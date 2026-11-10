import * as vscode from 'vscode';
import * as path from 'path';
import { AgentOrchestrator } from '../agents/orchestrator';
import { AgentMessage, TaskPlanItem, ToolApprovalRequest } from '../agents/types';
import { SessionManager, SessionData, ExecutionGroup, AgentSessionConfig, ExecutionMode, PermissionMode } from '../sessions/session-manager';
import { OllamaClient } from '../ollama/client';
import { ChangesManager, ChangesSummary } from '../context/changes-manager';
import { ModelProviderRegistry, ModelMetadata, ReasoningEffort } from '../models/model-provider-registry';
import { ToolManager } from '../tools/tool-manager';
import { PermissionManager, SecurityMode } from '../security/permission-manager';

export class AgentWorkspaceEditorPanel {
  public static currentPanel: AgentWorkspaceEditorPanel | undefined;
  public static readonly viewType = 'localcoders.agentWorkspace';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(
    extensionUri: vscode.Uri,
    orchestrator: AgentOrchestrator,
    sessionManager: SessionManager,
    ollama: OllamaClient,
    changesManager: ChangesManager,
    modelRegistry?: ModelProviderRegistry,
    toolManager?: ToolManager,
    permissionManager?: PermissionManager
  ): AgentWorkspaceEditorPanel {
    const column = vscode.ViewColumn.One;

    if (AgentWorkspaceEditorPanel.currentPanel) {
      AgentWorkspaceEditorPanel.currentPanel._panel.reveal(column);
      AgentWorkspaceEditorPanel.currentPanel.syncActiveSession();
      return AgentWorkspaceEditorPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      AgentWorkspaceEditorPanel.viewType,
      'LocalCoders Agent Workspace',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    AgentWorkspaceEditorPanel.currentPanel = new AgentWorkspaceEditorPanel(
      panel,
      extensionUri,
      orchestrator,
      sessionManager,
      ollama,
      changesManager,
      modelRegistry,
      toolManager,
      permissionManager
    );
    return AgentWorkspaceEditorPanel.currentPanel;
  }

  public static closeCurrent(): void {
    if (AgentWorkspaceEditorPanel.currentPanel) {
      AgentWorkspaceEditorPanel.currentPanel._panel.dispose();
      AgentWorkspaceEditorPanel.currentPanel = undefined;
    }
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly orchestrator: AgentOrchestrator,
    private readonly sessionManager: SessionManager,
    private readonly ollama: OllamaClient,
    private readonly changesManager: ChangesManager,
    private readonly modelRegistry: ModelProviderRegistry = ModelProviderRegistry.getInstance(),
    private readonly toolManager?: ToolManager,
    private readonly permissionManager?: PermissionManager
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'resources', 'icon.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'resources', 'icon.svg'),
    };

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.onDidChangeViewState(
      () => {
        if (this._panel.visible) {
          this.syncActiveSession();
        }
      },
      null,
      this._disposables
    );

    // Event connections
    this.orchestrator.onMessage((msg) => {
      this._panel.webview.postMessage({ type: 'addMessage', message: msg });
      this.sessionManager.updateActiveSession((s) => {
        s.messages.push(msg);
      });
      this.updateTitle();
    });

    this.orchestrator.onActivity((ev) => {
      this.sessionManager.updateActiveSession((s) => {
        if (!s.executionGroups) s.executionGroups = [];
        let currentGroup = s.executionGroups[s.executionGroups.length - 1];
        if (!currentGroup || currentGroup.status === 'completed') {
          currentGroup = {
            id: `eg_${Date.now()}`,
            agentId: ev.agentId || 'main',
            agentName: ev.agentName || 'Main Agent',
            title: `Worked on task`,
            durationMs: 0,
            status: 'working',
            details: [],
            startedAt: Date.now()
          };
          s.executionGroups.push(currentGroup);
        }
        currentGroup.details.push(ev.latestActivity || ev.currentTool || 'activity');
        currentGroup.durationMs = Math.max(1000, Date.now() - currentGroup.startedAt);
      });
      this._panel.webview.postMessage({ type: 'activity', event: ev });
    });

    this.orchestrator.onPlanUpdate((plan) => {
      this._panel.webview.postMessage({ type: 'planUpdate', plan });
      this.sessionManager.updateActiveSession((s) => {
        s.plan = plan;
      });
    });

    this.orchestrator.onApproval((req) => {
      this._panel.webview.postMessage({ type: 'approvalRequest', request: req });
    });

    // Session manager events
    this.sessionManager.onDidChangeSessions(() => {
      this.syncActiveSession();
      this.updateTitle();
    });

    // Changes manager events
    this.changesManager.onDidChangeChanges((summary) => {
      this._panel.webview.postMessage({ type: 'changesSummary', summary });
    });

    this._panel.webview.onDidReceiveMessage(
      async (data) => {
        switch (data.command) {
          case 'sendMessage': {
            const text = data.text?.trim();
            if (!text) return;

            let active = this.sessionManager.getActiveSession();
            if (!active) {
              const models = await this.ollama.listModels();
              const model = models[0]?.name || 'qwen3.8:27b';
              active = this.sessionManager.createSession(text, model);
            } else if (active.title === 'New Session' || active.title === 'New Section') {
              const newTitle = text.length > 36 ? text.substring(0, 36).trim() + '...' : text;
              this.sessionManager.renameSession(active.id, newTitle);
            }

            const userMsg: AgentMessage = {
              id: `usr_${Date.now()}`,
              senderId: 'user',
              senderName: 'You',
              senderRole: 'user',
              content: text,
              timestamp: Date.now(),
            };

            this.sessionManager.updateActiveSession((s) => {
              s.messages.push(userMsg);
              s.status = 'running';
            });
            this._panel.webview.postMessage({ type: 'addMessage', message: userMsg });
            this.updateTitle();

            try {
              const currentSession = this.sessionManager.getActiveSession();
              const history = currentSession?.messages ? currentSession.messages.map((m) => ({ role: m.senderRole, content: m.content })) : [];
              await this.orchestrator.submitTask(text, currentSession?.config, history);
              this.sessionManager.updateActiveSession((s) => {
                s.status = 'completed';
                if (s.executionGroups && s.executionGroups.length > 0) {
                  const last = s.executionGroups[s.executionGroups.length - 1];
                  if (last.status === 'working') {
                    last.status = 'completed';
                    last.completedAt = Date.now();
                    last.durationMs = Math.max(1000, last.completedAt - last.startedAt);
                  }
                }
              });
            } catch (err: any) {
              this.sessionManager.updateActiveSession((s) => {
                s.status = 'failed';
                if (s.executionGroups && s.executionGroups.length > 0) {
                  const last = s.executionGroups[s.executionGroups.length - 1];
                  if (last.status === 'working') {
                    last.status = 'failed';
                    last.completedAt = Date.now();
                    last.durationMs = Math.max(1000, last.completedAt - last.startedAt);
                  }
                }
              });
              vscode.window.showErrorMessage(`Agent task failed: ${err.message}`);
            }
            this.syncActiveSession();
            break;
          }

          case 'stopTask':
            this.orchestrator.cancelTask();
            this.sessionManager.updateActiveSession((s) => {
              s.status = 'idle';
            });
            this.syncActiveSession();
            break;

          case 'resolveApproval':
          case 'approveTool':
            this.orchestrator.resolveApproval(data.requestId, data.approved !== undefined ? data.approved : true);
            break;

          case 'rejectTool':
            this.orchestrator.resolveApproval(data.requestId, false);
            break;

          case 'switchSession':
            this.sessionManager.switchSession(data.sessionId);
            this.syncActiveSession();
            break;

          case 'newSession':
          case 'newSection': {
            const models = await this.ollama.listModels();
            const model = models[0]?.name || 'qwen3.8:27b';
            this.sessionManager.createSession('New Session', model);
            this.syncActiveSession();
            break;
          }

          case 'renameSession': {
            const s = this.sessionManager.getSession(data.sessionId);
            const newTitle = await vscode.window.showInputBox({
              prompt: 'Rename session',
              value: s?.title || '',
            });
            if (newTitle) {
              this.sessionManager.renameSession(data.sessionId, newTitle);
              this.syncActiveSession();
            }
            break;
          }

          case 'deleteSession': {
            const confirm = await vscode.window.showWarningMessage(
              'Delete this coding session?',
              { modal: true },
              'Delete'
            );
            if (confirm === 'Delete') {
              this.sessionManager.deleteSession(data.sessionId);
              this.syncActiveSession();
            }
            break;
          }

          case 'selectModel': {
            const modelId = data.modelId;
            if (!modelId) {
              const models = await this.modelRegistry.getAvailableModels();
              const picked = await vscode.window.showQuickPick(
                models.map(m => ({ label: m.name, description: m.providerName + ' • ' + (m.contextWindowLabel || ''), id: m.id, provider: m.provider })),
                { placeHolder: 'Select model for coding agent' }
              );
              if (picked) {
                this.sessionManager.updateActiveConfig((cfg) => {
                  cfg.modelId = picked.id;
                  cfg.modelName = picked.label;
                  cfg.providerId = picked.provider;
                });
                await this.modelRegistry.recordModelUsage(picked.id);
                this.syncActiveSession();
              }
              return;
            }
            const model = await this.modelRegistry.getModelById(modelId);
            this.sessionManager.updateActiveConfig((cfg) => {
              cfg.modelId = modelId;
              cfg.modelName = model?.name || data.modelName || modelId;
              if (model?.provider || data.provider) cfg.providerId = model?.provider || data.provider;
            });
            await this.modelRegistry.recordModelUsage(modelId);
            this.syncActiveSession();
            break;
          }

          case 'setReasoningEffort': {
            if (data.effort) {
              this.sessionManager.updateActiveConfig((cfg) => {
                cfg.reasoningEffort = data.effort;
              });
              this.syncActiveSession();
            }
            break;
          }

          case 'setFastMode': {
            this.sessionManager.updateActiveConfig((cfg) => {
              cfg.fastMode = !!data.fastMode;
            });
            this.syncActiveSession();
            break;
          }

          case 'setExecutionMode': {
            if (data.executionMode) {
              this.sessionManager.updateActiveConfig((cfg) => {
                cfg.executionMode = data.executionMode;
              });
              this.syncActiveSession();
            }
            break;
          }

          case 'setPermissionMode': {
            if (data.permissionMode) {
              this.sessionManager.updateActiveConfig((cfg) => {
                cfg.permissionMode = data.permissionMode;
              });
              if (this.permissionManager) {
                this.permissionManager.setMode(data.permissionMode);
              }
              this.syncActiveSession();
            }
            break;
          }

          case 'toggleFavorite': {
            if (data.modelId) {
              await this.modelRegistry.toggleFavorite(data.modelId);
              this.syncActiveSession();
            }
            break;
          }

          case 'searchModels': {
            const query = data.query || '';
            const modelsGrouped = await this.modelRegistry.getGroupedModels(query);
            this._panel.webview.postMessage({
              type: 'modelsGroupedResponse',
              modelsGrouped,
              query,
            });
            break;
          }

          case 'attachFiles': {
            const files = await vscode.window.showOpenDialog({
              canSelectFiles: true,
              canSelectFolders: false,
              canSelectMany: true,
              openLabel: 'Attach to Agent Context',
            });
            if (files && files.length > 0) {
              for (const f of files) {
                this.sessionManager.attachFileToActiveSession(f.fsPath);
              }
              this.syncActiveSession();
            }
            break;
          }

          case 'quickFile': {
            const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 50);
            if (files.length === 0) {
              vscode.window.showInformationMessage('No files found in workspace.');
              return;
            }
            const picked = await vscode.window.showQuickPick(
              files.map((f) => ({
                label: path.basename(f.fsPath),
                description: vscode.workspace.asRelativePath(f.fsPath),
                fsPath: f.fsPath,
              })),
              { placeHolder: 'Select file to attach to agent context' }
            );
            if (picked) {
              this.sessionManager.attachFileToActiveSession(picked.fsPath);
              this.syncActiveSession();
            }
            break;
          }

          case 'quickDirectory': {
            const folders = await vscode.window.showOpenDialog({
              canSelectFiles: false,
              canSelectFolders: true,
              canSelectMany: false,
              openLabel: 'Attach Directory to Agent',
            });
            if (folders && folders.length > 0) {
              this.sessionManager.attachFileToActiveSession(folders[0].fsPath);
              this.syncActiveSession();
            }
            break;
          }

          case 'attachGit': {
            this.sessionManager.attachFileToActiveSession('git:changes');
            this.syncActiveSession();
            vscode.window.showInformationMessage('Attached active Git status & changes to agent context.');
            break;
          }

          case 'attachTerminal': {
            this.sessionManager.attachFileToActiveSession('terminal:output');
            this.syncActiveSession();
            vscode.window.showInformationMessage('Attached recent terminal output to agent context.');
            break;
          }

          case 'attachCodemap': {
            this.sessionManager.attachFileToActiveSession('codemap:workspace');
            this.syncActiveSession();
            vscode.window.showInformationMessage('Attached codebase structure map to agent context.');
            break;
          }

          case 'removeAttachment': {
            if (data.filePath) {
              this.sessionManager.removeAttachmentFromActiveSession(data.filePath);
              this.syncActiveSession();
            }
            break;
          }

          case 'openRules': {
            const rulesPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.localcoders', 'rules.md');
            try {
              const doc = await vscode.workspace.openTextDocument(rulesPath);
              await vscode.window.showTextDocument(doc);
            } catch {
              vscode.commands.executeCommand('localcoders.projectMemoryView.focus');
            }
            break;
          }

          case 'openSkills': {
            vscode.commands.executeCommand('localcoders.agentTeamView.focus');
            break;
          }

          case 'getFileDiff': {
            const diff = await this.changesManager.getFileDiff(data.path);
            this._panel.webview.postMessage({
              type: 'fileDiffResponse',
              path: data.path,
              diff,
            });
            break;
          }

          case 'openDiff':
            await this.changesManager.openDiff(data.path);
            break;

          case 'acceptAll':
            await this.changesManager.acceptAll();
            break;

          case 'rejectAll':
            await this.changesManager.rejectAll();
            break;

          case 'acceptFile':
            await this.changesManager.acceptFile(data.path);
            break;

          case 'rejectFile':
            await this.changesManager.rejectFile(data.path);
            break;

          case 'reviewCritic':
            vscode.commands.executeCommand('localcoders.reviewGitChanges');
            break;

          case 'switchToIde':
            vscode.commands.executeCommand('localcoders.activateIDEView');
            break;

          case 'openSecurity':
            vscode.commands.executeCommand('localcoders.securityPermissionsView.focus');
            break;

          case 'openReview':
            vscode.commands.executeCommand('localcoders.criticReviewsView.focus');
            break;

          case 'openWiki':
            vscode.commands.executeCommand('localcoders.projectMemoryView.focus');
            break;

          case 'openAgents':
            vscode.commands.executeCommand('localcoders.agentTeamView.focus');
            break;

          case 'openMcp':
            vscode.commands.executeCommand('localcoders.mcpServersView.focus');
            break;
        }
      },
      null,
      this._disposables
    );

