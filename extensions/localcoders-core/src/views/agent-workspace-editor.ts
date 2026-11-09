import * as vscode from 'vscode';
import * as path from 'path';
import { AgentOrchestrator } from '../agents/orchestrator';
import { AgentMessage, TaskPlanItem, ToolApprovalRequest } from '../agents/types';
import { SessionManager, SessionData, ExecutionGroup } from '../sessions/session-manager';
import { OllamaClient } from '../ollama/client';

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
    ollama: OllamaClient
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
      ollama
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
    private readonly ollama: OllamaClient
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

    // Orchestrator events
    this.orchestrator.onMessage((msg) => {
      this._panel.webview.postMessage({ type: 'addMessage', message: msg });
      this.sessionManager.updateActiveSession((s) => {
        s.messages.push(msg);
      });
      this.updateTitle();
    });

    this.orchestrator.onActivity((ev) => {
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
              await this.orchestrator.submitTask(text);
              this.sessionManager.updateActiveSession((s) => {
                s.status = 'completed';
              });
            } catch (err: any) {
              this.sessionManager.updateActiveSession((s) => {
                s.status = 'failed';
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

          case 'openChanges':
            vscode.commands.executeCommand('localcoders.changesView.focus');
            break;

          case 'openFile': {
            const uri = vscode.Uri.file(data.path);
            vscode.window.showTextDocument(uri);
            break;
          }

          case 'selectModel': {
            const models = await this.ollama.listModels();
            if (models.length === 0) {
              vscode.window.showWarningMessage('No local Ollama models installed.');
              return;
            }
            const picked = await vscode.window.showQuickPick(
              models.map((m) => ({ label: m.name, description: m.details?.parameter_size })),
              { placeHolder: 'Select model for coding agent' }
            );
            if (picked) {
              this.sessionManager.updateActiveSession((s) => {
                s.model = picked.label;
              });
              this.syncActiveSession();
            }
            break;
          }

          case 'newSession': {
            const models = await this.ollama.listModels();
            const model = models[0]?.name || 'qwen3.8:27b';
            this.sessionManager.createSession('New Session', model);
            this.syncActiveSession();
            break;
          }
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

  public syncActiveSession(): void {
    if (!this._panel) return;
    const session = this.sessionManager.getActiveSession();
    const allSessions = this.sessionManager.getAllSessions();
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name || 'LocalCoders';
    this._panel.webview.postMessage({
      type: 'loadSession',
      session,
      allSessions,
      workspaceName,
    });
    this.updateTitle();
  }

  public dispose(): void {
    AgentWorkspaceEditorPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }

  private _update(): void {
    this._panel.webview.html = this._getHtmlForWebview();
  }

  private _getHtmlForWebview(): string {
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
      --input-bg: rgba(24, 24, 27, 0.85);
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
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      user-select: text;
    }

    /* Top Session Bar */
    .top-session-bar {
      height: 44px;
      min-height: 44px;
      padding: 0 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      background: rgba(18, 18, 20, 0.8);
      backdrop-filter: blur(8px);
      z-index: 20;
    }
    .session-title-wrap {
      display: flex;
      align-items: center;
      gap: 10px;
      overflow: hidden;
    }
    .session-icon {
      color: var(--accent);
      font-size: 15px;
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
      gap: 10px;
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

    /* Scrollable Conversation Workspace */
    .workspace-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 28px 24px 140px 24px;
      display: flex;
      flex-direction: column;
      align-items: center;
      position: relative;
    }
    .workspace-container {
      width: 100%;
      max-width: 860px;
      display: flex;
      flex-direction: column;
      gap: 20px;
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
      max-width: 80%;
      color: #f8fafc;
      font-size: 14px;
      line-height: 1.5;
    }
    .message-agent-wrap {
      display: flex;
      gap: 14px;
      width: 100%;
    }
    .agent-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: linear-gradient(135deg, #0284c7, #38bdf8);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #ffffff;
      font-weight: 700;
      font-size: 13px;
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
      font-size: 13.5px;
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
      font-size: 14px;
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
      font-size: 12.5px;
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
      border-radius: 10px;
      overflow: hidden;
      margin: 6px 0;
      transition: border-color 0.15s ease;
    }
    .execution-group-card:hover {
      border-color: rgba(255, 255, 255, 0.16);
    }
    .execution-header {
      padding: 10px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      user-select: none;
      background: rgba(255, 255, 255, 0.02);
      font-size: 12.5px;
      color: var(--text-muted);
      font-weight: 500;
    }
    .execution-header:hover {
      background: rgba(255, 255, 255, 0.05);
      color: #e2e8f0;
    }
    .execution-title {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .execution-chevron {
      transition: transform 0.2s ease;
      font-size: 11px;
    }
    .execution-body {
      padding: 12px 16px;
      border-top: 1px solid var(--card-border);
      display: flex;
      flex-direction: column;
      gap: 12px;
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
      padding: 8px 12px;
      border-radius: 6px;
      border-left: 3px solid #38bdf8;
    }
    .thought-block {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      background: rgba(24, 24, 27, 0.5);
      overflow: hidden;
    }
    .thought-header {
      padding: 8px 12px;
      font-size: 11.5px;
      color: #a1a1aa;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      user-select: none;
      background: rgba(255, 255, 255, 0.03);
    }
    .thought-header:hover {
      color: #f4f4f5;
    }
    .thought-content {
      padding: 10px 14px;
      font-size: 12.5px;
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
      border-radius: 10px;
      padding: 14px 18px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .plan-header {
      font-size: 11.5px;
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
      gap: 6px;
    }
    .plan-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 6px;
      font-size: 13px;
    }
    .plan-item.completed {
      color: #94a3b8;
      text-decoration: line-through;
    }
    .plan-badge {
      font-size: 10.5px;
      padding: 2px 7px;
      border-radius: 4px;
      font-weight: 600;
    }
    .plan-pending { background: rgba(255, 255, 255, 0.08); color: #a1a1aa; }
    .plan-in_progress { background: rgba(56, 189, 248, 0.2); color: #38bdf8; }
    .plan-completed { background: rgba(34, 197, 94, 0.2); color: #4ade80; }

    /* Approval Card */
    .approval-card {
      border: 1px solid rgba(245, 158, 11, 0.4);
      background: rgba(245, 158, 11, 0.08);
      border-radius: 10px;
      padding: 14px 18px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .approval-actions {
      display: flex;
      gap: 10px;
    }
    .btn-approve {
      background: #22c55e;
      color: #ffffff;
      border: none;
      border-radius: 6px;
      padding: 6px 14px;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-reject {
      background: rgba(239, 68, 68, 0.2);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.4);
      border-radius: 6px;
      padding: 6px 14px;
      font-size: 12.5px;
      cursor: pointer;
    }

    /* Status indicator */
    .status-indicator-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12.5px;
      color: var(--text-muted);
      margin-top: 6px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #f59e0b;
    }
    .status-dot.pulsing {
      background: #38bdf8;
      box-shadow: 0 0 10px #38bdf8;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.3); opacity: 0.6; }
    }
    .tip-text {
      font-size: 11.5px;
      color: #64748b;
      margin-top: 4px;
    }

    /* Floating Bottom Prompt Bar (Devin Style) */
    .floating-prompt-bar {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      width: calc(100% - 48px);
      max-width: 860px;
      background: rgba(22, 22, 26, 0.95);
      backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      z-index: 50;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .floating-prompt-bar:focus-within {
      border-color: rgba(56, 189, 248, 0.5);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6), 0 0 20px rgba(56, 189, 248, 0.15);
    }
    .prompt-textarea {
      width: 100%;
      min-height: 44px;
      max-height: 180px;
      background: transparent;
      border: none;
      outline: none;
      color: #f1f5f9;
      font-family: inherit;
      font-size: 14px;
      line-height: 1.5;
      resize: none;
    }
    .prompt-controls-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      padding-top: 8px;
    }
    .prompt-left-tools {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tool-btn {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.04);
      color: #94a3b8;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.15s ease;
    }
    .tool-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #f1f5f9;
    }
    .code-context-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 12px;
      color: #cbd5e1;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .prompt-right-tools {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .model-selector-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 6px;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.3);
      color: #38bdf8;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .model-selector-pill:hover {
      background: rgba(56, 189, 248, 0.2);
    }
    .btn-send {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #38bdf8;
      border: none;
      color: #0f172a;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 15px;
      font-weight: 700;
      transition: all 0.15s ease;
    }
    .btn-send:hover {
      background: #7dd3fc;
      transform: scale(1.05);
    }
    .btn-stop {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #ef4444;
      border: none;
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 14px;
    }
  </style>
</head>
<body>

  <!-- Top Session Bar -->
  <div class="top-session-bar">
    <div class="session-title-wrap">
      <span class="session-icon">💬</span>
      <span class="session-title" id="topSessionTitle">Viết lại tài liệu dự án theo mẫu.zip và sắp xếp vào thư mục docs</span>
      <span class="workspace-pill" id="topWorkspacePill">🗁 rateprofcuaban</span>
    </div>
    <div class="top-actions">
      <span class="status-badge status-ready" id="topStatusBadge">Ready</span>
    </div>
  </div>

  <!-- Central Conversation Workspace -->
  <div class="workspace-scroll" id="scrollContainer">
    <div class="workspace-container" id="conversationFlow">
      <!-- Dynamically injected messages, expandable execution groups, plans -->
    </div>
  </div>

  <!-- Floating Bottom Prompt Bar -->
  <div class="floating-prompt-bar">
    <textarea class="prompt-textarea" id="promptInput" rows="1" placeholder="Ask anything, @ to mention, / for actions... (Enter to send, Shift+Enter for newline)"></textarea>
    <div class="prompt-controls-row">
      <div class="prompt-left-tools">
        <button class="tool-btn" id="btnAttachment" title="Add File / Context">+</button>
        <div class="code-context-pill">
          <span>&lt;/&gt; Code</span>
          <span id="promptWorkspaceLabel">rateprofcuaban</span>
        </div>
      </div>
      <div class="prompt-right-tools">
        <div class="model-selector-pill" id="modelSelector" title="Change Ollama Model">
          <span id="activeModelLabel">qwen3.8:27b</span>
          <span>▾</span>
        </div>
        <button class="tool-btn" title="Voice Input">🎙</button>
        <button class="btn-send" id="btnSend" title="Send Prompt (Enter)">↑</button>
        <button class="btn-stop" id="btnStop" style="display:none;" title="Stop Execution">■</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    let currentSession = null;
    let activePlan = [];
    let isWorking = false;

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

    // Auto-expand textarea
    promptInput.addEventListener('input', () => {
      promptInput.style.height = 'auto';
      promptInput.style.height = Math.min(promptInput.scrollHeight, 180) + 'px';
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
      vscode.postMessage({ command: 'openChanges' });
    });

    function submitPrompt() {
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

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'loadSession':
          currentSession = msg.session;
          if (msg.workspaceName) {
            topWorkspacePill.textContent = '🗁 ' + msg.workspaceName;
            promptWorkspaceLabel.textContent = msg.workspaceName;
          }
          if (currentSession) {
            topSessionTitle.textContent = currentSession.title;
            activeModelLabel.textContent = currentSession.model || 'qwen3.8:27b';
            isWorking = currentSession.status === 'running';
            activePlan = currentSession.plan || [];
            renderFullConversation();
          }
          updateStatusUI();
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
      }
    });

    function renderFullConversation() {
      conversationFlow.innerHTML = '';

      if (!currentSession || currentSession.messages.length === 0) {
        const welcome = document.createElement('div');
        welcome.className = 'agent-content-area';
        welcome.innerHTML = '<div class="agent-text" style="color: #94a3b8; text-align: center; margin-top: 40px;">LocalCoders multi-agent IDE ready. Type instructions below to begin an autonomous coding task.</div>';
        conversationFlow.appendChild(welcome);
        return;
      }

      currentSession.messages.forEach((m) => {
        if (m.senderRole === 'user') {
          const userCard = document.createElement('div');
          userCard.className = 'message-card user';
          userCard.innerHTML = '<div class="message-user-bubble">' + escapeHtml(m.content) + '</div>';
          conversationFlow.appendChild(userCard);
        } else {
          const agentCard = document.createElement('div');
          agentCard.className = 'message-card';
          agentCard.innerHTML = \`
            <div class="message-agent-wrap">
              <div class="agent-avatar">LC</div>
              <div class="agent-content-area">
                <div class="agent-header">
                  <span class="agent-name">\${escapeHtml(m.senderName || 'Main Agent')}</span>
                  <span class="agent-role-pill">\${escapeHtml(m.senderRole || 'coordinator')}</span>
                </div>
                <div class="agent-text">\${formatMarkdown(m.content)}</div>
              </div>
            </div>
          \`;
          conversationFlow.appendChild(agentCard);
        }
      });

      // Render Execution Groups if any
      if (currentSession.executionGroups && currentSession.executionGroups.length > 0) {
        currentSession.executionGroups.forEach((group, idx) => {
          const card = document.createElement('div');
          card.className = 'execution-group-card';
          const isLast = idx === currentSession.executionGroups.length - 1;
          const open = isLast ? 'v' : '>';
          card.innerHTML = \`
            <div class="execution-header" onclick="this.parentElement.querySelector('.execution-body').style.display = this.parentElement.querySelector('.execution-body').style.display === 'none' ? 'flex' : 'none'">
              <div class="execution-title">
                <span class="execution-chevron">\${open}</span>
                <span>Worked for \${group.duration || '42s'}</span>
              </div>
              <span>\${group.activities ? group.activities.length : 0} actions</span>
            </div>
            <div class="execution-body" style="display: \${isLast ? 'flex' : 'none'};">
              \${(group.activities || []).map(a => \`
                <div class="cmd-row">
                  <span>$</span>
                  <span>\${escapeHtml(a.summary || a.command || 'Executed task')}</span>
                </div>
                \${a.thoughts ? \`
                  <div class="thought-block">
                    <div class="thought-header">Thoughts ▾</div>
                    <div class="thought-content">\${escapeHtml(a.thoughts)}</div>
                  </div>
                \` : ''}
              \`).join('')}
            </div>
          \`;
          conversationFlow.appendChild(card);
        });
      }

      // Render Plan if active
      if (activePlan && activePlan.length > 0) {
        const planCard = document.createElement('div');
        planCard.className = 'plan-card';
        planCard.innerHTML = \`
          <div class="plan-header">
            <span>LIVE EXECUTION PLAN</span>
            <span>\${activePlan.filter(p => p.status === 'completed').length}/\${activePlan.length} COMPLETED</span>
          </div>
          <ul class="plan-list">
            \${activePlan.map((item, idx) => \`
              <li class="plan-item \${item.status}">
                <span>\${idx + 1}. \${escapeHtml(item.description)}</span>
                <span class="plan-badge plan-\${item.status}">\${item.status.toUpperCase()}</span>
              </li>
            \`).join('')}
          </ul>
        \`;
        conversationFlow.appendChild(planCard);
      }

      // Status indicator row
      const statusRow = document.createElement('div');
      statusRow.className = 'status-indicator-row';
      statusRow.innerHTML = \`
        <span class="status-dot \${isWorking ? 'pulsing' : ''}"></span>
        <span>\${isWorking ? 'LocalCoders is executing instructions...' : 'LocalCoders is awaiting instructions'}</span>
      \`;
      conversationFlow.appendChild(statusRow);

      const tip = document.createElement('div');
      tip.className = 'tip-text';
      tip.textContent = 'Tip: Switch between Agents View and IDE View anytime with Ctrl+Shift+A or the top-left mode button.';
      conversationFlow.appendChild(tip);

      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function formatMarkdown(text) {
      if (!text) return '';
      let html = escapeHtml(text);
      const b3 = String.fromCharCode(96, 96, 96);
      const b1 = String.fromCharCode(96);
      html = html.split(b3).map((chunk, i) => {
        if (i % 2 === 1) {
          return '<pre><code>' + chunk + '</code></pre>';
        }
        return chunk.split(b1).map((sub, j) => {
          if (j % 2 === 1) {
            return '<code>' + sub + '</code>';
          }
          return sub.replace(/\n/g, '<br/>');
        }).join('');
      }).join('');
      return html;
    }
  </script>
</body>
</html>`;
  }
}
