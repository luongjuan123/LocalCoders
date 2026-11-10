import * as vscode from 'vscode';
import { getLucideCss, getLucideClientScript, lucideSvg, getLocalCodersLogoSvg } from './lucide-icons';
import { getSessionsBarStyles, getSessionsBarClientScript } from './sessions-bar-ui';
import { SessionManager, SessionData } from '../sessions/session-manager';
import { OllamaClient } from '../ollama/client';
import { ModelProviderRegistry } from '../models/model-provider-registry';

export class NavigationViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'localcoders.navigationView';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    private readonly ollama: OllamaClient,
    private readonly modelRegistry?: ModelProviderRegistry
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
          let model = '';
          let providerId = 'ollama';
          let modelName = '';
          if (this.modelRegistry) {
            const firstAvailable = await this.modelRegistry.getDefaultOrFirstAvailableModel();
            if (firstAvailable) {
              model = firstAvailable.id;
              providerId = firstAvailable.providerId;
              modelName = firstAvailable.displayName;
            }
          } else {
            const models = await this.ollama.listModels();
            model = models[0]?.name ? `ollama/${models[0].name}` : '';
            modelName = models[0]?.name || '';
          }
          this.sessionManager.createSession('New Section', model, { providerId, modelId: model, modelName });
          vscode.commands.executeCommand('localcoders.openChat');
          break;
        }

        case 'switchSession':
          this.sessionManager.switchSession(data.sessionId);
          vscode.commands.executeCommand('localcoders.openChat');
          break;

        case 'renameSession': {
          if (!data.sessionId) break;
          const providedTitle = typeof data.title === 'string' ? data.title.trim() : '';
          if (providedTitle) {
            this.sessionManager.renameSession(data.sessionId, providedTitle);
            break;
          }
          const s = this.sessionManager.getSession(data.sessionId);
          const newTitle = await vscode.window.showInputBox({
            prompt: 'Rename session',
            value: s?.title || '',
          });
          if (newTitle && newTitle.trim()) {
            this.sessionManager.renameSession(data.sessionId, newTitle.trim());
          }
          break;
        }

        case 'deleteSession': {
          if (!data.sessionId) break;
          if (data.confirmed === true) {
            this.sessionManager.deleteSession(data.sessionId);
            break;
          }
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
          vscode.commands.executeCommand('localcoders.manageModels');
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
    ${getLucideCss()}
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
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .profile-name {
      font-weight: 600;
      color: var(--fg);
      font-size: 12px;
      letter-spacing: 0.01em;
      display: inline-flex;
      align-items: center;
      gap: 7px;
    }
    .btn-icon {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .btn-icon:hover { color: var(--fg); background: var(--hover-bg); }

    /* 2. New Session Action */
    .action-container {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
    }
    .btn-new-session {
      width: 100%;
      padding: 6px 10px;
      background: color-mix(in srgb, var(--fg) 5%, transparent);
      border: 1px solid var(--border);
      color: var(--fg);
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: background 0.15s ease;
    }
    .btn-new-session:hover {
      background: var(--hover-bg);
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
      color: var(--text-muted);
      width: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
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
      display: flex;
      opacity: 0.45;
      gap: 4px;
      transition: opacity 0.12s ease;
    }
    .session-item:hover .session-actions,
    .session-item.active .session-actions {
      opacity: 1;
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
    ${getSessionsBarStyles()}
  </style>
</head>
<body>
  <div class="profile-card">
    <span class="profile-name">${getLocalCodersLogoSvg(18)}<span>LocalCoders</span></span>
    <button class="btn-icon" id="btn-settings" title="Settings">${lucideSvg('settings', 14)}</button>
  </div>

  <div class="nav-list">
    <div class="nav-item" id="nav-team">
      <span class="nav-icon">${lucideSvg('users', 14)}</span>
      <span>Agents</span>
    </div>
    <div class="nav-item" id="nav-models">
      <span class="nav-icon">${lucideSvg('cpu', 14)}</span>
      <span>Models</span>
    </div>
    <div class="nav-item" id="nav-reviews">
      <span class="nav-icon">${lucideSvg('eye', 14)}</span>
      <span>Changes Review</span>
    </div>
    <div class="nav-item" id="nav-wiki">
      <span class="nav-icon">${lucideSvg('file-text', 14)}</span>
      <span>Project Rules</span>
    </div>
  </div>

  <div class="lc-sessions-header">
    <span class="lc-sessions-heading">Sessions</span>
    <div class="lc-sessions-hdr-actions">
      <button type="button" class="lc-sess-hdr-btn" id="btn-new-session" title="New Session">${lucideSvg('plus', 15)}</button>
      <button type="button" class="lc-sess-hdr-btn" id="btn-nav-filter" title="Filter &amp; Sort">${lucideSvg('sliders-horizontal', 14)}</button>
      <button type="button" class="lc-sess-hdr-btn" id="btn-nav-more" title="Session Options">${lucideSvg('ellipsis', 14)}</button>
      <div class="lc-sessions-menu" id="nav-sessions-menu">
        <button type="button" class="lc-sessions-menu-item" data-nav-sess-act="new">${lucideSvg('plus', 12)}<span>New Session</span></button>
        <button type="button" class="lc-sessions-menu-item" data-nav-sess-act="toggleSort">${lucideSvg('arrow-up-down', 12)}<span id="nav-sort-lbl">Sort: Alphabetical</span></button>
      </div>
    </div>
  </div>

  <div class="lc-sessions-filter-bar" id="nav-filter-bar">
    <div class="lc-sessions-search-wrap">
      <span class="lc-sessions-search-ico">${lucideSvg('search', 12)}</span>
      <input type="text" class="lc-sessions-filter-input" id="nav-search-input" placeholder="Filter sessions...">
    </div>
  </div>

  <button type="button" class="lc-recent-subheader" id="btn-nav-recent">
    ${lucideSvg('clock', 12)}
    <span>Recent</span>
  </button>

  <div class="lc-sessions-scroll" id="session-list"></div>

  <script>
    const vscode = acquireVsCodeApi();
    ${getLucideClientScript()}
    ${getSessionsBarClientScript()}
    const sessionList = document.getElementById('session-list');
    const navFilterBar = document.getElementById('nav-filter-bar');
    const navSearchInput = document.getElementById('nav-search-input');
    const btnNavFilter = document.getElementById('btn-nav-filter');
    const btnNavMore = document.getElementById('btn-nav-more');
    const navMenu = document.getElementById('nav-sessions-menu');

    let navSessionsCache = [];
    let navActiveId = null;
    let navSortMode = 'recent';
    let navRecentCollapsed = false;

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

    btnNavFilter?.addEventListener('click', (e) => {
      e.stopPropagation();
      navMenu?.classList.remove('open');
      const next = navFilterBar ? !navFilterBar.classList.contains('open') : false;
      navFilterBar?.classList.toggle('open', next);
      btnNavFilter.classList.toggle('active', next);
      if (next) navSearchInput?.focus();
      else if (navSearchInput && navSearchInput.value) {
        navSearchInput.value = '';
        renderSessions(navSessionsCache, navActiveId);
      }
    });

    btnNavMore?.addEventListener('click', (e) => {
      e.stopPropagation();
      const lbl = document.getElementById('nav-sort-lbl');
      if (lbl) lbl.textContent = navSortMode === 'recent' ? 'Sort: Alphabetical' : 'Sort: Most Recent';
      navMenu?.classList.toggle('open');
    });

    document.addEventListener('click', (e) => {
      if (navMenu && !navMenu.contains(e.target) && e.target !== btnNavMore) {
        navMenu.classList.remove('open');
      }
    });

    navMenu?.querySelectorAll('.lc-sessions-menu-item[data-nav-sess-act]').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = item.getAttribute('data-nav-sess-act');
        navMenu.classList.remove('open');
        if (act === 'new') vscode.postMessage({ command: 'newSession' });
        if (act === 'toggleSort') {
          navSortMode = navSortMode === 'recent' ? 'alpha' : 'recent';
          renderSessions(navSessionsCache, navActiveId);
        }
      });
    });

    navSearchInput?.addEventListener('input', () => {
      renderSessions(navSessionsCache, navActiveId);
    });

    document.getElementById('btn-nav-recent')?.addEventListener('click', () => {
      navRecentCollapsed = !navRecentCollapsed;
      if (sessionList) sessionList.style.display = navRecentCollapsed ? 'none' : 'flex';
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'updateState') {
        navSessionsCache = msg.sessions || [];
        navActiveId = msg.activeSessionId;
        renderSessions(navSessionsCache, navActiveId);
      }
    });

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function formatTimeAgo(ts) {
      return lcFormatSessionTimeAgo(ts);
    }

    function renderSessions(sessions, activeId) {
      const q = (navSearchInput?.value || '').trim().toLowerCase();
      let filtered = q
        ? (sessions || []).filter((s) => (s.title || '').toLowerCase().includes(q))
        : (sessions || []).slice();

      if (navSortMode === 'alpha') {
        filtered.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      } else {
        filtered.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      }

      if (filtered.length === 0) {
        sessionList.innerHTML = '<div class="lc-sess-empty">No sessions found</div>';
        return;
      }

      sessionList.innerHTML = '';
      filtered.forEach((s) => {
        const isRunningSess = s.status === 'running';
        const item = document.createElement('div');
        item.className = 'lc-sess-row' + (s.id === activeId ? ' active' : '');
        item.innerHTML =
          '<span class="lc-sess-gutter"><span class="lc-sess-dot' + (isRunningSess ? ' running' : '') + '"></span></span>' +
          '<div class="lc-sess-main">' +
            '<div class="lc-sess-top">' +
              '<span class="lc-sess-name" title="' + escapeHtml(s.title) + '">' + escapeHtml(s.title) + '</span>' +
              '<div class="lc-sess-row-actions">' +
                '<button class="session-act-btn btn-rename" type="button" title="Rename">' + lcIcon('pencil', 12) + '</button>' +
                '<button class="session-act-btn btn-delete-session btn-delete" type="button" title="Delete">' + lcIcon('trash-2', 12) + '</button>' +
              '</div>' +
            '</div>' +
            '<div class="lc-sess-meta">' +
              '<span class="lc-sess-meta-icon">' + lcIcon('session-node', 11) + '</span>' +
              '<span class="lc-sess-time">' + escapeHtml(formatTimeAgo(s.updatedAt || s.createdAt)) + '</span>' +
            '</div>' +
          '</div>';

        item.addEventListener('click', (e) => {
          if (e.target.closest('.lc-sess-row-actions')) return;
          vscode.postMessage({ command: 'switchSession', sessionId: s.id });
        });

        item.querySelector('.btn-rename').addEventListener('click', (e) => {
          e.stopPropagation();
          const titleEl = item.querySelector('.lc-sess-name');
          if (!titleEl) return;
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'session-rename-input';
          input.value = s.title || '';
          let done = false;
          const finish = (save) => {
            if (done) return;
            done = true;
            const next = input.value.trim();
            if (save && next && next !== s.title) {
              vscode.postMessage({ command: 'renameSession', sessionId: s.id, title: next });
            } else {
              renderSessions(sessions, activeId);
            }
          };
          input.addEventListener('click', (ev) => ev.stopPropagation());
          input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
            if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
          });
          input.addEventListener('blur', () => finish(true));
          titleEl.replaceWith(input);
          input.focus();
          input.select();
        });

        item.querySelector('.btn-delete').addEventListener('click', (e) => {
          e.stopPropagation();
          const actionsEl = item.querySelector('.lc-sess-row-actions');
          if (!actionsEl) {
            vscode.postMessage({ command: 'deleteSession', sessionId: s.id, confirmed: true });
            return;
          }
          item.classList.add('confirming');
          actionsEl.innerHTML = '<button class="session-confirm-btn btn-confirm-del" type="button">Delete</button><button class="session-act-btn btn-cancel-del" type="button">' + lcIcon('x', 12) + '</button>';
          actionsEl.querySelector('.btn-confirm-del')?.addEventListener('click', (ev) => {
            ev.stopPropagation();
            vscode.postMessage({ command: 'deleteSession', sessionId: s.id, confirmed: true });
          });
          actionsEl.querySelector('.btn-cancel-del')?.addEventListener('click', (ev) => {
            ev.stopPropagation();
            item.classList.remove('confirming');
            renderSessions(sessions, activeId);
          });
        });

        sessionList.appendChild(item);
      });
    }
  </script>
</body>
</html>`;
  }
}
