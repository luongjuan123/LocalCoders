/**
 * Self-contained in-cockpit modals for Agent Mode (Models, Agents, MCP Servers,
 * Project Rules, Settings). Keeps all configuration actions inside the single pinned
 * Agent View tab so VS Code sidebars and secondary editor tabs never open.
 */

export type CockpitModalType = 'models' | 'agents' | 'mcp' | 'rules' | 'settings';

export function getCockpitModalStyles(): string {
  return `
    .cockpit-modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(6, 8, 12, 0.72);
      z-index: 1200;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .cockpit-modal-backdrop.open {
      display: flex;
    }
    .cockpit-modal-dialog {
      width: min(680px, 92vw);
      max-height: 82vh;
      background: #0d1016;
      border: 1px solid #262b36;
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      color: #e2e8f0;
      font-family: inherit;
    }
    .cockpit-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid #1e232d;
      background: #10141c;
    }
    .cockpit-modal-title {
      font-size: 13px;
      font-weight: 600;
      color: #f8fafc;
      letter-spacing: 0.01em;
    }
    .cockpit-modal-close {
      background: transparent;
      border: 1px solid transparent;
      color: #94a3b8;
      border-radius: 4px;
      padding: 3px 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .cockpit-modal-close:hover {
      background: #1e2430;
      color: #f8fafc;
    }
    .cockpit-modal-body {
      padding: 16px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
      font-size: 12px;
      line-height: 1.5;
    }
    .cockpit-section {
      border: 1px solid #1f2430;
      border-radius: 6px;
      padding: 12px;
      background: #11151d;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .cockpit-section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #94a3b8;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .cockpit-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 6px 8px;
      border-radius: 5px;
      background: #0b0e14;
      border: 1px solid #1a1f29;
    }
    .cockpit-row-main {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      flex: 1;
    }
    .cockpit-row-title {
      font-size: 12px;
      font-weight: 500;
      color: #e2e8f0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cockpit-row-sub {
      font-size: 11px;
      color: #64748b;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cockpit-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid #2a3140;
      color: #94a3b8;
      background: #151923;
      white-space: nowrap;
    }
    .cockpit-badge.ok {
      color: #34d399;
      border-color: rgba(52, 211, 153, 0.35);
      background: rgba(16, 185, 129, 0.1);
    }
    .cockpit-badge.warn {
      color: #fbbf24;
      border-color: rgba(251, 191, 36, 0.35);
      background: rgba(245, 158, 11, 0.1);
    }
    .cockpit-input-row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .cockpit-input,
    .cockpit-select,
    .cockpit-textarea {
      background: #090b10;
      border: 1px solid #262c38;
      border-radius: 5px;
      color: #e2e8f0;
      font-size: 12px;
      padding: 6px 8px;
      font-family: inherit;
      outline: none;
    }
    .cockpit-input {
      flex: 1;
      min-width: 150px;
    }
    .cockpit-input:focus,
    .cockpit-select:focus,
    .cockpit-textarea:focus {
      border-color: #38bdf8;
    }
    .cockpit-textarea {
      width: 100%;
      min-height: 220px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      resize: vertical;
      line-height: 1.5;
      box-sizing: border-box;
    }
    .cockpit-textarea.compact {
      min-height: 62px;
      font-family: inherit;
      font-size: 11.5px;
      line-height: 1.45;
    }
    .cockpit-subagent-card {
      border: 1px solid #1a1f29;
      border-radius: 6px;
      background: #0b0e14;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .cockpit-subagent-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .cockpit-subagent-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .cockpit-field-label {
      font-size: 10.5px;
      font-weight: 600;
      color: #94a3b8;
      letter-spacing: 0.02em;
    }
    .cockpit-btn {
      background: #1a202c;
      border: 1px solid #2d3546;
      color: #e2e8f0;
      border-radius: 5px;
      padding: 5px 10px;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
    }
    .cockpit-btn:hover {
      background: #232b3b;
      border-color: #3b465c;
    }
    .cockpit-btn.primary {
      background: #0284c7;
      border-color: #0369a1;
      color: #f8fafc;
    }
    .cockpit-btn.primary:hover {
      background: #0369a1;
    }
    .cockpit-btn.danger {
      color: #f87171;
      border-color: rgba(248, 113, 113, 0.35);
    }
    .cockpit-status-note {
      font-size: 11px;
      color: #94a3b8;
    }
  `;
}