    this.syncActiveSession();
  }

  public updateTitle(): void {
    const active = this.sessionManager.getActiveSession();
    if (active) {
      this._panel.title = `💬 ${active.title}`;
    } else {
      this._panel.title = 'Agent Workspace';
    }
  }

  public async syncActiveSession(): Promise<void> {
    if (!this._panel) return;
    const session = this.sessionManager.getActiveSession();
    const allSessions = this.sessionManager.getAllSessions();
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name || 'LocalCoders';
    const changesSummary = await this.changesManager.getSummary();

    let modelsGrouped: Record<string, ModelMetadata[]> = {};
    let allModels: ModelMetadata[] = [];
    try {
      modelsGrouped = await this.modelRegistry.getGroupedModels();
      allModels = await this.modelRegistry.getAvailableModels();
    } catch (e) {
      console.warn('[AgentWorkspace] Error loading models:', e);
    }

    const currentConfig = session?.config || {
      providerId: 'ollama',
      modelId: session?.model || 'qwen3.8:27b',
      reasoningEffort: 'medium',
      fastMode: false,
      executionMode: 'code',
      permissionMode: 'smart',
      attachedFiles: [],
      projectContext: [],
    };
    const permissionMode = this.permissionManager?.getMode() || currentConfig.permissionMode || 'smart';

    this._panel.webview.postMessage({
      type: 'loadSession',
      session,
      allSessions,
      workspaceName,
      changesSummary,
      modelsGrouped,
      allModels,
      currentConfig,
      permissionMode,
    });
    this.updateTitle();
  }

  public focusPrompt(): void {
    this._panel.webview.postMessage({ type: 'focusPrompt' });
  }

  public dispose(): void {
    AgentWorkspaceEditorPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }

  private _update() {
    this._panel.webview.html = this._getHtmlForWebview();
  }

  private _getHtmlForWebview(): string {
    const username = process.env.USER || process.env.USERNAME || 'local';
    const avatarInitials = username.substring(0, 2).toLowerCase();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LocalCoders Agent Workspace</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #121214);
      --fg: var(--vscode-editor-foreground, #ececec);
      --card-bg: var(--vscode-sideBar-background, #18181b);
      --card-border: rgba(255, 255, 255, 0.08);
      --border: var(--vscode-widget-border, #27272a);
      --hover-bg: rgba(255, 255, 255, 0.06);
      --input-bg: rgba(24, 24, 27, 0.95);
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.25);
      --success: #22c55e;
      --danger: #ef4444;
      --warning: #f59e0b;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
      font-size: 13.5px;
      line-height: 1.6;
      height: 100vh;
      overflow: hidden;
      user-select: text;
    }

    /* Devin 3-Column Workspace Layout */
    .devin-workspace-layout {
      display: flex;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
    }

    /* 1. LEFT SESSIONS SIDEBAR */
    .devin-sidebar {
      width: 250px;
      min-width: 200px;
      max-width: 320px;
      background: var(--card-bg);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      overflow: hidden;
      transition: width 0.2s ease, opacity 0.2s ease;
      z-index: 20;
    }
    .devin-sidebar.hidden {
      width: 0;
      min-width: 0;
      border-right: none;
      opacity: 0;
      pointer-events: none;
    }
    .user-profile-header {
      padding: 12px 14px;
      display: flex;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid var(--border);
    }
    .user-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #22c55e;
      color: #052e16;
      font-weight: 700;
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      text-transform: lowercase;
    }
    .user-meta {
      flex: 1;
      overflow: hidden;
    }
    .user-header-icons {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .user-name {
      font-size: 13px;
      font-weight: 600;
      color: #f1f5f9;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .user-role {
      font-size: 11px;
      color: var(--text-muted);
    }
    .btn-new-session {
      margin: 12px 14px;
      padding: 8px 12px;
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.35);
      border-radius: 6px;
      color: var(--accent);
      font-weight: 600;
      font-size: 12.5px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .btn-new-session:hover {
      background: rgba(56, 189, 248, 0.22);
      border-color: rgba(56, 189, 248, 0.6);
      color: #ffffff;
    }
    .devin-nav {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 0 8px 12px 8px;
      border-bottom: 1px solid var(--border);
    }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 6px;
      color: #cbd5e1;
      font-size: 12.5px;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .nav-item:hover {
      background: var(--hover-bg);
      color: #ffffff;
    }
    .session-search-box {
      padding: 6px 12px 2px 12px;
    }
    .session-search-input {
      width: 100%;
      height: 26px;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--fg);
      padding: 0 8px;
      font-size: 11.5px;
      outline: none;
      box-sizing: border-box;
    }
    .session-search-input:focus {
      border-color: var(--accent);
    }
    .composer-modes-row {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 6px;
    }
    .mode-tab {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-muted);
      padding: 2px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .mode-tab:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.05);
    }
    .mode-tab.active {
      color: var(--accent);
      background: rgba(56, 189, 248, 0.12);
      border-color: rgba(56, 189, 248, 0.35);
      font-weight: 600;
    }
    .diff-header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .sessions-heading-row {
      padding: 12px 14px 6px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-muted);
    }
    .sessions-heading-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .icon-btn-xs {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 13px;
      padding: 2px 4px;
      border-radius: 4px;
    }
    .icon-btn-xs:hover {
      background: var(--hover-bg);
      color: #ffffff;
    }
    .sessions-list-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 4px 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .session-item {
      padding: 8px 10px;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 2px;
      transition: background 0.15s ease;
      position: relative;
    }
    .session-item:hover {
      background: var(--hover-bg);
    }
    .session-item.active {
      background: rgba(56, 189, 248, 0.12);
      border-left: 2px solid var(--accent);
    }
    .session-item-title {
      font-size: 12px;
      color: #f1f5f9;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .session-item.active .session-item-title {
      color: var(--accent);
      font-weight: 600;
    }
    .session-item-time {
      font-size: 10.5px;
      color: var(--text-muted);
    }

    /* 2. CENTER CONVERSATION WORKSPACE */
    .devin-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      position: relative;
      background: var(--bg);
      min-width: 0;
    }

    /* Top Session Bar */
    .top-session-bar {
      height: 44px;
      min-height: 44px;
      padding: 0 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      background: rgba(18, 18, 20, 0.85);
      backdrop-filter: blur(8px);
      z-index: 10;
    }
    .session-left-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      overflow: hidden;
    }
    .btn-toggle-pane {
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 4px;
      color: #cbd5e1;
      padding: 4px 8px;
      font-size: 11.5px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .btn-toggle-pane:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #ffffff;
    }
    .session-title {
      font-size: 13.5px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #f1f5f9;
    }
    .workspace-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--card-border);
      border-radius: 4px;
      font-size: 11.5px;
      color: var(--text-muted);
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .top-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .status-badge {
      font-size: 11px;
      padding: 3px 9px;
      border-radius: 999px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .status-ready { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
    .status-running { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }
    .status-failed { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }

    .btn-switch-ide {
      background: rgba(168, 85, 247, 0.15);
      border: 1px solid rgba(168, 85, 247, 0.4);
      color: #d8b4fe;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: all 0.15s ease;
    }
    .btn-switch-ide:hover {
      background: rgba(168, 85, 247, 0.28);
      border-color: rgba(168, 85, 247, 0.7);
      color: #ffffff;
    }

    /* Scrollable Conversation Workspace */
    .workspace-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 24px 20px 140px 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
      position: relative;
    }
    .workspace-container {
      width: 100%;
      max-width: 820px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    /* Message Item */
    .message-card {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
    }
    .message-card.user {
      align-self: flex-end;
    }
    .message-user-bubble {
      align-self: flex-end;
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.28);
      border-radius: 12px 12px 2px 12px;
      padding: 12px 16px;
      max-width: 82%;
      color: #f8fafc;
      font-size: 13.5px;
      line-height: 1.5;
    }
    .message-agent-wrap {
      display: flex;
      gap: 12px;
      width: 100%;
    }
    .agent-avatar {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: linear-gradient(135deg, #0284c7, #38bdf8);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #ffffff;
      font-weight: 700;
      font-size: 12px;
      flex-shrink: 0;
      box-shadow: 0 2px 8px rgba(56, 189, 248, 0.3);
    }
    .agent-content-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
    }
    .agent-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .agent-name {
      font-weight: 600;
      font-size: 13px;
      color: #f1f5f9;
    }
    .agent-role-pill {
      font-size: 11px;
      padding: 1px 7px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 4px;
      color: var(--text-muted);
    }
    .agent-text {
      color: #e2e8f0;
      font-size: 13.5px;
      line-height: 1.6;
      word-break: break-word;
    }
    .agent-text pre {
      background: #09090b;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      overflow-x: auto;
      margin: 10px 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }
    .agent-text code {
      background: rgba(255, 255, 255, 0.08);
      padding: 2px 5px;
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }

    /* Expandable Execution Cards (Devin Style) */
    .execution-group-card {
      border: 1px solid var(--card-border);
      background: rgba(24, 24, 27, 0.6);
      border-radius: 8px;
      overflow: hidden;
      margin: 4px 0;
      transition: border-color 0.15s ease;
    }
    .execution-group-card:hover {
      border-color: rgba(255, 255, 255, 0.16);
    }
    .execution-header {
      padding: 8px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      user-select: none;
      background: rgba(255, 255, 255, 0.02);
      font-size: 12px;
      color: #94a3b8;
    }
    .execution-header:hover {
      background: rgba(255, 255, 255, 0.05);
      color: #f1f5f9;
    }
    .execution-title-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 500;
    }
    .execution-body {
      padding: 10px 14px;
      border-top: 1px solid var(--card-border);
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: #09090b;
    }
    .cmd-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.05);
      padding: 6px 10px;
      border-radius: 4px;
      border-left: 3px solid #38bdf8;
    }
    .thought-block {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      background: rgba(24, 24, 27, 0.5);
      overflow: hidden;
    }
    .thought-header {
      padding: 6px 10px;
      font-size: 11.5px;
      color: #a1a1aa;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      user-select: none;
    }
    .thought-header:hover {
      color: #f4f4f5;
    }
    .thought-content {
      padding: 8px 12px;
      font-size: 12px;
      color: #cbd5e1;
      font-style: italic;
      line-height: 1.5;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      white-space: pre-wrap;
    }

    /* Live Execution Plan Checklist */
    .plan-card {
      background: rgba(24, 24, 27, 0.7);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .plan-header {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .plan-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .plan-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 5px 8px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 4px;
      font-size: 12.5px;
    }
    .plan-item.completed {
      color: #94a3b8;
      text-decoration: line-through;
    }
    .plan-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 600;
    }
    .plan-pending { background: rgba(255, 255, 255, 0.08); color: #a1a1aa; }
    .plan-in_progress { background: rgba(56, 189, 248, 0.2); color: #38bdf8; }
    .plan-completed { background: rgba(34, 197, 94, 0.2); color: #4ade80; }

    /* Floating Bottom Prompt Bar (Devin Style) */
    .floating-prompt-bar {
      position: absolute;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      width: calc(100% - 40px);
      max-width: 820px;
      background: var(--input-bg);
      backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 30;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .floating-prompt-bar:focus-within {
      border-color: rgba(56, 189, 248, 0.5);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6), 0 0 20px rgba(56, 189, 248, 0.15);
    }
    .prompt-tip {
      font-size: 10.5px;
      color: #64748b;
      padding-left: 4px;
    }
    .prompt-textarea {
      width: 100%;
      min-height: 40px;
      max-height: 160px;
      background: transparent;
      border: none;
      outline: none;
      color: #f1f5f9;
      font-family: inherit;
      font-size: 13.5px;
      line-height: 1.5;
      resize: none;
    }
    .prompt-controls-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      padding-top: 6px;
    }
    .prompt-left-tools {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tool-btn {
      width: 26px;
      height: 26px;
      border-radius: 5px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.04);
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
    }
    .tool-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #ffffff;
    }
    .code-context-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 11px;
      color: #cbd5e1;
    }
    .prompt-right-tools {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .model-selector-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 10px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      font-size: 11.5px;
      color: #f1f5f9;
      cursor: pointer;
      font-weight: 500;
    }
    .model-selector-pill:hover {
      background: rgba(255, 255, 255, 0.12);
    }
    .btn-send {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: var(--accent);
      border: none;
      color: #0f172a;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 14px;
      font-weight: 700;
      transition: all 0.15s ease;
    }
    .btn-send:hover {
      background: #7dd3fc;
      transform: scale(1.05);
    }
    .btn-stop {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: var(--danger);
      border: none;
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 13px;
    }

    /* 3. RIGHT CHANGES & DIFF PANEL */
    .devin-changes {
      width: 320px;
      min-width: 250px;
      max-width: 480px;
      background: var(--card-bg);
      border-left: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      overflow: hidden;
      transition: width 0.2s ease, opacity 0.2s ease;
      z-index: 20;
    }
    .devin-changes.hidden {
      width: 0;
      min-width: 0;
      border-left: none;
      opacity: 0;
      pointer-events: none;
    }
    .changes-header-bar {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .changes-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .changes-title {
      font-size: 13px;
      font-weight: 600;
      color: #f1f5f9;
    }
    .changes-stats-badge {
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--text-muted);
    }
    .changes-actions-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .btn-action-sm {
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      border: none;
    }
    .btn-accept {
      background: rgba(34, 197, 94, 0.18);
      color: #4ade80;
      border: 1px solid rgba(34, 197, 94, 0.35);
    }
    .btn-accept:hover {
      background: rgba(34, 197, 94, 0.3);
    }
    .btn-reject {
      background: rgba(239, 68, 68, 0.18);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.35);
    }
    .btn-reject:hover {
      background: rgba(239, 68, 68, 0.3);
    }
    .btn-review-critic {
      background: rgba(56, 189, 248, 0.18);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.35);
    }
    .btn-review-critic:hover {
      background: rgba(56, 189, 248, 0.3);
    }
    .changes-files-scroll {
      max-height: 180px;
      overflow-y: auto;
      border-bottom: 1px solid var(--border);
      padding: 4px 6px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .change-file-item {
      padding: 6px 8px;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11.5px;
    }
    .change-file-item:hover {
      background: var(--hover-bg);
    }
    .change-file-item.selected {
      background: rgba(56, 189, 248, 0.12);
      border-left: 2px solid var(--accent);
    }
    .file-name-wrap {
      display: flex;
      align-items: center;
      gap: 6px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .file-status-tag {
      font-size: 10px;
      padding: 1px 4px;
      border-radius: 3px;
      font-weight: 700;
    }
    .file-status-tag.m { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
    .file-status-tag.a { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
    .file-status-tag.d { background: rgba(239, 68, 68, 0.2); color: #f87171; }

    /* Live Diff Viewer Area */
    .diff-viewer-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: #09090b;
    }
    .diff-header-tab {
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      color: #94a3b8;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(255, 255, 255, 0.02);
    }
    .diff-code-scroll {
      flex: 1;
      overflow: auto;
      padding: 8px 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
      line-height: 1.5;
    }
    .diff-line {
      padding: 0 10px;
      white-space: pre;
    }
    .diff-line.add {
      background: rgba(34, 197, 94, 0.15);
      color: #86efac;
    }
    .diff-line.del {
      background: rgba(239, 68, 68, 0.15);
      color: #fca5a5;
    }
    .diff-line.info {
      color: #64748b;
    }

    /* Popover Backdrop & Base Styles */
    .popover-backdrop {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: none;
      background: transparent;
    }
    .popover-backdrop.active {
      display: block;
    }

    .popover-menu, .popover-card {
      position: absolute;
      z-index: 110;
      display: none;
      background: #18181b;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(16px);
      color: #f1f5f9;
      user-select: none;
    }
    .popover-menu.open, .popover-card.open {
      display: flex;
      flex-direction: column;
      animation: popoverFadeIn 0.12s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes popoverFadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Attach Menu */
    .popover-menu {
      min-width: 200px;
      padding: 6px 0;
      font-size: 13px;
    }
    .popover-menu-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 14px;
      cursor: pointer;
      color: #e2e8f0;
      transition: background 0.1s ease;
    }
    .popover-menu-item:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #ffffff;
    }
    .popover-menu-item .popover-icon {
      font-size: 14px;
      width: 18px;
      text-align: center;
      color: var(--accent);
    }

    /* Execution & Permission Option Cards */
    .popover-card {
      padding: 8px;
    }
    .popover-card-option {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 10px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.1s ease;
    }
    .popover-card-option:hover {
      background: rgba(255, 255, 255, 0.07);
    }
    .popover-card-option .option-icon {
      font-size: 15px;
      width: 22px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #38bdf8;
      flex-shrink: 0;
    }
    .popover-card-option .option-content {
      flex: 1;
      min-width: 0;
    }
    .popover-card-option .option-title {
      font-size: 12.5px;
      font-weight: 600;
      color: #f8fafc;
    }
    .popover-card-option .option-desc {
      font-size: 11px;
      color: #94a3b8;
      line-height: 1.3;
      margin-top: 1px;
    }
    .popover-card-option .option-check {
      font-size: 13px;
      font-weight: 700;
      color: #38bdf8;
      display: none;
    }
    .popover-card-option.active .option-check {
      display: block;
    }
    .popover-divider {
      height: 1px;
      background: rgba(255, 255, 255, 0.08);
      margin: 6px 0;
    }

    /* Model Selector Modal */
    .modal-search-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .modal-search-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      font-size: 13px;
      color: #f1f5f9;
      font-family: inherit;
    }
    .modal-search-input::placeholder {
      color: #64748b;
    }
    .kbd-badge {
      font-size: 10.5px;
      padding: 2px 5px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.08);
      color: #94a3b8;
      font-family: var(--vscode-editor-font-family, monospace);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    .clear-search-btn {
      background: none;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      font-size: 12px;
    }
    .model-categories-scroll {
      flex: 1;
      overflow-y: auto;
      max-height: 440px;
      padding: 6px 4px;
    }
    .model-category-header {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: #64748b;
      padding: 8px 10px 4px 10px;
    }
    .model-item-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 10px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.1s ease;
    }
    .model-item-row:hover {
      background: rgba(255, 255, 255, 0.06);
    }
    .model-item-row.selected {
      background: rgba(56, 189, 248, 0.12);
    }
    .model-item-icon {
      width: 24px;
      height: 24px;
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.05);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      flex-shrink: 0;
    }
    .model-item-info {
      flex: 1;
      min-width: 0;
    }
    .model-item-name-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .model-item-name {
      font-size: 12.5px;
      font-weight: 600;
      color: #f8fafc;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .model-tag {
      font-size: 9.5px;
      padding: 1px 4px;
      border-radius: 3px;
      font-weight: 600;
    }
    .model-tag.local { background: rgba(56, 189, 248, 0.18); color: #38bdf8; }
    .model-tag.new { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
    .model-tag.free { background: rgba(168, 85, 247, 0.2); color: #c084fc; }
    .model-item-meta-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: #94a3b8;
      margin-top: 2px;
    }
    .status-dot-available {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #22c55e;
      display: inline-block;
    }
    .model-fav-btn {
      background: none;
      border: none;
      font-size: 14px;
      color: #64748b;
      cursor: pointer;
      padding: 2px 4px;
      transition: color 0.1s ease;
    }
    .model-fav-btn:hover, .model-fav-btn.is-fav {
      color: #fbbf24;
    }
    .model-check {
      font-size: 13px;
      font-weight: 700;
      color: #38bdf8;
      width: 16px;
      text-align: center;
    }

    /* Model Config Popover */
    .config-popover-header {
      padding: 8px 10px 10px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .config-popover-title {
      font-size: 13px;
      font-weight: 600;
      color: #f8fafc;
    }
    .config-model-name {
      font-size: 11.5px;
      color: var(--accent);
      font-family: var(--vscode-editor-font-family, monospace);
      margin-top: 2px;
    }
    .config-section {
      padding: 10px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .config-section-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.6px;
      color: #64748b;
      margin-bottom: 8px;
      text-transform: uppercase;
    }
    .effort-segmented-bar {
      display: flex;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 6px;
      padding: 2px;
      gap: 2px;
    }
    .effort-seg-btn {
      flex: 1;
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 11px;
      font-weight: 500;
      padding: 5px 0;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.1s ease;
    }
    .effort-seg-btn:hover {
      color: #ffffff;
    }
    .effort-seg-btn.active {
      background: var(--accent);
      color: #0f172a;
      font-weight: 700;
    }
    .fast-mode-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .fast-mode-title {
      font-size: 12.5px;
      font-weight: 600;
      color: #f8fafc;
    }
    .fast-mode-desc {
      font-size: 11px;
      color: #94a3b8;
      margin-top: 2px;
    }
    .toggle-switch {
      position: relative;
      display: inline-block;
      width: 36px;
      height: 20px;
      flex-shrink: 0;
    }
    .toggle-switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .toggle-slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: rgba(255, 255, 255, 0.15);
      transition: .2s;
      border-radius: 20px;
    }
    .toggle-slider:before {
      position: absolute;
      content: "";
      height: 14px;
      width: 14px;
      left: 3px;
      bottom: 3px;
      background-color: white;
      transition: .2s;
      border-radius: 50%;
    }
    input:checked + .toggle-slider {
      background-color: var(--accent);
    }
    input:checked + .toggle-slider:before {
      transform: translateX(16px);
      background-color: #0f172a;
    }
    .resource-card {
      display: flex;
      align-items: center;
      gap: 10px;
      background: rgba(255, 255, 255, 0.03);
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    .resource-icon {
      font-size: 16px;
    }
    .resource-title {
      font-size: 12px;
      font-weight: 600;
      color: #f1f5f9;
    }
    .resource-desc {
      font-size: 11px;
      color: #94a3b8;
    }

    /* Attached Context Chips Bar */
    .composer-attached-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 6px 10px 4px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .attached-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.25);
      color: #e0f2fe;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .attached-chip-remove {
      cursor: pointer;
      opacity: 0.7;
      font-weight: 700;
      font-size: 12px;
    }
    .attached-chip-remove:hover {
      opacity: 1;
      color: #f87171;
    }

    /* Controls Pills */
    .tool-btn-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 10px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #cbd5e1;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .tool-btn-pill:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #ffffff;
    }
    .effort-selector-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 5px;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.2);
      color: #38bdf8;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .effort-selector-pill:hover {
      background: rgba(56, 189, 248, 0.2);
    }
    .tool-btn-icon {
      background: none;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      font-size: 15px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 3px 6px;
      border-radius: 4px;
    }
    .tool-btn-icon:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.08);
    }
    .pill-arrow {
      font-size: 9px;
      opacity: 0.7;
    }

  </style>
