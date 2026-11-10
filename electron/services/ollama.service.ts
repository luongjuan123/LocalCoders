import * as os from 'os';
import * as path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { HardwareInfo, OllamaCatalogueItem, OllamaModel } from '../types';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export class OllamaService {
  private host: string = 'http://127.0.0.1:11434';

  setHost(host: string) {
    this.host = host.replace(/\/$/, '');
  }

  getHost(): string {
    return this.host;
  }

  async checkConnection(): Promise<{ connected: boolean; version?: string; error?: string }> {
    try {
      const res = await fetch(`${this.host}/api/version`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { connected: false, error: `HTTP ${res.status}` };
      const data = (await res.json()) as { version: string };
      return { connected: true, version: data.version };
    } catch (e: any) {
      return { connected: false, error: e.message || 'Cannot reach Ollama' };
    }
  }

  async getHardwareInfo(): Promise<HardwareInfo> {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const cpus = os.cpus();
    const cpuModel = cpus.length > 0 ? cpus[0].model : 'CPU';

    let ollamaInstalled = false;
    let ollamaRunning = false;
    let ollamaVersion: string | undefined = undefined;

    try {
      const { stdout } = await execAsync('which ollama');
      if (stdout.trim()) ollamaInstalled = true;
    } catch {}

    const conn = await this.checkConnection();
    ollamaRunning = conn.connected;
    ollamaVersion = conn.version;

    let gpu: { name: string; memoryTotalMb: number } | undefined = undefined;
    try {
      const { stdout } = await execAsync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits');
      const lines = stdout.trim().split('\n');
      if (lines.length > 0 && lines[0].includes(',')) {
        const [name, total] = lines[0].split(',').map((s) => s.trim());
        gpu = { name, memoryTotalMb: parseInt(total, 10) || 0 };
      }
    } catch {}

    return {
      os: `${os.type()} ${os.release()}`,
      platform: os.platform(),
      cpu: { model: cpuModel, cores: cpus.length },
      ram: {
        totalGb: Math.round((totalMem / (1024 * 1024 * 1024)) * 10) / 10,
        availableGb: Math.round((freeMem / (1024 * 1024 * 1024)) * 10) / 10,
      },
      gpu,
      ollamaInstalled,
      ollamaRunning,
      ollamaVersion,
    };
  }

  async listModels(): Promise<OllamaModel[]> {
    try {
      const res = await fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return [];
      const data = (await res.json()) as { models: OllamaModel[] };
      return data.models || [];
    } catch {
      return [];
    }
  }

  getCatalogue(installed: OllamaModel[] = []): OllamaCatalogueItem[] {
    const installedNames = new Set(installed.map((m) => m.name.toLowerCase()));
    const items: Array<Omit<OllamaCatalogueItem, 'installed'>> = [
      { name: 'Qwen 2.5 Coder 7B', tag: 'qwen2.5-coder:7b', description: 'Fast code generation & multi-file reasoning.', category: 'coding', parameters: '7B', size: '4.7 GB', minRamGb: 8 },
      { name: 'Qwen 2.5 Coder 14B', tag: 'qwen2.5-coder:14b', description: 'Advanced code reasoning, refactoring & multi-agent.', category: 'coding', parameters: '14B', size: '9.0 GB', minRamGb: 16 },
      { name: 'Qwen 2.5 Coder 32B', tag: 'qwen2.5-coder:32b', description: 'Commercial-grade coding & architectural design.', category: 'coding', parameters: '32B', size: '20 GB', minRamGb: 32 },
      { name: 'DeepSeek-Coder-V2 Lite', tag: 'deepseek-coder-v2:16b', description: 'MoE architecture supporting 338 languages.', category: 'coding', parameters: '16B', size: '8.9 GB', minRamGb: 12 },
      { name: 'DeepSeek-R1 8B', tag: 'deepseek-r1:8b', description: 'Premier open reasoning model for independent Critic review.', category: 'reasoning', parameters: '8B', size: '4.9 GB', minRamGb: 10 },
      { name: 'Qwen 3.8 27B', tag: 'qwen3.8:27b', description: 'High capability thinking & tool calling model.', category: 'reasoning', parameters: '27.3B', size: '17.7 GB', minRamGb: 24 },
      { name: 'Llama 3.1 8B', tag: 'llama3.1:8b', description: 'Fast instruction-tuned general model with 128k context.', category: 'general', parameters: '8B', size: '4.7 GB', minRamGb: 8 },
      { name: 'Llama 3.2 Vision 11B', tag: 'llama3.2-vision:11b', description: 'Multimodal vision and UI understanding.', category: 'vision', parameters: '11B', size: '7.9 GB', minRamGb: 16 },
    ];

    return items.map((i) => ({
      ...i,
      installed: installedNames.has(i.tag.toLowerCase()) || installed.some((m) => m.name.toLowerCase().startsWith(i.tag.toLowerCase())),
    }));
  }

  async pullModel(modelName: string, onProgress: (data: any) => void): Promise<void> {
    const res = await fetch(`${this.host}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName, stream: true }),
    });

    if (!res.ok || !res.body) throw new Error(`Pull failed: ${res.statusText}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          const percent = json.total && json.completed ? Math.round((json.completed / json.total) * 100) : undefined;
          onProgress({ ...json, percent });
        } catch {}
      }
    }
  }

  async deleteModel(name: string): Promise<boolean> {
    const res = await fetch(`${this.host}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return res.ok;
  }

  async chatStream(
    params: { model: string; messages: any[]; tools?: any[]; temperature?: number },
    onChunk: (chunk: { content: string; thinking?: string; done: boolean; toolCalls?: any[] }) => void
  ): Promise<void> {
    const res = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        tools: params.tools,
        options: { temperature: params.temperature || 0.2 },
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      const err = await res.text();
      throw new Error(`Chat error (${res.status}): ${err}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const msg = parsed.message || {};
          onChunk({
            content: msg.content || '',
            thinking: msg.thinking || '',
            done: parsed.done === true,
            toolCalls: msg.tool_calls,
          });
        } catch {}
      }
    }
  }

  async getRunningModels(): Promise<Array<{ name: string; model: string; size?: number; size_vram?: number }>> {
    try {
      const res = await fetch(`${this.host}/api/ps`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: Array<{ name: string; model: string; size?: number; size_vram?: number }> };
      return data.models || [];
    } catch {
      return [];
    }
  }

  async unloadModel(name: string): Promise<boolean> {
    if (!name) return false;
    try {
      const [res] = await Promise.allSettled([
        fetch(`${this.host}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: name, keep_alive: 0 }),
          signal: AbortSignal.timeout(2500),
        }),
        execFileAsync('ollama', ['stop', name], { timeout: 2500 }),
      ]);
      return res.status === 'fulfilled' && res.value.ok;
    } catch {
      await execFileAsync('ollama', ['stop', name], { timeout: 2000 }).catch(() => {});
      return false;
    }
  }

  async unloadAllModels(): Promise<void> {
    try {
      const running = await this.getRunningModels();
      await Promise.allSettled(
        running
          .map((m) => m.name || m.model)
          .filter(Boolean)
          .map((name) => this.unloadModel(name))
      );
    } catch (err: any) {
      console.warn('[OllamaService] unloadAllModels error:', err.message);
    }
  }

  async stopServerAndModels(): Promise<void> {
    await this.unloadAllModels();
    try {
      const u = new URL(this.host);
      const h = u.hostname.toLowerCase();
      if (h !== '127.0.0.1' && h !== 'localhost' && h !== '::1' && h !== '0.0.0.0' && h !== '[::1]') {
        return;
      }

      if (process.platform === 'win32') {
        for (const exe of ['llama-server.exe', 'ollama.exe', 'ollama app.exe']) {
          await execFileAsync('taskkill', ['/F', '/IM', exe], { timeout: 2500 }).catch(() => {});
        }
        return;
      }

      try {
        await execFileAsync('systemctl', ['is-active', '--quiet', 'ollama'], { timeout: 1000 });
        await execFileAsync('systemctl', ['--no-ask-password', 'stop', 'ollama'], { timeout: 2500 }).catch(() => {});
      } catch {}

      const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '';
      const psArgs = uid ? ['-u', uid, '-o', 'pid=,comm=,args='] : ['-eo', 'pid=,comm=,args='];
      const { stdout } = await execFileAsync('ps', psArgs, { timeout: 2000 }).catch(() => ({ stdout: '', stderr: '' }));
      const pids: number[] = [];
      for (const raw of (stdout || '').split(/\r?\n/)) {
        const m = raw.trim().match(/^(\d+)\s+(\S+)\s+([\s\S]+)$/);
        if (!m) continue;
        const pid = parseInt(m[1], 10);
        if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) continue;
        const bin = path.basename((m[3].split(/\s+/)[0] || '')).toLowerCase();
        const comm = path.basename(m[2]).toLowerCase();
        const isOllama = (bin === 'ollama' || comm === 'ollama') && /\b(serve|runner)\b/i.test(m[3]);
        const isRunner = (bin === 'llama-server' || comm === 'llama-server') && /ollama/i.test(m[3]);
        if (isOllama || isRunner) pids.push(pid);
      }

      for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
      if (pids.length > 0) {
        await new Promise((r) => setTimeout(r, 350));
        for (const pid of pids) {
          try {
            process.kill(pid, 0);
            process.kill(pid, 'SIGKILL');
          } catch {}
        }
      }
    } catch (err: any) {
      console.warn('[OllamaService] stopServerAndModels error:', err.message);
    }
  }
}
