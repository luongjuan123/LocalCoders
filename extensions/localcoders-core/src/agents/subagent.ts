import { OllamaClient } from '../ollama/client';
import { LLMRouter } from '../models/llm-router';
import { AgentConfig, TaskPlanItem } from './types';
import { ToolManager } from '../tools/tool-manager';
import { ToolExecutionContext } from '../tools/types';
import { FileLockManager } from './file-lock';
import { parseToolCallsFromContent, parseCodeBlocksFromContent, RuntimeModelOptions } from './main-agent';
import { getSafePhaseLabel, sanitizeAssistantContent } from './events';
import { createTurnProgressGuard, createTurnThoughtTracker, executeTrackedTool } from './tool-runner';

export class Subagent {
  public config: AgentConfig;
  private ollama: OllamaClient;
  private llmRouter: LLMRouter;
  private toolManager: ToolManager;
  private fileLockManager: FileLockManager;
  private workspaceRoot: string;

  constructor(
    config: AgentConfig,
    ollama: OllamaClient,
    toolManager: ToolManager,
    fileLockManager: FileLockManager,
    workspaceRoot: string,
    llmRouter?: LLMRouter
  ) {
    this.config = config;
    this.ollama = ollama;
    this.llmRouter = llmRouter || new LLMRouter(ollama);
    this.toolManager = toolManager;
    this.fileLockManager = fileLockManager;
    this.workspaceRoot = workspaceRoot;
  }

