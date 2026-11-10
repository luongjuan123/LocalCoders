import * as vscode from 'vscode';
import { OllamaClient } from '../ollama/client';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'extra_high';
export type ModelProviderType = 'ollama' | 'openai' | 'anthropic' | 'gemini' | 'custom';

export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM?: number;
}

export interface ModelMetadata {
  id: string; // e.g. "ollama/qwen3.8:27b" or "anthropic/claude-3-5-sonnet"
  name: string; // e.g. "Qwen 3.8 27B"
  rawName: string; // e.g. "qwen3.8:27b"
  provider: ModelProviderType;
  providerName: string; // e.g. "Ollama", "Anthropic"
  category: 'adaptive' | 'recently_used' | 'recommended' | 'local' | 'cloud' | 'favorite';
  reasoningEffortSupported: boolean;
  supportedEfforts: ReasoningEffort[];
  defaultEffort: ReasoningEffort;
  fastModeSupported: boolean;
  contextWindow: number;
  contextWindowLabel: string;
  pricing: ModelPricing | 'local';
  isLocal: boolean;
  isAvailable: boolean;
  isNew?: boolean;
  isFree?: boolean;
  parameterSize?: string;
  family?: string;
  description?: string;
}

export interface CustomEndpointConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
}

export class ModelProviderRegistry {
  private static instance: ModelProviderRegistry;
  private ollama: OllamaClient;
  private memento?: vscode.Memento;

  private favorites: Set<string> = new Set();
  private recentlyUsed: string[] = [];
  private customEndpoints: CustomEndpointConfig[] = [];

  // Static standard known models across cloud providers for seamless multi-provider support
  private static readonly CLOUD_MODELS: Omit<ModelMetadata, 'category' | 'isAvailable'>[] = [
    {
      id: 'anthropic/claude-3-7-sonnet',
      name: 'Claude 3.7 Sonnet',
      rawName: 'claude-3-7-sonnet-20250219',
      provider: 'anthropic',
      providerName: 'Anthropic',
      reasoningEffortSupported: true,
      supportedEfforts: ['low', 'medium', 'high', 'extra_high'],
      defaultEffort: 'medium',
      fastModeSupported: true,
      contextWindow: 200000,
      contextWindowLabel: '200k context',
      pricing: { inputPerM: 3.0, outputPerM: 15.0, cachedInputPerM: 0.3 },
      isLocal: false,
      isNew: true,
      description: 'Hybrid reasoning and high-speed coding model.',
    },
    {
      id: 'anthropic/claude-3-5-sonnet',
      name: 'Claude 3.5 Sonnet',
      rawName: 'claude-3-5-sonnet-20241022',
      provider: 'anthropic',
      providerName: 'Anthropic',
      reasoningEffortSupported: false,
      supportedEfforts: ['medium'],
      defaultEffort: 'medium',
      fastModeSupported: true,
      contextWindow: 200000,
      contextWindowLabel: '200k context',
      pricing: { inputPerM: 3.0, outputPerM: 15.0, cachedInputPerM: 0.3 },
      isLocal: false,
      description: 'Industry-leading code generation and multi-file reasoning.',
    },
    {
      id: 'openai/gpt-4o',
      name: 'GPT-4o',
      rawName: 'gpt-4o',
      provider: 'openai',
      providerName: 'OpenAI',
      reasoningEffortSupported: false,
      supportedEfforts: ['medium'],
      defaultEffort: 'medium',
      fastModeSupported: true,
      contextWindow: 128000,
      contextWindowLabel: '128k context',
      pricing: { inputPerM: 2.5, outputPerM: 10.0, cachedInputPerM: 1.25 },
      isLocal: false,
      description: 'Flagship high-intelligence multi-modal coding model.',
    },
    {
      id: 'openai/o3-mini',
      name: 'o3-mini',
      rawName: 'o3-mini',
      provider: 'openai',
      providerName: 'OpenAI',
      reasoningEffortSupported: true,
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      fastModeSupported: true,
      contextWindow: 200000,
      contextWindowLabel: '200k context',
      pricing: { inputPerM: 1.1, outputPerM: 4.4, cachedInputPerM: 0.55 },
      isLocal: false,
      isNew: true,
      description: 'Cost-efficient STEM and code reasoning with adjustable effort.',
    },
    {
      id: 'openai/o1',
      name: 'o1',
      rawName: 'o1',
      provider: 'openai',
      providerName: 'OpenAI',
      reasoningEffortSupported: true,
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      fastModeSupported: false,
      contextWindow: 200000,
      contextWindowLabel: '200k context',
      pricing: { inputPerM: 15.0, outputPerM: 60.0, cachedInputPerM: 7.5 },
      isLocal: false,
      description: 'Deep deliberative reasoning for complex algorithmic architectures.',
    },
    {
      id: 'gemini/gemini-2.0-flash',
      name: 'Gemini 2.0 Flash',
      rawName: 'gemini-2.0-flash',
      provider: 'gemini',
      providerName: 'Google',
      reasoningEffortSupported: true,
      supportedEfforts: ['minimal', 'low', 'medium', 'high'],
      defaultEffort: 'medium',
      fastModeSupported: true,
      contextWindow: 1048576,
      contextWindowLabel: '1M context',
      pricing: { inputPerM: 0.1, outputPerM: 0.4, cachedInputPerM: 0.025 },
      isLocal: false,
      isNew: true,
      isFree: true,
      description: 'High-speed 1M context with native tool use and multi-modal support.',
    },
    {
      id: 'gemini/gemini-2.0-pro',
      name: 'Gemini 2.0 Pro',
      rawName: 'gemini-2.0-pro-exp-02-05',
      provider: 'gemini',
      providerName: 'Google',
      reasoningEffortSupported: true,
      supportedEfforts: ['low', 'medium', 'high', 'extra_high'],
      defaultEffort: 'high',
      fastModeSupported: false,
      contextWindow: 2097152,
      contextWindowLabel: '2M context',
      pricing: { inputPerM: 1.25, outputPerM: 5.0, cachedInputPerM: 0.3 },
      isLocal: false,
      isNew: true,
      description: 'Massive 2M context with advanced software architecture comprehension.',
    },
  ];

