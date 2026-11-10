import * as vscode from 'vscode';
import { OllamaClient } from '../ollama/client';
import { AgentRegistry } from './agent-registry';
import { ToolManager } from '../tools/tool-manager';
import { MemoryManager } from '../context/memory-manager';
import { CodebaseIndexer } from '../context/indexer';
import { FileLockManager } from './file-lock';
import { MainAgent } from './main-agent';
import { Subagent } from './subagent';
import { CriticAgent } from './critic-agent';
import { AgentSessionConfig } from '../sessions/session-manager';
import {
  AgentActivityEvent,
  AgentMessage,
  AgentStatus,
  AgentTask,
  CriticReport,
  TaskPlanItem,
  ToolApprovalRequest,
} from './types';

export class AgentOrchestrator {
  private ollama: OllamaClient;
  private registry: AgentRegistry;
  private toolManager: ToolManager;
  private memoryManager: MemoryManager;
  private indexer: CodebaseIndexer;
  private fileLockManager: FileLockManager;
  private workspaceRoot: string;

  private currentTask: AgentTask | null = null;
  private abortController: AbortController | null = null;
  private pendingApprovals: Map<string, (approved: boolean) => void> = new Map();

  // Event callbacks for UI
  private onActivityListeners: ((event: AgentActivityEvent) => void)[] = [];
  private onMessageListeners: ((message: AgentMessage) => void)[] = [];
  private onPlanUpdateListeners: ((plan: TaskPlanItem[]) => void)[] = [];
  private onApprovalListeners: ((req: ToolApprovalRequest) => void)[] = [];
  private onCriticReportListeners: ((report: CriticReport) => void)[] = [];

  constructor(
    ollama: OllamaClient,
    registry: AgentRegistry,
    toolManager: ToolManager,
    workspaceRoot: string
  ) {
    this.ollama = ollama;
    this.registry = registry;
    this.toolManager = toolManager;
    this.workspaceRoot = workspaceRoot;
    this.memoryManager = new MemoryManager(workspaceRoot);
    this.indexer = new CodebaseIndexer(workspaceRoot);
    this.fileLockManager = new FileLockManager();
  }

  setWorkspace(root: string) {
    this.workspaceRoot = root;
    this.memoryManager.setWorkspace(root);
    this.indexer.setWorkspace(root);
  }

  // Event Listeners Registration
  onActivity(cb: (event: AgentActivityEvent) => void) {
    this.onActivityListeners.push(cb);
  }

  onMessage(cb: (msg: AgentMessage) => void) {
    this.onMessageListeners.push(cb);
  }

  onPlanUpdate(cb: (plan: TaskPlanItem[]) => void) {
    this.onPlanUpdateListeners.push(cb);
  }

  onApproval(cb: (req: ToolApprovalRequest) => void) {
    this.onApprovalListeners.push(cb);
  }

  onCriticReport(cb: (report: CriticReport) => void) {
    this.onCriticReportListeners.push(cb);
  }

  private emitActivity(agentId: string, agentName: string, status: AgentStatus, activity: string) {
    const event: AgentActivityEvent = {
      agentId,
      agentName,
      status,
      latestActivity: activity,
      timestamp: Date.now(),
    };
    for (const cb of this.onActivityListeners) cb(event);
  }

  private emitMessage(msg: AgentMessage) {
    for (const cb of this.onMessageListeners) cb(msg);
  }

  private emitPlan(plan: TaskPlanItem[]) {
    for (const cb of this.onPlanUpdateListeners) cb(plan);
  }

  private emitApproval(req: ToolApprovalRequest) {
    for (const cb of this.onApprovalListeners) cb(req);
  }

  private emitCritic(report: CriticReport) {
    for (const cb of this.onCriticReportListeners) cb(report);
  }

  // Resolve pending user approval
  resolveApproval(requestId: string, approved: boolean) {
    const resolver = this.pendingApprovals.get(requestId);
    if (resolver) {
      resolver(approved);
      this.pendingApprovals.delete(requestId);
    }
  }

