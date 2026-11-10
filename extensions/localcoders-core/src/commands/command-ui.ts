/**
 * Shared Slash Command Autocomplete & Command Result UI Components.
 * Used identically across Agent Workspace Editor and Chat Sidebar so command
 * discovery, keyboard navigation, bypass indicators, and result cards remain unified.
 */

export function getSlashCommandStyles(): string {
  return `
    /* Slash Command Autocomplete Popup */
    .lc-slash-popup {
      display: none;
      position: absolute;
      left: 0;
      right: 0;
      bottom: calc(100% + 8px);
      background: var(--vscode-menu-background, #18191e);
      border: 1px solid var(--vscode-widget-border, rgba(148, 163, 184, 0.22));
      border-radius: 10px;
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.55);
      z-index: 140;
      overflow: hidden;
      flex-direction: column;
      max-height: 300px;
      animation: lcSlashFadeIn 0.12s ease;
    }
    .lc-slash-popup.open {
      display: flex;
    }
    @keyframes lcSlashFadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .lc-slash-popup-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 12px;
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground, #94a3b8);
      border-bottom: 1px solid var(--vscode-widget-border, rgba(148, 163, 184, 0.12));
      background: color-mix(in srgb, var(--vscode-editor-background, #111214) 70%, transparent);
    }
    .lc-slash-popup-hint {
      font-size: 10px;
      font-weight: 500;
      opacity: 0.8;
    }
    .lc-slash-list {
      overflow-y: auto;
      padding: 5px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .lc-slash-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 7px 10px;
      border-radius: 6px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: background 0.1s ease, border-color 0.1s ease;
      text-align: left;
      width: 100%;
      background: transparent;
      color: inherit;
      font-family: inherit;
    }
    .lc-slash-item:hover,
    .lc-slash-item.active {
      background: color-mix(in srgb, var(--vscode-textLink-foreground, #38bdf8) 14%, transparent);
      border-color: color-mix(in srgb, var(--vscode-textLink-foreground, #38bdf8) 32%, transparent);
    }
    .lc-slash-item-left {
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
      flex: 1;
    }
    .lc-slash-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 5px;
      background: rgba(148, 163, 184, 0.1);
      color: var(--vscode-textLink-foreground, #38bdf8);
      flex-shrink: 0;
    }
    .lc-slash-item-text {
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
    }
    .lc-slash-name-row {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .lc-slash-name {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-editor-foreground, #f1f5f9);
      white-space: nowrap;
    }
    .lc-slash-usage {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10.5px;
      color: var(--vscode-descriptionForeground, #94a3b8);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .lc-slash-desc {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #94a3b8);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .lc-slash-cat {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 4px;
      background: rgba(148, 163, 184, 0.12);
      color: var(--vscode-descriptionForeground, #94a3b8);
      flex-shrink: 0;
      white-space: nowrap;
    }
    .lc-slash-empty {
      padding: 12px 14px;
      font-size: 11.5px;
      color: var(--vscode-descriptionForeground, #94a3b8);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Active Bypass Permission Pill Highlight */
    .tool-btn-pill.bypass-active {
      border-color: rgba(245, 158, 11, 0.45);
      background: rgba(245, 158, 11, 0.14);
      color: #fcd34d;
    }

    /* Dedicated Slash Command Result Card (distinct from assistant chat messages) */
    .lc-cmd-result-card {
      border: 1px solid var(--vscode-widget-border, rgba(148, 163, 184, 0.18));
      background: color-mix(in srgb, var(--vscode-sideBar-background, #18181b) 88%, #000 12%);
      border-radius: 8px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 7px;
      font-size: 12.5px;
    }
    .lc-cmd-result-card.status-error {
      border-color: rgba(239, 68, 68, 0.38);
    }
    .lc-cmd-result-card.status-confirmation_required {
      border-color: rgba(245, 158, 11, 0.42);
    }
    .lc-cmd-result-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .lc-cmd-result-title-wrap {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }
    .lc-cmd-tag {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 4px;
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.28);
      color: #38bdf8;
    }
    .lc-cmd-result-title {
      font-weight: 600;
      font-size: 12.5px;
      color: var(--vscode-editor-foreground, #f1f5f9);
    }
    .lc-cmd-status-pill {
      font-size: 10px;
      font-weight: 600;
      padding: 1px 7px;
      border-radius: 999px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .lc-cmd-status-pill.success { background: rgba(34, 197, 94, 0.16); color: #4ade80; }
    .lc-cmd-status-pill.error { background: rgba(239, 68, 68, 0.16); color: #f87171; }
    .lc-cmd-status-pill.info { background: rgba(56, 189, 248, 0.16); color: #38bdf8; }
    .lc-cmd-status-pill.confirmation_required { background: rgba(245, 158, 11, 0.18); color: #fbbf24; }
    .lc-cmd-status-pill.cancelled { background: rgba(148, 163, 184, 0.16); color: #94a3b8; }
    .lc-cmd-msg {
      color: var(--vscode-editor-foreground, #cbd5e1);
      line-height: 1.5;
      white-space: pre-wrap;
    }
    .lc-cmd-details-grid {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 3px 12px;
      padding: 6px 8px;
      border-radius: 5px;
      background: rgba(0, 0, 0, 0.22);
      font-size: 11.5px;
    }
    .lc-cmd-detail-k {
      color: var(--vscode-descriptionForeground, #94a3b8);
      font-weight: 600;
    }
    .lc-cmd-detail-v {
      color: var(--vscode-editor-foreground, #e2e8f0);
      font-family: var(--vscode-editor-font-family, monospace);
      word-break: break-word;
    }
    .lc-cmd-code {
      margin: 0;
      padding: 8px 10px;
      border-radius: 5px;
      background: rgba(0, 0, 0, 0.32);
      border: 1px solid rgba(148, 163, 184, 0.12);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
      line-height: 1.45;
      color: var(--vscode-editor-foreground, #e2e8f0);
      max-height: 240px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .lc-cmd-warn {
      font-size: 11px;
      color: #fbbf24;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .lc-cmd-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 2px;
    }
    .lc-cmd-btn {
      border-radius: 5px;
      border: 1px solid rgba(148, 163, 184, 0.25);
      padding: 4px 11px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.12s ease, opacity 0.12s ease;
    }
    .lc-cmd-btn.confirm {
      background: rgba(34, 197, 94, 0.18);
      border-color: rgba(34, 197, 94, 0.42);
      color: #4ade80;
    }
    .lc-cmd-btn.confirm:hover {
      background: rgba(34, 197, 94, 0.28);
    }
    .lc-cmd-btn.cancel {
      background: rgba(148, 163, 184, 0.1);
      color: #cbd5e1;
    }
    .lc-cmd-btn.cancel:hover {
      background: rgba(239, 68, 68, 0.16);
      border-color: rgba(239, 68, 68, 0.35);
      color: #fca5a5;
    }
  `;
}

