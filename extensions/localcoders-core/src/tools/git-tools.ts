import { exec } from 'child_process';
import { promisify } from 'util';
import { ToolExecutionContext, ToolResult } from './types';

const execAsync = promisify(exec);

async function runGit(cmd: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(`git ${cmd}`, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export async function readGitDiffTool(args: { path?: string; staged?: boolean }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    let cmd = args.staged ? 'diff --cached' : 'diff';
    if (args.path) {
      cmd += ` -- "${args.path}"`;
    }
    const diff = await runGit(cmd, ctx.workspaceRoot);
    return {
      success: true,
      output: {
        diff: diff || 'No changes detected in working tree.',
        staged: args.staged || false,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function inspectGitStatusTool(_args: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const branch = await runGit('branch --show-current', ctx.workspaceRoot).catch(() => 'detached');
    const statusOut = await runGit('status --porcelain=v1 -uall', ctx.workspaceRoot);

    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];

    const lines = statusOut.split('\n');
    for (const line of lines) {
      if (!line || line.length < 3) continue;
      const index = line[0];
      const worktree = line[1];
      const file = line.substring(3).trim();

      if (index !== ' ' && index !== '?') staged.push(file);
      if (worktree === 'M' || worktree === 'D') modified.push(file);
      if (index === '?' && worktree === '?') untracked.push(file);
    }

    return {
      success: true,
      output: {
        branch,
        staged,
        modified,
        untracked,
        totalChanged: staged.length + modified.length + untracked.length,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function createCheckpointTool(args: { description: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    try {
      await runGit('rev-parse --is-inside-work-tree', ctx.workspaceRoot);
    } catch {
      try {
        await runGit('init', ctx.workspaceRoot);
        await runGit('add -A', ctx.workspaceRoot);
        await runGit('commit -m "Initial commit by LocalCoders" --allow-empty', ctx.workspaceRoot);
      } catch {
        return {
          success: true,
          output: { checkpointCreated: false, message: 'Non-git workspace; checkpoint skipped.' },
        };
      }
    }

    // Check if there are uncommitted modifications to stash
    const status = await runGit('status --porcelain', ctx.workspaceRoot);
    if (!status.trim()) {
      return {
        success: true,
        output: {
          checkpointCreated: true,
          message: 'Working tree is clean; no changes needed to checkpoint.',
        },
      };
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const message = `LocalCoders Checkpoint [${timestamp}]: ${args.description || 'Pre-agent execution'}`;
    try {
      await runGit(`stash push -u -m "${message}"`, ctx.workspaceRoot);
      await runGit('stash apply', ctx.workspaceRoot);
    } catch {
      // Non-fatal if stash operation is skipped
    }
    return {
      success: true,
      output: {
        checkpointCreated: true,
        message,
      },
    };
  } catch (err: any) {
    return {
      success: true,
      output: {
        checkpointCreated: false,
        message: `Checkpoint skipped: ${err.message}`,
      },
    };
  }
}

export async function stageFileTool(args: { path: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    await runGit(`add "${args.path}"`, ctx.workspaceRoot);
    return { success: true, output: { staged: args.path } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function revertFileTool(args: { path: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    // Reverting changes in a file is destructive to current working tree changes
    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'revert_file',
      args,
      description: `Discard all working changes in '${args.path}' and revert to HEAD`,
      isDestructive: true,
      filePath: args.path,
    });

    if (!approved) {
      return { success: false, error: 'User rejected reverting file.' };
    }

    await runGit(`checkout HEAD -- "${args.path}"`, ctx.workspaceRoot);
    return { success: true, output: { reverted: args.path } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
