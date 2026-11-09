import { OllamaClient } from '../ollama/client';
import { AgentConfig, CriticReport, TaskPlanItem } from './types';
import { ToolManager } from '../tools/tool-manager';
import { ToolExecutionContext } from '../tools/types';
import { MemoryManager } from '../context/memory-manager';
import { CodebaseIndexer } from '../context/indexer';
import { Subagent } from './subagent';
import { CriticAgent } from './critic-agent';
import { TaskQueue } from './task-queue';

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
You are responsible for understanding the user request, inspecting project architecture, and creating a structured, modular task breakdown.

AVAILABLE SUBAGENTS FOR DELEGATION:
${subagentDescriptions}

PROJECT STRUCTURE:
Root: ${summary.rootName}
Type: ${summary.projectType}
Key Files: ${summary.keyFiles.join(', ')}
${summary.fileTreeSummary}

PROJECT RULES & CONVENTIONS:
${rulesText}

PLANNING INSTRUCTIONS:
- Break the objective into distinct, actionable subtasks.
- Assign tasks to appropriate subagents when matching their specialized role (e.g. Test Engineer for tests, Frontend Developer for UI, Backend Developer for APIs).
- If no suitable subagent exists, assign to "main".
- Define dependencies between tasks where necessary (e.g. tests depend on implementation).
- Specify expected affected files to prevent parallel file collisions.

OUTPUT FORMAT:
Respond with a STRICT JSON block in this exact schema:
\`\`\`json
{
  "tasks": [
    {
      "id": "task-1",
      "title": "Task title",
      "description": "Clear instructions for what needs to be implemented",
      "assignedTo": "main" | "subagent-id",
      "dependencies": [],
      "affectedFiles": ["path/to/file.ts"]
    }
  ]
}
\`\`\`
`;

    let responseContent = '';
    await this.ollama.chatStream(
      {
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `USER REQUEST:\n${userPrompt}\n\nGenerate the execution plan.` },
        ],
        temperature: 0.1,
      },
      (chunk) => {
        responseContent += chunk.content;
      }
    );

    try {
      const match = responseContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      const rawJson = match ? match[1] : responseContent;
      const parsed = JSON.parse(rawJson);
      const tasks: TaskPlanItem[] = (parsed.tasks || []).map((t: any, idx: number) => ({
        id: t.id || `task-${idx + 1}`,
        title: t.title || `Subtask ${idx + 1}`,
        description: t.description || '',
        assignedTo: t.assignedTo || 'main',
        dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
        status: 'pending',
        affectedFiles: Array.isArray(t.affectedFiles) ? t.affectedFiles : [],
      }));

      if (tasks.length === 0) {
        tasks.push({
          id: 'task-1',
          title: 'Direct Implementation',
          description: userPrompt,
          assignedTo: 'main',
          dependencies: [],
          status: 'pending',
          affectedFiles: [],
        });
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
    const queue = new TaskQueue(3);
    queue.setPlan(plan);
    const subagentMap = new Map<string, Subagent>(subagents.map((s) => [s.config.id, s]));

    const toolCtx: ToolExecutionContext = {
      workspaceRoot: this.workspaceRoot,
      agentId: this.config.id,
      agentName: this.config.name,
      requireApproval: true,
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
        // Wait briefly for running tasks or deadlock check
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }

      // Execute ready tasks concurrently
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
      return {
        success: false,
        summary: 'One or more subtasks failed during execution.',
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
        await this.addressCriticFindings(criticalFindings, onActivity, requestApproval);

        onActivity('[Critic Agent] Re-evaluating corrected code...');
        criticReport = await criticAgent.review({
          userRequirements: userPrompt,
          onProgress: onActivity,
        });
      }
    }

    return {
      success: true,
      criticReport,
      summary: 'Multi-agent implementation and validation completed successfully.',
    };
  }

  private async executeMainTask(
    task: TaskPlanItem,
    userPrompt: string,
    onActivity: (msg: string) => void,
    requestApproval: (req: any) => Promise<boolean>,
    abortSignal?: AbortSignal
  ): Promise<{ success: boolean; output: string }> {
    const toolCtx: ToolExecutionContext = {
      workspaceRoot: this.workspaceRoot,
      agentId: this.config.id,
      agentName: this.config.name,
      taskId: task.id,
      requireApproval: true,
      requestApproval,
    };

    const tools = this.toolManager.getOllamaTools();
    const systemPrompt = `You are the Lead Main Agent in LocalCoders.
${this.config.systemPrompt}
You have full access to workspace filesystem, Git, search, and terminal tools.
Implement the task with clean, high-quality, production-ready code.`;

    const userMsg = `TASK: ${task.title}\n${task.description}\nOVERALL GOAL: ${userPrompt}`;
    const messages: any[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMsg },
    ];

    let turns = 0;
    let finalOutput = '';

    while (turns < 10) {
      turns++;
      if (abortSignal?.aborted) throw new Error('Cancelled');

      let content = '';
      let toolCalls: any = undefined;

      await this.ollama.chatStream(
        {
          model: this.config.model,
          messages,
          tools,
          temperature: this.config.temperature || 0.2,
        },
        (chunk) => {
          content += chunk.content;
          if (chunk.toolCalls) toolCalls = chunk.toolCalls;
        },
        abortSignal
      );

      messages.push({ role: 'assistant', content, tool_calls: toolCalls });

      if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
        finalOutput = content;
        break;
      }

      for (const tc of (toolCalls as any[])) {
        const fn = tc.function || tc;
        const name = fn.name;
        let args: any = {};
        try {
          args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments || {};
        } catch {
          args = {};
        }

        onActivity(`[Main Agent] ${name}(${JSON.stringify(args).slice(0, 50)}...)`);
        const res = await this.toolManager.executeTool(name, args, toolCtx);
        messages.push({ role: 'tool', content: JSON.stringify(res) });
      }
    }

    return { success: true, output: finalOutput || 'Task completed.' };
  }

  // Address Critic findings
  private async addressCriticFindings(
    findings: any[],
    onActivity: (msg: string) => void,
    requestApproval: (req: any) => Promise<boolean>
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

Please inspect the files, apply the necessary corrections, and verify that the defects are resolved.`;

    const messages: any[] = [
      { role: 'system', content: `You are the Lead Main Agent. Correct the verified defects identified by the Critic Agent.` },
      { role: 'user', content: prompt },
    ];

    let turns = 0;
    while (turns < 8) {
      turns++;
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
        }
      );

      messages.push({ role: 'assistant', content, tool_calls: toolCalls });
      if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) break;

      for (const tc of (toolCalls as any[])) {
        const fn = tc.function || tc;
        const name = fn.name;
        let args: any = {};
        try {
          args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments || {};
        } catch {
          args = {};
        }

        onActivity(`[Main Agent Fixing] ${name}(${JSON.stringify(args).slice(0, 50)}...)`);
        const res = await this.toolManager.executeTool(name, args, toolCtx);
        messages.push({ role: 'tool', content: JSON.stringify(res) });
      }
    }
  }
}
