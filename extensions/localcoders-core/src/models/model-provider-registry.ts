import * as vscode from 'vscode';
import { OllamaClient } from '../ollama/client';
import { OllamaProvider } from './providers/ollama-provider';
import { CloudProviderClient } from './providers/cloud-providers';
import { maskApiKey, ProviderSecretStore, redactSecrets, validateEndpointUrl } from './security';
import {
  ManualModelSpec,
  ModelAvailabilityStatus,
  ModelMetadata,
  ModelParametersConfig,
  ProviderConfig,
  ProviderPublicStatus,
  ProviderTestResult,
  ProviderType,
} from './types';

export * from './types';

interface PersistedRegistryState {
  providers: ProviderConfig[];
  enabledModels: Record<string, boolean>;
  modelParameters: Record<string, ModelParametersConfig>;
  defaultModelId?: string;
  favorites: string[];
  recentlyUsed: string[];
  ollamaEndpoint?: string;
}

export class ModelProviderRegistry {
  private static instance: ModelProviderRegistry;

  private readonly ollamaClient: OllamaClient;
  private readonly ollamaProvider: OllamaProvider;
  private readonly cloudClient: CloudProviderClient;
  private readonly secretStore: ProviderSecretStore;
  private memento?: vscode.Memento;

  private providers: Map<string, ProviderConfig> = new Map();
  private providerStatuses: Map<string, ProviderPublicStatus> = new Map();
  private modelsByKey: Map<string, ModelMetadata> = new Map(); // canonical key: `${providerId}::${modelIdentifier}`

  private enabledModels: Map<string, boolean> = new Map();
  private modelParameters: Map<string, ModelParametersConfig> = new Map();
  private defaultModelId?: string;
  private favorites: Set<string> = new Set();
  private recentlyUsed: string[] = [];

  private lastFullRefreshAt = 0;
  private readonly cacheTtlMs = 60_000;
  private inFlightRefresh: Promise<void> | null = null;

  private _onDidChangeModels = new vscode.EventEmitter<void>();
  public readonly onDidChangeModels = this._onDidChangeModels.event;

  constructor(
    ollama: OllamaClient,
    memento?: vscode.Memento,
    secretStorage?: vscode.SecretStorage
  ) {
    this.ollamaClient = ollama;
    this.ollamaProvider = new OllamaProvider(ollama);
    this.cloudClient = new CloudProviderClient();
    this.secretStore = new ProviderSecretStore(secretStorage);
    this.memento = memento;

    this.initDefaultProviders();
    this.loadPersistedData();
  }

  public static initialize(
    ollama: OllamaClient,
    memento?: vscode.Memento,
    secretStorage?: vscode.SecretStorage
  ): ModelProviderRegistry {
    if (!ModelProviderRegistry.instance) {
      ModelProviderRegistry.instance = new ModelProviderRegistry(ollama, memento, secretStorage);
    }
    return ModelProviderRegistry.instance;
  }

  public static getInstance(): ModelProviderRegistry {
    if (!ModelProviderRegistry.instance) {
      throw new Error('ModelProviderRegistry must be initialized first.');
    }
    return ModelProviderRegistry.instance;
  }

  public getOllamaProvider(): OllamaProvider {
    return this.ollamaProvider;
  }

  public getCloudClient(): CloudProviderClient {
    return this.cloudClient;
  }

  private initDefaultProviders(): void {
    const defaults: ProviderConfig[] = [
      {
        id: 'ollama',
        type: 'ollama',
        name: 'Ollama',
        category: 'LOCAL',
        baseUrl: this.ollamaClient.getHost() || 'http://localhost:11434',
        enabled: true,
        hasApiKey: false,
        apiKeySource: 'none',
      },
      {
        id: 'openai',
        type: 'openai',
        name: 'OpenAI',
        category: 'CLOUD',
        baseUrl: CloudProviderClient.getDefaultBaseUrl('openai'),
        enabled: true,
        hasApiKey: false,
        apiKeySource: 'none',
      },
      {
        id: 'anthropic',
        type: 'anthropic',
        name: 'Anthropic',
        category: 'CLOUD',
        baseUrl: CloudProviderClient.getDefaultBaseUrl('anthropic'),
        enabled: true,
        hasApiKey: false,
        apiKeySource: 'none',
      },
      {
        id: 'gemini',
        type: 'gemini',
        name: 'Google Gemini',
        category: 'CLOUD',
        baseUrl: CloudProviderClient.getDefaultBaseUrl('gemini'),
        enabled: true,
        hasApiKey: false,
        apiKeySource: 'none',
      },
      {
        id: 'openrouter',
        type: 'openrouter',
        name: 'OpenRouter',
        category: 'CLOUD',
        baseUrl: CloudProviderClient.getDefaultBaseUrl('openrouter'),
        enabled: true,
        hasApiKey: false,
        apiKeySource: 'none',
      },
    ];

    for (const p of defaults) {
      this.providers.set(p.id, p);
    }
  }

