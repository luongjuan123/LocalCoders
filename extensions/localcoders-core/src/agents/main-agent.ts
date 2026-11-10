import * as vscode from 'vscode';
import { OllamaClient } from '../ollama/client';
import { AgentConfig, CriticReport, TaskPlanItem } from './types';
import { ToolManager } from '../tools/tool-manager';
import { ToolExecutionContext } from '../tools/types';
import { MemoryManager } from '../context/memory-manager';
import { CodebaseIndexer } from '../context/indexer';
import { Subagent } from './subagent';
import { CriticAgent } from './critic-agent';
import { TaskQueue } from './task-queue';

/**
 * Extracts embedded tool calls from text responses (e.g. <tool_call>... or ```json {"tool": ...} ```)
 */
export function parseToolCallsFromContent(content: string): Array<{ name: string; args: any }> {
  const calls: Array<{ name: string; args: any }> = [];
  if (!content) return calls;

  // 1. Tagged <tool_call> ... </tool_call>
  const tagRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const name = parsed.name || parsed.tool;
      if (name) {
        calls.push({ name, args: parsed.arguments || parsed.args || parsed.parameters || {} });
      }
    } catch {}
  }

  // 2. Embedded JSON blocks with {"tool": "..."} or {"name": "..."}
  const jsonBlockRegex = /```(?:json)?\s*(\{[\s\S]*?"(?:tool|name)"[\s\S]*?\})\s*```/gi;
  while ((match = jsonBlockRegex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const name = parsed.name || parsed.tool;
      if (name) {
        const args = parsed.arguments || parsed.args || parsed.parameters || { ...parsed };
        delete args.name;
        delete args.tool;
        calls.push({ name, args });
      }
    } catch {}
  }

  return calls;
}

/**
 * Extracts markdown code blocks that specify target file paths
 * Supports:
 * - Preceding headers: "### clock.py", "### 1. clock.py", "**clock.py**", "File: clock.py", "1. `clock.py`:"
 * - Code block fence annotations: "```python clock.py", "```python file=clock.py", "```python:clock.py"
 * - In-code comments on line 1: "# clock.py", "// clock.py"
 * - Contextual fallback to task affectedFiles if unannotated
 */
