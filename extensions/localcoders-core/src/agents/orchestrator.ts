import * as vscode from 'vscode';
import { OllamaClient } from '../ollama/client';
import { AgentRegistry } from './agent-registry';
import { ToolManager } from '../tools/tool-manager';
import { MemoryManager } from '../context/memory-manager';
import { CodebaseIndexer } from '../context/indexer';
import { FileLockManager } from './file-lock';
import { MainAgent, RuntimeModelOptions } from './main-agent';
import { Subagent } from './subagent';
import { CriticAgent } from './critic-agent';
import { AgentSessionConfig } from '../sessions/session-manager';
import { ModelProviderRegistry } from '../models/model-provider-registry';
import { LLMRouter } from '../models/llm-router';
import {
  AgentActivityEvent,
  AgentMessage,
  AgentStatus,
  AgentTask,
  CriticReport,
  TaskPlanItem,
  ToolApprovalRequest,
} from './types';
import {
  AgentStreamEvent,
  SafeAgentPhase,
  classifyUserPrompt,
  getSafePhaseLabel,
  isPlanExplicitlyRequested,
  pairConversationHistory,
  sanitizeActivityText,
  sanitizeAssistantContent,
  sanitizeConversationHistory,
  stripCancelledTurnsFromHistory,
} from './events';

export class AgentOrchestrator {
  private ollama: OllamaClient;
  private registry: AgentRegistry;
  private toolManager: ToolManager;
  private memoryManager: MemoryManager;
  private indexer: CodebaseIndexer;
  private fileLockManager: FileLockManager;
  private workspaceRoot: string;
  private modelRegistry?: ModelProviderRegistry;
  private llmRouter: LLMRouter;

  private currentTask: AgentTask | null = null;
  private activeRunId: string | null = null;
  private abortController: AbortController | null = null;
  private pendingApprovals: Map<string, (approved: boolean) => void> = new Map();
  private pendingApprovalRequests: Map<string, ToolApprovalRequest> = new Map();

  // Event callbacks for UI
  private onActivityListeners: ((event: AgentActivityEvent) => void)[] = [];
  private onMessageListeners: ((message: AgentMessage) => void)[] = [];
  private onPlanUpdateListeners: ((plan: TaskPlanItem[]) => void)[] = [];
  private onApprovalListeners: ((req: ToolApprovalRequest) => void)[] = [];
  private onApprovalResolvedListeners: ((ev: { requestId: string; approved: boolean }) => void)[] = [];
  private onCriticReportListeners: ((report: CriticReport) => void)[] = [];
  private onStreamEventListeners: ((event: AgentStreamEvent) => void)[] = [];

  constructor(
    ollama: OllamaClient,
    registry: AgentRegistry,
    toolManager: ToolManager,
    workspaceRoot: string,
    modelRegistry?: ModelProviderRegistry
  ) {
    this.ollama = ollama;
    this.registry = registry;
    this.toolManager = toolManager;
    this.workspaceRoot = workspaceRoot;
    this.modelRegistry = modelRegistry;
    this.llmRouter = new LLMRouter(ollama, modelRegistry);
    this.memoryManager = new MemoryManager(workspaceRoot);
    this.indexer = new CodebaseIndexer(workspaceRoot);
    this.fileLockManager = new FileLockManager();
  }

  public getLLMRouter(): LLMRouter {
    return this.llmRouter;
  }

