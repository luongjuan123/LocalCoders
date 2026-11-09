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

  // Submit and start a new coding task
  async submitTask(userPrompt: string): Promise<AgentTask> {
    const mainConfig = this.registry.getMainAgent();
    if (!mainConfig) {
      throw new Error('Mandatory Main Agent has not been configured! Please configure a Main Agent in LocalCoders setup.');
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

    const approvalHandler = async (req: ToolApprovalRequest): Promise<boolean> => {
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
    if (criticConf.enabled && criticConf.model) {
      criticAgent = new CriticAgent(this.ollama, criticConf, this.memoryManager, this.toolManager, this.workspaceRoot);
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
      this.emitActivity(mainConfig.id, mainConfig.name, 'planning', 'Formulating implementation plan...');

      // 1. Plan
      const plan = await mainAgent.createPlan(userPrompt, subagents, (act) => {
        this.emitActivity(mainConfig.id, mainConfig.name, 'planning', act);
      });

      this.currentTask.plan = plan;
      this.emitPlan(plan);

      // Assistant Plan Message
      const planMsgContent = `### Implementation Plan\n` + plan.map((p, i) => `${i + 1}. **${p.title}** (${p.assignedTo === 'main' ? 'Main Agent' : p.assignedTo}): ${p.description}`).join('\n');
      this.emitMessage({
        id: `msg_plan_${Date.now()}`,
        senderId: mainConfig.id,
        senderName: mainConfig.name,
        senderRole: 'assistant',
        content: planMsgContent,
        timestamp: Date.now(),
        taskId,
      });

      // 2. Execute
      this.emitActivity(mainConfig.id, mainConfig.name, 'working', 'Executing plan across agent team...');

      const execResult = await mainAgent.executePlan(
        plan,
        userPrompt,
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