export function parseCodeBlocksFromContent(
  content: string,
  affectedFiles: string[] = []
): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  if (!content) return files;

  const blockRegex = /```(?:([a-zA-Z0-9_\-]+))?(?:[\s:=]+`?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9_]+)`?)?\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(content)) !== null) {
    let filePath = match[2];
    const code = match[3] || '';
    const matchIndex = match.index;

    // 1. Look before the code block (after previous block, up to 300 chars)
    if (!filePath) {
      const precedingText = content.slice(Math.max(0, matchIndex - 300), matchIndex);
      const lastFence = precedingText.lastIndexOf('```');
      const relevantPreceding = lastFence >= 0 ? precedingText.slice(lastFence + 3) : precedingText;
      const preRegex = /(?:###|####|\*\*|\*|File:|filename:|\d+\.|\bCreate|\bUpdate|\bIn)\s*`?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9_]+)`?\*?\*?[:\s]*$/im;
      const preMatch = relevantPreceding.match(preRegex);
      if (preMatch && preMatch[1]) {
        filePath = preMatch[1];
      }
    }

    // 2. Look at the first line of the code block for a comment with filename
    if (!filePath && code.trim().length > 0) {
      const firstLine = code.trim().split('\n')[0].trim();
      const commentMatch = firstLine.match(/^(?:#|\/\/|\/\*)\s*(?:file(?:name)?:\s*)?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9_]+)/i);
      if (commentMatch && commentMatch[1]) {
        filePath = commentMatch[1];
      }
    }

    // 3. Fallback to affectedFiles if present
    if (!filePath && affectedFiles.length > 0 && code.trim().length > 20) {
      if (/import\s+unittest|import\s+pytest|class\s+Test|def\s+test_/i.test(code)) {
        filePath = affectedFiles.find((f) => /test/i.test(f)) || affectedFiles[0];
      } else {
        filePath = affectedFiles.find((f) => !/test/i.test(f)) || affectedFiles[0];
      }
    }

    if (filePath) {
      const cleanPath = filePath.trim().replace(/^[`*'"\s]+|[`*'"\s]+$/g, '');
      if (cleanPath.includes('.') && !cleanPath.endsWith('.md') && code.trim().length > 0) {
        if (!files.some((f) => f.path === cleanPath)) {
          files.push({ path: cleanPath, content: code });
        }
      }
    }
  }

  return files;
}

export class MainAgent {
  public config: AgentConfig;
  private ollama: OllamaClient;
  private toolManager: ToolManager;
  private memoryManager: MemoryManager;
  private indexer: CodebaseIndexer;
  private workspaceRoot: string;

  constructor(
    config: AgentConfig,
    ollama: OllamaClient,
    toolManager: ToolManager,
    memoryManager: MemoryManager,
    indexer: CodebaseIndexer,
    workspaceRoot: string
  ) {
    this.config = config;
    this.ollama = ollama;
    this.toolManager = toolManager;
    this.memoryManager = memoryManager;
    this.indexer = indexer;
    this.workspaceRoot = workspaceRoot;
  }

  // 1. Plan implementation for a user request
  async createPlan(
    userPrompt: string,
    availableSubagents: Subagent[],
    onActivity: (msg: string) => void
  ): Promise<TaskPlanItem[]> {
    onActivity('Analyzing project context and formulating execution plan...');

    const summary = await this.indexer.index();
    const { rulesText } = await this.memoryManager.getProjectRules();

    const subagentDescriptions = availableSubagents.map(
      (s) => `- ID: "${s.config.id}", Name: "${s.config.name}", Role: "${s.config.role}"`
    ).join('\n') || 'None (Main Agent handles all tasks)';

    const systemPrompt = `You are the Lead Main Agent in LocalCoders.
You are responsible for understanding the user request, inspecting project architecture, and creating a structured, actionable task breakdown.

AVAILABLE SUBAGENTS FOR DELEGATION:
${subagentDescriptions}

PROJECT STRUCTURE:
Root: ${summary.rootName}
Type: ${summary.projectType}
Key Files: ${summary.keyFiles.join(', ')}
${summary.fileTreeSummary}

PROJECT RULES & CONVENTIONS:
${rulesText}

CRITICAL PLANNING INSTRUCTIONS:
- LocalCoders is an autonomous software development environment.
- Every task plan MUST culminate in real code files written to disk (via write_file/edit_file) and automated test execution (via run_command).
- NEVER create plans that ONLY inspect, review, or recommend next steps without implementing them!
- If the user asks to build or add a feature (e.g., Python clock with alarm, REST API, UI component):
  1. Concrete source code implementation tasks (specify target filenames in affectedFiles, e.g. ["clock.py"]).
  2. Interactive entry point or CLI module (e.g. ["main.py"]).
  3. Comprehensive unit and integration test suite (e.g. ["test_clock.py"]).
  4. Automated test run and verification using run_command.
- If dependencies exist (e.g. tests depend on implementation), link them using dependencies.

OUTPUT FORMAT:
Respond with a STRICT JSON block in this exact schema:
\`\`\`json
{
  "tasks": [
    {
      "id": "task-1",
      "title": "Implement Core Logic in clock.py",
      "description": "Create the Clock and Alarm classes in clock.py with full feature set",
      "assignedTo": "main",
      "dependencies": [],
      "affectedFiles": ["clock.py"]
    },
    {
      "id": "task-2",
      "title": "Create Comprehensive Test Suite in test_clock.py",
      "description": "Write automated unit tests for Clock and Alarm in test_clock.py",
      "assignedTo": "main",
      "dependencies": ["task-1"],
      "affectedFiles": ["test_clock.py"]
    },
    {
      "id": "task-3",
      "title": "Execute Tests and Verify Implementation",
      "description": "Run the automated tests using terminal execution and verify zero failures",
      "assignedTo": "main",
      "dependencies": ["task-2"],
      "affectedFiles": []
    }
  ]
}
\`\`\`
`;

    let responseContent = '';
    let planTokens = 0;
    let lastPlanUpdate = Date.now();
    await this.ollama.chatStream(
      {
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `USER REQUEST:\n${userPrompt}\n\nGenerate the actionable execution plan with real implementation tasks.` },
        ],
        temperature: 0.1,
        contextWindow: this.config.contextWindow || 32768,
      },
      (chunk) => {
        responseContent += chunk.content;
        planTokens++;
        const now = Date.now();
        if (now - lastPlanUpdate > 2500) {
          lastPlanUpdate = now;
          if (chunk.thinking) {
            const thinkPreview = chunk.thinking.trim().slice(-60).replace(/[\r\n]+/g, ' ');
            onActivity(`[Thinking] ${thinkPreview}...`);
          } else {
            onActivity(`Formulating execution plan (${planTokens} tokens)...`);
          }
        }
      }
    );

    try {
      const match = responseContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      const rawJson = match ? match[1] : responseContent;
      const parsed = JSON.parse(rawJson);
      let tasks: TaskPlanItem[] = (parsed.tasks || []).map((t: any, idx: number) => ({
        id: t.id || `task-${idx + 1}`,
        title: t.title || `Subtask ${idx + 1}`,
        description: t.description || '',
        assignedTo: t.assignedTo || 'main',
        dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
        status: 'pending',
        affectedFiles: Array.isArray(t.affectedFiles) ? t.affectedFiles : [],
      }));

      // Guardrail: If model only created inspection/summary tasks without code implementation, augment plan
      const hasImplementation = tasks.some(
        (t) =>
          t.affectedFiles.length > 0 ||
          /\b(implement|create|write|build|add|code|fix|develop)\b/i.test(t.title + ' ' + t.description)
      );

      if (!hasImplementation && tasks.length > 0) {
        tasks.push({
          id: `task-${tasks.length + 1}`,
          title: 'Direct Code Implementation',
          description: `Implement the requested functionality directly: ${userPrompt}`,
          assignedTo: 'main',
          dependencies: [tasks[tasks.length - 1].id],
          status: 'pending',
          affectedFiles: [],
        });
        tasks.push({
          id: `task-${tasks.length + 1}`,
          title: 'Automated Testing and Verification',
          description: 'Run automated tests and verify working implementation',
          assignedTo: 'main',
          dependencies: [`task-${tasks.length}`],
          status: 'pending',
          affectedFiles: [],
        });
      }

      if (tasks.length === 0) {
        tasks = [
          {
            id: 'task-1',
            title: 'Direct Implementation',
            description: userPrompt,
            assignedTo: 'main',
            dependencies: [],
            status: 'pending',
            affectedFiles: [],
          },
        ];
      }

      return tasks;
    } catch {
      return [
        {
          id: 'task-1',
          title: 'Direct Implementation',
          description: userPrompt,
          assignedTo: 'main',
          dependencies: [],
          status: 'pending',
          affectedFiles: [],
        },
      ];
    }
  }

  // Answer user questions in Ask Mode without modifying any files
  async answerQuestion(
    question: string,
    abortSignal?: AbortSignal,
    options?: { reasoningEffort?: string; fastMode?: boolean }
  ): Promise<string> {
    const summary = await this.indexer.index();
    const { rulesText } = await this.memoryManager.getProjectRules();
    const systemPrompt = `You are LocalCoders AI, a senior software architect and coding partner.
You are running in ASK MODE. Your objective is to answer questions, explain concepts, review architecture, or analyze algorithms thoroughly, accurately, and concisely.
IMPORTANT: You must NOT attempt to modify or create files on disk or execute destructive commands.

PROJECT ARCHITECTURE:
Root: ${summary.rootName}
Type: ${summary.projectType}
Key Files: ${summary.keyFiles.join(', ')}
${summary.fileTreeSummary}

PROJECT RULES & CONVENTIONS:
${rulesText}
`;

    let temperature = 0.2;
    if (options?.reasoningEffort === 'extra_high' || options?.reasoningEffort === 'high') {
      temperature = 0.1;
    } else if (options?.fastMode) {
      temperature = 0.3;
    }

    let responseContent = '';
    await this.ollama.chatStream(
      {
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question },
        ],
        temperature,
      },
      (chunk) => {
        responseContent += chunk.content;
      },
      abortSignal
    );

    return responseContent.trim() || 'No response generated.';
  }

  // 2. Execute plan with multi-agent coordination
  async executePlan(
    plan: TaskPlanItem[],
    userPrompt: string,
    subagents: Subagent[],
    criticAgent: CriticAgent | null,
    onActivity: (msg: string) => void,
    onPlanUpdate: (updatedPlan: TaskPlanItem[]) => void,
    requestApproval: (req: any) => Promise<boolean>,
    abortSignal?: AbortSignal
  ): Promise<{ success: boolean; criticReport?: CriticReport; summary: string }> {
    const vsConfig = vscode.workspace.getConfiguration('localcoders');
    const maxConcurrency = vsConfig.get<number>('maxConcurrentSubagents') || 3;
    const requireApprovalForEdits = vsConfig.get<boolean>('requireApprovalForEdits') ?? true;

    const queue = new TaskQueue(maxConcurrency);
    queue.setPlan(plan);
    const subagentMap = new Map<string, Subagent>(subagents.map((s) => [s.config.id, s]));

    const toolCtx: ToolExecutionContext = {
      workspaceRoot: this.workspaceRoot,
      agentId: this.config.id,
      agentName: this.config.name,
      requireApproval: requireApprovalForEdits,
      requestApproval,
    };

    // Pre-execution safe checkpoint (non-fatal)
    try {
      await this.toolManager.executeTool('create_checkpoint', { description: 'Pre-multiagent task run' }, toolCtx);
    } catch (checkpointErr: any) {
      console.warn('[MainAgent] Non-fatal checkpoint note:', checkpointErr.message);
    }

    onActivity('Starting orchestrated multi-agent plan execution...');

    while (!queue.isComplete()) {
      if (abortSignal?.aborted) {
        throw new Error('Multi-agent execution cancelled by user.');
      }

      const readyTasks = queue.getReadyTasks();
      if (readyTasks.length === 0) {
        // Deadlock check: if no active tasks and no ready tasks, resolve deadlock
        if (queue.hasDeadlock()) {
          onActivity('Resolving unfulfilled task dependencies to complete execution...');
          queue.resolveDeadlock();
          onPlanUpdate(queue.getAllTasks());
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }

      // Execute ready tasks concurrently up to concurrency limit
      const executions = readyTasks.map(async (task) => {
        queue.updateTaskStatus(task.id, 'in_progress');
        onPlanUpdate(queue.getAllTasks());

        try {
          if (task.assignedTo !== 'main' && subagentMap.has(task.assignedTo)) {
            const worker = subagentMap.get(task.assignedTo)!;
            onActivity(`[${worker.config.name}] Dispatched to task: ${task.title}`);

            const res = await worker.executeTask(
              task,
              `User Goal: ${userPrompt}\nWorkspace: ${this.workspaceRoot}`,
              onActivity,
              requestApproval,
              abortSignal
            );

            queue.updateTaskStatus(task.id, res.success ? 'completed' : 'failed', res.output);
          } else {
            // Main Agent executes task directly
            onActivity(`[Main Agent] Executing task: ${task.title}`);
            const res = await this.executeMainTask(task, userPrompt, onActivity, requestApproval, abortSignal);
            queue.updateTaskStatus(task.id, res.success ? 'completed' : 'failed', res.output);
          }
        } catch (err: any) {
          onActivity(`Error executing ${task.title}: ${err.message}`);
          queue.updateTaskStatus(task.id, 'failed', err.message);
        }

        onPlanUpdate(queue.getAllTasks());
      });

      await Promise.all(executions);
    }

    if (queue.hasFailedTasks()) {
      const failed = queue.getAllTasks().filter((t) => t.status === 'failed');
      const failReasons = failed.map((f) => `- ${f.title}: ${f.output || 'Unknown error'}`).join('\n');
      return {
        success: false,
        summary: `One or more subtasks encountered issues:\n${failReasons}`,
      };
    }

    // 3. Independent Critic Review Step
    let criticReport: CriticReport | undefined = undefined;
    if (criticAgent && !abortSignal?.aborted) {
      onActivity('[Critic Agent] Initiating independent audit of implementation...');
      criticReport = await criticAgent.review({
        userRequirements: userPrompt,
        onProgress: onActivity,
      });

      // If Critic found Critical defects, Main Agent performs targeted correction cycle
      const criticalFindings = criticReport.findings.filter((f) => f.severity === 'Critical' || f.severity === 'High');
      if (criticalFindings.length > 0 && !abortSignal?.aborted) {
        onActivity(`[Main Agent] Received ${criticalFindings.length} critical Critic finding(s). Proposing corrections...`);
        await this.addressCriticFindings(criticalFindings, onActivity, requestApproval, abortSignal);

        if (!abortSignal?.aborted) {
          onActivity('[Critic Agent] Re-evaluating corrected code...');
          criticReport = await criticAgent.review({
            userRequirements: userPrompt,
            onProgress: onActivity,
          });
        }
      }
    }

    return {
      success: true,
      criticReport,
      summary: 'All tasks completed successfully. Files created/modified and verified.',
    };
  }

  // Execute a single implementation task autonomously with real tool calls and code persistence
  private async executeMainTask(
    task: TaskPlanItem,
    userPrompt: string,
    onActivity: (msg: string) => void,
    requestApproval: (req: any) => Promise<boolean>,
    abortSignal?: AbortSignal
  ): Promise<{ success: boolean; output: string }> {
    const vsConfig = vscode.workspace.getConfiguration('localcoders');
    const requireApprovalForEdits = vsConfig.get<boolean>('requireApprovalForEdits') ?? true;

    const toolCtx: ToolExecutionContext = {
      workspaceRoot: this.workspaceRoot,
      agentId: this.config.id,
      agentName: this.config.name,
      taskId: task.id,
      requireApproval: requireApprovalForEdits,
      requestApproval,
    };

    const taskContext = {
      affectedFiles: task.affectedFiles,
      prompt: `${task.title} ${task.description} ${userPrompt}`,
    };
    const tools = this.toolManager.getOllamaTools(this.config.role, taskContext);
    const systemPrompt = `You are the Lead Main Agent in LocalCoders, an autonomous development environment.
${this.config.systemPrompt}

CRITICAL EXECUTION MANDATE:
- You are NOT a chatbot. Talking about code or describing an implementation does NOT complete the task.
- YOU MUST EXECUTE REAL TOOLS:
  * write_file(path, content): Create or overwrite source files in the workspace.
  * edit_file(path, target, replacement): Modify existing files with targeted changes.
  * run_command(command): Run shell commands, tests, package managers, and builds.
  * read_file(path): Inspect file contents.
  * list_directory(path): Inspect directory structures.
- Whenever you implement a feature, module, or test, YOU MUST CALL write_file TO SAVE THE CODE TO DISK.
- Always write complete, production-ready, clean code with zero placeholders or omissions.`;

    const targetFilePrompt = task.affectedFiles.length > 0
      ? `You MUST immediately write/update the required code for: ${task.affectedFiles.join(', ')} using write_file. Do not waste turns reading directory listings when files must be written.`
      : `Use tools (write_file, edit_file, run_command) to execute this task now.`;

    const userMsg = `TASK TO IMPLEMENT:
Title: ${task.title}
Description: ${task.description}
Affected Files: ${task.affectedFiles.join(', ') || 'Determine needed files'}
OVERALL GOAL: ${userPrompt}

MANDATORY ACTION:
${targetFilePrompt}`;

    const messages: any[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMsg },
    ];

    let turns = 0;
    const maxTurns = 12;
    let finalOutput = '';
    const filesWritten: string[] = [];
    let toolsExecutedCount = 0;

    const isImplementationTask =
      task.affectedFiles.length > 0 ||
      /\b(implement|create|write|build|add|code|fix|develop|test|setup)\b/i.test(task.title + ' ' + task.description);

    while (turns < maxTurns) {
      turns++;
      if (abortSignal?.aborted) {
        throw new Error('Multi-agent execution cancelled by user.');
      }

      let content = '';
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
          content += chunk.content;
          genTokens++;
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
          } catch {
            args = {};
          }
          activeCalls.push({ name: fn.name, args });
        }
      }

      // 2. Check for embedded text tool calls (<tool_call>... or ```json {"tool": ...} ```)
      if (activeCalls.length === 0) {
        const embeddedCalls = parseToolCallsFromContent(content);
        if (embeddedCalls.length > 0) {
          activeCalls = embeddedCalls;
        }
      }

      // 3. Fallback: Parse code blocks with filenames and automatically persist them via write_file
      if (activeCalls.length === 0) {
        const extractedFiles = parseCodeBlocksFromContent(content, task.affectedFiles);
        if (extractedFiles.length > 0) {
          for (const ef of extractedFiles) {
            onActivity(`[Auto-Persisting] Writing extracted code to '${ef.path}'...`);
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
        content,
        tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      });

      // 4. Execute tool calls if any were found
      if (activeCalls.length > 0) {
        for (const call of activeCalls) {
          toolsExecutedCount++;
          const summaryStr = JSON.stringify(call.args).slice(0, 60);
          onActivity(`[Main Agent] ${call.name}(${summaryStr}...)`);

          const res = await this.toolManager.executeTool(call.name, call.args, toolCtx);
          if (res.success && (call.name === 'write_file' || call.name === 'create_file')) {
            const p = call.args.path || call.args.filePath;
            if (p) filesWritten.push(p);
          }

          const resStr = JSON.stringify(res);
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

        // If native tool calls were emitted, append a prompt so Qwen template always has a user turn
        if (toolCalls && toolCalls.length > 0) {
          messages.push({
            role: 'user',
            content: `Tool executions completed. Continue implementing the task. Use 'write_file' to save code to disk, and 'run_command' to run tests.`,
          });
        }

        continue;
      }

      // 5. Nudge if an implementation task produced pure text without writing any files
      if (isImplementationTask && filesWritten.length === 0 && toolsExecutedCount === 0 && turns < 3) {
        onActivity('[Main Agent] Nudging model to invoke write_file tool...');
        messages.push({
          role: 'user',
          content: 'CRITICAL: You explained the solution, but NO files were written to disk. You must call write_file(path, content) right now to persist the code into the workspace.',
        });
        continue;
      }

      finalOutput = content;
      break;
    }

    // 6. Automated Verification: If Python/Node test files exist or were modified, verify with run_command
    if (filesWritten.length > 0 && !abortSignal?.aborted) {
      const hasTests = filesWritten.some((f) => /test.*\.py$|.*_test\.py$|.*\.test\.ts$|.*\.spec\.ts$/i.test(f));
      if (hasTests) {
        const testFile = filesWritten.find((f) => /test.*\.py$|.*_test\.py$/i.test(f));
        const testCmd = testFile ? `python3 -m unittest ${testFile}` : 'python3 -m unittest discover -s . -p "*test*.py"';
        onActivity(`[Verification] Executing test suite: ${testCmd}`);
        const testRes = await this.toolManager.executeTool('run_command', { command: testCmd }, toolCtx);
        if (testRes.success) {
          onActivity('[Verification] All tests passed cleanly!');
        } else {
          onActivity(`[Verification Note] Test output: ${(testRes.output?.stderr || testRes.error || '').slice(0, 80)}`);
        }
      }
    }

    const summary = filesWritten.length > 0
      ? `Successfully implemented and persisted files: ${filesWritten.join(', ')}`
      : finalOutput || 'Task completed.';

    return {
      success: true,
      output: summary,
    };
  }

  // Address Critic findings
  private async addressCriticFindings(
    findings: any[],
    onActivity: (msg: string) => void,
    requestApproval: (req: any) => Promise<boolean>,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const toolCtx: ToolExecutionContext = {
      workspaceRoot: this.workspaceRoot,
      agentId: this.config.id,
      agentName: this.config.name,
      requireApproval: true,
      requestApproval,
    };

    const tools = this.toolManager.getOllamaTools();
    const findingsList = findings.map(
      (f, i) => `${i + 1}. [${f.severity}] in ${f.filePath} (lines ${f.lineRange || 'N/A'}):\n   Evidence: ${f.evidence}\n   Problem: ${f.explanation}\n   Fix: ${f.recommendedFix}`
    ).join('\n\n');

    const prompt = `The independent Critic Agent discovered the following verified issues in the implementation:

${findingsList}

Please inspect the files, apply the necessary corrections using write_file or edit_file, and verify that the defects are resolved.`;

    const messages: any[] = [
      { role: 'system', content: `You are the Lead Main Agent. Correct the verified defects identified by the Critic Agent using tools.` },
      { role: 'user', content: prompt },
    ];

    let turns = 0;
    while (turns < 8) {
      turns++;
      if (abortSignal?.aborted) {
        throw new Error('Multi-agent execution cancelled by user.');
      }

      let content = '';
      let toolCalls: any = undefined;

      await this.ollama.chatStream(
        {
          model: this.config.model,
          messages,
          tools,
          temperature: 0.1,
        },
        (chunk) => {
          content += chunk.content;
          if (chunk.toolCalls) toolCalls = chunk.toolCalls;
        },
        abortSignal
      );

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

      if (activeCalls.length === 0) {
        activeCalls = parseToolCallsFromContent(content);
      }

      messages.push({ role: 'assistant', content, tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined });
      if (activeCalls.length === 0) break;

      for (const call of activeCalls) {
        onActivity(`[Main Agent Fixing] ${call.name}(${JSON.stringify(call.args).slice(0, 50)}...)`);
        const res = await this.toolManager.executeTool(call.name, call.args, toolCtx);
        messages.push({ role: 'tool', content: JSON.stringify(res) });
      }
    }
  }
}
