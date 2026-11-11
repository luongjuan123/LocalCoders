import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AgentOrchestrator } from '../agents/orchestrator';
import {
  AgentStreamEvent,
  finalizeRunningActivities,
  getSafePhaseLabel,
  sanitizeConversationHistory,
  upsertActivityItem,
} from '../agents/events';
import { AgentRegistry } from '../agents/agent-registry';
import { AgentMessage, AgentTask, TaskPlanItem } from '../agents/types';
import { ChangesManager } from '../context/changes-manager';
import { McpHost } from '../mcp/mcp-host';
import { ModelProviderRegistry } from '../models/model-provider-registry';
import { OllamaClient } from '../ollama/client';
import { PermissionManager } from '../security/permission-manager';
import { ToolManager } from '../tools/tool-manager';
import { isSlashCommandInput, parseSlashCommand, runSlashCommandForWorkspace } from '../commands';
import type { CommandResult } from '../commands/types';
import type { AgentSessionConfig, ExecutionMode, SessionData, SessionManager } from './session-manager';

export type AttachmentType =
  | 'file'
  | 'folder'
  | 'git'
  | 'terminal'
  | 'codemap'
  | 'plan'
  | 'conversation'
  | 'mention';

export interface QueueAttachment {
  id: string;
  path: string;
  label: string;
  type: AttachmentType;
}

export type QueuedMessageStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type QueuedMessageKind = 'prompt' | 'slash_command';

export interface QueuedMessage {
  id: string;
  executionId: string;
  sessionId: string;
  content: string;
  attachments: QueueAttachment[];
  mentions?: string[];
  kind?: QueuedMessageKind;
  executionModeOverride?: ExecutionMode;
  createdAt: number;
  updatedAt: number;
  position: number;
  status: QueuedMessageStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  interruptedOnRestart?: boolean;
}

export type QueueEngineState =
  | 'idle'
  | 'running'
  | 'queued'
  | 'processing_next'
  | 'paused'
  | 'failed'
  | 'completed';

export interface PersistedQueueState {
  paused: boolean;
  lastError?: string;
  items: QueuedMessage[];
  completedExecutionIds?: string[];
}

export interface SessionQueueSnapshot {
  sessionId: string;
  state: QueueEngineState;
  paused: boolean;
  activeItemId: string | null;
  activeExecutionId: string | null;
  isBusy: boolean;
  capacity: number;
  queuedCount: number;
  failedCount: number;
  completedCount: number;
  lastError?: string;
  items: QueuedMessage[];
}

export interface QueueExecutionContext {
  sessionId: string;
  session: SessionData;
  freshPrompt: string;
  attachments: QueueAttachment[];
  effectiveConfig: AgentSessionConfig;
  history: Array<{ role: string; content: string }>;
  workspaceRoot: string;
  abortSignal: AbortSignal;
}

export type QueueTaskExecutor = (
  item: QueuedMessage,
  execCtx: QueueExecutionContext
) => Promise<{ ok: boolean; cancelled?: boolean; error?: string; summary?: string }>;

export interface SessionRuntimeEvent {
  sessionId: string;
  type:
    | 'addMessage'
    | 'messageDelta'
    | 'streamStatus'
    | 'activityUpsert'
    | 'planUpdate'
    | 'runFinished'
    | 'slashCommandResult'
    | 'queueUpdated';
  payload: any;
}

export interface SubmitQueueMessageParams {
  sessionId?: string;
  content: string;
  attachments?: Array<string | Partial<QueueAttachment>>;
  kind?: QueuedMessageKind;
  executionModeOverride?: ExecutionMode;
  clientSubmissionId?: string;
  dedupeDoubleClick?: boolean;
  forceQueue?: boolean;
}

export interface SubmitQueueMessageResult {
  ok: boolean;
  mode?: 'started' | 'queued' | 'deduplicated';
  error?: string;
  item?: QueuedMessage;
  snapshot?: SessionQueueSnapshot;
}

export interface QueueMutationResult {
  ok: boolean;
  message?: string;
  error?: string;
  item?: QueuedMessage;
  snapshot: SessionQueueSnapshot;
}

export interface MessageQueueDependencies {
  sessionManager: SessionManager;
  orchestrator?: AgentOrchestrator;
  modelRegistry?: ModelProviderRegistry;
  changesManager?: ChangesManager;
  permissionManager?: PermissionManager;
  toolManager?: ToolManager;
  registry?: AgentRegistry;
  mcpHost?: McpHost;
  ollama?: OllamaClient;
  executor?: QueueTaskExecutor;
  capacity?: number;
  doubleClickWindowMs?: number;
}

interface ActiveSessionRun {
  runId: string;
  sessionId: string;
  executionId: string;
  itemId?: string;
  source: 'direct' | 'queued';
  abortController: AbortController;
  cancelling?: boolean;
  runner?: AgentOrchestrator;
}

interface InternalSessionQueue {
  paused: boolean;
  lastError?: string;
  justCompletedCycle: boolean;
  completedCount: number;
  items: QueuedMessage[];
  completedExecutionIds: Set<string>;
}

const DEFAULT_QUEUE_CAPACITY = 200;
const DEFAULT_DOUBLE_CLICK_WINDOW_MS = 350;
const MAX_RETAINED_HISTORY_ITEMS = 60;
const MAX_RETAINED_EXEC_IDS = 500;

const QUEUE_CONTROL_COMMANDS = new Set(['queue', 'q']);
const QUEUEABLE_EXECUTION_COMMANDS = new Set([
  'test',
  'review',
  'run',
  'undo',
  'redo',
  'plan',
  'agent',
  'ask',
  'compact',
]);

export function isQueueControlSlashCommand(rawInput: string): boolean {
  const parsed = parseSlashCommand(rawInput);
  return Boolean(parsed && QUEUE_CONTROL_COMMANDS.has(parsed.commandName));
}

export function isQueueableSlashCommand(rawInput: string): boolean {
  const parsed = parseSlashCommand(rawInput);
  return Boolean(parsed && QUEUEABLE_EXECUTION_COMMANDS.has(parsed.commandName));
}

export function extractMentionsFromText(text: string): string[] {
  const found = new Set<string>();
  const regex = /(?:^|\s)@([A-Za-z0-9._\-\/]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text || '')) !== null) {
    if (match[1]) {
      found.add(match[1]);
    }
  }
  return Array.from(found);
}

export function inferAttachmentType(rawPath: string, hint?: AttachmentType): AttachmentType {
  if (hint) return hint;
  const p = String(rawPath || '').trim();
  if (p.startsWith('git:')) return 'git';
  if (p.startsWith('terminal:')) return 'terminal';
  if (p.startsWith('codemap:')) return 'codemap';
  if (p.startsWith('plan:')) return 'plan';
  if (p.startsWith('conversation:')) return 'conversation';
  try {
    if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      return 'folder';
    }
  } catch {
    // fallback below
  }
  if (p.endsWith('/') || p.endsWith('\\')) return 'folder';
  return 'file';
}

export function normalizeQueueAttachments(
  rawAttachments: Array<string | Partial<QueueAttachment>> = [],
  content: string = ''
): QueueAttachment[] {
  const seen = new Set<string>();
  const out: QueueAttachment[] = [];

  for (const raw of rawAttachments || []) {
    if (!raw) continue;
    const rawPath = typeof raw === 'string' ? raw.trim() : String(raw.path || '').trim();
    if (!rawPath) continue;
    const key = rawPath;
    if (seen.has(key)) continue;
    seen.add(key);

    const type = inferAttachmentType(rawPath, typeof raw === 'string' ? undefined : raw.type);
    const label =
      (typeof raw !== 'string' && raw.label ? raw.label.trim() : '') ||
      (rawPath.includes(':') ? rawPath : path.basename(rawPath) || rawPath);
    out.push({
      id: (typeof raw !== 'string' && raw.id) || `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      path: rawPath,
      label,
      type,
    });
  }

  for (const mention of extractMentionsFromText(content)) {
    if (!seen.has(mention)) {
      seen.add(mention);
      out.push({
        id: `att_m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        path: mention,
        label: `@${mention}`,
        type: 'mention',
      });
    }
  }

  return out;
}

