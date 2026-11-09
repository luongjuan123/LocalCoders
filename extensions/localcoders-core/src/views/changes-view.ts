import * as vscode from 'vscode';
import { ChangesManager, ChangesSummary, ChangedFile } from '../context/changes-manager';

export class ChangesViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'localcoders.changesView';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly changesManager: ChangesManager
  ) {
    this.changesManager.onDidChangeChanges((summary) => {
      this.updateView(summary);
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
        case 'refresh':
          await this.changesManager.refresh();
          break;
      }
    });

    // Initial load
    this.changesManager.getSummary().then((summary) => this.updateView(summary));
  }

  public updateView(summary: ChangesSummary) {
    if (this._view) {
      this._view.webview.postMessage({ type: 'updateChanges', summary });
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
      --bg: var(--vscode-editor-background, #181818);
      --fg: var(--vscode-editor-foreground, #cccccc);
      --card-bg: var(--vscode-sideBar-background, #1e1e1e);
      --border: var(--vscode-widget-border, #2e2e2e);
      --hover-bg: var(--vscode-list-hoverBackground, #2a2a2a);
      --accent: #38bdf8;
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
      font-size: 12px;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      user-select: none;
    }
    .header {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      background: var(--card-bg);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .title-row h2 {
      font-size: 13px;
      font-weight: 600;
      color: var(--fg);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .summary-pills {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
    }
    .pill {
      padding: 2px 7px;
      border-radius: 12px;
      font-weight: 600;
    }
    .pill-files { background: rgba(255, 255, 255, 0.08); color: var(--fg); }
    .pill-add { background: rgba(34, 197, 94, 0.15); color: var(--success); }
    .pill-rem { background: rgba(239, 68, 68, 0.15); color: var(--danger); }

    .actions-bar {
      display: flex;
      gap: 6px;
    }
    .btn {
      padding: 5px 10px;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.05);
      color: var(--fg);
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      transition: all 0.15s ease;
    }
    .btn:hover { background: var(--hover-bg); }
    .btn-primary {
      background: var(--accent);
      color: #0f172a;
      border-color: var(--accent);
      font-weight: 600;
    }
    .btn-primary:hover { opacity: 0.9; }
    .btn-danger {
      background: rgba(239, 68, 68, 0.15);
      color: var(--danger);
      border-color: rgba(239, 68, 68, 0.3);
    }
    .btn-danger:hover { background: rgba(239, 68, 68, 0.25); }

    .files-list {
      flex: 1;
      overflow-y: auto;
      padding: 6px 0;
    }
    .file-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 14px;
      cursor: pointer;
      border-bottom: 1px solid rgba(255, 255, 255, 0.03);
      transition: background 0.15s ease;
    }
    .file-item:hover {
      background: var(--hover-bg);
    }
    .file-left {
      display: flex;
      align-items: center;
      gap: 8px;
      overflow: hidden;
      flex: 1;
    }
    .status-badge {
      font-size: 10px;
      font-weight: 700;
      width: 18px;
      height: 18px;
      border-radius: 3px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .status-M { background: rgba(56, 189, 248, 0.2); color: var(--accent); }
    .status-A { background: rgba(34, 197, 94, 0.2); color: var(--success); }
    .status-D { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
    .status-R { background: rgba(245, 158, 11, 0.2); color: var(--warning); }

    .file-names {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .filename {
      font-weight: 500;
      color: var(--fg);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .filepath {
      font-size: 10px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .file-stats {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      flex-shrink: 0;
    }
    .stat-add { color: var(--success); }
    .stat-rem { color: var(--danger); }

    .empty-state {
      padding: 40px 20px;
      text-align: center;
      color: var(--text-muted);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }
    .empty-icon {
      font-size: 28px;
      opacity: 0.5;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title-row">
      <h2>Changes</h2>
      <div class="summary-pills">
        <span class="pill pill-files" id="pill-files">0 files</span>
        <span class="pill pill-add" id="pill-add">+0</span>
        <span class="pill pill-rem" id="pill-rem">-0</span>
      </div>
    </div>
    <div class="actions-bar">
      <button class="btn btn-primary" id="btn-accept" title="Accept all changes and commit">Accept All</button>
      <button class="btn btn-danger" id="btn-reject" title="Discard working tree modifications">Reject All</button>
      <button class="btn" id="btn-critic" title="Audit diff with Critic Agent">Critic Review</button>
    </div>
  </div>

  <div class="files-list" id="files-list">
    <div class="empty-state">
      <div class="empty-icon">✓</div>
      <div>No changes yet</div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const filesList = document.getElementById('files-list');
    const pillFiles = document.getElementById('pill-files');
    const pillAdd = document.getElementById('pill-add');
    const pillRem = document.getElementById('pill-rem');

    document.getElementById('btn-accept').addEventListener('click', () => {
      vscode.postMessage({ command: 'acceptAll' });
    });
    document.getElementById('btn-reject').addEventListener('click', () => {
      vscode.postMessage({ command: 'rejectAll' });
    });
    document.getElementById('btn-critic').addEventListener('click', () => {
      vscode.postMessage({ command: 'reviewCritic' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'updateChanges') {
        renderChanges(msg.summary);
      }
    });

    function renderChanges(summary) {
      pillFiles.textContent = summary.totalFiles + (summary.totalFiles === 1 ? ' file' : ' files');
      pillAdd.textContent = '+' + summary.totalAdded;
      pillRem.textContent = '-' + summary.totalRemoved;

      if (!summary.files || summary.files.length === 0) {
        filesList.innerHTML = '<div class="empty-state"><div class="empty-icon">✓</div><div>No changes yet</div></div>';
        return;
      }

      filesList.innerHTML = '';
      summary.files.forEach((file) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.innerHTML = \`
          <div class="file-left">
            <span class="status-badge status-\${file.status}">\${file.status}</span>
            <div class="file-names">
              <span class="filename">\${file.filename}</span>
              <span class="filepath">\${file.directory || '.'}</span>
            </div>
          </div>
          <div class="file-stats">
            \${file.added > 0 ? \`<span class="stat-add">+\${file.added}</span>\` : ''}
            \${file.removed > 0 ? \`<span class="stat-rem">-\${file.removed}</span>\` : ''}
          </div>
        \`;
        item.addEventListener('click', () => {
          vscode.postMessage({ command: 'openDiff', path: file.path });
        });
        filesList.appendChild(item);
      });
    }
  </script>
</body>
</html>`;
  }
}
