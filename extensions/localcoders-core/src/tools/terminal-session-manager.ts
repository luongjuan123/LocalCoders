import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildWorkspaceCommandEnv, getPreferredShell } from './terminal-tools';

const ANSI_ESCAPE_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

export function stripAnsiSequences(text: string): string {
  return String(text || '').replace(ANSI_ESCAPE_RE, '');
}

export interface TerminalTabSnapshot {
  id: string;
  name: string;
  cwd: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'killed';
  activeCommand?: string;
  exitCode?: number | null;
  pid?: number;
  lines: Array<{ stream: 'stdout' | 'stderr' | 'system'; text: string; timestamp: number }>;
  createdAt: number;
}

interface InternalTab extends TerminalTabSnapshot {
  child?: ChildProcess;
}

/**
 * Manages real interactive workspace shell terminal tabs for the Agent View Terminal area.
 */
export class TerminalSessionManager {
  private static instance: TerminalSessionManager;
  private tabs: Map<string, InternalTab> = new Map();
  private tabCounter = 0;
  private defaultCwd: string = process.cwd();
  private listeners: Array<(tabs: TerminalTabSnapshot[]) => void> = [];
  private maxLines = 400;

  public static getInstance(): TerminalSessionManager {
    if (!TerminalSessionManager.instance) {
      TerminalSessionManager.instance = new TerminalSessionManager();
    }
    return TerminalSessionManager.instance;
  }

  public setDefaultCwd(cwd: string): void {
    if (cwd && fs.existsSync(cwd)) {
      this.defaultCwd = cwd;
      if (this.tabs.size === 0) {
        this.createTab(cwd, 'Terminal 1');
        return;
      }
      let updated = false;
      for (const tab of this.tabs.values()) {
        if (tab.status === 'idle' && tab.lines.length <= 1 && tab.cwd !== cwd) {
          tab.cwd = cwd;
          tab.lines = [
            {
              stream: 'system',
              text: `Working directory: ${cwd}`,
              timestamp: Date.now(),
            },
          ];
          updated = true;
        }
      }
      if (updated) {
        this.emit();
      }
    }
  }

