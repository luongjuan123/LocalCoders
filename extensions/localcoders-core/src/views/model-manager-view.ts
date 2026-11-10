import * as vscode from 'vscode';
import {
  AgentRegistry,
} from '../agents/agent-registry';
import { OllamaClient } from '../ollama/client';
import { ModelProviderRegistry } from '../models/model-provider-registry';
import { ManualModelSpec, ModelParametersConfig, ReasoningEffort } from '../models/types';
import { getLucideCss, lucideSvg } from './lucide-icons';

export class ModelManagerPanel {
  public static currentPanel: ModelManagerPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _isDisposed = false;

  public static createOrShow(
    extensionUri: vscode.Uri,
    modelRegistry: ModelProviderRegistry,
    ollama: OllamaClient,
    agentRegistry: AgentRegistry
  ): void {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    if (ModelManagerPanel.currentPanel) {
      ModelManagerPanel.currentPanel._panel.reveal(column);
      ModelManagerPanel.currentPanel.sendState(true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'localcodersModelManager',
      'LocalCoders — Model & Provider Manager',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    ModelManagerPanel.currentPanel = new ModelManagerPanel(panel, extensionUri, modelRegistry, ollama, agentRegistry);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly modelRegistry: ModelProviderRegistry,
    private readonly ollama: OllamaClient,
    private readonly agentRegistry: AgentRegistry
  ) {
    this._panel = panel;
    this._panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'resources', 'icon.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'resources', 'icon.svg'),
    };

    this._panel.webview.html = this.getHtml();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._disposables.push(
      this.modelRegistry.onDidChangeModels(() => {
        this.sendState(false);
      })
    );

    this._panel.webview.onDidReceiveMessage(
      async (msg) => {
        switch (msg.command) {
          case 'init':
            await this.sendState(true);
            break;

          case 'refreshAll':
            await this.sendState(true);
            break;

          case 'updateEndpoint': {
            if (msg.providerId === 'ollama') {
              const res = await this.modelRegistry.setOllamaEndpoint(msg.baseUrl);
              this.postSafe({ type: 'testResult', providerId: 'ollama', result: res });
            } else {
              const res = await this.modelRegistry.updateProviderConfig(msg.providerId, {
                baseUrl: msg.baseUrl,
                name: msg.name,
                enabled: msg.enabled,
              });
              if (!res.ok) {
                this.postSafe({ type: 'actionError', error: res.error });
              }
            }
            await this.sendState(false);
            break;
          }

          case 'saveApiKey': {
            const res = await this.modelRegistry.setProviderApiKey(msg.providerId, msg.apiKey || '');
            this.postSafe({ type: 'testResult', providerId: msg.providerId, result: res });
            await this.sendState(false);
            break;
          }

          case 'clearApiKey': {
            const res = await this.modelRegistry.removeProviderApiKey(msg.providerId);
            this.postSafe({ type: 'testResult', providerId: msg.providerId, result: res });
            await this.sendState(false);
            break;
          }

          case 'testProvider': {
            const res = await this.modelRegistry.testProviderConnection(msg.providerId);
            this.postSafe({ type: 'testResult', providerId: msg.providerId, result: res });
            await this.sendState(false);
            break;
          }

          case 'addCustomProvider': {
            const manualModels: ManualModelSpec[] = [];
            if (msg.manualModelIdentifier && msg.manualModelIdentifier.trim()) {
              const efforts: ReasoningEffort[] = [];
              if (msg.manualReasoning) efforts.push('low', 'medium', 'high');
              manualModels.push({
                modelIdentifier: msg.manualModelIdentifier.trim(),
                displayName: msg.manualDisplayName?.trim() || undefined,
                contextWindow: msg.manualContextWindow ? parseInt(msg.manualContextWindow, 10) : undefined,
                supportsToolCalling: msg.manualTools !== false,
                supportsVision: Boolean(msg.manualVision),
                supportsStreaming: true,
                reasoningEffortsSupported: efforts,
              });
            }

            const res = await this.modelRegistry.addCustomProvider({
              name: msg.name || 'Custom Endpoint',
              baseUrl: msg.baseUrl,
              apiKey: msg.apiKey,
              manualModels,
            });
            if (!res.ok) {
              this.postSafe({ type: 'actionError', error: res.error });
            } else {
              this.postSafe({ type: 'actionSuccess', message: `Added custom provider '${msg.name || res.providerId}'` });
            }
            await this.sendState(false);
            break;
          }

          case 'addManualModel': {
            const spec: ManualModelSpec = {
              modelIdentifier: msg.modelIdentifier,
              displayName: msg.displayName || undefined,
              contextWindow: msg.contextWindow ? parseInt(msg.contextWindow, 10) : undefined,
              supportsToolCalling: Boolean(msg.supportsToolCalling),
              supportsVision: Boolean(msg.supportsVision),
              supportsStreaming: true,
              reasoningEffortsSupported: msg.supportsReasoning ? ['low', 'medium', 'high'] : [],
            };
            const res = await this.modelRegistry.addManualModel(msg.providerId, spec);
            if (!res.ok) {
              this.postSafe({ type: 'actionError', error: res.error });
            }
            await this.sendState(false);
            break;
          }

          case 'removeProvider': {
            await this.modelRegistry.removeProvider(msg.providerId);
            await this.sendState(false);
            break;
          }

          case 'removeManualModel': {
            await this.modelRegistry.removeManualModel(msg.providerId, msg.modelIdentifier);
            await this.sendState(false);
            break;
          }

          case 'toggleModelEnabled': {
            await this.modelRegistry.setModelEnabled(msg.modelId, Boolean(msg.enabled));
            await this.sendState(false);
            break;
          }

          case 'setDefaultModel': {
            await this.modelRegistry.setDefaultModel(msg.modelId);
            const main = this.agentRegistry.getMainAgent();
            if (main) {
              this.agentRegistry.setMainAgent({ ...main, model: msg.modelId });
            }
            this.postSafe({ type: 'actionSuccess', message: `Default model updated to '${msg.modelId}'` });
            await this.sendState(false);
            break;
          }

          case 'saveModelParams': {
            const params: ModelParametersConfig = {
              temperature: msg.temperature !== '' && msg.temperature !== undefined ? parseFloat(msg.temperature) : undefined,
              maxOutputTokens: msg.maxOutputTokens !== '' && msg.maxOutputTokens !== undefined ? parseInt(msg.maxOutputTokens, 10) : undefined,
              contextLimit: msg.contextLimit !== '' && msg.contextLimit !== undefined ? parseInt(msg.contextLimit, 10) : undefined,
              reasoningEffort: msg.reasoningEffort || undefined,
              fastMode: typeof msg.fastMode === 'boolean' ? msg.fastMode : undefined,
            };
            await this.modelRegistry.setModelParameters(msg.modelId, params);
            this.postSafe({ type: 'actionSuccess', message: `Saved parameters for '${msg.modelId}'` });
            await this.sendState(false);
            break;
          }

          case 'testModelChat': {
            const res = await this.modelRegistry.testModelCommunication(msg.modelId);
            this.postSafe({ type: 'modelTestResult', modelId: msg.modelId, result: res });
            break;
          }

          case 'pullOllamaModel': {
            const tag = (msg.tag || '').trim();
            if (!tag) return;
            this.modelRegistry.getOllamaProvider().markModelLoading(tag, true);
            await this.sendState(false);
            try {
              await this.ollama.pullModel(tag, (prog) => {
                this.postSafe({ type: 'pullProgress', tag, progress: prog });
              });
              this.modelRegistry.getOllamaProvider().markModelLoading(tag, false);
              await this.sendState(true);
              this.postSafe({ type: 'pullDone', tag });
            } catch (err: any) {
              this.modelRegistry.getOllamaProvider().markModelLoading(tag, false);
              this.postSafe({ type: 'actionError', error: err.message });
              await this.sendState(false);
            }
            break;
          }

          case 'deleteOllamaModel': {
            const modelIdentifier = (msg.modelIdentifier || '').trim();
            if (!modelIdentifier) return;
            await this.ollama.deleteModel(modelIdentifier);
            await this.sendState(true);
            break;
          }
        }
      },
      null,
      this._disposables
    );
  }

  private postSafe(data: any): void {
    if (this._isDisposed) return;
    try {
      this._panel.webview.postMessage(data);
    } catch {}
  }

  private async sendState(forceRefresh: boolean): Promise<void> {
    if (forceRefresh) {
      await this.modelRegistry.refreshAll(true);
    }
    const providers = await this.modelRegistry.getProviderStatuses(false);
    const models = await this.modelRegistry.getAvailableModels({ includeDisabled: true, forceRefresh: false });
    const defaultModelId = this.modelRegistry.getDefaultModelId();
    this.postSafe({
      type: 'state',
      providers,
      models,
      defaultModelId,
    });
  }

  public dispose(): void {
    this._isDisposed = true;
    ModelManagerPanel.currentPanel = undefined;
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
    try {
      this._panel.dispose();
    } catch {}
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>LocalCoders — Model &amp; Provider Manager</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #0d0e11);
    --card: #15171c;
    --border: rgba(255,255,255,0.1);
    --text: #f1f5f9;
    --muted: #94a3b8;
    --accent: #38bdf8;
    --green: #22c55e;
    --amber: #f59e0b;
    --red: #ef4444;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    padding: 24px 28px;
    line-height: 1.5;
  }
  .page { max-width: 1180px; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
  .topbar {
    display: flex; align-items: center; justify-content: space-between;
    border-bottom: 1px solid var(--border); padding-bottom: 14px;
  }
  .topbar h1 { font-size: 20px; font-weight: 700; color: #ffffff; }
  .topbar p { font-size: 12.5px; color: var(--muted); margin-top: 2px; }
  .btn {
    background: rgba(255,255,255,0.08); border: 1px solid var(--border); color: var(--text);
    padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer;
    transition: all 0.12s ease; display: inline-flex; align-items: center; gap: 6px;
  }
  ${getLucideCss()}
  .btn:hover { background: rgba(255,255,255,0.14); }
  .btn-primary { background: rgba(56,189,248,0.18); border-color: rgba(56,189,248,0.45); color: #7dd3fc; }
  .btn-primary:hover { background: rgba(56,189,248,0.28); color: #ffffff; }
  .btn-danger { background: rgba(239,68,68,0.14); border-color: rgba(239,68,68,0.35); color: #fca5a5; }
  .btn-sm { padding: 4px 9px; font-size: 11px; }
  .banner { padding: 10px 14px; border-radius: 7px; font-size: 12.5px; display: none; }
  .banner.ok { background: rgba(34,197,94,0.12); border: 1px solid rgba(34,197,94,0.35); color: #86efac; display: block; }
  .banner.err { background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.35); color: #fecaca; display: block; }
  .section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.7px; color: var(--muted); margin-bottom: 10px; display:flex; justify-content:space-between; align-items:center; }
  .providers-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
  .provider-card {
    background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .p-head { display: flex; align-items: center; justify-content: space-between; }
  .p-name { font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
  .badge { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 999px; text-transform: uppercase; }
  .b-connected { background: rgba(34,197,94,0.18); color: #4ade80; }
  .b-disconnected { background: rgba(245,158,11,0.18); color: #fbbf24; }
  .b-unconfigured { background: rgba(148,163,184,0.18); color: #cbd5e1; }
  .b-error { background: rgba(239,68,68,0.18); color: #f87171; }
  .b-local { background: rgba(56,189,248,0.16); color: #38bdf8; }
  .b-cloud { background: rgba(168,85,247,0.16); color: #c084fc; }
  label.field-lbl { font-size: 11px; color: var(--muted); display: block; margin-bottom: 4px; }
  .input-row { display: flex; gap: 6px; align-items: center; }
  input[type="text"], input[type="password"], input[type="number"], select {
    width: 100%; background: rgba(0,0,0,0.3); border: 1px solid var(--border); border-radius: 5px;
    padding: 6px 9px; color: var(--text); font-size: 12px; outline: none;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  input:focus { border-color: var(--accent); }
  .p-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .p-meta { font-size: 11px; color: var(--muted); }
  .p-err { font-size: 11px; color: #fca5a5; background: rgba(239,68,68,0.08); padding: 6px 8px; border-radius: 5px; word-break: break-word; }

  .card-panel { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .custom-form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-top: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); padding: 8px 10px; border-bottom: 1px solid var(--border); }
  td { padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05); vertical-align: middle; }
  tr:hover td { background: rgba(255,255,255,0.02); }
  .cap-pill { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 4px; background: rgba(255,255,255,0.08); color: #cbd5e1; margin: 1px 2px; }
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: none; align-items: center; justify-content: center; z-index: 50; }
  .modal-backdrop.open { display: flex; }
  .modal-box { background: #18181b; border: 1px solid var(--border); border-radius: 10px; padding: 20px; width: 420px; max-width: 92vw; display: flex; flex-direction: column; gap: 12px; }
</style>
</head>
<body>
<div class="page">
  <div class="topbar">
    <div>
      <h1>Model &amp; Provider Manager</h1>
      <p>Real model discovery only. API keys are stored encrypted in VS Code SecretStorage and never exposed to webviews.</p>
    </div>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-primary" id="btnRefreshAll">${lucideSvg('refresh-cw', 14)} Refresh Discovery</button>
    </div>
  </div>

  <div class="banner" id="toastBanner"></div>

  <div>
    <div class="section-title">
      <span>Configured Providers</span>
      <button class="btn btn-sm btn-primary" id="btnToggleCustomForm">+ Add Custom OpenAI-Compatible Provider</button>
    </div>

    <div class="card-panel" id="customProviderPanel" style="display:none; margin-bottom:14px;">
      <div style="font-size:13px;font-weight:700;margin-bottom:4px;">Add Custom OpenAI-Compatible Endpoint (LM Studio, vLLM, Groq, Together, LiteLLM)</div>
      <div class="custom-form-grid">
        <div>
          <label class="field-lbl">Provider Name *</label>
          <input type="text" id="cpName" placeholder="e.g. LM Studio Local" />
        </div>
        <div>
          <label class="field-lbl">Base URL *</label>
          <input type="text" id="cpUrl" placeholder="e.g. http://localhost:1234/v1" />
        </div>
        <div>
          <label class="field-lbl">API Key (Optional for local)</label>
          <input type="password" id="cpKey" placeholder="sk-..." />
        </div>
        <div>
          <label class="field-lbl">Optional Manual Model ID (if /models unsupported)</label>
          <input type="text" id="cpModelId" placeholder="e.g. llama-3.3-70b" />
        </div>
        <div>
          <label class="field-lbl">Display Name (Optional)</label>
          <input type="text" id="cpDisplayName" placeholder="Exact model name" />
        </div>
        <div>
          <label class="field-lbl">Context Window (Optional)</label>
          <input type="number" id="cpCtx" placeholder="e.g. 32768" />
        </div>
      </div>
      <div style="display:flex;gap:14px;align-items:center;margin-top:10px;font-size:12px;">
        <label><input type="checkbox" id="cpTools" checked /> Tool Calling</label>
        <label><input type="checkbox" id="cpVision" /> Vision</label>
        <label><input type="checkbox" id="cpReasoning" /> Reasoning Effort</label>
        <div style="flex:1;"></div>
        <button class="btn btn-sm" id="btnCancelCustom">Cancel</button>
        <button class="btn btn-sm btn-primary" id="btnSaveCustom">Save &amp; Test Provider</button>
      </div>
    </div>

    <div class="providers-grid" id="providersGrid"></div>
  </div>

  <div class="card-panel">
    <div class="section-title" style="margin-bottom:12px;">
      <span>Ollama Model Download Utility (Pull by Exact Tag)</span>
    </div>
    <div class="input-row" style="max-width:520px;">
      <input type="text" id="inpOllamaPullTag" placeholder="Enter Ollama library model tag (e.g. qwen3:8b, llama3.1:8b)" />
      <button class="btn btn-primary" id="btnPullOllama">Pull Model</button>
    </div>
    <div id="pullStatusText" style="font-size:11.5px;color:var(--accent);margin-top:6px;"></div>
  </div>

  <div class="card-panel">
    <div class="section-title">
      <span>Discovered &amp; Verified Models (<span id="modelsTotalCount">0</span>)</span>
      <input type="text" id="tblSearch" placeholder="Filter models..." style="width:240px;" />
    </div>
    <div style="overflow-x:auto;">
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Provider</th>
            <th>Status</th>
            <th>Context</th>
            <th>Capabilities &amp; Effort</th>
            <th>Source &amp; Pricing</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="modelsTableBody"></tbody>
      </table>
    </div>
  </div>
</div>

<!-- Model Parameter Editor Modal -->
<div class="modal-backdrop" id="paramModal">
  <div class="modal-box">
    <div style="font-size:15px;font-weight:700;">Configure Model Defaults</div>
    <div id="pmModelTitle" style="font-size:12px;color:var(--accent);font-family:monospace;"></div>
    <div>
      <label class="field-lbl">Default Reasoning Effort</label>
      <select id="pmEffort"></select>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div>
        <label class="field-lbl">Temperature</label>
        <input type="number" id="pmTemp" min="0" max="2" step="0.1" placeholder="Provider default" />
      </div>
      <div>
        <label class="field-lbl">Max Output Tokens</label>
        <input type="number" id="pmMaxTok" min="64" step="256" placeholder="Provider default" />
      </div>
    </div>
    <div id="pmCtxRow">
      <label class="field-lbl">Context Limit</label>
      <input type="number" id="pmCtx" min="1024" step="4096" placeholder="Auto" />
    </div>
    <div id="pmFastRow" style="font-size:12px;">
      <label><input type="checkbox" id="pmFast" /> Enable Fast Mode by default</label>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px;">
      <button class="btn btn-sm" id="btnCloseParamModal">Cancel</button>
      <button class="btn btn-sm btn-primary" id="btnSaveParamModal">Save Parameters</button>
    </div>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  let state = { providers: [], models: [], defaultModelId: '' };
  let editingModel = null;

  const toastBanner = document.getElementById('toastBanner');
  function showToast(text, isErr) {
    toastBanner.className = 'banner ' + (isErr ? 'err' : 'ok');
    toastBanner.textContent = text;
    setTimeout(() => { toastBanner.className = 'banner'; }, 6000);
  }
  function escapeHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  document.getElementById('btnRefreshAll').addEventListener('click', () => {
    vscode.postMessage({ command: 'refreshAll' });
  });
  document.getElementById('btnToggleCustomForm').addEventListener('click', () => {
    const p = document.getElementById('customProviderPanel');
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('btnCancelCustom').addEventListener('click', () => {
    document.getElementById('customProviderPanel').style.display = 'none';
  });
  document.getElementById('btnSaveCustom').addEventListener('click', () => {
    vscode.postMessage({
      command: 'addCustomProvider',
      name: document.getElementById('cpName').value,
      baseUrl: document.getElementById('cpUrl').value,
      apiKey: document.getElementById('cpKey').value,
      manualModelIdentifier: document.getElementById('cpModelId').value,
      manualDisplayName: document.getElementById('cpDisplayName').value,
      manualContextWindow: document.getElementById('cpCtx').value,
      manualTools: document.getElementById('cpTools').checked,
      manualVision: document.getElementById('cpVision').checked,
      manualReasoning: document.getElementById('cpReasoning').checked,
    });
    document.getElementById('cpKey').value = '';
    document.getElementById('customProviderPanel').style.display = 'none';
  });

  document.getElementById('btnPullOllama').addEventListener('click', () => {
    const tag = document.getElementById('inpOllamaPullTag').value.trim();
    if (!tag) return;
    vscode.postMessage({ command: 'pullOllamaModel', tag });
  });

  document.getElementById('tblSearch').addEventListener('input', renderModelsTable);

  document.getElementById('btnCloseParamModal').addEventListener('click', () => {
    document.getElementById('paramModal').classList.remove('open');
  });
  document.getElementById('btnSaveParamModal').addEventListener('click', () => {
    if (!editingModel) return;
    vscode.postMessage({
      command: 'saveModelParams',
      modelId: editingModel.id,
      reasoningEffort: document.getElementById('pmEffort').value,
      temperature: document.getElementById('pmTemp').value,
      maxOutputTokens: document.getElementById('pmMaxTok').value,
      contextLimit: document.getElementById('pmCtx').value,
      fastMode: document.getElementById('pmFast').checked,
    });
    document.getElementById('paramModal').classList.remove('open');
  });

  function renderProviders() {
    const grid = document.getElementById('providersGrid');
    grid.innerHTML = '';
    for (const p of state.providers || []) {
      const card = document.createElement('div');
      card.className = 'provider-card';
      const statusBadgeClass = 'b-' + (p.status || 'unconfigured');
      const isOllama = p.providerType === 'ollama';
      const isCustom = p.providerType === 'custom';

      card.innerHTML =
        '<div class="p-head">' +
          '<div class="p-name">' +
            '<span>' + escapeHtml(p.providerName) + '</span>' +
            '<span class="badge ' + (p.category === 'LOCAL' ? 'b-local' : 'b-cloud') + '">' + p.category + '</span>' +
          '</div>' +
          '<span class="badge ' + statusBadgeClass + '">' + escapeHtml(p.status) + '</span>' +
        '</div>' +
        '<div>' +
          '<label class="field-lbl">Endpoint URL</label>' +
          '<div class="input-row">' +
            '<input type="text" data-url="' + escapeHtml(p.providerId) + '" value="' + escapeHtml(p.baseUrl) + '" />' +
            '<button class="btn btn-sm" data-save-url="' + escapeHtml(p.providerId) + '">Save</button>' +
          '</div>' +
        '</div>' +
        (!isOllama ? (
          '<div>' +
            '<label class="field-lbl">API Key (' + (p.hasApiKey ? 'Stored securely: ' + escapeHtml(p.maskedApiKey || 'Configured') + (p.apiKeySource === 'env' ? ' via env' : '') : 'Not configured') + ')</label>' +
            '<div class="input-row">' +
              '<input type="password" data-key="' + escapeHtml(p.providerId) + '" placeholder="Enter API key to store securely..." />' +
              '<button class="btn btn-sm btn-primary" data-save-key="' + escapeHtml(p.providerId) + '">Set Key</button>' +
              (p.hasApiKey && p.apiKeySource === 'secret_storage' ? '<button class="btn btn-sm btn-danger" data-clear-key="' + escapeHtml(p.providerId) + '">Clear</button>' : '') +
            '</div>' +
          '</div>'
        ) : '') +
        '<div class="p-meta">' +
          'Discovered Models: <strong>' + p.modelCount + '</strong>' +
          (p.version ? ' | Version: ' + escapeHtml(p.version) : '') +
          (p.latencyMs !== undefined ? ' | Latency: ' + p.latencyMs + 'ms' : '') +
        '</div>' +
        (p.error ? '<div class="p-err">' + escapeHtml(p.error) + '</div>' : '') +
        '<div class="p-actions">' +
          '<button class="btn btn-sm btn-primary" data-test="' + escapeHtml(p.providerId) + '">Test &amp; Discover</button>' +
          (isCustom ? '<button class="btn btn-sm" data-add-model="' + escapeHtml(p.providerId) + '">+ Add Manual Model ID</button>' : '') +
          (p.providerId !== 'ollama' ? '<button class="btn btn-sm btn-danger" data-remove="' + escapeHtml(p.providerId) + '">Remove</button>' : '') +
        '</div>';

      card.querySelector('[data-save-url]')?.addEventListener('click', () => {
        const val = card.querySelector('[data-url]').value;
        vscode.postMessage({ command: 'updateEndpoint', providerId: p.providerId, baseUrl: val });
      });
      card.querySelector('[data-save-key]')?.addEventListener('click', () => {
        const inp = card.querySelector('[data-key]');
        const val = inp.value;
        inp.value = '';
        vscode.postMessage({ command: 'saveApiKey', providerId: p.providerId, apiKey: val });
      });
      card.querySelector('[data-clear-key]')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'clearApiKey', providerId: p.providerId });
      });
      card.querySelector('[data-test]')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'testProvider', providerId: p.providerId });
      });
      card.querySelector('[data-remove]')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'removeProvider', providerId: p.providerId });
      });
      card.querySelector('[data-add-model]')?.addEventListener('click', () => {
        const modelIdentifier = prompt('Enter exact API model identifier for ' + p.providerName + ':');
        if (modelIdentifier) {
          vscode.postMessage({ command: 'addManualModel', providerId: p.providerId, modelIdentifier });
        }
      });

      grid.appendChild(card);
    }
  }

  function renderModelsTable() {
    const tbody = document.getElementById('modelsTableBody');
    const q = (document.getElementById('tblSearch').value || '').trim().toLowerCase();
    const list = (state.models || []).filter((m) =>
      !q ||
      (m.displayName || '').toLowerCase().includes(q) ||
      (m.modelIdentifier || '').toLowerCase().includes(q) ||
      (m.providerName || '').toLowerCase().includes(q)
    );
    document.getElementById('modelsTotalCount').textContent = String(list.length);
    tbody.innerHTML = '';

    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:24px;">No real models discovered. Start Ollama or configure a cloud provider above.</td></tr>';
      return;
    }

    for (const m of list) {
      const tr = document.createElement('tr');
      const isDefault = state.defaultModelId === m.id || state.defaultModelId === m.modelIdentifier;
      const ctxStr = m.contextWindow ? (m.contextWindow >= 1000000 ? (m.contextWindow/1048576).toFixed(1) + 'M' : Math.round(m.contextWindow/1024) + 'k') : 'Unknown';
      const caps = [];
      if (m.capabilities?.toolCalling === true) caps.push('<span class="cap-pill">Tools</span>');
      if (m.capabilities?.vision === true) caps.push('<span class="cap-pill">Vision</span>');
      if (m.capabilities?.streaming === true) caps.push('<span class="cap-pill">Stream</span>');
      if (m.reasoningEffortsSupported?.length) caps.push('<span class="cap-pill">Effort: ' + m.reasoningEffortsSupported.join(',') + '</span>');
      else caps.push('<span class="cap-pill" style="opacity:0.6;">No Reasoning Effort</span>');

      const priceStr = m.pricing ? ('$' + m.pricing.inputPerM + ' / $' + m.pricing.outputPerM + ' per 1M') : (m.providerType === 'LOCAL' ? 'Local' : 'Pricing: Unknown');

      tr.innerHTML =
        '<td><strong>' + escapeHtml(m.displayName) + '</strong>' + (isDefault ? ' <span class="badge b-local">DEFAULT</span>' : '') + '<div style="font-size:10.5px;color:#94a3b8;font-family:monospace;">' + escapeHtml(m.modelIdentifier) + '</div></td>' +
        '<td>' + escapeHtml(m.providerName) + '</td>' +
        '<td><span class="badge ' + (m.availability === 'unavailable' ? 'b-error' : 'b-connected') + '">' + escapeHtml(m.availability) + '</span></td>' +
        '<td>' + ctxStr + '</td>' +
        '<td>' + caps.join('') + '</td>' +
        '<td><div>' + escapeHtml(m.modelSource) + '</div><div style="font-size:10.5px;color:#94a3b8;">' + escapeHtml(priceStr) + '</div></td>' +
        '<td style="white-space:nowrap;">' +
          '<button class="btn btn-sm" data-toggle="' + escapeHtml(m.id) + '">' + (m.enabled ? 'Disable' : 'Enable') + '</button> ' +
          '<button class="btn btn-sm" data-default="' + escapeHtml(m.id) + '">Set Default</button> ' +
          '<button class="btn btn-sm" data-params="' + escapeHtml(m.id) + '">Params</button> ' +
          '<button class="btn btn-sm btn-primary" data-chattest="' + escapeHtml(m.id) + '">Test</button> ' +
          (m.providerId === 'ollama' ? '<button class="btn btn-sm btn-danger" data-del-ollama="' + escapeHtml(m.modelIdentifier) + '">Delete</button>' : '') +
        '</td>';

      tr.querySelector('[data-toggle]')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'toggleModelEnabled', modelId: m.id, enabled: !m.enabled });
      });
      tr.querySelector('[data-default]')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'setDefaultModel', modelId: m.id });
      });
      tr.querySelector('[data-params]')?.addEventListener('click', () => {
        openParamModal(m);
      });
      tr.querySelector('[data-chattest]')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'testModelChat', modelId: m.id });
      });
      tr.querySelector('[data-del-ollama]')?.addEventListener('click', () => {
        if (confirm('Delete local Ollama model ' + m.modelIdentifier + '?')) {
          vscode.postMessage({ command: 'deleteOllamaModel', modelIdentifier: m.modelIdentifier });
        }
      });

      tbody.appendChild(tr);
    }
  }

  function openParamModal(m) {
    editingModel = m;
    document.getElementById('pmModelTitle').textContent = m.id;
    const effSel = document.getElementById('pmEffort');
    effSel.innerHTML = '';
    const efforts = m.reasoningEffortsSupported || [];
    if (efforts.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Not supported by this model';
      effSel.appendChild(opt);
      effSel.disabled = true;
    } else {
      effSel.disabled = false;
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = 'Model default';
      effSel.appendChild(blank);
      for (const e of efforts) {
        const opt = document.createElement('option');
        opt.value = e;
        opt.textContent = e;
        effSel.appendChild(opt);
      }
      effSel.value = m.customParameters?.reasoningEffort || '';
    }
    document.getElementById('pmTemp').value = m.customParameters?.temperature ?? '';
    document.getElementById('pmMaxTok').value = m.customParameters?.maxOutputTokens ?? '';
    document.getElementById('pmCtx').value = m.customParameters?.contextLimit ?? '';
    document.getElementById('pmCtxRow').style.display = m.supportsContextLimitConfig ? 'block' : 'none';
    document.getElementById('pmFastRow').style.display = m.supportsFastMode ? 'block' : 'none';
    document.getElementById('pmFast').checked = Boolean(m.customParameters?.fastMode);
    document.getElementById('paramModal').classList.add('open');
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'state') {
      state = msg;
      renderProviders();
      renderModelsTable();
    } else if (msg.type === 'testResult') {
      const r = msg.result;
      if (r.ok) {
        showToast('Provider "' + r.providerId + '" connected (' + (r.discoveredModelsCount ?? 0) + ' models discovered in ' + r.latencyMs + 'ms).', false);
      } else {
        showToast('Provider "' + r.providerId + '" error: ' + (r.error || 'Connection failed'), true);
      }
    } else if (msg.type === 'modelTestResult') {
      if (msg.result.ok) {
        showToast('Model "' + msg.modelId + '" responded cleanly in ' + msg.result.latencyMs + 'ms.', false);
      } else {
        showToast('Model "' + msg.modelId + '" test failed: ' + msg.result.error, true);
      }
    } else if (msg.type === 'pullProgress') {
      document.getElementById('pullStatusText').textContent = 'Pulling ' + msg.tag + ': ' + (msg.progress?.status || '') + (msg.progress?.percent !== undefined ? ' (' + msg.progress.percent + '%)' : '');
    } else if (msg.type === 'pullDone') {
      document.getElementById('pullStatusText').textContent = 'Model ' + msg.tag + ' installed successfully!';
      showToast('Pulled Ollama model ' + msg.tag, false);
    } else if (msg.type === 'actionError') {
      showToast(msg.error || 'Operation failed', true);
    } else if (msg.type === 'actionSuccess') {
      showToast(msg.message, false);
    }
  });

  vscode.postMessage({ command: 'init' });
</script>
</body>
</html>`;
  }
}
