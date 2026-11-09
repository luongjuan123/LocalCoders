import { create } from 'zustand';
import {
  AgentConfig,
  AgentMessage,
  AgentStatus,
  CriticConfig,
  CriticReport,
  EditorTab,
  FileNode,
  GitStatus,
  HardwareInfo,
  OllamaCatalogueItem,
  OllamaModel,
  TaskPlanItem,
  ToolApprovalRequest,
} from '../types';

interface AppState {
  setupCompleted: boolean;
  activeSidebarTab: 'explorer' | 'search' | 'git' | 'agents' | 'models' | 'rules';
  activeBottomTab: 'terminal' | 'problems' | 'logs' | 'critic';
  bottomPanelOpen: boolean;
  aiSidebarOpen: boolean;

  workspacePath: string;
  fileTree: FileNode[];
  openTabs: EditorTab[];
  activeTabId: string | null;

  gitStatus: GitStatus;
  installedModels: OllamaModel[];
  modelCatalogue: OllamaCatalogueItem[];
  hardware: HardwareInfo | null;

  mainAgent: AgentConfig | null;
  subagents: AgentConfig[];
  criticConfig: CriticConfig;

  agentMessages: AgentMessage[];
  agentStatus: AgentStatus;
  activeAgentActivity: string;
  currentPlan: TaskPlanItem[];
  pendingApproval: ToolApprovalRequest | null;
  criticReport: CriticReport | null;
  terminalLogs: Array<{ stream: 'stdout' | 'stderr'; text: string }>;

  // Actions
  init: () => Promise<void>;
  setActiveSidebarTab: (tab: any) => void;
  setActiveBottomTab: (tab: any) => void;
  toggleBottomPanel: () => void;
  toggleAiSidebar: () => void;
  openFile: (path: string) => Promise<void>;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTabContent: (id: string, content: string) => void;
  saveActiveFile: () => Promise<void>;
  refreshWorkspace: () => Promise<void>;
  refreshGit: () => Promise<void>;
  openDirectoryDialog: () => Promise<void>;

  submitAiPrompt: (prompt: string) => Promise<void>;
  cancelAiTask: () => Promise<void>;
  resolveApproval: (approved: boolean) => Promise<void>;

  pullModel: (name: string) => Promise<void>;
  deleteModel: (name: string) => Promise<void>;
  saveSetup: (main: AgentConfig, subs: AgentConfig[], critic: CriticConfig) => Promise<void>;
  runTerminalCommand: (cmd: string) => Promise<void>;
}

const api = (window as any).localCodersAPI;

