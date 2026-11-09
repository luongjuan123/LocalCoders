import { exec } from 'child_process';
import { promisify } from 'util';
import { ToolExecutionContext, ToolResult } from './types';
import { ProcessManager } from './process-manager';

const execAsync = promisify(exec);

export async function runCommandTool(
  args: { command: string; timeoutMs?: number },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const timeout = args.timeoutMs || 45000;

  if (ctx.requireApproval) {
    const isDestructive =
      args.command.includes('rm -rf') ||
      args.command.includes('mkfs') ||
      args.command.includes('dd if=') ||
      args.command.includes('shutdown') ||
      args.command.includes('reboot');

    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'run_command',
      args,
      description: `Execute terminal command: \`${args.command}\``,
      isDestructive,
    });

    if (!approved) {
      return { success: false, error: 'User rejected command execution.' };
    }
  }

  try {
    const { stdout, stderr } = await execAsync(args.command, {
      cwd: ctx.workspaceRoot,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });

    return {
      success: true,
      output: {
        command: args.command,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: 0,
      },
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message,
      output: {
        command: args.command,
        stdout: err.stdout ? err.stdout.trim() : '',
        stderr: err.stderr ? err.stderr.trim() : '',
        exitCode: err.code || 1,
      },
    };
  }
}

export async function startProcessTool(
  args: { processId?: string; command: string; cwd?: string },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const pm = ProcessManager.getInstance();
  const id = args.processId || `proc_${Date.now()}`;
  const cwd = args.cwd || ctx.workspaceRoot;

  if (ctx.requireApproval) {
    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'start_process',
      args,
      description: `Start long-running background process: \`${args.command}\``,
      isDestructive: false,
    });

    if (!approved) {
      return { success: false, error: 'User rejected background process execution.' };
    }
  }

  try {
    const proc = pm.startProcess(id, args.command, cwd);
    return {
      success: true,
      output: {
        processId: id,
        pid: proc.pid,
        command: args.command,
        status: 'running',
        startTime: proc.startTime,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function readOutputTool(
  args: { processId: string; tailLines?: number },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  const pm = ProcessManager.getInstance();
  const p = pm.getProcess(args.processId);
  if (!p) {
    return { success: false, error: `Process ID '${args.processId}' not found.` };
  }
  const lines = pm.readOutput(args.processId, args.tailLines || 50);
  return {
    success: true,
    output: {
      processId: args.processId,
      status: p.status,
      exitCode: p.exitCode,
      lines,
      output: lines.join('\n'),
    },
  };
}

export async function writeStdinTool(
  args: { processId: string; input: string },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  const pm = ProcessManager.getInstance();
  const success = pm.writeStdin(args.processId, args.input);
  return {
    success,
    output: {
      processId: args.processId,
      sent: success,
    },
    error: success ? undefined : `Failed to write stdin to process '${args.processId}' (not running or no stdin).`,
  };
}

export async function terminateProcessTool(
  args: { processId: string },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  const pm = ProcessManager.getInstance();
  const terminated = pm.terminateProcess(args.processId);
  return {
    success: terminated,
    output: { processId: args.processId, terminated },
    error: terminated ? undefined : `Process ID '${args.processId}' not found.`,
  };
}

export async function listProcessesTool(
  _args: {},
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  const pm = ProcessManager.getInstance();
  const processes = pm.listProcesses();
  return {
    success: true,
    output: { processes },
  };
}

export async function listPortsTool(
  args: { checkPorts?: number[] },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  const pm = ProcessManager.getInstance();
  const candidatePorts = args.checkPorts || [3000, 3001, 5000, 5173, 8000, 8080, 8888, 4200];
  const results: Record<number, boolean> = {};

  for (const port of candidatePorts) {
    results[port] = await pm.checkPortListening(port);
  }

  const openPorts = Object.entries(results)
    .filter(([_, open]) => open)
    .map(([p]) => parseInt(p, 10));

  return {
    success: true,
    output: {
      checkedPorts: candidatePorts,
      openPorts,
      status: results,
    },
  };
}

export async function runTestsTool(args: { testPath?: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  const cmd = args.testPath ? `npm test -- "${args.testPath}"` : 'npm test';
  return runCommandTool({ command: cmd }, ctx);
}

export async function runBuildTool(_args: {}, ctx: ToolExecutionContext): Promise<ToolResult> {
  return runCommandTool({ command: 'npm run build' }, ctx);
}

export async function runLintTool(_args: {}, ctx: ToolExecutionContext): Promise<ToolResult> {
  return runCommandTool({ command: 'npm run lint' }, ctx);
}
