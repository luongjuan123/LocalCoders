import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { ToolExecutionContext, ToolResult } from './types';
import { OperationHistoryManager } from '../commands/operation-history';

export function assertWithinWorkspace(workspaceRoot: string, targetPath: string): string {
  const resolved = path.resolve(workspaceRoot, targetPath);
  const rel = path.relative(workspaceRoot, resolved);
  if (rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new Error(`Security Violation: Path '${targetPath}' is outside the workspace root '${workspaceRoot}'`);
  }
  return resolved;
}

export async function readFileTool(args: { path: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const rawPath = args.path || (args as any).filePath || (args as any).filepath || (args as any).file || (args as any).filename;
    if (!rawPath) {
      return { success: false, error: 'readFileTool: Missing required argument "path"' };
    }
    const fullPath = assertWithinWorkspace(ctx.workspaceRoot, rawPath);
    if (!fsSync.existsSync(fullPath)) {
      return { success: false, error: `File not found: '${rawPath}'` };
    }
    const content = await fs.readFile(fullPath, 'utf-8');
    return {
      success: true,
      output: {
        path: path.relative(ctx.workspaceRoot, fullPath),
        content,
        lines: content.split('\n').length,
        sizeBytes: Buffer.byteLength(content, 'utf-8'),
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function readLinesTool(
  args: { path: string; startLine: number; endLine?: number },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const fullPath = assertWithinWorkspace(ctx.workspaceRoot, args.path);
    if (!fsSync.existsSync(fullPath)) {
      return { success: false, error: `File not found: '${args.path}'` };
    }
    const raw = await fs.readFile(fullPath, 'utf-8');
    const allLines = raw.split('\n');
    const start = Math.max(1, args.startLine);
    const end = args.endLine ? Math.min(allLines.length, args.endLine) : Math.min(allLines.length, start + 100);

    const slice = allLines.slice(start - 1, end).map((line, idx) => ({
      line: start + idx,
      text: line,
    }));

    return {
      success: true,
      output: {
        path: path.relative(ctx.workspaceRoot, fullPath),
        startLine: start,
        endLine: end,
        totalLines: allLines.length,
        lines: slice,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function writeFileTool(args: { path: string; content: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const rawPath = args.path || (args as any).filePath || (args as any).filepath || (args as any).file || (args as any).filename || (args as any).target;
    if (!rawPath) {
      return { success: false, error: 'writeFileTool: Missing required argument "path"' };
    }
    const fullPath = assertWithinWorkspace(ctx.workspaceRoot, rawPath);
    const relPath = path.relative(ctx.workspaceRoot, fullPath);

    let original = '';
    const exists = fsSync.existsSync(fullPath);
    if (exists) {
      original = await fs.readFile(fullPath, 'utf-8');
    }

    if (ctx.requireApproval) {
      const approved = await ctx.requestApproval({
        id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        toolCallId: `call_${Date.now()}`,
        agentId: ctx.agentId,
        agentName: ctx.agentName,
        tool: 'write_file',
        args,
        description: exists ? `Modify existing file '${relPath}'` : `Create new file '${relPath}'`,
        isDestructive: false,
        filePath: relPath,
      });

      if (!approved) {
        return { success: false, error: 'User rejected the file write operation.' };
      }
    }

    const content = args.content !== undefined ? args.content : ((args as any).code ?? (args as any).text ?? (args as any).source ?? (args as any).body ?? (args as any).contents ?? '');
    const parentDir = path.dirname(fullPath);
    await fs.mkdir(parentDir, { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    OperationHistoryManager.getInstance().record({
      workspaceRoot: ctx.workspaceRoot,
      type: 'write',
      filePath: relPath,
      beforeExists: exists,
      beforeContent: original,
      afterExists: true,
      afterContent: content,
      description: `${exists ? 'Modify' : 'Create'} ${relPath}`,
    });

    return {
      success: true,
      output: {
        path: relPath,
        action: exists ? 'modified' : 'created',
        bytesWritten: Buffer.byteLength(content, 'utf-8'),
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function editFileTool(
  args: { path: string; target: string; replacement: string },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const rawPath = args.path || (args as any).filePath || (args as any).filepath || (args as any).file || (args as any).filename;
    if (!rawPath) {
      return { success: false, error: 'editFileTool: Missing required argument "path"' };
    }
    const fullPath = assertWithinWorkspace(ctx.workspaceRoot, rawPath);
    const relPath = path.relative(ctx.workspaceRoot, fullPath);

    if (!fsSync.existsSync(fullPath)) {
      return { success: false, error: `File not found: '${relPath}'` };
    }

    const target = args.target || (args as any).search || (args as any).old_string || (args as any).oldText || (args as any).find;
    const replacement = args.replacement !== undefined ? args.replacement : ((args as any).replace ?? (args as any).new_string ?? (args as any).newText ?? '');

    const original = await fs.readFile(fullPath, 'utf-8');
    let matchedTarget = target && original.includes(target) ? target : '';

    // Safe newline / surrounding-blank-line normalization fallback when exact substring differs only in CRLF or blank edges
    if (!matchedTarget && target) {
      const normOrig = original.replace(/\r\n/g, '\n');
      const trimmedTarget = target.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
      if (trimmedTarget) {
        const firstIdx = normOrig.indexOf(trimmedTarget);
        const lastIdx = firstIdx >= 0 ? normOrig.lastIndexOf(trimmedTarget) : -1;
        if (firstIdx >= 0 && firstIdx === lastIdx) {
          matchedTarget = trimmedTarget;
        }
      }
    }

    if (!matchedTarget) {
      const lines = original.split(/\r?\n/);
      const previewLines = lines.slice(0, 80).map((l, idx) => `${idx + 1}: ${l}`).join('\n');
      const boundedPreview = previewLines.length > 3000 ? previewLines.slice(0, 3000) + '\n... [truncated]' : previewLines;
      return {
        success: false,
        error:
          `Target string was not found in '${relPath}'. Do NOT retry the same edit_file target. ` +
          `Use an exact substring from '${relPath}' below or call write_file('${relPath}', fullContent):\n\n` +
          `--- ${relPath} (lines 1-${Math.min(lines.length, 80)} of ${lines.length}) ---\n${boundedPreview}`,
      };
    }

    const baseText = original.includes(matchedTarget) ? original : original.replace(/\r\n/g, '\n');
    const modified = baseText.replace(matchedTarget, replacement);

    if (ctx.requireApproval) {
      const approved = await ctx.requestApproval({
        id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        toolCallId: `call_${Date.now()}`,
        agentId: ctx.agentId,
        agentName: ctx.agentName,
        tool: 'edit_file',
        args,
        description: `Apply targeted edit to '${relPath}'`,
        isDestructive: false,
        filePath: relPath,
      });

      if (!approved) {
        return { success: false, error: 'User rejected targeted edit.' };
      }
    }

    await fs.writeFile(fullPath, modified, 'utf-8');
    OperationHistoryManager.getInstance().record({
      workspaceRoot: ctx.workspaceRoot,
      type: 'edit',
      filePath: relPath,
      beforeExists: true,
      beforeContent: original,
      afterExists: true,
      afterContent: modified,
      description: `Edit ${relPath}`,
    });
    return { success: true, output: { path: relPath, edited: true } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function renameFileTool(
  args: { oldPath: string; newPath: string },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const oldFull = assertWithinWorkspace(ctx.workspaceRoot, args.oldPath);
    const newFull = assertWithinWorkspace(ctx.workspaceRoot, args.newPath);

    if (!fsSync.existsSync(oldFull)) {
      return { success: false, error: `Source path does not exist: '${args.oldPath}'` };
    }

    if (ctx.requireApproval) {
      const approved = await ctx.requestApproval({
        id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        toolCallId: `call_${Date.now()}`,
        agentId: ctx.agentId,
        agentName: ctx.agentName,
        tool: 'rename_file',
        args,
        description: `Rename/move '${args.oldPath}' to '${args.newPath}'`,
        isDestructive: false,
        filePath: args.newPath,
      });
      if (!approved) {
        return { success: false, error: 'User rejected rename operation.' };
      }
    }

    await fs.mkdir(path.dirname(newFull), { recursive: true });
    await fs.rename(oldFull, newFull);
    OperationHistoryManager.getInstance().record({
      workspaceRoot: ctx.workspaceRoot,
      type: 'rename',
      filePath: path.relative(ctx.workspaceRoot, oldFull),
      newPath: path.relative(ctx.workspaceRoot, newFull),
      beforeExists: true,
      beforeContent: '',
      afterExists: true,
      afterContent: '',
      description: `Rename ${path.relative(ctx.workspaceRoot, oldFull)} -> ${path.relative(ctx.workspaceRoot, newFull)}`,
    });

    return {
      success: true,
      output: {
        oldPath: path.relative(ctx.workspaceRoot, oldFull),
        newPath: path.relative(ctx.workspaceRoot, newFull),
        renamed: true,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function deleteFileTool(args: { path: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const fullPath = assertWithinWorkspace(ctx.workspaceRoot, args.path);
    const relPath = path.relative(ctx.workspaceRoot, fullPath);

    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'delete_file',
      args,
      description: `DELETE file or directory '${relPath}'`,
      isDestructive: true,
      filePath: relPath,
    });

    if (!approved) {
      return { success: false, error: 'User rejected deletion of file.' };
    }

    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      await fs.rm(fullPath, { recursive: true, force: true });
    } else {
      const original = await fs.readFile(fullPath, 'utf-8').catch(() => '');
      await fs.unlink(fullPath);
      OperationHistoryManager.getInstance().record({
        workspaceRoot: ctx.workspaceRoot,
        type: 'delete',
        filePath: relPath,
        beforeExists: true,
        beforeContent: original,
        afterExists: false,
        afterContent: '',
        description: `Delete ${relPath}`,
      });
    }

    return { success: true, output: { path: relPath, deleted: true } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function getMetadataTool(args: { path: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const fullPath = assertWithinWorkspace(ctx.workspaceRoot, args.path);
    if (!fsSync.existsSync(fullPath)) {
      return { success: false, error: `Path does not exist: '${args.path}'` };
    }
    const stat = await fs.stat(fullPath);
    return {
      success: true,
      output: {
        path: path.relative(ctx.workspaceRoot, fullPath),
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        sizeBytes: stat.size,
        modified: stat.mtime.toISOString(),
        created: stat.birthtime.toISOString(),
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function listDirectoryTool(
  args: { path?: string; maxDepth?: number },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const rawPath = args.path || (args as any).dir || (args as any).directory || (args as any).folder || '.';
    const targetPath = rawPath && rawPath !== '.' ? assertWithinWorkspace(ctx.workspaceRoot, rawPath) : ctx.workspaceRoot;
    const maxDepth = args.maxDepth || 3;

    async function scan(dir: string, depth: number): Promise<any[]> {
      if (depth > maxDepth) return [];
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const items: any[] = [];

      for (const entry of entries) {
        if (
          entry.name === '.git' ||
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === '.localcoders' ||
          entry.name === '.cache' ||
          entry.name.startsWith('.build')
        ) {
          continue;
        }

        const full = path.join(dir, entry.name);
        const rel = path.relative(ctx.workspaceRoot, full);

        if (entry.isDirectory()) {
          items.push({
            name: entry.name,
            path: rel,
            type: 'directory',
            children: depth < maxDepth ? await scan(full, depth + 1) : [],
          });
        } else {
          items.push({
            name: entry.name,
            path: rel,
            type: 'file',
          });
        }
      }
      return items;
    }

    const tree = await scan(targetPath, 1);
    return { success: true, output: { root: path.relative(ctx.workspaceRoot, targetPath) || '.', tree } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function getProjectStructureTool(args: {}, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const keyFiles = [
      'package.json',
      'tsconfig.json',
      'pyproject.toml',
      'requirements.txt',
      'Cargo.toml',
      'go.mod',
      'Dockerfile',
      'docker-compose.yml',
      'Makefile',
      'README.md',
    ];

    const discoveredConfigs: Record<string, boolean> = {};
    for (const kf of keyFiles) {
      discoveredConfigs[kf] = fsSync.existsSync(path.join(ctx.workspaceRoot, kf));
    }

    // Top level directories
    const topEntries = await fs.readdir(ctx.workspaceRoot, { withFileTypes: true });
    const topDirs = topEntries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name);

    return {
      success: true,
      output: {
        workspaceName: path.basename(ctx.workspaceRoot),
        discoveredConfigs,
        topLevelDirectories: topDirs,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
