import { exec } from 'child_process';
import { promisify } from 'util';
import { GitStatus } from '../types';

const execAsync = promisify(exec);

export class GitService {
  private workspaceRoot: string = process.cwd();

  setWorkspace(root: string) {
    this.workspaceRoot = root;
  }

  private async run(cmd: string): Promise<string> {
    const { stdout } = await execAsync(`git ${cmd}`, { cwd: this.workspaceRoot, maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  }

  async isRepo(): Promise<boolean> {
    try {
      const res = await this.run('rev-parse --is-inside-work-tree');
      return res === 'true';
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<GitStatus> {
    if (!(await this.isRepo())) {
      return { branch: '', isRepo: false, staged: [], modified: [], untracked: [] };
    }
    try {
      const branch = await this.run('branch --show-current').catch(() => 'HEAD');
      const out = await this.run('status --porcelain=v1 -uall');
      const staged: string[] = [];
      const modified: string[] = [];
      const untracked: string[] = [];

      for (const line of out.split('\n')) {
        if (!line || line.length < 3) continue;
        const idx = line[0];
        const wt = line[1];
        const file = line.substring(3).trim();

        if (idx !== ' ' && idx !== '?') staged.push(file);
        if (wt === 'M' || wt === 'D') modified.push(file);
        if (idx === '?' && wt === '?') untracked.push(file);
      }
      return { branch, isRepo: true, staged, modified, untracked };
    } catch {
      return { branch: '', isRepo: false, staged: [], modified: [], untracked: [] };
    }
  }

  async getDiff(filePath?: string, staged: boolean = false): Promise<string> {
    let cmd = staged ? 'diff --cached' : 'diff';
    if (filePath) cmd += ` -- "${filePath}"`;
    return this.run(cmd).catch(() => '');
  }

  async stage(filePath: string): Promise<boolean> {
    await this.run(`add "${filePath}"`);
    return true;
  }

  async stageAll(): Promise<boolean> {
    await this.run('add -A');
    return true;
  }

  async unstage(filePath: string): Promise<boolean> {
    await this.run(`reset HEAD "${filePath}"`);
    return true;
  }

  async commit(msg: string): Promise<boolean> {
    const esc = msg.replace(/"/g, '\\"');
    await this.run(`commit -m "${esc}"`);
    return true;
  }

  async init(): Promise<boolean> {
    try {
      await this.run('init');
      await this.run('add -A');
      await this.run('commit -m "Initial commit by LocalCoders" --allow-empty');
      return true;
    } catch {
      return false;
    }
  }

  async createCheckpoint(desc: string): Promise<string> {
    try {
      const isRepo = await this.isRepo();
      if (!isRepo) {
        const initialized = await this.init();
        if (!initialized) {
          return 'Checkpoint skipped (not a git repository)';
        }
      }

      // Check if there are any working changes to stash
      const status = await this.getStatus();
      if (status.staged.length === 0 && status.modified.length === 0 && status.untracked.length === 0) {
        return 'Working tree clean, no checkpoint stash needed.';
      }

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const message = `LocalCoders Checkpoint [${ts}]: ${desc}`;
      await this.run(`stash push -u -m "${message}"`);
      await this.run('stash apply');
      return message;
    } catch (err: any) {
      console.warn('[GitService] Checkpoint skipped:', err.message);
      return `Checkpoint skipped: ${err.message}`;
    }
  }
}
