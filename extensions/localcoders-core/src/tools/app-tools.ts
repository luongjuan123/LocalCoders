import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { ToolExecutionContext, ToolResult } from './types';

const execAsync = promisify(exec);

export async function appLaunchTool(
  args: { command: string; args?: string[]; detached?: boolean },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  if (ctx.requireApproval) {
    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'app.launch',
      args,
      description: `Launch desktop application: \`${args.command}\``,
      isDestructive: false,
    });
    if (!approved) {
      return { success: false, error: 'User rejected application launch.' };
    }
  }

  try {
    const child = spawn(args.command, args.args || [], {
      cwd: ctx.workspaceRoot,
      detached: args.detached !== false,
      stdio: 'ignore',
    });
    child.unref();

    return {
      success: true,
      output: {
        command: args.command,
        pid: child.pid,
        status: 'launched',
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function appOpenUrlTool(
  args: { url: string },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    await execAsync(`xdg-open "${args.url}"`);
    return { success: true, output: { url: args.url, opened: true } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function appOpenFileTool(
  args: { path: string },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const fullPath = require('path').resolve(ctx.workspaceRoot, args.path);
    await execAsync(`xdg-open "${fullPath}"`);
    return { success: true, output: { path: args.path, opened: true } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function appGetRunningApplicationsTool(
  _args: {},
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    // Try wmctrl first if available, otherwise ps
    let apps: any[] = [];
    try {
      const { stdout } = await execAsync('wmctrl -l -p');
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        const parts = line.split(/\s+/);
        const winId = parts[0];
        const pid = parseInt(parts[2], 10);
        const title = parts.slice(4).join(' ');
        apps.push({ windowId: winId, pid, title });
      }
    } catch {
      // Fallback to searching graphical desktop processes
      const { stdout } = await execAsync('ps -eo pid,comm,args --sort=-%mem | head -n 30');
      const lines = stdout.trim().split('\n').slice(1);
      apps = lines.map((l) => {
        const parts = l.trim().split(/\s+/);
        return { pid: parseInt(parts[0], 10), command: parts[1], args: parts.slice(2).join(' ') };
      });
    }

    return { success: true, output: { applications: apps } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function appTerminateTool(
  args: { pid?: number; processName?: string },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  if (ctx.requireApproval) {
    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'app.terminate',
      args,
      description: `Terminate application process: ${args.pid ? `PID ${args.pid}` : args.processName}`,
      isDestructive: true,
    });
    if (!approved) {
      return { success: false, error: 'User rejected application termination.' };
    }
  }

  try {
    if (args.pid) {
      process.kill(args.pid, 'SIGTERM');
      return { success: true, output: { pid: args.pid, terminated: true } };
    }
    if (args.processName) {
      await execAsync(`pkill -f "${args.processName}"`);
      return { success: true, output: { processName: args.processName, terminated: true } };
    }
    return { success: false, error: 'Either pid or processName must be provided.' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
