import { getLucideCss, getLucideClientScript, lucideSvg } from './lucide-icons';

export function getModelSelectorStyles(): string {
  return `
    ${getLucideCss()}
    /* Antigravity-Grade Model Selector & Configuration Popovers */
    .model-selector-modal {
      padding: 0 !important;
      overflow: hidden;
    }
    .modal-search-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 10px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.02);
    }
    .modal-search-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      font-size: 12.5px;
      color: #f1f5f9;
      font-family: inherit;
      min-width: 0;
    }
    .modal-search-input::placeholder {
      color: #64748b;
    }
    .modal-header-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #cbd5e1;
      border-radius: 5px;
      width: 24px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.12s ease;
      flex-shrink: 0;
    }
    .modal-header-btn:hover {
      background: rgba(56, 189, 248, 0.16);
      border-color: rgba(56, 189, 248, 0.4);
      color: #ffffff;
    }
    .modal-header-btn.spinning svg {
      animation: spin360 0.8s linear infinite;
    }
    @keyframes spin360 {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .kbd-badge {
      font-size: 10px;
      padding: 2px 5px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.07);
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
      padding: 2px 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .model-filter-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 7px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      background: rgba(0, 0, 0, 0.15);
      flex-wrap: wrap;
    }
    .model-filter-pills {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
    }
    .filter-pill-btn {
      background: transparent;
      border: 1px solid transparent;
      color: #94a3b8;
      font-size: 10.5px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 999px;
      cursor: pointer;
      transition: all 0.12s ease;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .filter-pill-btn:hover {
      background: rgba(255, 255, 255, 0.06);
      color: #e2e8f0;
    }
    .filter-pill-btn.active {
      background: rgba(56, 189, 248, 0.16);
      border-color: rgba(56, 189, 248, 0.35);
      color: #38bdf8;
    }
    .provider-filter-select {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #cbd5e1;
      font-size: 10.5px;
      border-radius: 4px;
      padding: 2px 6px;
      outline: none;
      max-width: 115px;
    }
    .provider-warnings-container {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px 10px 0 10px;
    }
    .provider-warning-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 7px 9px;
      border-radius: 6px;
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.3);
      font-size: 11px;
      color: #fde68a;
    }
    .provider-warning-banner.error {
      background: rgba(239, 68, 68, 0.1);
      border-color: rgba(239, 68, 68, 0.3);
      color: #fecaca;
    }
    .warning-text {
      flex: 1;
      min-width: 0;
      line-height: 1.35;
    }
    .warning-action-btn {
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: #ffffff;
      border-radius: 4px;
      padding: 3px 7px;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    .warning-action-btn:hover {
      background: rgba(255, 255, 255, 0.2);
    }
    .model-categories-scroll {
      flex: 1;
      overflow-y: auto;
      max-height: 380px;
      padding: 6px 6px 8px 6px;
    }
    .model-category-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: #64748b;
      padding: 8px 8px 4px 8px;
    }
    .model-item-row {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 7px 9px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.1s ease;
      border: 1px solid transparent;
    }
    .model-item-row:hover {
      background: rgba(255, 255, 255, 0.06);
    }
    .model-item-row.selected {
      background: rgba(56, 189, 248, 0.12);
      border-color: rgba(56, 189, 248, 0.25);
    }
    .model-item-row.unavailable {
      opacity: 0.58;
    }
    .model-item-icon {
      width: 26px;
      height: 26px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #cbd5e1;
      flex-shrink: 0;
    }
    .model-item-info {
      flex: 1;
      min-width: 0;
    }
    .model-item-name-row {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-wrap: wrap;
    }
    .model-item-name {
      font-size: 12.5px;
      font-weight: 600;
      color: #f8fafc;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 210px;
    }
    .model-tag {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .model-tag.local { background: rgba(56, 189, 248, 0.16); color: #38bdf8; }
    .model-tag.cloud { background: rgba(168, 85, 247, 0.16); color: #c084fc; }
    .model-tag.cap { background: rgba(255, 255, 255, 0.07); color: #94a3b8; font-weight: 600; }
    .model-item-meta-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10.5px;
      color: #94a3b8;
      margin-top: 2px;
      flex-wrap: wrap;
    }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      display: inline-block;
      flex-shrink: 0;
    }
    .status-dot.running { background: #22c55e; }
    .status-dot.installed { background: #38bdf8; }
    .status-dot.available { background: #22c55e; }
    .status-dot.loading { background: #f59e0b; }
    .status-dot.unavailable { background: #ef4444; }
    .model-fav-btn {
      background: none;
      border: none;
      color: #64748b;
      cursor: pointer;
      padding: 2px 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .model-fav-btn:hover, .model-fav-btn.is-fav {
      color: #fbbf24;
    }
    .model-check {
      color: #38bdf8;
      width: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .modal-footer-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.02);
      font-size: 11px;
    }
    .footer-link-btn {
      background: none;
      border: none;
      color: #38bdf8;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      padding: 2px 4px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .footer-link-btn:hover {
      text-decoration: underline;
    }

    /* Dynamic Model Configuration Popover */
    .config-popover-header {
      padding: 8px 10px 10px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .config-popover-title {
      font-size: 12.5px;
      font-weight: 600;
      color: #f8fafc;
    }
    .config-model-name {
      font-size: 11px;
      color: var(--accent, #38bdf8);
      font-family: var(--vscode-editor-font-family, monospace);
      margin-top: 2px;
      word-break: break-all;
    }
    .config-section {
      padding: 9px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .config-section:last-child {
      border-bottom: none;
    }
    .config-section-label {
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.6px;
      color: #64748b;
      margin-bottom: 7px;
      text-transform: uppercase;
      display: flex;
      align-items: center;
      justify-content: space-between;
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
      font-size: 10.5px;
      font-weight: 500;
      padding: 5px 4px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.1s ease;
    }
    .effort-seg-btn:hover {
      color: #ffffff;
    }
    .effort-seg-btn.active {
      background: var(--accent, #38bdf8);
      color: #0f172a;
      font-weight: 700;
    }
    .effort-unsupported-note {
      font-size: 11px;
      color: #64748b;
      font-style: italic;
      padding: 4px 0;
    }
    .param-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .param-field label {
      display: block;
      font-size: 10px;
      color: #94a3b8;
      margin-bottom: 3px;
    }
    .param-input {
      width: 100%;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #f1f5f9;
      border-radius: 4px;
      padding: 4px 7px;
      font-size: 11.5px;
      outline: none;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .param-input:focus {
      border-color: #38bdf8;
    }
    .fast-mode-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .fast-mode-title {
      font-size: 12px;
      font-weight: 600;
      color: #f8fafc;
    }
    .fast-mode-desc {
      font-size: 10.5px;
      color: #94a3b8;
      margin-top: 2px;
    }
    .toggle-switch {
      position: relative;
      display: inline-block;
      width: 34px;
      height: 18px;
      flex-shrink: 0;
    }
    .toggle-switch input { opacity: 0; width: 0; height: 0; }
    .toggle-slider {
      position: absolute;
      cursor: pointer;
      inset: 0;
      background-color: rgba(255, 255, 255, 0.16);
      transition: .2s;
      border-radius: 20px;
    }
    .toggle-slider:before {
      position: absolute;
      content: "";
      height: 12px;
      width: 12px;
      left: 3px;
      bottom: 3px;
      background-color: white;
      transition: .2s;
      border-radius: 50%;
    }
    input:checked + .toggle-slider { background-color: var(--accent, #38bdf8); }
    input:checked + .toggle-slider:before { transform: translateX(16px); background-color: #0f172a; }
    .resource-card {
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: rgba(255, 255, 255, 0.03);
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    .resource-title { font-size: 11.5px; font-weight: 600; color: #f1f5f9; }
    .resource-desc { font-size: 10.5px; color: #94a3b8; line-height: 1.4; }
    .resource-caps { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 3px; }
  `;
}

