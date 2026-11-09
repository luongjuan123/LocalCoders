import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as diff from 'diff';
import { FileNode } from '../types';

export class FsService {
  private workspaceRoot: string = process.cwd();

  setWorkspace(root: string) {
    this.workspaceRoot = path.resolve(root);
  }

  getWorkspace(): string {
    return this.workspaceRoot;
  }

  private assertSafe(p: string): string {
    const res = path.resolve(this.workspaceRoot, p);
    const rel = path.relative(this.workspaceRoot, res);
    if (rel.startsWith('..') && !path.isAbsolute(rel)) {
      throw new Error(`Security Violation: '${p}' is outside workspace`);
    }
    return res;
  }

  async listTree(dirPath?: string, maxDepth: number = 4, depth: number = 0): Promise<FileNode[]> {
    const target = dirPath ? this.assertSafe(dirPath) : this.workspaceRoot;
    try {
      const entries = await fs.readdir(target, { withFileTypes: true });
      const nodes: FileNode[] = [];

      const sorted = entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      for (const e of sorted) {
        if (
          e.name === '.git' ||
          e.name === 'node_modules' ||
          e.name === 'dist' ||
          e.name === 'dist-electron' ||
          e.name === '.localcoders' ||
          e.name === '.cache'
        ) {
          continue;
        }

        const full = path.join(target, e.name);
        if (e.isDirectory()) {
          nodes.push({
            name: e.name,
            path: full,
            isDirectory: true,
            children: depth < maxDepth ? await this.listTree(full, maxDepth, depth + 1) : [],
          });
        } else {
          let size = 0;
          try {
            size = (await fs.stat(full)).size;
          } catch {}
          nodes.push({
            name: e.name,
            path: full,
            isDirectory: false,
            size,
          });
        }
      }
      return nodes;
    } catch {
      return [];
    }
  }

  async readFile(filePath: string): Promise<string> {
    const full = this.assertSafe(filePath);
    return fs.readFile(full, 'utf-8');
  }

  async writeFile(filePath: string, content: string): Promise<boolean> {
    const full = this.assertSafe(filePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf-8');
    return true;
  }

  async deleteItem(itemPath: string): Promise<boolean> {
    const full = this.assertSafe(itemPath);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) {
      await fs.rm(full, { recursive: true, force: true });
    } else {
      await fs.unlink(full);
    }
    return true;
  }

  async getDiffPreview(filePath: string, newContent: string): Promise<string> {
    const full = this.assertSafe(filePath);
    let orig = '';
    if (fsSync.existsSync(full)) {
      orig = await fs.readFile(full, 'utf-8');
    }
    return diff.createPatch(path.basename(filePath), orig, newContent, 'Original', 'Agent Proposed');
  }

  async searchCodebase(query: string): Promise<Array<{ file: string; line: number; text: string }>> {
    const results: Array<{ file: string; line: number; text: string }> = [];
    const walk = async (dir: string) => {
      if (results.length >= 100) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === '.git' || e.name === 'node_modules' || e.name === 'dist') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else {
          try {
            const stat = await fs.stat(full);
            if (stat.size > 2 * 1024 * 1024) continue;
            const text = await fs.readFile(full, 'utf-8');
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                results.push({
                  file: path.relative(this.workspaceRoot, full),
                  line: i + 1,
                  text: lines[i].trim(),
                });
                if (results.length >= 100) break;
              }
            }
          } catch {}
        }
      }
    };
    await walk(this.workspaceRoot);
    return results;
  }
}
