import * as vscode from 'vscode';
import * as path from 'path';
import { AgentRegistry } from '../agents/agent-registry';
import { AgentOrchestrator } from '../agents/orchestrator';

// 1. Agent Team Tree View
export class AgentTeamTreeProvider implements vscode.TreeDataProvider<AgentTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<AgentTreeItem | undefined | null | void> = new vscode.EventEmitter<AgentTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<AgentTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(private registry: AgentRegistry) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: AgentTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AgentTreeItem): Thenable<AgentTreeItem[]> {
    if (element) return Promise.resolve([]);

    const items: AgentTreeItem[] = [];

    // Main Agent
    const main = this.registry.getMainAgent();
    if (main) {
      items.push(
        new AgentTreeItem(
          `★ ${main.name} (${main.model || 'No model'})`,
          `${main.role} • Mandatory Coordinator`,
          vscode.TreeItemCollapsibleState.None,
          'star',
          'localcoders.manageAgents'
        )
      );
    } else {
      items.push(
        new AgentTreeItem(
          '★ Main Agent (Not Configured)',
          'Click to configure mandatory Main Agent',
          vscode.TreeItemCollapsibleState.None,
          'warning',
          'localcoders.openSetupWizard'
        )
      );
    }

    // Subagents
    const subs = this.registry.getSubagents();
    if (subs.length === 0) {
      items.push(
        new AgentTreeItem(
          'No Subagents Configured',
          'Click to add specialized subagents',
          vscode.TreeItemCollapsibleState.None,
          'info',
          'localcoders.manageAgents'
        )
      );
    } else {
      for (const s of subs) {
        items.push(
          new AgentTreeItem(
            `${s.name} (${s.model || 'No model'})`,
            `${s.role} • ${s.enabled ? 'Enabled' : 'Disabled'}`,
            vscode.TreeItemCollapsibleState.None,
            s.enabled ? 'pass' : 'circle-slash',
            'localcoders.manageAgents'
          )
        );
      }
    }

    // Critic Agent
    const critic = this.registry.getCriticConfig();
    items.push(
      new AgentTreeItem(
        `🛡️ Critic Agent (${critic.enabled ? critic.model || 'Active' : 'Disabled'})`,
        `Strictness: ${critic.strictness} • Mode: ${critic.reviewMode}`,
        vscode.TreeItemCollapsibleState.None,
        critic.enabled ? 'shield' : 'circle-slash',
        'localcoders.enableCritic'
      )
    );

    return Promise.resolve(items);
  }
}

export class AgentTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    icon: string,
    commandId?: string
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    if (commandId) {
      this.command = {
        command: commandId,
        title: label,
      };
    }
  }
}

// 2. Task Monitor Tree View
export class TaskMonitorTreeProvider implements vscode.TreeDataProvider<TaskTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<TaskTreeItem | undefined | null | void> = new vscode.EventEmitter<TaskTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TaskTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(private orchestrator: AgentOrchestrator) {
    this.orchestrator.onPlanUpdate(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TaskTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TaskTreeItem): Thenable<TaskTreeItem[]> {
    if (element) return Promise.resolve([]);

    const task = this.orchestrator.getCurrentTask();
    if (!task || task.plan.length === 0) {
      return Promise.resolve([
        new TaskTreeItem('No active task plan', 'Submit a task to start orchestration', 'info'),
      ]);
    }

    const items = task.plan.map((p) => {
      let icon = 'circle-outline';
      if (p.status === 'in_progress') icon = 'sync~spin';
      else if (p.status === 'completed') icon = 'check';
      else if (p.status === 'failed') icon = 'error';

      return new TaskTreeItem(`${p.title}`, `[${p.status}] assigned to: ${p.assignedTo}`, icon);
    });

    return Promise.resolve(items);
  }
}

export class TaskTreeItem extends vscode.TreeItem {
  constructor(label: string, description: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

// 3. Project Memory Tree View
export class ProjectMemoryTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  constructor(private workspaceRoot: string) {}

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (element) return Promise.resolve([]);

    const rulesItem = new vscode.TreeItem('Project Rules (.localcoders/rules.md)', vscode.TreeItemCollapsibleState.None);
    rulesItem.description = 'Coding standards & conventions';
    rulesItem.iconPath = new vscode.ThemeIcon('book');
    rulesItem.command = {
      command: 'vscode.open',
      title: 'Open Rules',
      arguments: [vscode.Uri.file(path.join(this.workspaceRoot, '.localcoders', 'rules.md'))],
    };

    const memoryItem = new vscode.TreeItem('Project Memory (.localcoders/project-memory.md)', vscode.TreeItemCollapsibleState.None);
    memoryItem.description = 'Architectural decisions & session history';
    memoryItem.iconPath = new vscode.ThemeIcon('database');
    memoryItem.command = {
      command: 'vscode.open',
      title: 'Open Memory',
      arguments: [vscode.Uri.file(path.join(this.workspaceRoot, '.localcoders', 'project-memory.md'))],
    };

    return Promise.resolve([rulesItem, memoryItem]);
  }
}