export function getModelSelectorMarkup(options: { compact?: boolean } = {}): string {
  const modalWidth = options.compact ? '336px' : '420px';
  const configWidth = options.compact ? '296px' : '340px';
  return `
        <!-- Model Selector Popover (Antigravity Style, Real Discovery Only) -->
        <div class="popover-card model-selector-modal" id="modelSelectorPopover" style="width: ${modalWidth}; max-height: 540px;">
          <div class="modal-search-header">
            <span style="color:#94a3b8;display:inline-flex;align-items:center;">${lucideSvg('search', 14)}</span>
            <input type="text" id="modelSearchInput" class="modal-search-input" placeholder="Search discovered models..." autocomplete="off" />
            <button class="clear-search-btn" id="btnClearModelSearch" style="display:none;" title="Clear">${lucideSvg('x', 12)}</button>
            <span class="kbd-badge">Ctrl+K</span>
            <button class="modal-header-btn" id="btnRefreshModels" title="Refresh Real Provider Discovery">${lucideSvg('refresh-cw', 12)}</button>
            <button class="modal-header-btn" id="btnOpenModelManager" title="Manage Providers &amp; API Keys">${lucideSvg('settings', 12)}</button>
          </div>
          <div class="model-filter-bar">
            <div class="model-filter-pills" id="modelFilterPills">
              <button class="filter-pill-btn active" data-filter="ALL">All</button>
              <button class="filter-pill-btn" data-filter="LOCAL">Local</button>
              <button class="filter-pill-btn" data-filter="CLOUD">Cloud</button>
              <button class="filter-pill-btn" data-filter="FAVORITES">${lucideSvg('star', 11)} Fav</button>
              <button class="filter-pill-btn" data-filter="RECENT">Recent</button>
            </div>
            <select id="providerFilterSelect" class="provider-filter-select" title="Filter by Provider">
              <option value="all">All Providers</option>
            </select>
          </div>
          <div class="provider-warnings-container" id="providerWarningsContainer" style="display:none;"></div>
          <div class="model-categories-scroll" id="modelCategoriesContainer">
            <!-- Real discovered models rendered dynamically -->
          </div>
          <div class="modal-footer-bar">
            <span id="modelCountSummary" style="color:#64748b;">0 models available</span>
            <button class="footer-link-btn" id="btnFooterManageProviders">${lucideSvg('settings', 12)} Configure Providers</button>
          </div>
        </div>

        <!-- Model Configuration Popover (Dynamic Per-Model Capabilities) -->
        <div class="popover-card" id="modelConfigPopover" style="width: ${configWidth};">
          <div class="config-popover-header">
            <div class="config-popover-title">Model Configuration</div>
            <div class="config-model-name" id="cfgActiveModelName">No model selected</div>
          </div>

          <div class="config-section" id="cfgEffortSection">
            <div class="config-section-label">
              <span>REASONING EFFORT</span>
              <span id="cfgEffortSupportBadge" style="font-weight:500;color:#64748b;"></span>
            </div>
            <div class="effort-segmented-bar" id="effortSegmentedBar"></div>
            <div class="effort-unsupported-note" id="effortUnsupportedNote" style="display:none;">
              Reasoning effort is not configurable for this model.
            </div>
          </div>

          <div class="config-section" id="cfgParamsSection">
            <div class="config-section-label">PARAMETERS</div>
            <div class="param-grid">
              <div class="param-field" id="cfgTempField">
                <label for="inpModelTemp">Temperature</label>
                <input type="number" id="inpModelTemp" class="param-input" min="0" max="2" step="0.1" placeholder="Default" />
              </div>
              <div class="param-field" id="cfgMaxTokensField">
                <label for="inpMaxTokens">Max Tokens</label>
                <input type="number" id="inpMaxTokens" class="param-input" min="64" step="256" placeholder="Default" />
              </div>
              <div class="param-field" id="cfgContextLimitField" style="grid-column: span 2;">
                <label for="inpContextLimit">Context Limit (tokens)</label>
                <input type="number" id="inpContextLimit" class="param-input" min="1024" step="4096" placeholder="Auto" />
              </div>
            </div>
          </div>

          <div class="config-section" id="cfgFastModeSection" style="display:none;">
            <div class="fast-mode-row">
              <div class="fast-mode-text">
                <div class="fast-mode-title">Fast Mode</div>
                <div class="fast-mode-desc">Skip deep thinking tokens when supported</div>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="chkFastMode" />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div class="config-section">
            <div class="config-section-label">VERIFIED METADATA &amp; SOURCE</div>
            <div class="resource-card" id="cfgResourceCard">
              <div class="resource-title" id="cfgResourceTitle">No Model Selected</div>
              <div class="resource-desc" id="cfgResourceDesc">Select an installed Ollama model or configure a cloud provider.</div>
              <div class="resource-caps" id="cfgResourceCaps"></div>
            </div>
          </div>
        </div>
  `;
}