  private loadPersistedData(): void {
    if (!this.memento) return;

    const saved = this.memento.get<PersistedRegistryState>('localcoders.modelRegistryState.v2');
    if (saved) {
      if (saved.ollamaEndpoint) {
        const valid = validateEndpointUrl(saved.ollamaEndpoint, { allowHttp: false, allowHttpLocalhost: true });
        if (valid.valid && valid.normalizedUrl) {
          this.ollamaProvider.setHost(valid.normalizedUrl);
        }
      }

      if (Array.isArray(saved.providers)) {
        for (const p of saved.providers) {
          if (!p?.id || !p?.type) continue;
          // Strip any accidental plaintext key field if upgrading old schema
          const cleanProvider: ProviderConfig = {
            id: p.id,
            type: p.type,
            name: p.name,
            category: p.category,
            baseUrl: p.baseUrl,
            enabled: p.enabled ?? true,
            hasApiKey: false,
            apiKeySource: 'none',
            manualModels: Array.isArray(p.manualModels) ? p.manualModels : undefined,
            lastTestedAt: p.lastTestedAt,
          };
          this.providers.set(cleanProvider.id, cleanProvider);
        }
      }

      if (saved.enabledModels) {
        for (const [k, v] of Object.entries(saved.enabledModels)) {
          this.enabledModels.set(k, Boolean(v));
        }
      }

      if (saved.modelParameters) {
        for (const [k, v] of Object.entries(saved.modelParameters)) {
          if (v) this.modelParameters.set(k, v);
        }
      }

      this.defaultModelId = saved.defaultModelId;
      this.favorites = new Set(saved.favorites || []);
      this.recentlyUsed = Array.isArray(saved.recentlyUsed) ? saved.recentlyUsed : [];
    } else {
      // Legacy keys migration without plaintext secret retention
      const favs = this.memento.get<string[]>('localcoders.favoriteModels', []);
      this.favorites = new Set(favs);
      const recents = this.memento.get<string[]>('localcoders.recentlyUsedModels', []);
      this.recentlyUsed = recents;
    }
  }

  private async savePersistedData(): Promise<void> {
    if (!this.memento) return;
    // Security rule: NEVER persist API keys in Memento; persist only non-secret provider metadata
    const sanitizedProviders: ProviderConfig[] = Array.from(this.providers.values()).map((p) => ({
      id: p.id,
      type: p.type,
      name: p.name,
      category: p.category,
      baseUrl: p.baseUrl,
      enabled: p.enabled,
      hasApiKey: p.hasApiKey,
      apiKeySource: p.apiKeySource,
      maskedApiKey: p.maskedApiKey,
      manualModels: p.manualModels,
      lastTestedAt: p.lastTestedAt,
    }));

    const state: PersistedRegistryState = {
      providers: sanitizedProviders,
      enabledModels: Object.fromEntries(this.enabledModels.entries()),
      modelParameters: Object.fromEntries(this.modelParameters.entries()),
      defaultModelId: this.defaultModelId,
      favorites: Array.from(this.favorites),
      recentlyUsed: this.recentlyUsed,
      ollamaEndpoint: this.ollamaProvider.getHost(),
    };

    await this.memento.update('localcoders.modelRegistryState.v2', state);
  }

  private async resolveProviderApiKey(provider: ProviderConfig): Promise<{
    apiKey?: string;
    source: 'secret_storage' | 'env' | 'none';
  }> {
    const stored = await this.secretStore.getApiKey(provider.id);
    if (stored) {
      return { apiKey: stored, source: 'secret_storage' };
    }

    const envMap: Record<string, string | undefined> = {
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
    };

    const envKey = envMap[provider.id]?.trim();
    if (envKey) {
      return { apiKey: envKey, source: 'env' };
    }

    return { apiKey: undefined, source: 'none' };
  }

