import { OllamaClient } from '../../ollama/client';
import { OllamaModel, OllamaShowResponse } from '../../ollama/types';
import {
  ModelAvailabilityStatus,
  ModelChatChunk,
  ModelChatParams,
  ModelMetadata,
  ProviderPublicStatus,
  ProviderTestResult,
  ReasoningEffort,
} from '../types';

interface ShowCacheEntry {
  cacheKey: string;
  show: OllamaShowResponse | null;
}

export class OllamaProvider {
  private showCache: Map<string, ShowCacheEntry> = new Map();
  private loadingModels: Set<string> = new Set();

  constructor(private readonly client: OllamaClient) {}

  public setHost(host: string): void {
    this.client.setHost(host);
    this.showCache.clear();
  }

  public getHost(): string {
    return this.client.getHost();
  }

  public markModelLoading(modelIdentifier: string, isLoading: boolean): void {
    if (isLoading) {
      this.loadingModels.add(modelIdentifier);
    } else {
      this.loadingModels.delete(modelIdentifier);
    }
  }

  public clearCache(): void {
    this.showCache.clear();
  }

  public async testConnection(): Promise<ProviderTestResult> {
    const start = Date.now();
    const conn = await this.client.checkConnection();
    const latencyMs = Date.now() - start;

    if (!conn.connected) {
      return {
        ok: false,
        providerId: 'ollama',
        status: 'disconnected',
        latencyMs,
        error: conn.error || `Cannot reach Ollama at ${this.client.getHost()}`,
      };
    }

    try {
      const models = await this.client.listModelsStrict();
      return {
        ok: true,
        providerId: 'ollama',
        status: 'connected',
        version: conn.version,
        latencyMs,
        discoveredModelsCount: models.length,
      };
    } catch (err: any) {
      return {
        ok: false,
        providerId: 'ollama',
        status: 'error',
        version: conn.version,
        latencyMs,
        error: err.message || 'Failed to query Ollama models',
      };
    }
  }

