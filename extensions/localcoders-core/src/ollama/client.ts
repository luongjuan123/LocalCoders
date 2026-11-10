import { exec } from 'child_process';
import { ChatMessage, OllamaModel, OllamaPullProgress } from './types';

// Ensure long-running LLM streams (especially local models generating on CPU/GPU)
// are never terminated by Node.js undici default 300-second timeouts.
try {
  const { Agent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(
    new Agent({
      bodyTimeout: 0,
      headersTimeout: 0,
      connectTimeout: 60_000,
    })
  );
} catch {
  // Undici unavailable or global dispatcher already set
}

export interface OllamaChatChunk {
  content: string;
  thinking?: string;
  done: boolean;
  toolCalls?: any[];
}

export class OllamaClient {
  private host: string;

  constructor(host: string = 'http://127.0.0.1:11434') {
    this.host = host.replace(/\/$/, '');
  }

  setHost(host: string) {
    this.host = host.replace(/\/$/, '');
  }

  getHost(): string {
    return this.host;
  }

  async checkConnection(): Promise<{ connected: boolean; version?: string; error?: string }> {
    try {
      const response = await fetch(`${this.host}/api/version`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) {
        return { connected: false, error: `HTTP ${response.status}: ${response.statusText}` };
      }

      const data = (await response.json()) as { version: string };
      return { connected: true, version: data.version };
    } catch (err: any) {
      return { connected: false, error: err.message || 'Cannot reach Ollama service' };
    }
  }

  async listModels(): Promise<OllamaModel[]> {
    try {
      const response = await fetch(`${this.host}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`Failed to list models: ${response.statusText}`);
      }

      const data = (await response.json()) as { models: OllamaModel[] };
      return data.models || [];
    } catch (err: any) {
      console.error('[OllamaClient] listModels error:', err);
      return [];
    }
  }

  async showModel(name: string): Promise<any> {
    try {
      const res = await fetch(`${this.host}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      return await res.json();
    } catch (err: any) {
      return null;
    }
  }

  async pullModel(
    modelName: string,
    onProgress: (progress: OllamaPullProgress) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const response = await fetch(`${this.host}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName, stream: true }),
      signal: abortSignal,
    });

    if (!response.ok) {
      throw new Error(`Failed to pull model ${modelName}: HTTP ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('No response body returned from Ollama');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const percent =
            parsed.total && parsed.completed ? Math.round((parsed.completed / parsed.total) * 100) : undefined;
          onProgress({
            status: parsed.status,
            digest: parsed.digest,
            total: parsed.total,
            completed: parsed.completed,
            percent,
            error: parsed.error,
          });
          if (parsed.error) {
            throw new Error(parsed.error);
          }
        } catch (e: any) {
          if (e.message && e.message !== 'Unexpected end of JSON input') {
            throw e;
          }
        }
      }
    }
  }

  async deleteModel(modelName: string): Promise<boolean> {
    const response = await fetch(`${this.host}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
    });

    return response.ok;
  }

  async chatStream(
    params: {
      model: string;
      messages: ChatMessage[];
      tools?: any[];
      temperature?: number;
      contextWindow?: number;
      keepAlive?: string;
    },
    onChunk: (chunk: OllamaChatChunk) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const options: Record<string, any> = {};
    if (params.temperature !== undefined) options.temperature = params.temperature;
    options.num_ctx = params.contextWindow || 32768;

    const payload: Record<string, any> = {
      model: params.model,
      messages: params.messages,
      stream: true,
      options,
      keep_alive: params.keepAlive || '15m',
    };

    if (params.tools && params.tools.length > 0) {
      payload.tools = params.tools;
    }

    const response = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abortSignal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Ollama chat failed (${response.status}): ${errText}`);
    }

    if (!response.body) {
      throw new Error('No response body returned from Ollama');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const message = parsed.message || {};
          const content = message.content || '';
          const thinking = message.thinking || '';
          const toolCalls = message.tool_calls || undefined;

          onChunk({
            content,
            thinking,
            done: parsed.done === true,
            toolCalls,
          });
        } catch {
          // Ignore partial line parses
        }
      }
    }
  }

  /**
   * List all currently running Ollama models loaded in memory/VRAM
   */
  async getRunningModels(): Promise<Array<{ name: string; model: string; size?: number; size_vram?: number }>> {
    try {
      const response = await fetch(`${this.host}/api/ps`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as {
        models?: Array<{ name: string; model: string; size?: number; size_vram?: number }>;
      };
      return data.models || [];
    } catch {
      return [];
    }
  }

  /**
   * Stop and unload a specific model from Ollama (sets keep_alive to 0 to free VRAM/RAM immediately)
   */
  async unloadModel(modelName: string): Promise<boolean> {
    try {
      // 1. Unload via HTTP generate API with keep_alive: 0
      const response = await fetch(`${this.host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName, keep_alive: 0 }),
        signal: AbortSignal.timeout(4000),
      });

      // 2. Also invoke CLI 'ollama stop' for guaranteed process termination
      exec(`ollama stop "${modelName}"`, () => {});

      return response.ok;
    } catch (err: any) {
      console.warn(`[OllamaClient] Failed to unload model '${modelName}':`, err.message);
      // CLI fallback
      exec(`ollama stop "${modelName}"`, () => {});
      return false;
    }
  }

  /**
   * Unload all active Ollama models, releasing all GPU VRAM and system memory
   */
  async unloadAllModels(): Promise<void> {
    try {
      const running = await this.getRunningModels();
      for (const m of running) {
        if (m.name) {
          console.log(`[OllamaClient] Releasing model from VRAM: ${m.name}`);
          await this.unloadModel(m.name);
        }
      }
    } catch (err: any) {
      console.warn('[OllamaClient] Error in unloadAllModels:', err.message);
    }
  }
}
