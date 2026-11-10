import { lucideSvg } from './lucide-icons';

/**
 * Shared CSS & Client Rendering Helpers for Safe Agent Status, Structured Execution Activity Cards,
 * Streaming Assistant Responses, and Multi-Tab Interactive Terminal UI across Agent View & Chat View.
 */
export function getActivityStreamStyles(): string {
  return `
    /* Safe Live Phase Indicator (Conversation) */
    .lc-live-status-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 12px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-editor-foreground, #e2e8f0) 4%, transparent);
      border: 1px solid var(--vscode-widget-border, rgba(148, 163, 184, 0.2));
      color: var(--vscode-descriptionForeground, #94a3b8);
      font-size: 12px;
      margin: 4px 0;
      width: 100%;
    }
    .lc-status-pulse {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #38bdf8;
      flex-shrink: 0;
      animation: lcPulseDot 1.4s ease-in-out infinite;
    }
    .lc-status-dot-static {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .lc-status-dot-static.completed { background: #22c55e; }
    .lc-status-dot-static.failed { background: #ef4444; }
    .lc-status-dot-static.cancelled { background: #f59e0b; }
    @keyframes lcPulseDot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.8); }
    }
    @media (prefers-reduced-motion: reduce) {
      .lc-status-pulse { animation: none; }
    }
    .lc-live-status-text {
      font-weight: 500;
      color: var(--vscode-editor-foreground, #e2e8f0);
    }
    .lc-turn-summary-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 5px 10px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-editor-foreground, #e2e8f0) 4%, transparent);
      border: 1px solid var(--vscode-widget-border, rgba(148, 163, 184, 0.2));
      color: var(--vscode-descriptionForeground, #94a3b8);
      font-size: 11.5px;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
      align-self: flex-start;
    }
    .lc-turn-summary-pill:hover {
      background: color-mix(in srgb, var(--vscode-editor-foreground, #e2e8f0) 8%, transparent);
      color: var(--vscode-editor-foreground, #f8fafc);
    }

    /* Inline Collapsible Thinking / Command Trace Block (Main Conversation) */
    .lc-thinking-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 2px 0 4px 0;
      width: 100%;
    }
    .lc-thinking-trigger {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 6px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--vscode-descriptionForeground, #94a3b8);
      font-size: 12px;
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      align-self: flex-start;
      max-width: 100%;
      transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
    }
    .lc-thinking-trigger:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(255, 255, 255, 0.08);
      color: var(--vscode-editor-foreground, #f1f5f9);
    }
    .lc-thinking-label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .lc-thinking-chev {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      opacity: 0.7;
      transition: transform 0.15s ease;
      flex-shrink: 0;
    }
    .lc-thinking-group.expanded .lc-thinking-chev {
      transform: rotate(90deg);
    }
    .lc-thinking-drawer {
      display: none;
      flex-direction: column;
      gap: 4px;
      padding: 4px 0 4px 12px;
      margin-left: 8px;
      border-left: 1px solid rgba(148, 163, 184, 0.22);
    }
    .lc-thinking-group.expanded .lc-thinking-drawer {
      display: flex;
    }
    .lc-thinking-drawer .lc-activity-card {
      border: none;
      border-radius: 5px;
      background: transparent;
    }
    .lc-thinking-drawer .lc-activity-header {
      padding: 4px 6px;
    }
    .lc-thinking-drawer .lc-activity-header:hover {
      background: rgba(255, 255, 255, 0.04);
      border-radius: 5px;
    }

    /* Collapsible Structured Execution Activity Card */
    .lc-activity-card {
      border: 1px solid var(--vscode-widget-border, rgba(148, 163, 184, 0.2));
      border-radius: 7px;
      background: color-mix(in srgb, var(--vscode-sideBar-background, #18181b) 82%, transparent);
      overflow: hidden;
      transition: border-color 0.15s ease;
    }
    .lc-activity-card:hover {
      border-color: color-mix(in srgb, var(--vscode-textLink-foreground, #38bdf8) 40%, var(--vscode-widget-border, #334155));
    }
    .lc-activity-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 10px;
      cursor: pointer;
      user-select: none;
    }
    .lc-activity-left {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      min-width: 0;
      flex: 1;
    }
    .lc-activity-cat-icon {
      margin-top: 2px;
      color: var(--vscode-textLink-foreground, #38bdf8);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .lc-activity-card.status-failed .lc-activity-cat-icon { color: #ef4444; }
    .lc-activity-card.status-cancelled .lc-activity-cat-icon { color: #f59e0b; }
    .lc-activity-card.status-completed .lc-activity-cat-icon { color: #22c55e; }
    .lc-activity-headings {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      flex: 1;
    }
    .lc-activity-title-line {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-editor-foreground, #f1f5f9);
      line-height: 1.3;
    }
    .lc-activity-agent {
      color: var(--vscode-editor-foreground, #f8fafc);
    }
    .lc-activity-sep {
      color: var(--vscode-descriptionForeground, #64748b);
    }
    .lc-activity-summary-line {
      font-family: var(--vscode-editor-font-family, "JetBrains Mono", monospace);
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #94a3b8);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .lc-activity-subline {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 10.5px;
      color: var(--vscode-descriptionForeground, #94a3b8);
      margin-top: 2px;
    }
    .lc-activity-right {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .lc-act-status-pill {
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 4px;
      text-transform: capitalize;
    }
    .lc-act-status-pill.running {
      background: rgba(56, 189, 248, 0.16);
      color: #38bdf8;
    }
    .lc-act-status-pill.completed {
      background: rgba(34, 197, 94, 0.14);
      color: #22c55e;
    }
    .lc-act-status-pill.failed {
      background: rgba(239, 68, 68, 0.16);
      color: #ef4444;
    }
    .lc-act-status-pill.cancelled {
      background: rgba(245, 158, 11, 0.16);
      color: #f59e0b;
    }
    .lc-act-status-pill.waiting_approval {
      background: rgba(245, 158, 11, 0.16);
      color: #f59e0b;
    }
    .lc-act-dur {
      font-size: 10.5px;
      color: var(--vscode-descriptionForeground, #64748b);
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .lc-act-chevron {
      color: var(--vscode-descriptionForeground, #64748b);
      display: inline-flex;
      align-items: center;
      transition: transform 0.15s ease;
    }
    .lc-activity-card.expanded .lc-act-chevron {
      transform: rotate(90deg);
    }
    .lc-activity-details {
      display: none;
      border-top: 1px solid var(--vscode-widget-border, rgba(148, 163, 184, 0.15));
      padding: 8px 10px;
      background: color-mix(in srgb, var(--vscode-editor-background, #0f172a) 90%, transparent);
      font-size: 11px;
      flex-direction: column;
      gap: 6px;
    }
    .lc-activity-card.expanded .lc-activity-details {
      display: flex;
    }
    .lc-act-detail-kv {
      display: flex;
      gap: 8px;
      color: var(--vscode-descriptionForeground, #94a3b8);
      font-size: 10.5px;
      flex-wrap: wrap;
    }
    .lc-act-detail-kv code {
      font-family: var(--vscode-editor-font-family, "JetBrains Mono", monospace);
      color: var(--vscode-editor-foreground, #e2e8f0);
      background: rgba(148, 163, 184, 0.12);
      padding: 1px 5px;
      border-radius: 3px;
      word-break: break-all;
    }
    .lc-terminal-pre {
      margin: 0;
      padding: 8px 10px;
      border-radius: 5px;
      background: color-mix(in srgb, var(--vscode-editor-background, #090d16) 94%, #000 6%);
      border: 1px solid var(--vscode-widget-border, rgba(148, 163, 184, 0.16));
      color: var(--vscode-editor-foreground, #e2e8f0);
      font-family: var(--vscode-editor-font-family, "JetBrains Mono", monospace);
      font-size: 11px;
      line-height: 1.45;
      max-height: 260px;
      overflow: auto;
      overscroll-behavior: contain;
      overflow-anchor: none;
      scrollbar-gutter: stable;
      scrollbar-width: thin;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .lc-terminal-pre::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    .lc-terminal-pre::-webkit-scrollbar-thumb {
      background: rgba(148, 163, 184, 0.28);
      border-radius: 999px;
    }
    .lc-terminal-pre::-webkit-scrollbar-thumb:hover {
      background: rgba(148, 163, 184, 0.48);
    }
    .lc-terminal-pre.is-stderr {
      border-color: rgba(239, 68, 68, 0.35);
      color: #fca5a5;
    }

    /* Right Inspector Dock Tabs & Separate Panels (Activity | Terminal | Changes) */
    .lc-inspector-dock {
      width: 410px;
      min-width: 300px;
      max-width: 560px;
      background: var(--vscode-sideBar-background, #18181b);
      border-left: 1px solid var(--vscode-widget-border, #27272a);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      overflow: hidden;
      transition: width 0.2s ease, opacity 0.2s ease;
    }
    .lc-inspector-dock.hidden {
      width: 0;
      min-width: 0;
      border-left: none;
      opacity: 0;
      pointer-events: none;
    }
    .lc-inspector-tabs {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-widget-border, #27272a);
      background: color-mix(in srgb, var(--vscode-editor-background, #0f172a) 45%, transparent);
    }
    .lc-inspector-tab {
      flex: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 6px 8px;
      border-radius: 5px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--vscode-descriptionForeground, #94a3b8);
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    }
    .lc-inspector-tab:hover {
      color: var(--vscode-editor-foreground, #f8fafc);
      background: rgba(148, 163, 184, 0.1);
    }
    .lc-inspector-tab.active {
      background: color-mix(in srgb, var(--vscode-textLink-foreground, #38bdf8) 14%, transparent);
      border-color: color-mix(in srgb, var(--vscode-textLink-foreground, #38bdf8) 38%, transparent);
      color: var(--vscode-textLink-foreground, #38bdf8);
    }
    .lc-tab-count {
      font-size: 10px;
      font-weight: 700;
      padding: 0 5px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.18);
      color: var(--vscode-editor-foreground, #e2e8f0);
    }
    .lc-inspector-pane {
      flex: 1;
      display: none;
      flex-direction: column;
      overflow: hidden;
    }
    .lc-inspector-pane.active {
      display: flex;
    }
    .lc-activity-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-widget-border, #27272a);
      flex-wrap: wrap;
    }
    .lc-filter-row {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
    }
    .lc-filter-btn {
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--vscode-descriptionForeground, #94a3b8);
      font-size: 10.5px;
      font-weight: 600;
      cursor: pointer;
    }
    .lc-filter-btn.active {
      background: rgba(56, 189, 248, 0.15);
      border-color: rgba(56, 189, 248, 0.35);
      color: #38bdf8;
    }
    .lc-activity-feed {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .lc-empty-pane {
      padding: 24px 14px;
      text-align: center;
      color: var(--vscode-descriptionForeground, #64748b);
      font-size: 12px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }

    /* Interactive Multi-Tab Terminal Pane */
    .lc-term-tabs-bar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-widget-border, #27272a);
      overflow-x: auto;
    }
    .lc-term-tab {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      border-radius: 4px;
      border: 1px solid transparent;
      background: rgba(148, 163, 184, 0.08);
      color: var(--vscode-descriptionForeground, #94a3b8);
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
    }
    .lc-term-tab.active {
      background: rgba(56, 189, 248, 0.15);
      border-color: rgba(56, 189, 248, 0.35);
      color: var(--vscode-editor-foreground, #f8fafc);
      font-weight: 600;
    }
    .lc-term-tab-close {
      display: inline-flex;
      align-items: center;
      opacity: 0.65;
    }
    .lc-term-tab-close:hover { opacity: 1; color: #ef4444; }
    .lc-term-meta-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-widget-border, #27272a);
      font-size: 10.5px;
      color: var(--vscode-descriptionForeground, #94a3b8);
    }
    .lc-term-cwd {
      font-family: var(--vscode-editor-font-family, monospace);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .lc-term-controls {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .lc-term-output {
      flex: 1;
      overflow-y: auto;
      padding: 8px 10px;
      background: color-mix(in srgb, var(--vscode-editor-background, #090d16) 95%, #000 5%);
      font-family: var(--vscode-editor-font-family, "JetBrains Mono", monospace);
      font-size: 11.5px;
      line-height: 1.45;
    }
    .lc-term-line {
      white-space: pre-wrap;
      word-break: break-word;
      padding: 1px 0;
    }
    .lc-term-line.stdout { color: var(--vscode-editor-foreground, #e2e8f0); }
    .lc-term-line.stderr { color: #f87171; }
    .lc-term-line.system { color: #38bdf8; }
    .lc-term-input-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 10px;
      border-top: 1px solid var(--vscode-widget-border, #27272a);
      background: var(--vscode-input-background, #141414);
    }
    .lc-term-prompt-sym {
      font-family: var(--vscode-editor-font-family, monospace);
      color: #22c55e;
      font-weight: 700;
      font-size: 12px;
    }
    .lc-term-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: var(--vscode-editor-foreground, #f8fafc);
      font-family: var(--vscode-editor-font-family, "JetBrains Mono", monospace);
      font-size: 12px;
    }
    .lc-plan-checklist-mini {
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-widget-border, #27272a);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .lc-plan-mini-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-size: 11px;
      color: var(--vscode-editor-foreground, #cbd5e1);
    }
    .lc-plan-mini-item.completed {
      color: var(--vscode-descriptionForeground, #64748b);
      text-decoration: line-through;
    }

    /* Rendered Rich Markdown Inside Assistant Messages */
    .lc-md-h {
      font-weight: 650;
      color: var(--vscode-editor-foreground, #f8fafc);
      line-height: 1.35;
      margin: 10px 0 4px 0;
    }
    .lc-md-h:first-child { margin-top: 0; }
    .lc-md-h1 { font-size: 16px; }
    .lc-md-h2 { font-size: 14.5px; }
    .lc-md-h3 { font-size: 13.5px; }
    .lc-md-h4 { font-size: 12.5px; color: var(--vscode-descriptionForeground, #cbd5e1); }
    .lc-md-p {
      margin: 0 0 8px 0;
      line-height: 1.6;
    }
    .lc-md-p:last-child { margin-bottom: 0; }
    .lc-md-list {
      margin: 4px 0 8px 18px;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .lc-md-list:last-child { margin-bottom: 0; }
    .lc-md-list li { line-height: 1.55; }
    .lc-md-quote {
      border-left: 3px solid var(--vscode-textLink-foreground, #60a5fa);
      padding: 4px 10px;
      margin: 6px 0;
      color: var(--vscode-descriptionForeground, #cbd5e1);
      background: color-mix(in srgb, var(--vscode-editor-foreground, #e2e8f0) 4%, transparent);
      border-radius: 0 6px 6px 0;
    }
    .lc-md-hr {
      border: none;
      border-top: 1px solid var(--vscode-widget-border, rgba(148, 163, 184, 0.2));
      margin: 10px 0;
    }
    .lc-md-pre {
      background: #09090b;
      border: 1px solid var(--vscode-widget-border, rgba(148, 163, 184, 0.22));
      border-radius: 8px;
      margin: 8px 0;
      overflow: hidden;
    }
    .lc-md-lang {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--vscode-descriptionForeground, #94a3b8);
      padding: 4px 12px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.14);
      background: rgba(255, 255, 255, 0.02);
    }
    .lc-md-pre code {
      display: block;
      padding: 10px 12px;
      overflow-x: auto;
      background: transparent !important;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre;
    }
    .lc-md-inline {
      background: rgba(255, 255, 255, 0.08);
      padding: 1px 5px;
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }
    .lc-md-link {
      color: var(--vscode-textLink-foreground, #60a5fa);
      text-decoration: underline;
    }

    /* Readable Agent Thought Entries inside Thinking Drawer */
    .lc-thought-entry {
      border-left: 2px solid color-mix(in srgb, var(--vscode-textLink-foreground, #60a5fa) 55%, transparent);
      background: color-mix(in srgb, var(--vscode-editor-foreground, #e2e8f0) 3%, transparent);
      border-radius: 0 6px 6px 0;
      padding: 6px 10px;
      margin: 2px 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-height: 0;
    }
    .lc-thought-entry.running {
      border-left-color: #38bdf8;
    }
    .lc-thought-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground, #94a3b8);
    }
    .lc-thought-meta-right {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .lc-thought-expand-btn {
      background: transparent;
      border: 1px solid rgba(148, 163, 184, 0.22);
      border-radius: 4px;
      color: var(--vscode-descriptionForeground, #94a3b8);
      font-size: 10px;
      font-weight: 500;
      font-family: inherit;
      padding: 1px 6px;
      cursor: pointer;
      line-height: 1.35;
      transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
    }
    .lc-thought-expand-btn:hover {
      background: rgba(148, 163, 184, 0.12);
      border-color: rgba(148, 163, 184, 0.4);
      color: var(--vscode-editor-foreground, #f8fafc);
    }
    .lc-thought-agent {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--vscode-editor-foreground, #e2e8f0);
    }
    .lc-thought-role {
      font-weight: 400;
      color: var(--vscode-descriptionForeground, #94a3b8);
    }
    .lc-thought-body {
      font-size: 12px;
      line-height: 1.55;
      color: var(--vscode-descriptionForeground, #cbd5e1);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 340px;
      overflow-y: auto;
      overscroll-behavior: contain;
      overflow-anchor: none;
      scrollbar-gutter: stable;
      scrollbar-width: thin;
      padding-right: 4px;
    }
    .lc-thought-body.is-expanded {
      max-height: none;
      overflow-y: visible;
    }
    .lc-thought-body::-webkit-scrollbar {
      width: 6px;
    }
    .lc-thought-body::-webkit-scrollbar-thumb {
      background: rgba(148, 163, 184, 0.28);
      border-radius: 999px;
    }
    .lc-thought-body::-webkit-scrollbar-thumb:hover {
      background: rgba(148, 163, 184, 0.48);
    }
  `;
}