  constructor(ollama: OllamaClient, memento?: vscode.Memento) {
    this.ollama = ollama;
    this.memento = memento;
    this.loadPersistedData();
  }

  public static initialize(ollama: OllamaClient, memento?: vscode.Memento): ModelProviderRegistry {
    if (!ModelProviderRegistry.instance) {
      ModelProviderRegistry.instance = new ModelProviderRegistry(ollama, memento);
    }
    return ModelProviderRegistry.instance;
  }

  public static getInstance(): ModelProviderRegistry {
    if (!ModelProviderRegistry.instance) {
      throw new Error('ModelProviderRegistry must be initialized first.');
    }
    return ModelProviderRegistry.instance;
  }

  private loadPersistedData(): void {
    if (!this.memento) return;
    const favs = this.memento.get<string[]>('localcoders.favoriteModels', []);
    this.favorites = new Set(favs);

    const recents = this.memento.get<string[]>('localcoders.recentlyUsedModels', []);
    this.recentlyUsed = recents;

    const endpoints = this.memento.get<CustomEndpointConfig[]>('localcoders.customEndpoints', []);
    this.customEndpoints = endpoints;
  }

  private async savePersistedData(): Promise<void> {
    if (!this.memento) return;
    await this.memento.update('localcoders.favoriteModels', Array.from(this.favorites));
    await this.memento.update('localcoders.recentlyUsedModels', this.recentlyUsed);
    await this.memento.update('localcoders.customEndpoints', this.customEndpoints);
  }