</head>
<body>

  <div class="devin-workspace-layout">

    <!-- 1. LEFT SESSIONS SIDEBAR -->
    <aside class="devin-sidebar" id="devinSidebar">
      <div class="user-profile-header">
        <div class="user-avatar">${avatarInitials}</div>
        <div class="user-meta">
          <div class="user-name">${username}</div>
          <div class="user-role">@${username}</div>
        </div>
        <div class="user-header-icons">
          <button class="icon-btn-xs" id="btnSearchHeader" title="Search">🔍</button>
          <button class="icon-btn-xs" id="btnSettingsHeader" title="Notifications &amp; Settings">🔔</button>
        </div>
      </div>

      <button class="btn-new-session" id="btnNewSession">
        <span>+</span> New session
      </button>

      <div class="session-search-box">
        <input type="text" class="session-search-input" id="sessionSearchInput" placeholder="Search sessions...">
      </div>

      <nav class="devin-nav">
        <div class="nav-item" id="navAutomations"><span>⚡</span> Automations</div>
        <div class="nav-item" id="navSecurity"><span>🛡</span> Security</div>
        <div class="nav-item" id="navReview"><span>👁</span> Review</div>
        <div class="nav-item" id="navWiki"><span>📖</span> Wiki</div>
        <div class="nav-item" id="navCustomize"><span>⚙</span> Customize</div>
        <div class="nav-item" id="navAgents"><span>🤖</span> Agent Team</div>
        <div class="nav-item" id="navMcp"><span>🔌</span> MCP Servers</div>
      </nav>

      <div class="sessions-heading-row">
        <span>Sessions</span>
        <div class="sessions-heading-actions">
          <button class="icon-btn-xs" id="btnHeaderNewSession" title="New Session">+</button>
          <button class="icon-btn-xs" id="btnHeaderFilter" title="Sort / Filter">⇅</button>
        </div>
      </div>

      <div class="sessions-subgroup" style="padding: 4px 14px 2px 14px; font-size: 11px; color: #94a3b8; font-weight: 600;">
        ▾ Recent
      </div>

      <div class="sessions-list-scroll" id="sessionsList">
        <!-- Sessions dynamically rendered -->
      </div>
    </aside>

    <!-- 2. CENTER CONVERSATION WORKSPACE -->
    <main class="devin-main">
      <div class="top-session-bar">
        <div class="session-left-meta">
          <button class="btn-toggle-pane" id="btnToggleSidebar" title="Toggle Sessions Sidebar">☵ Sessions</button>
          <span class="session-title" id="topSessionTitle">LocalCoders Multi-Agent Workspace</span>
          <span class="workspace-pill" id="topWorkspacePill">🗁 workspace</span>
        </div>
        <div class="top-actions">
          <span class="status-badge status-ready" id="topStatusBadge">Ready</span>
          <button class="btn-switch-ide" id="btnSwitchToIde" title="Switch to standard IDE Editor &amp; File Tree">💻 IDE View</button>
          <button class="btn-toggle-pane" id="btnToggleChanges" title="Toggle Changes &amp; Review Panel">◫ Changes</button>
        </div>
      </div>

      <div class="workspace-scroll" id="scrollContainer">
        <div class="workspace-container" id="conversationFlow">
          <!-- Messages, execution cards, plans -->
        </div>
      </div>

      <!-- Floating Bottom Prompt Bar with Popovers -->
      <div class="floating-prompt-bar">
        <!-- Floating Popovers Backdrop -->
        <div class="popover-backdrop" id="popoverBackdrop"></div>

        <!-- 1. Attachment / Context Popover (Screenshot 1) -->
        <div class="popover-menu" id="attachMenuPopover">
          <div class="popover-menu-item" data-action="attachFiles">
            <span class="popover-icon">📎</span>
            <span class="popover-label">Attach files</span>
          </div>
          <div class="popover-menu-item" data-action="quickFile">
            <span class="popover-icon">📄</span>
            <span class="popover-label">Files</span>
          </div>
          <div class="popover-menu-item" data-action="quickDirectory">
            <span class="popover-icon">📁</span>
            <span class="popover-label">Directories</span>
          </div>
          <div class="popover-menu-item" data-action="attachGit">
            <span class="popover-icon">⎇</span>
            <span class="popover-label">Git</span>
          </div>
          <div class="popover-menu-item" data-action="openMcp">
            <span class="popover-icon">⚡</span>
            <span class="popover-label">MCP servers</span>
          </div>
          <div class="popover-menu-item" data-action="openRules">
            <span class="popover-icon">📜</span>
            <span class="popover-label">Rules</span>
          </div>
          <div class="popover-menu-item" data-action="openSkills">
            <span class="popover-icon">💡</span>
            <span class="popover-label">Skills</span>
          </div>
          <div class="popover-menu-item" data-action="attachPlan">
            <span class="popover-icon">📋</span>
            <span class="popover-label">Plans</span>
          </div>
          <div class="popover-menu-item" data-action="attachConversation">
            <span class="popover-icon">💬</span>
            <span class="popover-label">Conversations</span>
          </div>
          <div class="popover-menu-item" data-action="attachTerminal">
            <span class="popover-icon">⌨</span>
            <span class="popover-label">Terminal</span>
          </div>
          <div class="popover-menu-item" data-action="attachCodemap">
            <span class="popover-icon">🗺</span>
            <span class="popover-label">Codemaps</span>
          </div>
        </div>

        <!-- 2. Execution Mode Popover (Screenshot 2/3) -->
        <div class="popover-card" id="execModePopover" style="width: 290px;">
          <div class="popover-card-option" data-exec="code">
            <div class="option-icon">&lt;/&gt;</div>
            <div class="option-content">
              <div class="option-title">Code</div>
              <div class="option-desc">Write and edit code</div>
            </div>
            <div class="option-check" id="checkExec_code">✓</div>
          </div>
          <div class="popover-card-option" data-exec="smart">
            <div class="option-icon">✦</div>
            <div class="option-content">
              <div class="option-title">Smart</div>
              <div class="option-desc">Auto-approve actions the model judges safe</div>
            </div>
            <div class="option-check" id="checkExec_smart">✓</div>
          </div>
          <div class="popover-card-option" data-exec="ask">
            <div class="option-icon">💬</div>
            <div class="option-content">
              <div class="option-title">Ask</div>
              <div class="option-desc">Answer questions without code changes</div>
            </div>
            <div class="option-check" id="checkExec_ask">✓</div>
          </div>
          <div class="popover-card-option" data-exec="plan">
            <div class="option-icon">📋</div>
            <div class="option-content">
              <div class="option-title">Plan</div>
              <div class="option-desc">Plan changes before implementing</div>
            </div>
            <div class="option-check" id="checkExec_plan">✓</div>
          </div>
          <div class="popover-divider"></div>
          <div class="popover-card-option" data-perm="bypass" id="optBypassPerms">
            <div class="option-icon">🛡</div>
            <div class="option-content">
              <div class="option-title">Bypass Permissions</div>
              <div class="option-desc">Auto-approve all tool calls unless blocked by hard safety boundaries</div>
            </div>
            <div class="option-check" id="checkPerm_bypass">✓</div>
          </div>
        </div>

        <!-- 3. Permission Mode Popover -->
        <div class="popover-card" id="permModePopover" style="width: 300px;">
          <div class="popover-card-option" data-perm="ask">
            <div class="option-icon">🛡</div>
            <div class="option-content">
              <div class="option-title">Ask Before Actions</div>
              <div class="option-desc">Prompt for manual confirmation before every tool call or edit</div>
            </div>
            <div class="option-check" id="checkPerm_ask">✓</div>
          </div>
          <div class="popover-card-option" data-perm="smart">
            <div class="option-icon">⚡</div>
            <div class="option-content">
              <div class="option-title">Smart Approval</div>
              <div class="option-desc">Auto-approve safe reads; prompt on file modifications and terminal runs</div>
            </div>
            <div class="option-check" id="checkPerm_smart">✓</div>
          </div>
          <div class="popover-card-option" data-perm="bypass">
            <div class="option-icon">🚀</div>
            <div class="option-content">
              <div class="option-title">Bypass Permissions</div>
              <div class="option-desc">Auto-approve all tool calls unless your organization's policy requires approval</div>
            </div>
            <div class="option-check" id="checkPerm_bypass_modal">✓</div>
          </div>
        </div>

        <!-- 4. Advanced Model Selector Popover (Antigravity Reference Screenshot 4) -->
        <div class="popover-card model-selector-modal" id="modelSelectorPopover" style="width: 380px; max-height: 520px;">
          <div class="modal-search-header">
            <span class="search-icon">🔍</span>
            <input type="text" id="modelSearchInput" class="modal-search-input" placeholder="Search all models..." autocomplete="off" />
            <span class="kbd-badge">Ctrl+K</span>
            <button class="clear-search-btn" id="btnClearModelSearch" style="display:none;">✕</button>
          </div>
          <div class="model-categories-scroll" id="modelCategoriesContainer">
            <!-- Categories rendered dynamically -->
          </div>
        </div>

        <!-- 5. Model Configuration Popover (Reasoning Effort, Fast Mode, Context/Billing) -->
        <div class="popover-card" id="modelConfigPopover" style="width: 320px;">
          <div class="config-popover-header">
            <div class="config-popover-title">Model Configuration</div>
            <div class="config-model-name" id="cfgActiveModelName">qwen3.8:27b</div>
          </div>
          
          <div class="config-section">
            <div class="config-section-label">REASONING EFFORT</div>
            <div class="effort-segmented-bar" id="effortSegmentedBar">
              <button class="effort-seg-btn" data-effort="minimal">Minimal</button>
              <button class="effort-seg-btn" data-effort="low">Low</button>
              <button class="effort-seg-btn active" data-effort="medium">Medium</button>
              <button class="effort-seg-btn" data-effort="high">High</button>
              <button class="effort-seg-btn" data-effort="extra_high">Extra High</button>
            </div>
          </div>

          <div class="config-section">
            <div class="fast-mode-row">
              <div class="fast-mode-text">
                <div class="fast-mode-title">Fast Mode</div>
                <div class="fast-mode-desc">Prioritize generation speed and lower latency</div>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="chkFastMode" />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div class="config-section">
            <div class="config-section-label">RESOURCE &amp; BILLING</div>
            <div class="resource-card" id="cfgResourceCard">
              <div class="resource-icon">🖥</div>
              <div class="resource-details">
                <div class="resource-title" id="cfgResourceTitle">Local Model (Ollama)</div>
                <div class="resource-desc" id="cfgResourceDesc">100% On-Device / No API billing</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Attached Chips Row -->
        <div class="composer-attached-row" id="attachedChipsRow" style="display:none;"></div>

        <div class="composer-modes-row">
          <button class="mode-tab active" data-mode="agent">Agent</button>
          <button class="mode-tab" data-mode="plan">Plan</button>
          <button class="mode-tab" data-mode="ask">Ask</button>
          <button class="mode-tab" data-mode="review">Review</button>
        </div>
        <textarea class="prompt-textarea" id="promptInput" rows="1" placeholder="Ask anything, @ to mention, / for actions... (Enter to send, Shift+Enter for newline)"></textarea>
        
        <div class="prompt-controls-row">
          <div class="prompt-left-tools">
            <button class="tool-btn" id="btnAttachment" title="Add File / Context (Attach, Git, MCP, Rules, Skills)">+</button>
            <button class="tool-btn-pill" id="btnExecMode" title="Change Execution Mode">
              <span id="execModeLabel">&lt;/&gt; Code</span>
              <span class="pill-arrow">▾</span>
            </button>
            <button class="tool-btn-pill" id="btnPermMode" title="Change Security Permission Policy">
              <span id="permModeLabel">🛡 Smart Approval</span>
              <span class="pill-arrow">▾</span>
            </button>
            <div class="code-context-pill" id="btnWorkspaceContext" title="Current Workspace Folder">
              <span>📁</span>
              <span id="promptWorkspaceLabel">workspace</span>
            </div>
          </div>
          <div class="prompt-right-tools">
            <div class="model-selector-pill" id="modelSelector" title="Select AI Model (Ctrl+K)">
              <span class="model-provider-icon" id="modelProviderIcon">🦙</span>
              <span id="activeModelLabel">qwen3.8:27b</span>
              <span class="pill-arrow">▾</span>
            </div>
            <div class="effort-selector-pill" id="btnEffortConfig" title="Configure Reasoning Effort &amp; Fast Mode">
              <span id="activeEffortLabel">Medium</span>
            </div>
            <button class="tool-btn-icon" id="btnMic" title="Voice Input (Dictation)">🎙</button>
            <button class="btn-send" id="btnSend" title="Send Prompt (Enter)">↑</button>
            <button class="btn-stop" id="btnStop" style="display:none;" title="Stop Execution">■</button>
          </div>
        </div>
      </div>
    </main>

    <!-- 3. RIGHT CHANGES & DIFF PANEL -->
    <aside class="devin-changes" id="devinChanges">
      <div class="changes-header-bar">
        <div class="changes-title-row">
          <span class="changes-title">Changes</span>
          <span class="changes-stats-badge" id="changesStats">0 files</span>
        </div>
        <div class="changes-actions-row">
          <button class="btn-action-sm btn-accept" id="btnAcceptAll">Accept All</button>
          <button class="btn-action-sm btn-reject" id="btnRejectAll">Reject All</button>
          <button class="btn-action-sm btn-review-critic" id="btnCriticReview">Critic Review</button>
        </div>
      </div>

      <div class="changes-files-scroll" id="changesFilesList">
        <!-- Changed files injected dynamically -->
      </div>

      <div class="diff-viewer-area">
        <div class="diff-header-tab">
          <span id="diffActiveFileLabel">No file selected</span>
          <div class="diff-header-actions">
            <button class="icon-btn-xs" id="btnRevertFile" title="Revert Changes to this File">↺ Revert</button>
            <button class="icon-btn-xs" id="btnOpenInEditor" title="Open in VS Code Diff Editor">↗ Diff Editor</button>
          </div>
        </div>
        <div class="diff-code-scroll" id="diffCodeContainer">
          <div class="diff-line info">// Select a changed file above to inspect live diff</div>
        </div>
      </div>
    </aside>

  </div>

  <script>
    const vscode = acquireVsCodeApi();

    let currentSession = null;
    let allSessionsList = [];
    let activePlan = [];
    let isWorking = false;
    let currentChanges = { totalFiles: 0, totalAdded: 0, totalRemoved: 0, files: [] };
    let selectedDiffFile = null;

    const conversationFlow = document.getElementById('conversationFlow');
    const scrollContainer = document.getElementById('scrollContainer');
    const promptInput = document.getElementById('promptInput');
    const btnSend = document.getElementById('btnSend');
    const btnStop = document.getElementById('btnStop');
    const topSessionTitle = document.getElementById('topSessionTitle');
    const topWorkspacePill = document.getElementById('topWorkspacePill');
    const topStatusBadge = document.getElementById('topStatusBadge');
    const promptWorkspaceLabel = document.getElementById('promptWorkspaceLabel');
    const activeModelLabel = document.getElementById('activeModelLabel');
    const modelSelector = document.getElementById('modelSelector');

    // Panes
    const devinSidebar = document.getElementById('devinSidebar');
    const devinChanges = document.getElementById('devinChanges');
    const btnToggleSidebar = document.getElementById('btnToggleSidebar');
    const btnToggleChanges = document.getElementById('btnToggleChanges');
    const btnSwitchToIde = document.getElementById('btnSwitchToIde');

    btnToggleSidebar.addEventListener('click', () => {
      devinSidebar.classList.toggle('hidden');
    });
    btnToggleChanges.addEventListener('click', () => {
      devinChanges.classList.toggle('hidden');
    });
    btnSwitchToIde.addEventListener('click', () => {
      vscode.postMessage({ command: 'switchToIde' });
    });

    // Nav items
    document.getElementById('navSecurity').addEventListener('click', () => vscode.postMessage({ command: 'openSecurity' }));
    document.getElementById('navReview').addEventListener('click', () => vscode.postMessage({ command: 'openReview' }));
    document.getElementById('navWiki').addEventListener('click', () => vscode.postMessage({ command: 'openWiki' }));
    document.getElementById('navCustomize').addEventListener('click', () => vscode.postMessage({ command: 'openAgents' }));
    const navAgents = document.getElementById('navAgents');
    if (navAgents) {
      navAgents.addEventListener('click', () => vscode.postMessage({ command: 'openAgents' }));
    }
    document.getElementById('navMcp').addEventListener('click', () => vscode.postMessage({ command: 'openMcp' }));

    // Session search
    const sessionSearchInput = document.getElementById('sessionSearchInput');
    if (sessionSearchInput) {
      sessionSearchInput.addEventListener('input', () => {
        renderSessionsList(sessionSearchInput.value.trim());
      });
    }

    // Composer modes
    let activeComposerMode = 'agent';
    document.querySelectorAll('.mode-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeComposerMode = tab.getAttribute('data-mode') || 'agent';
      });
    });

    // New Session
    document.getElementById('btnNewSession').addEventListener('click', () => vscode.postMessage({ command: 'newSession' }));
    document.getElementById('btnHeaderNewSession').addEventListener('click', () => vscode.postMessage({ command: 'newSession' }));

    // Changes actions
    document.getElementById('btnAcceptAll').addEventListener('click', () => vscode.postMessage({ command: 'acceptAll' }));
    document.getElementById('btnRejectAll').addEventListener('click', () => vscode.postMessage({ command: 'rejectAll' }));
    document.getElementById('btnCriticReview').addEventListener('click', () => vscode.postMessage({ command: 'reviewCritic' }));
    const btnRevertFile = document.getElementById('btnRevertFile');
    if (btnRevertFile) {
      btnRevertFile.addEventListener('click', () => {
        if (!selectedDiffFile) return;
        vscode.postMessage({ command: 'rejectFile', path: selectedDiffFile });
      });
    }
    document.getElementById('btnOpenInEditor').addEventListener('click', () => {
      if (selectedDiffFile) {
        vscode.postMessage({ command: 'openDiff', path: selectedDiffFile });
      }
    });

    // Prompt input
    promptInput.addEventListener('input', () => {
      promptInput.style.height = 'auto';
      promptInput.style.height = Math.min(promptInput.scrollHeight, 160) + 'px';
    });

    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitPrompt();
      }
    });

    btnSend.addEventListener('click', submitPrompt);
    btnStop.addEventListener('click', () => {
      vscode.postMessage({ command: 'stopTask' });
    });

    modelSelector.addEventListener('click', () => {
      vscode.postMessage({ command: 'selectModel' });
    });

    document.getElementById('btnAttachment').addEventListener('click', () => {
      devinChanges.classList.remove('hidden');
    });

    function submitPrompt() {
      if (isWorking) return;
      const text = promptInput.value.trim();
      if (!text) return;
      promptInput.value = '';
      promptInput.style.height = 'auto';
      isWorking = true;
      updateStatusUI();
      vscode.postMessage({ command: 'sendMessage', text });
    }

    function updateStatusUI() {
      if (isWorking) {
        btnSend.style.display = 'none';
        btnStop.style.display = 'flex';
        topStatusBadge.className = 'status-badge status-running';
        topStatusBadge.textContent = 'Working...';
      } else {
        btnSend.style.display = 'flex';
        btnStop.style.display = 'none';
        topStatusBadge.className = 'status-badge status-ready';
        topStatusBadge.textContent = 'Ready';
      }
    }

    function formatTimeAgo(ts) {
      if (!ts) return '';
      const diffSec = Math.floor((Date.now() - ts) / 1000);
      if (diffSec < 60) return 'Just now';
      if (diffSec < 3600) return Math.floor(diffSec / 60) + 'm ago';
      if (diffSec < 86400) return Math.floor(diffSec / 3600) + 'h ago';
      const days = Math.floor(diffSec / 86400);
      return days + (days === 1 ? ' day ago' : ' days ago');
    }

    function renderSessionsList(filterQuery = '') {
      const container = document.getElementById('sessionsList');
      container.innerHTML = '';
      const list = filterQuery
        ? allSessionsList.filter(s => (s.title || '').toLowerCase().includes(filterQuery.toLowerCase()))
        : allSessionsList;

      if (list.length === 0) {
        container.innerHTML = '<div style="padding:10px;font-size:11.5px;color:var(--text-muted);text-align:center;">No sessions found</div>';
        return;
      }

      list.forEach((s) => {
        const item = document.createElement('div');
        item.className = 'session-item' + (currentSession && s.id === currentSession.id ? ' active' : '');
        item.innerHTML = '<div class="session-item-title">' + escapeHtml(s.title) + '</div>' +
          '<div class="session-item-time">🕒 ' + formatTimeAgo(s.updatedAt || s.createdAt) + '</div>';
        item.addEventListener('click', () => {
          vscode.postMessage({ command: 'switchSession', sessionId: s.id });
        });
        container.appendChild(item);
      });
    }

    function renderChangesList() {
      const statsBadge = document.getElementById('changesStats');
      statsBadge.textContent = currentChanges.totalFiles + ' files +' + currentChanges.totalAdded + ' -' + currentChanges.totalRemoved;

      const listContainer = document.getElementById('changesFilesList');
      listContainer.innerHTML = '';
      if (!currentChanges.files || currentChanges.files.length === 0) {
        listContainer.innerHTML = '<div style="padding:10px;font-size:11.5px;color:#64748b;text-align:center;">No changes in workspace</div>';
        return;
      }

      currentChanges.files.forEach((f) => {
        const item = document.createElement('div');
        item.className = 'change-file-item' + (selectedDiffFile === f.path ? ' selected' : '');
        const statusClass = f.status === 'M' ? 'm' : f.status === 'A' ? 'a' : 'd';
        item.innerHTML = '<div class="file-name-wrap">' +
          '<span class="file-status-tag ' + statusClass + '">' + f.status + '</span>' +
          '<span>' + escapeHtml(f.filename) + '</span>' +
          '</div>' +
          '<span style="font-size:10px;color:#94a3b8;">+' + f.added + ' -' + f.removed + '</span>';

        item.addEventListener('click', () => {
          selectedDiffFile = f.path;
          renderChangesList();
          document.getElementById('diffActiveFileLabel').textContent = f.path;
          vscode.postMessage({ command: 'getFileDiff', path: f.path });
        });
        listContainer.appendChild(item);
      });

      if (!selectedDiffFile && currentChanges.files.length > 0) {
        selectedDiffFile = currentChanges.files[0].path;
        document.getElementById('diffActiveFileLabel').textContent = selectedDiffFile;
        vscode.postMessage({ command: 'getFileDiff', path: selectedDiffFile });
      }
    }

    function renderDiffCode(diff) {
      const container = document.getElementById('diffCodeContainer');
      container.innerHTML = '';
      if (!diff) {
        container.innerHTML = '<div class="diff-line info">// No diff available</div>';
        return;
      }
      const lines = diff.split('\\n');
      lines.forEach((line) => {
        const el = document.createElement('div');
        if (line.startsWith('+') && !line.startsWith('+++')) {
          el.className = 'diff-line add';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          el.className = 'diff-line del';
        } else if (line.startsWith('@@') || line.startsWith('diff')) {
          el.className = 'diff-line info';
        } else {
          el.className = 'diff-line';
        }
        el.textContent = line;
        container.appendChild(el);
      });
    }

    function renderFullConversation() {
      conversationFlow.innerHTML = '';

      if (activePlan && activePlan.length > 0) {
        const planCard = document.createElement('div');
        planCard.className = 'plan-card';
        let planHtml = '<div class="plan-header"><span>Execution Checklist</span><span>' +
          activePlan.filter(p => p.status === 'completed').length + '/' + activePlan.length + ' Done</span></div><ul class="plan-list">';
        activePlan.forEach((p) => {
          const isDone = p.status === 'completed';
          const badgeClass = p.status === 'completed' ? 'plan-completed' : p.status === 'in_progress' ? 'plan-in_progress' : 'plan-pending';
          planHtml += '<li class="plan-item' + (isDone ? ' completed' : '') + '">' +
            '<span>' + escapeHtml(p.description) + '</span>' +
            '<span class="plan-badge ' + badgeClass + '">' + p.status + '</span>' +
            '</li>';
        });
        planHtml += '</ul>';
        planCard.innerHTML = planHtml;
        conversationFlow.appendChild(planCard);
      }

      if (currentSession && currentSession.messages) {
        currentSession.messages.forEach((msg) => {
          const card = document.createElement('div');
          card.className = 'message-card ' + msg.senderRole;

          if (msg.senderRole === 'user') {
            card.innerHTML = '<div class="message-user-bubble">' + escapeHtml(msg.content) + '</div>';
          } else {
            const avatarLetter = (msg.senderName || 'LC').substring(0, 2).toUpperCase();
            card.innerHTML = '<div class="message-agent-wrap">' +
              '<div class="agent-avatar">' + avatarLetter + '</div>' +
              '<div class="agent-content-area">' +
              '<div class="agent-header">' +
              '<span class="agent-name">' + escapeHtml(msg.senderName || 'Main Agent') + '</span>' +
              '<span class="agent-role-pill">' + escapeHtml(msg.senderRole || 'agent') + '</span>' +
              '</div>' +
              '<div class="agent-text">' + formatMarkdown(msg.content) + '</div>' +
              '</div>' +
              '</div>';
          }
          conversationFlow.appendChild(card);
        });
      }

      if (currentSession && currentSession.executionGroups && currentSession.executionGroups.length > 0) {
        currentSession.executionGroups.forEach((eg) => {
          const groupCard = document.createElement('div');
          groupCard.className = 'execution-group-card';
          const durationStr = formatDuration(eg.durationMs || (eg.completedAt ? eg.completedAt - eg.startedAt : Date.now() - eg.startedAt));
          let detailsHtml = '';
          if (eg.details && eg.details.length > 0) {
            detailsHtml = eg.details.map(d => '<div class="cmd-row">Ran ' + escapeHtml(d) + '</div>').join('');
          }
          groupCard.innerHTML =
            '<div class="execution-header">' +
            '<div class="execution-title-wrap"><span class="chevron">›</span> <span>Worked for ' + durationStr + '</span></div>' +
            '<span style="font-size:11px;color:var(--text-muted);">' + (eg.status || 'completed') + '</span>' +
            '</div>' +
            '<div class="execution-body">' + detailsHtml + '</div>';
          const execHeader = groupCard.querySelector('.execution-header');
          if (execHeader) {
            execHeader.addEventListener('click', () => {
              groupCard.classList.toggle('expanded');
            });
          }
          conversationFlow.appendChild(groupCard);
        });
      }

      const statusLine = document.createElement('div');
      statusLine.className = 'agent-awaiting-line';
      statusLine.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;color:#f59e0b;padding:8px 0;width:100%;';
      statusLine.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f59e0b;"></span> <span>LocalCoders is awaiting instructions</span>';
      conversationFlow.appendChild(statusLine);

      const tipLine = document.createElement('div');
      tipLine.className = 'agent-tip-line';
      tipLine.style.cssText = 'font-size:11px;color:#64748b;padding-bottom:12px;width:100%;';
      tipLine.textContent = 'Tip: Hide or show the sidebar (Ctrl B)';
      conversationFlow.appendChild(tipLine);

      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }

    function formatDuration(ms) {
      if (!ms || ms <= 0) return '0s';
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return sec + 's';
      const min = Math.floor(sec / 60);
      const remSec = sec % 60;
      return min + 'm ' + remSec + 's';
    }


    // Popovers Elements & State
    const popoverBackdrop = document.getElementById('popoverBackdrop');
    const attachMenuPopover = document.getElementById('attachMenuPopover');
    const execModePopover = document.getElementById('execModePopover');
    const permModePopover = document.getElementById('permModePopover');
    const modelSelectorPopover = document.getElementById('modelSelectorPopover');
    const modelConfigPopover = document.getElementById('modelConfigPopover');

    const btnAttachment = document.getElementById('btnAttachment');
    const btnExecMode = document.getElementById('btnExecMode');
    const btnPermMode = document.getElementById('btnPermMode');
    const btnEffortConfig = document.getElementById('btnEffortConfig');
    const modelSearchInput = document.getElementById('modelSearchInput');
    const btnClearModelSearch = document.getElementById('btnClearModelSearch');
    const modelCategoriesContainer = document.getElementById('modelCategoriesContainer');
    const attachedChipsRow = document.getElementById('attachedChipsRow');

    const execModeLabel = document.getElementById('execModeLabel');
    const permModeLabel = document.getElementById('permModeLabel');
    const activeEffortLabel = document.getElementById('activeEffortLabel');
    const modelProviderIcon = document.getElementById('modelProviderIcon');
    const cfgActiveModelName = document.getElementById('cfgActiveModelName');
    const cfgResourceTitle = document.getElementById('cfgResourceTitle');
    const cfgResourceDesc = document.getElementById('cfgResourceDesc');
    const chkFastMode = document.getElementById('chkFastMode');

    let cachedGroupedModels = {};
    let cachedConfig = {
      modelId: 'qwen3.8:27b',
      reasoningEffort: 'medium',
      fastMode: false,
      executionMode: 'code',
      permissionMode: 'smart',
      attachedFiles: [],
    };

    function closeAllPopovers() {
      popoverBackdrop.classList.remove('active');
      attachMenuPopover.classList.remove('open');
      execModePopover.classList.remove('open');
      permModePopover.classList.remove('open');
      modelSelectorPopover.classList.remove('open');
      modelConfigPopover.classList.remove('open');
    }

    popoverBackdrop.addEventListener('click', closeAllPopovers);

    function togglePopover(popover, triggerEl, alignRight = false) {
      const isOpen = popover.classList.contains('open');
      closeAllPopovers();
      if (!isOpen) {
        popoverBackdrop.classList.add('active');
        popover.classList.add('open');
        popover.style.bottom = 'calc(100% + 8px)';
        if (alignRight) {
          popover.style.right = '12px';
          popover.style.left = 'auto';
        } else {
          popover.style.left = '12px';
          popover.style.right = 'auto';
        }
      }
    }

    btnAttachment.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover(attachMenuPopover, btnAttachment, false);
    });

    btnExecMode.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover(execModePopover, btnExecMode, false);
    });

    btnPermMode.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover(permModePopover, btnPermMode, false);
    });

    modelSelector.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover(modelSelectorPopover, modelSelector, true);
      setTimeout(() => {
        modelSearchInput.focus();
        modelSearchInput.select();
      }, 50);
    });

    btnEffortConfig.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover(modelConfigPopover, btnEffortConfig, true);
    });

    // Keyboard Shortcuts (Ctrl+K / Cmd+K and Escape)
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        togglePopover(modelSelectorPopover, modelSelector, true);
        setTimeout(() => {
          modelSearchInput.focus();
          modelSearchInput.select();
        }, 50);
      } else if (e.key === 'Escape') {
        closeAllPopovers();
      }
    });

    // Model Search Filtering
    modelSearchInput.addEventListener('input', () => {
      const val = modelSearchInput.value.trim();
      btnClearModelSearch.style.display = val ? 'block' : 'none';
      renderModelCategories(cachedGroupedModels, val);
    });

    btnClearModelSearch.addEventListener('click', () => {
      modelSearchInput.value = '';
      btnClearModelSearch.style.display = 'none';
      renderModelCategories(cachedGroupedModels, '');
      modelSearchInput.focus();
    });

    function renderModelCategories(grouped, filterText = '') {
      modelCategoriesContainer.innerHTML = '';
      const filterLower = filterText.toLowerCase();

      const categoryLabels = {
        favorites: 'Favorites ★',
        adaptive: 'Adaptive',
        recently_used: 'Recently Used',
        recommended: 'Recommended',
        local: 'Local Models (Ollama)',
        cloud: 'Cloud Models',
      };

      const providerIcons = {
        ollama: '🦙',
        anthropic: ' Claude',
        openai: ' OpenAI',
        gemini: ' Gemini',
        custom: '🔌',
      };

      let totalRendered = 0;

      for (const [catKey, label] of Object.entries(categoryLabels)) {
        const list = grouped[catKey] || [];
        const filteredList = list.filter(m => {
          if (!filterLower) return true;
          return m.name.toLowerCase().includes(filterLower) ||
            m.providerName.toLowerCase().includes(filterLower) ||
            (m.family && m.family.toLowerCase().includes(filterLower));
        });

        if (filteredList.length === 0) continue;

        const catHeader = document.createElement('div');
        catHeader.className = 'model-category-header';
        catHeader.textContent = label;
        modelCategoriesContainer.appendChild(catHeader);

        for (const m of filteredList) {
          totalRendered++;
          const row = document.createElement('div');
          const isSelected = m.id === cachedConfig.modelId || m.rawName === cachedConfig.modelId;
          row.className = 'model-item-row' + (isSelected ? ' selected' : '');
          
          const icon = providerIcons[m.provider] || '⚡';
          const isFav = m.category === 'favorite' || m.isFavorite;

          row.innerHTML = 
            '<div class="model-item-icon">' + icon + '</div>' +
            '<div class="model-item-info">' +
              '<div class="model-item-name-row">' +
                '<span class="model-item-name">' + escapeHtml(m.name) + '</span>' +
                (m.isLocal ? '<span class="model-tag local">Local</span>' : '') +
                (m.isNew ? '<span class="model-tag new">New</span>' : '') +
                (m.isFree ? '<span class="model-tag free">Free</span>' : '') +
              '</div>' +
              '<div class="model-item-meta-row">' +
                '<span class="status-dot-available"></span>' +
                '<span>' + (m.defaultEffort ? m.defaultEffort.charAt(0).toUpperCase() + m.defaultEffort.slice(1) : 'Medium') + '</span>' +
                '<span>•</span>' +
                '<span>' + (m.contextWindowLabel || '32k') + '</span>' +
                (m.parameterSize ? '<span>• ' + escapeHtml(m.parameterSize) + '</span>' : '') +
              '</div>' +
            '</div>' +
            '<button class="model-fav-btn' + (isFav ? ' is-fav' : '') + '" title="' + (isFav ? 'Remove Favorite' : 'Pin Favorite') + '">' +
              (isFav ? '★' : '☆') +
            '</button>' +
            (isSelected ? '<div class="model-check">✓</div>' : '<div class="model-check"></div>');

          row.addEventListener('click', (e) => {
            if (e.target.closest('.model-fav-btn')) return;
            selectModelItem(m);
            closeAllPopovers();
          });

          const favBtn = row.querySelector('.model-fav-btn');
          favBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'toggleFavorite', modelId: m.id });
          });

          modelCategoriesContainer.appendChild(row);
        }
      }

      if (totalRendered === 0) {
        modelCategoriesContainer.innerHTML = '<div style="padding: 24px; text-align: center; color: #64748b; font-size: 12px;">No models found matching "' + escapeHtml(filterText) + '"</div>';
      }
    }

    function selectModelItem(m) {
      cachedConfig.modelId = m.id;
      cachedConfig.modelName = m.name;
      activeModelLabel.textContent = m.name;
      cfgActiveModelName.textContent = m.name;
      const providerIcons = {
        ollama: '🦙',
        anthropic: ' Claude',
        openai: ' OpenAI',
        gemini: ' Gemini',
        custom: '🔌',
      };
      modelProviderIcon.textContent = providerIcons[m.provider] || '⚡';
      if (m.isLocal) {
        cfgResourceTitle.textContent = 'Local Model (Ollama)';
        cfgResourceDesc.textContent = '100% On-Device / No API billing';
      } else {
        cfgResourceTitle.textContent = m.providerName + ' API';
        cfgResourceDesc.textContent = (m.contextWindowLabel || '200k') + ' context window';
      }
      vscode.postMessage({ command: 'selectModel', modelId: m.id, modelName: m.name, provider: m.provider });
    }

    // Execution Mode Handling
    document.querySelectorAll('#execModePopover .popover-card-option[data-exec]').forEach((opt) => {
      opt.addEventListener('click', () => {
        const mode = opt.getAttribute('data-exec');
        setExecutionModeUI(mode);
        vscode.postMessage({ command: 'setExecutionMode', executionMode: mode });
        closeAllPopovers();
      });
    });

    function setExecutionModeUI(mode) {
      cachedConfig.executionMode = mode;
      document.querySelectorAll('#execModePopover .popover-card-option[data-exec]').forEach((el) => {
        el.classList.toggle('active', el.getAttribute('data-exec') === mode);
      });
      const labels = {
        code: '</> Code',
        smart: '✦ Smart',
        ask: '💬 Ask',
        plan: '📋 Plan',
      };
      execModeLabel.textContent = labels[mode] || '</> Code';
    }

    // Permission Mode Handling
    document.querySelectorAll('#permModePopover .popover-card-option[data-perm], #execModePopover .popover-card-option[data-perm]').forEach((opt) => {
      opt.addEventListener('click', () => {
        const mode = opt.getAttribute('data-perm');
        setPermissionModeUI(mode);
        vscode.postMessage({ command: 'setPermissionMode', permissionMode: mode });
        closeAllPopovers();
      });
    });

    function setPermissionModeUI(mode) {
      cachedConfig.permissionMode = mode;
      document.querySelectorAll('#permModePopover .popover-card-option[data-perm]').forEach((el) => {
        el.classList.toggle('active', el.getAttribute('data-perm') === mode);
      });
      const bypassOpt = document.getElementById('optBypassPerms');
      if (bypassOpt) {
        bypassOpt.classList.toggle('active', mode === 'bypass');
      }
      const labels = {
        ask: '🛡 Ask Before Actions',
        smart: '🛡 Smart Approval',
        bypass: '🛡 Bypass Permissions',
      };
      permModeLabel.textContent = labels[mode] || '🛡 Smart Approval';
    }

    // Reasoning Effort Handling
    document.querySelectorAll('.effort-seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const effort = btn.getAttribute('data-effort');
        document.querySelectorAll('.effort-seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        cachedConfig.reasoningEffort = effort;
        activeEffortLabel.textContent = effort.charAt(0).toUpperCase() + effort.slice(1).replace('_', ' ');
        vscode.postMessage({ command: 'setReasoningEffort', effort });
      });
    });

    chkFastMode.addEventListener('change', () => {
      cachedConfig.fastMode = chkFastMode.checked;
      vscode.postMessage({ command: 'setFastMode', fastMode: chkFastMode.checked });
    });

    // Attachment Actions
    document.querySelectorAll('#attachMenuPopover .popover-menu-item').forEach((item) => {
      item.addEventListener('click', () => {
        const action = item.getAttribute('data-action');
        closeAllPopovers();
        if (action === 'attachFiles') {
          vscode.postMessage({ command: 'attachFiles' });
        } else if (action === 'quickFile') {
          vscode.postMessage({ command: 'quickFile' });
        } else if (action === 'quickDirectory') {
          vscode.postMessage({ command: 'quickDirectory' });
        } else if (action === 'attachGit') {
          vscode.postMessage({ command: 'attachGit' });
        } else if (action === 'openMcp') {
          vscode.postMessage({ command: 'openMcp' });
        } else if (action === 'openRules') {
          vscode.postMessage({ command: 'openRules' });
        } else if (action === 'openSkills') {
          vscode.postMessage({ command: 'openSkills' });
        } else if (action === 'attachTerminal') {
          vscode.postMessage({ command: 'attachTerminal' });
        } else if (action === 'attachCodemap') {
          vscode.postMessage({ command: 'attachCodemap' });
        }
      });
    });

    function renderAttachedChips(attachedFiles = []) {
      if (!attachedChipsRow) return;
      if (!attachedFiles || attachedFiles.length === 0) {
        attachedChipsRow.style.display = 'none';
        attachedChipsRow.innerHTML = '';
        return;
      }
      attachedChipsRow.style.display = 'flex';
      attachedChipsRow.innerHTML = '';
      for (const filePath of attachedFiles) {
        const chip = document.createElement('div');
        chip.className = 'attached-chip';
        const isSpecial = filePath.includes(':');
        const icon = isSpecial ? '⚡' : '📄';
        const label = isSpecial ? filePath : filePath.split('/').pop() || filePath;
        chip.innerHTML = 
          '<span>' + icon + '</span>' +
          '<span>' + escapeHtml(label) + '</span>' +
          '<span class="attached-chip-remove" data-path="' + escapeHtml(filePath) + '" title="Remove">✕</span>';

        chip.querySelector('.attached-chip-remove').addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'removeAttachment', filePath });
        });

        attachedChipsRow.appendChild(chip);
      }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'loadSession':
          currentSession = msg.session;
          allSessionsList = msg.allSessions || [];
          if (msg.workspaceName) {
            topWorkspacePill.textContent = '🗁 ' + msg.workspaceName;
            promptWorkspaceLabel.textContent = msg.workspaceName;
          }
          if (msg.currentConfig) {
            cachedConfig = Object.assign({}, cachedConfig, msg.currentConfig);
            if (msg.permissionMode) cachedConfig.permissionMode = msg.permissionMode;
            activeModelLabel.textContent = cachedConfig.modelName || cachedConfig.modelId || 'qwen3.8:27b';
            cfgActiveModelName.textContent = activeModelLabel.textContent;
            setExecutionModeUI(cachedConfig.executionMode || 'code');
            setPermissionModeUI(cachedConfig.permissionMode || 'smart');
            if (cachedConfig.reasoningEffort) {
              document.querySelectorAll('.effort-seg-btn').forEach(b => {
                b.classList.toggle('active', b.getAttribute('data-effort') === cachedConfig.reasoningEffort);
              });
              activeEffortLabel.textContent = cachedConfig.reasoningEffort.charAt(0).toUpperCase() + cachedConfig.reasoningEffort.slice(1).replace('_', ' ');
            }
            chkFastMode.checked = !!cachedConfig.fastMode;
            renderAttachedChips(cachedConfig.attachedFiles || []);
          }
          if (msg.modelsGrouped) {
            cachedGroupedModels = msg.modelsGrouped;
            renderModelCategories(cachedGroupedModels, modelSearchInput.value.trim());
          }
          if (currentSession) {
            topSessionTitle.textContent = currentSession.title;
            isWorking = currentSession.status === 'running';
            activePlan = currentSession.plan || [];
            renderFullConversation();
          }
          renderSessionsList();
          if (msg.changesSummary) {
            currentChanges = msg.changesSummary;
            renderChangesList();
          }
          updateStatusUI();
          break;

        case 'modelsGroupedResponse':
          if (msg.modelsGrouped) {
            cachedGroupedModels = msg.modelsGrouped;
            renderModelCategories(cachedGroupedModels, msg.query || '');
          }
          break;

        case 'changesSummary':
          currentChanges = msg.summary;
          renderChangesList();
          break;

        case 'fileDiffResponse':
          if (msg.path === selectedDiffFile) {
            renderDiffCode(msg.diff);
          }
          break;

        case 'addMessage':
          if (currentSession) {
            currentSession.messages.push(msg.message);
            renderFullConversation();
          }
          break;

        case 'planUpdate':
          activePlan = msg.plan || [];
          renderFullConversation();
          break;

        case 'activity':
          renderFullConversation();
          break;

        case 'approvalRequest':
          renderApprovalPrompt(msg.request);
          break;

        case 'focusPrompt':
          if (promptInput) {
            promptInput.focus();
          }
          break;
      }
    });

    function renderApprovalPrompt(req) {
      const card = document.createElement('div');
      card.className = 'approval-card';
      card.innerHTML = '<div style="font-weight:700;color:#f59e0b;font-size:12.5px;">⚠️ Security Approval Required</div>' +
        '<div style="font-size:12px;color:#f1f5f9;">' + escapeHtml(req.description) + '</div>' +
        '<div style="font-family:monospace;font-size:11.5px;background:rgba(0,0,0,0.4);padding:6px 10px;border-radius:4px;color:#38bdf8;">' +
        escapeHtml(req.tool || req.toolName || 'tool') + ' ' + escapeHtml(JSON.stringify(req.args || req.params || {})) +
        '</div>' +
        '<div class="approval-actions" style="display:flex;gap:8px;margin-top:6px;">' +
        '<button class="btn-action-sm btn-accept" id="btnApprove_' + req.id + '">Approve Action</button>' +
        '<button class="btn-action-sm btn-reject" id="btnReject_' + req.id + '">Reject Action</button>' +
        '</div>';

      conversationFlow.appendChild(card);
      scrollContainer.scrollTop = scrollContainer.scrollHeight;

      document.getElementById('btnApprove_' + req.id).addEventListener('click', () => {
        card.remove();
        vscode.postMessage({ command: 'resolveApproval', requestId: req.id, approved: true });
      });
      document.getElementById('btnReject_' + req.id).addEventListener('click', () => {
        card.remove();
        vscode.postMessage({ command: 'resolveApproval', requestId: req.id, approved: false });
      });
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function formatMarkdown(text) {
      if (!text) return '';
      let html = escapeHtml(text);
      // Code blocks
      const codeBlockRegex = new RegExp(String.fromCharCode(96, 96, 96) + '([\\\\s\\\\S]*?)' + String.fromCharCode(96, 96, 96), 'g');
      html = html.replace(codeBlockRegex, (match, p1) => {
        return '<pre><code>' + p1.trim() + '</code></pre>';
      });
      // Inline code
      const tick = String.fromCharCode(96);
      const parts = html.split(tick);
      if (parts.length > 1) {
        html = parts.map((part, index) => {
          if (index % 2 === 1) {
            return '<code>' + part + '</code>';
          }
          return part;
        }).join('');
      }
      // Bold
      html = html.replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>');
      // Linebreaks
      html = html.replace(/\\n/g, '<br/>');
      return html;
    }
  </script>
</body>
</html>`;
  }
}
