import * as vscode from 'vscode';
import * as path from 'path';
import { AgentOrchestrator } from '../agents/orchestrator';
import { AgentMessage, TaskPlanItem, ToolApprovalRequest } from '../agents/types';
import { SessionManager, SessionData, ExecutionGroup } from '../sessions/session-manager';
import { OllamaClient } from '../ollama/client';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'localcoders.chatView';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly orchestrator: AgentOrchestrator,
    private readonly sessionManager: SessionManager,
    private readonly ollama: OllamaClient
  ) {
    // Listen for events from orchestrator
    this.orchestrator.onMessage((msg) => {
      this._view?.webview.postMessage({ type: 'addMessage', message: msg });
      this.sessionManager.updateActiveSession((s) => {
        s.messages.push(msg);
      });
    });

    this.orchestrator.onActivity((ev) => {
      this._view?.webview.postMessage({ type: 'activity', event: ev });
    });

    this.orchestrator.onPlanUpdate((plan) => {
      this._view?.webview.postMessage({ type: 'planUpdate', plan });
      this.sessionManager.updateActiveSession((s) => {
        s.plan = plan;
      });
    });

    this.orchestrator.onApproval((req) => {
      this._view?.webview.postMessage({ type: 'approvalRequest', request: req });
    });

    this.sessionManager.onDidChangeSessions(() => {
      this.syncActiveSession();
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.command) {
        case 'sendMessage': {
          const text = data.text?.trim();
          if (!text) return;

          // If no active session, create one
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
          this._view?.webview.postMessage({ type: 'addMessage', message: userMsg });

          try {
            await this.orchestrator.submitTask(text);
            this.sessionManager.updateActiveSession((s) => {
              s.status = 'completed';
            });
          } catch (err: any) {
            this.sessionManager.updateActiveSession((s) => {
              s.status = 'failed';
            });
            console.error('[LocalCoders] Task execution error:', err.message);
            this._view?.webview.postMessage({
              type: 'addMessage',
              message: {
                id: `err_${Date.now()}`,
                senderId: 'system',
                senderName: 'System',
                senderRole: 'assistant',
                content: `⚠️ **Task Warning / Error**: ${err.message}`,
                timestamp: Date.now(),
              },
            });
          }
          break;
        }

        case 'newSession':
        case 'newSection': {
          const models = await this.ollama.listModels();
          const model = models[0]?.name || 'qwen3.8:27b';
          this.sessionManager.createSession('New Section', model);
          this.syncActiveSession();
          break;
        }

        case 'switchSection': {
          if (data.sessionId) {
            this.sessionManager.switchSession(data.sessionId);
            this.syncActiveSession();
          }
          break;
        }

        case 'renameSection': {
          const s = this.sessionManager.getSession(data.sessionId);
          if (s) {
            const newTitle = await vscode.window.showInputBox({
              prompt: 'Rename Chat Section',
              value: s.title || '',
            });
            if (newTitle && newTitle.trim()) {
              this.sessionManager.renameSession(data.sessionId, newTitle.trim());
              this.syncActiveSession();
            }
          }
          break;
        }

        case 'deleteSection': {
          const s = this.sessionManager.getSession(data.sessionId);
          const confirm = await vscode.window.showWarningMessage(
            `Delete section "${s?.title || 'this section'}"?`,
            { modal: true },
            'Delete'
          );
          if (confirm === 'Delete') {
            this.sessionManager.deleteSession(data.sessionId);
            this.syncActiveSession();
          }
          break;
        }

        case 'selectWorkspace': {
          vscode.commands.executeCommand('vscode.openFolder');
          break;
        }

        case 'resolveApproval': {
          this.orchestrator.resolveApproval(data.requestId, data.approved);
          break;
        }

        case 'cancelTask': {
          this.orchestrator.cancelTask();
          this.sessionManager.updateActiveSession((s) => {
            s.status = 'idle';
          });
          break;
        }

        case 'selectModel': {
          const models = await this.ollama.listModels();
          if (models.length === 0) {
            vscode.window.showWarningMessage('No Ollama models found. Open Model Manager to pull a model.');
            return;
          }
          const picked = await vscode.window.showQuickPick(
            models.map((m) => ({ label: m.name, description: m.details?.parameter_size || '' })),
            { placeHolder: 'Select active model for Main Agent' }
          );
          if (picked) {
            this.sessionManager.updateActiveSession((s) => {
              s.model = picked.label;
            });
            this.syncActiveSession();
          }
          break;
        }

        case 'showMoreOptions': {
          const items = [
            { label: '$(add) New Section', action: 'newSection' },
            { label: '$(edit) Rename Active Section', action: 'renameActive' },
            { label: '$(hubot) Select Model', action: 'selectModel' },
            { label: '$(clear-all) Clear Active Messages', action: 'clearActive' },
            { label: '$(trash) Delete Active Section', action: 'deleteActive' },
          ];
          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Chat Section Options',
          });
          if (picked) {
            if (picked.action === 'newSection') {
              const models = await this.ollama.listModels();
              const model = models[0]?.name || 'qwen3.8:27b';
              this.sessionManager.createSession('New Section', model);
              this.syncActiveSession();
            } else if (picked.action === 'renameActive') {
              const active = this.sessionManager.getActiveSession();
              if (active) {
                const newTitle = await vscode.window.showInputBox({
                  prompt: 'Rename Active Section',
                  value: active.title || '',
                });
                if (newTitle && newTitle.trim()) {
                  this.sessionManager.renameSession(active.id, newTitle.trim());
                  this.syncActiveSession();
                }
              }
            } else if (picked.action === 'selectModel') {
              vscode.commands.executeCommand('localcoders.selectModel');
            } else if (picked.action === 'clearActive') {
              this.sessionManager.updateActiveSession((s) => {
                s.messages = [];
                s.plan = [];
                s.status = 'idle';
              });
              this.syncActiveSession();
            } else if (picked.action === 'deleteActive') {
              const active = this.sessionManager.getActiveSession();
              if (active) {
                this.sessionManager.deleteSession(active.id);
                this.syncActiveSession();
              }
            }
          }
          break;
        }

        case 'openChanges':
          vscode.commands.executeCommand('localcoders.changesView.focus');
          break;

        case 'openFile': {
          const uri = vscode.Uri.file(data.path);
          vscode.window.showTextDocument(uri);
          break;
        }

        case 'openWizard':
          vscode.commands.executeCommand('localcoders.openSetupWizard');
          break;
      }
    });

    this.syncActiveSession();
  }

  public syncActiveSession() {
    if (!this._view) return;
    const session = this.sessionManager.getActiveSession();
    const allSessions = this.sessionManager.getAllSessions();
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name || 'No Project';
    this._view.webview.postMessage({
      type: 'loadSession',
      session,
      allSessions,
      workspaceName,
    });
  }

  private _getHtmlForWebview(): string {
    const username = process.env.USER || process.env.USERNAME || 'developer';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg: var(--vscode-editor-background, #181818);
      --fg: var(--vscode-editor-foreground, #e5e5e5);
      --card-bg: var(--vscode-sideBar-background, #1e1e1e);
      --border: var(--vscode-widget-border, #2a2a2a);
      --hover-bg: var(--vscode-list-hoverBackground, #262626);
      --input-bg: var(--vscode-input-background, #141414);
      --accent: #38bdf8;
      --accent-muted: rgba(56, 189, 248, 0.15);
      --success: #22c55e;
      --danger: #ef4444;
      --warning: #f59e0b;
      --text-muted: #888888;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      font-size: 13px;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* 1. Header */
    .header-bar {
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      background: var(--card-bg);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-shrink: 0;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 8px;
      overflow: hidden;
    }
    .session-title-label {
      font-weight: 600;
      font-size: 13px;
      color: var(--fg);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 180px;
    }
    .header-pills {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .pill {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 1px solid transparent;
      transition: all 0.15s ease;
    }
    .pill:hover {
      border-color: var(--border);
      color: var(--fg);
    }
    .pill-project {
      color: var(--accent);
      background: var(--accent-muted);
    }
    .pill-status {
      font-weight: 600;
      color: var(--success);
      background: rgba(34, 197, 94, 0.15);
    }
    .pill-working {
      color: var(--accent);
      background: var(--accent-muted);
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    /* 2. Chat Feed */
    #chat-container {
      flex: 1;
      overflow-y: auto;
      padding: 16px 14px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* Welcome Screen in Antigravity Style */
    .empty-welcome {
      margin: auto;
      text-align: center;
      max-width: 320px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      color: var(--text-muted);
      padding: 24px 12px;
    }
    .welcome-logo-container {
      width: 60px;
      height: 60px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .welcome-logo-svg {
      width: 52px;
      height: 52px;
      filter: drop-shadow(0 0 16px rgba(56, 189, 248, 0.45));
    }
    .welcome-title {
      font-size: 18px;
      font-weight: 500;
      color: var(--fg);
      letter-spacing: -0.3px;
      line-height: 1.35;
    }

    /* Message rows */
    .msg-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: 100%;
    }
    .msg-user {
      align-self: flex-end;
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.25);
      border-radius: 10px 10px 2px 10px;
      padding: 9px 13px;
      max-width: 85%;
      word-break: break-word;
      font-size: 13px;
      line-height: 1.5;
    }
    .msg-assistant {
      align-self: flex-start;
      background: transparent;
      padding: 4px 0;
      max-width: 100%;
      word-break: break-word;
      font-size: 13px;
      line-height: 1.6;
    }
    .msg-header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      color: var(--accent);
      margin-bottom: 4px;
    }

    /* Devin-style Expandable Execution Groups */
    .execution-group {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 6px;
      margin: 6px 0;
      overflow: hidden;
    }
    .exec-summary {
      padding: 7px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      font-size: 11px;
      color: var(--text-muted);
      user-select: none;
    }
    .exec-summary:hover {
      background: var(--hover-bg);
      color: var(--fg);
    }
    .exec-summary-left {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .exec-details {
      display: none;
      padding: 8px 12px;
      background: rgba(0, 0, 0, 0.2);
      border-top: 1px solid var(--border);
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      color: #94a3b8;
      line-height: 1.6;
    }
    .exec-details.open {
      display: block;
    }

    /* Task Plan Card */
    .plan-box {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      margin: 8px 0;
    }
    .plan-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--fg);
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .plan-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      font-size: 12px;
    }
    .plan-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 600;
    }
    .status-pending { background: #262626; color: var(--text-muted); }
    .status-in_progress { background: #0284c7; color: white; }
    .status-completed { background: rgba(34, 197, 94, 0.2); color: var(--success); }

    /* Completion Summary Card */
    .completion-box {
      background: rgba(34, 197, 94, 0.08);
      border: 1px solid rgba(34, 197, 94, 0.3);
      border-radius: 8px;
      padding: 12px;
      margin: 10px 0;
    }
    .completion-title {
      font-weight: 600;
      color: var(--success);
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .completion-actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    .btn-action {
      padding: 5px 10px;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.05);
      color: var(--fg);
      font-size: 11px;
      cursor: pointer;
    }
    .btn-action:hover { background: var(--hover-bg); }

    /* Approval Card */
    .approval-box {
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.4);
      border-radius: 8px;
      padding: 12px;
      margin: 8px 0;
    }
    .approval-btns {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    .btn-approve {
      padding: 5px 12px;
      border-radius: 4px;
      border: none;
      background: var(--success);
      color: white;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-reject {
      padding: 5px 12px;
      border-radius: 4px;
      border: none;
      background: var(--danger);
      color: white;
      font-weight: 600;
      cursor: pointer;
    }

    /* 3. Antigravity-style Floating Card Composer */
    .composer-surface {
      padding: 10px 14px 14px 14px;
      background: var(--bg);
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
    }
    .mode-bar {
      display: flex;
      gap: 4px;
    }
    .mode-btn {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      background: transparent;
      color: var(--text-muted);
      border: 1px solid transparent;
      cursor: pointer;
    }
    .mode-btn.active {
      background: rgba(255, 255, 255, 0.08);
      color: var(--fg);
      font-weight: 600;
    }
    .composer-card {
      background: var(--card-bg);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .composer-card:focus-within {
      border-color: rgba(56, 189, 248, 0.5);
      box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.2);
    }
    .composer-top-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .chip-project {
      font-size: 11px;
      color: var(--text-muted);
      background: rgba(255, 255, 255, 0.05);
      padding: 2px 8px;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      user-select: none;
      border: 1px solid transparent;
      transition: all 0.15s ease;
    }
    .chip-project:hover {
      background: rgba(255, 255, 255, 0.1);
      color: var(--fg);
    }
    textarea {
      width: 100%;
      background: transparent;
      border: none;
      color: var(--fg);
      font-family: inherit;
      font-size: 13px;
      resize: none;
      outline: none;
      min-height: 40px;
      max-height: 160px;
      line-height: 1.45;
    }
    textarea::placeholder {
      color: var(--text-muted);
      opacity: 0.8;
    }
    .composer-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .composer-left-tools {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .model-chip {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 11px;
      color: var(--text-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: all 0.15s ease;
    }
    .model-chip:hover {
      background: rgba(255, 255, 255, 0.1);
      color: var(--fg);
      border-color: rgba(255, 255, 255, 0.15);
    }
    .btn-send {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: none;
      background: #ffffff;
      color: #000000;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 13px;
      font-weight: 700;
      transition: transform 0.1s ease, opacity 0.15s ease;
    }
    .btn-send:hover {
      transform: scale(1.05);
      opacity: 0.95;
    }
    .btn-send.stop-mode {
      background: var(--danger);
      color: white;
      border-radius: 6px;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .header-icon-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      width: 26px;
      height: 26px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      transition: all 0.15s ease;
    }
    .header-icon-btn:hover {
      background: var(--hover-bg);
      color: var(--fg);
    }

    /* Section Selector in Header */
    .section-selector-btn {
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      color: var(--fg);
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      max-width: 170px;
      transition: all 0.15s ease;
      user-select: none;
    }
    .section-selector-btn:hover {
      background: var(--hover-bg);
      border-color: var(--border);
    }
    .section-icon {
      font-size: 12px;
      opacity: 0.9;
    }
    .session-title-label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 125px;
      font-weight: 600;
    }
    .dropdown-caret {
      font-size: 8px;
      color: var(--text-muted);
    }

    /* Sections / History Drawer Overlay */
    .sections-drawer {
      position: absolute;
      top: 43px;
      left: 0;
      right: 0;
      bottom: 0;
      background: #181818;
      border-bottom: 1px solid var(--border);
      display: none;
      flex-direction: column;
      z-index: 100;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.6);
      animation: slideDown 0.16s ease-out;
    }
    .sections-drawer.open {
      display: flex;
    }
    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .drawer-header {
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      background: var(--card-bg);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .drawer-title {
      font-weight: 600;
      font-size: 12px;
      color: var(--fg);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .drawer-count-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-muted);
    }
    .drawer-header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .btn-drawer-new {
      padding: 4px 9px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 5px;
      border: 1px solid rgba(56, 189, 248, 0.3);
      background: rgba(56, 189, 248, 0.12);
      color: var(--accent);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s ease;
    }
    .btn-drawer-new:hover {
      background: rgba(56, 189, 248, 0.22);
      border-color: var(--accent);
    }
    .btn-drawer-close {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 13px;
      padding: 3px 6px;
      border-radius: 4px;
    }
    .btn-drawer-close:hover {
      color: var(--fg);
      background: var(--hover-bg);
    }
    .drawer-search-bar {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      background: var(--card-bg);
    }
    .drawer-search-input {
      width: 100%;
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 12px;
      color: var(--fg);
      outline: none;
    }
    .drawer-search-input:focus {
      border-color: var(--accent);
    }
    .drawer-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .section-card {
      padding: 8px 10px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .section-card:hover {
      background: var(--hover-bg);
      border-color: var(--border);
    }
    .section-card.active {
      background: rgba(56, 189, 248, 0.08);
      border-color: rgba(56, 189, 248, 0.4);
    }
    .section-card-main {
      flex: 1;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .section-card-title {
      font-size: 12px;
      font-weight: 500;
      color: var(--fg);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .section-card.active .section-card-title {
      color: var(--accent);
      font-weight: 600;
    }
    .section-card-meta {
      font-size: 10px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .section-model-tag {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.06);
    }
    .section-card-actions {
      display: flex;
      align-items: center;
      gap: 3px;
      opacity: 0.5;
      transition: opacity 0.15s ease;
    }
    .section-card:hover .section-card-actions {
      opacity: 1;
    }
    .btn-card-action {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 3px 5px;
      border-radius: 4px;
      font-size: 11px;
    }
    .btn-card-action:hover {
      background: rgba(255, 255, 255, 0.12);
      color: var(--fg);
    }
    .btn-card-action.btn-delete:hover {
      color: var(--danger);
    }
    .drawer-empty-note {
      text-align: center;
      padding: 24px 12px;
      color: var(--text-muted);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <!-- 1. Antigravity-style Header Bar with Sections Dropdown -->
  <div class="header-bar">
    <div class="header-left">
      <button class="section-selector-btn" id="btn-section-dropdown" title="Click to view all chat sections / history">
        <span class="section-icon">💬</span>
        <span class="session-title-label" id="session-title">New Section</span>
        <span class="dropdown-caret">⌄</span>
      </button>
    </div>
    <div class="header-actions">
      <button class="header-icon-btn" id="btn-new-section" title="New Chat Section (+)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
      </button>
      <button class="header-icon-btn" id="btn-history-toggle" title="Chat Sections History">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
      </button>
      <button class="header-icon-btn" id="btn-more-options" title="Section Options">⋯</button>
    </div>
  </div>

  <!-- Sections / History Drawer -->
  <div class="sections-drawer" id="sections-drawer">
    <div class="drawer-header">
      <div class="drawer-title">
        <span>Chat Sections</span>
        <span class="drawer-count-badge" id="drawer-count">0</span>
      </div>
      <div class="drawer-header-actions">
        <button class="btn-drawer-new" id="btn-drawer-new">+ New Section</button>
        <button class="btn-drawer-close" id="btn-drawer-close">✕</button>
      </div>
    </div>
    <div class="drawer-search-bar">
      <input type="text" class="drawer-search-input" id="drawer-search-input" placeholder="Search saved sections..." />
    </div>
    <div class="drawer-list" id="drawer-sections-list"></div>
  </div>

  <!-- 2. Chat Feed -->
  <div id="chat-container">
    <div class="empty-welcome" id="empty-welcome">
      <div class="welcome-logo-container">
        <svg class="welcome-logo-svg" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M24 6L6 38H16L24 22L32 38H42L24 6Z" fill="url(#brandGlow)" />
          <defs>
            <linearGradient id="brandGlow" x1="6" y1="6" x2="42" y2="38" gradientUnits="userSpaceOnUse">
              <stop stop-color="#38bdf8" />
              <stop offset="1" stop-color="#818cf8" />
            </linearGradient>
          </defs>
        </svg>
      </div>
      <div class="welcome-title">Hey \${username}, what should we build today?</div>
    </div>
  </div>

  <!-- 3. Antigravity-style Floating Card Composer -->
  <div class="composer-surface">
    <div class="mode-bar">
      <button class="mode-btn active" data-mode="agent">Agent</button>
      <button class="mode-btn" data-mode="plan">Plan</button>
      <button class="mode-btn" data-mode="ask">Ask</button>
      <button class="mode-btn" data-mode="review">Review</button>
    </div>
    <div class="composer-card">
      <div class="composer-top-row">
        <span class="chip-project" id="chip-project" title="Workspace Context">
          <span>📁</span>
          <span id="chip-project-name">No Project</span>
          <span style="font-size: 9px; opacity: 0.7;">⌄</span>
        </span>
      </div>
      <textarea id="prompt-input" rows="2" placeholder="Ask anything, @ to mention, / for actions..."></textarea>
      <div class="composer-footer">
        <div class="composer-left-tools">
          <button class="model-chip" id="model-chip" title="Click to change Ollama model">
            <span style="font-weight: 700; color: var(--accent);">+</span>
            <span id="current-model-label">qwen3.8:27b</span>
            <span style="font-size: 9px; opacity: 0.7;">⌄</span>
          </button>
        </div>
        <button class="btn-send" id="btn-send" title="Send (Enter)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="19" x2="12" y2="5"></line>
            <polyline points="5 12 12 5 19 12"></polyline>
          </svg>
        </button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const chatContainer = document.getElementById('chat-container');
    const emptyWelcome = document.getElementById('empty-welcome');
    const promptInput = document.getElementById('prompt-input');
    const btnSend = document.getElementById('btn-send');
    const sessionTitle = document.getElementById('session-title');
    const chipProject = document.getElementById('chip-project');
    const chipProjectName = document.getElementById('chip-project-name');
    const modelChip = document.getElementById('model-chip');
    const currentModelLabel = document.getElementById('current-model-label');
    const btnNewSection = document.getElementById('btn-new-section');
    const btnHistoryToggle = document.getElementById('btn-history-toggle');
    const btnSectionDropdown = document.getElementById('btn-section-dropdown');
    const btnMoreOptions = document.getElementById('btn-more-options');

    // Drawer Elements
    const sectionsDrawer = document.getElementById('sections-drawer');
    const btnDrawerClose = document.getElementById('btn-drawer-close');
    const btnDrawerNew = document.getElementById('btn-drawer-new');
    const drawerSearchInput = document.getElementById('drawer-search-input');
    const drawerSectionsList = document.getElementById('drawer-sections-list');
    const drawerCount = document.getElementById('drawer-count');

    let isRunning = false;
    let allSectionsCache = [];
    let currentActiveSessionId = null;

    // Drawer Toggle Logic
    function toggleDrawer() {
      const isOpen = sectionsDrawer.classList.toggle('open');
      if (isOpen) {
        drawerSearchInput.value = '';
        renderDrawerSections(allSectionsCache);
        drawerSearchInput.focus();
      }
    }

    function closeDrawer() {
      sectionsDrawer.classList.remove('open');
    }

    btnSectionDropdown.addEventListener('click', toggleDrawer);
    btnHistoryToggle.addEventListener('click', toggleDrawer);
    btnDrawerClose.addEventListener('click', closeDrawer);

    btnNewSection.addEventListener('click', () => {
      closeDrawer();
      vscode.postMessage({ command: 'newSection' });
    });

    btnDrawerNew.addEventListener('click', () => {
      closeDrawer();
      vscode.postMessage({ command: 'newSection' });
    });

    drawerSearchInput.addEventListener('input', () => {
      const q = drawerSearchInput.value.toLowerCase().trim();
      if (!q) {
        renderDrawerSections(allSectionsCache);
        return;
      }
      const filtered = allSectionsCache.filter(s =>
        (s.title || '').toLowerCase().includes(q) ||
        (s.userGoal || '').toLowerCase().includes(q)
      );
      renderDrawerSections(filtered);
    });

    // Model selection
    modelChip.addEventListener('click', () => {
      vscode.postMessage({ command: 'selectModel' });
    });

    btnMoreOptions.addEventListener('click', () => {
      vscode.postMessage({ command: 'showMoreOptions' });
    });

    chipProject.addEventListener('click', () => {
      vscode.postMessage({ command: 'selectWorkspace' });
    });

    // Auto-grow textarea
    promptInput.addEventListener('input', () => {
      promptInput.style.height = 'auto';
      promptInput.style.height = Math.min(promptInput.scrollHeight, 160) + 'px';
    });

    // Enter to submit, Shift+Enter for newline
    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitMessage();
      }
    });

    btnSend.addEventListener('click', () => {
      if (isRunning) {
        vscode.postMessage({ command: 'cancelTask' });
      } else {
        submitMessage();
      }
    });

    function submitMessage() {
      const text = promptInput.value.trim();
      if (!text || isRunning) return;
      promptInput.value = '';
      promptInput.style.height = 'auto';
      setRunningState(true);
      vscode.postMessage({ command: 'sendMessage', text });
    }

    function setRunningState(running) {
      isRunning = running;
      if (running) {
        btnSend.classList.add('stop-mode');
        btnSend.innerHTML = '<span style="font-size: 11px;">■</span>';
        btnSend.title = 'Stop Generation';
      } else {
        btnSend.classList.remove('stop-mode');
        btnSend.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>';
        btnSend.title = 'Send (Enter)';
      }
    }

    function formatTimeAgo(timestamp) {
      if (!timestamp) return 'Just now';
      const diffSec = Math.floor((Date.now() - timestamp) / 1000);
      if (diffSec < 60) return 'Just now';
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return \`\${diffMin}m ago\`;
      const diffHour = Math.floor(diffMin / 60);
      if (diffHour < 24) return \`\${diffHour}h ago\`;
      const diffDay = Math.floor(diffHour / 24);
      if (diffDay < 7) return \`\${diffDay}d ago\`;
      return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    function renderDrawerSections(sections) {
      drawerSectionsList.innerHTML = '';
      if (!sections || sections.length === 0) {
        drawerSectionsList.innerHTML = '<div class="drawer-empty-note">No sections found. Click "+ New Section" to start one!</div>';
        return;
      }

      sections.forEach((s) => {
        const card = document.createElement('div');
        const isActive = s.id === currentActiveSessionId;
        card.className = 'section-card' + (isActive ? ' active' : '');
        const msgCount = (s.messages || []).length;

        card.innerHTML = \`
          <div class="section-card-main">
            <div class="section-card-title">\${escapeHtml(s.title || 'Untitled Section')}</div>
            <div class="section-card-meta">
              <span>\${formatTimeAgo(s.updatedAt)}</span>
              <span>•</span>
              <span>\${msgCount} msg\${msgCount === 1 ? '' : 's'}</span>
              <span>•</span>
              <span class="section-model-tag">\${escapeHtml(s.model || 'qwen3.8:27b')}</span>
            </div>
          </div>
          <div class="section-card-actions">
            <button class="btn-card-action btn-rename" title="Rename Section">✏️</button>
            <button class="btn-card-action btn-delete" title="Delete Section">🗑️</button>
          </div>
        \`;

        // Click to switch section
        card.querySelector('.section-card-main').addEventListener('click', () => {
          closeDrawer();
          vscode.postMessage({ command: 'switchSection', sessionId: s.id });
        });

        // Rename
        card.querySelector('.btn-rename').addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'renameSection', sessionId: s.id });
        });

        // Delete
        card.querySelector('.btn-delete').addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'deleteSection', sessionId: s.id });
        });

        drawerSectionsList.appendChild(card);
      });
    }

    window.addEventListener('message', (event) => {
      const data = event.data;
      switch (data.type) {
        case 'loadSession':
          allSectionsCache = data.allSessions || [];
          if (drawerCount) drawerCount.textContent = allSectionsCache.length;

          if (data.session) {
            currentActiveSessionId = data.session.id;
            sessionTitle.textContent = data.session.title || 'New Section';
            if (currentModelLabel) currentModelLabel.textContent = data.session.model || 'qwen3.8:27b';
          }

          if (data.workspaceName && chipProjectName) {
            chipProjectName.textContent = data.workspaceName;
          }

          // Re-render drawer if open
          if (sectionsDrawer.classList.contains('open')) {
            renderDrawerSections(allSectionsCache);
          }

          if (data.session && data.session.messages && data.session.messages.length > 0) {
            if (emptyWelcome) emptyWelcome.style.display = 'none';
            chatContainer.innerHTML = '';
            data.session.messages.forEach(renderMessage);
            if (data.session.plan && data.session.plan.length > 0) {
              renderPlan(data.session.plan);
            }
          } else {
            chatContainer.innerHTML = '';
            if (emptyWelcome) {
              emptyWelcome.style.display = 'flex';
              chatContainer.appendChild(emptyWelcome);
            }
          }
          break;

        case 'addMessage':
          if (emptyWelcome) emptyWelcome.style.display = 'none';
          renderMessage(data.message);
          chatContainer.scrollTop = chatContainer.scrollHeight;
          if (data.message.senderRole === 'assistant') {
            setRunningState(false);
          }
          break;

        case 'planUpdate':
          renderPlan(data.plan);
          break;

        case 'activity':
          renderExecutionActivity(data.event);
          break;

        case 'approvalRequest':
          renderApproval(data.request);
          break;
      }
    });

    function renderMessage(msg) {
      const row = document.createElement('div');
      row.className = 'msg-row';

      if (msg.senderRole === 'user') {
        row.innerHTML = \`<div class="msg-user">\${escapeHtml(msg.content)}</div>\`;
      } else {
        row.innerHTML = \`
          <div class="msg-assistant">
            <div class="msg-header">
              <span>🤖</span>
              <span>\${escapeHtml(msg.senderName || 'Main Agent')}</span>
            </div>
            <div class="msg-content">\${renderMarkdown(msg.content)}</div>
          </div>
        \`;
      }
      chatContainer.appendChild(row);
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    // Devin-style Expandable Execution Activity
    function renderExecutionActivity(ev) {
      if (!ev.latestActivity) return;
      const group = document.createElement('div');
      group.className = 'execution-group';
      group.innerHTML = \`
        <div class="exec-summary">
          <div class="exec-summary-left">
            <span>⚙️</span>
            <span>\${escapeHtml(ev.agentName || 'Agent')}: \${escapeHtml(ev.latestActivity)}</span>
          </div>
          <span style="font-size: 10px;">▸</span>
        </div>
        <div class="exec-details">
          <div>• Status: \${ev.status}</div>
          <div>• Timestamp: \${new Date(ev.timestamp || Date.now()).toLocaleTimeString()}</div>
        </div>
      \`;

      const summary = group.querySelector('.exec-summary');
      const details = group.querySelector('.exec-details');
      const arrow = summary.querySelector('span:last-child');
      summary.addEventListener('click', () => {
        const isOpen = details.classList.toggle('open');
        arrow.textContent = isOpen ? '▾' : '▸';
      });

      chatContainer.appendChild(group);
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function renderPlan(plan) {
      if (!plan || plan.length === 0) return;
      const box = document.createElement('div');
      box.className = 'plan-box';
      let html = '<div class="plan-title"><span>📋 Execution Plan</span><span>' + plan.length + ' steps</span></div>';
      plan.forEach((item, idx) => {
        html += \`
          <div class="plan-item">
            <span>\${idx + 1}. \${escapeHtml(item.title)}</span>
            <span class="plan-badge status-\${item.status}">\${item.status}</span>
          </div>
        \`;
      });
      box.innerHTML = html;
      chatContainer.appendChild(box);
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function renderApproval(req) {
      const box = document.createElement('div');
      box.className = 'approval-box';
      box.innerHTML = \`
        <div style="font-weight: 600; color: var(--warning); margin-bottom: 6px;">⚠️ Approval Required: \${escapeHtml(req.toolName)}</div>
        <div style="font-size: 12px; color: var(--fg);">\${escapeHtml(req.description)}</div>
        <div class="approval-btns">
          <button class="btn-approve" id="app-yes">Approve</button>
          <button class="btn-reject" id="app-no">Reject</button>
        </div>
      \`;
      box.querySelector('#app-yes').addEventListener('click', () => {
        vscode.postMessage({ command: 'resolveApproval', requestId: req.id, approved: true });
        box.remove();
      });
      box.querySelector('#app-no').addEventListener('click', () => {
        vscode.postMessage({ command: 'resolveApproval', requestId: req.id, approved: false });
        box.remove();
      });
      chatContainer.appendChild(box);
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function renderMarkdown(text) {
      if (!text) return '';
      let html = escapeHtml(text);
      const bt = String.fromCharCode(96);
      const b3 = bt + bt + bt;
      const codeBlockRe = new RegExp(b3 + '([a-zA-Z0-9]*)\\n([\\s\\S]*?)' + b3, 'g');
      const inlineCodeRe = new RegExp(bt + '([^' + bt + ']+)' + bt, 'g');
      html = html.replace(codeBlockRe, '<pre style="background: rgba(0,0,0,0.3); padding: 10px; border-radius: 6px; overflow-x: auto; font-family: monospace; font-size: 12px; margin: 8px 0;"><code>$2</code></pre>');
      html = html.replace(inlineCodeRe, '<code style="background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 4px; font-family: monospace;">$1</code>');
      html = html.replace(/\\*\\*([^\\*]+)\\*\\*/g, '<strong>$1</strong>');
      html = html.replace(/^### (.*$)/gm, '<h4 style="font-size: 13px; font-weight: 600; margin: 8px 0 4px 0; color: var(--fg);">$1</h4>');
      html = html.replace(/\\n/g, '<br/>');
      return html;
    }
  </script>
</body>
</html>`;
  }
}
