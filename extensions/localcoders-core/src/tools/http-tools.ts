import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolExecutionContext, ToolResult } from './types';

export async function httpGetTool(
  args: { url: string; headers?: Record<string, string>; timeoutMs?: number },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), args.timeoutMs || 20000);

    const response = await fetch(args.url, {
      method: 'GET',
      headers: args.headers || {},
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') || '';
    let body: any;
    if (contentType.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }

    return {
      success: response.ok,
      output: {
        status: response.status,
        statusText: response.statusText,
        contentType,
        data: body,
      },
      error: response.ok ? undefined : `HTTP Request failed with status ${response.status}`,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function httpPostTool(
  args: { url: string; body?: any; headers?: Record<string, string>; timeoutMs?: number },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  if (ctx.requireApproval) {
    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'http.post',
      args,
      description: `Send HTTP POST request to: ${args.url}`,
      isDestructive: false,
    });
    if (!approved) return { success: false, error: 'User rejected outbound HTTP POST.' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), args.timeoutMs || 25000);

    const isJson = typeof args.body === 'object';
    const headers: Record<string, string> = {
      ...(isJson ? { 'Content-Type': 'application/json' } : {}),
      ...(args.headers || {}),
    };

    const response = await fetch(args.url, {
      method: 'POST',
      headers,
      body: isJson ? JSON.stringify(args.body) : String(args.body || ''),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') || '';
    let responseBody: any;
    if (contentType.includes('application/json')) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }

    return {
      success: response.ok,
      output: {
        status: response.status,
        statusText: response.statusText,
        data: responseBody,
      },
      error: response.ok ? undefined : `HTTP POST failed with status ${response.status}`,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function httpDownloadFileTool(
  args: { url: string; destinationPath: string },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    const fullDest = path.resolve(ctx.workspaceRoot, args.destinationPath);
    await fs.mkdir(path.dirname(fullDest), { recursive: true });

    const response = await fetch(args.url);
    if (!response.ok) {
      return { success: false, error: `Failed to download file: HTTP ${response.status}` };
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await fs.writeFile(fullDest, buffer);

    return {
      success: true,
      output: {
        destinationPath: path.relative(ctx.workspaceRoot, fullDest),
        sizeBytes: buffer.length,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