export const useAppStore = create<AppState>((set, get) => ({
  setupCompleted: false,
  activeSidebarTab: 'explorer',
  activeBottomTab: 'terminal',
  bottomPanelOpen: true,
  aiSidebarOpen: true,

  workspacePath: '',
  fileTree: [],
  openTabs: [],
  activeTabId: null,

  gitStatus: { branch: '', isRepo: false, staged: [], modified: [], untracked: [] },
  installedModels: [],
  modelCatalogue: [],
  hardware: null,

  mainAgent: null,
  subagents: [],
  criticConfig: {
    enabled: true,
    model: '',
    strictness: 'strict',
    categories: ['Security', 'Logic', 'Edge cases'],
    trigger: 'on_diff',
    reviewMode: 'changed_files',
  },

  agentMessages: [],
  agentStatus: 'idle',
  activeAgentActivity: '',
  currentPlan: [],
  pendingApproval: null,
  criticReport: null,
  terminalLogs: [],

  init: async () => {
    if (!api) return;

    // Load initial data from Electron IPC
    try {
      const workspace = await api.fs.getWorkspace();
      const tree = await api.fs.listTree();
      const git = await api.git.getStatus();
      const models = await api.ollama.listModels();
      const catalogue = await api.ollama.getCatalogue();
      const hw = await api.ollama.getHardwareInfo();
      const main = await api.agents.getMainAgent();
      const subs = await api.agents.getSubagents();
      const critic = await api.agents.getCriticConfig();
      const msgs = await api.db.getMessages();
      const setupFlag = await api.db.getSetting('setupCompleted');

      set({
        workspacePath: workspace,
        fileTree: tree,
        gitStatus: git,
        installedModels: models,
        modelCatalogue: catalogue,
        hardware: hw,
        mainAgent: main,
        subagents: subs,
        criticConfig: critic,
        agentMessages: msgs || [],
        setupCompleted: setupFlag === 'true' && main && !!main.model,
      });

      // Subscribe to backend events
      api.on('agent-activity', (ev: any) => {
        set({ agentStatus: ev.status, activeAgentActivity: ev.latestActivity });
      });

      api.on('agent-message', (msg: AgentMessage) => {
        set((state) => ({ agentMessages: [...state.agentMessages, msg] }));
      });

      api.on('plan-update', (plan: TaskPlanItem[]) => {
        set({ currentPlan: plan });
      });

      api.on('approval-request', (req: ToolApprovalRequest) => {
        set({ pendingApproval: req });
      });

      api.on('critic-report', (report: CriticReport) => {
        set({ criticReport: report, activeBottomTab: 'critic', bottomPanelOpen: true });
      });

      api.on('terminal-output', (chunk: any) => {
        set((state) => ({ terminalLogs: [...state.terminalLogs.slice(-200), chunk] }));
      });
    } catch (e) {
      console.error('Init error:', e);
    }
  },

  setActiveSidebarTab: (tab) => set({ activeSidebarTab: tab }),
  setActiveBottomTab: (tab) => set({ activeBottomTab: tab }),
  toggleBottomPanel: () => set((s) => ({ bottomPanelOpen: !s.bottomPanelOpen })),
  toggleAiSidebar: () => set((s) => ({ aiSidebarOpen: !s.aiSidebarOpen })),

  openFile: async (filePath: string) => {
    const existing = get().openTabs.find((t) => t.path === filePath);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }

    try {
      const content = await api.fs.readFile(filePath);
      const ext = filePath.split('.').pop() || '';
      let language = 'plaintext';
      if (['ts', 'tsx'].includes(ext)) language = 'typescript';
      else if (['js', 'jsx'].includes(ext)) language = 'javascript';
      else if (['json'].includes(ext)) language = 'json';
      else if (['html'].includes(ext)) language = 'html';
      else if (['css'].includes(ext)) language = 'css';
      else if (['py'].includes(ext)) language = 'python';
      else if (['md'].includes(ext)) language = 'markdown';

      const newTab: EditorTab = {
        id: `tab_${Date.now()}_${Math.random()}`,
        path: filePath,
        title: filePath.split('/').pop() || filePath,
        isDirty: false,
        content,
        language,
      };

      set((state) => ({
        openTabs: [...state.openTabs, newTab],
        activeTabId: newTab.id,
      }));
    } catch (e: any) {
      console.error('Failed to open file:', e);
    }
  },

  closeTab: (id: string) => {
    set((state) => {
      const tabs = state.openTabs.filter((t) => t.id !== id);
      const nextActive = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
      return { openTabs: tabs, activeTabId: nextActive };
    });
  },

  setActiveTab: (id: string) => set({ activeTabId: id }),

  updateTabContent: (id: string, content: string) => {
    set((state) => ({
      openTabs: state.openTabs.map((t) => (t.id === id ? { ...t, content, isDirty: true } : t)),
    }));
  },

  saveActiveFile: async () => {
    const active = get().openTabs.find((t) => t.id === get().activeTabId);
    if (!active) return;
    await api.fs.writeFile(active.path, active.content);
    set((state) => ({
      openTabs: state.openTabs.map((t) => (t.id === active.id ? { ...t, isDirty: false } : t)),
    }));
    get().refreshGit();
  },

  refreshWorkspace: async () => {
    const tree = await api.fs.listTree();
    set({ fileTree: tree });
  },

  refreshGit: async () => {
    const git = await api.git.getStatus();
    set({ gitStatus: git });
  },

  openDirectoryDialog: async () => {
    const chosen = await api.fs.openDirectoryDialog();
    if (chosen) {
      const tree = await api.fs.listTree();
      const git = await api.git.getStatus();
      set({ workspacePath: chosen, fileTree: tree, gitStatus: git, openTabs: [], activeTabId: null });
    }
  },

  submitAiPrompt: async (prompt: string) => {
    if (!prompt.trim()) return;
    try {
      await api.agents.submitTask(prompt);
      get().refreshWorkspace();
      get().refreshGit();
    } catch (err: any) {
      alert(`Agent task failed: ${err.message}`);
    }
  },

  cancelAiTask: async () => {
    await api.agents.cancelTask();
  },

  resolveApproval: async (approved: boolean) => {
    const req = get().pendingApproval;
    if (req) {
      await api.agents.resolveApproval(req.id, approved);
      set({ pendingApproval: null });
    }
  },

  pullModel: async (name: string) => {
    await api.ollama.pullModel(name);
    const models = await api.ollama.listModels();
    set({ installedModels: models });
  },

  deleteModel: async (name: string) => {
    await api.ollama.deleteModel(name);
    const models = await api.ollama.listModels();
    set({ installedModels: models });
  },

  saveSetup: async (main: AgentConfig, subs: AgentConfig[], critic: CriticConfig) => {
    await api.agents.setMainAgent(main);
    for (const s of subs) {
      await api.agents.addSubagent(s);
    }
    await api.agents.setCriticConfig(critic);
    await api.db.setSetting('setupCompleted', 'true');
    set({ mainAgent: main, subagents: subs, criticConfig: critic, setupCompleted: true });
  },

  runTerminalCommand: async (cmd: string) => {
    await api.terminal.execute(cmd);
  },
}));
