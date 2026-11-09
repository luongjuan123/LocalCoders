import { OllamaClient } from '../ollama/client';
import { AgentConfig, TaskPlanItem } from './types';
import { ToolManager } from '../tools/tool-manager';
import { ToolExecutionContext } from '../tools/types';
import { FileLockManager } from './file-lock';

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

    const tools = this.toolManager.getOllamaTools();

    const systemPrompt = `You are ${this.config.name}, a specialized ${this.config.role} agent in LocalCoders.
${this.config.systemPrompt}

You have access to tools to read, edit, write, search files and run commands.
Perform your delegated task thoroughly and accurately.
When you edit files or write code, ensure it is production quality, clean, and bug-free.

PROJECT CONTEXT:
${projectContext}
`;

    const userPrompt = `DELEGATED TASK:
Title: ${task.title}
Description: ${task.description}
Expected Affected Files: ${task.affectedFiles.join(', ') || 'Determined by agent'}

Please execute this task using your tools as needed. Once completed, provide a summary of the work done.`;

    const messages: any[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    let turns = 0;
    const maxTurns = 10;
    let finalSummary = '';

    try {
      while (turns < maxTurns) {
        turns++;
        if (abortSignal?.aborted) {
          throw new Error('Task was cancelled by user.');
        }

        let assistantContent = '';
        let assistantThinking = '';
        let toolCalls: any = undefined;

        await this.ollama.chatStream(
          {
            model: this.config.model,
            messages,
            tools,
            temperature: this.config.temperature || 0.2,
          },
          (chunk) => {
            assistantContent += chunk.content;
            if (chunk.thinking) assistantThinking += chunk.thinking;
            if (chunk.toolCalls) toolCalls = chunk.toolCalls;
          },
          abortSignal
        );

        messages.push({
          role: 'assistant',
          content: assistantContent,
          thinking: assistantThinking || undefined,
          tool_calls: toolCalls,
        });

        if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
          finalSummary = assistantContent;
          break;
        }

        // Execute tool calls
        for (const tc of (toolCalls as any[])) {
          const fn = tc.function || tc;
          const toolName = fn.name;
          let toolArgs: any = {};
          try {
            toolArgs = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments || {};
          } catch {
            toolArgs = {};
          }

          onActivity(`Calling tool: ${toolName}(${JSON.stringify(toolArgs).slice(0, 60)}...)`);

          const result = await this.toolManager.executeTool(toolName, toolArgs, toolCtx);

          messages.push({
            role: 'tool',
            content: JSON.stringify(result),
          });
        }
      }

      return {
        success: true,
        output: finalSummary || 'Task completed successfully.',
        affectedFiles: task.affectedFiles,
      };
    } finally {
      // Release file locks held for this task
      this.fileLockManager.releaseAllForTask(task.id);
    }
  }
}