  /**
   * Dynamically fetch all models available:
   * 1. Locally installed in Ollama (live dynamically checked)
   * 2. Configured custom endpoints
   * 3. Configured or available Cloud providers
   */
  public async getAvailableModels(): Promise<ModelMetadata[]> {
    const models: ModelMetadata[] = [];

    // 1. Adaptive Routing Virtual Model ("Fusion")
    models.push({
      id: 'adaptive/fusion',
      name: 'Fusion',
      rawName: 'fusion-adaptive',
      provider: 'ollama',
      providerName: 'Adaptive Engine',
      category: 'adaptive',
      reasoningEffortSupported: true,
      supportedEfforts: ['minimal', 'low', 'medium', 'high', 'extra_high'],
      defaultEffort: 'medium',
      fastModeSupported: true,
      contextWindow: 128000,
      contextWindowLabel: '128k auto',
      pricing: 'local',
      isLocal: true,
      isAvailable: true,
      isNew: true,
      description: 'Automatically routes to the fastest or highest-reasoning local model per task.',
    });

    // 2. Local Ollama Models (Dynamic query to running daemon)
    try {
      const ollamaModels = await this.ollama.listModels();
      const runningModels = await this.ollama.getRunningModels();
      const runningSet = new Set(runningModels.map((m) => m.name || m.model));

      for (const om of ollamaModels) {
        const rawName = om.name;
        const paramSize = om.details?.parameter_size || (rawName.includes(':') ? rawName.split(':')[1] : 'Local');
        const isRunning = runningSet.has(rawName);

        const isReasoning =
          rawName.includes('qwen') ||
          rawName.includes('deepseek') ||
          rawName.includes('coder') ||
          rawName.includes('r1') ||
          rawName.includes('thinking');

        const contextWindow = rawName.includes('32b') || rawName.includes('coder') ? 32768 : 16384;

        models.push({
          id: `ollama/${rawName}`,
          name: this.formatModelName(rawName),
          rawName,
          provider: 'ollama',
          providerName: 'Ollama',
          category: 'local',
          reasoningEffortSupported: isReasoning,
          supportedEfforts: isReasoning
            ? ['minimal', 'low', 'medium', 'high', 'extra_high']
            : ['low', 'medium', 'high'],
          defaultEffort: 'medium',
          fastModeSupported: true,
          contextWindow,
          contextWindowLabel: `${Math.round(contextWindow / 1024)}k context`,
          pricing: 'local',
          isLocal: true,
          isAvailable: true,
          isFree: true,
          parameterSize: paramSize,
          family: om.details?.family || 'local',
          description: isRunning ? `● Running in VRAM (${paramSize})` : `Local offline inference (${paramSize})`,
        });
      }
    } catch (err: any) {
      console.warn('[ModelProviderRegistry] Could not query Ollama models:', err.message);
    }

    // 3. Cloud Models (Checking environment variables or VS Code settings for API keys)
    const anthropicKey = process.env.ANTHROPIC_API_KEY || vscode.workspace.getConfiguration('localcoders').get<string>('anthropicApiKey');
    const openaiKey = process.env.OPENAI_API_KEY || vscode.workspace.getConfiguration('localcoders').get<string>('openaiApiKey');
    const geminiKey = process.env.GEMINI_API_KEY || vscode.workspace.getConfiguration('localcoders').get<string>('geminiApiKey');

    for (const cm of ModelProviderRegistry.CLOUD_MODELS) {
      let isAvailable = false;
      if (cm.provider === 'anthropic' && anthropicKey) isAvailable = true;
      if (cm.provider === 'openai' && openaiKey) isAvailable = true;
      if (cm.provider === 'gemini' && (geminiKey || true)) isAvailable = true; // Gemini provides generous free tier

      models.push({
        ...cm,
        category: 'cloud',
        isAvailable,
      });
    }

    // 4. Custom Endpoints (e.g. LM Studio, vLLM, OpenRouter)
    for (const ep of this.customEndpoints) {
      for (const mName of ep.models) {
        models.push({
          id: `custom/${ep.id}/${mName}`,
          name: mName,
          rawName: mName,
          provider: 'custom',
          providerName: ep.name,
          category: 'cloud',
          reasoningEffortSupported: true,
          supportedEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
          fastModeSupported: true,
          contextWindow: 65536,
          contextWindowLabel: '64k context',
          pricing: 'local',
          isLocal: ep.baseUrl.includes('127.0.0.1') || ep.baseUrl.includes('localhost'),
          isAvailable: true,
          description: `Custom endpoint: ${ep.baseUrl}`,
        });
      }
    }

    return models;
  }

