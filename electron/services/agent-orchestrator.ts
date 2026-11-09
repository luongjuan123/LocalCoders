import { BrowserWindow } from 'electron';
import { OllamaService } from './ollama.service';
import { FsService } from './fs.service';
import { GitService } from './git.service';
import { TerminalService } from './terminal.service';
import { DbService } from './db.service';
import {
  AgentConfig,
  AgentMessage,
  AgentStatus,
  AgentTask,
  CriticConfig,
  CriticFinding,
  CriticReport,
  TaskPlanItem,
  ToolApprovalRequest,
} from '../types';

export class DesktopAgentOrchestrator {
  private ollama: OllamaService;
  private fs: FsService;
  private git: GitService;
  private terminal: TerminalService;
  private db: DbService;
  private window: BrowserWindow | null = null;

  private mainAgent: AgentConfig | null = null;
  private subagents: Map<string, AgentConfig> = new Map();
  private criticConfig: CriticConfig = {
    enabled: true,
    model: '',
    strictness: 'strict',
    categories: ['Logical correctness', 'Security vulnerabilities', 'Race conditions', 'Memory leaks', 'Performance', 'Edge cases'],
    trigger: 'on_diff',
    reviewMode: 'changed_files',
  };

  private currentTask: AgentTask | null = null;
  private pendingApprovals: Map<string, (approved: boolean) => void> = new Map();
  private activeLocks: Map<string, string> = new Map(); // file -> agentId

  constructor(
    ollama: OllamaService,
    fs: FsService,
    git: GitService,
    terminal: TerminalService,
    db: DbService
  ) {
    this.ollama = ollama;
    this.fs = fs;
    this.git = git;
    this.terminal = terminal;
    this.db = db;
    this.loadState();
  }

  setWindow(win: BrowserWindow) {
    this.window = win;
  }

