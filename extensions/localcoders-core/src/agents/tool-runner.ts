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
    requestApproval: async (req) => {
      if (onStreamEvent) {
        onStreamEvent({
          kind: 'status',
          id: `st_${runId}_${callId}_appr`,
          runId,
          agentId,
          agentName,
          phase: 'waiting_tool',
          summary: `Waiting for approval: ${formatted.title}`,
          timestamp: Date.now(),
        });
      }
      emitItem({
        ...baseItem,
        summary: `Waiting for approval — ${formatted.summary}`,
        stdout:
          liveStdout ||
          `Approval required: ${req.description || formatted.title}\nApprove or Reject in the confirmation card below to continue.`,
        stderr: liveStderr,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
      });
      const approved = await baseCtx.requestApproval(req);
      emitItem({
        ...baseItem,
        summary: formatted.summary,
        stdout: liveStdout,
        stderr: liveStderr,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
      });
      return approved;
    },
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

  const fileActionOut =
    result.success &&
    typeof outObj?.path === 'string' &&
    typeof outObj?.action === 'string'
      ? `${outObj.action === 'created' ? 'Created' : outObj.action === 'modified' ? 'Updated' : outObj.action} ${outObj.path}${typeof outObj.bytesWritten === 'number' ? ` (${outObj.bytesWritten} bytes)` : ''}`
      : '';

  const stdoutText =
    typeof outObj?.stdout === 'string' && outObj.stdout.length > 0
      ? outObj.stdout
      : liveStdout.trim() || fileActionOut;
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

export interface TurnProgressGuardOptions {
  maxStuckTurns?: number;
  blockInteractiveApps?: boolean;
  launchedApps?: Set<string>;
  isExecuteOnly?: boolean;
}

const APP_LAUNCH_TOOL_NAMES = new Set([
  'start_process',
  'app.launch',
  'app.open_url',
  'app.open_file',
]);

export function isTestOrVerificationCommand(rawCmd: string): boolean {
  const s = String(rawCmd || '').trim();
  if (!s) return false;
  return (
    /\b(unittest|pytest|py_compile|vitest|jest|mocha|rspec|phpunit|ctest)\b/i.test(s) ||
    /\b(npm|pnpm|yarn|bun)\s+(test|run\s+(test|lint|build|typecheck|check)|install|ci)\b/i.test(s) ||
    /\b(npx|tsc|eslint|flake8|mypy|ruff|black|pylint)\b/i.test(s) ||
    /\b(cargo|go|dotnet|mvn|gradle)\s+(test|build|check|vet|clippy)\b/i.test(s) ||
    /\bnode\b[^|;&]*--test\b/i.test(s) ||
    /\bpip3?\s+install\b/i.test(s)
  );
}

export function normalizeCommandTarget(toolName: string, args: Record<string, any> | undefined): string {
  if (toolName === 'app.open_url') {
    return `url:${String(args?.url || '').trim().toLowerCase()}`;
  }
  if (toolName === 'app.open_file') {
    return `file:${String(args?.path || '').trim().replace(/^\.\//, '')}`;
  }
  const argSuffix = Array.isArray(args?.args) && args.args.length > 0 ? ` ${args.args.join(' ')}` : '';
  let cmd = String(args?.command || args?.cmd || args?.path || '').trim() + argSuffix;
  // Strip shell wrappers (cd ... &&, nohup, trailing &, stderr redirection)
  cmd = cmd
    .replace(/^(?:cd\s+[^&;]+&&\s*)+/i, '')
    .replace(/^nohup\s+/i, '')
    .replace(/\s*(?:2>&1|1?>\/dev\/null)\s*/gi, ' ')
    .replace(/\s*&\s*$/, '')
    .trim();
  // Collapse whitespace, normalize python3/python & unbuffered flag, strip quotes & ./ on paths
  cmd = cmd
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\bpython3(?:\.\d+)?\b/gi, 'python')
    .replace(/\bpython\s+-u\s+/gi, 'python ')
    .replace(/(^|\s)\.\//g, '$1')
    .trim();
  return cmd;
}

/**
 * Shared loop-breaker across MainAgent, Critic remediation, and Subagents.
 * Prevents local models from wasting minutes repeating identical failed `edit_file` targets,
 * re-running identical failing tests, or infinitely re-launching desktop/GUI apps after close.
 */
