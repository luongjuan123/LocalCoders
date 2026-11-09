import * as vscode from 'vscode';
import { AgentOrchestrator } from '../agents/orchestrator';
import { CriticFinding, CriticReport } from '../agents/types';

export class CriticFindingsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'localcoders.criticFindingsPanel';
  private _view?: vscode.WebviewView;
  private latestReport: CriticReport | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly orchestrator: AgentOrchestrator
  ) {
    this.orchestrator.onCriticReport((report) => {
      this.latestReport = report;
      this._view?.webview.postMessage({ type: 'report', report });
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
        case 'fixFinding': {
          const finding = data.finding;
          const prompt = `Please fix this verified defect identified by the Critic Agent:
Severity: ${finding.severity}
File: ${finding.filePath} (lines ${finding.lineRange || 'N/A'})
Evidence: ${finding.evidence}
Problem: ${finding.explanation}
Recommended Fix: ${finding.recommendedFix}`;

          vscode.window.showInformationMessage(`LocalCoders: Instructing Main Agent to fix defect in ${finding.filePath}...`);
          try {
            await this.orchestrator.submitTask(prompt);
          } catch (err: any) {
            vscode.window.showErrorMessage(`Fix error: ${err.message}`);
          }
          break;
        }

        case 'triggerReview': {
          vscode.commands.executeCommand('localcoders.reviewGitChanges');
          break;
        }

        case 'openFile': {
          const filePath = data.filePath;
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders && workspaceFolders.length > 0) {
            const uri = vscode.Uri.joinPath(workspaceFolders[0].uri, filePath);
            try {
              const doc = await vscode.workspace.openTextDocument(uri);
              await vscode.window.showTextDocument(doc);
            } catch (err) {
              console.error('[CriticView] Failed to open file:', err);
            }
          }
          break;
        }
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
      --critical: #ef4444;
      --high: #f97316;
      --medium: #f59e0b;
      --low: #3b82f6;
      --info: #64748b;
      --accent: #38bdf8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 13px;
      padding: 16px;
      overflow-y: auto;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .btn {
      background: var(--accent);
      color: #0f172a;
      padding: 6px 12px;
      border-radius: 4px;
      border: none;
      font-weight: 600;
      cursor: pointer;
      font-size: 12px;
    }
    .finding-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
      margin-bottom: 12px;
    }
    .finding-card.sev-Critical { border-left: 4px solid var(--critical); }
    .finding-card.sev-High { border-left: 4px solid var(--high); }
    .finding-card.sev-Medium { border-left: 4px solid var(--medium); }
    .finding-card.sev-Low { border-left: 4px solid var(--low); }
    .finding-card.sev-Informational { border-left: 4px solid var(--info); }

    .sev-badge {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
    }
    .sev-badge.sev-Critical { background: rgba(239, 68, 68, 0.2); color: var(--critical); }
    .sev-badge.sev-High { background: rgba(249, 115, 22, 0.2); color: var(--high); }
    .sev-badge.sev-Medium { background: rgba(245, 158, 11, 0.2); color: var(--medium); }
    .sev-badge.sev-Low { background: rgba(59, 130, 246, 0.2); color: var(--low); }
    .sev-badge.sev-Informational { background: rgba(100, 116, 139, 0.2); color: var(--info); }

    .file-link {
      color: var(--accent);
      cursor: pointer;
      text-decoration: underline;
      font-family: monospace;
      font-size: 12px;
    }
    .code-box {
      background: rgba(0, 0, 0, 0.3);
      padding: 6px 10px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 11px;
      margin: 6px 0;
      white-space: pre-wrap;
    }
    .btn-fix {
      background: #059669;
      color: white;
      padding: 4px 10px;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <strong style="font-size: 15px;">Critic Audit Reports</strong>
      <span id="verdict-tag" style="margin-left: 8px; font-weight: 600;"></span>
    </div>
    <button class="btn" onclick="triggerReview()">Run Critic Audit Now</button>
  </div>

  <div id="findings-container">
    <p style="color: #94a3b8; font-size: 13px;">No code review reports available. Run a Critic audit or complete a coding task to inspect findings.</p>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const container = document.getElementById('findings-container');
    const verdictTag = document.getElementById('verdict-tag');

    function triggerReview() {
      vscode.postMessage({ command: 'triggerReview' });
    }

    function openFile(path) {
      vscode.postMessage({ command: 'openFile', filePath: path });
    }

    function fixFinding(f) {
      vscode.postMessage({ command: 'fixFinding', finding: f });
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'report') {
        const r = msg.report;
        verdictTag.innerText = 'Verdict: ' + r.verdict.toUpperCase();
        verdictTag.style.color = (r.verdict === 'approved') ? '#10b981' : (r.verdict === 'blocker') ? '#ef4444' : '#f59e0b';

        if (!r.findings || r.findings.length === 0) {
          container.innerHTML = '<div style="color: #10b981; font-weight: 600; padding: 16px;">✓ Critic verified: 0 defects discovered. Code is approved.</div>';
          return;
        }

        container.innerHTML = r.findings.map(f => \`
          <div class="finding-card sev-\${f.severity}">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <div>
                <span class="sev-badge sev-\${f.severity}">\${f.severity}</span>
                <strong style="margin-left: 6px;">\${escapeHtml(f.category)}</strong>
              </div>
              <span class="file-link" onclick="openFile('\${escapeHtml(f.filePath)}')">\${escapeHtml(f.filePath)}\${f.lineRange ? ':' + f.lineRange : ''}</span>
            </div>
            <div style="font-size: 13px; margin: 4px 0;">\${escapeHtml(f.explanation)}</div>
            \${f.evidence ? '<div class="code-box"><strong>Evidence:</strong> ' + escapeHtml(f.evidence) + '</div>' : ''}
            \${f.recommendedFix ? '<div class="code-box"><strong>Fix:</strong> ' + escapeHtml(f.recommendedFix) + '</div>' : ''}
            <button class="btn-fix" onclick='fixFinding(\${JSON.stringify(f)})'>Ask Main Agent to Fix This</button>
          </div>
        \`).join('');
      }
    });

    function escapeHtml(text) {
      if (!text) return '';
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  </script>
</body>
</html>`;
  }
}
