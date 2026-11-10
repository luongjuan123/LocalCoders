/**
 * Shared Queue Panel UI styles, HTML markup, and client script for both
 * Agent Workspace (Agent View) and Sidebar Chat (IDE View).
 * Uses strict SVG Lucide icons (zero emojis or Unicode symbol icons).
 */

import { lucideSvg } from './lucide-icons';

export function getQueuePanelStyles(options: { compact?: boolean } = {}): string {
  const dockLayout = options.compact
    ? `
      width: 100%;
      margin: 0;
      border-top: 1px solid var(--border);
      background: color-mix(in srgb, var(--card-bg, #16171a) 92%, #000);
    `
    : `
      width: calc(100% - 40px);
      max-width: 780px;
      margin: 4px auto 0 auto;
      border: 1px solid var(--border);
      border-radius: 9px;
      background: color-mix(in srgb, var(--input-bg, #18191d) 96%, #000);
    `;

  return `
    .lc-queue-dock {
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: border-color 0.15s ease;
      ${dockLayout}
    }
    .lc-queue-dock.has-items {
      border-color: color-mix(in srgb, var(--accent, #38bdf8) 32%, var(--border));
    }
    .lc-queue-dock.is-failed {
      border-color: color-mix(in srgb, #ef4444 45%, var(--border));
    }
    .lc-queue-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 10px;
      min-height: 30px;
      user-select: none;
    }
    .lc-queue-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: transparent;
      border: none;
      color: var(--fg, #e4e4e7);
      font-family: inherit;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 4px;
      min-width: 0;
    }
    .lc-queue-toggle:hover {
      background: rgba(255, 255, 255, 0.06);
    }
    .lc-queue-subtitle {
      font-size: 10.5px;
      font-weight: 400;
      color: var(--text-muted, #94a3b8);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .lc-queue-header-right {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
    }
    .lc-queue-state-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.02em;
      background: rgba(148, 163, 184, 0.14);
      color: #cbd5e1;
      border: 1px solid rgba(148, 163, 184, 0.24);
    }
    .lc-queue-state-pill.state-running,
    .lc-queue-state-pill.state-processing_next {
      background: rgba(56, 189, 248, 0.14);
      color: #7dd3fc;
      border-color: rgba(56, 189, 248, 0.35);
    }
    .lc-queue-state-pill.state-queued {
      background: rgba(99, 102, 241, 0.16);
      color: #c7d2fe;
      border-color: rgba(129, 140, 248, 0.35);
    }
    .lc-queue-state-pill.state-paused {
      background: rgba(245, 158, 11, 0.15);
      color: #fcd34d;
      border-color: rgba(245, 158, 11, 0.38);
    }
    .lc-queue-state-pill.state-failed {
      background: rgba(239, 68, 68, 0.16);
      color: #fca5a5;
      border-color: rgba(239, 68, 68, 0.4);
    }
    .lc-queue-state-pill.state-completed {
      background: rgba(34, 197, 94, 0.14);
      color: #86efac;
      border-color: rgba(34, 197, 94, 0.34);
    }
    .lc-queue-hdr-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 22px;
      padding: 0 7px;
      border-radius: 5px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.04);
      color: #cbd5e1;
      font-family: inherit;
      font-size: 10.5px;
      font-weight: 500;
      cursor: pointer;
    }
    .lc-queue-hdr-btn:hover {
      background: rgba(255, 255, 255, 0.11);
      color: #ffffff;
    }
    .lc-queue-hdr-btn.danger:hover {
      border-color: rgba(239, 68, 68, 0.45);
      color: #fca5a5;
      background: rgba(239, 68, 68, 0.14);
    }
    .lc-queue-body {
      display: none;
      flex-direction: column;
      gap: 6px;
      padding: 4px 10px 9px 10px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      max-height: 220px;
      overflow-y: auto;
    }
    .lc-queue-body.open {
      display: flex;
    }
    .lc-queue-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 6px;
      font-size: 11px;
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.35);
      color: #fde68a;
    }
    .lc-queue-banner.error {
      background: rgba(239, 68, 68, 0.12);
      border-color: rgba(239, 68, 68, 0.38);
      color: #fecaca;
    }
    .lc-queue-empty {
      padding: 8px 6px;
      font-size: 11px;
      color: var(--text-muted, #94a3b8);
      text-align: center;
    }
    .lc-queue-list {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .lc-queue-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 7px 9px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .lc-queue-item.status-processing {
      border-color: rgba(56, 189, 248, 0.45);
      background: rgba(56, 189, 248, 0.08);
    }
    .lc-queue-item.status-failed {
      border-color: rgba(239, 68, 68, 0.48);
      background: rgba(239, 68, 68, 0.08);
    }
    .lc-queue-item-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .lc-queue-item-main {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      min-width: 0;
      flex: 1;
    }
    .lc-queue-pos {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted, #94a3b8);
      flex-shrink: 0;
      margin-top: 1px;
      min-width: 16px;
    }
    .lc-queue-preview {
      font-size: 12px;
      line-height: 1.4;
      color: var(--fg, #f1f5f9);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 76px;
      overflow-y: auto;
      flex: 1;
    }
    .lc-queue-item-meta {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      padding-left: 22px;
      font-size: 10.5px;
      color: var(--text-muted, #94a3b8);
    }
    .lc-queue-badge {
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      background: rgba(255, 255, 255, 0.08);
      color: #cbd5e1;
    }
    .lc-queue-badge.status-processing {
      background: rgba(56, 189, 248, 0.2);
      color: #7dd3fc;
    }
    .lc-queue-badge.status-failed {
      background: rgba(239, 68, 68, 0.2);
      color: #fca5a5;
    }
    .lc-queue-att-chip {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 6px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 10px;
      color: #cbd5e1;
    }
    .lc-queue-actions {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      flex-shrink: 0;
    }
    .lc-queue-act-btn {
      width: 22px;
      height: 22px;
      border-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.04);
      color: #cbd5e1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
    }
    .lc-queue-act-btn:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.14);
      color: #ffffff;
    }
    .lc-queue-act-btn:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
    .lc-queue-act-btn.delete:hover:not(:disabled) {
      background: rgba(239, 68, 68, 0.18);
      border-color: rgba(239, 68, 68, 0.4);
      color: #fca5a5;
    }
    .lc-queue-item-err {
      margin-left: 22px;
      padding: 4px 7px;
      border-radius: 4px;
      background: rgba(239, 68, 68, 0.14);
      color: #fecaca;
      font-size: 11px;
    }
    .lc-queue-edit-box {
      margin-left: 22px;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .lc-queue-edit-input {
      width: 100%;
      min-height: 48px;
      padding: 6px 8px;
      border-radius: 5px;
      border: 1px solid var(--accent, #38bdf8);
      background: #0b0d12;
      color: #f8fafc;
      font-family: inherit;
      font-size: 12px;
      resize: vertical;
      outline: none;
    }
    .lc-queue-edit-btns {
      display: flex;
      gap: 6px;
      justify-content: flex-end;
    }
  `;
}

