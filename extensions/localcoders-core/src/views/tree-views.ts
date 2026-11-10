import * as vscode from 'vscode';
import * as path from 'path';
import { AgentRegistry } from '../agents/agent-registry';
import { AgentOrchestrator } from '../agents/orchestrator';
import { McpHost, McpConnectedServer } from '../mcp/mcp-host';
import { PermissionManager, SecurityMode } from '../security/permission-manager';
import { ModelProviderRegistry } from '../models/model-provider-registry';

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
          `${main.name} (${main.model || 'No model'})`,
          `${main.role} | Mandatory Coordinator`,
          vscode.TreeItemCollapsibleState.None,
          'star',
          'localcoders.manageAgents'
        )
      );
    } else {
      items.push(
        new AgentTreeItem(
          'Main Agent (Not Configured)',
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
            `${s.role} | ${s.enabled ? 'Enabled' : 'Disabled'}`,
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
        `Critic Agent (${critic.enabled ? critic.model || 'Active' : 'Disabled'})`,
        `Strictness: ${critic.strictness} | Mode: ${critic.reviewMode}`,
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

  constructor(private ollama: any, private modelRegistry?: ModelProviderRegistry) {
    if (this.modelRegistry) {
      this.modelRegistry.onDidChangeModels(() => this.refresh());
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) return [];

    const items: vscode.TreeItem[] = [];

    const openMgrItem = new vscode.TreeItem('Open Model & Provider Manager...', vscode.TreeItemCollapsibleState.None);
    openMgrItem.description = 'Configure Ollama, Cloud keys, Custom endpoints';
    openMgrItem.iconPath = new vscode.ThemeIcon('settings-gear');
    openMgrItem.command = { command: 'localcoders.manageModels', title: 'Open Model Manager' };
    items.push(openMgrItem);

    if (this.modelRegistry) {
      const statuses = await this.modelRegistry.getProviderStatuses(false);
      const models = await this.modelRegistry.getAvailableModels({ includeDisabled: false });

      const ollamaStatus = statuses.find((s) => s.providerId === 'ollama');
      if (ollamaStatus && ollamaStatus.status !== 'connected') {
        const warn = new vscode.TreeItem(`Ollama Disconnected (${ollamaStatus.baseUrl})`, vscode.TreeItemCollapsibleState.None);
        warn.description = ollamaStatus.error || 'Click to configure';
        warn.iconPath = new vscode.ThemeIcon('warning');
        warn.command = { command: 'localcoders.manageModels', title: 'Configure Ollama' };
        items.push(warn);
      }

      for (const m of models) {
        const ctxStr = m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k` : 'Ctx Unknown';
        const item = new vscode.TreeItem(m.displayName, vscode.TreeItemCollapsibleState.None);
        item.description = `${m.providerName} | ${m.availability} | ${ctxStr}`;
        item.iconPath = new vscode.ThemeIcon(m.providerType === 'LOCAL' ? 'device-desktop' : 'cloud');
        item.tooltip = `${m.id}\nSource: ${m.modelSource}\nStatus: ${m.availability}`;
        items.push(item);
      }
    } else {
      try {
        const models = await this.ollama.listModels();
        for (const m of models) {
          const sizeGb = (m.size / (1024 * 1024 * 1024)).toFixed(1);
          const item = new vscode.TreeItem(m.name, vscode.TreeItemCollapsibleState.None);
          item.description = `${sizeGb} GB | ${m.details?.parameter_size || ''}`;
          item.iconPath = new vscode.ThemeIcon('package');
          items.push(item);
        }
      } catch {
        items.push(new vscode.TreeItem('Ollama Service Disconnected', vscode.TreeItemCollapsibleState.None));
      }
    }

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

// 6. MCP Servers Tree View
export class McpServersTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private mcpHost: McpHost) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      const servers = this.mcpHost.getAllServers();
      const items: vscode.TreeItem[] = [];

      const addItem = new vscode.TreeItem('+ Add External MCP Server...', vscode.TreeItemCollapsibleState.None);
      addItem.description = 'Configure stdio or HTTP SSE server';
      addItem.iconPath = new vscode.ThemeIcon('add');
      addItem.command = { command: 'localcoders.addMcpServer', title: 'Add MCP Server' };
      items.push(addItem);

      if (servers.length === 0) {
        const empty = new vscode.TreeItem('No MCP Servers Configured', vscode.TreeItemCollapsibleState.None);
        empty.description = 'Click above to connect SQLite, GitHub, Brave, etc.';
        empty.iconPath = new vscode.ThemeIcon('info');
        items.push(empty);
      } else {
        for (const s of servers) {
          const item = new vscode.TreeItem(
            s.config.name,
            s.status === 'connected' && s.tools.length > 0
              ? vscode.TreeItemCollapsibleState.Collapsed
              : vscode.TreeItemCollapsibleState.None
          );
          item.description = `[${s.status.toUpperCase()}] | ${s.config.transport} (${s.tools.length} tools)`;
          item.iconPath = new vscode.ThemeIcon(
            s.status === 'connected' ? 'plug' : s.status === 'error' ? 'error' : 'circle-slash'
          );
          (item as any).serverId = s.config.id;
          items.push(item);
        }
      }

      return items;
    }

    // Child items: tools discovered for server
    const serverId = (element as any).serverId;
    if (serverId) {
      const server = this.mcpHost.getServer(serverId);
      if (server && server.tools) {
        return server.tools.map((t) => {
          const item = new vscode.TreeItem(t.name, vscode.TreeItemCollapsibleState.None);
          item.description = t.description ? t.description.substring(0, 40) + '...' : 'MCP Tool';
          item.iconPath = new vscode.ThemeIcon('tools');
          item.tooltip = `${t.name}\n${t.description || ''}`;
          return item;
        });
      }
    }

    return [];
  }
}

// 7. Security & Permissions Tree View
export class SecurityPermissionsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private permissionManager: PermissionManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) return [];

    const mode = this.permissionManager.getMode();
    const items: vscode.TreeItem[] = [];

    const modeItem = new vscode.TreeItem(`Security Mode: ${mode.toUpperCase().replace(/_/g, ' ')}`, vscode.TreeItemCollapsibleState.None);
    modeItem.description = 'Click to switch security profile';
    modeItem.iconPath = new vscode.ThemeIcon('shield');
    modeItem.command = { command: 'localcoders.setSecurityMode', title: 'Set Security Mode' };
    items.push(modeItem);

    const history = this.permissionManager.getAuditHistory(10);
    const auditHeader = new vscode.TreeItem(`Recent Tool Execution Audits (${history.length})`, vscode.TreeItemCollapsibleState.None);
    auditHeader.iconPath = new vscode.ThemeIcon('history');
    items.push(auditHeader);

    for (const h of history.slice().reverse()) {
      const item = new vscode.TreeItem(h.toolName, vscode.TreeItemCollapsibleState.None);
      item.description = `[${h.status}] ${h.durationMs ? `${h.durationMs}ms` : ''}`;
      item.iconPath = new vscode.ThemeIcon(h.status === 'completed' ? 'pass' : h.status === 'failed' ? 'error' : 'warning');
      item.tooltip = `Agent: ${h.agentName}\nArgs: ${h.argsSummary}\nEnvironment: ${h.environment}`;
      items.push(item);
    }

    return items;
  }
}