  // Execute a delegated task
  async executeTask(
    task: TaskPlanItem,
    projectContext: string,
    onActivity: (activity: string) => void,
    requestApproval: (req: any) => Promise<boolean>,
    abortSignal?: AbortSignal,
    runtimeOptions?: RuntimeModelOptions
  ): Promise<{ success: boolean; output: string; affectedFiles: string[]; verificationSummary?: string; verificationFailed?: boolean }> {
    onActivity(`Starting task: ${task.title}`);

    // Check file locks for affected files
    for (const f of task.affectedFiles) {
      const lockRes = this.fileLockManager.acquireLock(f, this.config.id, this.config.name, task.id);
      if (!lockRes.success) {
        throw new Error(
          `File Collision Error: File '${f}' is currently locked by agent '${lockRes.conflictWith?.agentName}'`
        );
      }
    }

    const pmMode = this.toolManager.getPermissionManager()?.getNormalizedMode();
    const toolCtx: ToolExecutionContext = {
      workspaceRoot: this.workspaceRoot,
      agentId: this.config.id,
      agentName: this.config.name,
      taskId: task.id,
      requireApproval: pmMode === 'bypass' || pmMode === 'smart' ? false : true,
      requestApproval,
    };

    const taskContext = {
      affectedFiles: task.affectedFiles,
      prompt: `${task.title} ${task.description} ${projectContext}`,
    };
    const tools = this.toolManager.getOllamaTools(this.config.role, taskContext);

    const systemPrompt = `You are ${this.config.name}, a specialized ${this.config.role} agent in LocalCoders.
${this.config.systemPrompt}

CRITICAL EXECUTION MANDATE:
- You are an autonomous software agent. Talking about code or describing an implementation does NOT complete the task.
- YOU MUST EXECUTE TOOLS:
  * write_file(path, content): Create or overwrite source files in the workspace.
  * edit_file(path, target, replacement): Modify existing files with targeted changes.
  * run_command(command, stdin?): Run shell commands, tests, package managers, and builds. Pass optional 'stdin' text when interactive scripts request input(), or use start_process + write_stdin + read_output + terminate_process only when explicitly asked to launch a UI/server (never re-launch an application repeatedly after it exits or is closed).
  * read_file(path): Inspect file contents.
  * list_directory(path): Inspect directory structures.
- Whenever you implement a feature, module, or test, YOU MUST CALL write_file TO SAVE THE CODE TO DISK.
- Always write complete, production-ready, clean code with zero placeholders or omissions.

PROJECT CONTEXT:
${projectContext}
`;

    const targetFilePrompt = task.affectedFiles.length > 0
      ? `You MUST immediately write/update the required code for: ${task.affectedFiles.join(', ')} using write_file. Do not waste turns reading directory listings when files must be written.`
      : `Please execute this task using your tools (write_file, edit_file, run_command) now.`;

    const userPrompt = `DELEGATED TASK:
Title: ${task.title}
Description: ${task.description}
Expected Affected Files: ${task.affectedFiles.join(', ') || 'Determined by agent'}

MANDATORY ACTION:
${targetFilePrompt}`;

    const messages: any[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    let turns = 0;
    const maxTurns = 8;
    let finalSummary = '';
    const filesWritten: string[] = [];
    const progressGuard = createTurnProgressGuard({
      maxStuckTurns: 2,
      launchedApps: runtimeOptions?.launchedApps,
    });
    let toolsExecutedCount = 0;
    let lastCommandOutput = '';
    let lastCommandFailed = false;

    const isImplementationTask =
      task.affectedFiles.length > 0 ||
      /\b(implement|create|write|build|add|code|fix|develop|test|setup)\b/i.test(task.title + ' ' + task.description);

    const runId = runtimeOptions?.runId || `run_${Date.now()}`;
    onActivity(`Working on ${task.title}`);

    try {
      while (turns < maxTurns) {
        turns++;
        if (abortSignal?.aborted) {
          throw new Error('Task was cancelled by user.');
        }

        let assistantContent = '';
        let assistantThinking = '';
        let toolCalls: any = undefined;
        let phaseNotified = false;
        const turnThought = createTurnThoughtTracker({
          runId,
          agentId: this.config.id,
          agentName: this.config.name,
          agentRole: this.config.role,
          title: `${this.config.name} Thinking`,
          stepKey: `${task.id}_t${turns}`,
          onStreamEvent: runtimeOptions?.onStreamEvent,
        });

        runtimeOptions?.onStreamEvent?.({
          kind: 'status',
          id: `st_${runId}_${this.config.id}_${turns}`,
          runId,
          agentId: this.config.id,
          agentName: this.config.name,
          phase: 'analyzing',
          summary: `${this.config.name}: ${getSafePhaseLabel('analyzing')}`,
          timestamp: Date.now(),
        });

        for (let streamAttempt = 0; streamAttempt < 2; streamAttempt++) {
          assistantContent = '';
          assistantThinking = '';
          toolCalls = undefined;
          phaseNotified = false;

          const turnAbort = new AbortController();
          const effectiveAbortSignal = abortSignal
            ? (AbortSignal as any).any
              ? (AbortSignal as any).any([abortSignal, turnAbort.signal])
              : turnAbort.signal
            : turnAbort.signal;
          if (abortSignal) {
            abortSignal.addEventListener('abort', () => turnAbort.abort(), { once: true });
          }

          let watchdogTimer: NodeJS.Timeout | null = null;
          const turnDeadline = Date.now() + 120000;
          const pingWatchdog = () => {
            if (watchdogTimer) clearTimeout(watchdogTimer);
            const remaining = Math.max(1000, turnDeadline - Date.now());
            const delay = Math.min(45000, remaining);
            watchdogTimer = setTimeout(() => {
              console.warn(`[Subagent:${this.config.id}] Stream watchdog timed out after inactivity`);
              turnAbort.abort();
            }, delay);
          };
          pingWatchdog();

          try {
            await this.llmRouter.chatStream(
              {
                model: this.config.model,
                messages,
                tools,
                temperature: runtimeOptions?.temperature ?? this.config.temperature ?? 0.2,
                maxOutputTokens: runtimeOptions?.maxOutputTokens ?? 2048,
                contextWindow: runtimeOptions?.contextLimit,
                reasoningEffort: runtimeOptions?.reasoningEffort,
                fastMode: runtimeOptions?.fastMode,
              },
              (chunk) => {
                pingWatchdog();
                assistantContent += chunk.content;
                if (chunk.thinking) assistantThinking += chunk.thinking;
                turnThought.updateFromStream(assistantContent, assistantThinking);
                if (chunk.toolCalls && chunk.toolCalls.length > 0) {
                  toolCalls = [...(toolCalls || []), ...chunk.toolCalls];
                }
                if (!phaseNotified && (chunk.content || chunk.thinking)) {
                  phaseNotified = true;
                  runtimeOptions?.onStreamEvent?.({
                    kind: 'status',
                    id: `st_${runId}_${this.config.id}_gen_${turns}`,
                    runId,
                    agentId: this.config.id,
                    agentName: this.config.name,
                    phase: 'generating',
                    summary: `${this.config.name}: ${getSafePhaseLabel('generating')}`,
                    timestamp: Date.now(),
                  });
                }
              },
              effectiveAbortSignal
            );
            if (watchdogTimer) clearTimeout(watchdogTimer);
            break;
          } catch (streamErr: any) {
            if (watchdogTimer) clearTimeout(watchdogTimer);
            if (turnAbort.signal.aborted && !abortSignal?.aborted) {
              console.warn(
                `[Subagent:${this.config.id}] Turn ${turns} hit watchdog limit. Processing partial stream (${assistantContent.length} chars).`
              );
              if (assistantContent.trim().length > 0 || (toolCalls && toolCalls.length > 0)) {
                break;
              }
            }
            const msg = String(streamErr?.message || '');
            const transient =
              /llama-server process no longer running|unexpected EOF|ECONNRESET|socket hang up/i.test(msg);
            if (streamAttempt === 0 && transient && !abortSignal?.aborted) {
              runtimeOptions?.onStreamEvent?.({
                kind: 'status',
                id: `st_${runId}_${this.config.id}_retry_${turns}`,
                runId,
                agentId: this.config.id,
                agentName: this.config.name,
                phase: 'working',
                summary: `${this.config.name}: Retrying local model execution`,
                timestamp: Date.now(),
              });
              await new Promise((r) => setTimeout(r, 1500));
              continue;
            }
            throw streamErr;
          }
        }

        // 1. Check for native tool calls
        let activeCalls: Array<{ name: string; args: any }> = [];
        if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
          for (const tc of toolCalls) {
            const fn = tc.function || tc;
            let args = {};
            try {
              args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments || {};
            } catch {}
            activeCalls.push({ name: fn.name, args });
          }
        }

        // 2. Check for embedded text tool calls (<tool_call>... or ```json {"tool": ...} ```)
        if (activeCalls.length === 0) {
          activeCalls = parseToolCallsFromContent(assistantContent);
        }

        const plannedFallback =
          activeCalls.length > 0
            ? `Task "${task.title}": ${activeCalls.map((c) => `${c.name}(${c.args?.path || c.args?.command || ''})`).join(', ')}`
            : `Completed step "${task.title}"`;
        turnThought.finalize(assistantContent, assistantThinking, plannedFallback);

        // 3. Fallback: Parse code blocks with filenames and automatically persist them via write_file
        if (activeCalls.length === 0) {
          const candidateFiles = Array.from(
            new Set([
              ...(task.affectedFiles || []),
              ...((`${task.title} ${task.description} ${assistantContent.slice(0, 500)}`).match(/[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9_]+/g) || []),
            ])
          );
          const extractedFiles = parseCodeBlocksFromContent(assistantContent, candidateFiles);
          if (extractedFiles.length > 0) {
            for (const ef of extractedFiles) {
              const { result: writeRes } = await executeTrackedTool({
                runId,
                agentId: this.config.id,
                agentName: this.config.name,
                agentRole: this.config.role,
                toolName: 'write_file',
                args: { path: ef.path, content: ef.content },
                toolManager: this.toolManager,
                baseCtx: toolCtx,
                abortSignal,
                onStreamEvent: runtimeOptions?.onStreamEvent,
              });
              if (writeRes.success) {
                filesWritten.push(ef.path);
                toolsExecutedCount++;
              }
            }
          }
        }

        messages.push({
          role: 'assistant',
          content: assistantContent,
          thinking: assistantThinking || undefined,
          tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        });

        // 4. Execute tool calls
        if (activeCalls.length > 0) {
          let skippedAll = true;
          let turnMadeProgress = false;
          let executedReadOnly = false;
          for (const call of activeCalls) {
            if (abortSignal?.aborted) {
              throw new Error('Task was cancelled by user.');
            }
            const preCheck = progressGuard.checkBeforeCall(call.name, call.args);
            if (preCheck.skip) {
              messages.push(
                toolCalls && toolCalls.length > 0
                  ? { role: 'tool', tool_name: call.name, content: preCheck.cachedResultJson }
                  : { role: 'user', content: `[Tool Result for ${call.name}]: ${preCheck.cachedResultJson}` }
              );
              continue;
            }

            skippedAll = false;
            toolsExecutedCount++;
            if (
              call.name === 'read_file' ||
              call.name === 'list_directory' ||
              call.name === 'search_codebase' ||
              call.name === 'search_symbols'
            ) {
              executedReadOnly = true;
            }

            const { result } = await executeTrackedTool({
              runId,
              agentId: this.config.id,
              agentName: this.config.name,
              agentRole: this.config.role,
              toolName: call.name,
              args: call.args,
              toolManager: this.toolManager,
              baseCtx: toolCtx,
              abortSignal,
              onStreamEvent: runtimeOptions?.onStreamEvent,
            });

            if (result.cancelled || abortSignal?.aborted) {
              throw new Error('Task was cancelled by user.');
            }

            const outcome = progressGuard.recordOutcome(call.name, call.args, result);
            if (outcome.modifiedFile) filesWritten.push(outcome.modifiedFile);
            if (outcome.madeProgress) turnMadeProgress = true;

            if (call.name === 'run_command' || call.name === 'run_tests') {
              lastCommandFailed = !result.success;
              const o = result.output || {};
              lastCommandOutput = [o.stdout, o.stderr || result.error].filter(Boolean).join('\n').slice(0, 3000);
            }

            const resStr = JSON.stringify(result);
            const boundedStr = resStr.length > 12000 ? resStr.slice(0, 12000) + '... [truncated]' : resStr;

            if (toolCalls && toolCalls.length > 0) {
              messages.push({
                role: 'tool',
                tool_name: call.name,
                content: boundedStr,
              });
            } else {
              messages.push({
                role: 'user',
                content: `[Tool Result for ${call.name}]: ${boundedStr}\nContinue implementing the task. Use 'write_file' to create or update required source files and test files.`,
              });
            }
          }
          if (progressGuard.shouldStopTurn({ skippedAll, turnMadeProgress, executedReadOnly })) {
            break;
          }

          if (toolCalls && toolCalls.length > 0) {
            messages.push({
              role: 'user',
              content: `Tool executions completed. Continue implementing the task. Use 'write_file' to save code to disk, and 'run_command' to run tests.`,
            });
          }

          continue;
        }

        // 5. Nudge if implementation task didn't call any tools
        if (isImplementationTask && filesWritten.length === 0 && toolsExecutedCount === 0 && turns < 3) {
          messages.push({
            role: 'user',
            content: 'CRITICAL: You explained the solution, but NO files were written to disk. You must call write_file(path, content) right now to persist the code into the workspace.',
          });
          continue;
        }

        finalSummary = sanitizeAssistantContent(assistantContent);
        break;
      }

      const summary = filesWritten.length > 0
        ? `Successfully implemented and persisted files: ${filesWritten.join(', ')}`
        : finalSummary || 'Task completed successfully.';

      return {
        success: true,
        output: summary,
        affectedFiles: Array.from(new Set([...task.affectedFiles, ...filesWritten])),
        verificationSummary: lastCommandOutput || undefined,
        verificationFailed: lastCommandFailed || undefined,
      };
    } finally {
      // Release file locks held for this task
      this.fileLockManager.releaseAllForTask(task.id);
    }
  }
}
