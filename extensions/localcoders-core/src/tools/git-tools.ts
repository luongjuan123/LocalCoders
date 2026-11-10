import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { ToolExecutionContext, ToolResult } from './types';

const execAsync = promisify(exec);

async function runGit(cmd: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(`git ${cmd}`, { cwd, maxBuffer: 15 * 1024 * 1024 });
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

export async function gitLogTool(args: { limit?: number; file?: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const limit = args.limit || 10;
    let cmd = `log -n ${limit} --pretty=format:"%h%x09%an%x09%ad%x09%s" --date=short`;
    if (args.file) {
      cmd += ` -- "${args.file}"`;
    }
    const out = await runGit(cmd, ctx.workspaceRoot);
    const commits = out.split('\n').filter(Boolean).map((line) => {
      const [hash, author, date, message] = line.split('\t');
      return { hash, author, date, message };
    });
    return { success: true, output: { commits, count: commits.length } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function gitShowTool(args: { revision?: string; file?: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const rev = args.revision || 'HEAD';
    const cmd = args.file ? `show "${rev}:${args.file}"` : `show --stat "${rev}"`;
    const out = await runGit(cmd, ctx.workspaceRoot);
    return { success: true, output: { content: out } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function gitBranchListTool(_args: {}, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const out = await runGit('branch --list -a', ctx.workspaceRoot);
    const branches = out.split('\n').map((b) => b.trim()).filter(Boolean);
    return { success: true, output: { branches } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function gitCreateBranchTool(args: { name: string; checkout?: boolean }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const cmd = args.checkout !== false ? `checkout -b "${args.name}"` : `branch "${args.name}"`;
    await runGit(cmd, ctx.workspaceRoot);
    return { success: true, output: { branch: args.name, checkedOut: args.checkout !== false } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function gitCheckoutTool(args: { target: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    await runGit(`checkout "${args.target}"`, ctx.workspaceRoot);
    return { success: true, output: { target: args.target, checkedOut: true } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function stageFileTool(args: { path: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    await runGit(`add "${args.path}"`, ctx.workspaceRoot);
    return { success: true, output: { path: args.path, staged: true } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function unstageFileTool(args: { path: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    await runGit(`restore --staged "${args.path}"`, ctx.workspaceRoot);
    return { success: true, output: { path: args.path, unstaged: true } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function gitCommitTool(args: { message: string; stageAll?: boolean }, ctx: ToolExecutionContext): Promise<ToolResult> {
  if (ctx.requireApproval) {
    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'git.commit',
      args,
      description: `Create Git commit: "${args.message}"`,
      isDestructive: false,
    });
    if (!approved) return { success: false, error: 'User rejected git commit.' };
  }

  try {
    if (args.stageAll) {
      await runGit('add -A', ctx.workspaceRoot);
    }
    const safeMsg = args.message.replace(/"/g, '\\"');
    const out = await runGit(`commit -m "${safeMsg}"`, ctx.workspaceRoot);
    return { success: true, output: { message: args.message, summary: out } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function revertFileTool(args: { path: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  if (ctx.requireApproval) {
    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'git.revert',
      args,
      description: `Discard uncommitted changes in '${args.path}'`,
      isDestructive: true,
      filePath: args.path,
    });
    if (!approved) return { success: false, error: 'User rejected revert.' };
  }

  try {
    await runGit(`checkout -- "${args.path}"`, ctx.workspaceRoot);
    return { success: true, output: { path: args.path, reverted: true } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function createCheckpointTool(args: { description: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const status = await runGit('status --porcelain', ctx.workspaceRoot).catch(() => '');
    if (!status.trim()) {
      return { success: true, output: { checkpointCreated: true, message: 'Working tree is clean; no changes to stash.' } };
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const message = `LocalCoders Checkpoint [${timestamp}]: ${args.description || 'Pre-agent execution'}`;
    await runGit(`stash push -u -m "${message}"`, ctx.workspaceRoot);
    await runGit('stash apply', ctx.workspaceRoot);
    return { success: true, output: { checkpointCreated: true, description: message } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function gitWorktreeCreateTool(args: { name: string; branch?: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const worktreeDir = path.join(ctx.workspaceRoot, '.localcoders', 'worktrees', args.name);
    await fs.mkdir(path.dirname(worktreeDir), { recursive: true });

    const branch = args.branch || `agent-${args.name}`;
    await runGit(`worktree add -b "${branch}" "${worktreeDir}" HEAD`, ctx.workspaceRoot);
    return {
      success: true,
      output: {
        worktreePath: worktreeDir,
        branch,
        relativeWorktreePath: path.relative(ctx.workspaceRoot, worktreeDir),
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function gitWorktreeRemoveTool(args: { name: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const worktreeDir = path.join(ctx.workspaceRoot, '.localcoders', 'worktrees', args.name);
    await runGit(`worktree remove --force "${worktreeDir}"`, ctx.workspaceRoot);
    return { success: true, output: { removed: true, name: args.name } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function gitMergeAnalysisTool(args: { targetBranch: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    // Check mergeability with --no-commit --no-ff then abort
    const out = await runGit(`merge-base HEAD "${args.targetBranch}"`, ctx.workspaceRoot);
    return {
      success: true,
      output: {
        mergeBase: out,
        clean: true,
        target: args.targetBranch,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
