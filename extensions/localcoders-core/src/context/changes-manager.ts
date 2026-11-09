import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface ChangedFile {
  path: string;
  filename: string;
  directory: string;
  status: 'M' | 'A' | 'D' | 'R' | '?';
  added: number;
  removed: number;
  reviewed: boolean;
}

export interface ChangesSummary {
  totalFiles: number;
  totalAdded: number;
  totalRemoved: number;
  files: ChangedFile[];
}

export class ChangesManager {
  private _onDidChangeChanges = new vscode.EventEmitter<ChangesSummary>();
  public readonly onDidChangeChanges = this._onDidChangeChanges.event;

  constructor(private workspaceRoot: string) {
    // Watch workspace filesystem changes to refresh diffs
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidChange(() => this.refresh());
    watcher.onDidCreate(() => this.refresh());
    watcher.onDidDelete(() => this.refresh());
  }

  private async runGit(cmd: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`git ${cmd}`, { cwd: this.workspaceRoot, maxBuffer: 10 * 1024 * 1024 });
      return stdout.trim();
    } catch {
      return '';
    }
  }

  public async getSummary(): Promise<ChangesSummary> {
    const isRepo = await this.runGit('rev-parse --is-inside-work-tree');
    if (isRepo !== 'true') {
      return { totalFiles: 0, totalAdded: 0, totalRemoved: 0, files: [] };
    }

    const statusOut = await this.runGit('status --porcelain=v1 -uall');
    if (!statusOut) {
      return { totalFiles: 0, totalAdded: 0, totalRemoved: 0, files: [] };
    }

    // Get numstat for line count additions/deletions
    const diffStat = await this.runGit('diff --numstat HEAD');
    const statsMap = new Map<string, { added: number; removed: number }>();

    for (const line of diffStat.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const added = parseInt(parts[0], 10) || 0;
        const removed = parseInt(parts[1], 10) || 0;
        const file = parts[2].trim();
        statsMap.set(file, { added, removed });
      }
    }

    const files: ChangedFile[] = [];
    let totalAdded = 0;
    let totalRemoved = 0;

    for (const line of statusOut.split('\n')) {
      if (!line || line.length < 3) continue;
      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const relPath = line.substring(3).trim();

      let statusType: 'M' | 'A' | 'D' | 'R' | '?' = 'M';
      if (indexStatus === 'A' || workTreeStatus === '?' || (indexStatus === '?' && workTreeStatus === '?')) {
        statusType = 'A';
      } else if (indexStatus === 'D' || workTreeStatus === 'D') {
        statusType = 'D';
      } else if (indexStatus === 'R') {
        statusType = 'R';
      }

      const stat = statsMap.get(relPath) || { added: 0, removed: 0 };
      // For newly untracked files, estimate line count
      if (statusType === 'A' && stat.added === 0) {
        try {
          const full = path.join(this.workspaceRoot, relPath);
          if (fs.existsSync(full)) {
            const lines = fs.readFileSync(full, 'utf-8').split('\n').length;
            stat.added = lines;
          }
        } catch {}
      }

      totalAdded += stat.added;
      totalRemoved += stat.removed;

      files.push({
        path: relPath,
        filename: path.basename(relPath),
        directory: path.dirname(relPath) === '.' ? '' : path.dirname(relPath),
        status: statusType,
        added: stat.added,
        removed: stat.removed,
        reviewed: false,
      });
    }

    return {
      totalFiles: files.length,
      totalAdded,
      totalRemoved,
      files,
    };
  }

  public async refresh() {
    const summary = await this.getSummary();
    this._onDidChangeChanges.fire(summary);
  }

  public async openDiff(relPath: string) {
    const fullPath = path.join(this.workspaceRoot, relPath);
    const fileUri = vscode.Uri.file(fullPath);

    // If file exists in git HEAD, compare against HEAD
    try {
      const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
      if (gitExtension) {
        const api = gitExtension.getAPI(1);
        const repo = api.getRepository(fileUri);
        if (repo) {
          await vscode.commands.executeCommand('git.openChange', fileUri);
          return;
        }
      }
    } catch {}

    // Fallback: Use vscode.diff command with git: URI or show file
    try {
      const headUri = fileUri.with({ scheme: 'git', query: JSON.stringify({ path: fullPath, ref: 'HEAD' }) });
      await vscode.commands.executeCommand(
        'vscode.diff',
        headUri,
        fileUri,
        `${path.basename(relPath)} (Working Tree vs HEAD)`
      );
    } catch {
      await vscode.window.showTextDocument(fileUri);
    }
  }

  public async acceptAll(message: string = 'Apply agent code modifications'): Promise<boolean> {
    try {
      await this.runGit('add -A');
      await this.runGit(`commit -m "${message.replace(/"/g, '\\"')}"`);
      await this.refresh();
      vscode.window.showInformationMessage('LocalCoders: All code changes accepted and committed.');
      return true;
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to accept changes: ${e.message}`);
      return false;
    }
  }

  public async rejectAll(): Promise<boolean> {
    const confirm = await vscode.window.showWarningMessage(
      'Are you sure you want to discard all agent modifications?',
      { modal: true },
      'Discard All'
    );
    if (confirm !== 'Discard All') return false;

    try {
      await this.runGit('restore --staged .');
      await this.runGit('restore .');
      await this.runGit('clean -fd');
      await this.refresh();
      vscode.window.showInformationMessage('LocalCoders: All modifications rejected and reverted.');
      return true;
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to reject changes: ${e.message}`);
      return false;
    }
  }

  public async acceptFile(relPath: string): Promise<boolean> {
    try {
      await this.runGit(`add "${relPath}"`);
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  public async rejectFile(relPath: string): Promise<boolean> {
    try {
      await this.runGit(`restore --staged "${relPath}"`);
      await this.runGit(`restore "${relPath}"`);
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }
}
