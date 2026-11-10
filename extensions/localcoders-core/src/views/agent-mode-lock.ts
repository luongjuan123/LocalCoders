/**
 * Helpers for enforcing strict single-tab isolation in Agent Mode.
 * Pure functions so tab-filtering rules can be unit tested without the VS Code extension host.
 */

export const AGENT_WORKSPACE_VIEW_TYPE = 'localcoders.agentWorkspace';

export interface TabLike {
  input: unknown;
}

export interface TabGroupLike<T extends TabLike = TabLike> {
  tabs: ReadonlyArray<T>;
}

/**
 * Returns true if the given tab input belongs to LocalCoders Agent Workspace.
 */
export function isAgentWorkspaceTabInput(input: unknown): boolean {
  if (!input || typeof input !== 'object') {
    return false;
  }
  const viewType = (input as { viewType?: unknown }).viewType;
  if (typeof viewType !== 'string' || !viewType) {
    return false;
  }
  return viewType === AGENT_WORKSPACE_VIEW_TYPE || viewType.includes(AGENT_WORKSPACE_VIEW_TYPE);
}

/**
 * Collects every open editor tab that must be closed so Agent Mode retains
 * at most one pinned Agent Workspace tab across all editor groups.
 */
export function collectNonAgentTabsToClose<T extends TabLike>(
  tabGroups: ReadonlyArray<TabGroupLike<T>>
): { agentTab: T | undefined; tabsToClose: T[] } {
  let agentTab: T | undefined;
  const tabsToClose: T[] = [];

  for (const group of tabGroups) {
    for (const tab of group.tabs) {
      if (!agentTab && isAgentWorkspaceTabInput(tab.input)) {
        agentTab = tab;
      } else {
        tabsToClose.push(tab);
      }
    }
  }

  return { agentTab, tabsToClose };
}