export function getSlashCommandPopupMarkup(): string {
  return `
    <div class="lc-slash-popup" id="slashCommandPopup" role="listbox" aria-label="Slash Commands">
      <div class="lc-slash-popup-header">
        <span id="slashPopupHeaderTitle">Commands</span>
        <span class="lc-slash-popup-hint">Up/Down · Enter/Tab · Esc</span>
      </div>
      <div class="lc-slash-list" id="slashPopupList"></div>
    </div>
  `;
}

export function getSlashCommandClientScript(): string {
  return `
    function lcEscapeSlash(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function lcIsSlashCommandInput(raw) {
      if (typeof raw !== 'string') return false;
      const trimmed = raw.trim();
      if (!trimmed.startsWith('/') || trimmed.length < 2) return false;
      const firstToken = trimmed.split(/\\s+/)[0] || '';
      if (firstToken.indexOf('/', 1) !== -1) return false;
      return /^\\/[a-zA-Z?][a-zA-Z0-9_-]*$/.test(firstToken);
    }

    function lcParseAutocompleteQuery(raw) {
      if (typeof raw !== 'string' || !raw.startsWith('/')) return null;
      if (raw.indexOf('\\n') !== -1) return null;
      const wsIdx = raw.search(/\\s/);
      if (wsIdx === -1) {
        const token = raw.slice(1);
        if (token.indexOf('/') !== -1) return null;
        if (token.length > 0 && !/^[a-zA-Z?][a-zA-Z0-9_-]*$/.test(token)) return null;
        return { mode: 'command', commandQuery: token.toLowerCase(), argQuery: '' };
      }
      const cmdTok = raw.slice(1, wsIdx);
      if (!cmdTok || cmdTok.indexOf('/') !== -1 || !/^[a-zA-Z?][a-zA-Z0-9_-]*$/.test(cmdTok)) return null;
      return { mode: 'arg', commandQuery: cmdTok.toLowerCase(), argQuery: raw.slice(wsIdx + 1) };
    }

    function lcCreateSlashController(opts) {
      const promptEl = opts.promptEl;
      const popupEl = opts.popupEl;
      const listEl = document.getElementById('slashPopupList');
      const headerTitleEl = document.getElementById('slashPopupHeaderTitle');

      let open = false;
      let queryMode = 'command';
      let items = [];
      let activeIndex = 0;
      let argNavigated = false;

      function getCatalog() {
        return typeof opts.getCatalog === 'function' ? (opts.getCatalog() || []) : [];
      }

      function filterCommands(q) {
        const catalog = getCatalog();
        if (!q) return catalog;
        const lower = q.toLowerCase();
        const prefixMatches = catalog.filter((c) => {
          if (c.name.toLowerCase().startsWith(lower)) return true;
          return Array.isArray(c.aliases) && c.aliases.some((a) => a.toLowerCase().startsWith(lower));
        });
        if (prefixMatches.length > 0) return prefixMatches;
        const subMatches = catalog.filter((c) => {
          if (c.name.toLowerCase().includes(lower)) return true;
          return Array.isArray(c.aliases) && c.aliases.some((a) => a.toLowerCase().includes(lower));
        });
        if (subMatches.length > 0) return subMatches;
        return catalog.filter((c) => (c.description || '').toLowerCase().includes(lower));
      }

      function buildArgSuggestions(cmdObj, argQuery) {
        if (!cmdObj) return [];
        const q = (argQuery || '').trim().toLowerCase();
        const suggestions = [];

        if (Array.isArray(cmdObj.subcommands) && cmdObj.subcommands.length > 0) {
          cmdObj.subcommands.forEach((s) => {
            if (!q || s.name.toLowerCase().startsWith(q)) {
              suggestions.push({
                kind: 'arg',
                cmdName: cmdObj.name,
                insertText: '/' + cmdObj.name + ' ' + s.name + (s.arguments && s.arguments.some((a) => a.required) ? ' ' : ''),
                display: '/' + cmdObj.name + ' ' + s.name,
                usage: s.usage || '',
                desc: s.description || '',
                category: 'Subcommand',
                icon: cmdObj.icon || 'terminal',
                requiresMore: !!(s.arguments && s.arguments.some((a) => a.required)),
              });
            }
          });
        }

        if (cmdObj.name === 'model' || cmdObj.name === 'model-info') {
          const models = typeof opts.getModels === 'function' ? (opts.getModels() || []) : [];
          models.forEach((m) => {
            const ident = m.modelIdentifier || m.id || '';
            if (!q || ident.toLowerCase().includes(q)) {
              suggestions.push({
                kind: 'arg',
                cmdName: cmdObj.name,
                insertText: '/' + cmdObj.name + ' ' + ident,
                display: ident,
                usage: m.providerName || '',
                desc: (m.contextWindow ? 'ctx ' + m.contextWindow : m.availability || ''),
                category: 'Model',
                icon: 'cpu',
                requiresMore: false,
              });
            }
          });
        }

        if (cmdObj.name === 'reasoning' || cmdObj.name === 'help') {
          const vals = cmdObj.name === 'reasoning'
            ? ['minimal', 'low', 'medium', 'high', 'extra_high']
            : getCatalog().map((c) => c.name);
          vals.forEach((v) => {
            if (!q || v.toLowerCase().includes(q)) {
              suggestions.push({
                kind: 'arg',
                cmdName: cmdObj.name,
                insertText: '/' + cmdObj.name + ' ' + v,
                display: v,
                usage: '/' + cmdObj.name + ' ' + v,
                desc: cmdObj.name === 'reasoning' ? 'Reasoning effort level' : 'Show help for /' + v,
                category: 'Arg',
                icon: cmdObj.icon || 'chevron-right',
                requiresMore: false,
              });
            }
          });
        }

        return suggestions.slice(0, 12);
      }

      function render() {
        if (!popupEl || !listEl) return;
        if (!open) {
          popupEl.classList.remove('open');
          return;
        }
        popupEl.classList.add('open');
        listEl.innerHTML = '';

        if (headerTitleEl) {
          headerTitleEl.textContent = queryMode === 'arg' ? 'Command Arguments' : 'Commands';
        }

        if (items.length === 0) {
          const rawVal = (promptEl && promptEl.value || '').trim();
          listEl.innerHTML =
            '<div class="lc-slash-empty">' +
            lcIcon('triangle-alert', 13) +
            '<span>No matching command for <code>' + lcEscapeSlash(rawVal) + '</code> · Press Enter to run check or /help</span>' +
            '</div>';
          return;
        }

        items.forEach((item, idx) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'lc-slash-item' + (idx === activeIndex ? ' active' : '');
          btn.setAttribute('role', 'option');
          btn.setAttribute('aria-selected', idx === activeIndex ? 'true' : 'false');

          const aliasHint = item.aliases && item.aliases.length > 0 ? ' (' + item.aliases.map((a) => '/' + a).join(', ') + ')' : '';
          const mainLabel = item.kind === 'arg' ? item.display : '/' + item.name;
          const usageText = item.kind === 'arg' ? item.usage : (item.usage && item.usage !== '/' + item.name ? item.usage : aliasHint);

          btn.innerHTML =
            '<div class="lc-slash-item-left">' +
            '<span class="lc-slash-icon">' + lcIcon(item.icon || 'terminal', 13) + '</span>' +
            '<div class="lc-slash-item-text">' +
            '<div class="lc-slash-name-row">' +
            '<span class="lc-slash-name">' + lcEscapeSlash(mainLabel) + '</span>' +
            (usageText ? '<span class="lc-slash-usage">' + lcEscapeSlash(usageText) + '</span>' : '') +
            '</div>' +
            '<span class="lc-slash-desc">' + lcEscapeSlash(item.desc || item.description || '') + '</span>' +
            '</div>' +
            '</div>' +
            '<span class="lc-slash-cat">' + lcEscapeSlash(item.category || 'Command') + '</span>';

          btn.addEventListener('mouseenter', () => {
            activeIndex = idx;
            argNavigated = queryMode === 'arg';
            listEl.querySelectorAll('.lc-slash-item').forEach((el, i) => {
              el.classList.toggle('active', i === activeIndex);
            });
          });
          btn.addEventListener('mousedown', (e) => {
            e.preventDefault(); // Keep textarea focused cleanly
          });
          btn.addEventListener('click', () => {
            activeIndex = idx;
            selectCurrent('click');
          });
          listEl.appendChild(btn);
        });

        const activeRow = listEl.querySelector('.lc-slash-item.active');
        if (activeRow && typeof activeRow.scrollIntoView === 'function') {
          activeRow.scrollIntoView({ block: 'nearest' });
        }
      }

      function refreshFromInput() {
        if (!promptEl) return;
        const q = lcParseAutocompleteQuery(promptEl.value);
        if (!q) {
          close();
          return;
        }
        queryMode = q.mode;
        if (q.mode === 'command') {
          items = filterCommands(q.commandQuery);
          activeIndex = 0;
          argNavigated = false;
          open = true;
        } else {
          const catalog = getCatalog();
          const cmdObj = catalog.find(
            (c) => c.name === q.commandQuery || (Array.isArray(c.aliases) && c.aliases.includes(q.commandQuery))
          );
          items = buildArgSuggestions(cmdObj, q.argQuery);
          activeIndex = -1;
          argNavigated = false;
          open = items.length > 0;
        }
        render();
      }

      function close() {
        open = false;
        items = [];
        activeIndex = 0;
        argNavigated = false;
        render();
      }

      function selectCurrent(trigger) {
        if (!promptEl) return false;
        const item = items[activeIndex];
        if (!item) return false;

        if (item.kind === 'arg') {
          promptEl.value = item.insertText;
          promptEl.focus();
          if (trigger !== 'tab' && !item.requiresMore) {
            const toRun = promptEl.value.trim();
            close();
            promptEl.value = '';
            promptEl.style.height = 'auto';
            opts.onSubmitSlash(toRun);
            return true;
          }
          refreshFromInput();
          return true;
        }

        const hasRequiredArgs = Array.isArray(item.arguments) && item.arguments.some((a) => a.required);
        if (trigger === 'tab' || hasRequiredArgs) {
          promptEl.value = '/' + item.name + ' ';
          promptEl.focus();
          refreshFromInput();
          return true;
        }

        const cmdLine = '/' + item.name;
        close();
        promptEl.value = '';
        promptEl.style.height = 'auto';
        opts.onSubmitSlash(cmdLine);
        return true;
      }

      function handleKeyDown(e) {
        if (!open) return false;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close();
          return true;
        }
        if (e.key === 'ArrowDown') {
          if (items.length === 0) return false;
          e.preventDefault();
          activeIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % items.length;
          if (queryMode === 'arg') argNavigated = true;
          render();
          return true;
        }
        if (e.key === 'ArrowUp') {
          if (items.length === 0) return false;
          e.preventDefault();
          activeIndex = activeIndex <= 0 ? items.length - 1 : activeIndex - 1;
          if (queryMode === 'arg') argNavigated = true;
          render();
          return true;
        }
        if (e.key === 'Tab') {
          if (items.length === 0) return false;
          e.preventDefault();
          if (activeIndex < 0) activeIndex = 0;
          return selectCurrent('tab');
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          if (queryMode === 'arg' && !argNavigated) {
            // User already finished typing command + argument; let caller execute full input directly
            close();
            return false;
          }
          if (items.length === 0) {
            // Unknown command typed: let caller execute so executor emits unknown-command error
            close();
            return false;
          }
          e.preventDefault();
          if (activeIndex < 0) activeIndex = 0;
          return selectCurrent('enter');
        }
        return false;
      }

      return {
        refreshFromInput,
        handleKeyDown,
        close,
        isOpen: () => open,
        getItems: () => items,
        getActiveIndex: () => activeIndex,
      };
    }

    function lcBuildCommandResultElement(res, callbacks) {
      const card = document.createElement('div');
      const status = res.status || (res.ok ? 'success' : 'error');
      card.className = 'lc-cmd-result-card status-' + status;
      card.setAttribute('data-cmd-id', res.id || '');

      const head = document.createElement('div');
      head.className = 'lc-cmd-result-head';
      head.innerHTML =
        '<div class="lc-cmd-result-title-wrap">' +
        '<span class="lc-cmd-tag">/' + lcEscapeSlash(res.command || 'cmd') + '</span>' +
        '<span class="lc-cmd-result-title">' + lcEscapeSlash(res.title || '') + '</span>' +
        '</div>' +
        '<span class="lc-cmd-status-pill ' + lcEscapeSlash(status) + '">' + lcEscapeSlash(status.replace('_', ' ')) + '</span>';
      card.appendChild(head);

      if (res.message) {
        const msg = document.createElement('div');
        msg.className = 'lc-cmd-msg';
        msg.textContent = res.message;
        card.appendChild(msg);
      }

      if (Array.isArray(res.details) && res.details.length > 0) {
        const grid = document.createElement('div');
        grid.className = 'lc-cmd-details-grid';
        grid.innerHTML = res.details
          .map((d) => '<span class="lc-cmd-detail-k">' + lcEscapeSlash(d.label) + '</span><span class="lc-cmd-detail-v">' + lcEscapeSlash(d.value) + '</span>')
          .join('');
        card.appendChild(grid);
      }

      if (res.codeBlock && res.codeBlock.content) {
        const pre = document.createElement('pre');
        pre.className = 'lc-cmd-code';
        pre.textContent = res.codeBlock.content;
        card.appendChild(pre);
      }

      if (Array.isArray(res.warnings) && res.warnings.length > 0) {
        res.warnings.forEach((w) => {
          const warn = document.createElement('div');
          warn.className = 'lc-cmd-warn';
          warn.innerHTML = lcIcon('triangle-alert', 12) + '<span>' + lcEscapeSlash(w) + '</span>';
          card.appendChild(warn);
        });
      }

      if (status === 'confirmation_required' && res.confirmPrompt) {
        const actions = document.createElement('div');
        actions.className = 'lc-cmd-actions';
        const btnConfirm = document.createElement('button');
        btnConfirm.type = 'button';
        btnConfirm.className = 'lc-cmd-btn confirm';
        btnConfirm.textContent = res.confirmPrompt.confirmLabel || 'Confirm';
        btnConfirm.addEventListener('click', () => {
          card.remove();
          if (callbacks && callbacks.onConfirm) callbacks.onConfirm(res.confirmPrompt.commandLine, res.id);
        });
        const btnCancel = document.createElement('button');
        btnCancel.type = 'button';
        btnCancel.className = 'lc-cmd-btn cancel';
        btnCancel.textContent = 'Cancel';
        btnCancel.addEventListener('click', () => {
          card.remove();
          if (callbacks && callbacks.onCancel) callbacks.onCancel(res.id);
        });
        actions.appendChild(btnConfirm);
        actions.appendChild(btnCancel);
        card.appendChild(actions);
      }

      return card;
    }
  `;
}
