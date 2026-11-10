import * as vscode from 'vscode';
import * as path from 'path';
import { OllamaClient } from './ollama/client';
import { AgentRegistry } from './agents/agent-registry';
import { ToolManager } from './tools/tool-manager';
import { AgentOrchestrator } from './agents/orchestrator';
import { SessionManager } from './sessions/session-manager';
import { ChangesManager } from './context/changes-manager';
import { MessageQueueManager } from './sessions/message-queue';
import { SetupWizardPanel } from './views/wizard-view';
import { ModelManagerPanel } from './views/model-manager-view';
import { AgentWorkspaceEditorPanel } from './views/agent-workspace-editor';
import { ChatViewProvider } from './views/chat-view';
import { ChangesViewProvider } from './views/changes-view';
import { NavigationViewProvider } from './views/navigation-view';
import { CriticFindingsViewProvider } from './views/critic-view';
import { AgentMonitorViewProvider } from './views/agent-monitor-view';
import {
  AgentTeamTreeProvider,
  TaskMonitorTreeProvider,
  ProjectMemoryTreeProvider,
  ModelManagerTreeProvider,
  CriticReviewsTreeProvider,
  McpServersTreeProvider,
  SecurityPermissionsTreeProvider,
} from './views/tree-views';
import { McpHost } from './mcp/mcp-host';
import { ModelProviderRegistry } from './models/model-provider-registry';
import { PermissionManager, SecurityMode } from './security/permission-manager';
import { ProcessManager } from './tools/process-manager';
import { TerminalSessionManager } from './tools/terminal-session-manager';
import { BrowserManager } from './tools/browser-tools';
import { collectNonAgentTabsToClose } from './views/agent-mode-lock';

let activeOrchestrator: AgentOrchestrator | null = null;
let activeOllamaClient: OllamaClient | null = null;
let activeMcpHost: McpHost | null = null;
let activePermissionManager: PermissionManager | null = null;
let activeQueueManager: MessageQueueManager | null = null;
let isDeactivating = false;

