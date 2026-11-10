import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentMessage, TaskPlanItem, CriticReport } from '../agents/types';
import { ReasoningEffort } from '../models/model-provider-registry';

export type ExecutionMode = 'code' | 'smart' | 'ask' | 'plan';
export type PermissionMode = 'ask' | 'smart' | 'bypass';

export interface AgentSessionConfig {
  providerId: string; // 'ollama' | 'openai' | 'anthropic' | 'gemini' | 'custom'
  modelId: string; // e.g. "ollama/qwen3.8:27b", "anthropic/claude-3-7-sonnet"
  modelName?: string;
  reasoningEffort: ReasoningEffort;
  fastMode: boolean;
  executionMode: ExecutionMode;
  permissionMode: PermissionMode;
  enabledMcpServers?: string[];
  enabledSkills?: string[];
  activeRules?: string[];
  attachedFiles?: string[];
  projectContext?: string[];
}

export interface ExecutionGroup {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  durationMs: number;
  status: 'working' | 'completed' | 'failed';
  details: string[];
  startedAt: number;
  completedAt?: number;
}

export interface SessionData {
  id: string;
  title: string;
  userGoal: string;
  status: 'running' | 'waiting_approval' | 'completed' | 'failed' | 'idle';
  createdAt: number;
  updatedAt: number;
  workspaceRoot: string;
  model: string;
  config: AgentSessionConfig;
  participatingAgents: string[];
  messages: AgentMessage[];
  plan: TaskPlanItem[];
  executionGroups: ExecutionGroup[];
  criticReport?: CriticReport | null;
  archived: boolean;
}

export class SessionManager {
  private sessions: Map<string, SessionData> = new Map();
  private activeSessionId: string | null = null;
  private storageDir: string;
  private _onDidChangeSessions = new vscode.EventEmitter<void>();
  public readonly onDidChangeSessions = this._onDidChangeSessions.event;

  constructor(private context: vscode.ExtensionContext, private workspaceRoot: string) {
    this.storageDir = this.resolveStorageDir(workspaceRoot);
    this.ensureStorage();
    this.loadSessions();
  }

  private resolveStorageDir(root: string): string {
    if (root && fs.existsSync(root)) {
      return path.join(root, '.localcoders', 'sessions');
    }
    return path.join(this.context.globalStorageUri?.fsPath || '/tmp/localcoders', 'sessions');
  }

  public setWorkspace(root: string) {
    this.workspaceRoot = root;
    this.storageDir = this.resolveStorageDir(root);
    this.sessions.clear();
    this.ensureStorage();
    this.loadSessions();
    this._onDidChangeSessions.fire();
  }