export function createTurnProgressGuard(options: TurnProgressGuardOptions = {}) {
  const isExecuteOnly = Boolean(options.isExecuteOnly);
  const maxStuckTurns = Math.max(1, options.maxStuckTurns ?? (isExecuteOnly ? 4 : 2));
  const blockInteractiveApps = Boolean(options.blockInteractiveApps);
  const launchedApps = options.launchedApps || new Set<string>();
  const succeededMutations = new Set<string>();
  const failedMutations = new Map<string, string>();
  const blockedCommands = new Map<string, string>();
  const failedCommandsSinceLastWrite = new Map<string, { error: string; count: number }>();
  const executedTestsSinceLastWrite = new Set<string>();
  let stuckTurns = 0;
  let lastFailedCommand: { command: string; error: string } | undefined;

  const isMutationTool = (name: string) =>
    name === 'write_file' || name === 'create_file' || name === 'edit_file';

  const isAppLaunchTool = (name: string) => APP_LAUNCH_TOOL_NAMES.has(name);

  const isCommandTool = (name: string) =>
    name === 'run_command' || name === 'run_tests' || isAppLaunchTool(name);

  const mutationSignature = (name: string, args: Record<string, any>) =>
    `${name}:${JSON.stringify(args || {})}`;

  const commandSignature = (name: string, args: Record<string, any>) =>
    `${name}:${normalizeCommandTarget(name, args)}::${String(args?.stdin ?? args?.input ?? '')}`;

  const isLaunchOrAppRun = (toolName: string, args: Record<string, any>): boolean => {
    if (isAppLaunchTool(toolName)) return true;
    if (toolName === 'run_command') {
      const norm = normalizeCommandTarget(toolName, args);
      return Boolean(norm) && !isTestOrVerificationCommand(norm);
    }
    return false;
  };

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
        const normTarget = normalizeCommandTarget(toolName, args);
        const appRun = isLaunchOrAppRun(toolName, args);

        if (blockInteractiveApps && appRun) {
          return {
            skip: true,
            reason: `Blocked launching interactive application '${normTarget}' during remediation pass`,
            cachedResultJson: JSON.stringify({
              success: true,
              skippedDuplicate: true,
              message: `Skipped launching '${normTarget}' during code-fix review pass. Run only automated tests/checks (e.g. unittest, pytest, npm test).`,
            }),
          };
        }

        if (appRun && normTarget && launchedApps.has(normTarget)) {
          return {
            skip: true,
            reason: `Application '${normTarget}' was already launched in this run`,
            cachedResultJson: JSON.stringify({
              success: true,
              skippedDuplicate: true,
              alreadyExecuted: true,
              message:
                `Skipped duplicate launch of '${normTarget}': this application already ran/launched during this task. ` +
                `Do NOT reopen it after it exits or is closed by the user. Summarize completion concisely now.`,
            }),
          };
        }

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
          return {
            skip: true,
            reason: `No workspace files changed since last failure of ${args?.command || toolName}`,
            cachedResultJson: JSON.stringify({
              success: false,
              skippedDuplicate: true,
              error: isExecuteOnly
                ? `Skipped redundant retry of failing command '${args?.command || toolName}'. Inspect workspace files with read_file/list_directory or compile/run the correct target.`
                : `Skipped redundant retry of failing command '${args?.command || toolName}': no files were modified since its last failure. ` +
                  `Read/fix the failing file with read_file + write_file before running tests again.`,
            }),
          };
        }
        if (!appRun && normTarget && executedTestsSinceLastWrite.has(normTarget)) {
          return {
            skip: true,
            reason: `Test/verification command '${normTarget}' already passed with current files`,
            cachedResultJson: JSON.stringify({
              success: true,
              skippedDuplicate: true,
              message: `Skipped duplicate verification '${normTarget}': already passed with zero edits since last run. Summarize completion.`,
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
          // File contents changed on disk, so previously failing tests/commands can re-run cleanly
          failedCommandsSinceLastWrite.clear();
          executedTestsSinceLastWrite.clear();
        } else if (!result?.cancelled && isMutationTool(toolName)) {
          failedMutations.set(
            mutationSignature(toolName, args),
            String(result?.error || 'Mutation failed')
          );
        }
      }

      if (isCommandTool(toolName)) {
        const sig = commandSignature(toolName, args);
        const normTarget = normalizeCommandTarget(toolName, args);
        const appRun = isLaunchOrAppRun(toolName, args);

        if (appRun && normTarget) {
          const out = result?.output || {};
          const exitCode = typeof out.exitCode === 'number' ? out.exitCode : undefined;
          const stderrStr = String(out.stderr || result?.error || '');
          // If an app crashed with a code error before staying open, allow fixing & retrying once;
          // if it opened/ran (success or user-closed/terminated), keep it in launchedApps for the run
          const preLaunchCodeCrash =
            !result?.success &&
            exitCode !== 0 &&
            exitCode !== 130 &&
            exitCode !== 143 &&
            /SyntaxError|IndentationError|ModuleNotFoundError|ImportError|NameError|Cannot find module|ENOENT/i.test(stderrStr);
          if (!preLaunchCodeCrash) {
            launchedApps.add(normTarget);
          }
        }

        if (result?.success) {
          failedCommandsSinceLastWrite.delete(sig);
          if (!appRun && normTarget) {
            executedTestsSinceLastWrite.add(normTarget);
          }
          madeProgress = true;
        } else if (!result?.cancelled) {
          const errStr = String(result?.error || result?.output?.stderr || result?.output?.stdout || 'Command failed');
          const rawCmd = String(args?.command || args?.cmd || toolName);
          lastFailedCommand = { command: rawCmd, error: errStr };
          if (result?.output?.interactiveRequired || result?.output?.timedOut) {
            commandHint = String(result.error || 'Command blocked waiting on stdin or long-running process.');
            blockedCommands.set(sig, commandHint);
          } else {
            const prevCount = failedCommandsSinceLastWrite.get(sig)?.count || 0;
            failedCommandsSinceLastWrite.set(sig, {
              error: errStr,
              count: prevCount + 1,
            });
          }
        }
      }

      return { modifiedFile, madeProgress, commandHint };
    },

    getLastCommandFailure(): { command: string; error: string } | undefined {
      return lastFailedCommand;
    },

    shouldStopTurn(params: { skippedAll: boolean; turnMadeProgress: boolean; executedReadOnly: boolean }): boolean {
      if (params.skippedAll && !params.turnMadeProgress && !params.executedReadOnly && launchedApps.size > 0) {
        return true;
      }
      if (params.turnMadeProgress) {
        stuckTurns = 0;
        return false;
      }
      if (isExecuteOnly && params.executedReadOnly && launchedApps.size === 0) {
        return false;
      }
      if (params.skippedAll || !params.executedReadOnly) {
        stuckTurns += 1;
      }
      return stuckTurns >= maxStuckTurns;
    },
  };
}
