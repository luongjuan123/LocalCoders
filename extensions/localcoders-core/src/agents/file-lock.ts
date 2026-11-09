import * as path from 'path';

export interface FileLockEntry {
  filePath: string;
  agentId: string;
  agentName: string;
  taskId: string;
  acquiredAt: number;
}

export class FileLockManager {
  private activeLocks: Map<string, FileLockEntry> = new Map();

  // Normalize path for consistent locking
  private normalize(filePath: string): string {
    return path.normalize(filePath).toLowerCase();
  }

  // Attempt to acquire lock on a file for an agent
  acquireLock(filePath: string, agentId: string, agentName: string, taskId: string): { success: boolean; conflictWith?: FileLockEntry } {
    const key = this.normalize(filePath);
    const existing = this.activeLocks.get(key);

    if (existing) {
      if (existing.agentId === agentId) {
        // Same agent can re-acquire
        return { success: true };
      }
      return { success: false, conflictWith: existing };
    }

    const entry: FileLockEntry = {
      filePath,
      agentId,
      agentName,
      taskId,
      acquiredAt: Date.now(),
    };
    this.activeLocks.set(key, entry);
    return { success: true };
  }

  // Release lock on a file
  releaseLock(filePath: string, agentId: string): boolean {
    const key = this.normalize(filePath);
    const existing = this.activeLocks.get(key);
    if (existing && existing.agentId === agentId) {
      this.activeLocks.delete(key);
      return true;
    }
    return false;
  }

  // Release all locks held by a specific agent or task
  releaseAllForAgent(agentId: string) {
    for (const [key, entry] of this.activeLocks.entries()) {
      if (entry.agentId === agentId) {
        this.activeLocks.delete(key);
      }
    }
  }

  releaseAllForTask(taskId: string) {
    for (const [key, entry] of this.activeLocks.entries()) {
      if (entry.taskId === taskId) {
        this.activeLocks.delete(key);
      }
    }
  }

  // Get active locks list
  getActiveLocks(): FileLockEntry[] {
    return Array.from(this.activeLocks.values());
  }

  // Check if a file is currently locked
  isLocked(filePath: string): boolean {
    return this.activeLocks.has(this.normalize(filePath));
  }
}