  // Cancel currently running task
  cancelTask() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.currentTask) {
      this.currentTask.status = 'cancelled';
      this.emitActivity('system', 'LocalCoders', 'cancelled', 'Task cancelled by user.');
    }
  }

  private isInformationalQuery(prompt: string): boolean {
    const lower = prompt.trim().toLowerCase();
    const actionWords = ['write', 'create', 'fix', 'implement', 'add', 'modify', 'change', 'refactor', 'delete', 'remove', 'run', 'test', 'install', 'build'];
    const hasAction = actionWords.some((w) => lower.includes(w));
    if (hasAction) return false;

    const questionWords = ['what', 'why', 'how', 'explain', 'where', 'list', 'is there', 'can you describe', 'tell me', 'which'];
    return questionWords.some((qw) => lower.startsWith(qw));
  }

  // Submit and start a new coding task with full execution mode & permission enforcement
  async submitTask(
    userPrompt: string,
    sessionConfig?: AgentSessionConfig,
    conversationContext?: Array<{ role: string; content: string }>
  ): Promise<AgentTask> {
    const mainConfig = this.registry.getMainAgent();
    if (!mainConfig) {
      throw new Error('Mandatory Main Agent has not been configured! Please configure a Main Agent in LocalCoders setup.');
    }

    // Apply session-specific model if configured
    if (sessionConfig?.modelId) {
      const cleanModel = sessionConfig.modelId.includes('/')
        ? sessionConfig.modelId.split('/')[1]
        : sessionConfig.modelId;
      mainConfig.model = cleanModel;
    }

    const taskId = `task_${Date.now()}`;
    this.abortController = new AbortController();

    this.currentTask = {
      id: taskId,
      title: userPrompt.slice(0, 60),
      userPrompt,
      plan: [],
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // User Message
    this.emitMessage({
      id: `msg_${Date.now()}`,
      senderId: 'user',
      senderName: 'You',
      senderRole: 'user',
      content: userPrompt,
      timestamp: Date.now(),
      taskId,
    });

    // Injected Context (Attached Files / Rules / Prior Conversation)
    let effectivePrompt = userPrompt;
    if (sessionConfig?.attachedFiles && sessionConfig.attachedFiles.length > 0) {
      effectivePrompt = `ATTACHED CONTEXT FILES:\n${sessionConfig.attachedFiles.map((f) => `- ${f}`).join('\n')}\n\nUSER PROMPT:\n${userPrompt}`;
    }

    if (conversationContext && conversationContext.length > 1) {
      const recentContext = conversationContext
        .slice(-4)
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 600)}`)
        .join('\n\n');
      effectivePrompt = `RECENT CONVERSATION HISTORY:\n${recentContext}\n\nLATEST USER INSTRUCTION:\n${effectivePrompt}`;
    }

    const approvalHandler = async (req: ToolApprovalRequest): Promise<boolean> => {
      // 1. Bypass Permissions mode: auto-approve unless dangerous
      if (sessionConfig?.permissionMode === 'bypass') {
        const isDangerous = req.tool === 'database_execute' && req.isDestructive;
        if (!isDangerous) {
          return true;
        }
      }

      // 2. Query PermissionManager if configured
      const pm = this.toolManager.getPermissionManager();
      if (pm) {
        const toolDef = this.toolManager.getToolDefinitions().find((t) => t.name === req.tool);
        if (toolDef && !pm.isApprovalRequired(toolDef, taskId, req.args)) {
          return true;
        }
      }

      // 3. Fallback when running without UI approval listeners (e.g. testing/headless)
      if (this.onApprovalListeners.length === 0) {
        return !req.isDestructive;
      }

      this.emitApproval(req);
      return new Promise<boolean>((resolve) => {
        this.pendingApprovals.set(req.id, resolve);
      });
    };

    // Build Subagents
    const activeSubagentConfigs = this.registry.getSubagents().filter((s) => s.enabled && s.model);
    const subagents = activeSubagentConfigs.map(
      (c) => new Subagent(c, this.ollama, this.toolManager, this.fileLockManager, this.workspaceRoot)
    );

    // Build Critic Agent if enabled
    const criticConf = this.registry.getCriticConfig();
    let criticAgent: CriticAgent | null = null;
    if (criticConf.enabled) {
      const criticModel = criticConf.model || mainConfig.model;
      criticAgent = new CriticAgent(
        this.ollama,
        { ...criticConf, model: criticModel },
        this.memoryManager,
        this.toolManager,
        this.workspaceRoot
      );
    }

    // Build Main Agent
    const mainAgent = new MainAgent(
      mainConfig,
      this.ollama,
      this.toolManager,
      this.memoryManager,
      this.indexer,
      this.workspaceRoot
    );

    try {
      const mode = sessionConfig?.executionMode || 'code';

      // 1. ASK MODE: Answer questions without making code modifications
      if (mode === 'ask' || (mode === 'smart' && this.isInformationalQuery(userPrompt))) {
        this.emitActivity(mainConfig.id, mainConfig.name, 'working', 'Analyzing codebase and formulating answer...');
        const answer = await mainAgent.answerQuestion(effectivePrompt, this.abortController.signal, {
          reasoningEffort: sessionConfig?.reasoningEffort,
          fastMode: sessionConfig?.fastMode,
        });

        this.currentTask.status = 'completed';
        this.emitMessage({
          id: `msg_ans_${Date.now()}`,
          senderId: mainConfig.id,
          senderName: mainConfig.name,
          senderRole: 'assistant',
          content: answer,
          timestamp: Date.now(),
          taskId,
        });
        this.emitActivity(mainConfig.id, mainConfig.name, 'completed', 'Analysis complete.');
        return this.currentTask;
      }

      // 2. PLAN MODE: Formulate plan without modifying files
      if (mode === 'plan') {
        this.emitActivity(mainConfig.id, mainConfig.name, 'planning', 'Formulating architectural plan before implementation...');
        const plan = await mainAgent.createPlan(effectivePrompt, subagents, (act) => {
          this.emitActivity(mainConfig.id, mainConfig.name, 'planning', act);
        });

        this.currentTask.plan = plan;
        this.emitPlan(plan);

        const planMsgContent =
          `### Implementation Plan (Drafted in Plan Mode)\n` +
          plan
            .map(
              (p, i) =>
                `${i + 1}. **${p.title}** (${p.assignedTo === 'main' ? 'Main Agent' : p.assignedTo}): ${p.description}`
            )
            .join('\n') +
          `\n\n*Review the plan above. To execute code modifications, switch to **Code Mode** or approve tasks.*`;

        this.emitMessage({
          id: `msg_plan_${Date.now()}`,
          senderId: mainConfig.id,
          senderName: mainConfig.name,
          senderRole: 'assistant',
          content: planMsgContent,
          timestamp: Date.now(),
          taskId,
        });

        this.currentTask.status = 'completed';
        this.emitActivity(mainConfig.id, mainConfig.name, 'completed', 'Plan formulated.');
        return this.currentTask;
      }

      // 3. CODE / SMART MODE: Full autonomous execution
      this.emitActivity(mainConfig.id, mainConfig.name, 'planning', 'Formulating implementation plan...');

      const plan = await mainAgent.createPlan(effectivePrompt, subagents, (act) => {
        this.emitActivity(mainConfig.id, mainConfig.name, 'planning', act);
      });

      this.currentTask.plan = plan;
      this.emitPlan(plan);

      // Assistant Plan Message
      const planMsgContent =
        `### Implementation Plan\n` +
        plan
          .map(
            (p, i) =>
              `${i + 1}. **${p.title}** (${p.assignedTo === 'main' ? 'Main Agent' : p.assignedTo}): ${p.description}`
          )
          .join('\n');
      this.emitMessage({
        id: `msg_plan_${Date.now()}`,
        senderId: mainConfig.id,
        senderName: mainConfig.name,
        senderRole: 'assistant',
        content: planMsgContent,
        timestamp: Date.now(),
        taskId,
      });

      // Execute Plan
      this.emitActivity(mainConfig.id, mainConfig.name, 'working', 'Executing plan across agent team...');

      const execResult = await mainAgent.executePlan(
        plan,
        effectivePrompt,
        subagents,
        criticAgent,
        (act) => {
          this.emitActivity(mainConfig.id, mainConfig.name, 'working', act);
        },
        (updatedPlan) => {
          this.currentTask!.plan = updatedPlan;
          this.emitPlan(updatedPlan);
        },
        approvalHandler,
        this.abortController.signal
      );

      this.currentTask.status = execResult.success ? 'completed' : 'failed';
      this.currentTask.criticReport = execResult.criticReport;

      if (execResult.criticReport) {
        this.emitCritic(execResult.criticReport);
      }

      this.emitActivity(
        mainConfig.id,
        mainConfig.name,
        execResult.success ? 'completed' : 'failed',
        execResult.summary
      );

      // Final Message
      let finalMsg = `### Execution Complete\n${execResult.summary}\n`;
      if (execResult.criticReport) {
        finalMsg += `\n**Critic Verdict**: \`${execResult.criticReport.verdict}\`\n**Findings**: ${execResult.criticReport.findings.length} issue(s) identified.`;
      }

      this.emitMessage({
        id: `msg_done_${Date.now()}`,
        senderId: mainConfig.id,
        senderName: mainConfig.name,
        senderRole: 'assistant',
        content: finalMsg,
        timestamp: Date.now(),
        taskId,
      });

      return this.currentTask;
    } catch (err: any) {
      this.currentTask.status = 'failed';
      this.emitActivity(mainConfig.id, mainConfig.name, 'failed', err.message);
      this.emitMessage({
        id: `msg_err_${Date.now()}`,
        senderId: 'system',
        senderName: 'LocalCoders',
        senderRole: 'system',
        content: `Execution halted with error: ${err.message}`,
        timestamp: Date.now(),
        taskId,
      });
      return this.currentTask;
    } finally {
      this.abortController = null;
    }
  }

  getCurrentTask(): AgentTask | null {
    return this.currentTask;
  }
}