export async function activate(context: vscode.ExtensionContext) {
  console.log('[LocalCoders] Initializing Multi-Agent AI Core...');

  const config = vscode.workspace.getConfiguration('localcoders');
  const ollamaHost = config.get<string>('ollamaHost') || 'http://localhost:11434';
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

  // Initialize Core Services
  const ollama = new OllamaClient(ollamaHost);
  const modelRegistry = ModelProviderRegistry.initialize(ollama, context.globalState, context.secrets);
  const registry = new AgentRegistry(context);
  const permissionManager = new PermissionManager(workspaceRoot);
  const initialPermMode = config.get<'ask' | 'smart' | 'bypass'>('defaultPermissionMode');
  if (initialPermMode) {
    permissionManager.setMode(initialPermMode);
  }
  const mcpHost = new McpHost(workspaceRoot);
  const toolManager = new ToolManager(mcpHost, permissionManager);
  const orchestrator = new AgentOrchestrator(ollama, registry, toolManager, workspaceRoot, modelRegistry);
  const sessionManager = new SessionManager(context, workspaceRoot);
  const changesManager = new ChangesManager(workspaceRoot);
  const queueManager = MessageQueueManager.getOrCreateShared({
    sessionManager,
    orchestrator,
    modelRegistry,
    changesManager,
    permissionManager,
    toolManager,
    registry,
    mcpHost,
    ollama,
  });

  activeOrchestrator = orchestrator;
  activeOllamaClient = ollama;
  activeMcpHost = mcpHost;
  activePermissionManager = permissionManager;
  activeQueueManager = queueManager;

  // Ensure Main Agent exists without hardcoding unavailable models
  if (!registry.getMainAgent()) {
    registry.setMainAgent({
      id: 'main',
      name: 'Main Agent',
      role: 'Lead Architect & Autonomous Developer',
      model: '',
      systemPrompt: 'Lead autonomous developer and orchestrator. Directs implementation, creates files, writes code, and executes tests.',
      enabled: true,
      maxConcurrency: 1,
      temperature: 0.2,
      contextWindow: 32768,
    });
  }

  // Handle workspace folder changes dynamically
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const newRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (newRoot) {
        orchestrator.setWorkspace(newRoot);
        sessionManager.setWorkspace(newRoot);
        changesManager.setWorkspace(newRoot);
        permissionManager.setWorkspace(newRoot);
        mcpHost.setWorkspace(newRoot);
        queueManager.hydrateFromSessions();
      }
    })
  );

  // Auto-connect enabled MCP servers in background
  mcpHost.connectAllEnabled().catch((err) => {
    console.warn('[LocalCoders] MCP auto-connect warning:', err.message);
  });

  // Status Bar Indicator
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'localcoders.manageModels';
  statusBarItem.tooltip = 'LocalCoders Multi-Agent AI — Click to open Model & Provider Manager';
  statusBarItem.text = '$(hubot) LocalCoders';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const updateStatusBar = async () => {
    const statuses = await modelRegistry.getProviderStatuses(false);
    const ollamaStatus = statuses.find((s) => s.providerId === 'ollama');
    const available = await modelRegistry.getAvailableModels({ includeDisabled: false });
    const main = registry.getMainAgent();
    const activeSession = sessionManager.getActiveSession();
    const activeModel = activeSession?.config?.modelName || main?.model || available[0]?.displayName;

    if (available.length > 0 && activeModel) {
      statusBarItem.text = `$(pass) LocalCoders: ${activeModel}`;
    } else if (ollamaStatus && ollamaStatus.status !== 'connected') {
      statusBarItem.text = '$(warning) LocalCoders: Ollama Disconnected';
    } else {
      statusBarItem.text = '$(warning) LocalCoders: No Model Selected';
    }
  };

  // Auto-start local Ollama if configured & installed, then run initial discovery
  const autoStartOllama = config.get<boolean>('autoStartOllamaOnStartup', true);
  (async () => {
    if (autoStartOllama) {
      await ollama.ensureServerRunning().catch(() => {});
    }
    await modelRegistry.refreshAll(true);
    const main = registry.getMainAgent();
    if (main && !main.model) {
      const first = await modelRegistry.getDefaultOrFirstAvailableModel();
      if (first) {
        registry.setMainAgent({ ...main, model: first.id });
      }
    }
    await updateStatusBar();
    await AgentWorkspaceEditorPanel.currentPanel?.syncActiveSession();
  })().catch(() => {});

  modelRegistry.onDidChangeModels(() => {
    updateStatusBar().catch(() => {});
    AgentWorkspaceEditorPanel.currentPanel?.syncActiveSession().catch(() => {});
  });

  // 1. Register Webview Providers
  const navigationViewProvider = new NavigationViewProvider(context.extensionUri, sessionManager, ollama, modelRegistry);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(NavigationViewProvider.viewType, navigationViewProvider)
  );

  const chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    orchestrator,
    sessionManager,
    ollama,
    modelRegistry,
    permissionManager,
    toolManager,
    registry,
    mcpHost,
    changesManager,
    queueManager
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider)
  );

  const changesViewProvider = new ChangesViewProvider(context.extensionUri, changesManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChangesViewProvider.viewType, changesViewProvider)
  );

  const criticFindingsProvider = new CriticFindingsViewProvider(context.extensionUri, orchestrator);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CriticFindingsViewProvider.viewType, criticFindingsProvider)
  );

  const agentMonitorProvider = new AgentMonitorViewProvider(context.extensionUri, orchestrator, registry);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentMonitorViewProvider.viewType, agentMonitorProvider)
  );

  // 2. Register Tree Data Providers
  const agentTeamTreeProvider = new AgentTeamTreeProvider(registry);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('localcoders.agentTeamView', agentTeamTreeProvider)
  );

  const taskMonitorTreeProvider = new TaskMonitorTreeProvider(orchestrator);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('localcoders.taskMonitorView', taskMonitorTreeProvider)
  );

  const modelManagerTreeProvider = new ModelManagerTreeProvider(ollama, modelRegistry);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('localcoders.modelManagerView', modelManagerTreeProvider)
  );

  const criticReviewsTreeProvider = new CriticReviewsTreeProvider(orchestrator, registry);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('localcoders.criticReviewsView', criticReviewsTreeProvider)
  );

  const projectMemoryTreeProvider = new ProjectMemoryTreeProvider(workspaceRoot);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('localcoders.projectMemoryView', projectMemoryTreeProvider)
  );

  const mcpServersTreeProvider = new McpServersTreeProvider(mcpHost);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('localcoders.mcpServersView', mcpServersTreeProvider)
  );

  const securityPermissionsTreeProvider = new SecurityPermissionsTreeProvider(permissionManager);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('localcoders.securityPermissionsView', securityPermissionsTreeProvider)
  );

  // 3. Mode State & Commands
  AgentWorkspaceEditorPanel.configureServices(registry, mcpHost, queueManager);
  let currentMode: 'agent' | 'ide' = config.get<'agent' | 'ide'>('defaultView', 'agent') === 'ide' ? 'ide' : 'agent';
  let isEnforcingSingleAgentTab = false;

  const ensureAgentPanelOpen = () =>
    AgentWorkspaceEditorPanel.createOrShow(
      context.extensionUri,
      orchestrator,
      sessionManager,
      ollama,
      changesManager,
      modelRegistry,
      toolManager,
      permissionManager,
      queueManager
    );

  const enforceSingleAgentTab = async () => {
    if (currentMode !== 'agent' || isDeactivating || isEnforcingSingleAgentTab) {
      return;
    }
    isEnforcingSingleAgentTab = true;
    try {
      const hasPanel = Boolean(AgentWorkspaceEditorPanel.currentPanel);
      const { tabsToClose } = collectNonAgentTabsToClose(vscode.window.tabGroups.all);
      const hasMultipleGroups = vscode.window.tabGroups.all.length > 1;
      if (hasPanel && tabsToClose.length === 0 && !hasMultipleGroups) {
        return;
      }

      ensureAgentPanelOpen();
      const updated = collectNonAgentTabsToClose(vscode.window.tabGroups.all);
      if (updated.tabsToClose.length > 0) {
        await vscode.window.tabGroups.close(updated.tabsToClose, false).then(undefined, () => {});
      }
      if (vscode.window.tabGroups.all.length > 1) {
        await vscode.commands.executeCommand('workbench.action.joinAllGroups').then(undefined, () => {});
      }
      AgentWorkspaceEditorPanel.currentPanel?.syncActiveSession();
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => {});
      await vscode.commands.executeCommand('workbench.action.closeSidebar').then(undefined, () => {});
      await vscode.commands.executeCommand('workbench.action.closePanel').then(undefined, () => {});
    } catch (e) {
      console.warn('[LocalCoders] Agent Mode isolation warning:', e);
    } finally {
      isEnforcingSingleAgentTab = false;
    }
  };

  AgentWorkspaceEditorPanel.onDidDisposeUnexpected = () => {
    if (currentMode === 'agent' && !isDeactivating) {
      setTimeout(() => {
        if (currentMode === 'agent' && !isDeactivating) {
          void enforceSingleAgentTab();
        }
      }, 20);
    }
  };

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => {
      if (currentMode === 'agent' && !isDeactivating) {
        void enforceSingleAgentTab();
      }
    }),
    vscode.window.tabGroups.onDidChangeTabGroups(() => {
      if (currentMode === 'agent' && !isDeactivating) {
        void enforceSingleAgentTab();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (currentMode === 'agent' && !isDeactivating && editor) {
        void enforceSingleAgentTab();
      }
    }),
    vscode.commands.registerCommand('localcoders.activateAgentView', async () => {
      currentMode = 'agent';
      await vscode.commands.executeCommand('setContext', 'localcoders.inAgentMode', true).then(undefined, () => {});
      try {
        await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
        await vscode.commands.executeCommand('workbench.action.closePanel');
      } catch (e) {
        console.warn('[LocalCoders] Focus error:', e);
      }

      ensureAgentPanelOpen();
      await enforceSingleAgentTab();

      // Re-enforce closing sidebars & stray restored tabs in case workbench restoration re-opened them
      setTimeout(() => {
        if (currentMode === 'agent' && !isDeactivating) {
          void enforceSingleAgentTab();
        }
      }, 150);
    }),

    vscode.commands.registerCommand('localcoders.activateIDEView', async () => {
      currentMode = 'ide';
      await vscode.commands.executeCommand('setContext', 'localcoders.inAgentMode', false).then(undefined, () => {});
      try {
        // In IDE View: Unconditionally close the center Agent webview cockpit
        AgentWorkspaceEditorPanel.closeCurrent();

        // Show genuine VS Code Explorer on left and dock LocalCoders AI Chat on right
        await vscode.commands.executeCommand('workbench.view.explorer');
        await vscode.commands.executeCommand('localcoders.chatView.focus');

        // Reveal active or open code file if present
        const activeDoc = vscode.workspace.textDocuments.find(d => !d.isUntitled && !d.uri.scheme.includes('webview'));
        if (activeDoc) {
          await vscode.window.showTextDocument(activeDoc.uri, { preview: true, preserveFocus: true });
        }
      } catch (e) {
        console.warn('[LocalCoders] Focus error:', e);
      }
    }),

    vscode.commands.registerCommand('localcoders.toggleWorkbenchMode', async () => {
      if (currentMode === 'agent') {
        await vscode.commands.executeCommand('localcoders.activateIDEView');
      } else {
        await vscode.commands.executeCommand('localcoders.activateAgentView');
      }
    }),

    vscode.commands.registerCommand('localcoders.openComposer', async () => {
      if (currentMode === 'agent') {
        AgentWorkspaceEditorPanel.currentPanel?.focusPrompt();
      } else {
        await vscode.commands.executeCommand('localcoders.chatView.focus');
      }
    }),

    vscode.commands.registerCommand('localcoders.toggleAgentPanel', async () => {
      if (currentMode === 'agent') {
        await vscode.commands.executeCommand('localcoders.activateIDEView');
      } else {
        await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
      }
    }),

    vscode.commands.registerCommand('localcoders.openChat', async () => {
      if (currentMode === 'agent') {
        await vscode.commands.executeCommand('localcoders.activateAgentView');
      } else {
        await vscode.commands.executeCommand('localcoders.chatView.focus');
      }
    }),

    vscode.commands.registerCommand('localcoders.openChanges', () => {
      if (currentMode === 'agent') {
        AgentWorkspaceEditorPanel.currentPanel?.syncActiveSession();
      } else {
        vscode.commands.executeCommand('localcoders.changesView.focus');
      }
    }),

    vscode.commands.registerCommand('localcoders.newSession', async () => {
      const goal = await vscode.window.showInputBox({
        prompt: 'Enter a task or goal for the new AI coding session',
        placeHolder: 'e.g. Build a python clock application with tests',
      });
      if (goal) {
        const firstAvailable = await modelRegistry.getDefaultOrFirstAvailableModel();
        const model = firstAvailable?.id || '';
        sessionManager.createSession(goal, model, {
          providerId: firstAvailable?.providerId || 'ollama',
          modelId: model,
          modelName: firstAvailable?.displayName || '',
        });
        if (currentMode === 'agent') {
          AgentWorkspaceEditorPanel.currentPanel?.syncActiveSession();
        } else {
          vscode.commands.executeCommand('localcoders.chatView.focus');
        }
      }
    }),

    vscode.commands.registerCommand('localcoders.openSetupWizard', () => {
      if (currentMode === 'agent') {
        void ensureAgentPanelOpen().openCockpitModal('settings');
        return;
      }
      SetupWizardPanel.createOrShow(context.extensionUri, ollama, registry);
    }),

    vscode.commands.registerCommand('localcoders.newTask', async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: 'Enter a task for the LocalCoders multi-agent team',
        placeHolder: 'e.g. Implement user authentication with password hashing and tests',
      });
      if (prompt) {
        await queueManager.submitMessage({
          sessionId: sessionManager.getActiveSession()?.id,
          content: prompt,
        });
      }
    }),

    vscode.commands.registerCommand('localcoders.setDefaultStartupView', async () => {
      const config = vscode.workspace.getConfiguration('localcoders');
      const current = config.get<'agent' | 'ide'>('defaultView', 'agent');
      const picked = await vscode.window.showQuickPick(
        [
          {
            label: 'Agent View (Autonomous Cockpit)',
            description: current === 'agent' ? '(Current Default)' : '',
            detail: 'Agent-first 3-column Devin workspace with sessions sidebar, conversation stream, and live changes review.',
            value: 'agent' as const,
          },
          {
            label: 'IDE View (Classic Workbench)',
            description: current === 'ide' ? '(Current Default)' : '',
            detail: 'Traditional VS Code code editor, Explorer file tree, and docked AI Assistant in the secondary sidebar.',
            value: 'ide' as const,
          },
        ],
        { placeHolder: 'Select your preferred default startup screen for LocalCoders' }
      );
      if (picked) {
        await config.update('defaultView', picked.value, vscode.ConfigurationTarget.Global);
        const action = await vscode.window.showInformationMessage(
          `LocalCoders default startup screen is now set to ${picked.label}.`,
          'Switch Now'
        );
        if (action === 'Switch Now') {
          if (picked.value === 'ide') {
            await vscode.commands.executeCommand('localcoders.activateIDEView');
          } else {
            await vscode.commands.executeCommand('localcoders.activateAgentView');
          }
        }
      }
    }),

    vscode.commands.registerCommand('localcoders.selectMainAgent', async () => {
      const models = await modelRegistry.getAvailableModels({ includeDisabled: false, forceRefresh: true });
      if (models.length === 0) {
        const openMgr = await vscode.window.showWarningMessage(
          'No models discovered in Ollama or configured cloud providers.',
          'Open Model Manager'
        );
        if (openMgr === 'Open Model Manager') {
          vscode.commands.executeCommand('localcoders.manageModels');
        }
        return;
      }
      const selected = await vscode.window.showQuickPick(
        models.map((m) => ({
          label: m.displayName,
          description: `${m.providerName} | ${m.availability}`,
          modelId: m.id,
        })),
        { placeHolder: 'Select model for mandatory Main Agent' }
      );
      if (selected) {
        const current = registry.getMainAgent();
        registry.setMainAgent({
          id: 'main',
          name: 'Main Agent',
          role: 'Lead Architect',
          model: selected.modelId,
          systemPrompt: current?.systemPrompt || 'Lead coordinator and implementation planner.',
          enabled: true,
          maxConcurrency: 1,
          temperature: 0.2,
          contextWindow: 32768,
        });
        await modelRegistry.setDefaultModel(selected.modelId);
        agentTeamTreeProvider.refresh();
        vscode.window.showInformationMessage(`Main Agent model updated to '${selected.label}'`);
      }
    }),

    vscode.commands.registerCommand('localcoders.manageAgents', () => {
      vscode.commands.executeCommand('localcoders.openSetupWizard');
    }),

    vscode.commands.registerCommand('localcoders.manageModels', () => {
      if (currentMode === 'agent') {
        void ensureAgentPanelOpen().openCockpitModal('models');
        return;
      }
      ModelManagerPanel.createOrShow(context.extensionUri, modelRegistry, ollama, registry);
    }),

    vscode.commands.registerCommand('localcoders.enableCritic', async () => {
      const current = registry.getCriticConfig();
      const next = !current.enabled;
      registry.setCriticConfig({ enabled: next });
      agentTeamTreeProvider.refresh();
      vscode.window.showInformationMessage(`Critic Agent ${next ? 'enabled' : 'disabled'}`);
    }),

    vscode.commands.registerCommand('localcoders.reviewGitChanges', async () => {
      vscode.window.showInformationMessage('LocalCoders: Critic Agent is auditing current Git changes...');
      const criticConf = { ...registry.getCriticConfig() };
      const main = registry.getMainAgent();
      if (!criticConf.model && main) {
        criticConf.model = main.model;
      }
      const critic = new (await import('./agents/critic-agent')).CriticAgent(
        ollama,
        criticConf,
        new (await import('./context/memory-manager')).MemoryManager(workspaceRoot),
        toolManager,
        workspaceRoot,
        orchestrator.getLLMRouter()
      );

      await critic.review({
        userRequirements: 'Audit working tree git changes for defects, security vulnerabilities, and race conditions.',
      });

      if (currentMode !== 'agent') {
        vscode.commands.executeCommand('localcoders.criticFindingsPanel.focus');
      }
    }),

    vscode.commands.registerCommand('localcoders.reviewCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active editor tab to review.');
        return;
      }

      const fileRel = path.relative(workspaceRoot, editor.document.uri.fsPath);
      vscode.window.showInformationMessage(`LocalCoders: Critic auditing '${fileRel}'...`);
      await queueManager.submitMessage({
        sessionId: sessionManager.getActiveSession()?.id,
        content: `Review and audit file '${fileRel}' for edge cases, bugs, and security weaknesses.`,
        attachments: [editor.document.uri.fsPath],
      });
    }),

    vscode.commands.registerCommand('localcoders.explainSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('Please select code to explain.');
        return;
      }
      const text = editor.document.getText(editor.selection);
      await queueManager.submitMessage({
        sessionId: sessionManager.getActiveSession()?.id,
        content: `Explain this code snippet:\n\`\`\`\n${text}\n\`\`\``,
        attachments: [editor.document.uri.fsPath],
      });
    }),

    vscode.commands.registerCommand('localcoders.refactorSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('Please select code to refactor.');
        return;
      }
      const text = editor.document.getText(editor.selection);
      const fileRel = path.relative(workspaceRoot, editor.document.uri.fsPath);
      await queueManager.submitMessage({
        sessionId: sessionManager.getActiveSession()?.id,
        content: `Refactor the following code in '${fileRel}' to improve readability and eliminate code smells while preserving behavior:\n\`\`\`\n${text}\n\`\`\``,
        attachments: [editor.document.uri.fsPath],
      });
    }),

    vscode.commands.registerCommand('localcoders.generateTests', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('Please select code to generate unit tests for.');
        return;
      }
      const text = editor.document.getText(editor.selection);
      const fileRel = path.relative(workspaceRoot, editor.document.uri.fsPath);
      await queueManager.submitMessage({
        sessionId: sessionManager.getActiveSession()?.id,
        content: `Generate comprehensive unit tests covering edge cases and boundary conditions for this code in '${fileRel}':\n\`\`\`\n${text}\n\`\`\``,
        attachments: [editor.document.uri.fsPath],
      });
    }),

    vscode.commands.registerCommand('localcoders.stopAllAgents', () => {
      queueManager.cancelActiveTask();
      orchestrator.cancelTask();
      vscode.window.showInformationMessage('LocalCoders: All running agent executions stopped.');
    }),

    vscode.commands.registerCommand('localcoders.setSecurityMode', async () => {
      const modes: Array<{ label: string; mode: SecurityMode; description: string }> = [
        { label: 'Supervised', mode: 'supervised', description: 'Auto-read files; ask before writing, executing, or network calls' },
        { label: 'Autonomous', mode: 'autonomous', description: 'Auto-execute tasks; ask only before destructive file/git/system actions' },
        { label: 'Ask Every Time', mode: 'ask_every_time', description: 'Prompt for approval before every single tool action' },
        { label: 'Restricted', mode: 'restricted', description: 'Read-only sandbox; block all modifications and executions' },
      ];
      const picked = await vscode.window.showQuickPick(modes, { placeHolder: 'Select Central Security Mode' });
      if (picked) {
        permissionManager.setMode(picked.mode);
        securityPermissionsTreeProvider.refresh();
        vscode.window.showInformationMessage(`LocalCoders: Security mode set to '${picked.label}'`);
      }
    }),

    vscode.commands.registerCommand('localcoders.addMcpServer', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Enter MCP Server Name',
        placeHolder: 'e.g. SQLite Explorer or Brave Search',
      });
      if (!name) return;

      const transport = await vscode.window.showQuickPick(['stdio', 'sse'], {
        placeHolder: 'Select MCP Transport Protocol',
      });
      if (!transport) return;

      const id = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

      if (transport === 'stdio') {
        const cmd = await vscode.window.showInputBox({
          prompt: 'Enter CLI command for MCP server',
          placeHolder: 'e.g. npx -y @modelcontextprotocol/server-sqlite or python3 -m my_mcp',
        });
        if (!cmd) return;
        const parts = cmd.split(' ');
        await mcpHost.addServer({
          id,
          name,
          transport: 'stdio',
          command: parts[0],
          args: parts.slice(1),
          enabled: true,
        });
      } else {
        const url = await vscode.window.showInputBox({
          prompt: 'Enter MCP SSE Server URL',
          placeHolder: 'http://localhost:3000/sse',
        });
        if (!url) return;
        await mcpHost.addServer({
          id,
          name,
          transport: 'sse',
          url,
          enabled: true,
        });
      }

      mcpServersTreeProvider.refresh();
      vscode.window.showInformationMessage(`LocalCoders: MCP Server '${name}' added and connected.`);
    }),

    vscode.commands.registerCommand('localcoders.removeMcpServer', async () => {
      const servers = mcpHost.getAllServers();
      if (servers.length === 0) {
        vscode.window.showInformationMessage('No MCP servers configured.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        servers.map((s) => ({ label: s.config.name, id: s.config.id })),
        { placeHolder: 'Select MCP Server to remove' }
      );
      if (picked) {
        await mcpHost.removeServer(picked.id);
        mcpServersTreeProvider.refresh();
        vscode.window.showInformationMessage(`Removed MCP server '${picked.label}'`);
      }
    })
  );

  // Launch into preferred startup screen on startup (Agent View by default, or IDE View if configured)
  const launchPreferredView = () => {
    const config = vscode.workspace.getConfiguration('localcoders');
    const defaultView = config.get<'agent' | 'ide'>('defaultView', 'agent');
    if (defaultView === 'ide') {
      vscode.commands.executeCommand('localcoders.activateIDEView').then(undefined, (err) => {
        console.warn('[LocalCoders] Auto-launch IDE View warning:', err);
      });
    } else {
      vscode.commands.executeCommand('localcoders.activateAgentView').then(undefined, (err) => {
        console.warn('[LocalCoders] Auto-launch Agents View warning:', err);
      });
    }
  };

  launchPreferredView();
  setTimeout(launchPreferredView, 250);
  setTimeout(launchPreferredView, 700);

  console.log('[LocalCoders] Multi-Agent AI Core successfully activated.');
}

