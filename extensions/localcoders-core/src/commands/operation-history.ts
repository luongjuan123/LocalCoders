import * as fs from 'fs';
import * as path from 'path';
import { assertWithinWorkspace } from '../tools/fs-tools';

export interface FileOperationRecord {
  id: string;
  workspaceRoot: string;
  type: 'write' | 'edit' | 'rename' | 'delete';
  filePath: string; // workspace-relative path
  newPath?: string; // for rename
  beforeExists: boolean;
  beforeContent: string;
  afterExists: boolean;
  afterContent: string;
  description: string;
  timestamp: number;
}

export interface UndoRedoOutcome {
  ok: boolean;
  message: string;
  record?: FileOperationRecord;
  remainingUndo: number;
  remainingRedo: number;
}

export interface PendingTrackedChange {
  filePath: string;
  status: 'M' | 'A' | 'D';
  beforeExists: boolean;
  beforeContent: string;
  afterExists: boolean;
  afterContent: string;
}

interface BaselineEntry {
  beforeExists: boolean;
  beforeContent: string;
}

function isIgnoredWorkspaceRelPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return (
    !norm ||
    norm === '.localcoders' ||
    norm.startsWith('.localcoders/') ||
    norm === '.git' ||
    norm.startsWith('.git/') ||
    norm.startsWith('node_modules/') ||
    norm.startsWith('__pycache__/') ||
    norm.includes('/__pycache__/') ||
    norm.endsWith('.pyc') ||
    norm.startsWith('.pytest_cache/') ||
    norm.startsWith('venv/') ||
    norm.startsWith('.venv/')
  );
}

/**
 * Tracks reversible workspace file operations executed through LocalCoders tools
 * so /undo, /redo, and non-Git Changes review operate on real file state while preserving workspace boundaries.
 */
export class OperationHistoryManager {
  private static instance: OperationHistoryManager;
  private undoStacks: Map<string, FileOperationRecord[]> = new Map();
  private redoStacks: Map<string, FileOperationRecord[]> = new Map();
  private pendingBaselines: Map<string, Map<string, BaselineEntry>> = new Map();
  private readonly maxPerWorkspace = 50;

  public static getInstance(): OperationHistoryManager {
    if (!OperationHistoryManager.instance) {
      OperationHistoryManager.instance = new OperationHistoryManager();
    }
    return OperationHistoryManager.instance;
  }

  private normalizeRoot(root: string): string {
    return path.resolve(root || process.cwd());
  }

  private getPendingMap(root: string): Map<string, BaselineEntry> {
    const key = this.normalizeRoot(root);
    let map = this.pendingBaselines.get(key);
    if (!map) {
      map = new Map<string, BaselineEntry>();
      const persisted = this.loadPersistedBaselines(key);
      for (const [k, v] of persisted.entries()) {
        map.set(k, v);
      }
      this.pendingBaselines.set(key, map);
    }
    return map;
  }

  private getPendingFilePath(root: string): string {
    return path.join(this.normalizeRoot(root), '.localcoders', 'pending-changes.json');
  }