export function getCockpitModalMarkup(closeIconHtml: string): string {
  return `
    <div class="cockpit-modal-backdrop" id="cockpitModalBackdrop" role="dialog" aria-modal="true">
      <div class="cockpit-modal-dialog" id="cockpitModalDialog">
        <div class="cockpit-modal-header">
          <span class="cockpit-modal-title" id="cockpitModalTitle">Workspace</span>
          <button class="cockpit-modal-close" id="cockpitModalClose" type="button" title="Close">${closeIconHtml}</button>
        </div>
        <div class="cockpit-modal-body" id="cockpitModalBody"></div>
      </div>
    </div>
  `;
}

export function getCockpitModalScript(): string {
  return `
    const cockpitModalBackdrop = document.getElementById('cockpitModalBackdrop');
    const cockpitModalTitle = document.getElementById('cockpitModalTitle');
    const cockpitModalBody = document.getElementById('cockpitModalBody');
    const cockpitModalClose = document.getElementById('cockpitModalClose');

    function closeCockpitModal() {
      if (cockpitModalBackdrop) cockpitModalBackdrop.classList.remove('open');
    }

    if (cockpitModalClose) {
      cockpitModalClose.addEventListener('click', closeCockpitModal);
    }
    if (cockpitModalBackdrop) {
      cockpitModalBackdrop.addEventListener('click', (e) => {
        if (e.target === cockpitModalBackdrop) closeCockpitModal();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && cockpitModalBackdrop && cockpitModalBackdrop.classList.contains('open')) {
        closeCockpitModal();
      }
    });

    function requestCockpitModal(modalType) {
      vscode.postMessage({ command: 'loadCockpitModal', modalType });
    }

    function renderCockpitModal(modalType, data) {
      if (!cockpitModalBackdrop || !cockpitModalTitle || !cockpitModalBody) return;
      const prevScrollTop = cockpitModalBody.scrollTop;
      cockpitModalBackdrop.classList.add('open');

      if (modalType === 'models') {
        cockpitModalTitle.textContent = 'Models & Providers';
        renderModelsModal(data || {});
      } else if (modalType === 'agents') {
        cockpitModalTitle.textContent = 'Agents';
        renderAgentsModal(data || {});
      } else if (modalType === 'mcp') {
        cockpitModalTitle.textContent = 'MCP Servers';
        renderMcpModal(data || {});
      } else if (modalType === 'rules') {
        cockpitModalTitle.textContent = 'Project Rules';
        renderRulesModal(data || {});
      } else if (modalType === 'settings') {
        cockpitModalTitle.textContent = 'Settings';
        renderSettingsModal(data || {});
      }

      if (typeof prevScrollTop === 'number' && prevScrollTop > 0) {
        cockpitModalBody.scrollTop = prevScrollTop;
      }
    }

    function renderModelsModal(data) {
      const providers = Array.isArray(data.providers) ? data.providers : [];
      const models = Array.isArray(data.models) ? data.models : [];
      const ollama = providers.find((p) => p.providerId === 'ollama');
      const cloudProviders = providers.filter((p) => p.providerId !== 'ollama');

      let html = '';
      html += '<div class="cockpit-section">';
      html += '<div class="cockpit-section-title"><span>Ollama Local Runtime</span><button class="cockpit-btn" id="cmRefreshModels" type="button">Refresh Discovery</button></div>';
      html += '<div class="cockpit-input-row">';
      html += '<input class="cockpit-input" id="cmOllamaEndpoint" type="text" value="' + escapeHtml(ollama ? ollama.baseUrl : 'http://localhost:11434') + '" placeholder="http://localhost:11434" />';
      html += '<button class="cockpit-btn" id="cmSaveEndpoint" type="button">Save & Test</button>';
      html += '<span class="cockpit-badge ' + (ollama && ollama.status === 'connected' ? 'ok' : 'warn') + '">' + escapeHtml(ollama ? ollama.status : 'unknown') + '</span>';
      html += '</div>';
      html += '<div class="cockpit-input-row">';
      html += '<input class="cockpit-input" id="cmPullModelTag" type="text" placeholder="Pull model tag (e.g. qwen2.5-coder:14b)" />';
      html += '<button class="cockpit-btn primary" id="cmPullModelBtn" type="button">Pull Model</button>';
      html += '</div>';
      html += '<div class="cockpit-status-note" id="cmModelsStatus">' + escapeHtml(data.statusText || (models.length + ' model(s) discovered')) + '</div>';
      html += '</div>';

      html += '<div class="cockpit-section">';
      html += '<div class="cockpit-section-title"><span>Cloud Providers</span></div>';
      cloudProviders.forEach((p) => {
        html += '<div class="cockpit-row">';
        html += '<div class="cockpit-row-main"><div class="cockpit-row-title">' + escapeHtml(p.providerName) + '</div><div class="cockpit-row-sub">' + (p.hasApiKey ? ('Configured (' + escapeHtml(p.maskedApiKey || 'saved') + ')') : 'Not configured') + '</div></div>';
        html += '<input class="cockpit-input" style="max-width:190px;" type="password" data-key-provider="' + escapeHtml(p.providerId) + '" placeholder="API Key..." />';
        html += '<button class="cockpit-btn" type="button" data-save-provider="' + escapeHtml(p.providerId) + '">Save</button>';
        html += '</div>';
      });
      html += '</div>';

      html += '<div class="cockpit-section">';
      html += '<div class="cockpit-section-title"><span>Available Models</span></div>';
      if (models.length === 0) {
        html += '<div class="cockpit-status-note">No models available yet. Pull a local Ollama model or configure a cloud provider above.</div>';
      } else {
        models.forEach((m) => {
          const isCurrent = data.activeModelId === m.id || data.activeModelId === m.modelIdentifier;
          html += '<div class="cockpit-row">';
          html += '<div class="cockpit-row-main"><div class="cockpit-row-title">' + escapeHtml(m.displayName) + '</div><div class="cockpit-row-sub">' + escapeHtml(m.providerName) + (m.contextWindow ? (' • ' + Math.round(m.contextWindow / 1024) + 'k ctx') : '') + '</div></div>';
          html += '<button class="cockpit-btn ' + (isCurrent ? 'primary' : '') + '" type="button" data-pick-model="' + escapeHtml(m.id) + '" data-pick-name="' + escapeHtml(m.displayName) + '" data-pick-provider="' + escapeHtml(m.providerId) + '">' + (isCurrent ? 'Active' : 'Use Model') + '</button>';
          html += '</div>';
        });
      }
      html += '</div>';

      cockpitModalBody.innerHTML = html;

      document.getElementById('cmRefreshModels')?.addEventListener('click', () => {
        const st = document.getElementById('cmModelsStatus');
        if (st) st.textContent = 'Refreshing model discovery...';
        vscode.postMessage({ command: 'cockpitRefreshModels' });
      });

      document.getElementById('cmSaveEndpoint')?.addEventListener('click', () => {
        const input = document.getElementById('cmOllamaEndpoint');
        if (!input) return;
        const st = document.getElementById('cmModelsStatus');
        if (st) st.textContent = 'Testing Ollama endpoint...';
        vscode.postMessage({ command: 'cockpitSetOllamaEndpoint', url: input.value.trim() });
      });

      document.getElementById('cmPullModelBtn')?.addEventListener('click', () => {
        const input = document.getElementById('cmPullModelTag');
        const tag = input ? input.value.trim() : '';
        if (!tag) return;
        const st = document.getElementById('cmModelsStatus');
        if (st) st.textContent = 'Pulling ' + tag + '...';
        vscode.postMessage({ command: 'cockpitPullOllamaModel', modelName: tag });
      });

      cockpitModalBody.querySelectorAll('[data-save-provider]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const providerId = btn.getAttribute('data-save-provider');
          const keyInput = cockpitModalBody.querySelector('[data-key-provider="' + providerId + '"]');
          const apiKey = keyInput ? keyInput.value.trim() : '';
          if (!providerId || !apiKey) return;
          const st = document.getElementById('cmModelsStatus');
          if (st) st.textContent = 'Validating ' + providerId + ' API key...';
          vscode.postMessage({ command: 'cockpitSaveProviderKey', providerId, apiKey });
        });
      });

      cockpitModalBody.querySelectorAll('[data-pick-model]').forEach((btn) => {
        btn.addEventListener('click', () => {
          vscode.postMessage({
            command: 'selectModel',
            modelId: btn.getAttribute('data-pick-model'),
            modelName: btn.getAttribute('data-pick-name'),
            provider: btn.getAttribute('data-pick-provider'),
          });
          closeCockpitModal();
        });
      });
    }

    function renderAgentsModal(data) {
      const main = data.mainAgent || null;
      const critic = data.critic || { enabled: true };
      const subagents = Array.isArray(data.subagents) ? data.subagents : [];
      const builtinSubagents = Array.isArray(data.builtinSubagents) ? data.builtinSubagents : [];
      const manageableSubagents = Array.isArray(data.manageableSubagents)
        ? data.manageableSubagents
        : (subagents.length > 0 ? subagents : builtinSubagents);
      const predefinedRoles = Array.isArray(data.predefinedRoles) && data.predefinedRoles.length > 0
        ? data.predefinedRoles
        : [
            { role: 'Backend Developer', defaultPrompt: '' },
            { role: 'Frontend Developer', defaultPrompt: '' },
            { role: 'Security Auditor', defaultPrompt: '' },
            { role: 'Test Engineer', defaultPrompt: '' },
            { role: 'Debugging Specialist', defaultPrompt: '' },
            { role: 'Software Architect', defaultPrompt: '' },
            { role: 'Refactoring Specialist', defaultPrompt: '' },
          ];
      const availableModels = Array.isArray(data.availableModels) ? data.availableModels : [];
      const activeModelLabel = data.activeModelId || 'active model';

      function renderModelOptionsHtml(selectedModel) {
        const curr = (selectedModel || '').trim();
        let optHtml = '<option value=""' + (!curr ? ' selected' : '') + '>Same as coding model (' + escapeHtml(activeModelLabel) + ')</option>';
        availableModels.forEach((m) => {
          const mid = m.id || m.modelIdentifier || m.displayName || '';
          if (!mid) return;
          const bareId = m.id && m.id.startsWith('ollama/') ? m.id.slice(7) : (m.id || '');
          const isSelected =
            Boolean(curr) &&
            (curr === mid ||
              curr === m.id ||
              curr === m.modelIdentifier ||
              curr === m.displayName ||
              (bareId && (curr === bareId || m.id === 'ollama/' + curr)));
          optHtml += '<option value="' + escapeHtml(m.id || mid) + '"' + (isSelected ? ' selected' : '') + '>' + escapeHtml(m.displayName || mid) + '</option>';
        });
        const matchedExisting = !curr || availableModels.some((m) => {
          const bareId = m.id && m.id.startsWith('ollama/') ? m.id.slice(7) : (m.id || '');
          return (
            curr === m.id ||
            curr === m.modelIdentifier ||
            curr === m.displayName ||
            (bareId && (curr === bareId || m.id === 'ollama/' + curr))
          );
        });
        if (curr && !matchedExisting) {
          optHtml += '<option value="' + escapeHtml(curr) + '" selected>' + escapeHtml(curr) + ' (configured)</option>';
        }
        return optHtml;
      }

      let html = '';
      if (data.statusText) {
        html += '<div class="cockpit-status-note" id="cmAgentsStatus">' + escapeHtml(data.statusText) + '</div>';
      }
      html += '<div class="cockpit-section">';
      html += '<div class="cockpit-section-title"><span>Main Coding Agent</span></div>';
      html += '<div class="cockpit-row"><div class="cockpit-row-main"><div class="cockpit-row-title">' + escapeHtml(main ? (main.name || 'Main Agent') : 'Main Agent') + '</div><div class="cockpit-row-sub">Model: ' + escapeHtml((main && main.model) || activeModelLabel) + '</div></div><span class="cockpit-badge ok">Active</span></div>';
      html += '</div>';

      html += '<div class="cockpit-section">';
      html += '<div class="cockpit-section-title"><span>Code Quality & Security Critic (Review ↔ Fix Loop)</span></div>';
      html += '<div class="cockpit-row"><div class="cockpit-row-main"><div class="cockpit-row-title">Critic Review Agent</div><div class="cockpit-row-sub">Audits changes & test failures and sends defects back to Main Agent until approved</div></div>';
      html += '<button class="cockpit-btn" id="cmToggleCriticBtn" type="button">' + (critic.enabled ? 'Enabled' : 'Disabled') + '</button></div>';
      html += '<div class="cockpit-input-row" style="margin-top:8px;">';
      html += '<select class="cockpit-select" id="cmCriticModelSelect" title="Select Critic Model" style="flex:1; min-width:180px;">';
      html += renderModelOptionsHtml(critic.model || '');
      html += '</select>';
      const currStrictness = critic.strictness || 'strict';
      html += '<select class="cockpit-select" id="cmCriticStrictnessSelect" title="Review Strictness">' +
        '<option value="strict"' + (currStrictness === 'strict' ? ' selected' : '') + '>Strict</option>' +
        '<option value="moderate"' + (currStrictness === 'moderate' ? ' selected' : '') + '>Moderate</option>' +
        '<option value="paranoid"' + (currStrictness === 'paranoid' ? ' selected' : '') + '>Paranoid</option>' +
        '<option value="lenient"' + (currStrictness === 'lenient' ? ' selected' : '') + '>Lenient</option>' +
        '</select>';
      const currMaxCycles = typeof data.maxCriticCycles === 'number' ? Math.max(0, Math.floor(data.maxCriticCycles)) : 0;
      const cyclePresets = [0, 2, 4, 8, 12];
      html += '<select class="cockpit-select" id="cmCriticMaxCyclesSelect" title="Max Review Cycles">';
      cyclePresets.forEach((n) => {
        const label = n === 0 ? 'Unlimited (Until Fixed)' : ('Max ' + n + ' cycles');
        html += '<option value="' + n + '"' + (currMaxCycles === n ? ' selected' : '') + '>' + label + '</option>';
      });
      if (!cyclePresets.includes(currMaxCycles)) {
        html += '<option value="' + currMaxCycles + '" selected>Max ' + currMaxCycles + ' cycles</option>';
      }
      html += '</select>';
      html += '<button class="cockpit-btn primary" id="cmSaveCriticBtn" type="button">Apply</button>';
      html += '</div>';
      html += '</div>';

      html += '<div class="cockpit-section">';
      html += '<div class="cockpit-section-title"><span>Specialized Subagents (' + manageableSubagents.length + ')</span></div>';
      if (manageableSubagents.length === 0) {
        html += '<div class="cockpit-status-note">No subagents active.</div>';
      } else {
        manageableSubagents.forEach((s) => {
          const sid = s.id || '';
          const isEnabled = s.enabled !== false;
          const kindLabel = s.isBuiltin ? 'Built-in' : 'Custom';
          const modelDisplay = (s.model || '').trim() || ('Inherit (' + activeModelLabel + ')');
          html += '<div class="cockpit-subagent-card" data-subagent-card="' + escapeHtml(sid) + '">';
          html += '<div class="cockpit-subagent-head">';
          html += '<div class="cockpit-row-main"><div class="cockpit-row-title">' + escapeHtml(s.name || sid) + '</div><div class="cockpit-row-sub">' + escapeHtml(s.role || 'Subagent') + ' · ' + kindLabel + ' · <span style="color:#38bdf8;font-weight:600;">' + escapeHtml(modelDisplay) + '</span></div></div>';
          html += '<div class="cockpit-subagent-actions">';
          html += '<button class="cockpit-btn" type="button" data-toggle-subagent="' + escapeHtml(sid) + '">' + (isEnabled ? 'Enabled' : 'Disabled') + '</button>';
          if (s.isBuiltin && s.isCustomized) {
            html += '<button class="cockpit-btn" type="button" title="Reset customized model and instructions to default" data-reset-subagent="' + escapeHtml(sid) + '">Reset</button>';
          }
          html += '<button class="cockpit-btn danger" type="button" title="Delete this subagent" data-delete-subagent="' + escapeHtml(sid) + '">Delete</button>';
          html += '</div></div>';
          html += '<div class="cockpit-input-row">';
          html += '<select class="cockpit-select" style="flex:1; min-width:180px;" title="Select Subagent Model" data-subagent-model="' + escapeHtml(sid) + '">';
          html += renderModelOptionsHtml(s.model || '');
          html += '</select>';
          html += '<button class="cockpit-btn primary" type="button" data-save-subagent="' + escapeHtml(sid) + '">Apply</button>';
          html += '</div>';
          html += '<div class="cockpit-field-label">Instructions</div>';
          html += '<textarea class="cockpit-textarea compact" rows="2" placeholder="Write instructions for ' + escapeHtml(s.name || 'this subagent') + '..." data-subagent-prompt="' + escapeHtml(sid) + '">' + escapeHtml(s.systemPrompt || '') + '</textarea>';
          html += '</div>';
        });

        if (typeof data.deletedBuiltinCount === 'number' && data.deletedBuiltinCount > 0) {
          html += '<div style="margin-top:10px; display:flex; justify-content:flex-end;">';
          html += '<button class="cockpit-btn secondary" type="button" id="cmRestoreSubagentsBtn">Restore Default Subagents (' + data.deletedBuiltinCount + ' deleted)</button>';
          html += '</div>';
        }
      }
      html += '</div>';

      html += '<div class="cockpit-section">';
      html += '<div class="cockpit-section-title"><span>Create Subagent</span></div>';
      html += '<div class="cockpit-input-row">';
      html += '<input class="cockpit-input" id="cmSubagentName" type="text" placeholder="Subagent name (e.g. Security Reviewer)" />';
      html += '<select class="cockpit-select" id="cmSubagentRole">';
      predefinedRoles.forEach((r) => {
        const rName = r.role || '';
        if (!rName) return;
        html += '<option value="' + escapeHtml(rName) + '">' + escapeHtml(rName) + '</option>';
      });
      html += '</select>';
      html += '</div>';
      html += '<div class="cockpit-input-row">';
      html += '<select class="cockpit-select" id="cmSubagentModelSelect" title="Select New Subagent Model" style="flex:1; min-width:180px;">';
      html += renderModelOptionsHtml('');
      html += '</select>';
      html += '<button class="cockpit-btn primary" id="cmCreateSubagentBtn" type="button">Add Subagent</button>';
      html += '</div>';
      html += '<div class="cockpit-field-label">Instructions</div>';
      html += '<textarea class="cockpit-textarea compact" id="cmSubagentPrompt" rows="2" placeholder="Write instructions for this subagent (leave blank for default role instructions)..."></textarea>';
      html += '</div>';

      cockpitModalBody.innerHTML = html;
      document.getElementById('cmToggleCriticBtn')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'cockpitToggleCritic' });
      });
      document.getElementById('cmSaveCriticBtn')?.addEventListener('click', () => {
        const modelSel = document.getElementById('cmCriticModelSelect');
        const strictSel = document.getElementById('cmCriticStrictnessSelect');
        const cyclesSel = document.getElementById('cmCriticMaxCyclesSelect');
        vscode.postMessage({
          command: 'cockpitUpdateCritic',
          model: modelSel ? modelSel.value : '',
          strictness: strictSel ? strictSel.value : 'strict',
          maxCycles: cyclesSel ? Number(cyclesSel.value) : 0,
        });
      });

      cockpitModalBody.querySelectorAll('[data-toggle-subagent]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-toggle-subagent');
          if (!id) return;
          vscode.postMessage({ command: 'cockpitToggleSubagent', id });
        });
      });

      cockpitModalBody.querySelectorAll('[data-delete-subagent]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-delete-subagent');
          if (!id) return;
          vscode.postMessage({ command: 'cockpitDeleteSubagent', id });
        });
      });

      cockpitModalBody.querySelectorAll('[data-reset-subagent]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-reset-subagent');
          if (!id) return;
          vscode.postMessage({ command: 'cockpitResetSubagent', id });
        });
      });

      // Keep legacy data-remove-subagent compatibility if referenced
      cockpitModalBody.querySelectorAll('[data-remove-subagent]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-remove-subagent');
          if (!id) return;
          vscode.postMessage({ command: 'cockpitRemoveSubagent', id });
        });
      });

      document.getElementById('cmRestoreSubagentsBtn')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'cockpitRestoreSubagents' });
      });

      cockpitModalBody.querySelectorAll('[data-save-subagent]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-save-subagent');
          if (!id) return;
          const card = btn.closest('[data-subagent-card]');
          const modelSel = card ? card.querySelector('[data-subagent-model]') : null;
          const promptEl = card ? card.querySelector('[data-subagent-prompt]') : null;
          btn.textContent = 'Applied ✓';
          btn.style.background = '#059669';
          btn.style.borderColor = '#10b981';
          btn.style.color = '#ffffff';
          vscode.postMessage({
            command: 'cockpitUpdateSubagent',
            id,
            model: modelSel ? modelSel.value : '',
            systemPrompt: promptEl ? promptEl.value : '',
          });
        });
      });

      const newRoleEl = document.getElementById('cmSubagentRole');
      const newPromptEl = document.getElementById('cmSubagentPrompt');
      if (newRoleEl && newPromptEl) {
        let userEditedPrompt = false;
        const applyRoleTemplate = () => {
          const match = predefinedRoles.find((r) => r.role === newRoleEl.value);
          if (match && match.defaultPrompt && !userEditedPrompt) {
            newPromptEl.value = match.defaultPrompt;
          }
        };
        applyRoleTemplate();
        newPromptEl.addEventListener('input', () => {
          userEditedPrompt = newPromptEl.value.trim().length > 0;
        });
        newRoleEl.addEventListener('change', applyRoleTemplate);
      }

      document.getElementById('cmCreateSubagentBtn')?.addEventListener('click', () => {
        const nameEl = document.getElementById('cmSubagentName');
        const roleEl = document.getElementById('cmSubagentRole');
        const modelEl = document.getElementById('cmSubagentModelSelect');
        const promptEl = document.getElementById('cmSubagentPrompt');
        const name = nameEl ? nameEl.value.trim() : '';
        if (!name) return;
        vscode.postMessage({
          command: 'cockpitAddSubagent',
          name,
          role: roleEl ? roleEl.value : 'Backend Developer',
          model: modelEl ? modelEl.value : '',
          systemPrompt: promptEl ? promptEl.value.trim() : '',
        });
      });
    }

    function renderMcpModal(data) {
      const servers = Array.isArray(data.servers) ? data.servers : [];
      let html = '';
      html += '<div class="cockpit-section">';
      html += '<div class="cockpit-section-title"><span>Configured MCP Servers (' + servers.length + ')</span></div>';
      if (servers.length === 0) {
        html += '<div class="cockpit-status-note">No MCP servers connected yet.</div>';
      } else {
        servers.forEach((s) => {
          html += '<div class="cockpit-row">';
          html += '<div class="cockpit-row-main"><div class="cockpit-row-title">' + escapeHtml(s.name) + '</div><div class="cockpit-row-sub">' + escapeHtml(s.transport) + ' • ' + s.toolCount + ' tool(s) • ' + escapeHtml(s.target || '') + '</div></div>';
          html += '<span class="cockpit-badge ' + (s.connected ? 'ok' : 'warn') + '">' + (s.connected ? 'Connected' : 'Disconnected') + '</span>';
          html += '<button class="cockpit-btn danger" type="button" data-remove-mcp="' + escapeHtml(s.id) + '">Remove</button>';
          html += '</div>';
        });
      }
      html += '</div>';

      html += '<div class="cockpit-section">';
      html += '<div class="cockpit-section-title"><span>Add MCP Server</span></div>';
      html += '<div class="cockpit-input-row">';
      html += '<input class="cockpit-input" id="cmMcpName" type="text" placeholder="Server name (e.g. sqlite)" />';
      html += '<select class="cockpit-select" id="cmMcpTransport"><option value="stdio">stdio</option><option value="sse">sse</option></select>';
      html += '</div>';
      html += '<div class="cockpit-input-row">';
      html += '<input class="cockpit-input" id="cmMcpTarget" type="text" placeholder="Command (npx -y ...) or SSE URL (http://...)" />';
      html += '<button class="cockpit-btn primary" id="cmAddMcpBtn" type="button">Add & Connect</button>';
      html += '</div>';
      html += '</div>';

      cockpitModalBody.innerHTML = html;

      cockpitModalBody.querySelectorAll('[data-remove-mcp]').forEach((btn) => {
        btn.addEventListener('click', () => {
          vscode.postMessage({ command: 'cockpitRemoveMcpServer', id: btn.getAttribute('data-remove-mcp') });
        });
      });

      document.getElementById('cmAddMcpBtn')?.addEventListener('click', () => {
        const nameEl = document.getElementById('cmMcpName');
        const transportEl = document.getElementById('cmMcpTransport');
        const targetEl = document.getElementById('cmMcpTarget');
        const name = nameEl ? nameEl.value.trim() : '';
        const transport = transportEl ? transportEl.value : 'stdio';
        const target = targetEl ? targetEl.value.trim() : '';
        if (!name || !target) return;
        vscode.postMessage({ command: 'cockpitAddMcpServer', name, transport, target });
      });
    }

    function renderRulesModal(data) {
      let html = '';
      html += '<div class="cockpit-section">';
      html += '<div class="cockpit-section-title"><span>.localcoders/rules.md</span></div>';
      html += '<textarea class="cockpit-textarea" id="cmRulesTextarea" placeholder="Add project-specific coding guidelines and rules for LocalCoders agents...">' + escapeHtml(data.content || '') + '</textarea>';
      html += '<div class="cockpit-input-row" style="justify-content:flex-end;">';
      html += '<span class="cockpit-status-note" id="cmRulesStatus" style="margin-right:auto;">' + escapeHtml(data.statusText || '') + '</span>';
      html += '<button class="cockpit-btn primary" id="cmSaveRulesBtn" type="button">Save Rules</button>';
      html += '</div>';
      html += '</div>';

      cockpitModalBody.innerHTML = html;
      document.getElementById('cmSaveRulesBtn')?.addEventListener('click', () => {
        const ta = document.getElementById('cmRulesTextarea');
        const st = document.getElementById('cmRulesStatus');
        if (st) st.textContent = 'Saving...';
        vscode.postMessage({ command: 'cockpitSaveRules', content: ta ? ta.value : '' });
      });
    }

    function renderSettingsModal(data) {
      const defaultView = data.defaultView || 'agent';
      const permMode = data.permissionMode || 'smart';
      const stopOnExit = data.stopOllamaOnExit !== false;
      const criticEnabled = data.criticEnabled !== false;

      let html = '';
      html += '<div class="cockpit-section">';
      html += '<div class="cockpit-section-title"><span>Workspace Preferences</span></div>';

      html += '<div class="cockpit-row"><div class="cockpit-row-main"><div class="cockpit-row-title">Default Startup View</div><div class="cockpit-row-sub">Screen shown when launching LocalCoders</div></div>';
      html += '<select class="cockpit-select" id="cmDefaultViewSelect"><option value="agent"' + (defaultView === 'agent' ? ' selected' : '') + '>Agent View</option><option value="ide"' + (defaultView === 'ide' ? ' selected' : '') + '>IDE View</option></select></div>';

      html += '<div class="cockpit-row"><div class="cockpit-row-main"><div class="cockpit-row-title">Tool Permission Mode</div><div class="cockpit-row-sub">Controls approval prompts for writes and terminal commands</div></div>';
      html += '<select class="cockpit-select" id="cmPermissionSelect"><option value="ask"' + (permMode === 'ask' ? ' selected' : '') + '>Ask Before Actions</option><option value="smart"' + (permMode === 'smart' ? ' selected' : '') + '>Smart Approval</option><option value="bypass"' + (permMode === 'bypass' ? ' selected' : '') + '>Bypass Permissions</option></select></div>';

      html += '<div class="cockpit-row"><div class="cockpit-row-main"><div class="cockpit-row-title">Stop Ollama Server on Exit</div><div class="cockpit-row-sub">Unload models and free GPU memory when closing app</div></div>';
      html += '<input type="checkbox" id="cmStopOllamaCheck"' + (stopOnExit ? ' checked' : '') + ' /></div>';

      html += '<div class="cockpit-row"><div class="cockpit-row-main"><div class="cockpit-row-title">Critic Auto-Review</div><div class="cockpit-row-sub">Verify modified files before completing coding tasks</div></div>';
      html += '<button class="cockpit-btn" id="cmSettingsToggleCritic" type="button">' + (criticEnabled ? 'Enabled' : 'Disabled') + '</button></div>';

      html += '</div>';

      html += '<div class="cockpit-input-row" style="justify-content:flex-end;">';
      html += '<button class="cockpit-btn" id="cmOpenAgentsFromSettings" type="button">Manage Agent Team</button>';
      html += '<button class="cockpit-btn" id="cmOpenModelsFromSettings" type="button">Manage Models & Providers</button>';
      html += '</div>';

      cockpitModalBody.innerHTML = html;

      document.getElementById('cmDefaultViewSelect')?.addEventListener('change', (e) => {
        vscode.postMessage({ command: 'cockpitUpdateSetting', key: 'defaultView', value: e.target.value });
      });
      document.getElementById('cmPermissionSelect')?.addEventListener('change', (e) => {
        vscode.postMessage({ command: 'setPermissionMode', permissionMode: e.target.value });
      });
      document.getElementById('cmStopOllamaCheck')?.addEventListener('change', (e) => {
        vscode.postMessage({ command: 'cockpitUpdateSetting', key: 'stopOllamaOnExit', value: !!e.target.checked });
      });
      document.getElementById('cmSettingsToggleCritic')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'cockpitToggleCritic', returnModal: 'settings' });
      });
      document.getElementById('cmOpenAgentsFromSettings')?.addEventListener('click', () => {
        requestCockpitModal('agents');
      });
      document.getElementById('cmOpenModelsFromSettings')?.addEventListener('click', () => {
        requestCockpitModal('models');
      });
    }
  `;
}