export async function deactivate(): Promise<void> {
  isDeactivating = true;
  console.log('[LocalCoders] Closing IDE: Stopping active tasks, unloading Ollama models, stopping local Ollama server, and freeing GPU/RAM...');
  try {
    if (activeQueueManager) {
      activeQueueManager.cancelActiveTask();
    }
    if (activeOrchestrator) {
      activeOrchestrator.cancelTask();
    }
    ProcessManager.getInstance().terminateAll();
    TerminalSessionManager.getInstance().terminateAll();
    if (activeMcpHost) {
      await Promise.race([
        activeMcpHost.disconnectAll().catch(() => {}),
        new Promise((r) => setTimeout(r, 1200)),
      ]);
    }
    if (activeOllamaClient) {
      const stopOnExit = vscode.workspace.getConfiguration('localcoders').get<boolean>('stopOllamaOnExit', true);
      await Promise.race([
        activeOllamaClient.stopServerAndModels({ stopServer: stopOnExit }),
        new Promise((r) => setTimeout(r, 3800)),
      ]);
    }
    await Promise.race([
      BrowserManager.getInstance().close().catch(() => {}),
      new Promise((r) => setTimeout(r, 800)),
    ]);
  } catch (err: any) {
    console.warn('[LocalCoders] Warning during deactivation cleanup:', err.message);
  }
  console.log('[LocalCoders] Deactivation and cleanup complete.');
}