  private loadPersistedBaselines(root: string): Map<string, BaselineEntry> {
    const out = new Map<string, BaselineEntry>();
    try {
      const p = this.getPendingFilePath(root);
      if (!fs.existsSync(p)) return out;
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
          if (v && typeof v === 'object' && !isIgnoredWorkspaceRelPath(k)) {
            out.set(k, {
              beforeExists: Boolean((v as any).beforeExists),
              beforeContent: typeof (v as any).beforeContent === 'string' ? (v as any).beforeContent : '',
            });
          }
        }
      }
    } catch {
      // Ignore malformed persisted pending-changes metadata
    }
    return out;
  }

  private savePersistedBaselines(root: string, map: Map<string, BaselineEntry>): void {
    try {
      const p = this.getPendingFilePath(root);
      if (map.size === 0) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
        return;
      }
      // Only persist if workspace .localcoders dir already exists or create only when pending entries exist
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj: Record<string, BaselineEntry> = {};
      for (const [k, v] of map.entries()) {
        // Cap individual baseline snapshot at 512KB to keep metadata lightweight
        if (v.beforeContent.length <= 512 * 1024) {
          obj[k] = v;
        }
      }
      fs.writeFileSync(p, JSON.stringify(obj), 'utf-8');
    } catch {
      // Non-fatal persistence error
    }
  }

  private recordBaseline(root: string, relPath: string, beforeExists: boolean, beforeContent: string): void {
    const cleanRel = relPath.replace(/\\/g, '/');
    if (isIgnoredWorkspaceRelPath(cleanRel)) return;
    const map = this.getPendingMap(root);
    if (!map.has(cleanRel)) {
      map.set(cleanRel, { beforeExists, beforeContent });
      this.savePersistedBaselines(root, map);
    }
  }

  private getUndoStack(root: string): FileOperationRecord[] {
    const key = this.normalizeRoot(root);
    let stack = this.undoStacks.get(key);
    if (!stack) {
      stack = [];
      this.undoStacks.set(key, stack);
    }
    return stack;
  }

  private getRedoStack(root: string): FileOperationRecord[] {
    const key = this.normalizeRoot(root);
    let stack = this.redoStacks.get(key);
    if (!stack) {
      stack = [];
      this.redoStacks.set(key, stack);
    }
    return stack;
  }

  public record(entry: Omit<FileOperationRecord, 'id' | 'timestamp'>): FileOperationRecord {
    const root = this.normalizeRoot(entry.workspaceRoot);
    const undo = this.getUndoStack(root);
    const redo = this.getRedoStack(root);
    const rec: FileOperationRecord = {
      ...entry,
      workspaceRoot: root,
      id: `op_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
    };
    undo.push(rec);
    if (undo.length > this.maxPerWorkspace) {
      undo.shift();
    }
    redo.length = 0; // New mutation invalidates redo branch

    if (entry.type === 'rename' && entry.newPath) {
      this.recordBaseline(root, entry.filePath, entry.beforeExists, entry.beforeContent);
      this.recordBaseline(root, entry.newPath, false, '');
    } else {
      this.recordBaseline(root, entry.filePath, entry.beforeExists, entry.beforeContent);
    }

    return rec;
  }

  public getPendingTrackedChanges(workspaceRoot: string): PendingTrackedChange[] {
    const root = this.normalizeRoot(workspaceRoot);
    if (!root || !fs.existsSync(root)) return [];
    const map = this.getPendingMap(root);
    const results: PendingTrackedChange[] = [];

    for (const [relPath, baseline] of map.entries()) {
      if (isIgnoredWorkspaceRelPath(relPath)) continue;
      let absPath: string;
      try {
        absPath = assertWithinWorkspace(root, relPath);
      } catch {
        continue;
      }
      const afterExists = fs.existsSync(absPath);
      let afterContent = '';
      if (afterExists) {
        try {
          const stat = fs.statSync(absPath);
          if (!stat.isFile()) continue;
          afterContent = fs.readFileSync(absPath, 'utf-8');
        } catch {
          continue;
        }
      }

      if (!baseline.beforeExists && !afterExists) continue;
      if (baseline.beforeExists && afterExists && afterContent === baseline.beforeContent) continue;

      const status: 'M' | 'A' | 'D' = !baseline.beforeExists ? 'A' : !afterExists ? 'D' : 'M';
      results.push({
        filePath: relPath,
        status,
        beforeExists: baseline.beforeExists,
        beforeContent: baseline.beforeContent,
        afterExists,
        afterContent,
      });
    }

    return results;
  }

  public acceptPendingChanges(workspaceRoot: string, targetRelPath?: string): void {
    const root = this.normalizeRoot(workspaceRoot);
    const map = this.getPendingMap(root);
    if (targetRelPath) {
      map.delete(targetRelPath.replace(/\\/g, '/'));
    } else {
      map.clear();
    }
    this.savePersistedBaselines(root, map);
  }

  public rejectPendingChanges(workspaceRoot: string, targetRelPath?: string): boolean {
    const root = this.normalizeRoot(workspaceRoot);
    const map = this.getPendingMap(root);
    const keys = targetRelPath ? [targetRelPath.replace(/\\/g, '/')] : Array.from(map.keys());
    let anyChanged = false;

    for (const rel of keys) {
      const baseline = map.get(rel);
      if (!baseline) continue;
      try {
        const abs = assertWithinWorkspace(root, rel);
        if (baseline.beforeExists) {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, baseline.beforeContent, 'utf-8');
        } else if (fs.existsSync(abs)) {
          fs.unlinkSync(abs);
        }
        map.delete(rel);
        anyChanged = true;
      } catch {
        // Skip invalid path cleanly
      }
    }
    this.savePersistedBaselines(root, map);
    return anyChanged;
  }

  public getCounts(workspaceRoot: string): { undo: number; redo: number } {
    return {
      undo: this.getUndoStack(workspaceRoot).length,
      redo: this.getRedoStack(workspaceRoot).length,
    };
  }

  public clearWorkspace(workspaceRoot: string): void {
    const key = this.normalizeRoot(workspaceRoot);
    this.undoStacks.delete(key);
    this.redoStacks.delete(key);
    this.pendingBaselines.delete(key);
    try {
      const p = this.getPendingFilePath(key);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  }

  public undo(workspaceRoot: string): UndoRedoOutcome {
    const root = this.normalizeRoot(workspaceRoot);
    const undo = this.getUndoStack(root);
    const redo = this.getRedoStack(root);
    const rec = undo.pop();
    if (!rec) {
      return {
        ok: false,
        message: 'Nothing to undo in the active workspace.',
        remainingUndo: 0,
        remainingRedo: redo.length,
      };
    }

    try {
      this.applyState(root, rec, 'before');
      redo.push(rec);
      return {
        ok: true,
        message: `Undid ${rec.type}: ${rec.filePath}${rec.newPath ? ` -> ${rec.newPath}` : ''}`,
        record: rec,
        remainingUndo: undo.length,
        remainingRedo: redo.length,
      };
    } catch (err: any) {
      undo.push(rec);
      return {
        ok: false,
        message: `Undo failed: ${err?.message || String(err)}`,
        remainingUndo: undo.length,
        remainingRedo: redo.length,
      };
    }
  }

  public redo(workspaceRoot: string): UndoRedoOutcome {
    const root = this.normalizeRoot(workspaceRoot);
    const undo = this.getUndoStack(root);
    const redo = this.getRedoStack(root);
    const rec = redo.pop();
    if (!rec) {
      return {
        ok: false,
        message: 'Nothing to redo in the active workspace.',
        remainingUndo: undo.length,
        remainingRedo: 0,
      };
    }

    try {
      this.applyState(root, rec, 'after');
      undo.push(rec);
      return {
        ok: true,
        message: `Redid ${rec.type}: ${rec.filePath}${rec.newPath ? ` -> ${rec.newPath}` : ''}`,
        record: rec,
        remainingUndo: undo.length,
        remainingRedo: redo.length,
      };
    } catch (err: any) {
      redo.push(rec);
      return {
        ok: false,
        message: `Redo failed: ${err?.message || String(err)}`,
        remainingUndo: undo.length,
        remainingRedo: redo.length,
      };
    }
  }

  private applyState(root: string, rec: FileOperationRecord, direction: 'before' | 'after'): void {
    const targetAbs = assertWithinWorkspace(root, rec.filePath);
    if (rec.type === 'rename' && rec.newPath) {
      const newAbs = assertWithinWorkspace(root, rec.newPath);
      if (direction === 'before') {
        if (fs.existsSync(newAbs)) {
          fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
          fs.renameSync(newAbs, targetAbs);
        }
      } else {
        if (fs.existsSync(targetAbs)) {
          fs.mkdirSync(path.dirname(newAbs), { recursive: true });
          fs.renameSync(targetAbs, newAbs);
        }
      }
      return;
    }

    const shouldExist = direction === 'before' ? rec.beforeExists : rec.afterExists;
    const content = direction === 'before' ? rec.beforeContent : rec.afterContent;
    if (shouldExist) {
      fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
      fs.writeFileSync(targetAbs, content, 'utf-8');
    } else if (fs.existsSync(targetAbs)) {
      fs.unlinkSync(targetAbs);
    }
  }
}