  setWorkspace(root: string) {
    this.workspaceRoot = root;
    this.memoryManager.setWorkspace(root);
    this.indexer.setWorkspace(root);
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  // Event Listeners Registration
  onActivity(cb: (event: AgentActivityEvent) => void): { dispose: () => void } {
    this.onActivityListeners.push(cb);
    return {
      dispose: () => {
        const idx = this.onActivityListeners.indexOf(cb);
        if (idx >= 0) this.onActivityListeners.splice(idx, 1);
      },
    };
  }

  onMessage(cb: (msg: AgentMessage) => void): { dispose: () => void } {
    this.onMessageListeners.push(cb);
    return {
      dispose: () => {
        const idx = this.onMessageListeners.indexOf(cb);
        if (idx >= 0) this.onMessageListeners.splice(idx, 1);
      },
    };
  }

  onPlanUpdate(cb: (plan: TaskPlanItem[]) => void): { dispose: () => void } {
    this.onPlanUpdateListeners.push(cb);
    return {
      dispose: () => {
        const idx = this.onPlanUpdateListeners.indexOf(cb);
        if (idx >= 0) this.onPlanUpdateListeners.splice(idx, 1);
      },
    };
  }

  onApproval(cb: (req: ToolApprovalRequest) => void): { dispose: () => void } {
    this.onApprovalListeners.push(cb);
    return {
      dispose: () => {
        const idx = this.onApprovalListeners.indexOf(cb);
        if (idx >= 0) this.onApprovalListeners.splice(idx, 1);
      },
    };
  }

  onCriticReport(cb: (report: CriticReport) => void): { dispose: () => void } {
    this.onCriticReportListeners.push(cb);
    return {
      dispose: () => {
        const idx = this.onCriticReportListeners.indexOf(cb);
        if (idx >= 0) this.onCriticReportListeners.splice(idx, 1);
      },
    };
  }

  onStreamEvent(cb: (event: AgentStreamEvent) => void): { dispose: () => void } {
    this.onStreamEventListeners.push(cb);
    return {
      dispose: () => {
        const idx = this.onStreamEventListeners.indexOf(cb);
        if (idx >= 0) this.onStreamEventListeners.splice(idx, 1);
      },
    };
  }

  private emitStreamEvent(event: AgentStreamEvent) {
    for (const cb of [...this.onStreamEventListeners]) {
      try {
        cb(event);
      } catch (e) {
        console.warn('[Orchestrator] onStreamEvent listener error:', e);
      }
    }
  }

  private emitActivity(agentId: string, agentName: string, status: AgentStatus, activity: string) {
    const safeActivity = sanitizeActivityText(activity, status);
    const event: AgentActivityEvent = {
      agentId,
      agentName,
      status,
      latestActivity: safeActivity,
      timestamp: Date.now(),
    };
    for (const cb of [...this.onActivityListeners]) {
      try {
        cb(event);
      } catch (e) {
        console.warn('[Orchestrator] onActivity listener error:', e);
      }
    }
  }

  private emitMessage(msg: AgentMessage) {
    for (const cb of [...this.onMessageListeners]) {
      try {
        cb(msg);
      } catch (e) {
        console.warn('[Orchestrator] onMessage listener error:', e);
      }
    }
  }

  private emitPlan(plan: TaskPlanItem[]) {
    for (const cb of [...this.onPlanUpdateListeners]) {
      try {
        cb(plan);
      } catch (e) {
        console.warn('[Orchestrator] onPlanUpdate listener error:', e);
      }
    }
  }

  private emitApproval(req: ToolApprovalRequest) {
    for (const cb of [...this.onApprovalListeners]) {
      try {
        cb(req);
      } catch (e) {
        console.warn('[Orchestrator] onApproval listener error:', e);
      }
    }
  }

  onApprovalResolved(cb: (ev: { requestId: string; approved: boolean }) => void): { dispose: () => void } {
    this.onApprovalResolvedListeners.push(cb);
    return {
      dispose: () => {
        const idx = this.onApprovalResolvedListeners.indexOf(cb);
        if (idx >= 0) this.onApprovalResolvedListeners.splice(idx, 1);
      },
    };
  }

  private emitApprovalResolved(requestId: string, approved: boolean) {
    for (const cb of [...this.onApprovalResolvedListeners]) {
      try {
        cb({ requestId, approved });
      } catch (e) {
        console.warn('[Orchestrator] onApprovalResolved listener error:', e);
      }
    }
  }

  public getPendingApprovalRequests(): ToolApprovalRequest[] {
    return Array.from(this.pendingApprovalRequests.values());
  }

  private emitCritic(report: CriticReport) {
    for (const cb of [...this.onCriticReportListeners]) {
      try {
        cb(report);
      } catch (e) {
        console.warn('[Orchestrator] onCriticReport listener error:', e);
      }
    }
  }

  // Resolve pending user approval
  resolveApproval(requestId: string, approved: boolean) {
    this.pendingApprovalRequests.delete(requestId);
    const resolver = this.pendingApprovals.get(requestId);
    if (resolver) {
      this.pendingApprovals.delete(requestId);
      resolver(approved);
    }
    this.emitApprovalResolved(requestId, approved);
  }

  public isTaskRunning(): boolean {
    return Boolean(this.abortController);
  }

  /**
   * Creates an isolated orchestrator runner sharing Ollama/registry/tools while forwarding
   * monitor telemetry, critic reports, and approval resolution to the parent orchestrator.
   */
  public createScopedRunner(targetWorkspaceRoot?: string): AgentOrchestrator {
    const runner = new AgentOrchestrator(
      this.ollama,
      this.registry,
      this.toolManager,
      targetWorkspaceRoot || this.workspaceRoot,
      this.modelRegistry
    );
    runner.onActivity((ev) => this.emitActivity(ev.agentId, ev.agentName, ev.status, ev.latestActivity));
    runner.onCriticReport((rep) => this.emitCritic(rep));
    runner.onStreamEvent((ev) => {
      if (ev.kind === 'activity_upsert') {
        this.emitStreamEvent(ev);
      }
    });
    runner.onApproval((req) => {
      this.pendingApprovalRequests.set(req.id, req);
      this.pendingApprovals.set(req.id, (approved) => runner.resolveApproval(req.id, approved));
      this.emitApproval(req);
    });
    runner.onApprovalResolved((ev) => {
      this.pendingApprovalRequests.delete(ev.requestId);
      this.pendingApprovals.delete(ev.requestId);
      this.emitApprovalResolved(ev.requestId, ev.approved);
    });
    return runner;
  }

  // Cancel currently running task
  cancelTask() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    for (const [reqId, resolver] of this.pendingApprovals.entries()) {
      this.pendingApprovalRequests.delete(reqId);
      this.pendingApprovals.delete(reqId);
      try {
        resolver(false);
      } catch {}
      this.emitApprovalResolved(reqId, false);
    }
    const runId = this.activeRunId || `run_${Date.now()}`;
    if (this.currentTask) {
      this.currentTask.status = 'cancelled';
      this.emitActivity('system', 'LocalCoders', 'cancelled', 'Task cancelled by user.');
    }
    this.emitStreamEvent({
      kind: 'status',
      id: `st_${runId}_cancel_${Date.now()}`,
      runId,
      agentId: 'system',
      agentName: 'LocalCoders',
      phase: 'cancelled',
      summary: getSafePhaseLabel('cancelled'),
      timestamp: Date.now(),
    });
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

    // Abort any lingering prior run so two local model streams never contend for VRAM
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // Use session-specific model if configured, without mutating global config or corrupting provider/model IDs
    const selectedModelId = (sessionConfig?.modelId || mainConfig.model || '').trim();
    const effectiveMainConfig = { ...mainConfig, model: selectedModelId };

    const taskId = `task_${Date.now()}`;
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.activeRunId = runId;
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

    // Strict Model Availability Check — NEVER silently substitute another model
    if (this.modelRegistry) {
      const resolution = await this.modelRegistry.resolveModelForExecution(selectedModelId);
      if (!resolution.ok) {
        const errMsg = resolution.error || `Selected model '${selectedModelId}' is unavailable.`;
        this.currentTask.status = 'failed';
        this.currentTask.error = errMsg;
        this.currentTask.updatedAt = Date.now();
        this.emitActivity(effectiveMainConfig.id, effectiveMainConfig.name, 'failed', errMsg);
        this.emitStreamEvent({
          kind: 'status',
          id: `st_${runId}_model_unavail_${Date.now()}`,
          runId,
          agentId: effectiveMainConfig.id,
          agentName: effectiveMainConfig.name,
          phase: 'failed',
          summary: errMsg,
          timestamp: Date.now(),
        });
        this.emitMessage({
          id: `msg_err_${Date.now()}`,
          senderId: 'system',
          senderName: 'LocalCoders',
          senderRole: 'assistant',
          content: `### Model Unavailable\n${errMsg}\n\nPlease choose an available model from the model selector or configure your provider in **Model Manager**.`,
          timestamp: Date.now(),
          taskId,
        });
        this.abortController = null;
        this.activeRunId = null;
        return this.currentTask;
      }
    }

    // Prepare clean context & classify prompt intent BEFORE heavy indexing/planning
    const mode = sessionConfig?.executionMode || 'code';
    const intent = classifyUserPrompt(userPrompt, mode);
    const activeHistory = stripCancelledTurnsFromHistory(conversationContext);
    const cleanHistory = sanitizeConversationHistory(activeHistory, userPrompt);
    const pairedHistory = pairConversationHistory(cleanHistory, 3);

    let effectivePrompt = userPrompt;
    if (sessionConfig?.attachedFiles && sessionConfig.attachedFiles.length > 0) {
      effectivePrompt = `ATTACHED CONTEXT FILES:\n${sessionConfig.attachedFiles.map((f) => `- ${f}`).join('\n')}\n\nUSER PROMPT:\n${userPrompt}`;
    }

    // Only prepend concise clean history summary for explicit multi-step planning/coding tasks;
    // conversational & question flows pass cleanHistory directly as structured messages.
    if (intent === 'coding_task' || intent === 'plan') {
      if (cleanHistory.length > 0) {
        const recentContext = cleanHistory
          .map((m) => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 400)}`)
          .join('\n\n');
        effectivePrompt = `RECENT CONVERSATION CONTEXT:\n${recentContext}\n\nLATEST USER INSTRUCTION:\n${effectivePrompt}`;
      }
    }

    // Keep runtime PermissionManager synchronized with active session permission mode
    const pmInstance = this.toolManager.getPermissionManager();
    if (pmInstance && sessionConfig?.permissionMode) {
      pmInstance.setMode(sessionConfig.permissionMode);
    }

    const approvalHandler = async (req: ToolApprovalRequest): Promise<boolean> => {
      const pm = this.toolManager.getPermissionManager();
      const toolDef = this.toolManager.getToolDefinitions().find((t) => t.name === req.tool);

      // 1. Hard safety boundary: prohibited commands/secrets/destructive actions ALWAYS require explicit confirmation
      if (pm && pm.isStrictlyProhibited(req.args)) {
        if (this.onApprovalListeners.length === 0) return false;
        this.pendingApprovalRequests.set(req.id, req);
        this.emitApproval(req);
        return new Promise<boolean>((resolve) => {
          this.pendingApprovals.set(req.id, resolve);
        });
      }

      // 2. Check PermissionManager policy first when tool definition exists
      if (pm && toolDef) {
        if (!pm.isApprovalRequired(toolDef, taskId, req.args)) {
          return true;
        }
      } else {
        // 3. Fallback when tool has no registered definition (e.g. git.commit or internal)
        const effectivePermMode = sessionConfig?.permissionMode || pm?.getNormalizedMode() || 'smart';
        if ((effectivePermMode === 'bypass' || effectivePermMode === 'smart') && !req.isDestructive) {
          return true;
        }
      }

      // 4. Headless / test fallback when no UI listener is attached
      if (this.onApprovalListeners.length === 0) {
        const effMode = sessionConfig?.permissionMode || pm?.getNormalizedMode() || 'smart';
        return !req.isDestructive && (effMode === 'bypass' || effMode === 'smart' || !toolDef || toolDef.permissionLevel === 'read');
      }

      this.pendingApprovalRequests.set(req.id, req);
      this.emitApproval(req);
      return new Promise<boolean>((resolve) => {
        this.pendingApprovals.set(req.id, resolve);
      });
    };

    // Build Subagents routed through LLMRouter (inheriting selectedModelId & default specialists when none custom-configured)
    const vsCfg = vscode.workspace.getConfiguration('localcoders');
    const enableBuiltinSubs = vsCfg.get<boolean>('enableBuiltinSubagents') ?? true;
    const activeSubagentConfigs = this.registry.getEffectiveSubagents(selectedModelId, enableBuiltinSubs);
    const subagents = activeSubagentConfigs.map(
      (c) => new Subagent(c, this.ollama, this.toolManager, this.fileLockManager, this.workspaceRoot, this.llmRouter)
    );

    // Build Critic Agent if enabled (do NOT silently substitute another model if critic model unavailable)
    const criticConf = this.registry.getCriticConfig();
    let criticAgent: CriticAgent | null = null;
    if (criticConf.enabled) {
      const criticModel = criticConf.model || selectedModelId;
      let canRunCritic = Boolean(criticModel);
      if (canRunCritic && this.modelRegistry) {
        const criticRes = await this.modelRegistry.resolveModelForExecution(criticModel);
        if (!criticRes.ok) {
          canRunCritic = false;
          const errSummary = `Critic review skipped: ${criticRes.error}`;
          this.emitActivity('critic', 'Critic Agent', 'failed', errSummary);
          this.emitStreamEvent({
            kind: 'activity_upsert',
            id: `critic_unavail_${runId}`,
            runId,
            item: {
              id: `critic_unavail_${runId}`,
              runId,
              category: 'subagent',
              agentId: 'critic',
              agentName: 'Critic Agent',
              agentRole: 'Code Quality & Security Critic',
              title: 'Critic Agent Unavailable',
              summary: errSummary,
              stderr: criticRes.error || 'Selected Critic model is unavailable.',
              status: 'failed',
              startTime: Date.now(),
              endTime: Date.now(),
              durationMs: 0,
              timestamp: Date.now(),
            },
            timestamp: Date.now(),
          });
        }
      }
      if (canRunCritic) {
        criticAgent = new CriticAgent(
          this.ollama,
          { ...criticConf, model: criticModel },
          this.memoryManager,
          this.toolManager,
          this.workspaceRoot,
          this.llmRouter
        );
      }
    }

    // Build Main Agent routed through LLMRouter
    const mainAgent = new MainAgent(
      effectiveMainConfig,
      this.ollama,
      this.toolManager,
      this.memoryManager,
      this.indexer,
      this.workspaceRoot,
      this.llmRouter
    );

    let lastEmittedStatusKey = '';
    const emitSafeStatus = (agentId: string, agentName: string, phase: SafeAgentPhase, summary?: string) => {
      const safeSum = summary || getSafePhaseLabel(phase);
      const dedupKey = `${agentId}:${phase}:${safeSum}`;
      if (dedupKey === lastEmittedStatusKey) return;
      lastEmittedStatusKey = dedupKey;
      this.emitStreamEvent({
        kind: 'status',
        id: `st_${runId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        runId,
        agentId,
        agentName,
        phase,
        summary: safeSum,
        timestamp: Date.now(),
      });
    };

