import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

export interface ProjectRules {
  rulesText: string;
  projectMemoryText: string;
}

export class MemoryManager {
  private workspaceRoot: string;
  private cachedRules: ProjectRules | null = null;
  private cacheTimestamp = 0;
  private static readonly CACHE_TTL_MS = 10_000;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  setWorkspace(root: string) {
    this.workspaceRoot = root;
    this.cachedRules = null;
    this.cacheTimestamp = 0;
  }

  private getDotDir(): string {
    return path.join(this.workspaceRoot, '.localcoders');
  }

  async ensureMemoryFiles(): Promise<void> {
    const dotDir = this.getDotDir();
    if (!fsSync.existsSync(dotDir)) {
      await fs.mkdir(dotDir, { recursive: true });
    }

    const rulesPath = path.join(dotDir, 'rules.md');
    if (!fsSync.existsSync(rulesPath)) {
      const defaultRules = `# LocalCoders Project Rules

## Architecture & Conventions
- Maintain clean, modular TypeScript / JavaScript architecture.
- Follow SOLID principles and separate business logic from UI.
- Use explicit error handling; never swallow uncaught exceptions.
- Prefer comprehensive unit and integration tests for every new feature.
- Follow idiomatic formatting and lint standards.

## Security
- Validate and sanitize all user and external inputs.
- Never hardcode API keys, secrets, or passwords in source code.
`;
      await fs.writeFile(rulesPath, defaultRules, 'utf-8');
    }

    const memoryPath = path.join(dotDir, 'project-memory.md');
    if (!fsSync.existsSync(memoryPath)) {
      const defaultMemory = `# LocalCoders Project Memory

## Key Decisions & Architecture Log
- Project initialized with LocalCoders local-first multi-agent orchestration.
`;
      await fs.writeFile(memoryPath, defaultMemory, 'utf-8');
    }
  }

  async getProjectRules(forceRefresh: boolean = false): Promise<ProjectRules> {
    if (
      !forceRefresh &&
      this.cachedRules &&
      Date.now() - this.cacheTimestamp < MemoryManager.CACHE_TTL_MS
    ) {
      return this.cachedRules;
    }
    await this.ensureMemoryFiles();
    const rulesPath = path.join(this.getDotDir(), 'rules.md');
    const memoryPath = path.join(this.getDotDir(), 'project-memory.md');

    let rulesText = '';
    let projectMemoryText = '';

    try {
      if (fsSync.existsSync(rulesPath)) {
        rulesText = await fs.readFile(rulesPath, 'utf-8');
      }
      if (fsSync.existsSync(memoryPath)) {
        projectMemoryText = await fs.readFile(memoryPath, 'utf-8');
      }
    } catch (err) {
      console.error('[MemoryManager] Error reading project rules:', err);
    }

    const result = { rulesText, projectMemoryText };
    this.cachedRules = result;
    this.cacheTimestamp = Date.now();
    return result;
  }

  async updateRules(newRules: string): Promise<void> {
    await this.ensureMemoryFiles();
    const rulesPath = path.join(this.getDotDir(), 'rules.md');
    await fs.writeFile(rulesPath, newRules, 'utf-8');
    this.cachedRules = null;
  }

  async appendToMemory(entry: string): Promise<void> {
    await this.ensureMemoryFiles();
    const memoryPath = path.join(this.getDotDir(), 'project-memory.md');
    const timestamp = new Date().toISOString();
    const formatted = `\n### [${timestamp}]\n${entry}\n`;
    await fs.appendFile(memoryPath, formatted, 'utf-8');
    this.cachedRules = null;
  }
}
