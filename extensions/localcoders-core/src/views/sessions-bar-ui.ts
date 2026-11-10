/**
 * Shared minimalist Sessions / Sections Sidebar UI styles, markup helpers, and client utilities.
 * Matches the clean monochrome hierarchy: `Sessions` header (+, filter, ...), collapsible `Recent`
 * section, dot/chevron left gutter, 2-line title + node/timestamp meta row, and matte active pill.
 */

import * as os from 'os';

function escapeProfileHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function getDeviceUsername(): string {
  let detected = '';
  try {
    detected = os.userInfo()?.username || '';
  } catch {
    detected = '';
  }
  const resolved = (detected || process.env.USER || process.env.USERNAME || 'user').trim();
  return resolved || 'user';
}

export function getUserProfileBadgeMarkup(username?: string): string {
  const rawName = (username !== undefined ? username : getDeviceUsername()).trim() || 'user';
  const safeName = escapeProfileHtml(rawName);
  const firstChar = Array.from(rawName)[0] || 'U';
  const safeInitial = escapeProfileHtml(firstChar.toUpperCase());
  return `<span class="lc-user-badge" title="${safeName}"><span class="lc-user-avatar" aria-hidden="true">${safeInitial}</span><span class="lc-user-name">${safeName}</span></span>`;
}