export function getQueuePanelMarkup(): string {
  return `
      <div class="lc-queue-dock" id="lcQueueDock" style="display:none;">
        <div class="lc-queue-header" id="lcQueueHeader">
          <button type="button" class="lc-queue-toggle" id="lcQueueToggleBtn" title="Expand or collapse queued messages">
            <span id="lcQueueChevron">${lucideSvg('chevron-right', 13)}</span>
            <span id="lcQueueTitle">Queued Messages (0)</span>
            <span class="lc-queue-subtitle" id="lcQueueSubtitle">Sends after agent finishes working</span>
          </button>
          <div class="lc-queue-header-right">
            <span class="lc-queue-state-pill state-idle" id="lcQueueStateBadge">Idle</span>
            <button type="button" class="lc-queue-hdr-btn" id="btnQueuePauseResume" style="display:none;" title="Pause or resume queue execution">${lucideSvg('pause', 11)}<span>Pause</span></button>
            <button type="button" class="lc-queue-hdr-btn danger" id="btnQueueClear" style="display:none;" title="Clear queued messages">${lucideSvg('trash-2', 11)}<span>Clear</span></button>
          </div>
        </div>
        <div class="lc-queue-body" id="lcQueueBody">
          <div class="lc-queue-banner" id="lcQueueBanner" style="display:none;"></div>
          <div class="lc-queue-empty" id="lcQueueEmpty">No messages queued. You can keep sending messages while the agent is working.</div>
          <div class="lc-queue-list" id="lcQueueList"></div>
        </div>
      </div>
  `;
}

