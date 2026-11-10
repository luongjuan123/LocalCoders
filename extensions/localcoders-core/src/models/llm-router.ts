import { OllamaClient } from '../ollama/client';
import { ModelProviderRegistry } from './model-provider-registry';
import {
  ModelChatChunk,
  ModelChatMessage,
  ModelParametersConfig,
  ReasoningEffort,
} from './types';

export class ModelUnavailableError extends Error {
  constructor(message: string, public readonly modelId?: string, public readonly providerId?: string) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

export interface RoutedChatRequest {
  model: string; // canonical modelId ("provider/model") or raw identifier ("qwen3.8:27b")
  messages: ModelChatMessage[];
  tools?: any[];
  temperature?: number;
  maxOutputTokens?: number;
  contextWindow?: number;
  reasoningEffort?: ReasoningEffort;
  fastMode?: boolean;
}

export class LLMRouter {
  constructor(
    private readonly ollamaClient: OllamaClient,
    private readonly modelRegistry?: ModelProviderRegistry
  ) {}

  public async chatStream(
    request: RoutedChatRequest,
    onChunk: (chunk: ModelChatChunk) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (!request.model || !request.model.trim()) {
      throw new ModelUnavailableError(
        'No AI model is currently selected. Select an installed Ollama model or configure a cloud provider in Model Manager.'
      );
    }

    // If no ModelProviderRegistry was attached (e.g. isolated unit tests with mock OllamaClient),
    // route directly to the provided client without silent model changes.
    if (!this.modelRegistry) {
      await this.ollamaClient.chatStream(
        {
          model: request.model.startsWith('ollama/') ? request.model.slice('ollama/'.length) : request.model,
          messages: request.messages.map((m) => ({
            role: m.role,
            content: m.content,
            tool_calls: m.tool_calls,
            tool_name: m.tool_name,
          })),
          tools: request.tools,
          temperature: request.temperature,
          maxOutputTokens: request.maxOutputTokens,
          contextWindow: request.contextWindow,
          think:
            request.fastMode || request.reasoningEffort === 'minimal'
              ? false
              : request.reasoningEffort,
        },
        onChunk,
        abortSignal
      );
      return;
    }

    const resolution = await this.modelRegistry.resolveModelForExecution(request.model);
    if (!resolution.ok || !resolution.model || !resolution.provider) {
      throw new ModelUnavailableError(
        resolution.error || `Model '${request.model}' is unavailable.`,
        request.model
      );
    }

    const modelMeta = resolution.model;
    const provider = resolution.provider;
    const customParams: ModelParametersConfig = modelMeta.customParameters || {};

    const effectiveTemperature =
      request.temperature !== undefined ? request.temperature : customParams.temperature;
    const effectiveMaxTokens =
      request.maxOutputTokens !== undefined ? request.maxOutputTokens : customParams.maxOutputTokens;
    const effectiveContext =
      request.contextWindow !== undefined ? request.contextWindow : customParams.contextLimit;
    const effectiveEffort =
      request.reasoningEffort !== undefined ? request.reasoningEffort : customParams.reasoningEffort;
    const effectiveFastMode =
      request.fastMode !== undefined ? request.fastMode : customParams.fastMode;

    const chatParams = {
      modelId: modelMeta.id,
      modelIdentifier: modelMeta.modelIdentifier,
      providerId: provider.id,
      messages: request.messages,
      tools: request.tools,
      temperature: effectiveTemperature,
      maxOutputTokens: effectiveMaxTokens,
      contextLimit: effectiveContext,
      reasoningEffort: effectiveEffort,
      fastMode: effectiveFastMode,
    };

    if (provider.type === 'ollama') {
      await this.modelRegistry
        .getOllamaProvider()
        .chatStream(chatParams, modelMeta, onChunk, abortSignal);
      return;
    }

    await this.modelRegistry
      .getCloudClient()
      .chatStream(provider, resolution.apiKey, chatParams, modelMeta, onChunk, abortSignal);
  }
}
