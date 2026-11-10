import {
  ManualModelSpec,
  ModelChatChunk,
  ModelChatMessage,
  ModelChatParams,
  ModelMetadata,
  ProviderConfig,
  ProviderPublicStatus,
  ProviderTestResult,
  ReasoningEffort,
} from '../types';
import { maskApiKey, redactSecrets, validateEndpointUrl } from '../security';

export class CloudProviderClient {
  private static readonly NON_CHAT_OPENAI_PREFIXES = [
    'text-embedding',
    'text-moderation',
    'omni-moderation',
    'whisper',
    'tts-',
    'dall-e',
    'gpt-image',
    'babbage',
    'davinci',
    'curie',
    'ada',
    'sora',
  ];

  public static getDefaultBaseUrl(type: ProviderConfig['type']): string {
    switch (type) {
      case 'openai':
        return 'https://api.openai.com/v1';
      case 'anthropic':
        return 'https://api.anthropic.com';
      case 'gemini':
        return 'https://generativelanguage.googleapis.com';
      case 'openrouter':
        return 'https://openrouter.ai/api/v1';
      default:
        return '';
    }
  }

  public async testAndDiscover(
    config: ProviderConfig,
    apiKey: string | undefined,
    enabledMap?: Map<string, boolean>,
    knownSecrets: string[] = []
  ): Promise<{ status: ProviderPublicStatus; models: ModelMetadata[]; testResult: ProviderTestResult }> {
    const start = Date.now();
    const checkedAt = Date.now();
    const masked = maskApiKey(apiKey);
    const hasKey = Boolean(apiKey && apiKey.trim().length > 0);
    const baseStatus: ProviderPublicStatus = {
      providerId: config.id,
      providerType: config.type,
      providerName: config.name,
      category: config.category,
      baseUrl: config.baseUrl,
      enabled: config.enabled,
      status: 'unconfigured',
      hasApiKey: hasKey,
      maskedApiKey: masked,
      apiKeySource: hasKey ? config.apiKeySource || 'secret_storage' : 'none',
      modelCount: 0,
      lastCheckedAt: checkedAt,
      manualModels: config.manualModels,
    };

    if (!config.enabled) {
      return {
        status: { ...baseStatus, status: 'disconnected', error: 'Provider disabled' },
        models: [],
        testResult: { ok: false, providerId: config.id, status: 'disconnected', error: 'Provider disabled' },
      };
    }

    const allowHttp = config.type === 'custom';
    const urlCheck = validateEndpointUrl(config.baseUrl, { allowHttp, allowHttpLocalhost: true });
    if (!urlCheck.valid || !urlCheck.normalizedUrl) {
      return {
        status: { ...baseStatus, status: 'error', error: urlCheck.error },
        models: [],
        testResult: { ok: false, providerId: config.id, status: 'error', error: urlCheck.error },
      };
    }
    const baseUrl = urlCheck.normalizedUrl;

    // Cloud providers require API key (custom local servers like LM Studio / vLLM may not need one)
    if (config.type !== 'custom' && !hasKey) {
      return {
        status: { ...baseStatus, status: 'unconfigured', error: 'API key not configured' },
        models: [],
        testResult: { ok: false, providerId: config.id, status: 'unconfigured', error: 'API key not configured' },
      };
    }

    const secretsToRedact = [...knownSecrets];
    if (apiKey) secretsToRedact.push(apiKey);

    try {
      let models: ModelMetadata[] = [];

      if (config.type === 'openai') {
        models = await this.discoverOpenAI(config, baseUrl, apiKey!, checkedAt, enabledMap);
      } else if (config.type === 'anthropic') {
        models = await this.discoverAnthropic(config, baseUrl, apiKey!, checkedAt, enabledMap);
      } else if (config.type === 'gemini') {
        models = await this.discoverGemini(config, baseUrl, apiKey!, checkedAt, enabledMap);
      } else if (config.type === 'openrouter') {
        models = await this.discoverOpenRouter(config, baseUrl, apiKey!, checkedAt, enabledMap);
      } else if (config.type === 'custom') {
        models = await this.discoverCustom(config, baseUrl, apiKey, checkedAt, enabledMap);
      }

      const latencyMs = Date.now() - start;
      return {
        status: {
          ...baseStatus,
          status: 'connected',
          modelCount: models.length,
          latencyMs,
        },
        models,
        testResult: {
          ok: true,
          providerId: config.id,
          status: 'connected',
          latencyMs,
          discoveredModelsCount: models.length,
        },
      };
    } catch (err: any) {
      const safeErr = redactSecrets(err?.message || 'Connection failed', secretsToRedact);
      const latencyMs = Date.now() - start;
      return {
        status: {
          ...baseStatus,
          status: 'error',
          error: safeErr,
          latencyMs,
        },
        models: [],
        testResult: {
          ok: false,
          providerId: config.id,
          status: 'error',
          error: safeErr,
          latencyMs,
        },
      };
    }
  }