export function getQueuePanelClientScript(): string {
  return `
    const lcQueueDock = document.getElementById('lcQueueDock');
    const lcQueueToggleBtn = document.getElementById('lcQueueToggleBtn');
    const lcQueueChevron = document.getElementById('lcQueueChevron');
    const lcQueueTitle = document.getElementById('lcQueueTitle');
    const lcQueueSubtitle = document.getElementById('lcQueueSubtitle');
    const lcQueueStateBadge = document.getElementById('lcQueueStateBadge');
    const btnQueuePauseResume = document.getElementById('btnQueuePauseResume');
    const btnQueueClear = document.getElementById('btnQueueClear');
    const lcQueueBody = document.getElementById('lcQueueBody');
    const lcQueueBanner = document.getElementById('lcQueueBanner');
    const lcQueueEmpty = document.getElementById('lcQueueEmpty');
    const lcQueueList = document.getElementById('lcQueueList');

    let lcQueueSnapshot = {
      sessionId: '',
      state: 'idle',
      paused: false,
      activeItemId: null,
      activeExecutionId: null,
      isBusy: false,
      capacity: 200,
      queuedCount: 0,
      failedCount: 0,
      completedCount: 0,
      lastError: '',
      items: []
    };
    let lcQueueExpanded = false;
    let lcQueueUserToggled = false;
    let lcQueueEditingId = null;

    function lcQueueEscape(str) {
      if (str === undefined || str === null) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function lcQueueFormatTime(ts) {
      if (!ts) return '';
      try {
        var d = new Date(ts);
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        var ss = String(d.getSeconds()).padStart(2, '0');
        return hh + ':' + mm + ':' + ss;
      } catch (e) {
        return '';
      }
    }

    function lcQueueStateLabel(state) {
      switch (state) {
        case 'running': return 'Running';
        case 'queued': return 'Queued';
        case 'processing_next': return 'Processing next';
        case 'paused': return 'Paused';
        case 'failed': return 'Failed';
        case 'completed': return 'Completed';
        default: return 'Idle';
      }
    }

    function lcCanResumeSnapshot(snap) {
      if (!snap) return false;
      var items = Array.isArray(snap.items) ? snap.items : [];
      var failedCount = typeof snap.failedCount === 'number'
        ? snap.failedCount
        : items.filter(function(i) { return i.status === 'failed'; }).length;
      return Boolean(snap.paused || (failedCount > 0 && !snap.isBusy));
    }

    function lcRenderQueuePanel() {
      if (!lcQueueDock) return;
      var snap = lcQueueSnapshot || { state: 'idle', paused: false, queuedCount: 0, failedCount: 0, items: [] };
      var items = Array.isArray(snap.items) ? snap.items : [];
      var pendingCount = typeof snap.queuedCount === 'number'
        ? snap.queuedCount
        : items.filter(function(i) { return i.status === 'queued'; }).length;
      var failedCount = typeof snap.failedCount === 'number'
        ? snap.failedCount
        : items.filter(function(i) { return i.status === 'failed'; }).length;
      var canResume = lcCanResumeSnapshot(snap);
      var totalVisible = items.length;
      var showQueueDock = pendingCount > 0 || failedCount > 0 || !!snap.paused || !!snap.lastError;
      if (lcQueueDock.style) {
        lcQueueDock.style.display = showQueueDock ? 'flex' : 'none';
      }
      if (!showQueueDock) {
        lcQueueExpanded = false;
        lcQueueUserToggled = false;
        if (lcQueueBody && lcQueueBody.classList) {
          lcQueueBody.classList.remove('open');
        }
        return;
      }

      if (!lcQueueUserToggled) {
        lcQueueExpanded = totalVisible > 0;
      }

      if (lcQueueDock.classList) {
        lcQueueDock.classList.toggle('has-items', pendingCount > 0 || !!snap.activeItemId);
        lcQueueDock.classList.toggle('is-failed', snap.state === 'failed' || failedCount > 0);
      }

      if (lcQueueTitle) {
        lcQueueTitle.textContent = 'Queued Messages (' + pendingCount + ')';
      }

      if (lcQueueSubtitle) {
        if (snap.state === 'processing_next') {
          lcQueueSubtitle.textContent = 'Starting next queued message...';
        } else if ((snap.paused || snap.state === 'failed') && failedCount > 0) {
          lcQueueSubtitle.textContent = 'Paused on error — click Resume to retry, or edit/skip';
        } else if (snap.paused) {
          lcQueueSubtitle.textContent = 'Paused — click Resume to continue';
        } else if (pendingCount > 0 && snap.isBusy) {
          lcQueueSubtitle.textContent = 'Sends after agent finishes working';
        } else if (pendingCount > 0) {
          lcQueueSubtitle.textContent = 'Waiting in queue (' + pendingCount + ')';
        } else if (snap.state === 'completed') {
          lcQueueSubtitle.textContent = 'All queued messages processed';
        } else {
          lcQueueSubtitle.textContent = 'Send anytime while agent works';
        }
      }

      if (lcQueueStateBadge) {
        lcQueueStateBadge.className = 'lc-queue-state-pill state-' + (snap.state || 'idle');
        lcQueueStateBadge.textContent = lcQueueStateLabel(snap.state || 'idle');
      }

      if (lcQueueChevron) {
        lcQueueChevron.innerHTML = lcIcon(lcQueueExpanded ? 'chevron-down' : 'chevron-right', 13);
      }
      if (lcQueueBody && lcQueueBody.classList) {
        lcQueueBody.classList.toggle('open', !!lcQueueExpanded);
      }

      if (btnQueuePauseResume) {
        var showPause = totalVisible > 0 || snap.isBusy || canResume;
        btnQueuePauseResume.style.display = showPause ? 'inline-flex' : 'none';
        if (canResume) {
          btnQueuePauseResume.innerHTML = lcIcon('play', 11) + '<span>Resume</span>';
          btnQueuePauseResume.title = failedCount > 0
            ? 'Retry failed message and resume queue execution'
            : 'Resume queue execution';
        } else {
          btnQueuePauseResume.innerHTML = lcIcon('pause', 11) + '<span>Pause</span>';
          btnQueuePauseResume.title = 'Pause queue advancement';
        }
      }

      if (btnQueueClear) {
        var showClear = pendingCount > 0 || failedCount > 0;
        btnQueueClear.style.display = showClear ? 'inline-flex' : 'none';
      }

      if (lcQueueBanner) {
        if (snap.lastError) {
          lcQueueBanner.style.display = 'flex';
          lcQueueBanner.className = 'lc-queue-banner' + (failedCount > 0 || snap.state === 'failed' ? ' error' : '');
          lcQueueBanner.innerHTML =
            '<span class="lc-icon-gap">' + lcIcon('triangle-alert', 12) + '<span>' + lcQueueEscape(snap.lastError) + '</span></span>' +
            (canResume ? '<button type="button" class="lc-queue-hdr-btn" id="btnBannerResume">' + lcIcon('play', 10) + '<span>Resume</span></button>' : '');
          var bannerBtn = document.getElementById('btnBannerResume');
          if (bannerBtn) {
            bannerBtn.addEventListener('click', function() {
              vscode.postMessage({ command: 'queueAction', action: 'resume' });
            });
          }
        } else {
          lcQueueBanner.style.display = 'none';
          lcQueueBanner.innerHTML = '';
        }
      }

      if (lcQueueEmpty) {
        lcQueueEmpty.style.display = totalVisible === 0 ? 'block' : 'none';
      }

      if (!lcQueueList) return;
      lcQueueList.innerHTML = '';
      var queuedOnly = items.filter(function(i) { return i.status === 'queued'; });

      items.forEach(function(item) {
        var row = document.createElement('div');
        row.className = 'lc-queue-item status-' + (item.status || 'queued');
        row.setAttribute('data-queue-id', item.id);

        var qIdx = item.status === 'queued'
          ? queuedOnly.findIndex(function(q) { return q.id === item.id; })
          : -1;
        var posLabel = item.status === 'processing'
          ? '>'
          : (qIdx >= 0 ? (qIdx + 1) + '.' : '!');

        var html = '<div class="lc-queue-item-top">' +
          '<div class="lc-queue-item-main">' +
            '<span class="lc-queue-pos">' + lcQueueEscape(posLabel) + '</span>';

        if (lcQueueEditingId === item.id) {
          html += '<div class="lc-queue-preview" style="display:none;">' + lcQueueEscape(item.content) + '</div>';
        } else {
          html += '<div class="lc-queue-preview">' + lcQueueEscape(item.content) + '</div>';
        }

        html += '</div><div class="lc-queue-actions">';

        if (item.status === 'processing') {
          html += '<span class="lc-queue-badge status-processing">Processing</span>' +
            '<button type="button" class="lc-queue-act-btn delete" data-q-act="stopActive" title="Stop current task">' + lcIcon('square', 10) + '</button>';
        } else if (item.status === 'failed') {
          html +=
            '<button type="button" class="lc-queue-act-btn" data-q-act="retry" title="Retry this message">' + lcIcon('rotate-ccw', 11) + '</button>' +
            '<button type="button" class="lc-queue-act-btn" data-q-act="edit" title="Edit before retry">' + lcIcon('pencil', 11) + '</button>' +
            '<button type="button" class="lc-queue-act-btn" data-q-act="skip" title="Skip and continue remaining queue">' + lcIcon('skip-forward', 11) + '</button>' +
            '<button type="button" class="lc-queue-act-btn delete" data-q-act="delete" title="Delete message">' + lcIcon('trash-2', 11) + '</button>';
        } else {
          var isFirst = qIdx <= 0;
          var isLast = qIdx === -1 || qIdx >= queuedOnly.length - 1;
          html +=
            '<button type="button" class="lc-queue-act-btn" data-q-act="sendNow" title="' + (snap.isBusy ? 'Send next (prioritize right after current task finishes)' : 'Send now') + '">' + lcIcon('play', 11) + '</button>' +
            '<button type="button" class="lc-queue-act-btn" data-q-act="edit" title="Edit queued message">' + lcIcon('pencil', 11) + '</button>' +
            '<button type="button" class="lc-queue-act-btn" data-q-act="moveUp" ' + (isFirst ? 'disabled ' : '') + 'title="Move up">' + lcIcon('chevron-up', 12) + '</button>' +
            '<button type="button" class="lc-queue-act-btn" data-q-act="moveDown" ' + (isLast ? 'disabled ' : '') + 'title="Move down">' + lcIcon('chevron-down', 12) + '</button>' +
            '<button type="button" class="lc-queue-act-btn delete" data-q-act="delete" title="Delete queued message">' + lcIcon('trash-2', 11) + '</button>';
        }

        html += '</div></div>';

        if (lcQueueEditingId === item.id) {
          html += '<div class="lc-queue-edit-box">' +
            '<textarea class="lc-queue-edit-input" data-q-edit-input="' + lcQueueEscape(item.id) + '">' + lcQueueEscape(item.content) + '</textarea>' +
            '<div class="lc-queue-edit-btns">' +
              '<button type="button" class="lc-queue-hdr-btn" data-q-act="cancelEdit">Cancel</button>' +
              '<button type="button" class="lc-queue-hdr-btn" data-q-act="saveEdit">Save</button>' +
            '</div>' +
          '</div>';
        }

        var metaBits = [];
        metaBits.push('<span class="lc-queue-badge status-' + lcQueueEscape(item.status) + '">' + lcQueueEscape(item.interruptedOnRestart ? 'restored' : item.status) + '</span>');
        if (item.createdAt) {
          metaBits.push('<span>' + lcQueueEscape(lcQueueFormatTime(item.createdAt)) + '</span>');
        }
        if (item.kind === 'slash_command') {
          metaBits.push('<span class="lc-queue-att-chip">' + lcIcon('terminal', 10) + '<span>Command</span></span>');
        }
        if (Array.isArray(item.attachments)) {
          item.attachments.forEach(function(att) {
            var ico = att.type === 'folder' ? 'folder' : att.type === 'git' ? 'git-branch' : att.type === 'terminal' ? 'terminal' : 'file-text';
            metaBits.push('<span class="lc-queue-att-chip">' + lcIcon(ico, 10) + '<span>' + lcQueueEscape(att.label || att.path) + '</span></span>');
          });
        }
        html += '<div class="lc-queue-item-meta">' + metaBits.join('') + '</div>';

        if (item.error) {
          html += '<div class="lc-queue-item-err">' + lcQueueEscape(item.error) + '</div>';
        }

        row.innerHTML = html;

        row.querySelectorAll('[data-q-act]').forEach(function(btn) {
          btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var act = btn.getAttribute('data-q-act');
            if (act === 'edit') {
              lcQueueEditingId = item.id;
              lcRenderQueuePanel();
              var inp = row.querySelector('[data-q-edit-input="' + item.id + '"]');
              if (inp && typeof inp.focus === 'function') inp.focus();
            } else if (act === 'cancelEdit') {
              lcQueueEditingId = null;
              lcRenderQueuePanel();
            } else if (act === 'saveEdit') {
              var editEl = row.querySelector('[data-q-edit-input="' + item.id + '"]');
              var val = editEl ? String(editEl.value || '').trim() : item.content;
              if (!val) return;
              lcQueueEditingId = null;
              vscode.postMessage({ command: 'queueAction', action: 'edit', itemId: item.id, content: val });
            } else {
              vscode.postMessage({ command: 'queueAction', action: act, itemId: item.id });
            }
          });
        });

        lcQueueList.appendChild(row);
      });
    }

    function lcSetQueueSnapshot(snapshot) {
      if (!snapshot) return;
      lcQueueSnapshot = snapshot;
      lcRenderQueuePanel();
    }

    function lcGetQueueSnapshot() {
      return lcQueueSnapshot;
    }

    if (lcQueueToggleBtn) {
      lcQueueToggleBtn.addEventListener('click', function() {
        lcQueueUserToggled = true;
        lcQueueExpanded = !lcQueueExpanded;
        lcRenderQueuePanel();
      });
    }

    if (btnQueuePauseResume) {
      btnQueuePauseResume.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({
          command: 'queueAction',
          action: lcCanResumeSnapshot(lcQueueSnapshot) ? 'resume' : 'pause'
        });
      });
    }

    if (btnQueueClear) {
      btnQueueClear.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({ command: 'runSlashCommand', text: '/queue clear' });
      });
    }
  `;
}