    let lastEmittedCriticReportId = '';
    const emitCriticOnce = (report: CriticReport) => {
      if (report.id && report.id === lastEmittedCriticReportId) return;
      lastEmittedCriticReportId = report.id || '';
      if (this.currentTask) {
        this.currentTask.criticReport = report;
      }
      this.emitCritic(report);
    };

    const runtimeOptions: RuntimeModelOptions = {
      reasoningEffort: sessionConfig?.reasoningEffort,
      fastMode: sessionConfig?.fastMode,
      temperature: sessionConfig?.temperature,
      maxOutputTokens: sessionConfig?.maxOutputTokens,
      contextLimit: sessionConfig?.contextLimit,
      runId,
      onCriticReport: emitCriticOnce,
      onStreamEvent: (ev) => {
        if (ev.kind === 'status') {
          const dedupKey = `${ev.agentId}:${ev.phase}:${ev.summary}`;
          if (dedupKey === lastEmittedStatusKey) return;
          lastEmittedStatusKey = dedupKey;
        }
        this.emitStreamEvent(ev);
      },
    };

    const runAbortSignal = this.abortController.signal;

    try {
      // 0. LIGHTWEIGHT CONVERSATIONAL FAST PATH: Casual greetings / acknowledgements skip indexing, planning, tools, and Critic
      if (intent === 'greeting') {
        const convId = `msg_conv_${runId}`;
        emitSafeStatus(effectiveMainConfig.id, effectiveMainConfig.name, 'analyzing', 'Responding');
        const reply = await mainAgent.answerConversationalFast(userPrompt, runAbortSignal, {
          ...runtimeOptions,
          streamMessageId: convId,
          conversationHistory: pairedHistory,
        });

        this.currentTask.status = 'completed';
        const convMsg: AgentMessage = {
          id: convId,
          senderId: effectiveMainConfig.id,
          senderName: effectiveMainConfig.name,
          senderRole: 'assistant',
          content: sanitizeAssistantContent(reply),
          timestamp: Date.now(),
          taskId,
        };
        this.emitStreamEvent({
          kind: 'message_complete',
          id: `mc_${convId}`,
          runId,
          message: convMsg,
          timestamp: Date.now(),
        });
        this.emitMessage(convMsg);
        emitSafeStatus(effectiveMainConfig.id, effectiveMainConfig.name, 'completed', getSafePhaseLabel('completed'));
        this.emitActivity(effectiveMainConfig.id, effectiveMainConfig.name, 'completed', 'Completed');
        return this.currentTask;
      }

      // 1. ASK / QUESTION PATH: Answer questions without coding plans, tools, or file modifications
      if (intent === 'question') {
        const answerId = `msg_ans_${runId}`;
        emitSafeStatus(effectiveMainConfig.id, effectiveMainConfig.name, 'analyzing', 'Analyzing the task');
        const answer = await mainAgent.answerQuestion(effectivePrompt, runAbortSignal, {
          ...runtimeOptions,
          streamMessageId: answerId,
          conversationHistory: pairedHistory,
        });

        this.currentTask.status = 'completed';
        const finalMsg: AgentMessage = {
          id: answerId,
          senderId: effectiveMainConfig.id,
          senderName: effectiveMainConfig.name,
          senderRole: 'assistant',
          content: sanitizeAssistantContent(answer),
          timestamp: Date.now(),
          taskId,
        };
        this.emitStreamEvent({
          kind: 'message_complete',
          id: `mc_${answerId}`,
          runId,
          message: finalMsg,
          timestamp: Date.now(),
        });
        this.emitMessage(finalMsg);
        emitSafeStatus(effectiveMainConfig.id, effectiveMainConfig.name, 'completed', getSafePhaseLabel('completed'));
        this.emitActivity(effectiveMainConfig.id, effectiveMainConfig.name, 'completed', 'Completed');
        return this.currentTask;
      }

      // 2. PLAN MODE: Formulate plan without modifying files
      if (intent === 'plan' || mode === 'plan') {
        emitSafeStatus(effectiveMainConfig.id, effectiveMainConfig.name, 'planning', 'Planning approach');
        const plan = await mainAgent.createPlan(
          effectivePrompt,
          subagents,
          (act) => {
            this.emitActivity(effectiveMainConfig.id, effectiveMainConfig.name, 'planning', act);
          },
          runtimeOptions,
          runAbortSignal
        );

        this.currentTask.plan = plan;
        this.emitPlan(plan);
        this.emitStreamEvent({
          kind: 'plan',
          id: `plan_${runId}`,
          runId,
          plan,
          explicit: true,
          timestamp: Date.now(),
        });

        const planMsgContent =
          `### Implementation Plan (Drafted in Plan Mode)\n` +
          plan
            .map(
              (p, i) =>
                `${i + 1}. **${p.title}** (${p.assignedTo === 'main' ? 'Main Agent' : p.assignedTo}): ${p.description}`
            )
            .join('\n') +
          `\n\n*Review the plan above. To execute code modifications, switch to **Code Mode** or approve tasks.*`;

        const planMsg: AgentMessage = {
          id: `msg_plan_${runId}`,
          senderId: effectiveMainConfig.id,
          senderName: effectiveMainConfig.name,
          senderRole: 'assistant',
          content: planMsgContent,
          timestamp: Date.now(),
          taskId,
        };
        this.emitStreamEvent({
          kind: 'message_complete',
          id: `mc_${planMsg.id}`,
          runId,
          message: planMsg,
          timestamp: Date.now(),
        });
        this.emitMessage(planMsg);

        this.currentTask.status = 'completed';
        emitSafeStatus(effectiveMainConfig.id, effectiveMainConfig.name, 'completed', 'Completed');
        this.emitActivity(effectiveMainConfig.id, effectiveMainConfig.name, 'completed', 'Plan formulated.');
        return this.currentTask;
      }

      // 3. EXECUTE-ONLY / CODE / SMART MODE
      const isExecuteOnly = intent === 'execute_task';
      const taskRuntimeOptions: RuntimeModelOptions = {
        ...runtimeOptions,
        executeOnly: isExecuteOnly,
      };
      emitSafeStatus(
        effectiveMainConfig.id,
        effectiveMainConfig.name,
        isExecuteOnly ? 'working' : 'analyzing',
        isExecuteOnly ? 'Preparing execution' : 'Analyzing the task'
      );
      this.emitActivity(
        effectiveMainConfig.id,
        effectiveMainConfig.name,
        isExecuteOnly ? 'working' : 'planning',
        isExecuteOnly ? 'Running requested command/application without modifying code' : 'Analyzing the task'
      );

      const plan: TaskPlanItem[] = isExecuteOnly
        ? [
            {
              id: 'task-1',
              title: 'Run Requested Application or Command',
              description: userPrompt,
              assignedTo: 'main',
              dependencies: [],
              status: 'pending',
              affectedFiles: [],
            },
          ]
        : await mainAgent.createPlan(
            effectivePrompt,
            subagents,
            (act) => {
              this.emitActivity(effectiveMainConfig.id, effectiveMainConfig.name, 'planning', act);
            },
            taskRuntimeOptions,
            runAbortSignal
          );

      this.currentTask.plan = plan;
      this.emitPlan(plan);
      const explicitPlan = isPlanExplicitlyRequested(userPrompt, mode);
      this.emitStreamEvent({
        kind: 'plan',
        id: `plan_${runId}`,
        runId,
        plan,
        explicit: explicitPlan,
        timestamp: Date.now(),
      });

      // Only add plan wall-of-text into Main Conversation if explicitly requested by the user
      if (explicitPlan) {
        const planMsgContent =
          `### Implementation Plan\n` +
          plan
            .map(
              (p, i) =>
                `${i + 1}. **${p.title}** (${p.assignedTo === 'main' ? 'Main Agent' : p.assignedTo}): ${p.description}`
            )
            .join('\n');
        const planMsg: AgentMessage = {
          id: `msg_plan_${runId}`,
          senderId: effectiveMainConfig.id,
          senderName: effectiveMainConfig.name,
          senderRole: 'assistant',
          content: planMsgContent,
          timestamp: Date.now(),
          taskId,
        };
        this.emitStreamEvent({
          kind: 'message_complete',
          id: `mc_${planMsg.id}`,
          runId,
          message: planMsg,
          timestamp: Date.now(),
        });
        this.emitMessage(planMsg);
      }

      // Execute Plan
      emitSafeStatus(effectiveMainConfig.id, effectiveMainConfig.name, 'working', 'Agent is working');
      this.emitActivity(effectiveMainConfig.id, effectiveMainConfig.name, 'working', 'Agent is working');

      const execResult = await mainAgent.executePlan(
        plan,
        effectivePrompt,
        subagents,
        criticAgent,
        (act) => {
          this.emitActivity(effectiveMainConfig.id, effectiveMainConfig.name, 'working', act);
        },
        (updatedPlan) => {
          this.currentTask!.plan = updatedPlan;
          this.emitPlan(updatedPlan);
          this.emitStreamEvent({
            kind: 'plan',
            id: `plan_${runId}_${Date.now()}`,
            runId,
            plan: updatedPlan,
            explicit: explicitPlan,
            timestamp: Date.now(),
          });
        },
        approvalHandler,
        runAbortSignal,
        taskRuntimeOptions
      );

      const wasCancelled = Boolean(runAbortSignal.aborted);
      this.currentTask.status = wasCancelled ? 'cancelled' : execResult.success ? 'completed' : 'failed';
      if (!wasCancelled && !execResult.success) {
        this.currentTask.error = execResult.summary || 'Task execution failed.';
      }
      this.currentTask.updatedAt = Date.now();
      this.currentTask.criticReport = execResult.criticReport;

      if (execResult.criticReport) {
        emitCriticOnce(execResult.criticReport);
      }

      const effectiveSummary = wasCancelled
        ? 'Execution cancelled by user before completion.'
        : execResult.summary;

      emitSafeStatus(
        mainConfig.id,
        mainConfig.name,
        wasCancelled ? 'cancelled' : execResult.success ? 'completed' : 'failed',
        wasCancelled ? getSafePhaseLabel('cancelled') : execResult.success ? getSafePhaseLabel('completed') : getSafePhaseLabel('failed')
      );
      this.emitActivity(
        mainConfig.id,
        mainConfig.name,
        this.currentTask.status as AgentStatus,
        effectiveSummary
      );

      // Final Formatted Result Message
      const heading = wasCancelled
        ? '### Execution Cancelled'
        : execResult.success
        ? '### Execution Complete'
        : '### Execution Failed';
      let finalMsg = `${heading}\n${effectiveSummary}\n`;
      if (execResult.criticReport) {
        const rep = execResult.criticReport;
        finalMsg += `\n**Critic Verdict**: \`${rep.verdict}\`\n**Findings**: ${rep.findings.length} issue(s) identified.`;
        if (rep.findings.length > 0) {
          const topFindings = rep.findings
            .slice(0, 5)
            .map((f) => `- **[${f.severity}]** \`${f.filePath}${f.lineRange ? ':' + f.lineRange : ''}\`: ${f.explanation}`)
            .join('\n');
          finalMsg += `\n${topFindings}`;
        }
      }

      const doneMsg: AgentMessage = {
        id: `msg_done_${runId}`,
        senderId: mainConfig.id,
        senderName: mainConfig.name,
        senderRole: 'assistant',
        content: sanitizeAssistantContent(finalMsg),
        timestamp: Date.now(),
        taskId,
      };
      this.emitStreamEvent({
        kind: 'message_complete',
        id: `mc_${doneMsg.id}`,
        runId,
        message: doneMsg,
        timestamp: Date.now(),
      });
      this.emitMessage(doneMsg);

      return this.currentTask;
    } catch (err: any) {
      const wasCancelled = Boolean(runAbortSignal.aborted || /cancelled/i.test(err?.message || ''));
      this.currentTask.status = wasCancelled ? 'cancelled' : 'failed';
      if (!wasCancelled) {
        this.currentTask.error = err?.message || String(err);
      }
      this.currentTask.updatedAt = Date.now();
      const terminalPhase: SafeAgentPhase = wasCancelled ? 'cancelled' : 'failed';
      emitSafeStatus(mainConfig.id, mainConfig.name, terminalPhase, getSafePhaseLabel(terminalPhase));
      this.emitActivity(mainConfig.id, mainConfig.name, terminalPhase, err.message);
      const errMsg: AgentMessage = {
        id: `msg_${terminalPhase}_${runId}`,
        senderId: 'system',
        senderName: 'LocalCoders',
        senderRole: 'system',
        content: wasCancelled ? 'Execution cancelled by user.' : `Execution halted with error: ${err.message}`,
        timestamp: Date.now(),
        taskId,
      };
      this.emitStreamEvent({
        kind: 'message_complete',
        id: `mc_${errMsg.id}`,
        runId,
        message: errMsg,
        timestamp: Date.now(),
      });
      this.emitMessage(errMsg);
      return this.currentTask;
    } finally {
      this.abortController = null;
      this.activeRunId = null;
    }
  }

  getCurrentTask(): AgentTask | null {
    return this.currentTask;
  }
}
