import * as fs from 'fs/promises';
import * as path from 'path';

export interface WorkspaceSummary {
  rootName: string;
  packageDependencies: Record<string, string>;
  projectType: string;
  keyFiles: string[];
  fileTreeSummary: string;
}

export class CodebaseIndexer {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  setWorkspace(root: string) {
    this.workspaceRoot = root;
  }

  async index(): Promise<WorkspaceSummary> {
    const rootName = path.basename(this.workspaceRoot);
    let packageDependencies: Record<string, string> = {};
    let projectType = 'general';

    // Check for package.json
    try {
      const pkgPath = path.join(this.workspaceRoot, 'package.json');
      const content = await fs.readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      packageDependencies = { ...pkg.dependencies, ...pkg.devDependencies };
      projectType = 'node/typescript';
    } catch {
      // not node or no package.json
    }

    const keyFiles: string[] = [];
    const treeLines: string[] = [];

    async function scan(dir: string, depth: number = 0) {
      if (depth > 2) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (
          entry.name === '.git' ||
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === '.localcoders' ||
          entry.name === '.cache'
        ) {
          continue;
        }

        const indent = '  '.repeat(depth);
        const rel = path.relative(dir, path.join(dir, entry.name));

        if (entry.isDirectory()) {
          treeLines.push(`${indent}📁 ${entry.name}/`);
          await scan(path.join(dir, entry.name), depth + 1);
        } else {
          treeLines.push(`${indent}📄 ${entry.name}`);
          if (
            entry.name.endsWith('.json') ||
            entry.name.endsWith('.md') ||
            entry.name.includes('config') ||
            entry.name.startsWith('index.') ||
            entry.name.startsWith('main.') ||
            entry.name.startsWith('app.')
          ) {
            keyFiles.push(path.relative(dir, path.join(dir, entry.name)));
          }
        }
      }
    }

    try {
      await scan(this.workspaceRoot);
    } catch {
      // ignore
    }

    return {
      rootName,
      packageDependencies,
      projectType,
      keyFiles: keyFiles.slice(0, 20),
      fileTreeSummary: treeLines.slice(0, 60).join('\n'),
    };
  }

  // Token budgeting estimation (~4 characters per token)
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
