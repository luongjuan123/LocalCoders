import { exec, execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { ChatMessage, OllamaModel, OllamaPullProgress, OllamaShowResponse } from './types';

function execFileAsync(file: string, args: string[], timeoutMs: number = 3000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export function hasOllamaManifests(modelsDir: string): boolean {
  try {
    const manifestsRoot = path.join(modelsDir, 'manifests');
    if (!fs.existsSync(manifestsRoot)) return false;
    const walk = (dir: string, depth: number): boolean => {
      if (depth > 5) return false;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const entry of entries) {
        if (entry.isFile()) return true;
        if (entry.isDirectory() && walk(path.join(dir, entry.name), depth + 1)) {
          return true;
        }
      }
      return false;
    };
    return walk(manifestsRoot, 0);
  } catch {
    return false;
  }
}

export function resolveOllamaModelsDir(
  envModels: string | undefined = process.env.OLLAMA_MODELS,
  homeDir: string = os.homedir(),
  systemDirs: string[] = ['/usr/share/ollama/.ollama/models', '/var/lib/ollama/.ollama/models']
): string | undefined {
  if (envModels && envModels.trim()) {
    return envModels.trim();
  }
  const userDir = path.join(homeDir, '.ollama', 'models');
  if (hasOllamaManifests(userDir)) {
    return undefined;
  }
  for (const dir of systemDirs) {
    if (hasOllamaManifests(dir)) {
      return dir;
    }
  }
  return undefined;
}

export function isLoopbackOllamaHost(hostUrl: string): boolean {
  try {
    const u = new URL(hostUrl);
    const h = u.hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '[::1]';
  } catch {
    return false;
  }
}

export function parseOllamaServerProcesses(
  psOutput: string,
  selfPid: number = process.pid,
  parentPid: number = process.ppid
): Array<{ pid: number; comm: string; args: string }> {
  const matches: Array<{ pid: number; comm: string; args: string }> = [];
  for (const rawLine of (psOutput || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(\S+)\s+([\s\S]+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const comm = m[2];
    const args = m[3].trim();
    if (!Number.isFinite(pid) || pid <= 1 || pid === selfPid || pid === parentPid) continue;

    const firstToken = args.split(/\s+/)[0] || '';
    const binName = path.basename(firstToken).toLowerCase();
    const commLower = path.basename(comm).toLowerCase();

    const isOllamaServeOrRunner =
      (binName === 'ollama' || commLower === 'ollama') &&
      /\b(serve|runner)\b/i.test(args);
    const isOllamaLlamaServer =
      (binName === 'llama-server' || commLower === 'llama-server') &&
      (/\/ollama\//i.test(args) || /ollama[/\\].*blobs/i.test(args));

    if (isOllamaServeOrRunner || isOllamaLlamaServer) {
      matches.push({ pid, comm, args });
    }
  }
  return matches;
}

export interface OllamaChatChunk {
  content: string;
  thinking?: string;
  done: boolean;
  toolCalls?: any[];
}

export class OllamaClient {
  private host: string;
  private chatQueue: Promise<void> = Promise.resolve();
  private managedServerPid: number | null = null;

  constructor(host: string = 'http://localhost:11434') {
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

  async listModelsStrict(): Promise<OllamaModel[]> {
    const response = await fetch(`${this.host}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Ollama /api/tags failed (HTTP ${response.status}): ${response.statusText}`);
    }

    const data = (await response.json()) as { models: OllamaModel[] };
    return data.models || [];
  }

  async listModels(): Promise<OllamaModel[]> {
    try {
      return await this.listModelsStrict();
    } catch (err: any) {
      console.error('[OllamaClient] listModels error:', err);
      return [];
    }
  }

  async showModel(name: string): Promise<OllamaShowResponse | null> {
    try {
      const res = await fetch(`${this.host}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      return (await res.json()) as OllamaShowResponse;
    } catch {
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
      maxOutputTokens?: number;
      contextWindow?: number;
      minContextWindow?: number;
      preserveLoadedContext?: boolean;
      think?: boolean | string;
      keepAlive?: string;
    },
    onChunk: (chunk: OllamaChatChunk) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const runTask = async () => {
      if (abortSignal?.aborted) {
        throw new Error('Ollama request cancelled before start.');
      }
      let resolvedParams = params;
      if (params.preserveLoadedContext) {
        try {
          const running = await this.getRunningModels();
          const active = running.find(
            (r) => r.name === params.model || r.model === params.model
          );
          const minNeeded = params.minContextWindow || 8192;
          if (
            active?.context_length &&
            active.context_length >= minNeeded &&
            active.context_length <= 32768
          ) {
            resolvedParams = { ...params, contextWindow: active.context_length };
          }
        } catch {
          // Non-fatal: keep dynamic params.contextWindow
        }
      }
      await this.executeChatStreamWithRetry(resolvedParams, onChunk, abortSignal);
    };

    const next = this.chatQueue.then(runTask, runTask);
    this.chatQueue = next.catch(() => {});
    return next;
  }

  private async executeChatStreamWithRetry(
    params: {
      model: string;
      messages: ChatMessage[];
      tools?: any[];
      temperature?: number;
      maxOutputTokens?: number;
      contextWindow?: number;
      minContextWindow?: number;
      preserveLoadedContext?: boolean;
      think?: boolean | string;
      keepAlive?: string;
    },
    onChunk: (chunk: OllamaChatChunk) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    let lastErr: any;
    for (let attempt = 0; attempt < 2; attempt++) {
      let emittedChunk = false;
      try {
        await this.executeSingleChatStream(
          params,
          (chunk) => {
            emittedChunk = true;
            onChunk(chunk);
          },
          abortSignal
        );
        return;
      } catch (err: any) {
        lastErr = err;
        const msg = String(err?.message || '');
        const isTransientCrash =
          /llama-server process no longer running|unexpected EOF|ECONNRESET|EPIPE|socket hang up|fetch failed/i.test(msg);
        if (attempt === 0 && !emittedChunk && isTransientCrash && !abortSignal?.aborted) {
          console.warn(`[OllamaClient] Transient runner error before output (${msg}); retrying once in 1500ms...`);
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 1500);
            if (abortSignal) {
              const onAbort = () => {
                clearTimeout(t);
                reject(new Error('Ollama retry aborted.'));
              };
              if (abortSignal.aborted) {
                clearTimeout(t);
                reject(new Error('Ollama retry aborted.'));
                return;
              }
              abortSignal.addEventListener('abort', onAbort, { once: true });
            }
          });
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  private async executeSingleChatStream(
    params: {
      model: string;
      messages: ChatMessage[];
      tools?: any[];
      temperature?: number;
      maxOutputTokens?: number;
      contextWindow?: number;
      think?: boolean | string;
      keepAlive?: string;
    },
    onChunk: (chunk: OllamaChatChunk) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const options: Record<string, any> = {};
    if (params.temperature !== undefined) options.temperature = params.temperature;
    if (params.maxOutputTokens !== undefined && params.maxOutputTokens > 0) {
      options.num_predict = params.maxOutputTokens;
    }
    if (params.contextWindow !== undefined && params.contextWindow > 0) {
      options.num_ctx = params.contextWindow;
    }

    // Ensure messages satisfies model chat templates (must have a non-empty user query and valid role sequence)
    const sanitizedMessages: ChatMessage[] = (params.messages || []).map((m) => {
      if (m.role === 'user' && (!m.content || !String(m.content).trim())) {
        return { ...m, content: 'Proceed with the task.' };
      }
      return { ...m };
    });
    if (sanitizedMessages.length === 0) {
      sanitizedMessages.push({ role: 'user', content: 'Begin task implementation.' });
    } else {
      const hasNonEmptyUser = sanitizedMessages.some(
        (m) => m.role === 'user' && m.content && String(m.content).trim().length > 0
      );
      if (!hasNonEmptyUser) {
        sanitizedMessages.push({ role: 'user', content: 'Continue implementation.' });
      } else {
        const last = sanitizedMessages[sanitizedMessages.length - 1];
        if (last.role === 'tool') {
          sanitizedMessages.push({
            role: 'user',
            content: 'Tool executions completed. Continue implementing the task. Use write_file to save code to disk, and run_command to run tests.',
          });
        }
      }
    }

    const payload: Record<string, any> = {
      model: params.model,
      messages: sanitizedMessages,
      stream: true,
      options,
      keep_alive: params.keepAlive || '15m',
    };

    if (params.think !== undefined) {
      payload.think = params.think;
    }

    if (params.tools && params.tools.length > 0) {
      payload.tools = params.tools;
    }

    const bodyText = JSON.stringify(payload);
    const parsedUrl = new URL(`${this.host}/api/chat`);
    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    await new Promise<void>((resolve, reject) => {
      if (abortSignal?.aborted) {
        reject(new Error('Ollama chat request aborted.'));
        return;
      }

      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const IDLE_WATCHDOG_MS = 120_000;
      let idleTimer: NodeJS.Timeout | null = null;

      const req = transport.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port ? Number(parsedUrl.port) : isHttps ? 443 : 80,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          agent: false, // Fresh connection per stream avoids stale keepalive resets and undici 300s headersTimeout
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyText),
          },
        },
        (res) => {
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) {
            const errChunks: Buffer[] = [];
            res.on('data', (d) => {
              resetIdleTimer();
              errChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
            });
            res.on('end', () => {
              const errText = Buffer.concat(errChunks).toString('utf-8');
              fail(new Error(`Ollama chat failed (${status}): ${errText}`));
            });
            res.on('error', (e) => fail(e));
            return;
          }

          const decoder = new TextDecoder();
          let buffer = '';

          const processLine = (line: string) => {
            if (!line.trim()) return;
            try {
              const parsed = JSON.parse(line);
              if (parsed.error) {
                throw new Error(`Ollama error: ${parsed.error}`);
              }
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
            } catch (err: any) {
              if (err?.message?.startsWith('Ollama error:')) {
                throw err;
              }
            }
          };

          res.on('data', (chunk) => {
            resetIdleTimer();
            try {
              buffer += decoder.decode(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              for (const line of lines) {
                processLine(line);
              }
            } catch (err: any) {
              req.destroy();
              fail(err instanceof Error ? err : new Error(String(err)));
            }
          });

          res.on('end', () => {
            try {
              if (buffer.trim()) {
                processLine(buffer);
              }
              succeed();
            } catch (err: any) {
              fail(err instanceof Error ? err : new Error(String(err)));
            }
          });

          res.on('error', (err) => {
            fail(new Error(`Ollama stream error: ${err?.message || err}`));
          });
        }
      );

      const resetIdleTimer = () => {
        if (settled) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          req.destroy();
          fail(new Error(`Ollama stream stalled with no response for ${Math.round(IDLE_WATCHDOG_MS / 1000)}s.`));
        }, IDLE_WATCHDOG_MS);
      };

      // Activity-resetting watchdog prevents infinite silence if Ollama hangs mid-stream
      // while allowing legitimate slow prompt evaluations up to 120s between chunks.
      req.setTimeout(0);
      resetIdleTimer();

      const onAbort = () => {
        req.destroy();
        fail(new Error('Ollama chat request aborted.'));
      };
      if (abortSignal) {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      const cleanup = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (abortSignal) {
          abortSignal.removeEventListener('abort', onAbort);
        }
      };

      req.on('error', (err: any) => {
        const detail = err?.code ? `${err.code}: ${err.message}` : err?.message || String(err);
        fail(new Error(`Ollama connection error (${detail})`));
      });

      req.write(bodyText);
      req.end();
    });
  }

  /**
   * Tests real model communication via POST /api/chat with minimal token output.
   */
  async testModelChat(modelName: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: 'user', content: 'Respond with OK' }],
          stream: false,
          options: { num_predict: 4 },
        }),
        signal: AbortSignal.timeout(30000),
      });
      const latencyMs = Date.now() - start;
      if (!response.ok) {
        const text = await response.text();
        return { ok: false, latencyMs, error: `HTTP ${response.status}: ${text}` };
      }
      return { ok: true, latencyMs };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - start, error: err.message || 'Model test failed' };
    }
  }

  /**
   * List all currently running Ollama models loaded in memory/VRAM
   */
  async getRunningModels(): Promise<
    Array<{ name: string; model: string; size?: number; size_vram?: number; context_length?: number }>
  > {
    try {
      const response = await fetch(`${this.host}/api/ps`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as {
        models?: Array<{ name: string; model: string; size?: number; size_vram?: number; context_length?: number }>;
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
    if (!modelName) return false;
    try {
      const [httpRes] = await Promise.allSettled([
        fetch(`${this.host}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelName, keep_alive: 0 }),
          signal: AbortSignal.timeout(2500),
        }),
        execFileAsync('ollama', ['stop', modelName], 2500),
      ]);

      return httpRes.status === 'fulfilled' && httpRes.value.ok;
    } catch (err: any) {
      console.warn(`[OllamaClient] Failed to unload model '${modelName}':`, err.message);
      await execFileAsync('ollama', ['stop', modelName], 2000).catch(() => {});
      return false;
    }
  }

  /**
   * Unload all active Ollama models, releasing GPU VRAM and system memory
   */
  async unloadAllModels(): Promise<void> {
    await this.unloadAllModelsWithList();
  }

  private async unloadAllModelsWithList(): Promise<string[]> {
    const unloaded: string[] = [];
    try {
      const running = await this.getRunningModels();
      const targets = running
        .map((m) => m.name || m.model)
        .filter((n): n is string => Boolean(n && n.trim()));

      await Promise.allSettled(
        targets.map(async (name) => {
          console.log(`[OllamaClient] Releasing model from VRAM: ${name}`);
          await this.unloadModel(name);
          unloaded.push(name);
        })
      );
    } catch (err: any) {
      console.warn('[OllamaClient] Error in unloadAllModels:', err.message);
    }
    return unloaded;
  }

  /**
   * Starts a local `ollama serve` daemon in the background if localhost Ollama is installed but not running.
   * Resolves system-wide model stores (e.g. `/usr/share/ollama/.ollama/models`) when user home has no models.
   */
  async ensureServerRunning(): Promise<{ started: boolean; alreadyRunning: boolean; error?: string }> {
    const conn = await this.checkConnection();
    const resolvedModelsDir = resolveOllamaModelsDir();

    if (conn.connected) {
      if (isLoopbackOllamaHost(this.host) && resolvedModelsDir && !hasOllamaManifests(path.join(os.homedir(), '.ollama', 'models'))) {
        const currentModels = await this.listModels();
        if (currentModels.length === 0) {
          // Existing user-owned daemon was started without system OLLAMA_MODELS; restart only if user-owned
          const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '';
          if (uid) {
            const { stdout } = await execFileAsync('ps', ['-u', uid, '-o', 'pid=,comm=,args='], 2000).catch(() => ({ stdout: '' }));
            const ownedTargets = parseOllamaServerProcesses(stdout);
            if (ownedTargets.length > 0) {
              await this.stopServerAndModels({ stopServer: true });
            } else {
              return { started: false, alreadyRunning: true };
            }
          } else {
            return { started: false, alreadyRunning: true };
          }
        } else {
          return { started: false, alreadyRunning: true };
        }
      } else {
        return { started: false, alreadyRunning: true };
      }
    }

    if (!isLoopbackOllamaHost(this.host)) {
      return { started: false, alreadyRunning: false, error: 'Remote Ollama host cannot be auto-started locally.' };
    }

    try {
      const env = { ...process.env };
      if (resolvedModelsDir && !env.OLLAMA_MODELS) {
        env.OLLAMA_MODELS = resolvedModelsDir;
      }
      const child = spawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore',
        env,
      });
      if (child.pid) {
        this.managedServerPid = child.pid;
      }
      child.unref();

      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        const check = await this.checkConnection();
        if (check.connected) {
          return { started: true, alreadyRunning: false };
        }
      }
      return { started: true, alreadyRunning: false };
    } catch (err: any) {
      return { started: false, alreadyRunning: false, error: err?.message || 'Failed to spawn ollama serve' };
    }
  }

  /**
   * Stops EVERY active Ollama model AND shuts down any local Ollama server / llama-server GPU processes
   * so closing the IDE completely frees GPU VRAM and system memory.
   */
  async stopServerAndModels(options?: { stopServer?: boolean }): Promise<{ unloadedModels: string[]; stoppedPids: number[] }> {
    const unloadedModels = await this.unloadAllModelsWithList();
    const stoppedPids: number[] = [];

    if (options?.stopServer === false || !isLoopbackOllamaHost(this.host)) {
      return { unloadedModels, stoppedPids };
    }

    try {
      if (process.platform === 'win32') {
        for (const exe of ['llama-server.exe', 'ollama.exe', 'ollama app.exe']) {
          await execFileAsync('taskkill', ['/F', '/IM', exe], 2500).catch(() => {});
        }
        return { unloadedModels, stoppedPids };
      }

      // 1. Stop systemd ollama.service cleanly only if currently active and accessible without password prompt
      try {
        await execFileAsync('systemctl', ['is-active', '--quiet', 'ollama'], 1000);
        await execFileAsync('systemctl', ['--no-ask-password', 'stop', 'ollama'], 2500).catch(() => {});
      } catch {
        // Service not active or no systemd; continue with user-level process cleanup
      }

      // 2. Terminate user-owned `ollama serve` / `ollama runner` / Ollama `llama-server` PIDs safely
      const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '';
      const psArgs = uid ? ['-u', uid, '-o', 'pid=,comm=,args='] : ['-eo', 'pid=,comm=,args='];
      const { stdout } = await execFileAsync('ps', psArgs, 2000).catch(() => ({ stdout: '', stderr: '' }));
      const targets = parseOllamaServerProcesses(stdout);

      if (this.managedServerPid && !targets.some((t) => t.pid === this.managedServerPid)) {
        targets.push({ pid: this.managedServerPid, comm: 'ollama', args: 'serve' });
      }

      // Signal `ollama serve` first so it cleans up children, then runners
      const sorted = targets.sort((a, b) => (/serve/i.test(b.args) ? 1 : 0) - (/serve/i.test(a.args) ? 1 : 0));
      for (const proc of sorted) {
        try {
          process.kill(proc.pid, 'SIGTERM');
          stoppedPids.push(proc.pid);
        } catch {}
      }

      if (stoppedPids.length > 0) {
        await new Promise((r) => setTimeout(r, 350));
        for (const pid of stoppedPids) {
          try {
            process.kill(pid, 0);
            process.kill(pid, 'SIGKILL');
          } catch {
            // Already exited cleanly
          }
        }
      }
      this.managedServerPid = null;
    } catch (err: any) {
      console.warn('[OllamaClient] Error stopping Ollama server processes:', err?.message || err);
    }

    return { unloadedModels, stoppedPids };
  }
}