  public async discoverModels(options: {
    forceRefresh?: boolean;
    enabledMap?: Map<string, boolean>;
  } = {}): Promise<{ status: ProviderPublicStatus; models: ModelMetadata[] }> {
    const start = Date.now();
    const checkedAt = Date.now();
    const baseUrl = this.client.getHost();

    const conn = await this.client.checkConnection();
    if (!conn.connected) {
      return {
        status: {
          providerId: 'ollama',
          providerType: 'ollama',
          providerName: 'Ollama',
          category: 'LOCAL',
          baseUrl,
          enabled: true,
          status: 'disconnected',
          hasApiKey: false,
          modelCount: 0,
          error: conn.error || `Cannot connect to Ollama at ${baseUrl}`,
          lastCheckedAt: checkedAt,
          latencyMs: Date.now() - start,
        },
        models: [],
      };
    }

    let rawModels: OllamaModel[] = [];
    try {
      rawModels = await this.client.listModelsStrict();
    } catch (err: any) {
      return {
        status: {
          providerId: 'ollama',
          providerType: 'ollama',
          providerName: 'Ollama',
          category: 'LOCAL',
          baseUrl,
          enabled: true,
          status: 'error',
          version: conn.version,
          hasApiKey: false,
          modelCount: 0,
          error: err.message || 'Failed to list Ollama models from /api/tags',
          lastCheckedAt: checkedAt,
          latencyMs: Date.now() - start,
        },
        models: [],
      };
    }

    const runningList = await this.client.getRunningModels().catch(() => []);
    const runningMap = new Map<string, { size_vram?: number; context_length?: number }>();
    for (const r of runningList) {
      if (r.name) runningMap.set(r.name, r);
      if (r.model) runningMap.set(r.model, r);
    }

    // Deduplicate installed tags by exact model identifier
    const seen = new Set<string>();
    const discovered: ModelMetadata[] = [];

    for (const om of rawModels) {
      const identifier = om.name || om.model;
      if (!identifier || seen.has(identifier)) continue;
      seen.add(identifier);

      const show = await this.getShowDetails(identifier, om.digest || om.modified_at || '', options.forceRefresh);
      const isRunning = runningMap.has(identifier);
      const isLoading = this.loadingModels.has(identifier);

      const availability: ModelAvailabilityStatus = isLoading
        ? 'loading'
        : isRunning
        ? 'running'
        : 'installed';

      const contextWindow = this.extractContextLength(om, show);
      const capsSet = new Set<string>([
        ...(Array.isArray(om.capabilities) ? om.capabilities : []),
        ...(Array.isArray(show?.capabilities) ? show!.capabilities! : []),
      ]);

      const supportsVision =
        capsSet.has('vision') || Boolean(show?.projector_info?.['clip.has_vision_encoder']);
      const supportsTools = capsSet.has('tools');
      const supportsThinking = capsSet.has('thinking') || Boolean(show?.thinking);

      const { supportedEfforts, mapping, defaultEffort } = this.extractThinkingConfig(
        supportsThinking,
        show
      );

      const modelId = `ollama/${identifier}`;
      const isEnabled = options.enabledMap?.has(modelId) ? options.enabledMap.get(modelId)! : true;
      const runningInfo = runningMap.get(identifier);

      discovered.push({
        id: modelId,
        // Never invent aliases: keep exact Ollama model tag as display name
        displayName: identifier,
        providerId: 'ollama',
        providerName: 'Ollama',
        modelIdentifier: identifier,
        providerType: 'LOCAL',
        availability,
        enabled: isEnabled,
        contextWindow,
        capabilities: {
          streaming: true,
          toolCalling: capsSet.size > 0 ? supportsTools : undefined,
          vision: capsSet.size > 0 ? supportsVision : undefined,
          structuredOutput: true,
          reasoning: capsSet.size > 0 || show?.thinking ? supportsThinking : undefined,
        },
        reasoningEffortsSupported: supportedEfforts,
        reasoningEffortMapping: mapping,
        defaultReasoningEffort: defaultEffort,
        supportsFastMode: supportsThinking,
        supportsTemperature: true,
        supportsMaxOutputTokens: true,
        supportsContextLimitConfig: true,
        modelSource: show ? 'ollama /api/tags + /api/show' : 'ollama /api/tags',
        lastVerifiedAt: checkedAt,
        parameterSize: om.details?.parameter_size || show?.details?.parameter_size,
        family: om.details?.family || show?.details?.family || show?.model_info?.['general.architecture'],
        quantization: om.details?.quantization_level || show?.details?.quantization_level,
        sizeBytes: om.size,
        vramBytes: runningInfo?.size_vram,
      });
    }

    return {
      status: {
        providerId: 'ollama',
        providerType: 'ollama',
        providerName: 'Ollama',
        category: 'LOCAL',
        baseUrl,
        enabled: true,
        status: 'connected',
        version: conn.version,
        hasApiKey: false,
        modelCount: discovered.length,
        lastCheckedAt: checkedAt,
        latencyMs: Date.now() - start,
      },
      models: discovered,
    };
  }

  public async chatStream(
    params: ModelChatParams,
    modelMeta: ModelMetadata | undefined,
    onChunk: (chunk: ModelChatChunk) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    let thinkValue: boolean | string | undefined = undefined;

    if (params.fastMode || params.reasoningEffort === 'minimal') {
      if (modelMeta?.reasoningEffortMapping?.['minimal'] !== undefined) {
        thinkValue = modelMeta.reasoningEffortMapping['minimal'];
      } else if (modelMeta?.capabilities?.reasoning) {
        thinkValue = false;
      }
    } else if (params.reasoningEffort && modelMeta?.reasoningEffortsSupported?.length) {
      const mapping = modelMeta.reasoningEffortMapping;
      if (mapping && mapping[params.reasoningEffort] !== undefined) {
        thinkValue = mapping[params.reasoningEffort];
      }
    }

    const effectiveTools = modelMeta?.capabilities?.toolCalling === false ? undefined : params.tools;
    let effectiveCtx: number;
    let estimatedTokens = 8192;
    const preserveLoadedContext = !(params.contextLimit && params.contextLimit > 0);
    if (params.contextLimit && params.contextLimit > 0) {
      effectiveCtx = modelMeta?.contextWindow
        ? Math.min(params.contextLimit, modelMeta.contextWindow)
        : params.contextLimit;
    } else {
      const payloadChars =
        JSON.stringify(params.messages || []).length + JSON.stringify(effectiveTools || []).length;
      estimatedTokens = Math.ceil(payloadChars / 3.2) + 4096;
      const modelCap = modelMeta?.contextWindow ? Math.min(modelMeta.contextWindow, 32768) : 32768;
      // Default to 16384 for typical prompts; if already loaded in VRAM with sufficient context_length, OllamaClient reuses it
      const dynamicTarget = estimatedTokens <= 14336 ? 16384 : Math.min(32768, estimatedTokens);
      effectiveCtx = Math.min(modelCap, Math.max(8192, dynamicTarget));
    }

    await this.client.chatStream(
      {
        model: params.modelIdentifier,
        messages: params.messages.map((m) => ({
          role: m.role,
          content: m.content,
          tool_calls: m.tool_calls,
          tool_name: m.tool_name,
        })),
        tools: effectiveTools,
        temperature: params.temperature,
        maxOutputTokens: params.maxOutputTokens,
        contextWindow: effectiveCtx,
        minContextWindow: estimatedTokens,
        preserveLoadedContext,
        think: thinkValue,
        keepAlive: '15m',
      },
      onChunk,
      abortSignal
    );
  }

