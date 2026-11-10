import * as vscode from 'vscode';
import { AgentOrchestrator } from '../agents/orchestrator';
import { AgentRegistry } from '../agents/agent-registry';
import { AgentActivityEvent } from '../agents/types';
import { AgentStreamEvent, sanitizeActivityText } from '../agents/events';

export class AgentMonitorViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'localcoders.agentMonitorPanel';
  private _view?: vscode.WebviewView;
  private logs: AgentActivityEvent[] = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly orchestrator: AgentOrchestrator,
    private readonly registry: AgentRegistry
  ) {
    this.orchestrator.onActivity((ev) => {
      const cleaned = sanitizeActivityText(ev.latestActivity, ev.status);
      if (!cleaned) return;
      const safeEv: AgentActivityEvent = { ...ev, latestActivity: cleaned };
      this.logs.unshift(safeEv);
      if (this.logs.length > 200) this.logs.pop();
      this._view?.webview.postMessage({ type: 'activity', event: safeEv, allLogs: this.logs });
    });

    this.orchestrator.onStreamEvent((ev: AgentStreamEvent) => {
      if (ev.kind === 'activity_upsert') {
        const it = ev.item;
        const cmdOrTitle = it.command ? `$ ${it.command}` : it.title;
        const dur = it.durationMs ? ` (${it.durationMs}ms)` : '';
        const ec = it.exitCode !== undefined && it.exitCode !== null ? ` [exit ${it.exitCode}]` : '';
        const safeEv: AgentActivityEvent = {
          agentId: it.agentId,
          agentName: it.agentName,
          status: it.status === 'running' ? 'working' : (it.status as any),
          latestActivity: `${it.status.toUpperCase()}: ${cmdOrTitle}${ec}${dur}`,
          timestamp: it.timestamp,
        };
        const existingIdx = this.logs.findIndex((l) => (l as any)._actId === it.id);
        if (existingIdx !== -1) {
          this.logs[existingIdx] = Object.assign(safeEv, { _actId: it.id }) as any;
        } else {
          this.logs.unshift(Object.assign(safeEv, { _actId: it.id }) as any);
          if (this.logs.length > 200) this.logs.pop();
        }
        this._view?.webview.postMessage({ type: 'activity', event: safeEv, allLogs: this.logs });
      }
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

    webviewView.webview.onDidReceiveMessage((data) => {
      if (data.command === 'getInitialState') {
        const main = this.registry.getMainAgent();
        const subs = this.registry.getSubagents();
        const critic = this.registry.getCriticConfig();
        this._view?.webview.postMessage({
          type: 'initialState',
          mainAgent: main,
          subagents: subs,
          criticConfig: critic,
          logs: this.logs,
        });
      }
    });
  }

  private _getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --card-bg: var(--vscode-sideBar-background);
      --border: var(--vscode-widget-border, #334155);
      --accent: #38bdf8;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 13px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .agent-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
    }
    .badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .badge-idle { background: #334155; color: #cbd5e1; }
    .badge-working { background: rgba(56, 189, 248, 0.2); color: var(--accent); }
    .badge-planning { background: rgba(168, 85, 247, 0.2); color: #c084fc; }
    .badge-completed { background: rgba(16, 185, 129, 0.2); color: var(--success); }
    .badge-failed { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
    .badge-cancelled { background: rgba(245, 158, 11, 0.2); color: var(--warning); }

    .logs-header {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--fg);
    }
    #logs-table {
      flex: 1;
      overflow-y: auto;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.2);
      font-family: monospace;
      font-size: 12px;
    }
    .log-row {
      display: flex;
      padding: 6px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      gap: 12px;
    }
    .log-time { color: #64748b; white-space: nowrap; }
    .log-agent { color: var(--accent); font-weight: 600; width: 140px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .log-text { flex: 1; word-break: break-all; }
  </style>
</head>
<body>
  <div class="grid" id="agents-grid">
    <div class="agent-card">
      <div style="display: flex; justify-content: space-between;">
        <strong>Main Agent</strong>
        <span class="badge badge-idle" id="main-badge">IDLE</span>
      </div>
      <div style="font-size: 12px; color: #94a3b8; margin-top: 4px;" id="main-model">Model: Not selected</div>
    </div>
    <div class="agent-card">
      <div style="display: flex; justify-content: space-between;">
        <strong>Critic Agent</strong>
        <span class="badge badge-idle" id="critic-badge">IDLE</span>
      </div>
      <div style="font-size: 12px; color: #94a3b8; margin-top: 4px;" id="critic-model">Model: Not selected</div>
    </div>
  </div>

  <div class="logs-header">Live Multi-Agent Activity & Tool Logs</div>
  <div id="logs-table">
    <div style="padding: 12px; color: #64748b;">No agent events recorded yet.</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const logsTable = document.getElementById('logs-table');

    window.addEventListener('load', () => {
      vscode.postMessage({ command: 'getInitialState' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'initialState') {
        if (msg.mainAgent) {
          document.getElementById('main-model').innerText = 'Model: ' + msg.mainAgent.model;
        }
        if (msg.criticConfig) {
          document.getElementById('critic-model').innerText = 'Model: ' + (msg.criticConfig.model || 'Inherited');
        }
        if (msg.logs && msg.logs.length > 0) {
          renderLogs(msg.logs);
        }
      } else if (msg.type === 'activity') {
        const ev = msg.event;
        if (ev.agentId === 'main') {
          const badge = document.getElementById('main-badge');
          badge.className = 'badge badge-' + ev.status;
          badge.innerText = ev.status.toUpperCase();
        } else if (ev.agentId === 'critic') {
          const badge = document.getElementById('critic-badge');
          badge.className = 'badge badge-' + ev.status;
          badge.innerText = ev.status.toUpperCase();
        }
        renderLogs(msg.allLogs);
      }
    });

    function renderLogs(logs) {
      logsTable.innerHTML = logs.map(l => \`
        <div class="log-row">
          <span class="log-time">\${new Date(l.timestamp).toLocaleTimeString()}</span>
          <span class="log-agent">\${escapeHtml(l.agentName)}</span>
          <span class="log-text">\${escapeHtml(l.latestActivity)}</span>
        </div>
      \`).join('');
    }

    function escapeHtml(text) {
      if (!text) return '';
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  </script>
</body>
</html>`;
  }
}