  private makeCanonicalKey(providerId: string, modelIdentifier: string): string {
    return `${providerId}::${modelIdentifier}`;
  }

  /**
   * Refreshes model discovery from Ollama and all configured cloud/custom providers.
   * Deduplicates calls via inFlightRefresh and honours TTL cache unless force=true.
   */
  public async refreshAll(force: boolean = false): Promise<void> {
    if (!force && this.lastFullRefreshAt > 0 && Date.now() - this.lastFullRefreshAt < this.cacheTtlMs) {
      return;
    }

    if (this.inFlightRefresh) {
      return this.inFlightRefresh;
    }

    this.inFlightRefresh = (async () => {
      try {
        const nextModels = new Map<string, ModelMetadata>();
        const knownSecrets = this.secretStore.getAllCachedSecrets();

        // 1. Ollama local discovery
        const ollamaCfg = this.providers.get('ollama');
        if (ollamaCfg && ollamaCfg.enabled) {
          this.ollamaProvider.setHost(ollamaCfg.baseUrl);
          const { status, models } = await this.ollamaProvider.discoverModels({
            forceRefresh: force,
            enabledMap: this.enabledModels,
          });
          this.providerStatuses.set('ollama', status);
          for (const m of models) {
            const key = this.makeCanonicalKey(m.providerId, m.modelIdentifier);
            if (!nextModels.has(key)) {
              nextModels.set(key, this.decorateModelMetadata(m));
            }
          }
        } else if (ollamaCfg) {
          this.providerStatuses.set('ollama', {
            providerId: 'ollama',
            providerType: 'ollama',
            providerName: ollamaCfg.name,
            category: 'LOCAL',
            baseUrl: ollamaCfg.baseUrl,
            enabled: false,
            status: 'disconnected',
            hasApiKey: false,
            modelCount: 0,
            error: 'Ollama provider is disabled',
          });
        }

        // 2. Cloud and Custom providers (only discover when API key / custom endpoint is configured)
        const otherProviders = Array.from(this.providers.values()).filter((p) => p.id !== 'ollama');
        await Promise.all(
          otherProviders.map(async (provider) => {
            const { apiKey, source } = await this.resolveProviderApiKey(provider);
            provider.hasApiKey = Boolean(apiKey);
            provider.apiKeySource = source;
            provider.maskedApiKey = maskApiKey(apiKey);

            // Unconfigured built-in cloud providers remain unconfigured with zero fake models
            if (provider.type !== 'custom' && !apiKey) {
              this.providerStatuses.set(provider.id, {
                providerId: provider.id,
                providerType: provider.type,
                providerName: provider.name,
                category: provider.category,
                baseUrl: provider.baseUrl,
                enabled: provider.enabled,
                status: 'unconfigured',
                hasApiKey: false,
                apiKeySource: 'none',
                modelCount: 0,
              });
              return;
            }

            const { status, models } = await this.cloudClient.testAndDiscover(
              provider,
              apiKey,
              this.enabledModels,
              knownSecrets
            );
            this.providerStatuses.set(provider.id, status);
            for (const m of models) {
              const key = this.makeCanonicalKey(m.providerId, m.modelIdentifier);
              if (!nextModels.has(key)) {
                nextModels.set(key, this.decorateModelMetadata(m));
              }
            }
          })
        );

        this.modelsByKey = nextModels;
        this.lastFullRefreshAt = Date.now();
        this._onDidChangeModels.fire();
      } finally {
        this.inFlightRefresh = null;
      }
    })();

    return this.inFlightRefresh;
  }

  private decorateModelMetadata(m: ModelMetadata): ModelMetadata {
    const enabled = this.enabledModels.has(m.id) ? this.enabledModels.get(m.id)! : m.enabled;
    const customParams = this.modelParameters.get(m.id);
    const availability: ModelAvailabilityStatus = !enabled ? 'unavailable' : m.availability;
    return {
      ...m,
      enabled,
      availability,
      unavailableReason: !enabled ? 'Disabled by user in Model Manager' : m.unavailableReason,
      isFavorite: this.favorites.has(m.id),
      isRecentlyUsed: this.recentlyUsed.includes(m.id),
      customParameters: customParams,
    };
  }

  public async getAvailableModels(options: { includeDisabled?: boolean; forceRefresh?: boolean } = {}): Promise<ModelMetadata[]> {
    await this.refreshAll(options.forceRefresh ?? false);
    const all = Array.from(this.modelsByKey.values()).map((m) => this.decorateModelMetadata(m));
    if (options.includeDisabled) {
      return all;
    }
    return all.filter((m) => m.enabled);
  }

