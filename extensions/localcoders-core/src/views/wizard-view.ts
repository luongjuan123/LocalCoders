import * as vscode from 'vscode';
import { OllamaClient } from '../ollama/client';
import { AgentRegistry } from '../agents/agent-registry';
import { detectHardware } from '../ollama/hardware';
import { getModelCatalogue } from '../ollama/catalogue';

export class SetupWizardPanel {
  public static currentPanel: SetupWizardPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  private ollama: OllamaClient;
  private registry: AgentRegistry;

  public static createOrShow(extensionUri: vscode.Uri, ollama: OllamaClient, registry: AgentRegistry) {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    if (SetupWizardPanel.currentPanel) {
      SetupWizardPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'localcodersWizard',
      'LocalCoders — Setup Wizard',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    SetupWizardPanel.currentPanel = new SetupWizardPanel(panel, extensionUri, ollama, registry);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    ollama: OllamaClient,
    registry: AgentRegistry
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this.ollama = ollama;
    this.registry = registry;

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'getInitialData': {
            const hw = await detectHardware(this.ollama.getHost());
            const models = await this.ollama.listModels();
            const catalogue = getModelCatalogue(models);
            const mainAgent = this.registry.getMainAgent();
            const subagents = this.registry.getSubagents();
            const criticConfig = this.registry.getCriticConfig();

            this._panel.webview.postMessage({
              type: 'initialData',
              hardware: hw,
              installedModels: models,
              catalogue,
              mainAgent,
              subagents,
              criticConfig,
              predefinedRoles: AgentRegistry.getPredefinedRoles(),
            });
            break;
          }

          case 'pullModel': {
            const modelName = message.modelName;
            try {
              await this.ollama.pullModel(modelName, (prog) => {
                this._panel.webview.postMessage({
                  type: 'pullProgress',
                  modelName,
                  progress: prog,
                });
              });
              const updatedModels = await this.ollama.listModels();
              this._panel.webview.postMessage({
                type: 'pullComplete',
                modelName,
                installedModels: updatedModels,
              });
            } catch (err: any) {
              this._panel.webview.postMessage({
                type: 'pullError',
                modelName,
                error: err.message,
              });
            }
            break;
          }

          case 'deleteModel': {
            const modelName = message.modelName;
            await this.ollama.deleteModel(modelName);
            const updatedModels = await this.ollama.listModels();
            this._panel.webview.postMessage({
              type: 'modelDeleted',
              modelName,
              installedModels: updatedModels,
            });
            break;
          }

          case 'saveConfiguration': {
            const { mainAgent, subagents, criticConfig } = message;
            if (mainAgent && mainAgent.model) {
              this.registry.setMainAgent(mainAgent);
            }
            if (Array.isArray(subagents)) {
              for (const s of subagents) {
                this.registry.addSubagent(s);
              }
            }
            if (criticConfig) {
              this.registry.setCriticConfig(criticConfig);
            }

            vscode.window.showInformationMessage('LocalCoders: Agent configuration successfully saved!');
            this._panel.dispose();
            break;
          }
        }
      },
      null,
      this._disposables
    );
  }

  public dispose() {
    SetupWizardPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  private _update() {
    this._panel.webview.html = this._getHtmlForWebview();
  }

  private _getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LocalCoders Setup Wizard</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --accent-hover: #0284c7;
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      padding: 32px;
      line-height: 1.6;
    }
    .container { max-width: 900px; margin: 0 auto; }
    .header { text-align: center; margin-bottom: 32px; }
    .header h1 { font-size: 28px; font-weight: 700; color: var(--accent); margin-bottom: 8px; }
    .header p { color: var(--text-muted); font-size: 15px; }

    /* Steps Indicator */
    .steps-nav { display: flex; justify-content: space-between; margin-bottom: 32px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
    .step-item { font-size: 14px; font-weight: 600; color: var(--text-muted); cursor: pointer; padding: 6px 12px; border-radius: 6px; }
    .step-item.active { color: var(--accent); background: rgba(56, 189, 248, 0.15); border: 1px solid var(--accent); }
    .step-item.done { color: var(--success); }

    /* Cards & Sections */
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 24px; }
    .card h2 { font-size: 18px; margin-bottom: 16px; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 16px; }
    .stat-box { background: rgba(15, 23, 42, 0.6); padding: 12px 16px; border-radius: 8px; border: 1px solid var(--border); }
    .stat-label { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-val { font-size: 16px; font-weight: 600; color: var(--text); margin-top: 4px; }

    /* Forms */
    .form-group { margin-bottom: 16px; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: var(--text-muted); }
    select, input[type="text"], textarea {
      width: 100%;
      background: #0f172a;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 14px;
      outline: none;
    }
    select:focus, input:focus, textarea:focus { border-color: var(--accent); }

    /* Buttons */
    .btn {
      background: var(--accent);
      color: #0f172a;
      font-weight: 600;
      border: none;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .btn:hover { background: var(--accent-hover); }
    .btn-secondary { background: #334155; color: var(--text); }
    .btn-secondary:hover { background: #475569; }
    .btn-danger { background: var(--danger); color: white; }
    .btn-success { background: var(--success); color: white; }
    .btn-sm { padding: 6px 12px; font-size: 12px; }

    /* Model items */
    .model-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: rgba(15, 23, 42, 0.5);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-bottom: 10px;
    }
    .model-meta { display: flex; gap: 8px; font-size: 12px; margin-top: 4px; }
    .tag { background: #334155; padding: 2px 8px; border-radius: 4px; color: #cbd5e1; }
    .tag-coding { background: rgba(56, 189, 248, 0.2); color: #38bdf8; }
    .tag-reasoning { background: rgba(244, 63, 94, 0.2); color: #f43f5e; }

    .nav-buttons { display: flex; justify-content: space-between; margin-top: 32px; }
    .hidden { display: none !important; }
    .progress-bar { width: 100%; height: 8px; background: #334155; border-radius: 4px; overflow: hidden; margin-top: 8px; }
    .progress-fill { height: 100%; background: var(--accent); width: 0%; transition: width 0.2s; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>LocalCoders Setup Wizard</h1>
      <p>Configure your local-first multi-agent AI coding environment powered by Ollama</p>
    </div>

    <div class="steps-nav">
      <div class="step-item active" id="nav-step-1" onclick="goToStep(1)">1. Welcome & Hardware</div>
      <div class="step-item" id="nav-step-2" onclick="goToStep(2)">2. Ollama Status</div>
      <div class="step-item" id="nav-step-3" onclick="goToStep(3)">3. Model Manager</div>
      <div class="step-item" id="nav-step-4" onclick="goToStep(4)">4. Agent Team</div>
      <div class="step-item" id="nav-step-5" onclick="goToStep(5)">5. Finish</div>
    </div>

    <!-- STEP 1: WELCOME & HARDWARE -->
    <div id="step-1" class="step-content">
      <div class="card">
        <h2>Hardware & System Diagnostics</h2>
        <div class="grid">
          <div class="stat-box">
            <div class="stat-label">Operating System</div>
            <div class="stat-val" id="hw-os">Detecting...</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">CPU Cores</div>
            <div class="stat-val" id="hw-cpu">Detecting...</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">Total RAM / Available</div>
            <div class="stat-val" id="hw-ram">Detecting...</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">GPU Acceleration</div>
            <div class="stat-val" id="hw-gpu">Detecting...</div>
          </div>
        </div>
        <p style="color: var(--text-muted); font-size: 13px;">
          LocalCoders uses local Ollama inference on your machine. All calculations run strictly on your hardware with complete privacy and zero mandatory external cloud APIs.
        </p>
      </div>
    </div>

    <!-- STEP 2: OLLAMA STATUS -->
    <div id="step-2" class="step-content hidden">
      <div class="card">
        <h2>Ollama Connection Status</h2>
        <div id="ollama-status-banner" style="padding: 16px; border-radius: 8px; margin-bottom: 16px; background: rgba(16, 185, 129, 0.15); border: 1px solid var(--success);">
          <strong id="ollama-status-title">Checking Ollama connection...</strong>
          <p id="ollama-status-desc" style="font-size: 13px; margin-top: 4px;">Connecting to http://127.0.0.1:11434...</p>
        </div>
        <div class="form-group">
          <label>Ollama API Host Endpoint</label>
          <input type="text" id="ollama-host" value="http://127.0.0.1:11434" />
        </div>
      </div>
    </div>

    <!-- STEP 3: MODEL MANAGER -->
    <div id="step-3" class="step-content hidden">
      <div class="card">
        <h2>Installed Ollama Models</h2>
        <div id="installed-models-list">Loading installed models...</div>
      </div>

      <div class="card">
        <h2>Available Model Catalogue</h2>
        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 16px;">Download coding, reasoning, and review models directly into Ollama:</p>
        <div id="catalogue-list">Loading catalogue...</div>
      </div>
    </div>

    <!-- STEP 4: AGENT TEAM -->
    <div id="step-4" class="step-content hidden">
      <div class="card" style="border-left: 4px solid var(--accent);">
        <h2>Main Agent (Mandatory)</h2>
        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 16px;">
          The Main Agent plans implementation, calls tools, delegates tasks, and coordinates the entire workflow.
        </p>
        <div class="form-group">
          <label>Assigned Model *</label>
          <select id="main-agent-model"></select>
        </div>
        <div class="form-group">
          <label>System Instructions</label>
          <textarea id="main-agent-prompt" rows="3">You are the Lead Main Agent in LocalCoders. You plan implementations, inspect context, delegate tasks to subagents, execute tools, and coordinate production quality code changes.</textarea>
        </div>
      </div>

      <div class="card" style="border-left: 4px solid var(--danger);">
        <h2>Critic Agent (Independent Reviewer)</h2>
        <div class="form-group" style="display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" id="critic-enabled" checked />
          <label for="critic-enabled" style="margin-bottom: 0;">Enable Independent Critic Agent</label>
        </div>
        <div class="form-group">
          <label>Critic Model</label>
          <select id="critic-model"></select>
        </div>
        <div class="form-group">
          <label>Review Strictness</label>
          <select id="critic-strictness">
            <option value="strict" selected>Strict (Full audit of logic, security, race conditions, edge cases)</option>
            <option value="paranoid">Paranoid (Comprehensive verification of all changes & boundary conditions)</option>
            <option value="moderate">Moderate (Standard defect and security audit)</option>
            <option value="lenient">Lenient (High-level review only)</option>
          </select>
        </div>
      </div>
    </div>

    <!-- STEP 5: SUMMARY -->
    <div id="step-5" class="step-content hidden">
      <div class="card">
        <h2>Configuration Summary</h2>
        <div id="summary-content">Preparing summary...</div>
        <button class="btn btn-success" style="margin-top: 20px; width: 100%; justify-content: center;" onclick="saveAndFinish()">
          Save Configuration & Launch LocalCoders
        </button>
      </div>
    </div>

    <!-- Navigation Buttons -->
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btn-prev" onclick="prevStep()" disabled>Previous</button>
      <button class="btn" id="btn-next" onclick="nextStep()">Next</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentStep = 1;
    let initialData = null;

    window.addEventListener('load', () => {
      vscode.postMessage({ command: 'getInitialData' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'initialData') {
        initialData = msg;
        renderDiagnostics(msg.hardware);
        renderOllama(msg.hardware);
        renderModels(msg.installedModels, msg.catalogue);
        populateAgentSelects(msg.installedModels, msg.mainAgent, msg.criticConfig);
      } else if (msg.type === 'pullProgress') {
        updatePullProgress(msg.modelName, msg.progress);
      } else if (msg.type === 'pullComplete') {
        alert('Model ' + msg.modelName + ' installed successfully!');
        vscode.postMessage({ command: 'getInitialData' });
      } else if (msg.type === 'pullError') {
        alert('Failed to pull ' + msg.modelName + ': ' + msg.error);
      }
    });

    function renderDiagnostics(hw) {
      document.getElementById('hw-os').innerText = hw.os;
      document.getElementById('hw-cpu').innerText = hw.cpu.model + ' (' + hw.cpu.cores + ' cores)';
      document.getElementById('hw-ram').innerText = hw.ram.totalGb + ' GB (' + hw.ram.availableGb + ' GB available)';
      document.getElementById('hw-gpu').innerText = hw.gpu ? hw.gpu.name + ' (' + hw.gpu.memoryTotalMb + ' MB)' : 'CPU Only (No discrete GPU detected)';
    }

    function renderOllama(hw) {
      const title = document.getElementById('ollama-status-title');
      const desc = document.getElementById('ollama-status-desc');
      const banner = document.getElementById('ollama-status-banner');

      if (hw.ollamaRunning) {
        title.innerText = 'Ollama Service Connected (v' + (hw.ollamaVersion || 'detected') + ')';
        desc.innerText = 'Ollama is running locally and responding to API requests.';
        banner.style.background = 'rgba(16, 185, 129, 0.15)';
        banner.style.borderColor = 'var(--success)';
      } else if (hw.ollamaInstalled) {
        title.innerText = 'Ollama Installed but Not Running';
        desc.innerText = 'Please start the Ollama daemon with: ollama serve';
        banner.style.background = 'rgba(245, 158, 11, 0.15)';
        banner.style.borderColor = 'var(--warning)';
      } else {
        title.innerText = 'Ollama Not Detected';
        desc.innerText = 'Please install Ollama from https://ollama.com before continuing.';
        banner.style.background = 'rgba(239, 68, 68, 0.15)';
        banner.style.borderColor = 'var(--danger)';
      }
    }

    function renderModels(installed, catalogue) {
      const installedContainer = document.getElementById('installed-models-list');
      if (!installed || installed.length === 0) {
        installedContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 13px;">No models installed in Ollama yet. Install a model below to proceed.</p>';
      } else {
        installedContainer.innerHTML = installed.map(m => \`
          <div class="model-item">
            <div>
              <strong>\${m.name}</strong>
              <div class="model-meta">
                <span class="tag">\${(m.size / (1024*1024*1024)).toFixed(1)} GB</span>
                <span class="tag">\${m.details?.parameter_size || 'N/A'}</span>
                <span class="tag">\${m.details?.format || 'GGUF'}</span>
              </div>
            </div>
            <button class="btn btn-danger btn-sm" onclick="deleteModel('\${m.name}')">Delete</button>
          </div>
        \`).join('');
      }

      const catContainer = document.getElementById('catalogue-list');
      catContainer.innerHTML = catalogue.map(c => \`
        <div class="model-item" id="cat-\${c.tag.replace(/[:.]/g, '-')}">
          <div style="max-width: 75%;">
            <strong>\${c.name}</strong> (\${c.tag})
            <p style="font-size: 13px; color: var(--text-muted); margin: 4px 0;">\${c.description}</p>
            <div class="model-meta">
              <span class="tag tag-\${c.category}">\${c.category.toUpperCase()}</span>
              <span class="tag">\${c.size}</span>
              <span class="tag">Min \${c.minRamGb} GB RAM</span>
            </div>
            <div class="progress-bar hidden" id="prog-\${c.tag.replace(/[:.]/g, '-')}">
              <div class="progress-fill" id="fill-\${c.tag.replace(/[:.]/g, '-')}"></div>
            </div>
          </div>
          <div>
            \${c.installed
              ? '<span style="color: var(--success); font-size: 13px; font-weight: 600;">Installed</span>'
              : \`<button class="btn btn-sm" onclick="pullModel('\${c.tag}')">Pull Model</button>\`
            }
          </div>
        </div>
      \`).join('');
    }

    function populateAgentSelects(installed, mainAgent, criticConfig) {
      const mainSelect = document.getElementById('main-agent-model');
      const criticSelect = document.getElementById('critic-model');

      const options = installed.map(m => \`<option value="\${m.name}">\${m.name} (\${m.details?.parameter_size || ''})</option>\`).join('');
      mainSelect.innerHTML = options || '<option value="">No models installed</option>';
      criticSelect.innerHTML = options || '<option value="">No models installed</option>';

      if (mainAgent && mainAgent.model) mainSelect.value = mainAgent.model;
      if (criticConfig && criticConfig.model) criticSelect.value = criticConfig.model;
    }

    function pullModel(tag) {
      const progBar = document.getElementById('prog-' + tag.replace(/[:.]/g, '-'));
      if (progBar) progBar.classList.remove('hidden');
      vscode.postMessage({ command: 'pullModel', modelName: tag });
    }

    function updatePullProgress(tag, prog) {
      const fill = document.getElementById('fill-' + tag.replace(/[:.]/g, '-'));
      if (fill && prog.percent !== undefined) {
        fill.style.width = prog.percent + '%';
      }
    }

    function deleteModel(name) {
      if (confirm('Are you sure you want to delete model ' + name + '?')) {
        vscode.postMessage({ command: 'deleteModel', modelName: name });
      }
    }

    function goToStep(s) {
      document.querySelectorAll('.step-content').forEach(el => el.classList.add('hidden'));
      document.querySelectorAll('.step-item').forEach(el => el.classList.remove('active'));

      currentStep = s;
      document.getElementById('step-' + s).classList.remove('hidden');
      document.getElementById('nav-step-' + s).classList.add('active');

      document.getElementById('btn-prev').disabled = (s === 1);
      document.getElementById('btn-next').innerText = (s === 5) ? 'Finish' : 'Next';

      if (s === 5) renderSummary();
    }

    function nextStep() {
      if (currentStep === 4) {
        const mainModel = document.getElementById('main-agent-model').value;
        if (!mainModel) {
          alert('Mandatory Main Agent requires an installed model! Please install a model in Step 3.');
          return;
        }
      }
      if (currentStep < 5) goToStep(currentStep + 1);
      else saveAndFinish();
    }

    function prevStep() {
      if (currentStep > 1) goToStep(currentStep - 1);
    }

    function renderSummary() {
      const mainModel = document.getElementById('main-agent-model').value;
      const criticEnabled = document.getElementById('critic-enabled').checked;
      const criticModel = document.getElementById('critic-model').value;
      const strictness = document.getElementById('critic-strictness').value;

      document.getElementById('summary-content').innerHTML = \`
        <div class="stat-box" style="margin-bottom: 12px;">
          <div class="stat-label">Main Agent</div>
          <div class="stat-val">\${mainModel || 'None Selected'}</div>
        </div>
        <div class="stat-box" style="margin-bottom: 12px;">
          <div class="stat-label">Critic Agent</div>
          <div class="stat-val">\${criticEnabled ? 'Enabled (' + criticModel + ', Strictness: ' + strictness + ')' : 'Disabled'}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Default Ollama Endpoint</div>
          <div class="stat-val">\${document.getElementById('ollama-host').value}</div>
        </div>
      \`;
    }

    function saveAndFinish() {
      const mainModel = document.getElementById('main-agent-model').value;
      if (!mainModel) {
        alert('You must select a model for the Main Agent!');
        return;
      }

      vscode.postMessage({
        command: 'saveConfiguration',
        mainAgent: {
          id: 'main',
          name: 'Main Agent',
          role: 'Lead Architect & Orchestrator',
          model: mainModel,
          systemPrompt: document.getElementById('main-agent-prompt').value,
          enabled: true,
          maxConcurrency: 1,
          temperature: 0.2,
          contextWindow: 32768,
        },
        subagents: [],
        criticConfig: {
          enabled: document.getElementById('critic-enabled').checked,
          model: document.getElementById('critic-model').value || mainModel,
          strictness: document.getElementById('critic-strictness').value,
          categories: ['Logical correctness', 'Security vulnerabilities', 'Race conditions', 'Memory leaks', 'Performance', 'Edge cases'],
          trigger: 'on_diff',
          reviewMode: 'changed_files',
        }
      });
    }
  </script>
</body>
</html>`;
  }
}
