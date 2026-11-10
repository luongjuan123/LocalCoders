import { exec } from 'child_process';
import { promisify } from 'util';
import { ToolExecutionContext, ToolResult } from './types';

const execAsync = promisify(exec);

async function runDocker(cmd: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(`docker ${cmd}`, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export async function dockerListContainersTool(args: { all?: boolean }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const flag = args.all !== false ? '-a' : '';
    const out = await runDocker(`ps ${flag} --format "{{json .}}"`, ctx.workspaceRoot);
    const containers = out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
    return { success: true, output: { containers, count: containers.length } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function dockerListImagesTool(_args: {}, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const out = await runDocker('images --format "{{json .}}"', ctx.workspaceRoot);
    const images = out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
    return { success: true, output: { images, count: images.length } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function dockerBuildImageTool(
  args: { tag: string; dockerfilePath?: string; contextPath?: string },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  if (ctx.requireApproval) {
    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'docker.build_image',
      args,
      description: `Build Docker image with tag '${args.tag}'`,
      isDestructive: false,
    });
    if (!approved) return { success: false, error: 'User rejected Docker image build.' };
  }

  try {
    const df = args.dockerfilePath ? `-f "${args.dockerfilePath}"` : '';
    const cpath = args.contextPath || '.';
    const out = await runDocker(`build ${df} -t "${args.tag}" "${cpath}"`, ctx.workspaceRoot);
    return { success: true, output: { tag: args.tag, buildLog: out } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function dockerStartContainerTool(args: { containerId: string }, _ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const out = await runDocker(`start "${args.containerId}"`, process.cwd());
    return { success: true, output: { containerId: args.containerId, started: true, result: out } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function dockerStopContainerTool(args: { containerId: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  if (ctx.requireApproval) {
    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'docker.stop_container',
      args,
      description: `Stop Docker container: ${args.containerId}`,
      isDestructive: false,
    });
    if (!approved) return { success: false, error: 'User rejected container stop.' };
  }

  try {
    const out = await runDocker(`stop "${args.containerId}"`, process.cwd());
    return { success: true, output: { containerId: args.containerId, stopped: true, result: out } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function dockerReadLogsTool(args: { containerId: string; tailLines?: number }, _ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const lines = args.tailLines || 50;
    const out = await runDocker(`logs --tail ${lines} "${args.containerId}"`, process.cwd());
    return { success: true, output: { containerId: args.containerId, logs: out } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function dockerExecuteCommandTool(
  args: { containerId: string; command: string },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  if (ctx.requireApproval) {
    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'docker.execute_command',
      args,
      description: `Execute inside container ${args.containerId}: \`${args.command}\``,
      isDestructive: false,
    });
    if (!approved) return { success: false, error: 'User rejected docker exec command.' };
  }

  try {
    const out = await runDocker(`exec "${args.containerId}" ${args.command}`, ctx.workspaceRoot);
    return { success: true, output: { containerId: args.containerId, stdout: out } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function dockerComposeUpTool(args: { file?: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  if (ctx.requireApproval) {
    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'docker.compose_up',
      args,
      description: 'Start Docker Compose stack',
      isDestructive: false,
    });
    if (!approved) return { success: false, error: 'User rejected docker compose up.' };
  }

  try {
    const f = args.file ? `-f "${args.file}"` : '';
    const out = await runDocker(`compose ${f} up -d`, ctx.workspaceRoot);
    return { success: true, output: { started: true, result: out } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function dockerComposeDownTool(args: { file?: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  if (ctx.requireApproval) {
    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'docker.compose_down',
      args,
      description: 'Stop and remove Docker Compose stack',
      isDestructive: true,
    });
    if (!approved) return { success: false, error: 'User rejected docker compose down.' };
  }

  try {
    const f = args.file ? `-f "${args.file}"` : '';
    const out = await runDocker(`compose ${f} down`, ctx.workspaceRoot);
    return { success: true, output: { stopped: true, result: out } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