  private async discoverOpenAI(
    config: ProviderConfig,
    baseUrl: string,
    apiKey: string,
    checkedAt: number,
    enabledMap?: Map<string, boolean>
  ): Promise<ModelMetadata[]> {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`OpenAI /models failed (HTTP ${response.status}): ${errBody || response.statusText}`);
    }

    const json = (await response.json()) as { data?: Array<{ id: string; created?: number; owned_by?: string }> };
    const items = Array.isArray(json.data) ? json.data : [];
    const seen = new Set<string>();
    const results: ModelMetadata[] = [];

    for (const item of items) {
      const identifier = item.id;
      if (!identifier || seen.has(identifier)) continue;
      if (CloudProviderClient.NON_CHAT_OPENAI_PREFIXES.some((p) => identifier.toLowerCase().startsWith(p))) {
        continue;
      }
      // Exclude audio/realtime/search preview non-standard chat completions if obviously audio-only
      if (/realtime|transcribe|audio/i.test(identifier)) continue;
      seen.add(identifier);

      const isReasoning = /^(o1|o3|o4|gpt-5)(-|$)/i.test(identifier) && !/o1-mini|o1-preview/i.test(identifier);
      const isOSeries = /^(o1|o3|o4)(-|$)/i.test(identifier);
      const supportedEfforts: ReasoningEffort[] = isReasoning ? ['low', 'medium', 'high'] : [];
      const modelId = `${config.id}/${identifier}`;

      results.push({
        id: modelId,
        displayName: identifier,
        providerId: config.id,
        providerName: config.name,
        modelIdentifier: identifier,
        providerType: 'CLOUD',
        availability: 'available',
        enabled: enabledMap?.has(modelId) ? enabledMap.get(modelId)! : true,
        // OpenAI /v1/models does not report context_length or pricing; do not fabricate
        contextWindow: undefined,
        capabilities: {
          streaming: true,
          toolCalling: !identifier.includes('instruct'),
          vision: /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o3|o4/i.test(identifier) ? true : undefined,
          structuredOutput: true,
          reasoning: isReasoning,
        },
        reasoningEffortsSupported: supportedEfforts,
        reasoningEffortMapping: isReasoning
          ? { low: 'low', medium: 'medium', high: 'high' }
          : undefined,
        defaultReasoningEffort: isReasoning ? 'medium' : undefined,
        supportsFastMode: false,
        supportsTemperature: !isOSeries,
        supportsMaxOutputTokens: true,
        supportsContextLimitConfig: false,
        modelSource: `${config.id} /models`,
        lastVerifiedAt: checkedAt,
      });
    }

    return results.sort((a, b) => a.modelIdentifier.localeCompare(b.modelIdentifier));
  }

  private async discoverAnthropic(
    config: ProviderConfig,
    baseUrl: string,
    apiKey: string,
    checkedAt: number,
    enabledMap?: Map<string, boolean>
  ): Promise<ModelMetadata[]> {
    const response = await fetch(`${baseUrl}/v1/models?limit=100`, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Anthropic /v1/models failed (HTTP ${response.status}): ${errBody || response.statusText}`);
    }

    const json = (await response.json()) as {
      data?: Array<{ id: string; display_name?: string; created_at?: string; context_window?: number; max_tokens?: number }>;
    };
    const items = Array.isArray(json.data) ? json.data : [];
    const seen = new Set<string>();
    const results: ModelMetadata[] = [];

    for (const item of items) {
      const identifier = item.id;
      if (!identifier || seen.has(identifier)) continue;
      seen.add(identifier);

      const lower = identifier.toLowerCase();
      const supportsThinking =
        lower.includes('claude-3-7') ||
        lower.includes('claude-sonnet-4') ||
        lower.includes('claude-opus-4') ||
        lower.includes('claude-haiku-4') ||
        lower.includes('claude-4');

      const supportedEfforts: ReasoningEffort[] = supportsThinking
        ? ['minimal', 'low', 'medium', 'high']
        : [];
      const modelId = `${config.id}/${identifier}`;

      results.push({
        id: modelId,
        displayName: item.display_name || identifier,
        providerId: config.id,
        providerName: config.name,
        modelIdentifier: identifier,
        providerType: 'CLOUD',
        availability: 'available',
        enabled: enabledMap?.has(modelId) ? enabledMap.get(modelId)! : true,
        contextWindow: typeof item.context_window === 'number' ? item.context_window : undefined,
        maxOutputTokens: typeof item.max_tokens === 'number' ? item.max_tokens : undefined,
        capabilities: {
          streaming: true,
          toolCalling: true,
          vision: lower.includes('claude-3') || lower.includes('claude-4') || lower.includes('claude-sonnet') || lower.includes('claude-opus') ? true : undefined,
          structuredOutput: true,
          reasoning: supportsThinking,
        },
        reasoningEffortsSupported: supportedEfforts,
        reasoningEffortMapping: supportsThinking
          ? { minimal: 'disabled', low: 'low', medium: 'medium', high: 'high' }
          : undefined,
        defaultReasoningEffort: supportsThinking ? 'medium' : undefined,
        supportsFastMode: false,
        supportsTemperature: true,
        supportsMaxOutputTokens: true,
        supportsContextLimitConfig: false,
        modelSource: `${config.id} /v1/models`,
        lastVerifiedAt: checkedAt,
      });
    }

    return results;
  }

  private async discoverGemini(
    config: ProviderConfig,
    baseUrl: string,
    apiKey: string,
    checkedAt: number,
    enabledMap?: Map<string, boolean>
  ): Promise<ModelMetadata[]> {
    const response = await fetch(`${baseUrl}/v1beta/models?pageSize=100`, {
      method: 'GET',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Gemini /v1beta/models failed (HTTP ${response.status}): ${errBody || response.statusText}`);
    }

    const json = (await response.json()) as {
      models?: Array<{
        name: string;
        displayName?: string;
        description?: string;
        inputTokenLimit?: number;
        outputTokenLimit?: number;
        supportedGenerationMethods?: string[];
        thinking?: boolean;
      }>;
    };

    const items = Array.isArray(json.models) ? json.models : [];
    const seen = new Set<string>();
    const results: ModelMetadata[] = [];

    for (const item of items) {
      const methods = item.supportedGenerationMethods || [];
      if (!methods.includes('generateContent')) continue;

      const identifier = (item.name || '').replace(/^models\//, '');
      if (!identifier || seen.has(identifier)) continue;
      // Exclude embedding or non-text image-only generation models
      if (/embedding|aqa|imagen|veo/i.test(identifier)) continue;
      seen.add(identifier);

      const lower = identifier.toLowerCase();
      const supportsThinking =
        item.thinking === true || lower.includes('2.5') || lower.includes('thinking') || lower.includes('gemini-3');
      const supportedEfforts: ReasoningEffort[] = supportsThinking
        ? ['minimal', 'low', 'medium', 'high']
        : [];
      const modelId = `${config.id}/${identifier}`;

      results.push({
        id: modelId,
        displayName: item.displayName || identifier,
        providerId: config.id,
        providerName: config.name,
        modelIdentifier: identifier,
        providerType: 'CLOUD',
        availability: 'available',
        enabled: enabledMap?.has(modelId) ? enabledMap.get(modelId)! : true,
        contextWindow: typeof item.inputTokenLimit === 'number' ? item.inputTokenLimit : undefined,
        maxOutputTokens: typeof item.outputTokenLimit === 'number' ? item.outputTokenLimit : undefined,
        capabilities: {
          streaming: methods.includes('streamGenerateContent') || true,
          toolCalling: !lower.includes('gemma'),
          vision: lower.includes('gemini') ? true : undefined,
          structuredOutput: !lower.includes('gemma'),
          reasoning: supportsThinking,
        },
        reasoningEffortsSupported: supportedEfforts,
        reasoningEffortMapping: supportsThinking
          ? { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' }
          : undefined,
        defaultReasoningEffort: supportsThinking ? 'medium' : undefined,
        supportsFastMode: false,
        supportsTemperature: true,
        supportsMaxOutputTokens: true,
        supportsContextLimitConfig: false,
        modelSource: `${config.id} /v1beta/models`,
        lastVerifiedAt: checkedAt,
      });
    }

    return results;
  }

  private async discoverOpenRouter(
    config: ProviderConfig,
    baseUrl: string,
    apiKey: string,
    checkedAt: number,
    enabledMap?: Map<string, boolean>
  ): Promise<ModelMetadata[]> {
    // 1. Verify OpenRouter API key validity against account endpoint first
    const keyRes = await fetch(`${baseUrl}/auth/key`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!keyRes.ok) {
      const errBody = await keyRes.text().catch(() => '');
      throw new Error(`OpenRouter key check failed (HTTP ${keyRes.status}): ${errBody || keyRes.statusText}`);
    }

    // 2. Fetch model catalog from OpenRouter API
    const modelsRes = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(12000),
    });

    if (!modelsRes.ok) {
      const errBody = await modelsRes.text().catch(() => '');
      throw new Error(`OpenRouter /models failed (HTTP ${modelsRes.status}): ${errBody || modelsRes.statusText}`);
    }

    const json = (await modelsRes.json()) as {
      data?: Array<{
        id: string;
        name?: string;
        context_length?: number;
        pricing?: { prompt?: string; completion?: string };
        supported_parameters?: string[];
        top_provider?: { max_completion_tokens?: number };
        architecture?: { input_modalities?: string[]; output_modalities?: string[] };
      }>;
    };

    const items = Array.isArray(json.data) ? json.data : [];
    const seen = new Set<string>();
    const results: ModelMetadata[] = [];

    for (const item of items) {
      const identifier = item.id;
      if (!identifier || seen.has(identifier)) continue;
      if (item.architecture?.output_modalities && !item.architecture.output_modalities.includes('text')) {
        continue;
      }
      seen.add(identifier);

      const supportedParams = Array.isArray(item.supported_parameters) ? item.supported_parameters : [];
      const supportsTools = supportedParams.includes('tools');
      const supportsReasoning =
        supportedParams.includes('reasoning') || supportedParams.includes('include_reasoning');
      const supportsStructured =
        supportedParams.includes('structured_outputs') || supportedParams.includes('response_format');
      const supportsVision = item.architecture?.input_modalities?.includes('image');

      let pricing: ModelMetadata['pricing'] = undefined;
      if (item.pricing?.prompt !== undefined && item.pricing?.completion !== undefined) {
        const promptPerToken = parseFloat(item.pricing.prompt);
        const completionPerToken = parseFloat(item.pricing.completion);
        if (!Number.isNaN(promptPerToken) && !Number.isNaN(completionPerToken) && promptPerToken >= 0 && completionPerToken >= 0) {
          pricing = {
            inputPerM: Number((promptPerToken * 1_000_000).toFixed(4)),
            outputPerM: Number((completionPerToken * 1_000_000).toFixed(4)),
            currency: 'USD',
            source: 'openrouter /api/v1/models',
          };
        }
      }

      const supportedEfforts: ReasoningEffort[] = supportsReasoning ? ['low', 'medium', 'high'] : [];
      const modelId = `${config.id}/${identifier}`;

      results.push({
        id: modelId,
        displayName: item.name || identifier,
        providerId: config.id,
        providerName: config.name,
        modelIdentifier: identifier,
        providerType: 'CLOUD',
        availability: 'available',
        enabled: enabledMap?.has(modelId) ? enabledMap.get(modelId)! : true,
        contextWindow: typeof item.context_length === 'number' && item.context_length > 0 ? item.context_length : undefined,
        maxOutputTokens:
          typeof item.top_provider?.max_completion_tokens === 'number'
            ? item.top_provider.max_completion_tokens
            : undefined,
        capabilities: {
          streaming: true,
          toolCalling: supportedParams.length > 0 ? supportsTools : undefined,
          vision: item.architecture?.input_modalities ? Boolean(supportsVision) : undefined,
          structuredOutput: supportedParams.length > 0 ? supportsStructured : undefined,
          reasoning: supportsReasoning,
        },
        reasoningEffortsSupported: supportedEfforts,
        reasoningEffortMapping: supportsReasoning ? { low: 'low', medium: 'medium', high: 'high' } : undefined,
        defaultReasoningEffort: supportsReasoning ? 'medium' : undefined,
        supportsFastMode: false,
        supportsTemperature: supportedParams.length === 0 || supportedParams.includes('temperature'),
        supportsMaxOutputTokens: supportedParams.length === 0 || supportedParams.includes('max_tokens'),
        supportsContextLimitConfig: false,
        pricing,
        modelSource: `${config.id} /models`,
        lastVerifiedAt: checkedAt,
      });
    }

    return results;
  }

  private async discoverCustom(
    config: ProviderConfig,
    baseUrl: string,
    apiKey: string | undefined,
    checkedAt: number,
    enabledMap?: Map<string, boolean>
  ): Promise<ModelMetadata[]> {
    const isLocalHost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(baseUrl);
    const providerCategory = isLocalHost ? 'LOCAL' : 'CLOUD';
    const seen = new Set<string>();
    const results: ModelMetadata[] = [];

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    let discoveryError: Error | null = null;
    try {
      const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(8000),
      });

      if (response.ok) {
        const json = (await response.json()) as { data?: Array<{ id: string; context_length?: number }> };
        const items = Array.isArray(json.data) ? json.data : [];
        for (const item of items) {
          const identifier = item.id;
          if (!identifier || seen.has(identifier)) continue;
          seen.add(identifier);
          const modelId = `${config.id}/${identifier}`;
          results.push({
            id: modelId,
            displayName: identifier,
            providerId: config.id,
            providerName: config.name,
            modelIdentifier: identifier,
            providerType: providerCategory,
            availability: 'available',
            enabled: enabledMap?.has(modelId) ? enabledMap.get(modelId)! : true,
            contextWindow: typeof item.context_length === 'number' ? item.context_length : undefined,
            capabilities: {
              streaming: true,
              toolCalling: undefined,
              vision: undefined,
              structuredOutput: undefined,
              reasoning: undefined,
            },
            reasoningEffortsSupported: [],
            supportsFastMode: false,
            supportsTemperature: true,
            supportsMaxOutputTokens: true,
            supportsContextLimitConfig: false,
            modelSource: `${config.id} /models`,
            lastVerifiedAt: checkedAt,
          });
        }
      } else {
        const errBody = await response.text().catch(() => '');
        discoveryError = new Error(`Custom /models failed (HTTP ${response.status}): ${errBody || response.statusText}`);
      }
    } catch (err: any) {
      discoveryError = err;
    }

    // Add explicitly user-configured manual models (deduplicated against discovered IDs)
    const manualModels: ManualModelSpec[] = config.manualModels || [];
    for (const mm of manualModels) {
      if (!mm.modelIdentifier || seen.has(mm.modelIdentifier)) continue;
      seen.add(mm.modelIdentifier);
      const modelId = `${config.id}/${mm.modelIdentifier}`;
      results.push({
        id: modelId,
        displayName: mm.displayName || mm.modelIdentifier,
        providerId: config.id,
        providerName: config.name,
        modelIdentifier: mm.modelIdentifier,
        providerType: providerCategory,
        availability: 'available',
        enabled: enabledMap?.has(modelId) ? enabledMap.get(modelId)! : true,
        contextWindow: mm.contextWindow,
        maxOutputTokens: mm.maxOutputTokens,
        capabilities: {
          streaming: mm.supportsStreaming ?? true,
          toolCalling: mm.supportsToolCalling,
          vision: mm.supportsVision,
          structuredOutput: mm.supportsStructuredOutput,
          reasoning: Boolean(mm.reasoningEffortsSupported?.length),
        },
        reasoningEffortsSupported: mm.reasoningEffortsSupported || [],
        reasoningEffortMapping: mm.reasoningEffortsSupported?.length
          ? Object.fromEntries(mm.reasoningEffortsSupported.map((e) => [e, e === 'extra_high' ? 'high' : e]))
          : undefined,
        supportsFastMode: false,
        supportsTemperature: true,
        supportsMaxOutputTokens: true,
        supportsContextLimitConfig: false,
        modelSource: `${config.id} user-configured`,
        lastVerifiedAt: checkedAt,
      });
    }

    if (results.length === 0 && discoveryError) {
      throw discoveryError;
    }

    return results;
  }

  // ==================== STREAMING CHAT IMPLEMENTATIONS ====================

  public async chatStream(
    config: ProviderConfig,
    apiKey: string | undefined,
    params: ModelChatParams,
    modelMeta: ModelMetadata | undefined,
    onChunk: (chunk: ModelChatChunk) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const allowHttp = config.type === 'custom';
    const urlCheck = validateEndpointUrl(config.baseUrl, { allowHttp, allowHttpLocalhost: true });
    if (!urlCheck.valid || !urlCheck.normalizedUrl) {
      throw new Error(urlCheck.error || `Invalid endpoint for provider '${config.name}'`);
    }
    const baseUrl = urlCheck.normalizedUrl;

    if (config.type !== 'custom' && !apiKey) {
      throw new Error(`API key not configured for ${config.name}. Configure your key in Model Manager.`);
    }

    try {
      if (config.type === 'openai' || config.type === 'openrouter' || config.type === 'custom') {
        await this.streamOpenAICompatible(config, baseUrl, apiKey, params, modelMeta, onChunk, abortSignal);
      } else if (config.type === 'anthropic') {
        await this.streamAnthropic(baseUrl, apiKey!, params, modelMeta, onChunk, abortSignal);
      } else if (config.type === 'gemini') {
        await this.streamGemini(baseUrl, apiKey!, params, modelMeta, onChunk, abortSignal);
      } else {
        throw new Error(`Unsupported cloud provider type '${config.type}'.`);
      }
    } catch (err: any) {
      throw new Error(redactSecrets(err?.message || 'Provider chat error', apiKey ? [apiKey] : []));
    }
  }

  private async streamOpenAICompatible(
    config: ProviderConfig,
    baseUrl: string,
    apiKey: string | undefined,
    params: ModelChatParams,
    modelMeta: ModelMetadata | undefined,
    onChunk: (chunk: ModelChatChunk) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const messages = params.messages.map((m: ModelChatMessage) => {
      if (m.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: m.tool_call_id || `call_${m.tool_name || 'tool'}`,
          name: m.tool_name,
          content: m.content,
        };
      }
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.tool_calls.map((tc: any, idx: number) => ({
            id: tc.id || `call_${idx}_${Date.now()}`,
            type: 'function',
            function: {
              name: tc.function?.name || tc.name,
              arguments:
                typeof (tc.function?.arguments ?? tc.arguments) === 'string'
                  ? tc.function?.arguments ?? tc.arguments
                  : JSON.stringify(tc.function?.arguments ?? tc.arguments ?? {}),
            },
          })),
        };
      }
      return { role: m.role, content: m.content };
    });

    const payload: Record<string, any> = {
      model: params.modelIdentifier,
      messages,
      stream: true,
    };

    if (params.tools && params.tools.length > 0 && modelMeta?.capabilities?.toolCalling !== false) {
      payload.tools = params.tools;
    }

    if (params.temperature !== undefined && modelMeta?.supportsTemperature !== false) {
      payload.temperature = params.temperature;
    }

    if (params.maxOutputTokens !== undefined && params.maxOutputTokens > 0) {
      if (config.type === 'openai' && /^(o1|o3|o4|gpt-5)/i.test(params.modelIdentifier)) {
        payload.max_completion_tokens = params.maxOutputTokens;
      } else {
        payload.max_tokens = params.maxOutputTokens;
      }
    }

    if (params.reasoningEffort && modelMeta?.reasoningEffortsSupported?.includes(params.reasoningEffort)) {
      const mapped = modelMeta.reasoningEffortMapping?.[params.reasoningEffort];
      if (typeof mapped === 'string') {
        if (config.type === 'openrouter') {
          payload.reasoning = { effort: mapped };
        } else {
          payload.reasoning_effort = mapped;
        }
      }
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (config.type === 'openrouter') {
      headers['HTTP-Referer'] = 'https://localcoders.dev';
      headers['X-Title'] = 'LocalCoders AI IDE';
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: abortSignal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`${config.name} chat failed (${response.status}): ${errText || response.statusText}`);
    }

    if (!response.body) {
      throw new Error(`No response stream returned from ${config.name}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const accumulatedTools = new Map<number, { id?: string; name: string; arguments: string }>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || !line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (dataStr === '[DONE]') {
          const finalToolCalls = this.finalizeOpenAIToolCalls(accumulatedTools);
          onChunk({
            content: '',
            done: true,
            toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
          });
          return;
        }

        try {
          const parsed = JSON.parse(dataStr);
          if (parsed.error) {
            throw new Error(parsed.error.message || JSON.stringify(parsed.error));
          }
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc.index === 'number' ? tc.index : 0;
              const existing = accumulatedTools.get(idx) || { id: tc.id, name: '', arguments: '' };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              accumulatedTools.set(idx, existing);
            }
          }

          onChunk({
            content: delta.content || '',
            thinking: delta.reasoning_content || delta.reasoning || '',
            done: false,
          });
        } catch (err: any) {
          if (err?.message && !err.message.includes('JSON')) {
            throw err;
          }
        }
      }
    }

    const finalToolCalls = this.finalizeOpenAIToolCalls(accumulatedTools);
    onChunk({
      content: '',
      done: true,
      toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
    });
  }

  private finalizeOpenAIToolCalls(accumulated: Map<number, { id?: string; name: string; arguments: string }>): any[] {
    const out: any[] = [];
    const sorted = Array.from(accumulated.entries()).sort((a, b) => a[0] - b[0]);
    for (const [, tc] of sorted) {
      if (!tc.name) continue;
      let parsedArgs: any = tc.arguments;
      try {
        parsedArgs = tc.arguments ? JSON.parse(tc.arguments) : {};
      } catch {
        parsedArgs = {};
      }
      out.push({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: parsedArgs,
        },
      });
    }
    return out;
  }

  private async streamAnthropic(
    baseUrl: string,
    apiKey: string,
    params: ModelChatParams,
    modelMeta: ModelMetadata | undefined,
    onChunk: (chunk: ModelChatChunk) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const systemParts: string[] = [];
    const anthropicMessages: any[] = [];

    for (const m of params.messages) {
      if (m.role === 'system') {
        if (m.content) systemParts.push(m.content);
        continue;
      }
      if (m.role === 'tool') {
        anthropicMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.tool_call_id || `tool_${m.tool_name || 'call'}`,
              content: m.content,
            },
          ],
        });
        continue;
      }
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        const blocks: any[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (let i = 0; i < m.tool_calls.length; i++) {
          const tc = m.tool_calls[i];
          const fn = tc.function || tc;
          let inputObj = fn.arguments || {};
          if (typeof inputObj === 'string') {
            try {
              inputObj = JSON.parse(inputObj);
            } catch {
              inputObj = {};
            }
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id || `toolu_${i}_${Date.now()}`,
            name: fn.name,
            input: inputObj,
          });
        }
        anthropicMessages.push({ role: 'assistant', content: blocks });
        continue;
      }
      anthropicMessages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }

    const maxTokens = params.maxOutputTokens && params.maxOutputTokens > 0 ? params.maxOutputTokens : 4096;
    const payload: Record<string, any> = {
      model: params.modelIdentifier,
      messages: anthropicMessages,
      max_tokens: maxTokens,
      stream: true,
    };

    if (systemParts.length > 0) {
      payload.system = systemParts.join('\n\n');
    }

    if (params.tools && params.tools.length > 0 && modelMeta?.capabilities?.toolCalling !== false) {
      payload.tools = params.tools.map((t: any) => {
        const fn = t.function || t;
        return {
          name: fn.name,
          description: fn.description || '',
          input_schema: fn.parameters || { type: 'object', properties: {} },
        };
      });
    }

    let thinkingEnabled = false;
    if (params.reasoningEffort && modelMeta?.reasoningEffortsSupported?.includes(params.reasoningEffort)) {
      const budgetMap: Partial<Record<ReasoningEffort, number>> = {
        low: 1024,
        medium: 4096,
        high: 10000,
        extra_high: 16000,
      };
      const budget = budgetMap[params.reasoningEffort];
      if (budget) {
        thinkingEnabled = true;
        payload.thinking = { type: 'enabled', budget_tokens: budget };
        if (payload.max_tokens <= budget) {
          payload.max_tokens = budget + 2048;
        }
      }
    }

    if (!thinkingEnabled && params.temperature !== undefined) {
      payload.temperature = params.temperature;
    }

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: abortSignal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Anthropic chat failed (${response.status}): ${errText || response.statusText}`);
    }
    if (!response.body) throw new Error('No response stream from Anthropic');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolBlocks = new Map<number, { id: string; name: string; partialJson: string }>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr) continue;
        try {
          const ev = JSON.parse(dataStr);
          if (ev.type === 'error') {
            throw new Error(ev.error?.message || 'Anthropic stream error');
          }
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
            toolBlocks.set(ev.index, {
              id: ev.content_block.id,
              name: ev.content_block.name,
              partialJson: '',
            });
          } else if (ev.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta') {
              onChunk({ content: ev.delta.text || '', done: false });
            } else if (ev.delta?.type === 'thinking_delta') {
              onChunk({ content: '', thinking: ev.delta.thinking || '', done: false });
            } else if (ev.delta?.type === 'input_json_delta') {
              const block = toolBlocks.get(ev.index);
              if (block) block.partialJson += ev.delta.partial_json || '';
            }
          } else if (ev.type === 'message_stop') {
            const toolCalls = Array.from(toolBlocks.values()).map((tb) => {
              let args = {};
              try {
                args = tb.partialJson ? JSON.parse(tb.partialJson) : {};
              } catch {}
              return { id: tb.id, type: 'function', function: { name: tb.name, arguments: args } };
            });
            onChunk({ content: '', done: true, toolCalls: toolCalls.length > 0 ? toolCalls : undefined });
            return;
          }
        } catch (err: any) {
          if (err?.message && !err.message.includes('JSON')) throw err;
        }
      }
    }

    onChunk({ content: '', done: true });
  }

  private async streamGemini(
    baseUrl: string,
    apiKey: string,
    params: ModelChatParams,
    modelMeta: ModelMetadata | undefined,
    onChunk: (chunk: ModelChatChunk) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const systemParts: string[] = [];
    const contents: any[] = [];

    for (const m of params.messages) {
      if (m.role === 'system') {
        if (m.content) systemParts.push(m.content);
        continue;
      }
      if (m.role === 'tool') {
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: m.tool_name || 'tool',
                response: { result: m.content },
              },
            },
          ],
        });
        continue;
      }
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        const parts: any[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.tool_calls) {
          const fn = tc.function || tc;
          let args = fn.arguments || {};
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args);
            } catch {
              args = {};
            }
          }
          parts.push({ functionCall: { name: fn.name, args } });
        }
        contents.push({ role: 'model', parts });
        continue;
      }
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      });
    }

    const generationConfig: Record<string, any> = {};
    if (params.temperature !== undefined) generationConfig.temperature = params.temperature;
    if (params.maxOutputTokens !== undefined && params.maxOutputTokens > 0) {
      generationConfig.maxOutputTokens = params.maxOutputTokens;
    }

    if (params.reasoningEffort && modelMeta?.reasoningEffortsSupported?.includes(params.reasoningEffort)) {
      const budgetMap: Partial<Record<ReasoningEffort, number>> = {
        minimal: 0,
        low: 1024,
        medium: 4096,
        high: 12288,
      };
      const budget = budgetMap[params.reasoningEffort];
      if (budget !== undefined) {
        generationConfig.thinkingConfig = { thinkingBudget: budget };
      }
    }

    const payload: Record<string, any> = {
      contents,
      generationConfig,
    };

    if (systemParts.length > 0) {
      payload.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
    }

    if (params.tools && params.tools.length > 0 && modelMeta?.capabilities?.toolCalling !== false) {
      payload.tools = [
        {
          functionDeclarations: params.tools.map((t: any) => {
            const fn = t.function || t;
            return {
              name: fn.name,
              description: fn.description || '',
              parameters: fn.parameters || { type: 'OBJECT', properties: {} },
            };
          }),
        },
      ];
    }

    const modelPath = encodeURIComponent(params.modelIdentifier);
    const response = await fetch(`${baseUrl}/v1beta/models/${modelPath}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: abortSignal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Gemini chat failed (${response.status}): ${errText || response.statusText}`);
    }
    if (!response.body) throw new Error('No response stream from Gemini');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const collectedToolCalls: any[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr) continue;
        try {
          const parsed = JSON.parse(dataStr);
          if (parsed.error) {
            throw new Error(parsed.error.message || JSON.stringify(parsed.error));
          }
          const parts = parsed.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (part.thought && part.text) {
              onChunk({ content: '', thinking: part.text, done: false });
            } else if (part.text) {
              onChunk({ content: part.text, done: false });
            } else if (part.functionCall) {
              collectedToolCalls.push({
                type: 'function',
                function: {
                  name: part.functionCall.name,
                  arguments: part.functionCall.args || {},
                },
              });
            }
          }
        } catch (err: any) {
          if (err?.message && !err.message.includes('JSON')) throw err;
        }
      }
    }

    onChunk({
      content: '',
      done: true,
      toolCalls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
    });
  }
}
