import { OllamaClient } from '../ollama/client';
import { AgentConfig, TaskPlanItem } from './types';
import { ToolManager } from '../tools/tool-manager';
import { ToolExecutionContext } from '../tools/types';
import { FileLockManager } from './file-lock';
import { parseToolCallsFromContent, parseCodeBlocksFromContent } from './main-agent';

export class Subagent {
  public config: AgentConfig;
  private ollama: OllamaClient;
  private toolManager: ToolManager;
  private fileLockManager: FileLockManager;
  private workspaceRoot: string;

  constructor(
    config: AgentConfig,
    ollama: OllamaClient,
    toolManager: ToolManager,
    fileLockManager: FileLockManager,
    workspaceRoot: string
  ) {
    this.config = config;
    this.ollama = ollama;
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
    abortSignal?: AbortSignal
  ): Promise<{ success: boolean; output: string; affectedFiles: string[] }> {
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

    const toolCtx: ToolExecutionContext = {
      workspaceRoot: this.workspaceRoot,
      agentId: this.config.id,
      agentName: this.config.name,
      taskId: task.id,
      requireApproval: true,
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
  * run_command(command): Run shell commands, tests, package managers, and builds.
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
    const maxTurns = 10;
    let finalSummary = '';
    const filesWritten: string[] = [];
    let toolsExecutedCount = 0;

    const isImplementationTask =
      task.affectedFiles.length > 0 ||
      /\b(implement|create|write|build|add|code|fix|develop|test|setup)\b/i.test(task.title + ' ' + task.description);

    try {
      while (turns < maxTurns) {
        turns++;
        if (abortSignal?.aborted) {
          throw new Error('Task was cancelled by user.');
        }

        let assistantContent = '';
        let assistantThinking = '';
        let toolCalls: any = undefined;

        let genTokens = 0;
        let lastGenUpdate = Date.now();

        await this.ollama.chatStream(
          {
            model: this.config.model,
            messages,
            tools,
            temperature: this.config.temperature || 0.2,
            contextWindow: this.config.contextWindow || 32768,
          },
          (chunk) => {
            assistantContent += chunk.content;
            genTokens++;
            if (chunk.thinking) assistantThinking += chunk.thinking;
            if (chunk.toolCalls) toolCalls = chunk.toolCalls;

            const now = Date.now();
            if (now - lastGenUpdate > 2500) {
              lastGenUpdate = now;
              if (chunk.thinking) {
                const thinkSnippet = chunk.thinking.trim().slice(-60).replace(/[\r\n]+/g, ' ');
                onActivity(`[${this.config.name}] Thinking: ${thinkSnippet}...`);
              } else {
                onActivity(`[${this.config.name}] Generating implementation (${genTokens} tokens)...`);
              }
            }
          },
          abortSignal
        );

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

        // 3. Fallback: Parse code blocks with filenames and automatically persist them via write_file
        if (activeCalls.length === 0) {
          const extractedFiles = parseCodeBlocksFromContent(assistantContent, task.affectedFiles);
          if (extractedFiles.length > 0) {
            for (const ef of extractedFiles) {
              onActivity(`[${this.config.name}] Writing extracted code to '${ef.path}'...`);
              const writeRes = await this.toolManager.executeTool(
                'write_file',
                { path: ef.path, content: ef.content },
                toolCtx
              );
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
          for (const call of activeCalls) {
            toolsExecutedCount++;
            onActivity(`[${this.config.name}] ${call.name}(${JSON.stringify(call.args).slice(0, 50)}...)`);

            const result = await this.toolManager.executeTool(call.name, call.args, toolCtx);
            if (result.success && (call.name === 'write_file' || call.name === 'create_file')) {
              const p = call.args.path || call.args.filePath;
              if (p) filesWritten.push(p);
            }

            const resStr = JSON.stringify(result);
            const boundedStr = resStr.length > 3000 ? resStr.slice(0, 3000) + '... [truncated]' : resStr;

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
          onActivity(`[${this.config.name}] Nudging model to invoke write_file tool...`);
          messages.push({
            role: 'user',
            content: 'CRITICAL: You explained the solution, but NO files were written to disk. You must call write_file(path, content) right now to persist the code into the workspace.',
          });
          continue;
        }

        finalSummary = assistantContent;
        break;
      }

      const summary = filesWritten.length > 0
        ? `Successfully implemented and persisted files: ${filesWritten.join(', ')}`
        : finalSummary || 'Task completed successfully.';

      return {
        success: true,
        output: summary,
        affectedFiles: Array.from(new Set([...task.affectedFiles, ...filesWritten])),
      };
    } finally {
      // Release file locks held for this task
      this.fileLockManager.releaseAllForTask(task.id);
    }
  }
}
