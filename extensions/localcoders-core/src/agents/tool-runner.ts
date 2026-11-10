import { ToolManager } from '../tools/tool-manager';
import { ToolExecutionContext, ToolResult } from '../tools/types';
import {
  AgentStreamEvent,
  ExecutionActivityItem,
  classifyToolCategory,
  formatToolActivityTitle,
  getSafePhaseLabel,
} from './events';

export interface TrackedToolParams {
  runId: string;
  agentId: string;
  agentName: string;
  agentRole?: string;
  toolName: string;
  args: Record<string, any>;
  toolManager: ToolManager;
  baseCtx: ToolExecutionContext;
  abortSignal?: AbortSignal;
  onStreamEvent?: (ev: AgentStreamEvent) => void;
}

/**
 * Executes any agent tool while emitting correlated start -> live output -> completion
 * ExecutionActivityItem events keyed by a single unique callId (preventing duplicates).
 */
export async function executeTrackedTool(params: TrackedToolParams): Promise<{
  callId: string;
  result: ToolResult;
  item: ExecutionActivityItem;
}> {
  const { runId, agentId, agentName, agentRole, toolName, args, toolManager, baseCtx, abortSignal, onStreamEvent } =
    params;

  const callId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const startTime = Date.now();
  const category = classifyToolCategory(toolName);
  const formatted = formatToolActivityTitle(toolName, args);

  // Emit safe high-level phase summary for this tool operation
  if (onStreamEvent) {
    const phase = category === 'command' ? 'running_commands' : 'waiting_tool';
    onStreamEvent({
      kind: 'status',
      id: `st_${runId}_${callId}`,
      runId,
      agentId,
      agentName,
      phase,
      summary: category === 'command' ? getSafePhaseLabel('running_commands') : formatted.title,
      timestamp: startTime,
    });
  }

  let liveStdout = '';
  let liveStderr = '';
  let flushTimer: NodeJS.Timeout | null = null;
  let dirty = false;

  const baseItem: ExecutionActivityItem = {
    id: callId,
    runId,
    category,
    agentId,
    agentName,
    agentRole,
    toolName,
    title: formatted.title,
    summary: formatted.summary,
    command: formatted.command,
    cwd: baseCtx.workspaceRoot,
    filePath: formatted.filePath,
    status: 'running',
    startTime,
    stdout: '',
    stderr: '',
    timestamp: startTime,
  };

  const emitItem = (item: ExecutionActivityItem) => {
    onStreamEvent?.({
      kind: 'activity_upsert',
      id: `up_${item.id}_${item.timestamp}`,
      runId,
      item,
      timestamp: item.timestamp,
    });
  };

  emitItem(baseItem);

  const scheduleOutputFlush = () => {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (!dirty) return;
      dirty = false;
      emitItem({
        ...baseItem,
        stdout: liveStdout,
        stderr: liveStderr,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
      });
    }, 150);
  };

  const trackedCtx: ToolExecutionContext = {
    ...baseCtx,
    abortSignal: abortSignal || baseCtx.abortSignal,
    onOutput: (stream, chunk) => {
      const cap = 64 * 1024;
      if (stream === 'stdout') {
        liveStdout += chunk;
        if (liveStdout.length > cap) liveStdout = liveStdout.slice(liveStdout.length - cap);
      } else {
        liveStderr += chunk;
        if (liveStderr.length > cap) liveStderr = liveStderr.slice(liveStderr.length - cap);
      }
      scheduleOutputFlush();
    },
  };

  let result: ToolResult;
  try {
    result = await toolManager.executeTool(toolName, args, trackedCtx);
  } catch (err: any) {
    result = {
      success: false,
      cancelled: Boolean(abortSignal?.aborted),
      error: err?.message || 'Tool execution error',
    };
  } finally {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  const endTime = Date.now();
  const wasCancelled = Boolean(result.cancelled || abortSignal?.aborted);
  const finalStatus = wasCancelled ? 'cancelled' : result.success ? 'completed' : 'failed';
  const outObj = result.output && typeof result.output === 'object' ? result.output : undefined;

  const stdoutText =
    typeof outObj?.stdout === 'string' && outObj.stdout.length > 0
      ? outObj.stdout
      : liveStdout.trim();
  const stderrText =
    typeof outObj?.stderr === 'string' && outObj.stderr.length > 0
      ? outObj.stderr
      : liveStderr.trim() || (!result.success && result.error ? result.error : '');

  const exitCode: number | null | undefined =
    typeof outObj?.exitCode === 'number'
      ? outObj.exitCode
      : category === 'command'
      ? wasCancelled
        ? null
        : result.success
        ? 0
        : 1
      : undefined;

  const finalItem: ExecutionActivityItem = {
    ...baseItem,
    status: finalStatus,
    endTime,
    durationMs: typeof outObj?.durationMs === 'number' ? outObj.durationMs : Math.max(0, endTime - startTime),
    exitCode,
    stdout: stdoutText || undefined,
    stderr: stderrText || undefined,
    processId: typeof outObj?.processId === 'string' ? outObj.processId : undefined,
    metadata: result.metadata,
    timestamp: endTime,
  };

  emitItem(finalItem);
  return { callId, result, item: finalItem };
}