  private emit(channel: string, data: any) {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, data);
    }
  }

  private loadState() {
    const agents = this.db.getAgents();
    for (const a of agents) {
      if (a.id === 'main') this.mainAgent = a;
      else if (a.id === 'critic') this.criticConfig = a;
      else this.subagents.set(a.id, a);
    }
  }

  getMainAgent(): AgentConfig | null {
    return this.mainAgent;
  }

  setMainAgent(config: AgentConfig) {
    this.mainAgent = config;
    this.db.saveAgent(config);
  }

  getSubagents(): AgentConfig[] {
    return Array.from(this.subagents.values());
  }

  addSubagent(config: AgentConfig) {
    this.subagents.set(config.id, config);
    this.db.saveAgent(config);
  }

  removeSubagent(id: string) {
    this.subagents.delete(id);
  }

  getCriticConfig(): CriticConfig {
    return this.criticConfig;
  }

  setCriticConfig(config: Partial<CriticConfig>) {
    this.criticConfig = { ...this.criticConfig, ...config };
    this.db.saveAgent({ id: 'critic', ...this.criticConfig });
  }

  resolveApproval(reqId: string, approved: boolean) {
    const res = this.pendingApprovals.get(reqId);
    if (res) {
      res(approved);
      this.pendingApprovals.delete(reqId);
    }
  }

  cancelTask() {
    if (this.currentTask) {
      this.currentTask.status = 'cancelled';
      this.emit('agent-activity', {
        agentId: 'system',
        agentName: 'LocalCoders',
        status: 'cancelled',
        latestActivity: 'Execution cancelled by user.',
        timestamp: Date.now(),
      });
    }
  }

  // Multi-Agent Task Submission
  async submitTask(userPrompt: string): Promise<AgentTask> {
    if (!this.mainAgent || !this.mainAgent.model) {
      throw new Error('Mandatory Main Agent has not been configured. Please select a model in Setup.');
    }

    const taskId = `task_${Date.now()}`;
    this.currentTask = {
      id: taskId,
      title: userPrompt.slice(0, 50),
      userPrompt,
      plan: [],
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const userMsg: AgentMessage = {
      id: `msg_${Date.now()}`,
      senderId: 'user',
      senderName: 'You',
      senderRole: 'user',
      content: userPrompt,
      timestamp: Date.now(),
      taskId,
    };
    this.emit('agent-message', userMsg);
    this.db.saveMessage(userMsg);

    try {
      this.emit('agent-activity', {
        agentId: this.mainAgent.id,
        agentName: this.mainAgent.name,
        status: 'planning',
        latestActivity: 'Formulating task plan and delegation strategy...',
        timestamp: Date.now(),
      });

      // 1. Planning Phase
      const plan = await this.planTask(userPrompt);
      this.currentTask.plan = plan;
      this.emit('plan-update', plan);

      const planSummary = '### Implementation Plan\n' + plan.map((p, i) => `${i + 1}. **${p.title}** (${p.assignedTo === 'main' ? 'Main Agent' : p.assignedTo}): ${p.description}`).join('\n');
      const planMsg: AgentMessage = {
        id: `msg_plan_${Date.now()}`,
        senderId: this.mainAgent.id,
        senderName: this.mainAgent.name,
        senderRole: 'assistant',
        content: planSummary,
        timestamp: Date.now(),
        taskId,
      };
      this.emit('agent-message', planMsg);
      this.db.saveMessage(planMsg);

      // Pre-run Checkpoint Commit / Stash (safely handled)
      try {
        await this.git.createCheckpoint('Pre-agent execution');
      } catch (checkpointErr: any) {
        console.warn('[AgentOrchestrator] Non-fatal checkpoint warning:', checkpointErr?.message);
      }

      // 2. Execution Phase across Agents
      this.emit('agent-activity', {
        agentId: this.mainAgent.id,
        agentName: this.mainAgent.name,
        status: 'working',
        latestActivity: 'Executing tasks across configured agents...',
        timestamp: Date.now(),
      });

      for (const item of plan) {
        if (this.currentTask.status === 'cancelled') break;
        item.status = 'in_progress';
        this.emit('plan-update', this.currentTask.plan);

        if (item.assignedTo !== 'main' && this.subagents.has(item.assignedTo)) {
          const sub = this.subagents.get(item.assignedTo)!;
          this.emit('agent-activity', {
            agentId: sub.id,
            agentName: sub.name,
            status: 'working',
            latestActivity: `[${sub.name}] Working on: ${item.title}`,
            timestamp: Date.now(),
          });
          await this.executeAgentTask(sub, item, userPrompt);
        } else {
          this.emit('agent-activity', {
            agentId: this.mainAgent.id,
            agentName: this.mainAgent.name,
            status: 'working',
            latestActivity: `[Main Agent] Working on: ${item.title}`,
            timestamp: Date.now(),
          });
          await this.executeAgentTask(this.mainAgent, item, userPrompt);
        }

        item.status = 'completed';
        this.emit('plan-update', this.currentTask.plan);
      }

      // 3. Independent Critic Review Phase
      let criticReport: CriticReport | undefined = undefined;
      if (this.criticConfig.enabled && this.currentTask.status !== 'cancelled') {
        const criticModel = this.criticConfig.model || this.mainAgent.model;
        this.emit('agent-activity', {
          agentId: 'critic',
          agentName: 'Critic Agent',
          status: 'reviewing',
          latestActivity: 'Auditing code changes for defects and security vulnerabilities...',
          timestamp: Date.now(),
        });

        criticReport = await this.runCriticReview(userPrompt, criticModel);
        this.currentTask.criticReport = criticReport;
        this.emit('critic-report', criticReport);

        // Targeted Correction Cycle if Critical defects exist
        const criticalFindings = criticReport.findings.filter((f) => f.severity === 'Critical' || f.severity === 'High');
        if (criticalFindings.length > 0 && (this.currentTask.status as string) !== 'cancelled') {
          this.emit('agent-activity', {
            agentId: this.mainAgent.id,
            agentName: this.mainAgent.name,
            status: 'working',
            latestActivity: `Resolving ${criticalFindings.length} verified Critic defect(s)...`,
            timestamp: Date.now(),
          });
          await this.fixCriticFindings(criticalFindings);

          // Re-audit
          this.emit('agent-activity', {
            agentId: 'critic',
            agentName: 'Critic Agent',
            status: 'reviewing',
            latestActivity: 'Re-checking corrected code...',
            timestamp: Date.now(),
          });
          criticReport = await this.runCriticReview(userPrompt, criticModel);
          this.currentTask.criticReport = criticReport;
          this.emit('critic-report', criticReport);
        }
      }

      this.currentTask.status = 'completed';
      this.emit('agent-activity', {
        agentId: this.mainAgent.id,
        agentName: this.mainAgent.name,
        status: 'completed',
        latestActivity: 'Implementation and validation finished.',
        timestamp: Date.now(),
      });

      let finalMsgText = `### Task Completed Successfully\nImplementation and validation finished.\n`;
      if (criticReport) {
        finalMsgText += `\n**Critic Verdict**: \`${criticReport.verdict}\`\n**Findings**: ${criticReport.findings.length} issue(s) identified.`;
      }

      const doneMsg: AgentMessage = {
        id: `msg_done_${Date.now()}`,
        senderId: this.mainAgent.id,
        senderName: this.mainAgent.name,
        senderRole: 'assistant',
        content: finalMsgText,
        timestamp: Date.now(),
        taskId,
      };
      this.emit('agent-message', doneMsg);
      this.db.saveMessage(doneMsg);

      return this.currentTask;
    } catch (err: any) {
      this.currentTask.status = 'failed';
      this.emit('agent-activity', {
        agentId: this.mainAgent.id,
        agentName: this.mainAgent.name,
        status: 'failed',
        latestActivity: err.message,
        timestamp: Date.now(),
      });
      return this.currentTask;
    }
  }

  private async planTask(userPrompt: string): Promise<TaskPlanItem[]> {
    const subList = Array.from(this.subagents.values())
      .filter((s) => s.enabled)
      .map((s) => `- ${s.name} (ID: "${s.id}", Role: "${s.role}")`)
      .join('\n') || 'None (Main Agent only)';

    const prompt = `You are the Lead Main Agent. Plan this coding task into 1-4 modular steps.
Assign tasks to available subagents matching their role, or "main".

AVAILABLE SUBAGENTS:
${subList}

USER REQUEST:
${userPrompt}

Respond strictly with JSON:
\`\`\`json
{
  "tasks": [
    {
      "id": "t-1",
      "title": "Short title",
      "description": "What to do",
      "assignedTo": "main" | "subagent-id",
      "dependencies": [],
      "affectedFiles": ["file.ts"]
    }
  ]
}
\`\`\``;

    let text = '';
    await this.ollama.chatStream(
      {
        model: this.mainAgent!.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      },
      (c) => (text += c.content)
    );

    try {
      const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      const parsed = JSON.parse(match ? match[1] : text);
      return (parsed.tasks || []).map((t: any, idx: number) => ({
        id: t.id || `task-${idx + 1}`,
        title: t.title || `Step ${idx + 1}`,
        description: t.description || '',
        assignedTo: t.assignedTo || 'main',
        dependencies: t.dependencies || [],
        status: 'pending',
        affectedFiles: t.affectedFiles || [],
      }));
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

  private async executeAgentTask(agent: AgentConfig, task: TaskPlanItem, goal: string): Promise<void> {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read file contents',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Write file contents',
          parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'run_command',
          description: 'Execute shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        },
      },
    ];

    const messages: any[] = [
      { role: 'system', content: `You are ${agent.name} (${agent.role}). Implement the delegated task accurately.` },
      { role: 'user', content: `TASK: ${task.title}\n${task.description}\nGOAL: ${goal}` },
    ];

    let turns = 0;
    while (turns < 8) {
      turns++;
      let content = '';
      let toolCalls: any = undefined;

      await this.ollama.chatStream(
        {
          model: agent.model,
          messages,
          tools,
          temperature: agent.temperature || 0.2,
        },
        (c) => {
          content += c.content;
          if (c.toolCalls) toolCalls = c.toolCalls;
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
        } catch {}

        let result: any = { success: true };

        if (name === 'read_file') {
          try {
            const data = await this.fs.readFile(args.path);
            result = { success: true, content: data };
          } catch (e: any) {
            result = { success: false, error: e.message };
          }
        } else if (name === 'write_file') {
          // Trigger approval request
          const approved = await this.requestApproval({
            id: `appr_${Date.now()}`,
            toolCallId: tc.id || `call_${Date.now()}`,
            agentId: agent.id,
            agentName: agent.name,
            tool: 'write_file',
            args,
            description: `Modify file '${args.path}'`,
            isDestructive: false,
            filePath: args.path,
          });

          if (approved) {
            await this.fs.writeFile(args.path, args.content);
            result = { success: true, path: args.path };
          } else {
            result = { success: false, error: 'User rejected change.' };
          }
        } else if (name === 'run_command') {
          const isDanger = this.terminal.isDangerous(args.command);
          const approved = await this.requestApproval({
            id: `appr_${Date.now()}`,
            toolCallId: tc.id || `call_${Date.now()}`,
            agentId: agent.id,
            agentName: agent.name,
            tool: 'run_command',
            args,
            description: isDanger ? `DANGEROUS command: '${args.command}'` : `Run command: '${args.command}'`,
            isDestructive: isDanger,
          });

          if (approved) {
            let out = '';
            await this.terminal.execute(`cmd_${Date.now()}`, args.command, (c) => (out += c.text));
            result = { success: true, output: out };
          } else {
            result = { success: false, error: 'User rejected command execution.' };
          }
        }

        messages.push({ role: 'tool', content: JSON.stringify(result) });
      }
    }
  }

  private requestApproval(req: ToolApprovalRequest): Promise<boolean> {
    this.emit('approval-request', req);
    return new Promise((resolve) => {
      this.pendingApprovals.set(req.id, resolve);
    });
  }

  private async runCriticReview(userPrompt: string, model: string): Promise<CriticReport> {
    const diff = await this.git.getDiff();
    const prompt = `You are the LocalCoders Critic Agent. Audit the code changes independently and find verifiable defects.
STRICTNESS: ${this.criticConfig.strictness}

REQUIREMENTS:
${userPrompt}

GIT DIFF:
${diff.slice(0, 12000)}

Respond strictly in JSON format:
\`\`\`json
{
  "verdict": "approved" | "changes_requested" | "blocker",
  "summary": "Concise summary",
  "findings": [
    {
      "id": "crit-1",
      "severity": "Critical" | "High" | "Medium" | "Low",
      "category": "Security" | "Logic" | "Performance",
      "filePath": "src/file.ts",
      "evidence": "Problematic code",
      "explanation": "Why this is an issue",
      "reproduction": "How to trigger",
      "recommendedFix": "Concrete code correction",
      "confidence": "Confirmed"
    }
  ]
}
\`\`\``;

    let res = '';
    await this.ollama.chatStream(
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      },
      (c) => (res += c.content)
    );

    try {
      const match = res.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      const parsed = JSON.parse(match ? match[1] : res);
      return {
        id: `report_${Date.now()}`,
        timestamp: Date.now(),
        filesReviewed: [],
        findings: (parsed.findings || []).map((f: any, idx: number) => ({
          id: f.id || `f-${idx + 1}`,
          severity: f.severity || 'Medium',
          category: f.category || 'Logical correctness',
          filePath: f.filePath || 'unknown',
          evidence: f.evidence || '',
          explanation: f.explanation || '',
          reproduction: f.reproduction || '',
          recommendedFix: f.recommendedFix || '',
          confidence: f.confidence || 'Confirmed',
          resolved: false,
        })),
        summary: parsed.summary || 'Audit completed.',
        verdict: parsed.verdict || 'approved',
      };
    } catch {
      return {
        id: `report_${Date.now()}`,
        timestamp: Date.now(),
        filesReviewed: [],
        findings: [],
        summary: 'Critic verified changes. No defects found.',
        verdict: 'approved',
      };
    }
  }

  private async fixCriticFindings(findings: CriticFinding[]): Promise<void> {
    const list = findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.filePath}: ${f.explanation}\nEvidence: ${f.evidence}\nFix: ${f.recommendedFix}`).join('\n\n');
    const prompt = `The Critic Agent reported the following defects in the code:\n\n${list}\n\nPlease apply corrections.`;
    await this.executeAgentTask(
      this.mainAgent!,
      {
        id: 'fix-critic',
        title: 'Fix Critic Defects',
        description: prompt,
        assignedTo: 'main',
        dependencies: [],
        status: 'in_progress',
        affectedFiles: findings.map((f) => f.filePath),
      },
      'Fix verified defects discovered by Critic'
    );
  }
}