  private ensureStorage() {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
    } catch (e) {
      console.error('[SessionManager] Failed to create sessions dir:', e);
    }
  }

  private loadSessions() {
    try {
      if (!fs.existsSync(this.storageDir)) return;
      const files = fs.readdirSync(this.storageDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const filePath = path.join(this.storageDir, file);
          const raw = fs.readFileSync(filePath, 'utf-8');
          const session = JSON.parse(raw) as SessionData;

          // Backfill config if legacy session
          if (!session.config) {
            session.config = {
              providerId: 'ollama',
              modelId: session.model || 'qwen3.8:27b',
              reasoningEffort: 'medium',
              fastMode: false,
              executionMode: 'code',
              permissionMode: 'smart',
              attachedFiles: [],
              projectContext: [],
            };
          }
          this.sessions.set(session.id, session);
        } catch (e) {
          console.error(`[SessionManager] Failed to read session ${file}:`, e);
        }
      }

      // Restore active session or pick the most recent one
      const savedActive = this.context.workspaceState.get<string>('localcoders.activeSessionId');
      if (savedActive && this.sessions.has(savedActive)) {
        this.activeSessionId = savedActive;
      } else if (this.sessions.size > 0) {
        const sorted = this.getAllSessions();
        this.activeSessionId = sorted[0].id;
      }
    } catch (e) {
      console.error('[SessionManager] Error loading sessions:', e);
    }
  }

  public getAllSessions(): SessionData[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public getActiveSession(): SessionData | undefined {
    if (!this.activeSessionId) return undefined;
    return this.sessions.get(this.activeSessionId);
  }

  public getSession(id: string): SessionData | undefined {
    return this.sessions.get(id);
  }

  public createSession(
    goal: string,
    model: string = 'qwen3.8:27b',
    initialConfig?: Partial<AgentSessionConfig>
  ): SessionData {
    const id = `session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const title = goal.length > 36 ? goal.substring(0, 36).trim() + '...' : goal || 'New Session';

    const config: AgentSessionConfig = {
      providerId: initialConfig?.providerId || (model.includes('/') ? model.split('/')[0] : 'ollama'),
      modelId: initialConfig?.modelId || model,
      modelName: initialConfig?.modelName || model,
      reasoningEffort: initialConfig?.reasoningEffort || 'medium',
      fastMode: initialConfig?.fastMode ?? false,
      executionMode: initialConfig?.executionMode || 'code',
      permissionMode: initialConfig?.permissionMode || 'smart',
      enabledMcpServers: initialConfig?.enabledMcpServers || [],
      enabledSkills: initialConfig?.enabledSkills || [],
      activeRules: initialConfig?.activeRules || [],
      attachedFiles: initialConfig?.attachedFiles || [],
      projectContext: initialConfig?.projectContext || [],
    };

    const newSession: SessionData = {
      id,
      title,
      userGoal: goal,
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspaceRoot: this.workspaceRoot,
      model: config.modelId,
      config,
      participatingAgents: ['main'],
      messages: [],
      plan: [],
      executionGroups: [],
      archived: false,
    };

    this.sessions.set(id, newSession);
    this.activeSessionId = id;
    this.saveSession(newSession);
    this.context.workspaceState.update('localcoders.activeSessionId', id);
    this._onDidChangeSessions.fire();
    return newSession;
  }

  public switchSession(id: string): boolean {
    if (this.sessions.has(id)) {
      this.activeSessionId = id;
      this.context.workspaceState.update('localcoders.activeSessionId', id);
      this._onDidChangeSessions.fire();
      return true;
    }
    return false;
  }

  public renameSession(id: string, newTitle: string) {
    const s = this.sessions.get(id);
    if (s) {
      s.title = newTitle;
      s.updatedAt = Date.now();
      this.saveSession(s);
      this._onDidChangeSessions.fire();
    }
  }

  public deleteSession(id: string) {
    if (this.sessions.has(id)) {
      this.sessions.delete(id);
      const filePath = path.join(this.storageDir, `${id}.json`);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {}
      }
      if (this.activeSessionId === id) {
        const remaining = this.getAllSessions();
        this.activeSessionId = remaining.length > 0 ? remaining[0].id : null;
        this.context.workspaceState.update('localcoders.activeSessionId', this.activeSessionId);
      }
      this._onDidChangeSessions.fire();
    }
  }

  public archiveSession(id: string, archived: boolean = true) {
    const s = this.sessions.get(id);
    if (s) {
      s.archived = archived;
      s.updatedAt = Date.now();
      this.saveSession(s);
      this._onDidChangeSessions.fire();
    }
  }

  public updateActiveSession(updater: (session: SessionData) => void) {
    const session = this.getActiveSession();
    if (!session) return;
    updater(session);
    if (session.messages && session.messages.length > 1) {
      const seen = new Set<string>();
      const deduped: AgentMessage[] = [];
      for (const m of session.messages) {
        if (!m.id) {
          deduped.push(m);
          continue;
        }
        if (!seen.has(m.id)) {
          seen.add(m.id);
          deduped.push(m);
        }
      }
      session.messages = deduped;
    }
    session.updatedAt = Date.now();
    this.saveSession(session);
    this._onDidChangeSessions.fire();
  }

  public updateActiveConfig(updater: (config: AgentSessionConfig) => void): SessionData | undefined {
    const session = this.getActiveSession();
    if (!session) return undefined;
    if (!session.config) {
      session.config = {
        providerId: 'ollama',
        modelId: session.model || 'qwen3.8:27b',
        reasoningEffort: 'medium',
        fastMode: false,
        executionMode: 'code',
        permissionMode: 'smart',
        attachedFiles: [],
        projectContext: [],
      };
    }
    updater(session.config);
    session.model = session.config.modelId;
    session.updatedAt = Date.now();
    this.saveSession(session);
    this._onDidChangeSessions.fire();
    return session;
  }

  public attachFileToActiveSession(filePath: string): void {
    this.updateActiveConfig((cfg) => {
      if (!cfg.attachedFiles) cfg.attachedFiles = [];
      if (!cfg.attachedFiles.includes(filePath)) {
        cfg.attachedFiles.push(filePath);
      }
    });
  }

  public removeAttachmentFromActiveSession(filePath: string): void {
    this.updateActiveConfig((cfg) => {
      if (!cfg.attachedFiles) return;
      cfg.attachedFiles = cfg.attachedFiles.filter((f) => f !== filePath);
    });
  }

  private saveSession(session: SessionData) {
    try {
      this.ensureStorage();
      const filePath = path.join(this.storageDir, `${session.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
    } catch (e) {
      console.error(`[SessionManager] Failed to persist session ${session.id}:`, e);
    }
  }
}