export function getActivityClientScript(): string {
  return `
    function lcEscapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function lcFormatDuration(ms) {
      if (!ms || ms <= 0) return '0s';
      if (ms < 1000) return ms + 'ms';
      var sec = (ms / 1000);
      if (sec < 60) return (sec < 10 ? sec.toFixed(1) : Math.floor(sec)) + 's';
      var min = Math.floor(sec / 60);
      var rem = Math.floor(sec % 60);
      return min + 'm ' + rem + 's';
    }

    function lcCategoryIconName(cat) {
      if (cat === 'command') return 'terminal';
      if (cat === 'file') return 'file-code';
      if (cat === 'mcp') return 'plug';
      if (cat === 'browser') return 'globe';
      if (cat === 'subagent') return 'users';
      return 'wrench';
    }

    function lcStatusLabel(status) {
      if (status === 'running') return 'Running';
      if (status === 'completed') return 'Completed';
      if (status === 'failed') return 'Failed';
      if (status === 'cancelled') return 'Cancelled';
      if (status === 'waiting_approval') return 'Approval';
      return status || 'Completed';
    }

    function lcUpsertActivityList(list, incoming) {
      var next = Array.isArray(list) ? list.slice() : [];
      var idx = -1;
      for (var i = 0; i < next.length; i++) {
        if (next[i] && next[i].id === incoming.id) { idx = i; break; }
      }
      if (idx !== -1) {
        next[idx] = Object.assign({}, next[idx], incoming);
      } else {
        next.push(incoming);
        if (next.length > 300) next.shift();
      }
      return next;
    }

    function lcFindChildByAttr(root, attrName, attrVal) {
      if (!root || !attrVal || typeof root.querySelectorAll !== 'function') return null;
      var nodes = root.querySelectorAll('[' + attrName + ']');
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i] && nodes[i].getAttribute(attrName) === attrVal) {
          return nodes[i];
        }
      }
      return null;
    }

    function lcApplyTextPreservingScroll(el, nextText) {
      if (!el) return;
      var str = (nextText === null || nextText === undefined) ? '' : String(nextText);
      var prev = el.textContent || '';
      if (prev === str) return;

      var prevTop = Number(el.scrollTop || 0);
      var prevH = Number(el.scrollHeight || 0);
      var prevC = Number(el.clientHeight || 0);
      var wasAtBottom = prevTop > 0 && (prevH - prevTop - prevC) <= 24;

      if (prev.length > 0 && str.indexOf(prev) === 0 && typeof document !== 'undefined' && typeof document.createTextNode === 'function') {
        var delta = str.slice(prev.length);
        if (el.lastChild && el.lastChild.nodeType === 3 && typeof el.lastChild.appendData === 'function') {
          el.lastChild.appendData(delta);
        } else {
          el.appendChild(document.createTextNode(delta));
        }
      } else {
        el.textContent = str;
      }

      if (wasAtBottom) {
        var nextTop = Math.max(0, Number(el.scrollHeight || 0) - Number(el.clientHeight || 0));
        if (Math.abs(Number(el.scrollTop || 0) - nextTop) > 1) {
          el.scrollTop = nextTop;
        }
      } else if (prevTop > 0 && Math.abs(Number(el.scrollTop || 0) - prevTop) > 1) {
        el.scrollTop = prevTop;
      }
    }

    function lcActivityDisplayParts(item) {
      var st = item.status || 'completed';
      var durText = item.durationMs ? lcFormatDuration(item.durationMs) : (st === 'running' ? 'live' : '');
      var exitHtml = '';
      if (item.category === 'command' && (item.exitCode !== undefined && item.exitCode !== null || st !== 'running')) {
        var ecLabel = (item.exitCode !== undefined && item.exitCode !== null) ? String(item.exitCode) : (st === 'cancelled' ? 'cancelled' : 'n/a');
        exitHtml = '<span>Exit code: <strong>' + lcEscapeHtml(ecLabel) + '</strong></span>';
      }
      var sublineInner = exitHtml + (item.toolName ? '<span>Tool: ' + lcEscapeHtml(item.toolName) + '</span>' : '');
      var startTimeStr = item.startTime ? new Date(item.startTime).toLocaleTimeString() : '';
      var kvInner =
        (item.command ? '<span>Command: <code>' + lcEscapeHtml(item.command) + '</code></span>' : '') +
        (item.filePath ? '<span>Path: <code>' + lcEscapeHtml(item.filePath) + '</code></span>' : '') +
        (item.cwd ? '<span>CWD: <code>' + lcEscapeHtml(item.cwd) + '</code></span>' : '') +
        (startTimeStr ? '<span>Started: <code>' + lcEscapeHtml(startTimeStr) + '</code></span>' : '');
      return {
        st: st,
        durText: durText,
        summaryText: item.command ? ('$ ' + item.command) : (item.summary || ''),
        sublineInner: sublineInner,
        kvInner: kvInner,
      };
    }

    function lcSyncActivityPre(detailsEl, clsName, text) {
      if (!detailsEl) return null;
      var pre = detailsEl.querySelector('.' + clsName);
      if (text) {
        if (!pre && typeof document !== 'undefined' && typeof document.createElement === 'function') {
          pre = document.createElement('pre');
          pre.className = 'lc-terminal-pre ' + clsName;
          var emptyNote = detailsEl.querySelector('.lc-act-empty-out');
          if (emptyNote) emptyNote.remove();
          detailsEl.appendChild(pre);
        }
        lcApplyTextPreservingScroll(pre, text);
        return pre;
      }
      if (pre) pre.remove();
      return null;
    }

    function lcUpdateActivityCardElement(card, item) {
      if (!card || !item) return;
      var parts = lcActivityDisplayParts(item);
      var wasExpanded = card.classList ? card.classList.contains('expanded') : String(card.className || '').indexOf('expanded') !== -1;
      card.className = 'lc-activity-card status-' + parts.st + (wasExpanded ? ' expanded' : '');

      var summaryEl = card.querySelector('.lc-activity-summary-line');
      if (summaryEl && (summaryEl.textContent || '') !== parts.summaryText) {
        summaryEl.textContent = parts.summaryText;
      }
      var sublineEl = card.querySelector('.lc-activity-subline');
      if (parts.sublineInner) {
        if (!sublineEl && typeof document !== 'undefined') {
          var headings = card.querySelector('.lc-activity-headings');
          if (headings) {
            sublineEl = document.createElement('div');
            sublineEl.className = 'lc-activity-subline';
            headings.appendChild(sublineEl);
          }
        }
        if (sublineEl && sublineEl.innerHTML !== parts.sublineInner) {
          sublineEl.innerHTML = parts.sublineInner;
        }
      } else if (sublineEl) {
        sublineEl.remove();
      }

      var pillEl = card.querySelector('.lc-act-status-pill');
      if (pillEl) {
        pillEl.className = 'lc-act-status-pill ' + lcEscapeHtml(parts.st);
        var nextLbl = lcStatusLabel(parts.st);
        if ((pillEl.textContent || '') !== nextLbl) pillEl.textContent = nextLbl;
      }
      var rightEl = card.querySelector('.lc-activity-right');
      var durEl = card.querySelector('.lc-act-dur');
      if (parts.durText) {
        if (!durEl && rightEl && typeof document !== 'undefined') {
          durEl = document.createElement('span');
          durEl.className = 'lc-act-dur';
          var chev = rightEl.querySelector('.lc-act-chevron');
          rightEl.insertBefore(durEl, chev || null);
        }
        if (durEl && (durEl.textContent || '') !== parts.durText) durEl.textContent = parts.durText;
      } else if (durEl) {
        durEl.remove();
      }

      var detailsEl = card.querySelector('.lc-activity-details');
      if (detailsEl) {
        var kvEl = detailsEl.querySelector('.lc-act-detail-kv');
        if (kvEl && kvEl.innerHTML !== parts.kvInner) kvEl.innerHTML = parts.kvInner;
        lcSyncActivityPre(detailsEl, 'is-stdout', item.stdout || '');
        lcSyncActivityPre(detailsEl, 'is-stderr', item.stderr || '');
        var emptyEl = detailsEl.querySelector('.lc-act-empty-out');
        if (!item.stdout && !item.stderr) {
          var emptyMsg = parts.st === 'running' ? 'Waiting for output...' : 'No console output captured.';
          if (!emptyEl && typeof document !== 'undefined') {
            emptyEl = document.createElement('div');
            emptyEl.className = 'lc-act-empty-out';
            emptyEl.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground,#64748b);';
            detailsEl.appendChild(emptyEl);
          }
          if (emptyEl && (emptyEl.textContent || '') !== emptyMsg) emptyEl.textContent = emptyMsg;
        } else if (emptyEl) {
          emptyEl.remove();
        }
      }
    }

    function lcBuildActivityCardElement(item, isExpanded, onToggle) {
      var card = document.createElement('div');
      var parts = lcActivityDisplayParts(item);
      card.className = 'lc-activity-card status-' + parts.st + (isExpanded ? ' expanded' : '');
      card.setAttribute('data-act-id', item.id);

      var iconName = lcCategoryIconName(item.category);
      var headerHtml =
        '<div class="lc-activity-header">' +
          '<div class="lc-activity-left">' +
            '<span class="lc-activity-cat-icon">' + lcIcon(iconName, 14) + '</span>' +
            '<div class="lc-activity-headings">' +
              '<div class="lc-activity-title-line">' +
                '<span class="lc-activity-agent">' + lcEscapeHtml(item.agentName || 'Main Agent') + '</span>' +
                '<span class="lc-activity-sep">&mdash;</span>' +
                '<span>' + lcEscapeHtml(item.title || item.toolName || 'Tool Execution') + '</span>' +
              '</div>' +
              '<div class="lc-activity-summary-line">' + lcEscapeHtml(parts.summaryText) + '</div>' +
              (parts.sublineInner ? '<div class="lc-activity-subline">' + parts.sublineInner + '</div>' : '') +
            '</div>' +
          '</div>' +
          '<div class="lc-activity-right">' +
            '<span class="lc-act-status-pill ' + lcEscapeHtml(parts.st) + '">' + lcEscapeHtml(lcStatusLabel(parts.st)) + '</span>' +
            (parts.durText ? '<span class="lc-act-dur">' + lcEscapeHtml(parts.durText) + '</span>' : '') +
            '<span class="lc-act-chevron">' + lcIcon('chevron-right', 13) + '</span>' +
          '</div>' +
        '</div>';

      var detailsHtml = '<div class="lc-activity-details">' +
        '<div class="lc-act-detail-kv">' + parts.kvInner + '</div>' +
        (item.stdout ? '<pre class="lc-terminal-pre is-stdout">' + lcEscapeHtml(item.stdout) + '</pre>' : '') +
        (item.stderr ? '<pre class="lc-terminal-pre is-stderr">' + lcEscapeHtml(item.stderr) + '</pre>' : '') +
        ((!item.stdout && !item.stderr) ? '<div class="lc-act-empty-out" style="font-size:11px;color:var(--vscode-descriptionForeground,#64748b);">' + (parts.st === 'running' ? 'Waiting for output...' : 'No console output captured.') + '</div>' : '') +
      '</div>';

      card.innerHTML = headerHtml + detailsHtml;
      var headerEl = card.querySelector('.lc-activity-header');
      if (headerEl) {
        headerEl.addEventListener('click', function () {
          var open = card.classList.toggle('expanded');
          if (onToggle) onToggle(item.id, open);
        });
      }
      return card;
    }

    function lcGroupActivitiesByUserTurn(messages, activities) {
      var byMsgIndex = {};
      var userTurns = [];
      if (Array.isArray(messages)) {
        for (var i = 0; i < messages.length; i++) {
          var m = messages[i];
          if (m && m.senderRole === 'user') {
            userTurns.push({ msgIndex: i, ts: Number(m.timestamp || 0) });
          }
        }
      }
      if (!Array.isArray(activities) || activities.length === 0 || userTurns.length === 0) {
        return { byMsgIndex: byMsgIndex, lastTurnMsgIndex: userTurns.length ? userTurns[userTurns.length - 1].msgIndex : -1 };
      }
      for (var j = 0; j < activities.length; j++) {
        var act = activities[j];
        if (!act) continue;
        var actTs = Number(act.startTime || act.timestamp || 0);
        var assignedIdx = userTurns[0].msgIndex;
        for (var k = 0; k < userTurns.length; k++) {
          if (actTs >= userTurns[k].ts || userTurns[k].ts === 0) {
            assignedIdx = userTurns[k].msgIndex;
          } else {
            break;
          }
        }
        if (!byMsgIndex[assignedIdx]) byMsgIndex[assignedIdx] = [];
        byMsgIndex[assignedIdx].push(act);
      }
      return { byMsgIndex: byMsgIndex, lastTurnMsgIndex: userTurns[userTurns.length - 1].msgIndex };
    }

    function lcFormatTurnThinkingLabel(opts) {
      var list = Array.isArray(opts.activities) ? opts.activities : [];
      var isLive = !!opts.isLive;
      var thoughtCount = 0;
      var cmdCount = 0;
      var fileCount = 0;
      var actionCount = 0;
      var latestThought = null;
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (!it) continue;
        if (it.category === 'thinking_summary') {
          thoughtCount++;
          latestThought = it;
        } else {
          actionCount++;
          if (it.category === 'command') cmdCount++;
          else if (it.category === 'file') fileCount++;
        }
      }
      if (isLive) {
        var phaseText = (opts.statusSummary || 'Analyzing the task').trim();
        if (latestThought && latestThought.status === 'running' && latestThought.summary) {
          var who = latestThought.agentName || 'Agent';
          var preview = String(latestThought.summary).replace(/\\s+/g, ' ').trim();
          if (preview.length > 52) preview = preview.slice(0, 49) + '...';
          phaseText = who + ': ' + preview;
        }
        var countSuffix = actionCount > 0 ? (' · ' + actionCount + (actionCount === 1 ? ' step' : ' steps')) : '';
        return 'Thinking · ' + phaseText + countSuffix;
      }
      if (list.length === 1 && list[0].command) {
        var cmd = String(list[0].command).trim();
        if (cmd.length > 48) cmd = cmd.slice(0, 45) + '...';
        return 'Thinking · ' + cmd;
      }
      var parts = [];
      if (thoughtCount > 0) parts.push(thoughtCount + (thoughtCount === 1 ? ' thought' : ' thoughts'));
      if (cmdCount > 0) parts.push(cmdCount + (cmdCount === 1 ? ' command' : ' commands'));
      if (fileCount > 0) parts.push(fileCount + (fileCount === 1 ? ' file' : ' files'));
      if (parts.length === 0 && list.length > 0) {
        parts.push(list.length + (list.length === 1 ? ' step' : ' steps'));
      }
      if (parts.length === 0) return 'Thinking';
      return 'Thinking · ' + parts.join(', ');
    }

    function lcThoughtDurText(act) {
      if (act && act.durationMs) return lcFormatDuration(act.durationMs);
      if (act && act.status === 'running') return 'thinking...';
      return '';
    }

    function lcCanExpandThoughtText(bodyText) {
      if (!bodyText) return false;
      var s = String(bodyText);
      return s.length > 260 || s.split('\\n').length > 8;
    }

    function lcUpdateThoughtEntryElement(box, act, opts) {
      if (!box || !act) return;
      var isRunning = act.status === 'running';
      if (box.classList && typeof box.classList.toggle === 'function') {
        box.classList.toggle('running', isRunning);
      } else {
        box.className = 'lc-thought-entry' + (isRunning ? ' running' : '');
      }
      var durEl = box.querySelector('.lc-thought-dur');
      var nextDur = lcThoughtDurText(act);
      if (durEl && (durEl.textContent || '') !== nextDur) {
        durEl.textContent = nextDur;
      }
      var bodyText = act.stdout || act.summary || '';
      var bodyEl = box.querySelector('.lc-thought-body');
      if (bodyEl) {
        lcApplyTextPreservingScroll(bodyEl, bodyText);
        if (opts && typeof opts.isExpanded === 'boolean' && bodyEl.classList) {
          bodyEl.classList.toggle('is-expanded', opts.isExpanded);
        }
      }
      var expandBtn = box.querySelector('.lc-thought-expand-btn');
      if (expandBtn && bodyEl && bodyEl.classList) {
        var isExp = bodyEl.classList.contains('is-expanded');
        expandBtn.style.display = (isExp || lcCanExpandThoughtText(bodyText)) ? 'inline-block' : 'none';
        expandBtn.textContent = isExp ? 'Compact' : 'Expand';
      }
    }

    function lcBuildThoughtEntryElement(act, opts) {
      var box = document.createElement('div');
      var isRunning = act.status === 'running';
      var isExpanded = Boolean(opts && opts.isExpanded);
      box.className = 'lc-thought-entry' + (isRunning ? ' running' : '');
      box.setAttribute('data-act-id', act.id || '');
      var bodyText = act.stdout || act.summary || '';
      var roleHtml = act.agentRole ? '<span class="lc-thought-role">(' + lcEscapeHtml(act.agentRole) + ')</span>' : '';
      var durText = lcThoughtDurText(act);
      var showExpand = isExpanded || lcCanExpandThoughtText(bodyText);
      box.innerHTML =
        '<div class="lc-thought-meta">' +
          '<span class="lc-thought-agent">' +
            lcIcon('brain', 12) +
            '<span>' + lcEscapeHtml(act.agentName || 'Main Agent') + '</span>' +
            roleHtml +
          '</span>' +
          '<span class="lc-thought-meta-right">' +
            '<button type="button" class="lc-thought-expand-btn" style="display:' + (showExpand ? 'inline-block' : 'none') + '">' + (isExpanded ? 'Compact' : 'Expand') + '</button>' +
            '<span class="lc-thought-dur">' + lcEscapeHtml(durText) + '</span>' +
          '</span>' +
        '</div>' +
        '<div class="lc-thought-body' + (isExpanded ? ' is-expanded' : '') + '">' + lcEscapeHtml(bodyText) + '</div>';

      var expandBtn = box.querySelector('.lc-thought-expand-btn');
      var bodyEl = box.querySelector('.lc-thought-body');
      if (expandBtn && bodyEl) {
        expandBtn.addEventListener('click', function (e) {
          if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
          var open = bodyEl.classList.toggle('is-expanded');
          expandBtn.textContent = open ? 'Compact' : 'Expand';
          if (opts && typeof opts.onToggleExpand === 'function') {
            opts.onToggleExpand(act.id, open);
          }
        });
      }
      return box;
    }

    function lcBuildPlanMiniHtml(planItems) {
      if (!Array.isArray(planItems) || planItems.length === 0) return '';
      return planItems.map(function (p) {
        var done = p.status === 'completed';
        return '<div class="lc-plan-mini-item' + (done ? ' completed' : '') + '">' +
          '<span>' + lcEscapeHtml(p.title || p.description) + '</span>' +
          '<span class="lc-act-status-pill ' + lcEscapeHtml(p.status === 'in_progress' ? 'running' : p.status) + '">' + lcEscapeHtml(p.status) + '</span>' +
          '</div>';
      }).join('');
    }

    function lcUpdateInlineThinkingGroupHeader(wrap, opts) {
      if (!wrap) return;
      var activities = Array.isArray(opts.activities) ? opts.activities : [];
      var isLive = !!opts.isLive;
      var hasFailed = activities.some(function (a) { return a && a.status === 'failed'; });
      var trigger = wrap.querySelector('.lc-thinking-trigger');
      if (!trigger) return;

      var dotEl = trigger.querySelector('.lc-status-pulse, .lc-status-dot-static');
      if (dotEl) {
        var nextDotClass = isLive ? 'lc-status-pulse' : ('lc-status-dot-static ' + (hasFailed ? 'failed' : 'completed'));
        if (dotEl.className !== nextDotClass) dotEl.className = nextDotClass;
      }
      var labelEl = trigger.querySelector('.lc-thinking-label');
      var nextLabel = lcFormatTurnThinkingLabel({
        activities: activities,
        isLive: isLive,
        statusSummary: opts.statusSummary,
      });
      if (labelEl && (labelEl.textContent || '') !== nextLabel) {
        labelEl.textContent = nextLabel;
      }
    }

    function lcBuildInlineThinkingGroup(opts) {
      var wrap = document.createElement('div');
      var isExpanded = !!opts.isExpanded;
      var isLive = !!opts.isLive;
      var activities = Array.isArray(opts.activities) ? opts.activities : [];
      var planItems = Array.isArray(opts.planItems) ? opts.planItems : [];
      var hasFailed = activities.some(function (a) { return a && a.status === 'failed'; });

      wrap.className = 'lc-thinking-group' + (isExpanded ? ' expanded' : '');
      if (opts.turnKey) wrap.setAttribute('data-turn-key', opts.turnKey);

      var trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'lc-thinking-trigger';
      var dotHtml = isLive
        ? '<span class="lc-status-pulse"></span>'
        : '<span class="lc-status-dot-static ' + (hasFailed ? 'failed' : 'completed') + '"></span>';
      var labelText = lcFormatTurnThinkingLabel({
        activities: activities,
        isLive: isLive,
        statusSummary: opts.statusSummary,
      });
      trigger.innerHTML =
        dotHtml +
        '<span class="lc-thinking-label">' + lcEscapeHtml(labelText) + '</span>' +
        '<span class="lc-thinking-chev">' + lcIcon('chevron-right', 13) + '</span>';

      var drawer = document.createElement('div');
      drawer.className = 'lc-thinking-drawer';

      if (planItems.length > 0) {
        var planListEl = document.createElement('div');
        planListEl.className = 'lc-plan-checklist-mini';
        planListEl.style.borderBottom = 'none';
        planListEl.style.padding = '2px 0 4px 0';
        planListEl.innerHTML = lcBuildPlanMiniHtml(planItems);
        drawer.appendChild(planListEl);
      }

      var expandedThoughtMap = opts.expandedThoughtIds;
      activities.forEach(function (act) {
        if (act && act.category === 'thinking_summary') {
          var isThoughtExpanded = expandedThoughtMap && typeof expandedThoughtMap.has === 'function' ? expandedThoughtMap.has(act.id) : false;
          drawer.appendChild(lcBuildThoughtEntryElement(act, {
            isExpanded: isThoughtExpanded,
            onToggleExpand: opts.onToggleExpandThought,
          }));
          return;
        }
        var expandedMap = opts.expandedActivityIds;
        var card = lcBuildActivityCardElement(
          act,
          expandedMap && typeof expandedMap.has === 'function' ? expandedMap.has(act.id) : false,
          opts.onToggleActivity
        );
        drawer.appendChild(card);
      });

      if (activities.length === 0 && planItems.length === 0) {
        var note = document.createElement('div');
        note.className = 'lc-thinking-empty-note';
        note.style.cssText = 'font-size:11.5px;color:var(--vscode-descriptionForeground,#94a3b8);padding:2px 4px;';
        note.textContent = opts.statusSummary || 'Working...';
        drawer.appendChild(note);
      }

      trigger.addEventListener('click', function () {
        var open = wrap.classList.toggle('expanded');
        if (opts.onToggleTurn) opts.onToggleTurn(opts.turnKey, open);
      });

      wrap.appendChild(trigger);
      wrap.appendChild(drawer);
      return wrap;
    }

    function lcRenderMarkdown(text) {
      if (!text) return '';
      var src = String(text).replace(/\\r\\n/g, '\\n');
      var bt = String.fromCharCode(96);
      var b3 = bt + bt + bt;

      // 1. Protect fenced code blocks before inline/block parsing
      var preBlocks = [];
      var withoutFences = '';
      var pos = 0;
      while (pos < src.length) {
        var openIdx = src.indexOf(b3, pos);
        if (openIdx === -1) {
          withoutFences += src.slice(pos);
          break;
        }
        withoutFences += src.slice(pos, openIdx);
        var lineEnd = src.indexOf('\\n', openIdx + 3);
        var fenceLang = '';
        var codeStart = openIdx + 3;
        if (lineEnd !== -1) {
          fenceLang = src.slice(openIdx + 3, lineEnd).trim().replace(/[^a-zA-Z0-9_+-]/g, '');
          codeStart = lineEnd + 1;
        }
        var closeIdx = src.indexOf(b3, codeStart);
        var rawCode = '';
        if (closeIdx === -1) {
          rawCode = src.slice(codeStart);
          pos = src.length;
        } else {
          rawCode = src.slice(codeStart, closeIdx);
          pos = closeIdx + 3;
        }
        var trimmedCode = rawCode.replace(/^\\n+|\\n+$/g, '');
        var langHtml = fenceLang ? '<div class="lc-md-lang">' + lcEscapeHtml(fenceLang) + '</div>' : '';
        var preHtml = '<pre class="lc-md-pre">' + langHtml + '<code>' + lcEscapeHtml(trimmedCode) + '</code></pre>';
        var token = '@@LC_PRE_' + preBlocks.length + '@@';
        preBlocks.push(preHtml);
        withoutFences += '\\n' + token + '\\n';
      }

      // 2. Protect inline code spans
      var inlineCodes = [];
      var working = '';
      var i = 0;
      while (i < withoutFences.length) {
        if (withoutFences[i] === bt) {
          var endTick = withoutFences.indexOf(bt, i + 1);
          if (endTick !== -1 && withoutFences.slice(i + 1, endTick).indexOf('\\n') === -1) {
            var codeTok = '@@LC_CODE_' + inlineCodes.length + '@@';
            inlineCodes.push('<code class="lc-md-inline">' + lcEscapeHtml(withoutFences.slice(i + 1, endTick)) + '</code>');
            working += codeTok;
            i = endTick + 1;
            continue;
          }
        }
        working += withoutFences[i];
        i++;
      }

      var escaped = lcEscapeHtml(working);

      function formatInline(s) {
        var out = s;
        out = out.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, '<a class="lc-md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        out = out.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
        out = out.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
        out = out.replace(/__(.+?)__/g, '<strong>$1</strong>');
        out = out.replace(/(^|[\\s(])\\*([^\\s*][^*]*?)\\*(?=[\\s.,!?:;)]|$)/g, '$1<em>$2</em>');
        return out;
      }

      // 3. Parse block elements cleanly line-by-line
      var lines = escaped.split('\\n');
      var blocks = [];
      var paraBuf = [];
      var ulBuf = [];
      var olBuf = [];

      function flushPara() {
        if (paraBuf.length === 0) return;
        blocks.push('<p class="lc-md-p">' + paraBuf.map(formatInline).join('<br/>') + '</p>');
        paraBuf = [];
      }
      function flushLists() {
        if (ulBuf.length > 0) {
          blocks.push('<ul class="lc-md-list">' + ulBuf.map(function (it) { return '<li>' + formatInline(it) + '</li>'; }).join('') + '</ul>');
          ulBuf = [];
        }
        if (olBuf.length > 0) {
          blocks.push('<ol class="lc-md-list">' + olBuf.map(function (it) { return '<li>' + formatInline(it) + '</li>'; }).join('') + '</ol>');
          olBuf = [];
        }
      }

      for (var lnIdx = 0; lnIdx < lines.length; lnIdx++) {
        var line = lines[lnIdx];
        var trimmed = line.trim();

        if (!trimmed) {
          flushPara();
          flushLists();
          continue;
        }

        if (/^@@LC_PRE_\\d+@@$/.test(trimmed)) {
          flushPara();
          flushLists();
          blocks.push(trimmed);
          continue;
        }

        var hMatch = trimmed.match(/^(#{1,4})\\s+(.+)$/);
        if (hMatch) {
          flushPara();
          flushLists();
          var lvl = hMatch[1].length;
          blocks.push('<h' + lvl + ' class="lc-md-h lc-md-h' + lvl + '">' + formatInline(hMatch[2]) + '</h' + lvl + '>');
          continue;
        }

        if (/^(?:---+|\\*\\*\\*+|===+)$/.test(trimmed)) {
          flushPara();
          flushLists();
          blocks.push('<hr class="lc-md-hr" />');
          continue;
        }

        var qMatch = line.match(/^\\s*&gt;\\s?(.*)$/);
        if (qMatch) {
          flushPara();
          flushLists();
          blocks.push('<blockquote class="lc-md-quote">' + formatInline(qMatch[1]) + '</blockquote>');
          continue;
        }

        var ulMatch = line.match(/^\\s*[-*+]\\s+(.+)$/);
        if (ulMatch) {
          flushPara();
          if (olBuf.length > 0) flushLists();
          ulBuf.push(ulMatch[1]);
          continue;
        }

        var olMatch = line.match(/^\\s*\\d+\\.\\s+(.+)$/);
        if (olMatch) {
          flushPara();
          if (ulBuf.length > 0) flushLists();
          olBuf.push(olMatch[1]);
          continue;
        }

        flushLists();
        paraBuf.push(line);
      }
      flushPara();
      flushLists();

      var resultHtml = blocks.join('');
      for (var k = 0; k < preBlocks.length; k++) {
        resultHtml = resultHtml.split('@@LC_PRE_' + k + '@@').join(preBlocks[k]);
      }
      for (var m = 0; m < inlineCodes.length; m++) {
        resultHtml = resultHtml.split('@@LC_CODE_' + m + '@@').join(inlineCodes[m]);
      }
      return resultHtml;
    }
  `;
}

export function inspectorTabIcon(tab: 'activity' | 'terminal' | 'changes'): string {
  if (tab === 'activity') return lucideSvg('zap', 13);
  if (tab === 'terminal') return lucideSvg('terminal', 13);
  return lucideSvg('file-diff', 13);
}