function attachmentsSignature(atts: QueueAttachment[]): string {
  return atts.map((a) => `${a.type}:${a.path}`).sort().join('|');
}

function makeQueueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export class MessageQueueManager {
  private static sharedInstance: MessageQueueManager | undefined;

  public static getOrCreateShared(deps: MessageQueueDependencies): MessageQueueManager {
    if (!MessageQueueManager.sharedInstance) {
      MessageQueueManager.sharedInstance = new MessageQueueManager(deps);
    } else {
      MessageQueueManager.sharedInstance.updateDependencies(deps);
    }
    return MessageQueueManager.sharedInstance;
  }

  public static getShared(): MessageQueueManager | undefined {
    return MessageQueueManager.sharedInstance;
  }

  public static resetShared(): void {
    MessageQueueManager.sharedInstance = undefined;
  }

  private deps: MessageQueueDependencies;
  private queues: Map<string, InternalSessionQueue> = new Map();
  private activeRuns: Map<string, ActiveSessionRun> = new Map();
  private startingExecutionIds: Set<string> = new Set();
  private drainingWorkers: Set<string> = new Set();
  private transitioningSessions: Set<string> = new Set();
  private seenClientSubmissionIds: Map<string, number> = new Map();
  private lastSubmissions: Map<string, { signature: string; timestamp: number; item?: QueuedMessage }> = new Map();
  private idleWaiters: Map<string, Array<() => void>> = new Map();
  private capacity: number;
  private doubleClickWindowMs: number;

  private _onDidChangeQueue = new vscode.EventEmitter<SessionQueueSnapshot>();
  public readonly onDidChangeQueue = this._onDidChangeQueue.event;

  private _onDidSessionEvent = new vscode.EventEmitter<SessionRuntimeEvent>();
  public readonly onDidSessionEvent = this._onDidSessionEvent.event;

  constructor(deps: MessageQueueDependencies) {
    this.deps = deps;
    let configuredCapacity = deps.capacity;
    if (configuredCapacity === undefined) {
      try {
        configuredCapacity = vscode.workspace.getConfiguration('localcoders').get<number>('queueCapacity');
      } catch {
        configuredCapacity = undefined;
      }
    }
    this.capacity = Math.max(1, Number(configuredCapacity) || DEFAULT_QUEUE_CAPACITY);
    this.doubleClickWindowMs = Math.max(0, deps.doubleClickWindowMs ?? DEFAULT_DOUBLE_CLICK_WINDOW_MS);

    this.hydrateFromSessions();
  }

  public updateDependencies(deps: Partial<MessageQueueDependencies>): void {
    const smChanged = deps.sessionManager && deps.sessionManager !== this.deps.sessionManager;
    this.deps = { ...this.deps, ...deps };
    if (deps.capacity !== undefined) {
      this.capacity = Math.max(1, deps.capacity);
    }
    if (smChanged) {
      this.hydrateFromSessions();
    }
  }

  public setCapacity(limit: number): void {
    this.capacity = Math.max(1, Math.floor(limit));
  }

  public getCapacity(): number {
    return this.capacity;
  }

  public isSessionBusy(sessionId: string): boolean {
    return this.activeRuns.has(sessionId) || this.drainingWorkers.has(sessionId);
  }

  public hasAnyActiveRun(): boolean {
    return this.activeRuns.size > 0;
  }

  public getActiveRunSessionIds(): string[] {
    return Array.from(this.activeRuns.keys());
  }

  private ensureQueueRecord(sessionId: string): InternalSessionQueue {
    let q = this.queues.get(sessionId);
    if (!q) {
      const persisted = this.deps.sessionManager?.getQueueState?.(sessionId);
      q = {
        paused: Boolean(persisted?.paused),
        lastError: persisted?.lastError,
        justCompletedCycle: false,
        completedCount: (persisted?.items || []).filter((i) => i.status === 'completed').length,
        items: Array.isArray(persisted?.items) ? persisted!.items.map((i) => ({ ...i })) : [],
        completedExecutionIds: new Set<string>(persisted?.completedExecutionIds || []),
      };
      this.queues.set(sessionId, q);
    }
    return q;
  }

  /**
   * Restores pending queue entries from persisted session files, preserving order and
   * converting any mid-flight 'processing' entries into safely resumable paused items
   * so crashes or restarts never lose messages or silently duplicate half-completed runs.
   */
  public hydrateFromSessions(): void {
    const rawSessions = this.deps.sessionManager?.getAllSessions?.();
    const sessions = Array.isArray(rawSessions) ? rawSessions : [];
    for (const s of sessions) {
      const persisted = s.queueState;
      const completedIds = new Set<string>(persisted?.completedExecutionIds || []);
      let paused = Boolean(persisted?.paused);
      let lastError = persisted?.lastError;
      let hadInterruption = false;

      const rawItems = Array.isArray(persisted?.items) ? persisted!.items : [];
      const sorted = rawItems
        .map((it) => ({
          ...it,
          sessionId: s.id,
          executionId: it.executionId || makeQueueId('exec'),
          attachments: Array.isArray(it.attachments) ? it.attachments : [],
        }))
        .sort((a, b) => (a.position - b.position) || (a.createdAt - b.createdAt));

      for (const it of sorted) {
        if (it.status === 'completed') {
          completedIds.add(it.executionId);
        } else if (it.status === 'processing') {
          // Was interrupted mid-execution when application closed or crashed
          it.status = 'queued';
          it.interruptedOnRestart = true;
          it.updatedAt = Date.now();
          hadInterruption = true;
        }
      }

      if (s.status === 'running' && !this.activeRuns.has(s.id)) {
        hadInterruption = hadInterruption || sorted.some((it) => it.status === 'queued');
        this.deps.sessionManager.updateSession(
          s.id,
          (sess) => {
            sess.status = 'cancelled';
            sess.activePhase = 'cancelled';
            sess.activePhaseSummary = 'Interrupted by restart';
            if (sess.activities) {
              sess.activities = finalizeRunningActivities(sess.activities, sess.activities.slice(-1)[0]?.runId || '', 'cancelled');
            }
          },
          { silent: true }
        );
      }

      if (hadInterruption) {
        paused = true;
        lastError =
          lastError ||
          'Previous session execution was interrupted before completion. Pending messages were restored safely — click Resume to continue.';
      }

      const queueRec: InternalSessionQueue = {
        paused,
        lastError,
        justCompletedCycle: false,
        completedCount: sorted.filter((i) => i.status === 'completed').length,
        items: sorted,
        completedExecutionIds: completedIds,
      };
      this.renumberQueuedPositions(queueRec);
      this.queues.set(s.id, queueRec);

      if (persisted || hadInterruption) {
        this.persistQueue(s.id, true);
      }
    }
  }

  private renumberQueuedPositions(q: InternalSessionQueue): void {
    const queued = q.items
      .filter((i) => i.status === 'queued')
      .sort((a, b) => (a.position - b.position) || (a.createdAt - b.createdAt));
    queued.forEach((it, idx) => {
      it.position = idx;
    });
  }

  private trimArchivedHistory(q: InternalSessionQueue): void {
    // Never remove queued, processing, or failed messages!
    const archived = q.items.filter((i) => i.status === 'completed' || i.status === 'cancelled');
    if (archived.length <= MAX_RETAINED_HISTORY_ITEMS) return;
    const dropCount = archived.length - MAX_RETAINED_HISTORY_ITEMS;
    const dropIds = new Set(archived.slice(0, dropCount).map((i) => i.id));
    q.items = q.items.filter((i) => !dropIds.has(i.id));
  }

  private persistQueue(sessionId: string, silent: boolean = false): void {
    const q = this.queues.get(sessionId);
    if (!q || !this.deps.sessionManager?.saveQueueState) return;
    this.trimArchivedHistory(q);
    const execIds = Array.from(q.completedExecutionIds).slice(-MAX_RETAINED_EXEC_IDS);
    const payload: PersistedQueueState = {
      paused: q.paused,
      lastError: q.lastError,
      items: q.items.map((i) => ({ ...i, attachments: [...(i.attachments || [])] })),
      completedExecutionIds: execIds,
    };
    this.deps.sessionManager.saveQueueState(sessionId, payload, { silent: true });
    if (!silent) {
      this.emitQueueSnapshot(sessionId);
    }
  }

  private computeState(sessionId: string, q: InternalSessionQueue): QueueEngineState {
    const activeRun = this.activeRuns.get(sessionId);
    const isActivelyRunning = Boolean(
      activeRun && !activeRun.cancelling && !activeRun.abortController.signal.aborted
    );
    if (this.transitioningSessions.has(sessionId)) {
      return 'processing_next';
    }
    if (isActivelyRunning || q.items.some((i) => i.status === 'processing')) {
      return 'running';
    }
    const hasFailed = q.items.some((i) => i.status === 'failed');
    const hasQueued = q.items.some((i) => i.status === 'queued');
    if (q.paused) {
      if (hasFailed && q.lastError) return 'failed';
      return 'paused';
    }
    if (hasQueued) {
      return 'queued';
    }
    if (hasFailed) {
      return 'failed';
    }
    if (q.justCompletedCycle) {
      return 'completed';
    }
    return 'idle';
  }

  public getSnapshot(sessionId: string): SessionQueueSnapshot {
    const q = this.ensureQueueRecord(sessionId);
    const activeRun = this.activeRuns.get(sessionId);
    const isActivelyRunning = Boolean(
      activeRun && !activeRun.cancelling && !activeRun.abortController.signal.aborted
    );
    const processingItem = q.items.find((i) => i.status === 'processing');
    const queuedItems = q.items
      .filter((i) => i.status === 'queued')
      .sort((a, b) => (a.position - b.position) || (a.createdAt - b.createdAt));
    const failedItems = q.items.filter((i) => i.status === 'failed');
    const processingList = processingItem ? [processingItem] : [];
    const visibleItems = [...processingList, ...failedItems, ...queuedItems].map((i) => ({
      ...i,
      attachments: [...(i.attachments || [])],
    }));

    return {
      sessionId,
      state: this.computeState(sessionId, q),
      paused: q.paused,
      activeItemId: processingItem?.id || (isActivelyRunning ? activeRun?.itemId || null : null),
      activeExecutionId: processingItem?.executionId || (isActivelyRunning ? activeRun?.executionId || null : null),
      isBusy: Boolean(isActivelyRunning || this.transitioningSessions.has(sessionId)),
      capacity: this.capacity,
      queuedCount: queuedItems.length,
      failedCount: failedItems.length,
      completedCount: q.completedCount,
      lastError: q.lastError,
      items: visibleItems,
    };
  }

  private emitQueueSnapshot(sessionId: string): SessionQueueSnapshot {
    const snapshot = this.getSnapshot(sessionId);
    this._onDidChangeQueue.fire(snapshot);
    this._onDidSessionEvent.fire({
      sessionId,
      type: 'queueUpdated',
      payload: snapshot,
    });
    return snapshot;
  }

  private checkIdleWaiters(sessionId: string): void {
    if (this.isSessionBusy(sessionId)) return;
    const waiters = this.idleWaiters.get(sessionId);
    if (!waiters || waiters.length === 0) return;
    this.idleWaiters.delete(sessionId);
    for (const resolve of waiters) {
      try {
        resolve();
      } catch {
        // ignore
      }
    }
  }

  public waitForQueueIdle(sessionId: string, timeoutMs: number = 30000): Promise<void> {
    if (!this.isSessionBusy(sessionId)) {
      const q = this.ensureQueueRecord(sessionId);
      const hasQueued = q.items.some((i) => i.status === 'queued');
      if (q.paused || !hasQueued) {
        return Promise.resolve();
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.idleWaiters.get(sessionId) || [];
        this.idleWaiters.set(
          sessionId,
          list.filter((fn) => fn !== onDone)
        );
        reject(new Error(`Timed out waiting for queue in session '${sessionId}' to become idle.`));
      }, timeoutMs);
      const onDone = () => {
        clearTimeout(timer);
        resolve();
      };
      const list = this.idleWaiters.get(sessionId) || [];
      list.push(onDone);
      this.idleWaiters.set(sessionId, list);
    });
  }

  private async resolveOrCreateSession(sessionId?: string, initialText: string = 'New Session'): Promise<SessionData> {
    if (sessionId) {
      const found = this.deps.sessionManager.getSession(sessionId);
      if (found) return found;
    }
    const active = this.deps.sessionManager.getActiveSession();
    if (active) return active;

    let firstModel: any;
    try {
      firstModel = await this.deps.modelRegistry?.getDefaultOrFirstAvailableModel();
    } catch {
      firstModel = undefined;
    }
    const modelId = firstModel?.id || '';
    return this.deps.sessionManager.createSession(initialText, modelId, {
      providerId: firstModel?.providerId || 'ollama',
      modelId,
      modelName: firstModel?.displayName || '',
    });
  }

  /**
   * Primary entrypoint from composers or commands.
   * Accepts unlimited submissions cleanly (within safety capacity), guarantees strict FIFO order,
   * prevents accidental double-clicks, and never lets two tasks run concurrently in one session.
   */
  public async submitMessage(params: SubmitQueueMessageParams): Promise<SubmitQueueMessageResult> {
    const content = String(params.content || '').trim();
    if (!content) {
      return { ok: false, error: 'Cannot submit an empty message.' };
    }

    if (params.clientSubmissionId) {
      const seenAt = this.seenClientSubmissionIds.get(params.clientSubmissionId);
      if (seenAt && Date.now() - seenAt < 60_000) {
        const sid = params.sessionId || this.deps.sessionManager.getActiveSession()?.id || '';
        return {
          ok: true,
          mode: 'deduplicated',
          snapshot: sid ? this.getSnapshot(sid) : undefined,
        };
      }
      this.seenClientSubmissionIds.set(params.clientSubmissionId, Date.now());
      if (this.seenClientSubmissionIds.size > 500) {
        const oldestKey = this.seenClientSubmissionIds.keys().next().value;
        if (oldestKey) this.seenClientSubmissionIds.delete(oldestKey);
      }
    }

    const session = await this.resolveOrCreateSession(params.sessionId, content);
    const sessionId = session.id;
    const q = this.ensureQueueRecord(sessionId);

    const attachments = normalizeQueueAttachments(
      params.attachments && params.attachments.length > 0
        ? params.attachments
        : session.config?.attachedFiles || [],
      content
    );
    const mentions = extractMentionsFromText(content);
    const signature = `${sessionId}::${content}::${attachmentsSignature(attachments)}`;

    if (params.dedupeDoubleClick) {
      const prev = this.lastSubmissions.get(sessionId);
      if (prev && prev.signature === signature && Date.now() - prev.timestamp < this.doubleClickWindowMs) {
        return {
          ok: true,
          mode: 'deduplicated',
          item: prev.item,
          snapshot: this.getSnapshot(sessionId),
        };
      }
    }

    const activeBacklogCount = q.items.filter(
      (i) => i.status === 'queued' || i.status === 'processing' || i.status === 'failed'
    ).length;
    if (activeBacklogCount >= this.capacity) {
      return {
        ok: false,
        error: `Queue capacity limit (${this.capacity}) reached for this session. Process, clear, or remove queued items before adding more.`,
        snapshot: this.getSnapshot(sessionId),
      };
    }

    const kind: QueuedMessageKind =
      params.kind || (isSlashCommandInput(content) ? 'slash_command' : 'prompt');

    const now = Date.now();
    const shouldQueue =
      Boolean(params.forceQueue) ||
      this.isSessionBusy(sessionId) ||
      q.paused ||
      q.items.some((i) => i.status === 'queued') ||
      this.computeState(sessionId, q) === 'failed';

    const maxPos = q.items
      .filter((i) => i.status === 'queued')
      .reduce((max, i) => Math.max(max, i.position), -1);

    const item: QueuedMessage = {
      id: makeQueueId('qm'),
      executionId: makeQueueId('exec'),
      sessionId,
      content,
      attachments,
      mentions: mentions.length > 0 ? mentions : undefined,
      kind,
      executionModeOverride: params.executionModeOverride,
      createdAt: now,
      updatedAt: now,
      position: shouldQueue ? maxPos + 1 : 0,
      status: shouldQueue ? 'queued' : 'processing',
      startedAt: shouldQueue ? undefined : now,
    };

    this.lastSubmissions.set(sessionId, { signature, timestamp: now, item });

    if (shouldQueue) {
      q.justCompletedCycle = false;
      q.items.push(item);
      this.renumberQueuedPositions(q);
      this.persistQueue(sessionId);
      // Do not wait; if session became idle right before push and isn't paused, trigger worker cleanly
      if (!q.paused && !this.isSessionBusy(sessionId) && this.computeState(sessionId, q) !== 'failed') {
        void this.drainQueue(sessionId);
      }
      return {
        ok: true,
        mode: 'queued',
        item: { ...item },
        snapshot: this.getSnapshot(sessionId),
      };
    }

    // Immediate execution synchronously claims the active session slot BEFORE any await
    // so rapid back-to-back submissions 1ms later deterministically queue instead of racing!
    q.justCompletedCycle = false;
    q.lastError = undefined;
    q.items.push(item);
    this.startingExecutionIds.add(item.executionId);
    const runId = makeQueueId('qrun');
    const abortController = new AbortController();
    this.activeRuns.set(sessionId, {
      runId,
      sessionId,
      executionId: item.executionId,
      itemId: item.id,
      source: 'queued',
      abortController,
    });
    this.persistQueue(sessionId);

    // Run immediately then continue draining any queued follow-ups in strict FIFO order
    void this.executeAndDrainLoop(sessionId, item);

    return {
      ok: true,
      mode: 'started',
      item: { ...item },
      snapshot: this.getSnapshot(sessionId),
    };
  }

  private async executeAndDrainLoop(sessionId: string, initialItem: QueuedMessage): Promise<void> {
    if (this.drainingWorkers.has(sessionId)) return;
    this.drainingWorkers.add(sessionId);
    const q = this.ensureQueueRecord(sessionId);

    try {
      await this.executeSingleItem(sessionId, initialItem);
      await this.drainRemainingItems(sessionId);
    } finally {
      this.startingExecutionIds.delete(initialItem.executionId);
      this.activeRuns.delete(sessionId);
      this.transitioningSessions.delete(sessionId);
      this.drainingWorkers.delete(sessionId);
      if (!q.paused && !q.items.some((i) => i.status === 'queued' || i.status === 'failed') && q.completedCount > 0) {
        q.justCompletedCycle = true;
      }
      this.persistQueue(sessionId);
      this.checkIdleWaiters(sessionId);
    }
  }

  public async drainQueue(sessionId: string): Promise<void> {
    if (this.drainingWorkers.has(sessionId) || this.activeRuns.has(sessionId)) {
      return;
    }
    const q = this.ensureQueueRecord(sessionId);
    if (q.paused) return;

    this.drainingWorkers.add(sessionId);
    try {
      await this.drainRemainingItems(sessionId);
    } finally {
      this.activeRuns.delete(sessionId);
      this.transitioningSessions.delete(sessionId);
      this.drainingWorkers.delete(sessionId);
      if (!q.paused && !q.items.some((i) => i.status === 'queued' || i.status === 'failed') && q.completedCount > 0) {
        q.justCompletedCycle = true;
      }
      this.persistQueue(sessionId);
      this.checkIdleWaiters(sessionId);
    }
  }

  private async drainRemainingItems(sessionId: string): Promise<void> {
    const q = this.ensureQueueRecord(sessionId);

    while (true) {
      if (q.paused) break;

      const nextItem = q.items
        .filter((i) => i.status === 'queued')
        .sort((a, b) => (a.position - b.position) || (a.createdAt - b.createdAt))[0];

      if (!nextItem) break;

      // Idempotency guard against duplicate execution of an already completed executionId
      if (q.completedExecutionIds.has(nextItem.executionId) || this.startingExecutionIds.has(nextItem.executionId)) {
        nextItem.status = 'completed';
        nextItem.completedAt = nextItem.completedAt || Date.now();
        this.renumberQueuedPositions(q);
        this.persistQueue(sessionId);
        continue;
      }

      // Transition state briefly to processing_next and yield microtask so pause/delete/reorder can take effect
      this.transitioningSessions.add(sessionId);
      this.emitQueueSnapshot(sessionId);
      await Promise.resolve();
      this.transitioningSessions.delete(sessionId);

      // Re-verify state after yield
      if (q.paused) {
        this.emitQueueSnapshot(sessionId);
        break;
      }

      const revalidated = q.items
        .filter((i) => i.status === 'queued')
        .sort((a, b) => (a.position - b.position) || (a.createdAt - b.createdAt))[0];
      if (!revalidated) break;
      if (q.completedExecutionIds.has(revalidated.executionId) || this.startingExecutionIds.has(revalidated.executionId)) {
        continue;
      }

      this.startingExecutionIds.add(revalidated.executionId);
      revalidated.status = 'processing';
      revalidated.startedAt = Date.now();
      revalidated.updatedAt = Date.now();
      revalidated.interruptedOnRestart = false;
      revalidated.error = undefined;
      q.lastError = undefined;
      q.justCompletedCycle = false;

      const runId = makeQueueId('qrun');
      const abortController = new AbortController();
      this.activeRuns.set(sessionId, {
        runId,
        sessionId,
        executionId: revalidated.executionId,
        itemId: revalidated.id,
        source: 'queued',
        abortController,
      });
      this.renumberQueuedPositions(q);
      this.persistQueue(sessionId);

      const outcome = await this.executeSingleItem(sessionId, revalidated);

      this.startingExecutionIds.delete(revalidated.executionId);
      this.activeRuns.delete(sessionId);

      if (outcome === 'failed' || outcome === 'cancelled' || q.paused) {
        break;
      }
    }
  }

  private async executeSingleItem(sessionId: string, item: QueuedMessage): Promise<QueuedMessageStatus> {
    const q = this.ensureQueueRecord(sessionId);
    const activeRun = this.activeRuns.get(sessionId);
    const runId = activeRun?.runId || makeQueueId('qrun');
    const abortController = activeRun?.abortController || new AbortController();

    // Always reload FRESH session state, config, history, and workspace changes when this item begins
    let session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      item.status = 'failed';
      item.error = `Target session '${sessionId}' no longer exists.`;
      item.completedAt = Date.now();
      q.paused = true;
      q.lastError = item.error;
      this.persistQueue(sessionId);
      return 'failed';
    }

    const workspaceRoot =
      session.workspaceRoot && fs.existsSync(session.workspaceRoot)
        ? session.workspaceRoot
        : this.deps.orchestrator?.getWorkspaceRoot?.() || process.cwd();

    if (session.title === 'New Session' || session.title === 'New Section') {
      const newTitle = item.content.length > 36 ? item.content.substring(0, 36).trim() + '...' : item.content;
      this.deps.sessionManager.renameSession(sessionId, newTitle);
      session = this.deps.sessionManager.getSession(sessionId) || session;
    }

    // Handle slash commands when dequeued or executed cleanly without sending to LLM
    if (item.kind === 'slash_command' || isSlashCommandInput(item.content)) {
      await this.executeSlashItem(sessionId, session, item, workspaceRoot, abortController.signal);
      return item.status;
    }

    const userMsg: AgentMessage = {
      id: `usr_${item.id}_${Date.now()}`,
      senderId: 'user',
      senderName: 'You',
      senderRole: 'user',
      content: item.content,
      timestamp: Date.now(),
    };

    this.deps.sessionManager.updateSession(sessionId, (s) => {
      s.messages.push(userMsg);
      s.status = 'running';
      s.activePhase = 'analyzing';
      s.activePhaseSummary = getSafePhaseLabel('analyzing');
      s.planExplicit = false;
    });
    this._onDidSessionEvent.fire({
      sessionId,
      type: 'addMessage',
      payload: userMsg,
    });

    // Gather fresh workspace & git change state AFTER previous tasks finished
    let workspaceDeltaNote = '';
    if (this.deps.changesManager) {
      try {
        this.deps.changesManager.setWorkspace(workspaceRoot);
        await this.deps.changesManager.refresh();
        const summary = await this.deps.changesManager.getSummary();
        if (summary && summary.files && summary.files.length > 0) {
          const list = summary.files
            .slice(0, 20)
            .map((f) => `- [${f.status}] ${f.path}`)
            .join('\n');
          workspaceDeltaNote = `\n\nCURRENT WORKSPACE MODIFIED/CREATED FILES:\n${list}`;
        }
      } catch {
        // non-fatal
      }
    }

    // Re-read fresh session config & history after persisting userMsg
    session = this.deps.sessionManager.getSession(sessionId) || session;
    const mergedAttachmentPaths = Array.from(
      new Set([
        ...(session.config?.attachedFiles || []),
        ...(item.attachments || []).map((a) => a.path),
      ])
    );

    const effectiveConfig: AgentSessionConfig = {
      ...(session.config || {
        providerId: 'ollama',
        modelId: session.model || '',
        reasoningEffort: 'medium',
        fastMode: false,
        executionMode: 'code',
        permissionMode: 'smart',
      }),
      executionMode: item.executionModeOverride || session.config?.executionMode || 'code',
      attachedFiles: mergedAttachmentPaths,
    };

    const rawHistory = (session.messages || []).map((m) => ({
      role: m.senderRole,
      content: m.content,
    }));
    const freshHistory = sanitizeConversationHistory(rawHistory, item.content);
    const freshPrompt = workspaceDeltaNote ? `${item.content}${workspaceDeltaNote}` : item.content;

    try {
      let result: { ok: boolean; cancelled?: boolean; error?: string; summary?: string };

      if (this.deps.executor) {
        result = await this.deps.executor(item, {
          sessionId,
          session,
          freshPrompt,
          attachments: item.attachments || [],
          effectiveConfig,
          history: freshHistory,
          workspaceRoot,
          abortSignal: abortController.signal,
        });
      } else {
        result = await this.runWithOrchestrator(
          sessionId,
          runId,
          freshPrompt,
          effectiveConfig,
          freshHistory,
          workspaceRoot,
          abortController
        );
      }

      if (abortController.signal.aborted || result.cancelled) {
        const hasQueued = q.items.some((i) => i.status === 'queued');
        item.status = 'cancelled';
        item.error = result.error || 'Execution cancelled by user.';
        item.completedAt = Date.now();
        item.updatedAt = Date.now();
        q.paused = hasQueued;
        q.lastError = hasQueued ? (q.lastError || item.error) : undefined;
        this.finalizeSessionStatus(sessionId, runId, 'cancelled');
        this.persistQueue(sessionId);
        return 'cancelled';
      }

      if (!result.ok) {
        item.status = 'failed';
        item.error = result.error || 'Task failed during execution.';
        item.completedAt = Date.now();
        item.updatedAt = Date.now();
        q.paused = true;
        q.lastError = item.error;
        this.finalizeSessionStatus(sessionId, runId, 'failed');
        this.persistQueue(sessionId);
        return 'failed';
      }

      item.status = 'completed';
      item.error = undefined;
      item.interruptedOnRestart = false;
      item.completedAt = Date.now();
      item.updatedAt = Date.now();
      q.completedCount += 1;
      q.completedExecutionIds.add(item.executionId);
      q.lastError = undefined;
      this.finalizeSessionStatus(sessionId, runId, 'completed');
      this.persistQueue(sessionId);
      return 'completed';
    } catch (err: any) {
      const msg = err?.message || String(err);
      const isCancelled = Boolean(abortController.signal.aborted || /cancel|abort/i.test(msg));
      const hasQueued = q.items.some((i) => i.status === 'queued');
      item.status = isCancelled ? 'cancelled' : 'failed';
      item.error = msg;
      item.completedAt = Date.now();
      item.updatedAt = Date.now();
      q.paused = isCancelled ? hasQueued : true;
      q.lastError = isCancelled ? (hasQueued ? (q.lastError || msg) : undefined) : msg;
      this.finalizeSessionStatus(sessionId, runId, isCancelled ? 'cancelled' : 'failed');
      this.persistQueue(sessionId);
      return item.status;
    }
  }

  private finalizeSessionStatus(
    sessionId: string,
    runId: string,
    terminalStatus: 'completed' | 'failed' | 'cancelled'
  ): void {
    this.deps.sessionManager.updateSession(sessionId, (s) => {
      s.status = terminalStatus;
      s.activePhase = undefined;
      s.activePhaseSummary = undefined;
      if (s.activities) {
        s.activities = finalizeRunningActivities(s.activities, runId, terminalStatus);
      }
    });
    this._onDidSessionEvent.fire({
      sessionId,
      type: 'runFinished',
      payload: { status: terminalStatus, runId },
    });
  }

  private async runWithOrchestrator(
    sessionId: string,
    localRunId: string,
    prompt: string,
    config: AgentSessionConfig,
    history: Array<{ role: string; content: string }>,
    workspaceRoot: string,
    abortController: AbortController
  ): Promise<{ ok: boolean; cancelled?: boolean; error?: string; summary?: string }> {
    const baseOrch = this.deps.orchestrator;
    if (!baseOrch) {
      return { ok: false, error: 'Orchestrator is not configured.' };
    }

    const runner =
      typeof (baseOrch as any).createScopedRunner === 'function'
        ? baseOrch.createScopedRunner(workspaceRoot)
        : baseOrch;

    runner.setWorkspace?.(workspaceRoot);
    this.deps.permissionManager?.setWorkspace(workspaceRoot);
    this.deps.mcpHost?.setWorkspace(workspaceRoot);
    const activeRun = this.activeRuns.get(sessionId);
    if (activeRun) {
      activeRun.runner = runner;
    }

    const subs: Array<{ dispose(): void }> = [];
    let currentRunnerRunId = localRunId;
    const onAbort = () => {
      runner.cancelTask();
    };
    abortController.signal.addEventListener('abort', onAbort, { once: true });

    try {
      if (typeof runner.onMessage === 'function') {
        subs.push(
          runner.onMessage((msg: AgentMessage) => {
            if (msg.senderRole === 'user') return;
            this.deps.sessionManager.updateSession(
              sessionId,
              (s) => {
                if (!s.messages.some((m) => m.id === msg.id)) {
                  s.messages.push(msg);
                }
              },
              { silent: true }
            );
            this._onDidSessionEvent.fire({ sessionId, type: 'addMessage', payload: msg });
          })
        );
      }

      if (typeof runner.onStreamEvent === 'function') {
        subs.push(
          runner.onStreamEvent((ev: AgentStreamEvent) => {
            if (ev.runId) currentRunnerRunId = ev.runId;
            switch (ev.kind) {
              case 'status':
                this.deps.sessionManager.updateSession(
                  sessionId,
                  (s) => {
                    s.activePhase = ev.phase;
                    s.activePhaseSummary = ev.summary;
                    if (ev.phase === 'completed' || ev.phase === 'failed' || ev.phase === 'cancelled') {
                      s.activities = finalizeRunningActivities(s.activities || [], currentRunnerRunId, ev.phase);
                      if (s.status === 'running') s.status = ev.phase;
                    }
                  },
                  { silent: true }
                );
                this._onDidSessionEvent.fire({ sessionId, type: 'streamStatus', payload: ev });
                break;

              case 'message_delta':
                this._onDidSessionEvent.fire({ sessionId, type: 'messageDelta', payload: ev });
                break;

              case 'message_complete': {
                const msg = (ev as any).message as AgentMessage | undefined;
                if (msg && msg.id && msg.senderRole !== 'user') {
                  this.deps.sessionManager.updateSession(
                    sessionId,
                    (s) => {
                      if (!s.messages.some((m) => m.id === msg.id)) {
                        s.messages.push(msg);
                      }
                    },
                    { silent: true }
                  );
                  this._onDidSessionEvent.fire({ sessionId, type: 'addMessage', payload: msg });
                }
                break;
              }

              case 'activity_upsert':
                this.deps.sessionManager.updateSession(
                  sessionId,
                  (s) => {
                    s.activities = upsertActivityItem(s.activities || [], ev.item);
                  },
                  { silent: true }
                );
                this._onDidSessionEvent.fire({ sessionId, type: 'activityUpsert', payload: ev.item });
                if (ev.item.category === 'file' && ev.item.status === 'completed') {
                  this.deps.changesManager?.refresh().catch(() => {});
                }
                break;

              case 'plan':
                this.deps.sessionManager.updateSession(
                  sessionId,
                  (s) => {
                    s.plan = ev.plan;
                    s.planExplicit = ev.explicit;
                  },
                  { silent: true }
                );
                this._onDidSessionEvent.fire({
                  sessionId,
                  type: 'planUpdate',
                  payload: { plan: ev.plan, explicit: ev.explicit },
                });
                break;
            }
          })
        );
      }

      const task: AgentTask = await runner.submitTask(prompt, config, history);
      if (task.status === 'cancelled' || abortController.signal.aborted) {
        return { ok: false, cancelled: true, error: task.error || 'Execution cancelled.' };
      }
      if (task.status === 'failed') {
        return { ok: false, error: task.error || 'Agent execution failed.' };
      }
      return { ok: true, summary: task.title };
    } finally {
      abortController.signal.removeEventListener('abort', onAbort);
      for (const s of subs) {
        try {
          s.dispose();
        } catch {
          // ignore
        }
      }
    }
  }

  private async executeSlashItem(
    sessionId: string,
    session: SessionData,
    item: QueuedMessage,
    workspaceRoot: string,
    abortSignal: AbortSignal
  ): Promise<void> {
    const q = this.ensureQueueRecord(sessionId);
    if (!this.deps.orchestrator || !this.deps.modelRegistry) {
      item.status = 'failed';
      item.error = 'Slash execution dependencies unavailable.';
      q.paused = true;
      q.lastError = item.error;
      this.persistQueue(sessionId);
      return;
    }

    const previousActive = this.deps.sessionManager.getActiveSession()?.id;
    // Switch target cleanly only if needed for slash command workspace runner
    if (previousActive && previousActive !== sessionId) {
      this.deps.sessionManager.switchSession(sessionId);
    }

    try {
      const res: CommandResult = await runSlashCommandForWorkspace({
        rawInput: item.content,
        confirmed: true,
        abortSignal,
        workspaceRoot,
        viewMode: 'agent',
        orchestrator: this.deps.orchestrator,
        sessionManager: this.deps.sessionManager,
        modelRegistry: this.deps.modelRegistry,
        permissionManager: this.deps.permissionManager,
        changesManager: this.deps.changesManager,
        toolManager: this.deps.toolManager,
        mcpHost: this.deps.mcpHost,
        registry: this.deps.registry,
        ollama: this.deps.ollama,
      });

      this._onDidSessionEvent.fire({
        sessionId,
        type: 'slashCommandResult',
        payload: res,
      });

      if (res.status === 'cancelled' || abortSignal.aborted) {
        item.status = 'cancelled';
        item.error = res.message || 'Slash command cancelled.';
        item.completedAt = Date.now();
        q.paused = true;
        q.lastError = item.error;
        this.persistQueue(sessionId);
        return;
      }

      if (!res.ok && res.status === 'error') {
        item.status = 'failed';
        item.error = res.message || 'Slash command failed.';
        item.completedAt = Date.now();
        q.paused = true;
        q.lastError = item.error;
        this.persistQueue(sessionId);
        return;
      }

      item.status = 'completed';
      item.completedAt = Date.now();
      q.completedCount += 1;
      q.completedExecutionIds.add(item.executionId);
      q.lastError = undefined;
      this.persistQueue(sessionId);
    } finally {
      if (previousActive && previousActive !== sessionId && this.deps.sessionManager.getSession(previousActive)) {
        this.deps.sessionManager.switchSession(previousActive);
      }
    }
  }

  public editQueuedMessage(
    sessionId: string,
    itemId: string,
    newContent: string,
    newAttachments?: Array<string | Partial<QueueAttachment>>
  ): QueueMutationResult {
    const q = this.ensureQueueRecord(sessionId);
    const trimmed = String(newContent || '').trim();
    if (!trimmed) {
      return {
        ok: false,
        error: 'Message content cannot be empty.',
        snapshot: this.getSnapshot(sessionId),
      };
    }

    const item = q.items.find((i) => i.id === itemId);
    if (!item) {
      return {
        ok: false,
        error: 'Queued message not found.',
        snapshot: this.getSnapshot(sessionId),
      };
    }
    if (item.status === 'processing') {
      return {
        ok: false,
        error: 'Cannot edit this message because it is already processing.',
        snapshot: this.getSnapshot(sessionId),
      };
    }
    if (item.status === 'completed') {
      return {
        ok: false,
        error: 'Cannot edit an already completed message.',
        snapshot: this.getSnapshot(sessionId),
      };
    }

    item.content = trimmed;
    item.updatedAt = Date.now();
    item.mentions = extractMentionsFromText(trimmed);
    item.kind = isSlashCommandInput(trimmed) ? 'slash_command' : 'prompt';
    if (newAttachments !== undefined) {
      item.attachments = normalizeQueueAttachments(newAttachments, trimmed);
    } else {
      // Revalidate existing attachments + updated mentions cleanly
      const preserved = (item.attachments || []).filter((a) => a.type !== 'mention');
      item.attachments = normalizeQueueAttachments(preserved, trimmed);
    }

    this.persistQueue(sessionId);
    return {
      ok: true,
      message: 'Queued message updated.',
      item: { ...item },
      snapshot: this.getSnapshot(sessionId),
    };
  }

  public deleteQueuedMessage(sessionId: string, itemId: string): QueueMutationResult {
    const q = this.ensureQueueRecord(sessionId);
    const idx = q.items.findIndex((i) => i.id === itemId);
    if (idx === -1) {
      return {
        ok: false,
        error: 'Queued message not found.',
        snapshot: this.getSnapshot(sessionId),
      };
    }
    const target = q.items[idx];
    if (target.status === 'processing') {
      return {
        ok: false,
        error: 'Cannot delete this message because it is currently executing. Wait for it to finish or stop the active task first.',
        snapshot: this.getSnapshot(sessionId),
      };
    }

    q.items.splice(idx, 1);
    this.renumberQueuedPositions(q);
    const hasFailed = q.items.some((i) => i.status === 'failed');
    const hasQueued = q.items.some((i) => i.status === 'queued');
    if (!hasFailed) {
      q.lastError = undefined;
      if (!hasQueued && !this.isSessionBusy(sessionId)) {
        q.paused = false;
      }
    }
    this.persistQueue(sessionId);
    return {
      ok: true,
      message: 'Removed message from queue.',
      snapshot: this.getSnapshot(sessionId),
    };
  }

  public moveQueuedMessage(
    sessionId: string,
    itemId: string,
    directionOrTargetIndex: 'up' | 'down' | number
  ): QueueMutationResult {
    const q = this.ensureQueueRecord(sessionId);
    const item = q.items.find((i) => i.id === itemId);
    if (!item) {
      return {
        ok: false,
        error: 'Queued message not found.',
        snapshot: this.getSnapshot(sessionId),
      };
    }
    if (item.status !== 'queued') {
      return {
        ok: false,
        error: `Cannot reorder message while its status is '${item.status}'.`,
        snapshot: this.getSnapshot(sessionId),
      };
    }

    const queued = q.items
      .filter((i) => i.status === 'queued')
      .sort((a, b) => (a.position - b.position) || (a.createdAt - b.createdAt));
    const currentIndex = queued.findIndex((i) => i.id === itemId);
    if (currentIndex === -1) {
      return { ok: false, error: 'Queued item missing from order.', snapshot: this.getSnapshot(sessionId) };
    }

    let nextIndex = currentIndex;
    if (directionOrTargetIndex === 'up') {
      nextIndex = Math.max(0, currentIndex - 1);
    } else if (directionOrTargetIndex === 'down') {
      nextIndex = Math.min(queued.length - 1, currentIndex + 1);
    } else {
      nextIndex = Math.max(0, Math.min(queued.length - 1, Math.floor(directionOrTargetIndex)));
    }

    if (nextIndex !== currentIndex) {
      const [moved] = queued.splice(currentIndex, 1);
      queued.splice(nextIndex, 0, moved);
      queued.forEach((entry, idx) => {
        entry.position = idx;
      });
      this.persistQueue(sessionId);
    }

    return {
      ok: true,
      message: 'Queue order updated.',
      item: { ...item },
      snapshot: this.getSnapshot(sessionId),
    };
  }

  /**
   * Moves an item to the front of the queue safely without interrupting an actively running task
   * unless interruptCurrent=true is explicitly requested. Starts immediately if session is idle.
   */
  public async sendNow(
    sessionId: string,
    itemId: string,
    options?: { interruptCurrent?: boolean }
  ): Promise<QueueMutationResult> {
    const q = this.ensureQueueRecord(sessionId);
    const item = q.items.find((i) => i.id === itemId);
    if (!item) {
      return {
        ok: false,
        error: 'Queued message not found.',
        snapshot: this.getSnapshot(sessionId),
      };
    }
    if (item.status === 'processing') {
      return {
        ok: true,
        message: 'This message is already executing.',
        item: { ...item },
        snapshot: this.getSnapshot(sessionId),
      };
    }
    if (item.status === 'completed') {
      return {
        ok: false,
        error: 'This message has already completed.',
        snapshot: this.getSnapshot(sessionId),
      };
    }

    // If failed/cancelled, re-queue cleanly with a fresh executionId so idempotency lets it run
    if (item.status === 'failed' || item.status === 'cancelled') {
      item.status = 'queued';
      item.executionId = makeQueueId('exec');
      item.error = undefined;
      item.updatedAt = Date.now();
    }

    // Put target item at position 0 (front of queue)
    const others = q.items
      .filter((i) => i.status === 'queued' && i.id !== item.id)
      .sort((a, b) => (a.position - b.position) || (a.createdAt - b.createdAt));
    item.position = 0;
    others.forEach((other, idx) => {
      other.position = idx + 1;
    });

    if (this.isSessionBusy(sessionId)) {
      if (options?.interruptCurrent) {
        const active = this.activeRuns.get(sessionId);
        active?.abortController.abort();
        active?.runner?.cancelTask();
        q.paused = false;
        this.persistQueue(sessionId);
        return {
          ok: true,
          message: 'Stopping active task and scheduling this message next.',
          item: { ...item },
          snapshot: this.getSnapshot(sessionId),
        };
      }
      q.paused = false;
      this.persistQueue(sessionId);
      return {
        ok: true,
        message: 'Moved to front of queue — will execute immediately after the current task completes without interrupting it.',
        item: { ...item },
        snapshot: this.getSnapshot(sessionId),
      };
    }

    // Session is idle -> unpause and run immediately
    q.paused = false;
    q.lastError = undefined;
    this.persistQueue(sessionId);
    void this.drainQueue(sessionId);

    return {
      ok: true,
      message: 'Started executing message now.',
      item: { ...item },
      snapshot: this.getSnapshot(sessionId),
    };
  }

  public pauseQueue(sessionId: string, reason?: string): QueueMutationResult {
    const q = this.ensureQueueRecord(sessionId);
    q.paused = true;
    if (reason) q.lastError = reason;
    this.persistQueue(sessionId);
    return {
      ok: true,
      message: this.isSessionBusy(sessionId)
        ? 'Queue paused. The active task will finish, and pending queued messages will wait until resumed.'
        : 'Queue execution paused.',
      snapshot: this.getSnapshot(sessionId),
    };
  }

  private requeueFailedOrTargetItems(q: InternalSessionQueue, targets: QueuedMessage[]): void {
    if (targets.length === 0) return;
    const targetIds = new Set(targets.map((t) => t.id));
    const remainingQueued = q.items
      .filter((i) => i.status === 'queued' && !targetIds.has(i.id))
      .sort((a, b) => (a.position - b.position) || (a.createdAt - b.createdAt));
    const now = Date.now();
    targets.forEach((item, idx) => {
      item.status = 'queued';
      item.executionId = makeQueueId('exec');
      item.error = undefined;
      item.completedAt = undefined;
      item.updatedAt = now;
      item.position = idx;
    });
    remainingQueued.forEach((other, idx) => {
      other.position = targets.length + idx;
    });
  }

  public resumeQueue(sessionId: string): QueueMutationResult {
    const q = this.ensureQueueRecord(sessionId);
    const failedItems = q.items.filter((i) => i.status === 'failed');
    if (failedItems.length > 0) {
      // Re-queue failed items at the front so clicking Resume after a failure retries and continues cleanly
      this.requeueFailedOrTargetItems(q, failedItems);
    }
    q.paused = false;
    q.justCompletedCycle = false;
    q.lastError = undefined;
    this.persistQueue(sessionId);
    if (!this.isSessionBusy(sessionId) && q.items.some((i) => i.status === 'queued')) {
      void this.drainQueue(sessionId);
    }
    return {
      ok: true,
      message: failedItems.length > 0
        ? 'Retrying failed message and resuming queue execution.'
        : 'Queue execution resumed.',
      snapshot: this.getSnapshot(sessionId),
    };
  }

  public retryQueuedMessage(sessionId: string, itemId: string): QueueMutationResult {
    const q = this.ensureQueueRecord(sessionId);
    const item = q.items.find((i) => i.id === itemId);
    if (!item) {
      return {
        ok: false,
        error: 'Queued message not found.',
        snapshot: this.getSnapshot(sessionId),
      };
    }
    if (item.status === 'processing') {
      return {
        ok: false,
        error: 'Message is already processing.',
        snapshot: this.getSnapshot(sessionId),
      };
    }

    // Place retried item at the front of remaining queued items so it runs next cleanly
    this.requeueFailedOrTargetItems(q, [item]);

    q.paused = false;
    q.lastError = undefined;
    q.justCompletedCycle = false;
    this.persistQueue(sessionId);

    if (!this.isSessionBusy(sessionId)) {
      void this.drainQueue(sessionId);
    }
    return {
      ok: true,
      message: 'Queued message reset for retry.',
      item: { ...item },
      snapshot: this.getSnapshot(sessionId),
    };
  }

  public skipQueuedMessage(sessionId: string, itemId?: string): QueueMutationResult {
    const q = this.ensureQueueRecord(sessionId);
    let target: QueuedMessage | undefined;

    if (itemId) {
      target = q.items.find((i) => i.id === itemId);
    } else {
      // Skip next blocking item: first failed item if paused by failure, else oldest queued item
      target =
        q.items.find((i) => i.status === 'failed') ||
        q.items
          .filter((i) => i.status === 'queued')
          .sort((a, b) => (a.position - b.position) || (a.createdAt - b.createdAt))[0];
    }

    if (!target) {
      return {
        ok: false,
        error: 'No pending or failed message in the queue to skip.',
        snapshot: this.getSnapshot(sessionId),
      };
    }
    if (target.status === 'processing') {
      return {
        ok: false,
        error: 'Cannot skip an actively processing message. Stop the active task first.',
        snapshot: this.getSnapshot(sessionId),
      };
    }

    target.status = 'cancelled';
    target.error = target.error ? `${target.error} (Skipped)` : 'Skipped by user';
    target.completedAt = Date.now();
    target.updatedAt = Date.now();
    this.renumberQueuedPositions(q);

    const stillHasFailed = q.items.some((i) => i.status === 'failed');
    if (!stillHasFailed) {
      q.lastError = undefined;
    }

    const hasRemaining = q.items.some((i) => i.status === 'queued');
    // Unpause if queue was paused because of a failed item or becomes empty after skipping it
    if (!stillHasFailed && (hasRemaining || !this.isSessionBusy(sessionId))) {
      q.paused = false;
    }

    this.persistQueue(sessionId);
    if (!q.paused && hasRemaining && !this.isSessionBusy(sessionId)) {
      void this.drainQueue(sessionId);
    }

    return {
      ok: true,
      message: 'Skipped queued message.',
      item: { ...target },
      snapshot: this.getSnapshot(sessionId),
    };
  }

  public clearQueue(sessionId: string, options?: { includeFailed?: boolean }): QueueMutationResult {
    const q = this.ensureQueueRecord(sessionId);
    const keepStatuses = new Set<QueuedMessageStatus>(['processing', 'completed', 'cancelled']);
    if (!options?.includeFailed) {
      keepStatuses.add('failed');
    }

    const beforeCount = q.items.filter((i) => !keepStatuses.has(i.status)).length;
    q.items = q.items.filter((i) => keepStatuses.has(i.status));
    q.justCompletedCycle = false;
    const stillHasFailed = q.items.some((i) => i.status === 'failed');
    const stillHasQueued = q.items.some((i) => i.status === 'queued');
    if (options?.includeFailed || !stillHasFailed) {
      q.lastError = undefined;
    }
    if (!stillHasFailed && !stillHasQueued && !this.isSessionBusy(sessionId)) {
      q.paused = false;
    }
    this.persistQueue(sessionId);

    return {
      ok: true,
      message: `Cleared ${beforeCount} queued message(s).`,
      snapshot: this.getSnapshot(sessionId),
    };
  }

  public cancelActiveTask(sessionId?: string): void {
    const targets = sessionId
      ? [sessionId]
      : Array.from(new Set([...this.activeRuns.keys(), ...this.queues.keys()]));
    for (const sid of targets) {
      const q = this.ensureQueueRecord(sid);
      const run = this.activeRuns.get(sid);
      if (run) {
        run.cancelling = true;
        run.abortController.abort();
        run.runner?.cancelTask();
      }
      this.deps.orchestrator?.cancelTask();

      const processingItem = q.items.find((i) => i.status === 'processing');
      if (processingItem) {
        processingItem.status = 'cancelled';
        processingItem.error = 'Execution cancelled by user.';
        processingItem.completedAt = Date.now();
        processingItem.updatedAt = Date.now();
      }
      const hasRemainingQueued = q.items.some((i) => i.status === 'queued');
      q.paused = hasRemainingQueued;
      q.lastError = hasRemainingQueued
        ? 'Active task cancelled; remaining queued messages were paused cleanly.'
        : undefined;
      this.finalizeSessionStatus(sid, run?.runId || '', 'cancelled');
      this.persistQueue(sid);
    }
  }
}