// 4. Model Manager Tree View
export class ModelManagerTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private ollama: any) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) return [];

    const items: vscode.TreeItem[] = [];
    try {
      const models = await this.ollama.listModels();
      for (const m of models) {
        const sizeGb = (m.size / (1024 * 1024 * 1024)).toFixed(1);
        const item = new vscode.TreeItem(m.name, vscode.TreeItemCollapsibleState.None);
        item.description = `${sizeGb} GB • ${m.details?.parameter_size || ''}`;
        item.iconPath = new vscode.ThemeIcon('package');
        item.tooltip = `Ollama model: ${m.name}\nQuantization: ${m.details?.quantization_level || 'N/A'}`;
        items.push(item);
      }
    } catch {
      items.push(new vscode.TreeItem('Ollama Service Disconnected', vscode.TreeItemCollapsibleState.None));
    }

    const pullItem = new vscode.TreeItem('+ Browse / Pull Models...', vscode.TreeItemCollapsibleState.None);
    pullItem.description = 'Install models from Ollama library';
    pullItem.iconPath = new vscode.ThemeIcon('cloud-download');
    pullItem.command = { command: 'localcoders.openSetupWizard', title: 'Open Model Manager' };
    items.push(pullItem);

    return items;
  }
}

// 5. Critic Reviews Tree View
export class CriticReviewsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private orchestrator: AgentOrchestrator, private registry: AgentRegistry) {
    this.orchestrator.onCriticReport(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (element) return Promise.resolve([]);

    const criticConf = this.registry.getCriticConfig();
    const task = this.orchestrator.getCurrentTask();
    const report = task?.criticReport;

    const items: vscode.TreeItem[] = [];

    const statusItem = new vscode.TreeItem(
      `Critic Status: ${criticConf.enabled ? 'Enabled (' + (criticConf.model || 'Default') + ')' : 'Disabled'}`,
      vscode.TreeItemCollapsibleState.None
    );
    statusItem.description = `Strictness: ${criticConf.strictness}`;
    statusItem.iconPath = new vscode.ThemeIcon(criticConf.enabled ? 'shield' : 'circle-slash');
    statusItem.command = { command: 'localcoders.enableCritic', title: 'Toggle Critic' };
    items.push(statusItem);

    if (report) {
      const verdictItem = new vscode.TreeItem(
        `Verdict: ${report.verdict.toUpperCase()}`,
        vscode.TreeItemCollapsibleState.None
      );
      verdictItem.description = `${report.findings.length} defect(s) flagged`;
      verdictItem.iconPath = new vscode.ThemeIcon(report.verdict === 'approved' ? 'check' : 'warning');
      verdictItem.command = { command: 'localcoders.criticFindingsPanel.focus', title: 'View Report' };
      items.push(verdictItem);

      for (const f of report.findings) {
        const item = new vscode.TreeItem(`[${f.severity}] ${f.category}`, vscode.TreeItemCollapsibleState.None);
        item.description = `${f.filePath}:${f.lineRange || ''}`;
        item.iconPath = new vscode.ThemeIcon(f.severity === 'Critical' || f.severity === 'High' ? 'error' : 'warning');
        item.tooltip = `${f.explanation}\n\nRecommended Fix: ${f.recommendedFix}`;
        item.command = { command: 'localcoders.criticFindingsPanel.focus', title: 'Inspect Finding' };
        items.push(item);
      }
    } else {
      const auditNowItem = new vscode.TreeItem('Run Independent Audit on Git Diff', vscode.TreeItemCollapsibleState.None);
      auditNowItem.description = 'Audit uncommitted changes';
      auditNowItem.iconPath = new vscode.ThemeIcon('play');
      auditNowItem.command = { command: 'localcoders.reviewGitChanges', title: 'Run Audit' };
      items.push(auditNowItem);
    }

    return Promise.resolve(items);
  }
}
