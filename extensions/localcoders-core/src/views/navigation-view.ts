import * as vscode from 'vscode';
import { SessionManager, SessionData } from '../sessions/session-manager';
import { OllamaClient } from '../ollama/client';

export class NavigationViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'localcoders.navigationView';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    private readonly ollama: OllamaClient
  ) {
    this.sessionManager.onDidChangeSessions(() => {
      this.refresh();
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
        case 'newSession':
        case 'newSection': {
          const models = await this.ollama.listModels();
          const model = models[0]?.name || 'qwen3.8:27b';
          this.sessionManager.createSession('New Section', model);
          vscode.commands.executeCommand('localcoders.openChat');
          break;
        }

        case 'switchSession':
          this.sessionManager.switchSession(data.sessionId);
          vscode.commands.executeCommand('localcoders.openChat');
          break;

        case 'renameSession': {
          const s = this.sessionManager.getSession(data.sessionId);
          const newTitle = await vscode.window.showInputBox({
            prompt: 'Rename session',
            value: s?.title || '',
          });
          if (newTitle) {
            this.sessionManager.renameSession(data.sessionId, newTitle);
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
          }
          break;
        }

        case 'archiveSession':
          this.sessionManager.archiveSession(data.sessionId, true);
          break;

        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'localcoders');
          break;

        case 'openAgentTeam':
          vscode.commands.executeCommand('localcoders.agentTeamView.focus');
          break;

        case 'openModelManager':
          vscode.commands.executeCommand('localcoders.modelManagerView.focus');
          break;

        case 'openCriticReviews':
          vscode.commands.executeCommand('localcoders.criticReviewsView.focus');
          break;

        case 'openProjectWiki':
          vscode.commands.executeCommand('localcoders.projectMemoryView.focus');
          break;
      }
    });

    this.refresh();
  }

  public refresh() {
    if (this._view) {
      const sessions = this.sessionManager.getAllSessions();
      const active = this.sessionManager.getActiveSession();
      this._view.webview.postMessage({
        type: 'updateState',
        sessions,
        activeSessionId: active?.id,
      });
    }
  }

  private _getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg: var(--vscode-sideBar-background, #191919);
      --fg: var(--vscode-sideBar-foreground, #cccccc);
      --border: var(--vscode-widget-border, #2e2e2e);
      --hover-bg: var(--vscode-list-hoverBackground, #262626);
      --active-bg: var(--vscode-list-activeSelectionBackground, #323232);
      --accent: #38bdf8;
      --success: #22c55e;
      --danger: #ef4444;
      --text-muted: #888888;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: 12px;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow-x: hidden;
      overflow-y: auto;
      user-select: none;
    }

    /* 1. Profile Section */
    .profile-card {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .profile-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: linear-gradient(135deg, #0284c7, #38bdf8);
      color: #0f172a;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 13px;
    }
    .profile-info {
      display: flex;
      flex-direction: column;
    }
    .profile-name {
      font-weight: 600;
      color: var(--fg);
      font-size: 12px;
    }
    .profile-role {
      font-size: 10px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--success);
      display: inline-block;
    }
    .btn-icon {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 14px;
      padding: 4px;
      border-radius: 4px;
    }
    .btn-icon:hover { color: var(--fg); background: var(--hover-bg); }

    /* 2. New Session Action */
    .action-container {
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
    }
    .btn-new-session {
      width: 100%;
      padding: 7px 12px;
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.3);
      color: var(--accent);
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .btn-new-session:hover {
      background: rgba(56, 189, 248, 0.22);
      border-color: var(--accent);
    }

    /* 3. Navigation List */
    .nav-list {
      padding: 6px 0;
      border-bottom: 1px solid var(--border);
    }
    .nav-item {
      padding: 6px 14px;
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
      color: var(--fg);
      font-size: 12px;
      transition: background 0.15s ease;
    }
    .nav-item:hover { background: var(--hover-bg); }
    .nav-icon {
      font-size: 14px;
      color: var(--text-muted);
      width: 16px;
      text-align: center;
    }

    /* 4. Sessions Section */
    .sessions-header {
      padding: 10px 14px 4px 14px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .session-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px 0;
    }
    .session-item {
      padding: 8px 14px;
      cursor: pointer;
      border-bottom: 1px solid rgba(255, 255, 255, 0.02);
      display: flex;
      flex-direction: column;
      gap: 4px;
      transition: background 0.15s ease;
    }
    .session-item:hover { background: var(--hover-bg); }
    .session-item.active {
      background: var(--active-bg);
      border-left: 2px solid var(--accent);
    }
    .session-row-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .session-title {
      font-weight: 500;
      color: var(--fg);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
    }
    .session-badge {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      text-transform: uppercase;
      font-weight: 600;
    }
    .badge-idle { background: rgba(255, 255, 255, 0.08); color: var(--text-muted); }
    .badge-running { background: rgba(56, 189, 248, 0.2); color: var(--accent); }
    .badge-completed { background: rgba(34, 197, 94, 0.2); color: var(--success); }
    .badge-failed { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
    .session-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 10px;
      color: var(--text-muted);
    }
    .session-actions {
      display: none;
      gap: 4px;
    }
    .session-item:hover .session-actions {
      display: flex;
    }
    .act-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 11px;
      padding: 2px 4px;
      border-radius: 3px;
    }
    .act-btn:hover { color: var(--fg); background: rgba(255, 255, 255, 0.1); }
  </style>
</head>
<body>
  <!-- 1. Profile -->
  <div class="profile-card">
    <div class="profile-left">
      <div class="avatar">LC</div>
      <div class="profile-info">
        <span class="profile-name">Local Developer</span>
        <span class="profile-role"><span class="status-dot"></span> Offline / Local-First</span>
      </div>
    </div>
    <button class="btn-icon" id="btn-settings" title="LocalCoders Settings">⚙</button>
  </div>

  <!-- 2. New Section -->
  <div class="action-container">
    <button class="btn-new-session" id="btn-new-session">
      <span>+</span> New Section
    </button>
  </div>

  <!-- 3. Navigation -->
  <div class="nav-list">
    <div class="nav-item" id="nav-team">
      <span class="nav-icon">👥</span>
      <span>Agent Team</span>
    </div>
    <div class="nav-item" id="nav-models">
      <span class="nav-icon">🧠</span>
      <span>Model Manager</span>
    </div>
    <div class="nav-item" id="nav-reviews">
      <span class="nav-icon">🛡️</span>
      <span>Code Reviews</span>
    </div>
    <div class="nav-item" id="nav-wiki">
      <span class="nav-icon">📖</span>
      <span>Project Rules & Wiki</span>
    </div>
  </div>

  <!-- 4. Sections History Section -->
  <div class="sessions-header">
    <span>Chat Sections (History)</span>
  </div>
  <div class="session-list" id="session-list"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const sessionList = document.getElementById('session-list');

    document.getElementById('btn-new-session').addEventListener('click', () => {
      vscode.postMessage({ command: 'newSession' });
    });
    document.getElementById('btn-settings').addEventListener('click', () => {
      vscode.postMessage({ command: 'openSettings' });
    });
    document.getElementById('nav-team').addEventListener('click', () => {
      vscode.postMessage({ command: 'openAgentTeam' });
    });
    document.getElementById('nav-models').addEventListener('click', () => {
      vscode.postMessage({ command: 'openModelManager' });
    });
    document.getElementById('nav-reviews').addEventListener('click', () => {
      vscode.postMessage({ command: 'openCriticReviews' });
    });
    document.getElementById('nav-wiki').addEventListener('click', () => {
      vscode.postMessage({ command: 'openProjectWiki' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'updateState') {
        renderSessions(msg.sessions || [], msg.activeSessionId);
      }
    });

    function formatTimeAgo(ts) {
      const diff = Date.now() - ts;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hours = Math.floor(mins / 60);
      if (hours < 24) return hours + 'h ago';
      return Math.floor(hours / 24) + 'd ago';
    }

    function renderSessions(sessions, activeId) {
      if (sessions.length === 0) {
        sessionList.innerHTML = '<div style="padding: 20px 14px; color: var(--text-muted); text-align: center;">No sessions yet. Click New Session to begin.</div>';
        return;
      }

      sessionList.innerHTML = '';
      sessions.forEach((s) => {
        const item = document.createElement('div');
        item.className = 'session-item' + (s.id === activeId ? ' active' : '');
        item.innerHTML = \`
          <div class="session-row-top">
            <span class="session-title" title="\${s.title}">\${s.title}</span>
            <span class="session-badge badge-\${s.status}">\${s.status}</span>
          </div>
          <div class="session-meta">
            <span>\${s.model || 'qwen3.8:27b'} • \${formatTimeAgo(s.updatedAt)}</span>
            <div class="session-actions">
              <button class="act-btn btn-rename" title="Rename">✏️</button>
              <button class="act-btn btn-delete" title="Delete">🗑️</button>
            </div>
          </div>
        \`;

        item.addEventListener('click', (e) => {
          if (e.target.closest('.act-btn')) return;
          vscode.postMessage({ command: 'switchSession', sessionId: s.id });
        });

        item.querySelector('.btn-rename').addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'renameSession', sessionId: s.id });
        });

        item.querySelector('.btn-delete').addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'deleteSession', sessionId: s.id });
        });

        sessionList.appendChild(item);
      });
    }
  </script>
</body>
</html>`;
  }
}