export function getSessionsBarStyles(): string {
  return `
    /* Logged-in OS User Sidebar Profile Badge */
    .lc-user-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1;
    }
    .lc-user-avatar {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--fg, #e4e4e7) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--fg, #e4e4e7) 20%, transparent);
      color: var(--fg, #f4f4f5);
      font-size: 10.5px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      user-select: none;
    }
    .lc-user-name {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--fg, #e4e4e7);
      letter-spacing: 0.01em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Minimalist Sessions Bar Header */
    .lc-sessions-header {
      padding: 10px 12px 6px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-shrink: 0;
    }
    .lc-sessions-heading {
      font-size: 13px;
      font-weight: 500;
      color: var(--fg, #e4e4e7);
      letter-spacing: -0.01em;
      user-select: none;
    }
    .lc-sessions-hdr-actions {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      position: relative;
    }
    .lc-sess-hdr-btn {
      width: 24px;
      height: 24px;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--text-muted, #9ca3af);
      border-radius: 5px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .lc-sess-hdr-btn:hover,
    .lc-sess-hdr-btn.active {
      background: color-mix(in srgb, var(--fg, #ffffff) 8%, transparent);
      color: var(--fg, #f4f4f5);
    }

    /* Collapsible Search & Filter Panel (hidden until Sliders toggled) */
    .lc-sessions-filter-bar {
      display: none;
      flex-direction: column;
      gap: 6px;
      padding: 2px 12px 8px 12px;
      flex-shrink: 0;
    }
    .lc-sessions-filter-bar.open {
      display: flex;
    }
    .lc-sessions-search-wrap {
      position: relative;
      display: flex;
      align-items: center;
    }
    .lc-sessions-search-ico {
      position: absolute;
      left: 8px;
      color: var(--text-muted, #71717a);
      pointer-events: none;
      display: inline-flex;
    }
    .lc-sessions-filter-input {
      width: 100%;
      height: 27px;
      background: rgba(0, 0, 0, 0.28);
      border: 1px solid var(--border, rgba(161, 161, 170, 0.16));
      border-radius: 6px;
      color: var(--fg, #e4e4e7);
      padding: 0 8px 0 26px;
      font-size: 11.5px;
      font-family: inherit;
      outline: none;
      box-sizing: border-box;
    }
    .lc-sessions-filter-input:focus {
      border-color: color-mix(in srgb, var(--fg, #e4e4e7) 35%, transparent);
    }
    .lc-sessions-filter-pills {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
    }
    .lc-sess-filter-pill {
      font-size: 10.5px;
      padding: 2px 7px;
      border-radius: 5px;
      border: 1px solid var(--border, rgba(161, 161, 170, 0.16));
      background: transparent;
      color: var(--text-muted, #9ca3af);
      cursor: pointer;
      font-family: inherit;
    }
    .lc-sess-filter-pill:hover {
      color: var(--fg, #f4f4f5);
      background: rgba(255, 255, 255, 0.04);
    }
    .lc-sess-filter-pill.active {
      color: var(--fg, #f4f4f5);
      background: rgba(255, 255, 255, 0.09);
      border-color: color-mix(in srgb, var(--fg, #e4e4e7) 26%, transparent);
    }

    /* Compact '...' Dropdown Menu */
    .lc-sessions-menu {
      display: none;
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      min-width: 176px;
      background: var(--vscode-menu-background, #18191e);
      border: 1px solid var(--vscode-widget-border, rgba(148, 163, 184, 0.22));
      border-radius: 8px;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.52);
      padding: 4px;
      z-index: 80;
      flex-direction: column;
      gap: 1px;
    }
    .lc-sessions-menu.open {
      display: flex;
    }
    .lc-sessions-menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border: none;
      background: transparent;
      color: var(--fg, #e4e4e7);
      font-size: 11.5px;
      font-family: inherit;
      text-align: left;
      border-radius: 5px;
      cursor: pointer;
      width: 100%;
    }
    .lc-sessions-menu-item:hover {
      background: rgba(255, 255, 255, 0.07);
    }
    .lc-sessions-menu-item.danger:hover {
      background: rgba(239, 68, 68, 0.14);
      color: #fca5a5;
    }
    .lc-sessions-menu-sep {
      height: 1px;
      background: var(--border, rgba(161, 161, 170, 0.14));
      margin: 3px 4px;
    }

    /* Recent Sub-header */
    .lc-recent-subheader {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px 6px 14px;
      background: transparent;
      border: none;
      color: var(--text-muted, #9ca3af);
      font-size: 12px;
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      width: 100%;
      text-align: left;
      flex-shrink: 0;
    }
    .lc-recent-subheader:hover {
      color: var(--fg, #e4e4e7);
    }

    /* Scrollable Sessions List */
    .lc-sessions-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 2px 8px 14px 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .lc-sess-group-header {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      padding: 7px 10px 7px 6px;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.12s ease;
      user-select: none;
    }
    .lc-sess-group-header:hover {
      background: rgba(255, 255, 255, 0.04);
    }
    .lc-sess-group-children {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .lc-sess-group-children.collapsed {
      display: none;
    }

    /* Individual Session Row */
    .lc-sess-row {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      padding: 7px 10px 7px 6px;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.12s ease;
      position: relative;
      border: 1px solid transparent;
    }
    .lc-sess-row.child {
      padding-left: 24px;
    }
    .lc-sess-row:hover {
      background: rgba(255, 255, 255, 0.045);
    }
    .lc-sess-row.active {
      background: color-mix(in srgb, var(--fg, #ffffff) 7%, transparent);
    }
    .lc-sess-gutter {
      width: 16px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: var(--text-muted, #71717a);
    }
    .lc-sess-dot {
      width: 3.5px;
      height: 3.5px;
      border-radius: 50%;
      background: currentColor;
      opacity: 0.72;
      transition: transform 0.12s ease, opacity 0.12s ease, background 0.12s ease;
    }
    .lc-sess-row.active .lc-sess-dot {
      opacity: 0.95;
      color: var(--fg, #e4e4e7);
    }
    .lc-sess-dot.running {
      width: 5px;
      height: 5px;
      background: #4ade80;
      opacity: 1;
    }
    .lc-sess-main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .lc-sess-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      min-width: 0;
    }
    .lc-sess-name {
      flex: 1;
      min-width: 0;
      font-size: 12.8px;
      font-weight: 400;
      line-height: 1.35;
      color: var(--fg, #d4d4d8);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .lc-sess-row.active .lc-sess-name {
      color: var(--fg, #f4f4f5);
      font-weight: 500;
    }
    .lc-sess-row-actions {
      display: none;
      align-items: center;
      gap: 2px;
      flex-shrink: 0;
    }
    .lc-sess-row:hover .lc-sess-row-actions,
    .lc-sess-row:focus-within .lc-sess-row-actions,
    .lc-sess-row.confirming .lc-sess-row-actions {
      display: inline-flex;
    }
    .lc-sess-meta {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 11.2px;
      line-height: 1.25;
      color: var(--text-muted, #8b8f98);
      min-width: 0;
    }
    .lc-sess-time {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .lc-sess-empty {
      padding: 16px 12px;
      font-size: 11.5px;
      color: var(--text-muted, #8b8f98);
      text-align: center;
    }
    .session-act-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-muted, #8b8f98);
      border-radius: 4px;
      padding: 2px;
      width: 20px;
      height: 20px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .session-act-btn:hover {
      color: var(--fg, #f4f4f5);
      background: rgba(255, 255, 255, 0.08);
    }
    .session-act-btn.btn-delete-session:hover {
      color: #f87171;
      background: rgba(248, 113, 113, 0.14);
    }
    .session-confirm-btn {
      background: rgba(239, 68, 68, 0.18);
      border: 1px solid rgba(248, 113, 113, 0.4);
      color: #fca5a5;
      border-radius: 4px;
      padding: 1px 6px;
      font-size: 10.5px;
      font-weight: 600;
      cursor: pointer;
    }
    .session-confirm-btn:hover {
      background: rgba(239, 68, 68, 0.32);
      color: #ffffff;
    }
    .session-rename-input {
      width: 100%;
      flex: 1;
      min-width: 0;
      background: #090b10;
      border: 1px solid #38bdf8;
      border-radius: 4px;
      color: var(--fg, #e4e4e7);
      font-size: 12.5px;
      font-family: inherit;
      padding: 2px 6px;
      outline: none;
    }
  `;
}

export function getSessionsBarClientScript(): string {
  return `
    function lcFormatSessionTimeAgo(ts) {
      if (!ts) return 'Just now';
      var diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (diffSec < 60) return 'Just now';
      var mins = Math.floor(diffSec / 60);
      if (mins < 60) return mins + (mins === 1 ? ' min ago' : ' mins ago');
      var hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
      var days = Math.floor(hrs / 24);
      return days + (days === 1 ? ' day ago' : ' days ago');
    }
  `;
}