  /**
   * Search models by name, provider, family, tag, or local/cloud capability
   */
  public async searchModels(query: string): Promise<ModelMetadata[]> {
    const all = await this.getAvailableModels();
    const q = query.trim().toLowerCase();
    if (!q) return all;

    return all.filter((m) => {
      return (
        m.name.toLowerCase().includes(q) ||
        m.rawName.toLowerCase().includes(q) ||
        m.providerName.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q) ||
        (m.family && m.family.toLowerCase().includes(q)) ||
        (m.parameterSize && m.parameterSize.toLowerCase().includes(q)) ||
        (q === 'local' && m.isLocal) ||
        (q === 'cloud' && !m.isLocal) ||
        (q === 'free' && m.isFree) ||
        (q === 'reasoning' && m.reasoningEffortSupported)
      );
    });
  }

  /**
   * Group models into dynamic sections:
   * 1. Adaptive
   * 2. Recently Used
   * 3. Recommended
   * 4. Local Models
   * 5. All Models
   * 6. Favorites
   */
  public async getGroupedModels(query: string = ''): Promise<Record<string, ModelMetadata[]>> {
    const models = await this.searchModels(query);
    const groups: Record<string, ModelMetadata[]> = {};

    // Favorites
    const favModels = models.filter((m) => this.favorites.has(m.id));
    if (favModels.length > 0) {
      groups['Favorites'] = favModels;
      groups['favorites'] = favModels;
    }

    // Adaptive
    const adaptive = models.filter((m) => m.category === 'adaptive');
    if (adaptive.length > 0) {
      groups['Adaptive'] = adaptive;
      groups['adaptive'] = adaptive;
    }

    // Recently Used
    if (this.recentlyUsed.length > 0) {
      const recents: ModelMetadata[] = [];
      for (const id of this.recentlyUsed) {
        const found = models.find((m) => m.id === id);
        if (found && !recents.some((r) => r.id === found.id)) {
          recents.push(found);
        }
      }
      if (recents.length > 0) {
        groups['Recently Used'] = recents;
        groups['recently_used'] = recents;
      }
    }

    // Recommended
    const recommended = models.filter(
      (m) =>
        m.id.includes('qwen2.5-coder') ||
        m.id.includes('qwen3.8') ||
        m.id.includes('claude-3-7-sonnet') ||
        m.id.includes('gpt-4o') ||
        m.id.includes('gemini-2.0-flash') ||
        m.id.includes('o3-mini')
    );
    if (recommended.length > 0) {
      groups['Recommended'] = recommended;
      groups['recommended'] = recommended;
    }

    // Local Models
    const localModels = models.filter((m) => m.isLocal && m.category !== 'adaptive');
    if (localModels.length > 0) {
      groups['Local Models'] = localModels;
      groups['local'] = localModels;
    }

    // Cloud Models
    const cloudModels = models.filter((m) => !m.isLocal);
    if (cloudModels.length > 0) {
      groups['Cloud Models'] = cloudModels;
      groups['cloud'] = cloudModels;
    }

    return groups;
  }

  public async getModelById(id: string): Promise<ModelMetadata | undefined> {
    const all = await this.getAvailableModels();
    return all.find((m) => m.id === id || m.rawName === id);
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
    return this.favorites.has(modelId);
  }

  public async recordModelUsage(modelId: string): Promise<void> {
    this.recentlyUsed = [modelId, ...this.recentlyUsed.filter((id) => id !== modelId)].slice(0, 10);
    await this.savePersistedData();
  }

  public async addCustomEndpoint(config: CustomEndpointConfig): Promise<void> {
    this.customEndpoints = this.customEndpoints.filter((e) => e.id !== config.id);
    this.customEndpoints.push(config);
    await this.savePersistedData();
  }

  public async removeCustomEndpoint(endpointId: string): Promise<void> {
    this.customEndpoints = this.customEndpoints.filter((e) => e.id !== endpointId);
    await this.savePersistedData();
  }

  private formatModelName(rawName: string): string {
    // E.g. "qwen2.5-coder:32b" -> "Qwen2.5 Coder (32B)"
    if (rawName.includes(':')) {
      const [base, tag] = rawName.split(':');
      const cleanBase = base
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      return `${cleanBase} (${tag.toUpperCase()})`;
    }
    return rawName.charAt(0).toUpperCase() + rawName.slice(1);
  }
}
