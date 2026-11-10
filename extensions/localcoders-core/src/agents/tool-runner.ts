import { ToolManager } from '../tools/tool-manager';
import { ToolExecutionContext, ToolResult } from '../tools/types';
import {
  AgentStreamEvent,
  ExecutionActivityItem,
  classifyToolCategory,
  extractAgentReasoningText,
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

export interface TurnThoughtTrackerParams {
  runId: string;
  agentId: string;
  agentName: string;
  agentRole?: string;
  title: string;
  stepKey?: string;
  onStreamEvent?: (ev: AgentStreamEvent) => void;
}

/**
 * Throttled per-turn reasoning emitter that streams agent thought blocks into the Thinking drawer
 * (`category: 'thinking_summary'`) without timer leaks on completion/cancellation.
 */
export function createTurnThoughtTracker(params: TurnThoughtTrackerParams) {
  const { runId, agentId, agentName, agentRole, title, stepKey, onStreamEvent } = params;
  const thoughtId = `thought_${runId}_${agentId}_${stepKey || Math.random().toString(36).slice(2, 7)}`;
  const startTime = Date.now();
  let lastEmitAt = 0;
  let flushTimer: NodeJS.Timeout | null = null;
  let pendingContent = '';
  let pendingThinking = '';
  let emittedAny = false;

  const buildSummaryLine = (body: string) => {
    const first = body.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() || title;
    return first.length > 120 ? first.slice(0, 117) + '...' : first;
  };

  const emitThought = (text: string, status: 'running' | 'completed') => {
    if (!onStreamEvent || !text) return;
    emittedAny = true;
    const now = Date.now();
    lastEmitAt = now;
    const item: ExecutionActivityItem = {
      id: thoughtId,
      runId,
      category: 'thinking_summary',
      agentId,
      agentName,
      agentRole,
      title,
      summary: buildSummaryLine(text),
      stdout: text,
      status,
      startTime,
      endTime: status === 'completed' ? now : undefined,
      durationMs: status === 'completed' ? Math.max(0, now - startTime) : undefined,
      timestamp: now,
    };
    onStreamEvent({
      kind: 'activity_upsert',
      id: `up_${thoughtId}_${now}`,
      runId,
      item,
      timestamp: now,
    });
  };

  return {
    updateFromStream(rawContent: string, rawThinking?: string) {
      if (!onStreamEvent) return;
      pendingContent = rawContent;
      pendingThinking = rawThinking || '';
      const now = Date.now();
      const extracted = extractAgentReasoningText(pendingContent, pendingThinking);
      if (!extracted) return;

      if (!emittedAny || now - lastEmitAt >= 200) {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        emitThought(extracted, 'running');
      } else if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          const next = extractAgentReasoningText(pendingContent, pendingThinking);
          if (next) emitThought(next, 'running');
        }, 200);
      }
    },

    finalize(rawContent: string, rawThinking?: string, fallbackNote?: string) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      const finalBody = extractAgentReasoningText(rawContent, rawThinking, fallbackNote);
      if (finalBody) {
        emitThought(finalBody, 'completed');
      }
    },
  };
}

export interface TurnProgressCheckResult {
  skip: boolean;
  reason?: string;
  cachedResultJson?: string;
}

/**
 * Shared loop-breaker across MainAgent, Critic remediation, and Subagents.
 * Prevents local models from wasting minutes repeating identical failed `edit_file` targets
 * or re-running identical failing tests when zero files were modified between runs.
 */
