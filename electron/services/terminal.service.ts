import { spawn, ChildProcess } from 'child_process';

export class TerminalService {
  private workspaceRoot: string = process.cwd();
  private activeProcesses: Map<string, ChildProcess> = new Map();

  setWorkspace(root: string) {
    this.workspaceRoot = root;
  }

  isDangerous(cmd: string): boolean {
    const dangerousPatterns = [
      /\brm\s+-[rf]{1,2}\s+[\/~]/,
      /\bmkfs\b/,
      /\bdd\s+if=/,
      />\s*\/dev\/sd/,
      /\b(chmod|chown)\s+-R\s+[\/~]/,
    ];
    return dangerousPatterns.some((p) => p.test(cmd.trim()));
  }

  execute(
    id: string,
    command: string,
    onOutput: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void
  ): Promise<{ exitCode: number | null }> {
    return new Promise((resolve) => {
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
      const args = process.platform === 'win32' ? ['-Command', command] : ['-c', command];

      const child = spawn(shell, args, {
        cwd: this.workspaceRoot,
        env: { ...process.env, FORCE_COLOR: '1' },
      });

      this.activeProcesses.set(id, child);

      child.stdout.on('data', (d) => onOutput({ stream: 'stdout', text: d.toString() }));
      child.stderr.on('data', (d) => onOutput({ stream: 'stderr', text: d.toString() }));

      child.on('close', (code) => {
        this.activeProcesses.delete(id);
        resolve({ exitCode: code });
      });

      child.on('error', (err) => {
        this.activeProcesses.delete(id);
        onOutput({ stream: 'stderr', text: `Spawn error: ${err.message}\n` });
        resolve({ exitCode: -1 });
      });
    });
  }

  kill(id: string) {
    const child = this.activeProcesses.get(id);
    if (child) {
      child.kill('SIGTERM');
      this.activeProcesses.delete(id);
    }
  }
}