/**
 * Shared handler for webview `queueAction` IPC messages across both Agent View and IDE Chat View.
 */
export async function handleQueueActionCommand(
  queueManager: MessageQueueManager,
  sessionId: string,
  data: any
): Promise<QueueMutationResult> {
  const action = String(data?.action || '').trim();
  const itemId = String(data?.itemId || '').trim();

  switch (action) {
    case 'stopActive':
      queueManager.cancelActiveTask(sessionId);
      return {
        ok: true,
        message: 'Active task cancelled.',
        snapshot: queueManager.getSnapshot(sessionId),
      };
    case 'pause':
      return queueManager.pauseQueue(sessionId);
    case 'resume':
      return queueManager.resumeQueue(sessionId);
    case 'clear':
      return queueManager.clearQueue(sessionId, { includeFailed: Boolean(data?.includeFailed ?? true) });
    case 'skip':
      return queueManager.skipQueuedMessage(sessionId, itemId || undefined);
    case 'sendNow':
      return queueManager.sendNow(sessionId, itemId, { interruptCurrent: Boolean(data?.interruptCurrent) });
    case 'edit':
      return queueManager.editQueuedMessage(sessionId, itemId, String(data?.content || ''), data?.attachments);
    case 'delete':
      return queueManager.deleteQueuedMessage(sessionId, itemId);
    case 'moveUp':
      return queueManager.moveQueuedMessage(sessionId, itemId, 'up');
    case 'moveDown':
      return queueManager.moveQueuedMessage(sessionId, itemId, 'down');
    case 'retry':
      return queueManager.retryQueuedMessage(sessionId, itemId);
    default:
      return {
        ok: false,
        error: `Unknown queue action '${action}'.`,
        snapshot: queueManager.getSnapshot(sessionId),
      };
  }
}
