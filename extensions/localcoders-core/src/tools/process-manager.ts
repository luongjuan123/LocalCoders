import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';

export interface ManagedProcess {
  id: string;
  command: string;
  cwd: string;
  pid: number | undefined;
  startTime: number;
  status: 'running' | 'completed' | 'failed' | 'terminated';
  exitCode: number | null;
  outputBuffer: string[];
  maxBufferLines: number;
  child: ChildProcess;
}

export class ProcessManager {
  private static instance: ProcessManager;
  private processes: Map<string, ManagedProcess> = new Map();

  public static getInstance(): ProcessManager {
    if (!ProcessManager.instance) {
      ProcessManager.instance = new ProcessManager();
    }
    return ProcessManager.instance;
  }

  public startProcess(id: string, command: string, cwd: string, env?: Record<string, string>): ManagedProcess {
    // If process with this ID is already running, terminate it first
    if (this.processes.has(id)) {
      this.terminateProcess(id);
    }

    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, ...env },
    });

    const managed: ManagedProcess = {
      id,
      command,
      cwd,
      pid: child.pid,
      startTime: Date.now(),
      status: 'running',
      exitCode: null,
      outputBuffer: [],
      maxBufferLines: 1000,
      child,
    };

    const appendLog = (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      const lines = text.split('\n');
      for (const line of lines) {
        if (line) {
          managed.outputBuffer.push(`[${new Date().toISOString()}] ${line}`);
          if (managed.outputBuffer.length > managed.maxBufferLines) {
            managed.outputBuffer.shift();
          }
        }
      }
    };

    child.stdout?.on('data', appendLog);
    child.stderr?.on('data', appendLog);

    child.on('close', (code) => {
      managed.status = code === 0 ? 'completed' : 'failed';
      managed.exitCode = code;
    });

    child.on('error', (err) => {
      managed.status = 'failed';
      managed.outputBuffer.push(`[ERROR] ${err.message}`);
    });

    this.processes.set(id, managed);
    return managed;
  }

  public getProcess(id: string): ManagedProcess | undefined {
    return this.processes.get(id);
  }

  public isProcessRunning(id: string): boolean {
    const p = this.processes.get(id);
    return !!p && p.status === 'running';
  }

  public readOutput(id: string, tailLines: number = 50): string[] {
    const p = this.processes.get(id);
    if (!p) return [];
    return p.outputBuffer.slice(-tailLines);
  }

  public writeStdin(id: string, input: string): boolean {
    const p = this.processes.get(id);
    if (!p || p.status !== 'running' || !p.child.stdin) return false;
    p.child.stdin.write(input.endsWith('\n') ? input : input + '\n');
    return true;
  }

  public terminateProcess(id: string): boolean {
    const p = this.processes.get(id);
    if (!p) return false;
    if (p.status === 'running') {
      try {
        if (p.child.pid) {
          try {
            require('child_process').execSync(`pkill -P ${p.child.pid} 2>/dev/null || true; kill -9 ${p.child.pid} 2>/dev/null || true`);
          } catch {}
        }
        p.child.kill('SIGKILL');
      } catch {
        // ignore
      }
      p.status = 'terminated';
    }
    return true;
  }

  public listProcesses(): Array<{
    id: string;
    command: string;
    pid: number | undefined;
    status: string;
    durationMs: number;
  }> {
    return Array.from(this.processes.values()).map((p) => ({
      id: p.id,
      command: p.command,
      pid: p.pid,
      status: p.status,
      durationMs: Date.now() - p.startTime,
    }));
  }

  public async checkPortListening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const client = new net.Socket();
      client.setTimeout(400);
      client.once('connect', () => {
        client.destroy();
        resolve(true);
      });
      client.once('timeout', () => {
        client.destroy();
        resolve(false);
      });
      client.once('error', () => {
        client.destroy();
        resolve(false);
      });
      client.connect(port, '127.0.0.1');
    });
  }

  public terminateAll(): void {
    for (const [id] of this.processes) {
      this.terminateProcess(id);
    }
  }
}