  public onDidChange(cb: (tabs: TerminalTabSnapshot[]) => void): { dispose: () => void } {
    this.listeners.push(cb);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== cb);
      },
    };
  }

  private emit(): void {
    const snap = this.getTabs();
    for (const cb of [...this.listeners]) {
      try {
        cb(snap);
      } catch {}
    }
  }

  public ensureDefaultTab(cwd?: string): TerminalTabSnapshot {
    if (this.tabs.size > 0) {
      return this.getTabs()[0];
    }
    return this.createTab(cwd || this.defaultCwd, 'Terminal 1');
  }

  public createTab(cwd?: string, name?: string): TerminalTabSnapshot {
    this.tabCounter++;
    const resolvedCwd = cwd && fs.existsSync(cwd) ? cwd : this.defaultCwd;
    const id = `term_${Date.now()}_${this.tabCounter}`;
    const tab: InternalTab = {
      id,
      name: name || `Terminal ${this.tabCounter}`,
      cwd: resolvedCwd,
      status: 'idle',
      lines: [
        {
          stream: 'system',
          text: `Working directory: ${resolvedCwd}`,
          timestamp: Date.now(),
        },
      ],
      createdAt: Date.now(),
    };
    this.tabs.set(id, tab);
    this.emit();
    return this.toSnapshot(tab);
  }

  public closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (tab.status === 'running') {
      this.terminateTab(tabId);
    }
    this.tabs.delete(tabId);
    if (this.tabs.size === 0) {
      this.createTab(this.defaultCwd, 'Terminal 1');
    } else {
      this.emit();
    }
  }

  public clearTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.lines = [
      {
        stream: 'system',
        text: `Working directory: ${tab.cwd}`,
        timestamp: Date.now(),
      },
    ];
    this.emit();
  }

  public getTabs(): TerminalTabSnapshot[] {
    return Array.from(this.tabs.values()).map((t) => this.toSnapshot(t));
  }

  private toSnapshot(tab: InternalTab): TerminalTabSnapshot {
    return {
      id: tab.id,
      name: tab.name,
      cwd: tab.cwd,
      status: tab.status,
      activeCommand: tab.activeCommand,
      exitCode: tab.exitCode,
      pid: tab.pid,
      lines: [...tab.lines],
      createdAt: tab.createdAt,
    };
  }

  private pushLine(tab: InternalTab, stream: 'stdout' | 'stderr' | 'system', raw: string): void {
    const cleanRaw = stripAnsiSequences(raw);
    const parts = cleanRaw.split(/\r?\n/);
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      if (!text && i === parts.length - 1) continue;
      tab.lines.push({ stream, text, timestamp: Date.now() });
      if (tab.lines.length > this.maxLines) {
        tab.lines.shift();
      }
    }
  }

  public runCommand(tabId: string, command: string): void {
    const tab = this.tabs.get(tabId) || this.tabs.values().next().value;
    if (!tab) return;

    // Handle running process: forward input (including bare Enter) to stdin
    if (tab.status === 'running' && tab.child) {
      this.writeStdin(tab.id, command || '');
      return;
    }

    const cmd = (command || '').trim();
    if (!cmd) return;

    this.pushLine(tab, 'system', `$ ${cmd}`);

    // Support standalone `cd <target>` without hijacking compound commands like `cd dir && ls`
    const isCompound = /&&|\|\||[;|><]/.test(cmd);
    if (!isCompound && /^cd(?:\s+.*)?$/.test(cmd)) {
      let targetArg = cmd.slice(2).trim();
      if (
        (targetArg.startsWith('"') && targetArg.endsWith('"')) ||
        (targetArg.startsWith("'") && targetArg.endsWith("'"))
      ) {
        targetArg = targetArg.slice(1, -1);
      }
      if (!targetArg || targetArg === '~') {
        targetArg = os.homedir();
      } else if (targetArg.startsWith('~/')) {
        targetArg = path.join(os.homedir(), targetArg.slice(2));
      }
      const nextCwd = path.resolve(tab.cwd, targetArg);
      if (fs.existsSync(nextCwd) && fs.statSync(nextCwd).isDirectory()) {
        tab.cwd = nextCwd;
        tab.status = 'completed';
        tab.exitCode = 0;
        this.pushLine(tab, 'system', `Directory changed to ${nextCwd}`);
      } else {
        tab.status = 'failed';
        tab.exitCode = 1;
        this.pushLine(tab, 'stderr', `cd: no such directory: ${nextCwd}`);
      }
      this.emit();
      return;
    }

    if (cmd === 'clear') {
      this.clearTab(tab.id);
      return;
    }

    if (!fs.existsSync(tab.cwd)) {
      tab.status = 'failed';
      tab.exitCode = 1;
      this.pushLine(tab, 'stderr', `Working directory does not exist: ${tab.cwd}`);
      this.emit();
      return;
    }

    const child = spawn(cmd, {
      cwd: tab.cwd,
      shell: getPreferredShell(),
      detached: process.platform !== 'win32',
      env: buildWorkspaceCommandEnv(tab.cwd),
    });

    tab.child = child;
    tab.pid = child.pid;
    tab.activeCommand = cmd;
    tab.status = 'running';
    tab.exitCode = null;
    this.emit();

    let flushTimer: NodeJS.Timeout | null = null;
    const scheduleEmit = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        this.emit();
      }, 80);
    };

    child.stdout?.on('data', (d: Buffer) => {
      this.pushLine(tab, 'stdout', d.toString('utf-8'));
      scheduleEmit();
    });

    child.stderr?.on('data', (d: Buffer) => {
      this.pushLine(tab, 'stderr', d.toString('utf-8'));
      scheduleEmit();
    });

    child.on('close', (code) => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (tab.status !== 'killed') {
        tab.status = code === 0 ? 'completed' : 'failed';
      }
      tab.exitCode = code;
      tab.child = undefined;
      tab.pid = undefined;
      tab.activeCommand = undefined;
      this.pushLine(tab, 'system', `[Process exited with code ${code ?? 'killed'}]`);
      this.emit();
    });

    child.on('error', (err) => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      tab.status = 'failed';
      tab.exitCode = 1;
      tab.child = undefined;
      tab.pid = undefined;
      tab.activeCommand = undefined;
      this.pushLine(tab, 'stderr', `Error: ${err.message}`);
      this.emit();
    });
  }

  public writeStdin(tabId: string, input: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab || !tab.child || !tab.child.stdin || tab.status !== 'running') {
      return false;
    }
    const cleanInput = String(input ?? '').replace(/\r?\n$/, '');
    this.pushLine(tab, 'system', cleanInput ? `> ${cleanInput}` : '> (Enter)');
    tab.child.stdin.write(cleanInput + '\n');
    this.emit();
    return true;
  }

  public terminateTab(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab || !tab.child || tab.status !== 'running') {
      return false;
    }
    tab.status = 'killed';
    try {
      if (tab.child.pid && process.platform !== 'win32') {
        try {
          process.kill(-tab.child.pid, 'SIGKILL');
        } catch {
          tab.child.kill('SIGKILL');
        }
      } else {
        tab.child.kill('SIGKILL');
      }
    } catch {}
    tab.child = undefined;
    tab.pid = undefined;
    tab.activeCommand = undefined;
    this.pushLine(tab, 'system', '[Process terminated by user]');
    this.emit();
    return true;
  }

  public terminateAll(): void {
    for (const tab of this.tabs.values()) {
      if (tab.status === 'running' && tab.child) {
        this.terminateTab(tab.id);
      }
    }
  }
}