  public async getProviderStatuses(forceRefresh: boolean = false): Promise<ProviderPublicStatus[]> {
    await this.refreshAll(forceRefresh);
    return Array.from(this.providerStatuses.values());
  }

  public async searchModels(
    query: string = '',
    filters?: { category?: 'ALL' | 'LOCAL' | 'CLOUD' | 'FAVORITES' | 'RECENT'; providerId?: string }
  ): Promise<ModelMetadata[]> {
    const all = await this.getAvailableModels({ includeDisabled: false });
    const q = query.trim().toLowerCase();

    return all.filter((m) => {
      if (filters?.category === 'LOCAL' && m.providerType !== 'LOCAL') return false;
      if (filters?.category === 'CLOUD' && m.providerType !== 'CLOUD') return false;
      if (filters?.category === 'FAVORITES' && !m.isFavorite) return false;
      if (filters?.category === 'RECENT' && !m.isRecentlyUsed) return false;
      if (filters?.providerId && filters.providerId !== 'all' && m.providerId !== filters.providerId) return false;

      if (!q) return true;
      return (
        m.displayName.toLowerCase().includes(q) ||
        m.modelIdentifier.toLowerCase().includes(q) ||
        m.providerName.toLowerCase().includes(q) ||
        m.providerId.toLowerCase().includes(q) ||
        (m.family && m.family.toLowerCase().includes(q)) ||
        (m.parameterSize && m.parameterSize.toLowerCase().includes(q))
      );
    });
  }

  /**
   * Returns deduplicated groups matching Requirement 5:
   * Strictly two non-overlapping sections: LOCAL MODELS (OLLAMA) and CLOUD MODELS.
   * No fake Recommended/Adaptive duplicate entries!
   */
  public async getGroupedModels(query: string = ''): Promise<{
    local: ModelMetadata[];
    cloud: ModelMetadata[];
    providers: ProviderPublicStatus[];
  }> {
    const filtered = await this.searchModels(query);
    const seen = new Set<string>();
    const local: ModelMetadata[] = [];
    const cloud: ModelMetadata[] = [];

    for (const m of filtered) {
      const key = this.makeCanonicalKey(m.providerId, m.modelIdentifier);
      if (seen.has(key)) continue;
      seen.add(key);
      if (m.providerType === 'LOCAL') {
        local.push(m);
      } else {
        cloud.push(m);
      }
    }

    return {
      local,
      cloud,
      providers: Array.from(this.providerStatuses.values()),
    };
  }

  public async getModelById(idOrIdentifier: string): Promise<ModelMetadata | undefined> {
    if (!idOrIdentifier) return undefined;
    const all = await this.getAvailableModels({ includeDisabled: true });

    // Exact canonical ID match first
    const byId = all.find((m) => m.id === idOrIdentifier);
    if (byId) return byId;

    // Exact modelIdentifier match (e.g. legacy Ollama raw name like "qwen3.8:27b")
    const matches = all.filter((m) => m.modelIdentifier === idOrIdentifier);
    if (matches.length === 1) return matches[0];

    return matches[0];
  }

  public async getDefaultOrFirstAvailableModel(): Promise<ModelMetadata | undefined> {
    const enabled = await this.getAvailableModels({ includeDisabled: false });
    if (enabled.length === 0) return undefined;

    if (this.defaultModelId) {
      const found = enabled.find(
        (m) => m.id === this.defaultModelId || m.modelIdentifier === this.defaultModelId
      );
      if (found) return found;
    }

    // Prefer already running local model if present, else first available
    const running = enabled.find((m) => m.availability === 'running');
    return running || enabled[0];
  }

  public getDefaultModelId(): string | undefined {
    return this.defaultModelId;
  }

  public async setDefaultModel(modelId: string): Promise<void> {
    this.defaultModelId = modelId;
    await this.savePersistedData();
    this._onDidChangeModels.fire();
  }

