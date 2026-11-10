import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { OperationHistoryManager } from '../commands/operation-history';

const execAsync = promisify(exec);

export function computeUnifiedLineDiff(
  relPath: string,
  beforeExists: boolean,
  beforeContent: string,
  afterExists: boolean,
  afterContent: string
): { added: number; removed: number; diffText: string } {
  const oldLines = beforeExists ? beforeContent.split('\n') : [];
  const newLines = afterExists ? afterContent.split('\n') : [];

  if (!beforeExists && afterExists) {
    return {
      added: newLines.length,
      removed: 0,
      diffText: [`--- /dev/null`, `+++ b/${relPath}`, `@@ -0,0 +1,${newLines.length} @@`, ...newLines.map((l) => `+${l}`)].join('\n'),
    };
  }
  if (beforeExists && !afterExists) {
    return {
      added: 0,
      removed: oldLines.length,
      diffText: [`--- a/${relPath}`, `+++ /dev/null`, `@@ -1,${oldLines.length} +0,0 @@`, ...oldLines.map((l) => `-${l}`)].join('\n'),
    };
  }

  // Bounded LCS diff for readable line-level stats & unified diff output
  if (oldLines.length <= 800 && newLines.length <= 800) {
    const m = oldLines.length;
    const n = newLines.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = oldLines[i] === newLines[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const diffBody: string[] = [];
    let added = 0;
    let removed = 0;
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (oldLines[i] === newLines[j]) {
        diffBody.push(` ${oldLines[i]}`);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        diffBody.push(`-${oldLines[i]}`);
        removed++;
        i++;
      } else {
        diffBody.push(`+${newLines[j]}`);
        added++;
        j++;
      }
    }
    while (i < m) {
      diffBody.push(`-${oldLines[i++]}`);
      removed++;
    }
    while (j < n) {
      diffBody.push(`+${newLines[j++]}`);
      added++;
    }
    return {
      added,
      removed,
      diffText: [`--- a/${relPath}`, `+++ b/${relPath}`, `@@ -1,${m} +1,${n} @@`, ...diffBody].join('\n'),
    };
  }

  return {
    added: newLines.length,
    removed: oldLines.length,
    diffText: [
      `--- a/${relPath}`,
      `+++ b/${relPath}`,
      `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
      ...oldLines.slice(0, 200).map((l) => `-${l}`),
      ...newLines.slice(0, 200).map((l) => `+${l}`),
    ].join('\n'),
  };
}

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
  private watcher: vscode.FileSystemWatcher | null = null;

  constructor(private workspaceRoot: string) {
    this.setupWatcher();
  }

  private setupWatcher() {
    if (this.watcher) {
      this.watcher.dispose();
    }
    const pattern = this.workspaceRoot && typeof vscode.RelativePattern === 'function'
      ? new vscode.RelativePattern(vscode.Uri.file(this.workspaceRoot), '**/*')
      : '**/*';
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidChange(() => this.refresh());
    this.watcher.onDidCreate(() => this.refresh());
    this.watcher.onDidDelete(() => this.refresh());
  }

  public setWorkspace(root: string) {
    this.workspaceRoot = root;
    this.setupWatcher();
    this.refresh();
  }

  private async runGit(cmd: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`git ${cmd}`, { cwd: this.workspaceRoot, maxBuffer: 10 * 1024 * 1024 });
      return stdout.trim();
    } catch {
      return '';
    }
  }

  private async runGitRaw(cmd: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`git ${cmd}`, { cwd: this.workspaceRoot, maxBuffer: 10 * 1024 * 1024 });
      return stdout.replace(/\r?\n$/, '');
    } catch {
      return '';
    }
  }

  private async isGitWorkspace(): Promise<boolean> {
    return (await this.runGit('rev-parse --is-inside-work-tree')) === 'true';
  }

  private getTrackedSummaryFallback(): ChangesSummary {
    const tracked = OperationHistoryManager.getInstance().getPendingTrackedChanges(this.workspaceRoot);
    const files: ChangedFile[] = [];
    let totalAdded = 0;
    let totalRemoved = 0;

    for (const item of tracked) {
      const diffStats = computeUnifiedLineDiff(
        item.filePath,
        item.beforeExists,
        item.beforeContent,
        item.afterExists,
        item.afterContent
      );
      totalAdded += diffStats.added;
      totalRemoved += diffStats.removed;
      files.push({
        path: item.filePath,
        filename: path.basename(item.filePath),
        directory: path.dirname(item.filePath) === '.' ? '' : path.dirname(item.filePath),
        status: item.status,
        added: diffStats.added,
        removed: diffStats.removed,
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

  public async getSummary(): Promise<ChangesSummary> {
    if (!(await this.isGitWorkspace())) {
      return this.getTrackedSummaryFallback();
    }

    const statusOut = await this.runGitRaw('status --porcelain=v1 -uall');
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
      const relPath = line.substring(3).trim().replace(/^"|"$/g, '');
      if (
        relPath.startsWith('.localcoders/') ||
        relPath.startsWith('.localcoders\\') ||
        relPath === '.localcoders' ||
        relPath.endsWith('audit.log') ||
        relPath.startsWith('.git/') ||
        relPath.startsWith('__pycache__/') ||
        relPath.startsWith('__pycache__\\') ||
        relPath.includes('/__pycache__/') ||
        relPath.endsWith('.pyc') ||
        relPath.startsWith('.pytest_cache/') ||
        relPath.startsWith('node_modules/') ||
        relPath.startsWith('venv/') ||
        relPath.startsWith('.venv/')
      ) {
        continue;
      }

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

  public async getFileDiff(relPath: string): Promise<string> {
    if (await this.isGitWorkspace()) {
      const diff = await this.runGit(`diff HEAD -- "${relPath}"`);
      if (diff) return diff;
    }

    const cleanRel = relPath.replace(/\\/g, '/');
    const tracked = OperationHistoryManager.getInstance()
      .getPendingTrackedChanges(this.workspaceRoot)
      .find((c) => c.filePath === cleanRel);
    if (tracked) {
      return computeUnifiedLineDiff(
        tracked.filePath,
        tracked.beforeExists,
        tracked.beforeContent,
        tracked.afterExists,
        tracked.afterContent
      ).diffText;
    }

    const fullPath = path.join(this.workspaceRoot, relPath);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        return content.split('\n').map((line) => `+${line}`).join('\n');
      } catch {
        return '';
      }
    }
    return '';
  }

  public async refresh() {
    const summary = await this.getSummary();
    this._onDidChangeChanges.fire(summary);
  }

  public async openDiff(relPath: string) {
    const fullPath = path.join(this.workspaceRoot, relPath);
    const fileUri = vscode.Uri.file(fullPath);

    if (await this.isGitWorkspace()) {
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

      try {
        const headUri = fileUri.with({ scheme: 'git', query: JSON.stringify({ path: fullPath, ref: 'HEAD' }) });
        await vscode.commands.executeCommand(
          'vscode.diff',
          headUri,
          fileUri,
          `${path.basename(relPath)} (Working Tree vs HEAD)`
        );
        return;
      } catch {}
    }

    await vscode.window.showTextDocument(fileUri);
  }

  public async acceptAll(message: string = 'Apply agent code modifications'): Promise<boolean> {
    if (!(await this.isGitWorkspace())) {
      OperationHistoryManager.getInstance().acceptPendingChanges(this.workspaceRoot);
      await this.refresh();
      vscode.window.showInformationMessage('LocalCoders: All tracked workspace changes accepted.');
      return true;
    }

    try {
      await this.runGit('add -A');
      await this.runGit(`commit -m "${message.replace(/"/g, '\\"')}"`);
      OperationHistoryManager.getInstance().acceptPendingChanges(this.workspaceRoot);
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

    if (!(await this.isGitWorkspace())) {
      OperationHistoryManager.getInstance().rejectPendingChanges(this.workspaceRoot);
      await this.refresh();
      vscode.window.showInformationMessage('LocalCoders: All modifications rejected and reverted.');
      return true;
    }

    try {
      await this.runGit('restore --staged .');
      await this.runGit('restore .');
      await this.runGit('clean -fd');
      OperationHistoryManager.getInstance().acceptPendingChanges(this.workspaceRoot);
      await this.refresh();
      vscode.window.showInformationMessage('LocalCoders: All modifications rejected and reverted.');
      return true;
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to reject changes: ${e.message}`);
      return false;
    }
  }

  public async acceptFile(relPath: string): Promise<boolean> {
    if (!(await this.isGitWorkspace())) {
      OperationHistoryManager.getInstance().acceptPendingChanges(this.workspaceRoot, relPath);
      await this.refresh();
      return true;
    }

    try {
      await this.runGit(`add "${relPath}"`);
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  public async rejectFile(relPath: string): Promise<boolean> {
    if (!(await this.isGitWorkspace())) {
      const ok = OperationHistoryManager.getInstance().rejectPendingChanges(this.workspaceRoot, relPath);
      await this.refresh();
      return ok;
    }

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