export function getModelSelectorScript(options: { modelLabelElementId: string }): string {
  const labelId = options.modelLabelElementId;
  return `
    ${getLucideClientScript()}
    let activeModelFilterCategory = 'ALL';
    let activeModelFilterProvider = 'all';
    let cachedAllModelsList = [];
    let cachedProviderStatuses = [];

    const btnRefreshModels = document.getElementById('btnRefreshModels');
    const btnOpenModelManager = document.getElementById('btnOpenModelManager');
    const btnFooterManageProviders = document.getElementById('btnFooterManageProviders');
    const providerFilterSelect = document.getElementById('providerFilterSelect');
    const providerWarningsContainer = document.getElementById('providerWarningsContainer');
    const modelCountSummary = document.getElementById('modelCountSummary');
    const cfgEffortSection = document.getElementById('cfgEffortSection');
    const cfgEffortSupportBadge = document.getElementById('cfgEffortSupportBadge');
    const effortSegmentedBar = document.getElementById('effortSegmentedBar');
    const effortUnsupportedNote = document.getElementById('effortUnsupportedNote');
    const cfgFastModeSection = document.getElementById('cfgFastModeSection');
    const cfgTempField = document.getElementById('cfgTempField');
    const cfgMaxTokensField = document.getElementById('cfgMaxTokensField');
    const cfgContextLimitField = document.getElementById('cfgContextLimitField');
    const inpModelTemp = document.getElementById('inpModelTemp');
    const inpMaxTokens = document.getElementById('inpMaxTokens');
    const inpContextLimit = document.getElementById('inpContextLimit');
    const cfgResourceCaps = document.getElementById('cfgResourceCaps');
    const btnEffortConfigPill = document.getElementById('btnEffortConfig');
    const activeModelLabelEl = document.getElementById('${labelId}');

    function getProviderSvgIcon(providerType) {
      if (providerType === 'ollama') {
        return '<span style="color:#38bdf8;display:inline-flex;align-items:center;">' + lcIcon('cpu', 14) + '</span>';
      }
      if (providerType === 'openai') {
        return '<span style="color:#10b981;display:inline-flex;align-items:center;">' + lcIcon('globe', 14) + '</span>';
      }
      if (providerType === 'anthropic') {
        return '<span style="color:#f59e0b;display:inline-flex;align-items:center;">' + lcIcon('brain', 14) + '</span>';
      }
      if (providerType === 'gemini') {
        return '<span style="color:#a855f7;display:inline-flex;align-items:center;">' + lcIcon('sparkles', 14) + '</span>';
      }
      if (providerType === 'openrouter') {
        return '<span style="color:#ec4899;display:inline-flex;align-items:center;">' + lcIcon('terminal', 14) + '</span>';
      }
      return '<span style="color:#94a3b8;display:inline-flex;align-items:center;">' + lcIcon('server', 14) + '</span>';
    }

    function formatContextWindow(tokens) {
      if (!tokens || typeof tokens !== 'number') return 'Context: Unknown';
      if (tokens >= 1000000) return (tokens / 1048576).toFixed(tokens % 1048576 === 0 ? 0 : 1) + 'M ctx';
      return Math.round(tokens / 1024) + 'k ctx';
    }

    function formatAvailabilityLabel(avail) {
      switch (avail) {
        case 'running': return 'Running';
        case 'installed': return 'Installed';
        case 'loading': return 'Loading';
        case 'available': return 'Available';
        case 'unavailable': return 'Unavailable';
        default: return 'Unknown';
      }
    }

    function formatEffortLabel(effort) {
      const map = {
        minimal: 'Minimal',
        low: 'Low',
        medium: 'Medium',
        high: 'High',
        extra_high: 'Extra High',
      };
      return map[effort] || effort;
    }

    // Filter Pill Events
    document.querySelectorAll('#modelFilterPills .filter-pill-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('#modelFilterPills .filter-pill-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        activeModelFilterCategory = btn.getAttribute('data-filter') || 'ALL';
        renderModelCategories(cachedGroupedModels, modelSearchInput.value.trim());
      });
    });

    if (providerFilterSelect) {
      providerFilterSelect.addEventListener('change', () => {
        activeModelFilterProvider = providerFilterSelect.value || 'all';
        renderModelCategories(cachedGroupedModels, modelSearchInput.value.trim());
      });
    }

    if (btnRefreshModels) {
      btnRefreshModels.addEventListener('click', (e) => {
        e.stopPropagation();
        btnRefreshModels.classList.add('spinning');
        vscode.postMessage({ command: 'refreshModels' });
        setTimeout(() => btnRefreshModels.classList.remove('spinning'), 1500);
      });
    }

    if (btnOpenModelManager) {
      btnOpenModelManager.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllPopovers();
        vscode.postMessage({ command: 'openModelManager' });
      });
    }

    if (btnFooterManageProviders) {
      btnFooterManageProviders.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllPopovers();
        vscode.postMessage({ command: 'openModelManager' });
      });
    }

    modelSearchInput.addEventListener('input', () => {
      const val = modelSearchInput.value.trim();
      btnClearModelSearch.style.display = val ? 'inline-block' : 'none';
      renderModelCategories(cachedGroupedModels, val);
    });

    btnClearModelSearch.addEventListener('click', () => {
      modelSearchInput.value = '';
      btnClearModelSearch.style.display = 'none';
      renderModelCategories(cachedGroupedModels, '');
      modelSearchInput.focus();
    });

    function renderProviderWarnings(providers) {
      if (!providerWarningsContainer) return;
      const list = Array.isArray(providers) ? providers : [];
      providerWarningsContainer.innerHTML = '';
      let warningCount = 0;

      for (const p of list) {
        if (!p.enabled && p.providerType !== 'ollama') continue;
        if (p.providerType === 'ollama' && (p.status === 'disconnected' || p.status === 'error')) {
          warningCount++;
          const div = document.createElement('div');
          div.className = 'provider-warning-banner';
          div.innerHTML =
            '<div class="warning-text"><strong>Ollama Disconnected</strong> (' + escapeHtml(p.baseUrl) + ')' +
            (p.error ? ' — ' + escapeHtml(p.error) : '') + '</div>' +
            '<div style="display:flex;gap:4px;">' +
              '<button class="warning-action-btn" data-act="config-ollama">Configure</button>' +
              '<button class="warning-action-btn" data-act="retry-ollama">Retry</button>' +
            '</div>';
          div.querySelector('[data-act="config-ollama"]').addEventListener('click', (e) => {
            e.stopPropagation();
            closeAllPopovers();
            vscode.postMessage({ command: 'openModelManager' });
          });
          div.querySelector('[data-act="retry-ollama"]').addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'refreshModels' });
          });
          providerWarningsContainer.appendChild(div);
        } else if (p.providerType !== 'ollama' && p.hasApiKey && p.status === 'error') {
          warningCount++;
          const div = document.createElement('div');
          div.className = 'provider-warning-banner error';
          div.innerHTML =
            '<div class="warning-text"><strong>' + escapeHtml(p.providerName) + ' Error:</strong> ' +
            escapeHtml(p.error || 'Connection error') + '</div>' +
            '<button class="warning-action-btn" data-act="fix-provider">Fix</button>';
          div.querySelector('[data-act="fix-provider"]').addEventListener('click', (e) => {
            e.stopPropagation();
            closeAllPopovers();
            vscode.postMessage({ command: 'openModelManager' });
          });
          providerWarningsContainer.appendChild(div);
        }
      }

      providerWarningsContainer.style.display = warningCount > 0 ? 'flex' : 'none';

      // Update Provider filter select options cleanly without losing selection
      if (providerFilterSelect) {
        const prevVal = activeModelFilterProvider;
        const activeProviders = list.filter((p) => p.modelCount > 0 || p.status === 'connected');
        providerFilterSelect.innerHTML = '<option value="all">All Providers</option>';
        for (const p of activeProviders) {
          const opt = document.createElement('option');
          opt.value = p.providerId;
          opt.textContent = p.providerName + ' (' + p.modelCount + ')';
          providerFilterSelect.appendChild(opt);
        }
        providerFilterSelect.value = activeProviders.some((p) => p.providerId === prevVal) ? prevVal : 'all';
        activeModelFilterProvider = providerFilterSelect.value;
      }
    }

    function renderModelCategories(grouped, filterText = '') {
      modelCategoriesContainer.innerHTML = '';
      const data = grouped || { local: [], cloud: [], providers: [] };
      cachedProviderStatuses = data.providers || cachedProviderStatuses || [];
      renderProviderWarnings(cachedProviderStatuses);

      const filterLower = (filterText || '').toLowerCase();
      const localAll = Array.isArray(data.local) ? data.local : [];
      const cloudAll = Array.isArray(data.cloud) ? data.cloud : [];
      const seenKeys = new Set();

      const matchesFilter = (m) => {
        if (activeModelFilterCategory === 'LOCAL' && m.providerType !== 'LOCAL') return false;
        if (activeModelFilterCategory === 'CLOUD' && m.providerType !== 'CLOUD') return false;
        if (activeModelFilterCategory === 'FAVORITES' && !m.isFavorite) return false;
        if (activeModelFilterCategory === 'RECENT' && !m.isRecentlyUsed) return false;
        if (activeModelFilterProvider !== 'all' && m.providerId !== activeModelFilterProvider) return false;
        if (!filterLower) return true;
        return (
          (m.displayName || '').toLowerCase().includes(filterLower) ||
          (m.modelIdentifier || '').toLowerCase().includes(filterLower) ||
          (m.providerName || '').toLowerCase().includes(filterLower) ||
          (m.family || '').toLowerCase().includes(filterLower)
        );
      };

      const renderSection = (title, rawList) => {
        const filtered = [];
        for (const m of rawList) {
          const dedupeKey = m.providerId + '::' + m.modelIdentifier;
          if (seenKeys.has(dedupeKey)) continue;
          if (!matchesFilter(m)) continue;
          seenKeys.add(dedupeKey);
          filtered.push(m);
        }
        if (filtered.length === 0) return 0;

        const header = document.createElement('div');
        header.className = 'model-category-header';
        header.innerHTML = '<span>' + escapeHtml(title) + '</span><span>' + filtered.length + '</span>';
        modelCategoriesContainer.appendChild(header);

        for (const m of filtered) {
          const row = document.createElement('div');
          const isSelected = m.id === cachedConfig.modelId || (m.providerId === 'ollama' && m.modelIdentifier === cachedConfig.modelId);
          row.className = 'model-item-row' + (isSelected ? ' selected' : '') + (m.availability === 'unavailable' ? ' unavailable' : '');

          const caps = [];
          if (m.capabilities?.toolCalling) caps.push('Tools');
          if (m.capabilities?.vision) caps.push('Vision');
          if (m.reasoningEffortsSupported && m.reasoningEffortsSupported.length > 0) caps.push('Thinking');
          const pricingText = m.pricing ? ('$' + m.pricing.inputPerM + '/$' + m.pricing.outputPerM + ' /1M') : '';

          row.innerHTML =
            '<div class="model-item-icon">' + getProviderSvgIcon(m.providerType === 'LOCAL' ? (m.providerId === 'ollama' ? 'ollama' : 'custom') : m.providerId.split('-')[0]) + '</div>' +
            '<div class="model-item-info">' +
              '<div class="model-item-name-row">' +
                '<span class="model-item-name" title="' + escapeHtml(m.modelIdentifier) + '">' + escapeHtml(m.displayName) + '</span>' +
                '<span class="model-tag ' + (m.providerType === 'LOCAL' ? 'local' : 'cloud') + '">' + (m.providerType === 'LOCAL' ? 'Local' : 'Cloud') + '</span>' +
                caps.map((c) => '<span class="model-tag cap">' + c + '</span>').join('') +
              '</div>' +
              '<div class="model-item-meta-row">' +
                '<span class="status-dot ' + (m.availability || 'available') + '"></span>' +
                '<span>' + escapeHtml(m.providerName) + '</span>' +
                '<span>|</span>' +
                '<span>' + formatContextWindow(m.contextWindow) + '</span>' +
                '<span>|</span>' +
                '<span>' + formatAvailabilityLabel(m.availability) + '</span>' +
                (pricingText ? '<span>| ' + escapeHtml(pricingText) + '</span>' : '') +
              '</div>' +
            '</div>' +
            '<button class="model-fav-btn' + (m.isFavorite ? ' is-fav' : '') + '" title="' + (m.isFavorite ? 'Remove Favorite' : 'Favorite') + '">' +
              (m.isFavorite ? lcIcon('star', 13, '', 'currentColor') : lcIcon('star', 13)) +
            '</button>' +
            (isSelected ? '<div class="model-check">' + lcIcon('check', 13) + '</div>' : '<div class="model-check"></div>');

          row.addEventListener('click', (e) => {
            if (e.target.closest('.model-fav-btn')) return;
            selectModelItem(m);
            closeAllPopovers();
          });

          row.querySelector('.model-fav-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'toggleFavorite', modelId: m.id });
          });

          modelCategoriesContainer.appendChild(row);
        }
        return filtered.length;
      };

      const countLocal = renderSection('LOCAL MODELS (OLLAMA / LOCAL)', localAll);
      const countCloud = renderSection('CLOUD MODELS', cloudAll);
      const total = countLocal + countCloud;

      if (modelCountSummary) {
        modelCountSummary.textContent = total + ' model' + (total === 1 ? '' : 's') + ' shown';
      }

      if (total === 0) {
        const emptyMsg = filterLower
          ? 'No discovered models matching "' + escapeHtml(filterText) + '"'
          : 'No models available. Connect Ollama and pull a model, or configure a cloud provider API key in Model Manager.';
        modelCategoriesContainer.innerHTML =
          '<div style="padding: 24px 16px; text-align: center; color: #94a3b8; font-size: 12px; line-height: 1.5;">' +
            emptyMsg +
            '<div style="margin-top: 10px;"><button class="warning-action-btn" id="btnEmptyOpenManager" style="background:rgba(56,189,248,0.18);border-color:rgba(56,189,248,0.4);color:#38bdf8;padding:5px 12px;">Open Model Manager</button></div>' +
          '</div>';
        const emptyBtn = document.getElementById('btnEmptyOpenManager');
        if (emptyBtn) {
          emptyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeAllPopovers();
            vscode.postMessage({ command: 'openModelManager' });
          });
        }
      }
    }

    function updateModelConfigurationUI(activeModel) {
      if (cfgActiveModelName) {
        cfgActiveModelName.textContent = activeModel ? (activeModel.displayName + ' (' + activeModel.providerName + ')') : (cachedConfig.modelName || cachedConfig.modelId || 'No model selected');
      }

      // Dynamic Reasoning Effort Buttons based STRICTLY on activeModel.reasoningEffortsSupported
      const supportedEfforts = activeModel?.reasoningEffortsSupported || [];
      if (effortSegmentedBar) {
        effortSegmentedBar.innerHTML = '';
        if (supportedEfforts.length > 0) {
          effortSegmentedBar.style.display = 'flex';
          if (effortUnsupportedNote) effortUnsupportedNote.style.display = 'none';
          if (cfgEffortSupportBadge) cfgEffortSupportBadge.textContent = supportedEfforts.length + ' levels';

          let selectedEffort = cachedConfig.reasoningEffort;
          if (!supportedEfforts.includes(selectedEffort)) {
            selectedEffort = activeModel.defaultReasoningEffort || supportedEfforts[0];
            cachedConfig.reasoningEffort = selectedEffort;
          }

          for (const eff of supportedEfforts) {
            const btn = document.createElement('button');
            btn.className = 'effort-seg-btn' + (eff === selectedEffort ? ' active' : '');
            btn.setAttribute('data-effort', eff);
            btn.textContent = formatEffortLabel(eff);
            btn.addEventListener('click', () => {
              effortSegmentedBar.querySelectorAll('.effort-seg-btn').forEach((b) => b.classList.remove('active'));
              btn.classList.add('active');
              cachedConfig.reasoningEffort = eff;
              if (activeEffortLabel) activeEffortLabel.textContent = formatEffortLabel(eff);
              vscode.postMessage({ command: 'setReasoningEffort', effort: eff });
            });
            effortSegmentedBar.appendChild(btn);
          }

          if (btnEffortConfigPill) {
            btnEffortConfigPill.style.display = 'inline-flex';
            if (activeEffortLabel) activeEffortLabel.textContent = formatEffortLabel(selectedEffort);
          }
        } else {
          effortSegmentedBar.style.display = 'none';
          if (effortUnsupportedNote) effortUnsupportedNote.style.display = 'block';
          if (cfgEffortSupportBadge) cfgEffortSupportBadge.textContent = activeModel ? 'Unsupported' : '';
          if (btnEffortConfigPill) {
            btnEffortConfigPill.style.display = activeModel ? 'inline-flex' : 'none';
            if (activeEffortLabel) activeEffortLabel.textContent = 'Params';
          }
        }
      }

      // Dynamic Parameters Visibility
      if (cfgTempField) cfgTempField.style.display = activeModel?.supportsTemperature === false ? 'none' : 'block';
      if (cfgMaxTokensField) cfgMaxTokensField.style.display = activeModel?.supportsMaxOutputTokens === false ? 'none' : 'block';
      if (cfgContextLimitField) cfgContextLimitField.style.display = activeModel?.supportsContextLimitConfig ? 'block' : 'none';
      if (cfgFastModeSection) cfgFastModeSection.style.display = activeModel?.supportsFastMode ? 'block' : 'none';

      if (inpModelTemp) inpModelTemp.value = cachedConfig.temperature !== undefined ? String(cachedConfig.temperature) : '';
      if (inpMaxTokens) inpMaxTokens.value = cachedConfig.maxOutputTokens !== undefined ? String(cachedConfig.maxOutputTokens) : '';
      if (inpContextLimit) inpContextLimit.value = cachedConfig.contextLimit !== undefined ? String(cachedConfig.contextLimit) : '';

      // Verified Resource & Capabilities Card
      if (activeModel) {
        if (cfgResourceTitle) cfgResourceTitle.textContent = activeModel.providerName + ' | ' + activeModel.modelIdentifier;
        const details = [];
        details.push('Status: ' + formatAvailabilityLabel(activeModel.availability));
        details.push(formatContextWindow(activeModel.contextWindow));
        if (activeModel.parameterSize) details.push(activeModel.parameterSize);
        if (activeModel.pricing) {
          details.push('Pricing: $' + activeModel.pricing.inputPerM + ' in / $' + activeModel.pricing.outputPerM + ' out per 1M');
        } else if (activeModel.providerType === 'LOCAL') {
          details.push('Local Execution');
        } else {
          details.push('Pricing: Unknown');
        }
        details.push('Source: ' + activeModel.modelSource);
        if (cfgResourceDesc) cfgResourceDesc.textContent = details.join(' | ');

        if (cfgResourceCaps) {
          const capBadges = [];
          if (activeModel.capabilities?.toolCalling === true) capBadges.push('Tool Calling');
          if (activeModel.capabilities?.toolCalling === false) capBadges.push('No Tools');
          if (activeModel.capabilities?.vision === true) capBadges.push('Vision');
          if (activeModel.capabilities?.streaming === true) capBadges.push('Streaming');
          if (activeModel.capabilities?.structuredOutput === true) capBadges.push('Structured JSON');
          if (activeModel.capabilities?.reasoning === true) capBadges.push('Reasoning');
          cfgResourceCaps.innerHTML = capBadges.map((b) => '<span class="model-tag cap">' + b + '</span>').join('');
        }
      } else {
        if (cfgResourceTitle) cfgResourceTitle.textContent = 'No Active Model';
        if (cfgResourceDesc) cfgResourceDesc.textContent = 'Select a discovered local or cloud model to configure parameters.';
        if (cfgResourceCaps) cfgResourceCaps.innerHTML = '';
      }
    }

    function selectModelItem(m) {
      cachedConfig.modelId = m.id;
      cachedConfig.modelName = m.displayName;
      cachedConfig.providerId = m.providerId;
      if (activeModelLabelEl) activeModelLabelEl.textContent = m.displayName;
      if (modelProviderIcon) {
        modelProviderIcon.innerHTML = getProviderSvgIcon(m.providerType === 'LOCAL' ? (m.providerId === 'ollama' ? 'ollama' : 'custom') : m.providerId.split('-')[0]);
      }
      updateModelConfigurationUI(m);
      vscode.postMessage({
        command: 'selectModel',
        modelId: m.id,
        modelName: m.displayName,
        provider: m.providerId,
      });
    }

    function sendRuntimeParamUpdates() {
      const tempVal = inpModelTemp && inpModelTemp.value !== '' ? parseFloat(inpModelTemp.value) : null;
      const maxTokVal = inpMaxTokens && inpMaxTokens.value !== '' ? parseInt(inpMaxTokens.value, 10) : null;
      const ctxVal = inpContextLimit && inpContextLimit.value !== '' ? parseInt(inpContextLimit.value, 10) : null;
      cachedConfig.temperature = tempVal !== null && !Number.isNaN(tempVal) ? tempVal : undefined;
      cachedConfig.maxOutputTokens = maxTokVal !== null && !Number.isNaN(maxTokVal) ? maxTokVal : undefined;
      cachedConfig.contextLimit = ctxVal !== null && !Number.isNaN(ctxVal) ? ctxVal : undefined;
      vscode.postMessage({
        command: 'setModelRuntimeParams',
        temperature: cachedConfig.temperature,
        maxOutputTokens: cachedConfig.maxOutputTokens,
        contextLimit: cachedConfig.contextLimit,
      });
    }

    if (inpModelTemp) inpModelTemp.addEventListener('change', sendRuntimeParamUpdates);
    if (inpMaxTokens) inpMaxTokens.addEventListener('change', sendRuntimeParamUpdates);
    if (inpContextLimit) inpContextLimit.addEventListener('change', sendRuntimeParamUpdates);
  `;
}