  /**
   * Resolves a model for real execution. Never silently substitutes another model.
   */
  public async resolveModelForExecution(modelIdOrIdentifier: string): Promise<{
    ok: boolean;
    model?: ModelMetadata;
    provider?: ProviderConfig;
    apiKey?: string;
    error?: string;
  }> {
    if (!modelIdOrIdentifier || !modelIdOrIdentifier.trim()) {
      return {
        ok: false,
        error: 'No model selected. Select an installed Ollama model or configure a cloud provider in Model Manager.',
      };
    }

    await this.refreshAll(false);
    const model = await this.getModelById(modelIdOrIdentifier.trim());

    if (!model) {
      // Check if an ID specifies a provider whose status tells why it's missing
      const slashIdx = modelIdOrIdentifier.indexOf('/');
      if (slashIdx > 0) {
        const providerId = modelIdOrIdentifier.slice(0, slashIdx);
        const status = this.providerStatuses.get(providerId);
        if (status && status.status !== 'connected') {
          return {
            ok: false,
            error: `Model '${modelIdOrIdentifier}' is unavailable because provider '${status.providerName}' is ${status.status}${status.error ? `: ${status.error}` : ''}. Please check your provider configuration or select another model.`,
          };
        }
      }
      return {
        ok: false,
        error: `Selected model '${modelIdOrIdentifier}' is not available in any configured provider. Please verify it is installed/accessible or select another model.`,
      };
    }

    if (!model.enabled) {
      return {
        ok: false,
        error: `Model '${model.displayName}' is disabled in Model Manager. Enable it or select a different model.`,
      };
    }

    const provider = this.providers.get(model.providerId);
    if (!provider || !provider.enabled) {
      return {
        ok: false,
        error: `Provider '${model.providerName}' is disabled or removed.`,
      };
    }

    if (provider.type === 'ollama') {
      const status = this.providerStatuses.get('ollama');
      if (status && status.status !== 'connected') {
        return {
          ok: false,
          error: `Ollama is disconnected (${provider.baseUrl}). Start Ollama or switch to another model.`,
        };
      }
      return { ok: true, model, provider };
    }

    const { apiKey } = await this.resolveProviderApiKey(provider);
    if (provider.type !== 'custom' && !apiKey) {
      return {
        ok: false,
        error: `Missing API key for provider '${provider.name}'. Add your API key in Model Manager.`,
      };
    }

    return { ok: true, model, provider, apiKey };
  }

  // ==================== PROVIDER & MODEL MUTATIONS ====================

  public async setOllamaEndpoint(rawUrl: string): Promise<ProviderTestResult> {
    const check = validateEndpointUrl(rawUrl, { allowHttp: false, allowHttpLocalhost: true });
    if (!check.valid || !check.normalizedUrl) {
      return {
        ok: false,
        providerId: 'ollama',
        status: 'error',
        error: check.error,
      };
    }

    const cfg = this.providers.get('ollama')!;
    cfg.baseUrl = check.normalizedUrl;
    cfg.enabled = true;
    this.ollamaProvider.setHost(check.normalizedUrl);
    await this.savePersistedData();
    await this.refreshAll(true);

    const status = this.providerStatuses.get('ollama');
    return {
      ok: status?.status === 'connected',
      providerId: 'ollama',
      status: status?.status || 'disconnected',
      version: status?.version,
      latencyMs: status?.latencyMs,
      discoveredModelsCount: status?.modelCount,
      error: status?.error,
    };
  }

