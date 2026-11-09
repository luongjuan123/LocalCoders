import * as vscode from 'vscode';
import * as path from 'path';
import { OllamaClient } from './ollama/client';
import { AgentRegistry } from './agents/agent-registry';
import { ToolManager } from './tools/tool-manager';
import { AgentOrchestrator } from './agents/orchestrator';
import { SessionManager } from './sessions/session-manager';
import { ChangesManager } from './context/changes-manager';
import { SetupWizardPanel } from './views/wizard-view';
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
} from './views/tree-views';

let activeOrchestrator: AgentOrchestrator | null = null;
let activeOllamaClient: OllamaClient | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log('[LocalCoders] Initializing Multi-Agent AI Core...');

  const config = vscode.workspace.getConfiguration('localcoders');
  const ollamaHost = config.get<string>('ollamaHost') || 'http://127.0.0.1:11434';
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

  // Initialize Core Services
  const ollama = new OllamaClient(ollamaHost);
  const registry = new AgentRegistry(context);
  const toolManager = new ToolManager();
  const orchestrator = new AgentOrchestrator(ollama, registry, toolManager, workspaceRoot);
  const sessionManager = new SessionManager(context, workspaceRoot);
  const changesManager = new ChangesManager(workspaceRoot);

  activeOrchestrator = orchestrator;
  activeOllamaClient = ollama;

  // Status Bar Indicator
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'localcoders.openChat';
  statusBarItem.tooltip = 'LocalCoders Multi-Agent AI Status';
  statusBarItem.text = '$(hubot) LocalCoders';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Update status bar with Ollama connection
  ollama.checkConnection().then((conn) => {
    if (conn.connected) {
      const main = registry.getMainAgent();
      statusBarItem.text = `$(pass) LocalCoders: ${main ? main.model : 'Ready'}`;
    } else {
      statusBarItem.text = '$(warning) LocalCoders: Ollama Disconnected';
    }
  });

  // 1. Register Webview Providers
  const navigationViewProvider = new NavigationViewProvider(context.extensionUri, sessionManager, ollama);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(NavigationViewProvider.viewType, navigationViewProvider)
  );

  const chatViewProvider = new ChatViewProvider(context.extensionUri, orchestrator, sessionManager, ollama);
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

  const modelManagerTreeProvider = new ModelManagerTreeProvider(ollama);
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

  // 3. Mode State & Commands
  let currentMode: 'agent' | 'ide' = 'agent';

  context.subscriptions.push(
    vscode.commands.registerCommand('localcoders.activateAgentView', async () => {
      currentMode = 'agent';
      AgentWorkspaceEditorPanel.createOrShow(context.extensionUri, orchestrator, sessionManager, ollama);
      try {
        await vscode.commands.executeCommand('localcoders.navigationView.focus');
        await vscode.commands.executeCommand('localcoders.changesView.focus');
      } catch (e) {
        console.warn('[LocalCoders] Focus error:', e);
      }
    }),

    vscode.commands.registerCommand('localcoders.activateIDEView', async () => {
      currentMode = 'ide';
      AgentWorkspaceEditorPanel.closeCurrent();
      try {
        await vscode.commands.executeCommand('workbench.view.explorer');
        await vscode.commands.executeCommand('localcoders.chatView.focus');
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

    vscode.commands.registerCommand('localcoders.openChat', () => {
      vscode.commands.executeCommand('localcoders.chatView.focus');
    }),

    vscode.commands.registerCommand('localcoders.openChanges', () => {
      vscode.commands.executeCommand('localcoders.changesView.focus');
    }),

    vscode.commands.registerCommand('localcoders.newSession', async () => {
      const goal = await vscode.window.showInputBox({
        prompt: 'Enter a task or goal for the new AI coding session',
        placeHolder: 'e.g. Build a python clock application with tests',
      });
      if (goal) {
        const models = await ollama.listModels();
        const model = models[0]?.name || 'qwen3.8:27b';
        sessionManager.createSession(goal, model);
        vscode.commands.executeCommand('localcoders.chatView.focus');
      }
    }),

    vscode.commands.registerCommand('localcoders.openSetupWizard', () => {
      SetupWizardPanel.createOrShow(context.extensionUri, ollama, registry);
    }),

    vscode.commands.registerCommand('localcoders.newTask', async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: 'Enter a task for the LocalCoders multi-agent team',
        placeHolder: 'e.g. Implement user authentication with password hashing and tests',
      });
      if (prompt) {
        orchestrator.submitTask(prompt);
      }
    }),

    vscode.commands.registerCommand('localcoders.selectMainAgent', async () => {
      const models = await ollama.listModels();
      if (models.length === 0) {
        vscode.window.showWarningMessage('No Ollama models found.');
        return;
      }
      const selected = await vscode.window.showQuickPick(
        models.map((m) => ({ label: m.name, description: m.details?.parameter_size })),
        { placeHolder: 'Select model for mandatory Main Agent' }
      );
      if (selected) {
        const current = registry.getMainAgent();
        registry.setMainAgent({
          id: 'main',
          name: 'Main Agent',
          role: 'Lead Architect',
          model: selected.label,
          systemPrompt: current?.systemPrompt || 'Lead coordinator and implementation planner.',
          enabled: true,
          maxConcurrency: 1,
          temperature: 0.2,
          contextWindow: 32768,
        });
        agentTeamTreeProvider.refresh();
        vscode.window.showInformationMessage(`Main Agent model updated to '${selected.label}'`);
      }
    }),

    vscode.commands.registerCommand('localcoders.manageAgents', () => {
      vscode.commands.executeCommand('localcoders.openSetupWizard');
    }),

    vscode.commands.registerCommand('localcoders.manageModels', () => {
      vscode.commands.executeCommand('localcoders.openSetupWizard');
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
      const criticConf = registry.getCriticConfig();
      const main = registry.getMainAgent();
      if (!criticConf.model && main) {
        criticConf.model = main.model;
      }
      const critic = new (await import('./agents/critic-agent')).CriticAgent(
        ollama,
        criticConf,
        new (await import('./context/memory-manager')).MemoryManager(workspaceRoot),
        toolManager,
        workspaceRoot
      );

      const report = await critic.review({
        userRequirements: 'Audit working tree git changes for defects, security vulnerabilities, and race conditions.',
      });

      vscode.commands.executeCommand('localcoders.criticFindingsPanel.focus');
    }),

    vscode.commands.registerCommand('localcoders.reviewCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active editor tab to review.');
        return;
      }

      const fileRel = path.relative(workspaceRoot, editor.document.uri.fsPath);
      vscode.window.showInformationMessage(`LocalCoders: Critic auditing '${fileRel}'...`);
      await orchestrator.submitTask(`Review and audit file '${fileRel}' for edge cases, bugs, and security weaknesses.`);
    }),

    vscode.commands.registerCommand('localcoders.explainSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('Please select code to explain.');
        return;
      }
      const text = editor.document.getText(editor.selection);
      await orchestrator.submitTask(`Explain this code snippet:\n\`\`\`\n${text}\n\`\`\``);
    }),

    vscode.commands.registerCommand('localcoders.refactorSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('Please select code to refactor.');
        return;
      }
      const text = editor.document.getText(editor.selection);
      const fileRel = path.relative(workspaceRoot, editor.document.uri.fsPath);
      await orchestrator.submitTask(
        `Refactor the following code in '${fileRel}' to improve readability and eliminate code smells while preserving behavior:\n\`\`\`\n${text}\n\`\`\``
      );
    }),

    vscode.commands.registerCommand('localcoders.generateTests', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('Please select code to generate unit tests for.');
        return;
      }
      const text = editor.document.getText(editor.selection);
      const fileRel = path.relative(workspaceRoot, editor.document.uri.fsPath);
      await orchestrator.submitTask(
        `Generate comprehensive unit tests covering edge cases and boundary conditions for this code in '${fileRel}':\n\`\`\`\n${text}\n\`\`\``
      );
    }),

    vscode.commands.registerCommand('localcoders.stopAllAgents', () => {
      orchestrator.cancelTask();
      vscode.window.showInformationMessage('LocalCoders: All running agent executions stopped.');
    })
  );

  console.log('[LocalCoders] Multi-Agent AI Core successfully activated.');
}

export async function deactivate(): Promise<void> {
  console.log('[LocalCoders] Closing IDE: Cancelling active agent tasks and releasing Ollama models from memory/VRAM...');
  try {
    if (activeOrchestrator) {
      activeOrchestrator.cancelTask();
    }
    if (activeOllamaClient) {
      await activeOllamaClient.unloadAllModels();
    }
  } catch (err: any) {
    console.warn('[LocalCoders] Warning during deactivation cleanup:', err.message);
  }
  console.log('[LocalCoders] Deactivation and cleanup complete.');
}