export function createTurnProgressGuard(options: { maxStuckTurns?: number } = {}) {
  const maxStuckTurns = Math.max(1, options.maxStuckTurns ?? 2);
  const succeededMutations = new Set<string>();
  const failedMutations = new Map<string, string>();
  const blockedCommands = new Map<string, string>();
  const failedCommandsSinceLastWrite = new Map<string, { error: string; count: number }>();
  let stuckTurns = 0;

  const isMutationTool = (name: string) =>
    name === 'write_file' || name === 'create_file' || name === 'edit_file';

  const isCommandTool = (name: string) =>
    name === 'run_command' || name === 'run_tests';

  const mutationSignature = (name: string, args: Record<string, any>) =>
    `${name}:${JSON.stringify(args || {})}`;

  const commandSignature = (name: string, args: Record<string, any>) =>
    `${name}:${String(args?.command || args?.cmd || '').trim()}::${String(args?.stdin ?? args?.input ?? '')}`;

  return {
    checkBeforeCall(toolName: string, args: Record<string, any>): TurnProgressCheckResult {
      if (isMutationTool(toolName)) {
        const sig = mutationSignature(toolName, args);
        const fileTarget = args?.path || args?.filePath || 'file';
        if (succeededMutations.has(sig)) {
          return {
            skip: true,
            reason: `Skipped redundant ${toolName} on '${fileTarget}'`,
            cachedResultJson: JSON.stringify({
              success: true,
              skippedDuplicate: true,
              message: `Skipped redundant write: '${fileTarget}' already contains these exact edits. Move on to testing or summarize completion.`,
            }),
          };
        }
        if (failedMutations.has(sig)) {
          const prevErr = failedMutations.get(sig) || 'Previous edit target did not match file content.';
          return {
            skip: true,
            reason: `Blocked repeated failed ${toolName} on '${fileTarget}'`,
            cachedResultJson: JSON.stringify({
              success: false,
              skippedDuplicate: true,
              error:
                `Blocked identical retry of failed ${toolName} on '${fileTarget}'. Previous error: ${prevErr.slice(0, 600)}. ` +
                `Call read_file('${fileTarget}') first or use write_file('${fileTarget}', fullContent) with the full corrected code.`,
            }),
          };
        }
      }

      if (isCommandTool(toolName)) {
        const sig = commandSignature(toolName, args);
        if (blockedCommands.has(sig)) {
          const prevReason = blockedCommands.get(sig) || 'Command timed out or required interactive input.';
          return {
            skip: true,
            reason: prevReason,
            cachedResultJson: JSON.stringify({
              success: false,
              skippedDuplicate: true,
              error: `Skipped identical retry of blocked command: ${prevReason}`,
            }),
          };
        }
        if (failedCommandsSinceLastWrite.has(sig)) {
          const prev = failedCommandsSinceLastWrite.get(sig)!;
          return {
            skip: true,
            reason: `No workspace files changed since last failure of ${args?.command || toolName}`,
            cachedResultJson: JSON.stringify({
              success: false,
              skippedDuplicate: true,
              error:
                `Skipped redundant retry of failing command '${args?.command || toolName}': no files were modified since its last failure. ` +
                `Read/fix the failing file with read_file + write_file before running tests again.`,
            }),
          };
        }
      }

      return { skip: false };
    },

    recordOutcome(toolName: string, args: Record<string, any>, result: ToolResult): {
      modifiedFile?: string;
      madeProgress: boolean;
      commandHint?: string;
    } {
      let modifiedFile: string | undefined;
      let madeProgress = false;
      let commandHint: string | undefined;

      const mutating = isMutationTool(toolName) || toolName === 'delete_file' || toolName === 'rename_file';
      if (mutating) {
        if (result?.success) {
          modifiedFile = args?.path || args?.filePath || args?.newPath;
          madeProgress = true;
          if (isMutationTool(toolName)) {
            succeededMutations.add(mutationSignature(toolName, args));
          }
          // File contents changed on disk, so previously failing tests are now allowed to re-run
          failedCommandsSinceLastWrite.clear();
        } else if (!result?.cancelled && isMutationTool(toolName)) {
          failedMutations.set(
            mutationSignature(toolName, args),
            String(result?.error || 'Mutation failed')
          );
        }
      }

      if (isCommandTool(toolName)) {
        const sig = commandSignature(toolName, args);
        if (result?.success) {
          failedCommandsSinceLastWrite.delete(sig);
          madeProgress = true;
        } else if (!result?.cancelled) {
          if (result?.output?.interactiveRequired || result?.output?.timedOut) {
            commandHint = String(result.error || 'Command blocked waiting on stdin or long-running process.');
            blockedCommands.set(sig, commandHint);
          } else {
            const prevCount = failedCommandsSinceLastWrite.get(sig)?.count || 0;
            failedCommandsSinceLastWrite.set(sig, {
              error: String(result?.error || result?.output?.stderr || 'Command failed'),
              count: prevCount + 1,
            });
          }
        }
      }

      return { modifiedFile, madeProgress, commandHint };
    },

    shouldStopTurn(params: { skippedAll: boolean; turnMadeProgress: boolean; executedReadOnly: boolean }): boolean {
      if (params.turnMadeProgress) {
        stuckTurns = 0;
        return false;
      }
      if (params.skippedAll || !params.executedReadOnly) {
        stuckTurns += 1;
      }
      return stuckTurns >= maxStuckTurns;
    },
  };
}