  public async setProviderApiKey(providerId: string, apiKey: string): Promise<ProviderTestResult> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      return { ok: false, providerId, status: 'error', error: `Provider '${providerId}' not found.` };
    }

    if (!apiKey || !apiKey.trim()) {
      return this.removeProviderApiKey(providerId);
    }

    await this.secretStore.setApiKey(providerId, apiKey.trim());
    provider.enabled = true;
    provider.hasApiKey = true;
    provider.apiKeySource = 'secret_storage';
    provider.maskedApiKey = maskApiKey(apiKey);
    await this.savePersistedData();

    await this.refreshAll(true);
    const status = this.providerStatuses.get(providerId);
    return {
      ok: status?.status === 'connected',
      providerId,
      status: status?.status || 'error',
      latencyMs: status?.latencyMs,
      discoveredModelsCount: status?.modelCount,
      error: status?.error,
    };
  }

  public async removeProviderApiKey(providerId: string): Promise<ProviderTestResult> {
    const provider = this.providers.get(providerId);
    await this.secretStore.deleteApiKey(providerId);
    if (provider) {
      provider.hasApiKey = false;
      provider.apiKeySource = 'none';
      provider.maskedApiKey = undefined;
    }
    await this.savePersistedData();
    await this.refreshAll(true);
    const status = this.providerStatuses.get(providerId);
    return {
      ok: true,
      providerId,
      status: status?.status || 'unconfigured',
      discoveredModelsCount: 0,
    };
  }

  public async updateProviderConfig(
    providerId: string,
    updates: { name?: string; baseUrl?: string; enabled?: boolean }
  ): Promise<{ ok: boolean; error?: string }> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      return { ok: false, error: `Provider '${providerId}' does not exist.` };
    }

    if (updates.baseUrl !== undefined) {
      const allowHttp = provider.type === 'custom';
      const check = validateEndpointUrl(updates.baseUrl, { allowHttp, allowHttpLocalhost: true });
      if (!check.valid || !check.normalizedUrl) {
        return { ok: false, error: check.error };
      }
      provider.baseUrl = check.normalizedUrl;
      if (provider.type === 'ollama') {
        this.ollamaProvider.setHost(check.normalizedUrl);
      }
    }

    if (updates.name !== undefined && updates.name.trim()) {
      provider.name = updates.name.trim();
    }
    if (updates.enabled !== undefined) {
      provider.enabled = updates.enabled;
    }

    await this.savePersistedData();
    await this.refreshAll(true);
    return { ok: true };
  }

  public async addCustomProvider(params: {
    id?: string;
    name: string;
    baseUrl: string;
    apiKey?: string;
    manualModels?: ManualModelSpec[];
  }): Promise<{ ok: boolean; providerId?: string; error?: string }> {
    const check = validateEndpointUrl(params.baseUrl, { allowHttp: true, allowHttpLocalhost: true });
    if (!check.valid || !check.normalizedUrl) {
      return { ok: false, error: check.error };
    }

    const id =
      params.id?.trim() ||
      `custom-${params.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || Date.now()}`;

    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(check.normalizedUrl);
    const config: ProviderConfig = {
      id,
      type: 'custom',
      name: params.name.trim() || id,
      category: isLocal ? 'LOCAL' : 'CLOUD',
      baseUrl: check.normalizedUrl,
      enabled: true,
      hasApiKey: Boolean(params.apiKey && params.apiKey.trim()),
      apiKeySource: params.apiKey && params.apiKey.trim() ? 'secret_storage' : 'none',
      maskedApiKey: maskApiKey(params.apiKey),
      manualModels: params.manualModels || [],
    };

    this.providers.set(id, config);
    if (params.apiKey && params.apiKey.trim()) {
      await this.secretStore.setApiKey(id, params.apiKey.trim());
    }

    await this.savePersistedData();
    await this.refreshAll(true);
    return { ok: true, providerId: id };
  }

  public async removeProvider(providerId: string): Promise<void> {
    if (providerId === 'ollama') {
      // Built-in Ollama cannot be permanently deleted, only disabled cleanly
      const cfg = this.providers.get('ollama');
      if (cfg) cfg.enabled = false;
    } else {
      const cfg = this.providers.get(providerId);
      await this.secretStore.deleteApiKey(providerId);
      if (cfg && cfg.type !== 'custom') {
        // Built-in cloud provider: clear key and mark disabled/unconfigured
        cfg.enabled = false;
        cfg.hasApiKey = false;
        cfg.apiKeySource = 'none';
        cfg.maskedApiKey = undefined;
      } else {
        this.providers.delete(providerId);
        this.providerStatuses.delete(providerId);
      }
    }

    // Purge models belonging to this provider immediately
    for (const [k, m] of this.modelsByKey.entries()) {
      if (m.providerId === providerId) {
        this.modelsByKey.delete(k);
        this.favorites.delete(m.id);
        this.recentlyUsed = this.recentlyUsed.filter((id) => id !== m.id);
        if (this.defaultModelId === m.id) {
          this.defaultModelId = undefined;
        }
      }
    }

    await this.savePersistedData();
    await this.refreshAll(true);
  }

  public async addManualModel(providerId: string, spec: ManualModelSpec): Promise<{ ok: boolean; error?: string }> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      return { ok: false, error: `Provider '${providerId}' not found.` };
    }
    const cleanId = (spec.modelIdentifier || '').trim();
    if (!cleanId) {
      return { ok: false, error: 'Model identifier is required.' };
    }
    if (!provider.manualModels) provider.manualModels = [];
    // Deduplicate
    provider.manualModels = provider.manualModels.filter((m) => m.modelIdentifier !== cleanId);
    provider.manualModels.push({ ...spec, modelIdentifier: cleanId });
    await this.savePersistedData();
    await this.refreshAll(true);
    return { ok: true };
  }

  public async removeManualModel(providerId: string, modelIdentifier: string): Promise<void> {
    const provider = this.providers.get(providerId);
    if (!provider || !provider.manualModels) return;
    provider.manualModels = provider.manualModels.filter((m) => m.modelIdentifier !== modelIdentifier);
    const fullId = `${providerId}/${modelIdentifier}`;
    this.modelsByKey.delete(this.makeCanonicalKey(providerId, modelIdentifier));
    this.favorites.delete(fullId);
    this.recentlyUsed = this.recentlyUsed.filter((id) => id !== fullId);
    if (this.defaultModelId === fullId) {
      this.defaultModelId = undefined;
    }
    await this.savePersistedData();
    await this.refreshAll(true);
  }

  public async testProviderConnection(providerId: string): Promise<ProviderTestResult> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      return { ok: false, providerId, status: 'error', error: `Unknown provider '${providerId}'` };
    }

    if (provider.type === 'ollama') {
      this.ollamaProvider.setHost(provider.baseUrl);
      const res = await this.ollamaProvider.testConnection();
      await this.refreshAll(true);
      return res;
    }

    const { apiKey } = await this.resolveProviderApiKey(provider);
    const { testResult } = await this.cloudClient.testAndDiscover(
      provider,
      apiKey,
      this.enabledModels,
      this.secretStore.getAllCachedSecrets()
    );
    provider.lastTestedAt = Date.now();
    await this.refreshAll(true);
    return testResult;
  }

  public async testModelCommunication(modelId: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const resolved = await this.resolveModelForExecution(modelId);
    if (!resolved.ok || !resolved.model || !resolved.provider) {
      return { ok: false, latencyMs: 0, error: resolved.error || 'Model unavailable' };
    }

    if (resolved.provider.type === 'ollama') {
      return this.ollamaProvider.testModelCommunication(resolved.model.modelIdentifier);
    }

    const start = Date.now();
    try {
      await this.cloudClient.chatStream(
        resolved.provider,
        resolved.apiKey,
        {
          modelId: resolved.model.id,
          modelIdentifier: resolved.model.modelIdentifier,
          providerId: resolved.provider.id,
          messages: [{ role: 'user', content: 'Respond with OK' }],
          maxOutputTokens: 8,
        },
        resolved.model,
        () => {}
      );
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err: any) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: redactSecrets(err?.message || 'Test request failed', resolved.apiKey ? [resolved.apiKey] : []),
      };
    }
  }

  public async setModelEnabled(modelId: string, enabled: boolean): Promise<void> {
    this.enabledModels.set(modelId, enabled);
    await this.savePersistedData();
    this._onDidChangeModels.fire();
  }

  public async setModelParameters(modelId: string, params: ModelParametersConfig): Promise<void> {
    const existing = this.modelParameters.get(modelId) || {};
    this.modelParameters.set(modelId, { ...existing, ...params });
    await this.savePersistedData();
    this._onDidChangeModels.fire();
  }

  public getModelParameters(modelId: string): ModelParametersConfig | undefined {
    return this.modelParameters.get(modelId);
  }

  public isFavorite(modelId: string): boolean {
    return this.favorites.has(modelId);
  }

  public async toggleFavorite(modelId: string): Promise<boolean> {
    if (this.favorites.has(modelId)) {
      this.favorites.delete(modelId);
    } else {
      this.favorites.add(modelId);
    }
    await this.savePersistedData();
    this._onDidChangeModels.fire();
    return this.favorites.has(modelId);
  }

  public async recordModelUsage(modelId: string): Promise<void> {
    this.recentlyUsed = [modelId, ...this.recentlyUsed.filter((id) => id !== modelId)].slice(0, 10);
    await this.savePersistedData();
  }

  // Backward-compatible helpers kept cleanly without faking endpoints
  public async addCustomEndpoint(config: { id: string; name: string; baseUrl: string; apiKey?: string; models: string[] }): Promise<void> {
    await this.addCustomProvider({
      id: config.id,
      name: config.name,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      manualModels: (config.models || []).map((m) => ({ modelIdentifier: m })),
    });
  }

  public async removeCustomEndpoint(endpointId: string): Promise<void> {
    await this.removeProvider(endpointId);
  }
}