  public async testModelCommunication(modelIdentifier: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    return this.client.testModelChat(modelIdentifier);
  }

  private async getShowDetails(
    name: string,
    digest: string,
    forceRefresh?: boolean
  ): Promise<OllamaShowResponse | null> {
    const cached = this.showCache.get(name);
    if (!forceRefresh && cached && cached.cacheKey === digest) {
      return cached.show;
    }

    const show = await this.client.showModel(name);
    this.showCache.set(name, { cacheKey: digest, show });
    return show;
  }

  private extractContextLength(om: OllamaModel, show: OllamaShowResponse | null): number | undefined {
    if (typeof om.details?.context_length === 'number' && om.details.context_length > 0) {
      return om.details.context_length;
    }
    if (show?.model_info) {
      const arch = show.model_info['general.architecture'];
      if (arch && typeof show.model_info[`${arch}.context_length`] === 'number') {
        return show.model_info[`${arch}.context_length`];
      }
      for (const [key, val] of Object.entries(show.model_info)) {
        if (key.endsWith('.context_length') && typeof val === 'number' && val > 0) {
          return val;
        }
      }
    }
    return undefined;
  }

  private extractThinkingConfig(
    supportsThinking: boolean,
    show: OllamaShowResponse | null
  ): {
    supportedEfforts: ReasoningEffort[];
    mapping: Partial<Record<ReasoningEffort, string | boolean>>;
    defaultEffort?: ReasoningEffort;
  } {
    if (!supportsThinking) {
      return { supportedEfforts: [], mapping: {} };
    }

    const rawValues = show?.thinking?.values;
    const supportedEfforts: ReasoningEffort[] = [];
    const mapping: Partial<Record<ReasoningEffort, string | boolean>> = {};

    if (Array.isArray(rawValues) && rawValues.length > 0) {
      for (const val of rawValues) {
        if (val === false) {
          if (!supportedEfforts.includes('minimal')) supportedEfforts.push('minimal');
          mapping['minimal'] = false;
        } else if (val === true) {
          if (!supportedEfforts.includes('medium')) supportedEfforts.push('medium');
          mapping['medium'] = true;
        } else if (typeof val === 'string') {
          const lower = val.toLowerCase();
          if (lower === 'low') {
            if (!supportedEfforts.includes('low')) supportedEfforts.push('low');
            mapping['low'] = val;
          } else if (lower === 'medium') {
            if (!supportedEfforts.includes('medium')) supportedEfforts.push('medium');
            mapping['medium'] = val;
          } else if (lower === 'high') {
            if (!supportedEfforts.includes('high')) supportedEfforts.push('high');
            mapping['high'] = val;
          } else if (lower === 'xhigh' || lower === 'extra_high') {
            if (!supportedEfforts.includes('extra_high')) supportedEfforts.push('extra_high');
            mapping['extra_high'] = val;
          }
        }
      }

      let defaultEffort: ReasoningEffort | undefined;
      const rawDefault = show?.thinking?.default;
      if (rawDefault === false && mapping['minimal'] !== undefined) defaultEffort = 'minimal';
      else if (rawDefault === true && mapping['medium'] !== undefined) defaultEffort = 'medium';
      else if (typeof rawDefault === 'string') {
        const d = rawDefault.toLowerCase();
        if (d === 'low') defaultEffort = 'low';
        else if (d === 'medium') defaultEffort = 'medium';
        else if (d === 'high') defaultEffort = 'high';
        else if (d === 'xhigh' || d === 'extra_high') defaultEffort = 'extra_high';
      }

      return { supportedEfforts, mapping, defaultEffort: defaultEffort || supportedEfforts[0] };
    }

    // Model declares 'thinking' capability without discrete levels -> boolean on/off
    return {
      supportedEfforts: ['minimal', 'medium'],
      mapping: { minimal: false, medium: true },
      defaultEffort: 'medium',
    };
  }
}
