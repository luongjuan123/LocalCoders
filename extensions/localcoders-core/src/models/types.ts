export type ProviderType = 'ollama' | 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'custom';
export type ProviderCategory = 'LOCAL' | 'CLOUD';
export type ModelAvailabilityStatus = 'installed' | 'available' | 'loading' | 'running' | 'unavailable' | 'unconfigured';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'extra_high';

export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM?: number;
  currency?: string;
  source: string;
}

export interface ModelCapabilities {
  streaming?: boolean;
  toolCalling?: boolean;
  vision?: boolean;
  structuredOutput?: boolean;
  reasoning?: boolean;
}

export interface ModelParametersConfig {
  temperature?: number;
  maxOutputTokens?: number;
  contextLimit?: number;
  reasoningEffort?: ReasoningEffort;
  fastMode?: boolean;
}

export interface ModelMetadata {
  /** Canonical ID: `${providerId}/${modelIdentifier}` */
  id: string;
  /** Real display name from provider or exact model identifier; never fabricated aliases */
  displayName: string;
  providerId: string;
  providerName: string;
  /** Exact identifier sent in API requests to the provider */
  modelIdentifier: string;
  providerType: ProviderCategory;
  availability: ModelAvailabilityStatus;
  enabled: boolean;
  /** Known context window in tokens, or undefined when unreported by provider */
  contextWindow?: number;
  /** Known max output tokens, or undefined when unreported */
  maxOutputTokens?: number;
  capabilities: ModelCapabilities;
  /** Only populated when the model/provider actually supports configurable reasoning effort */
  reasoningEffortsSupported?: ReasoningEffort[];
  /** Provider-specific reasoning effort parameter mapping (e.g. Ollama 'extra_high' -> 'xhigh') */
  reasoningEffortMapping?: Partial<Record<ReasoningEffort, string | boolean>>;
  defaultReasoningEffort?: ReasoningEffort;
  supportsFastMode?: boolean;
  supportsTemperature?: boolean;
  supportsMaxOutputTokens?: boolean;
  supportsContextLimitConfig?: boolean;
  /** Present ONLY when verified by provider API; omitted otherwise */
  pricing?: ModelPricing;
  modelSource: string;
  lastVerifiedAt?: number;
  parameterSize?: string;
  family?: string;
  quantization?: string;
  sizeBytes?: number;
  vramBytes?: number;
  unavailableReason?: string;
  isFavorite?: boolean;
  isRecentlyUsed?: boolean;
  customParameters?: ModelParametersConfig;
}

export interface ManualModelSpec {
  modelIdentifier: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsToolCalling?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
  supportsStructuredOutput?: boolean;
  reasoningEffortsSupported?: ReasoningEffort[];
}

export interface ProviderConfig {
  id: string;
  type: ProviderType;
  name: string;
  category: ProviderCategory;
  baseUrl: string;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeySource?: 'secret_storage' | 'env' | 'none';
  maskedApiKey?: string;
  manualModels?: ManualModelSpec[];
  lastTestedAt?: number;
}

export type ProviderConnectionStatus = 'connected' | 'disconnected' | 'unconfigured' | 'error';

export interface ProviderPublicStatus {
  providerId: string;
  providerType: ProviderType;
  providerName: string;
  category: ProviderCategory;
  baseUrl: string;
  enabled: boolean;
  status: ProviderConnectionStatus;
  hasApiKey: boolean;
  maskedApiKey?: string;
  apiKeySource?: 'secret_storage' | 'env' | 'none';
  version?: string;
  latencyMs?: number;
  modelCount: number;
  error?: string;
  lastCheckedAt?: number;
  manualModels?: ManualModelSpec[];
}

export interface ProviderTestResult {
  ok: boolean;
  providerId: string;
  status: ProviderConnectionStatus;
  version?: string;
  latencyMs?: number;
  discoveredModelsCount?: number;
  error?: string;
}

export interface ModelChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: any[];
  tool_name?: string;
  tool_call_id?: string;
}

export interface ModelChatParams {
  modelId?: string;
  modelIdentifier: string;
  providerId: string;
  messages: ModelChatMessage[];
  tools?: any[];
  temperature?: number;
  maxOutputTokens?: number;
  contextLimit?: number;
  reasoningEffort?: ReasoningEffort;
  fastMode?: boolean;
}

export interface ModelChatChunk {
  content: string;
  thinking?: string;
  done: boolean;
  toolCalls?: any[];
}
