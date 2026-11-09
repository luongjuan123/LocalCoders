import { exec } from 'child_process';
import { promisify } from 'util';
import { ToolExecutionContext, ToolResult } from './types';

const execAsync = promisify(exec);

const DANGEROUS_PATTERNS = [
  /\brm\s+-[rf]{1,2}\s+[\/~]/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/sd/,
  /\b(chmod|chown)\s+-R\s+[\/~]/,
  /:\(\)\s*\{[^}]*:\s*\|\s*:[^}]*&\s*\}\s*;\s*:/,
];

function isPotentiallyDangerous(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(cmd.trim()));
}

export async function runCommandTool(
  args: { command: string; timeoutMs?: number },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const cmd = args.command.trim();

  // If command matches dangerous pattern or approval is enabled, ask user
  if (isPotentiallyDangerous(cmd) || ctx.requireApproval) {
    const isDangerous = isPotentiallyDangerous(cmd);
    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'run_command',
      args,
      description: isDangerous ? `DANGEROUS terminal command: '${cmd}'` : `Execute terminal command: '${cmd}'`,
      isDestructive: isDangerous,
    });

    if (!approved) {
      return { success: false, error: 'User rejected command execution.' };
    }
  }

  try {
    const timeout = args.timeoutMs || 60000;
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: ctx.workspaceRoot,
      timeout,
      maxBuffer: 5 * 1024 * 1024,
    });

    return {
      success: true,
      output: {
        command: cmd,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      },
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Command failed: ${err.message}`,
      output: {
        stdout: err.stdout?.toString() || '',
        stderr: err.stderr?.toString() || '',
      },
    };
  }
}

export async function runTestsTool(args: { testPath?: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  const testCmd = args.testPath ? `npm test -- ${args.testPath}` : 'npm test';
  return runCommandTool({ command: testCmd, timeoutMs: 90000 }, ctx);
}

export async function runBuildTool(_args: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  return runCommandTool({ command: 'npm run build', timeoutMs: 120000 }, ctx);
}

export async function runLintTool(_args: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  return runCommandTool({ command: 'npm run lint', timeoutMs: 60000 }, ctx);
}
