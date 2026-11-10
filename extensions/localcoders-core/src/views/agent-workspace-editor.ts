import * as vscode from 'vscode';
import * as fs from 'fs';
import { getLucideCss, getLucideClientScript, lucideSvg } from './lucide-icons';
import * as path from 'path';
import { AgentOrchestrator } from '../agents/orchestrator';
import { AgentRegistry } from '../agents/agent-registry';
import { McpHost } from '../mcp/mcp-host';
import { AgentMessage, TaskPlanItem, ToolApprovalRequest } from '../agents/types';
import { SessionManager, SessionData, ExecutionGroup, AgentSessionConfig, ExecutionMode, PermissionMode } from '../sessions/session-manager';
import { OllamaClient } from '../ollama/client';
import { collectLiveSystemTelemetry, LiveSystemTelemetry } from '../ollama/hardware';
import { ChangesManager, ChangesSummary } from '../context/changes-manager';
import { ModelProviderRegistry, ModelMetadata, ReasoningEffort } from '../models/model-provider-registry';
import { getModelSelectorStyles, getModelSelectorMarkup, getModelSelectorScript } from './model-selector-ui';
import { getActivityStreamStyles, getActivityClientScript, inspectorTabIcon } from './activity-stream-ui';
import { getSessionsBarStyles, getSessionsBarClientScript, getUserProfileBadgeMarkup } from './sessions-bar-ui';
import { getQueuePanelStyles, getQueuePanelMarkup, getQueuePanelClientScript } from './queue-panel-ui';
import { CockpitModalType, getCockpitModalStyles, getCockpitModalMarkup, getCockpitModalScript } from './agent-cockpit-modals';
import {
  MessageQueueManager,
  handleQueueActionCommand,
  isQueueControlSlashCommand,
  isQueueableSlashCommand,
} from '../sessions/message-queue';
import { ToolManager } from '../tools/tool-manager';
import { PermissionManager, SecurityMode } from '../security/permission-manager';
import { TerminalSessionManager } from '../tools/terminal-session-manager';
import { upsertActivityItem, finalizeRunningActivities, getSafePhaseLabel } from '../agents/events';
import {
  SlashCommandRegistry,
  ensureBuiltinSlashCommandsRegistered,
  runSlashCommandForWorkspace,
  isSlashCommandInput,
  getSlashCommandStyles,
  getSlashCommandPopupMarkup,
  getSlashCommandClientScript,
  CommandResult,
} from '../commands';

export class AgentWorkspaceEditorPanel {
  public static currentPanel: AgentWorkspaceEditorPanel | undefined;
  public static readonly viewType = 'localcoders.agentWorkspace';
  private static _registry?: AgentRegistry;
  private static _mcpHost?: McpHost;
  private static _queueManager?: MessageQueueManager;
  public static onDidDisposeUnexpected?: () => void;
  private static _closingInternally = false;

  public static configureServices(
    registry?: AgentRegistry,
    mcpHost?: McpHost,
    queueManager?: MessageQueueManager
  ): void {
    AgentWorkspaceEditorPanel._registry = registry;
    AgentWorkspaceEditorPanel._mcpHost = mcpHost;
    if (queueManager) {
      AgentWorkspaceEditorPanel._queueManager = queueManager;
    }
  }

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _telemetryTimer?: NodeJS.Timeout;
  private _telemetryInFlight = false;
  private readonly queueManager: MessageQueueManager;

  public static createOrShow(
    extensionUri: vscode.Uri,
    orchestrator: AgentOrchestrator,
    sessionManager: SessionManager,
    ollama: OllamaClient,
    changesManager: ChangesManager,
    modelRegistry?: ModelProviderRegistry,
    toolManager?: ToolManager,
    permissionManager?: PermissionManager,
    queueManager?: MessageQueueManager
  ): AgentWorkspaceEditorPanel {
    const column = vscode.ViewColumn.One;

    if (AgentWorkspaceEditorPanel.currentPanel) {
      AgentWorkspaceEditorPanel.currentPanel._panel.reveal(column);
      AgentWorkspaceEditorPanel.currentPanel.syncActiveSession();
      return AgentWorkspaceEditorPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      AgentWorkspaceEditorPanel.viewType,
      'LocalCoders Agent Workspace',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    AgentWorkspaceEditorPanel.currentPanel = new AgentWorkspaceEditorPanel(
      panel,
      extensionUri,
      orchestrator,
      sessionManager,
      ollama,
      changesManager,
      modelRegistry,
      toolManager,
      permissionManager,
      queueManager
    );
    return AgentWorkspaceEditorPanel.currentPanel;
  }

  public static closeCurrent(): void {
    if (AgentWorkspaceEditorPanel.currentPanel) {
      AgentWorkspaceEditorPanel._closingInternally = true;
      try {
        AgentWorkspaceEditorPanel.currentPanel._panel.dispose();
        AgentWorkspaceEditorPanel.currentPanel = undefined;
      } finally {
        AgentWorkspaceEditorPanel._closingInternally = false;
      }
    }
  }

  private _isDisposed = false;

  private postMessageSafe(data: any): void {
    if (this._isDisposed) return;
    try {
      this._panel.webview.postMessage(data);
    } catch {
      // Safely ignore if webview was disposed
    }
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly orchestrator: AgentOrchestrator,
    private readonly sessionManager: SessionManager,
    private readonly ollama: OllamaClient,
    private readonly changesManager: ChangesManager,
    private readonly modelRegistry: ModelProviderRegistry = ModelProviderRegistry.getInstance(),
    private readonly toolManager?: ToolManager,
    private readonly permissionManager?: PermissionManager,
    queueManager?: MessageQueueManager
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this.queueManager =
      queueManager ||
      AgentWorkspaceEditorPanel._queueManager ||
      MessageQueueManager.getOrCreateShared({
        sessionManager: this.sessionManager,
        orchestrator: this.orchestrator,
        modelRegistry: this.modelRegistry,
        changesManager: this.changesManager,
        permissionManager: this.permissionManager,
        toolManager: this.toolManager,
        mcpHost: AgentWorkspaceEditorPanel._mcpHost,
        registry: AgentWorkspaceEditorPanel._registry,
        ollama: this.ollama,
      });

    this._panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'resources', 'icon.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'resources', 'icon.svg'),
    };

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.onDidChangeViewState(
      () => {
        if (this._panel.visible) {
          this.syncActiveSession();
        }
      },
      null,
      this._disposables
    );

    const terminalManager = TerminalSessionManager.getInstance();
    const rootDir = this.getActiveWorkspaceRoot();
    if (rootDir) {
      terminalManager.setDefaultCwd(rootDir);
    }
    terminalManager.ensureDefaultTab(rootDir);
    this._disposables.push(
      terminalManager.onDidChange((tabs) => {
        this.postMessageSafe({ type: 'terminalTabs', tabs });
      })
    );

    this._telemetryTimer = setInterval(() => {
      if (this._panel.visible && !this._isDisposed) {
        this.pushSystemTelemetry().catch(() => {});
      }
    }, 4000);

    // Track message & stream updates strictly scoped to whichever session matches the active UI session
    this._disposables.push(
      this.queueManager.onDidSessionEvent((ev) => {
        const activeId = this.sessionManager.getActiveSession()?.id;
        if (activeId && ev.sessionId !== activeId) {
          return;
        }
        switch (ev.type) {
          case 'queueUpdated':
            this.postMessageSafe({ type: 'queueUpdated', snapshot: ev.payload });
            break;
          case 'addMessage':
            this.postMessageSafe({ type: 'addMessage', message: ev.payload });
            this.updateTitle();
            break;
          case 'messageDelta':
            this.postMessageSafe({ type: 'messageDelta', event: ev.payload });
            break;
          case 'streamStatus':
            this.postMessageSafe({ type: 'streamStatus', event: ev.payload });
            break;
          case 'activityUpsert':
            this.postMessageSafe({ type: 'activityUpsert', item: ev.payload });
            break;
          case 'planUpdate':
            this.postMessageSafe({ type: 'planUpdate', plan: ev.payload?.plan || [], explicit: Boolean(ev.payload?.explicit) });
            break;
          case 'runFinished':
            this.syncActiveSession();
            break;
          case 'slashCommandResult':
            this.postMessageSafe({ type: 'slashCommandResult', result: ev.payload });
            this.syncActiveSession();
            break;
        }
      })
    );

    this._disposables.push(
      this.orchestrator.onApproval((req) => {
        this.postMessageSafe({ type: 'approvalRequest', request: req });
      })
    );

    // Session manager events
    this._disposables.push(
      this.sessionManager.onDidChangeSessions(() => {
        this.syncActiveSession();
        this.updateTitle();
      })
    );

    // Changes manager events
    this._disposables.push(
      this.changesManager.onDidChangeChanges((summary) => {
        this.postMessageSafe({ type: 'changesSummary', summary });
      })
    );

    // Model registry events
    this._disposables.push(
      this.modelRegistry.onDidChangeModels(() => {
        this.syncActiveSession();
      })
    );

    this._panel.webview.onDidReceiveMessage(
      async (data) => {
        switch (data.command) {
          case 'runSlashCommand':
          case 'confirmSlashCommand': {
            const rawCmd = String(data.text || '').trim();
            if (!rawCmd) return;
            const confirmed = data.command === 'confirmSlashCommand' || !!data.confirmed;
            const activeSess = this.sessionManager.getActiveSession();
            if (
              !confirmed &&
              !isQueueControlSlashCommand(rawCmd) &&
              isQueueableSlashCommand(rawCmd) &&
              activeSess &&
              this.queueManager.isSessionBusy(activeSess.id)
            ) {
              const qRes = await this.queueManager.submitMessage({
                sessionId: activeSess.id,
                content: rawCmd,
                kind: 'slash_command',
                attachments: Array.isArray(data.attachments) ? data.attachments : undefined,
                clientSubmissionId: data.clientSubmissionId,
                dedupeDoubleClick: true,
              });
              if (!qRes.ok) {
                this.postMessageSafe({ type: 'queueActionError', error: qRes.error || 'Unable to queue command.' });
                return;
              }
              if (qRes.mode === 'queued' && qRes.snapshot) {
                this.postMessageSafe({ type: 'queueUpdated', snapshot: qRes.snapshot });
                this.postMessageSafe({
                  type: 'slashCommandResult',
                  result: {
                    id: `cmd_q_${Date.now()}`,
                    command: 'queue',
                    rawInput: rawCmd,
                    ok: true,
                    status: 'info',
                    title: `Queued ${rawCmd}`,
                    message: `Added '${rawCmd}' to the queue at position #${qRes.snapshot.queuedCount}. It will execute after current tasks complete.`,
                    timestamp: Date.now(),
                  },
                });
              }
              return;
            }
            await this.executeSlashCommand(rawCmd, confirmed);
            return;
          }

          case 'sendMessage': {
            const text = data.text?.trim();
            if (!text) return;
            const activeSess = this.sessionManager.getActiveSession();

            // Queue-control commands ALWAYS execute immediately; other slash commands execute immediately when idle
            if (isQueueControlSlashCommand(text)) {
              await this.executeSlashCommand(text, false);
              return;
            }
            if (isSlashCommandInput(text)) {
              if (activeSess && this.queueManager.isSessionBusy(activeSess.id) && isQueueableSlashCommand(text)) {
                const qRes = await this.queueManager.submitMessage({
                  sessionId: activeSess.id,
                  content: text,
                  kind: 'slash_command',
                  attachments: Array.isArray(data.attachments) ? data.attachments : undefined,
                  clientSubmissionId: data.clientSubmissionId,
                  dedupeDoubleClick: true,
                });
                if (!qRes.ok) {
                  this.postMessageSafe({ type: 'queueActionError', error: qRes.error || 'Unable to queue command.' });
                } else if (qRes.snapshot) {
                  this.postMessageSafe({ type: 'queueUpdated', snapshot: qRes.snapshot });
                }
                return;
              }
              await this.executeSlashCommand(text, false);
              return;
            }

            const prevCount = this.sessionManager.getAllSessions().length;
            this.applyWorkingFolder(this.getActiveWorkspaceRoot());
            const submitRes = await this.queueManager.submitMessage({
              sessionId: activeSess?.id,
              content: text,
              attachments: Array.isArray(data.attachments) ? data.attachments : undefined,
              clientSubmissionId: data.clientSubmissionId,
              dedupeDoubleClick: true,
            });
            if (!submitRes.ok) {
              this.postMessageSafe({
                type: 'queueActionError',
                error: submitRes.error || 'Failed to add message to queue.',
              });
              if (submitRes.snapshot) {
                this.postMessageSafe({ type: 'queueUpdated', snapshot: submitRes.snapshot });
              }
              return;
            }
            if (submitRes.snapshot) {
              this.postMessageSafe({ type: 'queueUpdated', snapshot: submitRes.snapshot });
            }
            if (this.sessionManager.getAllSessions().length !== prevCount || !activeSess) {
              await this.syncActiveSession();
            } else {
              this.updateTitle();
            }
            break;
          }

          case 'cancelTask':
          case 'stopTask': {
            this._slashAbortController?.abort();
            this._slashAbortController = undefined;
            const activeSess = this.sessionManager.getActiveSession();
            this.queueManager.cancelActiveTask(activeSess?.id);
            this.orchestrator.cancelTask();
            if (activeSess) {
              this.postMessageSafe({ type: 'queueUpdated', snapshot: this.queueManager.getSnapshot(activeSess.id) });
            }
            this.postMessageSafe({ type: 'runFinished', status: 'cancelled' });
            await this.syncActiveSession();
            break;
          }

          case 'queueAction': {
            const activeSess = this.sessionManager.getActiveSession();
            if (!activeSess) {
              this.postMessageSafe({ type: 'queueActionError', error: 'No active session available.' });
              break;
            }
            const res = await handleQueueActionCommand(this.queueManager, activeSess.id, data);
            this.postMessageSafe({ type: 'queueUpdated', snapshot: res.snapshot });
            if (data?.action === 'stopActive') {
              this.orchestrator.cancelTask();
              this.postMessageSafe({ type: 'runFinished', status: 'cancelled' });
              await this.syncActiveSession();
            } else if (!res.ok && res.error) {
              this.postMessageSafe({ type: 'queueActionError', error: res.error });
            }
            break;
          }

          case 'resolveApproval':
          case 'approveTool':
            this.orchestrator.resolveApproval(data.requestId, data.approved !== undefined ? data.approved : true);
            break;

          case 'rejectTool':
            this.orchestrator.resolveApproval(data.requestId, false);
            break;

          case 'switchSession': {
            this.sessionManager.switchSession(data.sessionId);
            const switched = this.sessionManager.getActiveSession();
            if (switched?.workspaceRoot && fs.existsSync(switched.workspaceRoot)) {
              this.applyWorkingFolder(switched.workspaceRoot);
            }
            this.syncActiveSession();
            break;
          }

          case 'newSession':
          case 'newSection': {
            const firstAvailable = await this.modelRegistry.getDefaultOrFirstAvailableModel();
            const model = firstAvailable?.id || '';
            this.sessionManager.createSession('New Session', model, {
              providerId: firstAvailable?.providerId || 'ollama',
              modelId: model,
              modelName: firstAvailable?.displayName || '',
            });
            await this.syncActiveSession();
            break;
          }

          case 'renameSession': {
            if (!data.sessionId) break;
            const providedTitle = typeof data.title === 'string' ? data.title.trim() : '';
            if (providedTitle) {
              this.sessionManager.renameSession(data.sessionId, providedTitle);
              this.syncActiveSession();
              break;
            }
            const s = this.sessionManager.getSession(data.sessionId);
            const newTitle = await vscode.window.showInputBox({
              prompt: 'Rename session',
              value: s?.title || '',
            });
            if (newTitle && newTitle.trim()) {
              this.sessionManager.renameSession(data.sessionId, newTitle.trim());
              this.syncActiveSession();
            }
            break;
          }

          case 'deleteSession': {
            if (!data.sessionId) break;
            if (data.confirmed === true) {
              this.sessionManager.deleteSession(data.sessionId);
              await this.syncActiveSession();
              break;
            }
            const confirm = await vscode.window.showWarningMessage(
              'Delete this coding session?',
              { modal: true },
              'Delete'
            );
            if (confirm === 'Delete') {
              this.sessionManager.deleteSession(data.sessionId);
              await this.syncActiveSession();
            }
            break;
          }

          case 'refreshModels': {
            await this.modelRegistry.refreshAll(true);
            await this.syncActiveSession();
            break;
          }

          case 'openModelManager': {
            await this.openCockpitModal('models');
            break;
          }

          case 'selectModel': {
            const modelId = data.modelId;
            if (!modelId) {
              const models = await this.modelRegistry.getAvailableModels();
              const picked = await vscode.window.showQuickPick(
                models.map(m => ({
                  label: m.displayName,
                  description: `${m.providerName} | ${m.contextWindow ? Math.round(m.contextWindow / 1024) + 'k ctx' : 'Context: Unknown'} | ${m.availability}`,
                  id: m.id,
                  provider: m.providerId,
                })),
                { placeHolder: models.length > 0 ? 'Select discovered model' : 'No models discovered — configure Ollama or Cloud providers' }
              );
              if (picked) {
                const pickedMeta = await this.modelRegistry.getModelById(picked.id);
                this.sessionManager.updateActiveConfig((cfg) => {
                  cfg.modelId = picked.id;
                  cfg.modelName = picked.label;
                  cfg.providerId = picked.provider;
                  if (pickedMeta?.reasoningEffortsSupported?.length && !pickedMeta.reasoningEffortsSupported.includes(cfg.reasoningEffort)) {
                    cfg.reasoningEffort = pickedMeta.defaultReasoningEffort || pickedMeta.reasoningEffortsSupported[0];
                  }
                });
                await this.modelRegistry.recordModelUsage(picked.id);
                await this.syncActiveSession();
              }
              return;
            }
            const model = await this.modelRegistry.getModelById(modelId);
            this.sessionManager.updateActiveConfig((cfg) => {
              cfg.modelId = model?.id || modelId;
              cfg.modelName = model?.displayName || data.modelName || modelId;
              if (model?.providerId || data.provider) cfg.providerId = model?.providerId || data.provider;
              if (model?.reasoningEffortsSupported?.length && !model.reasoningEffortsSupported.includes(cfg.reasoningEffort)) {
                cfg.reasoningEffort = model.defaultReasoningEffort || model.reasoningEffortsSupported[0];
              }
            });
            await this.modelRegistry.recordModelUsage(model?.id || modelId);
            await this.syncActiveSession();
            break;
          }

          case 'setModelRuntimeParams': {
            this.sessionManager.updateActiveConfig((cfg) => {
              cfg.temperature = typeof data.temperature === 'number' ? data.temperature : undefined;
              cfg.maxOutputTokens = typeof data.maxOutputTokens === 'number' ? data.maxOutputTokens : undefined;
              cfg.contextLimit = typeof data.contextLimit === 'number' ? data.contextLimit : undefined;
            });
            await this.syncActiveSession();
            break;
          }

          case 'setReasoningEffort': {
            if (data.effort) {
              this.sessionManager.updateActiveConfig((cfg) => {
                cfg.reasoningEffort = data.effort;
              });
              this.syncActiveSession();
            }
            break;
          }

          case 'setFastMode': {
            this.sessionManager.updateActiveConfig((cfg) => {
              cfg.fastMode = !!data.fastMode;
            });
            this.syncActiveSession();
            break;
          }

          case 'setExecutionMode': {
            if (data.executionMode) {
              this.sessionManager.updateActiveConfig((cfg) => {
                cfg.executionMode = data.executionMode;
              });
              this.syncActiveSession();
            }
            break;
          }

          case 'setPermissionMode': {
            if (data.permissionMode) {
              this.sessionManager.updateActiveConfig((cfg) => {
                cfg.permissionMode = data.permissionMode;
              });
              if (this.permissionManager) {
                this.permissionManager.setMode(data.permissionMode);
              }
              try {
                await vscode.workspace.getConfiguration('localcoders').update('defaultPermissionMode', data.permissionMode, vscode.ConfigurationTarget.Global);
              } catch {}
              this.syncActiveSession();
            }
            break;
          }

          case 'toggleFavorite': {
            if (data.modelId) {
              await this.modelRegistry.toggleFavorite(data.modelId);
              this.syncActiveSession();
            }
            break;
          }

          case 'searchModels': {
            const query = data.query || '';
            const modelsGrouped = await this.modelRegistry.getGroupedModels(query);
            this.postMessageSafe({
              type: 'modelsGroupedResponse',
              modelsGrouped,
              query,
            });
            break;
          }

          case 'attachFiles': {
            const files = await vscode.window.showOpenDialog({
              canSelectFiles: true,
              canSelectFolders: false,
              canSelectMany: true,
              openLabel: 'Attach to Agent Context',
            });
            if (files && files.length > 0) {
              for (const f of files) {
                this.sessionManager.attachFileToActiveSession(f.fsPath);
              }
              this.syncActiveSession();
            }
            break;
          }

          case 'quickFile': {
            const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 50);
            if (files.length === 0) {
              vscode.window.showInformationMessage('No files found in workspace.');
              return;
            }
            const picked = await vscode.window.showQuickPick(
              files.map((f) => ({
                label: path.basename(f.fsPath),
                description: vscode.workspace.asRelativePath(f.fsPath),
                fsPath: f.fsPath,
              })),
              { placeHolder: 'Select file to attach to agent context' }
            );
            if (picked) {
              this.sessionManager.attachFileToActiveSession(picked.fsPath);
              this.syncActiveSession();
            }
            break;
          }

          case 'quickDirectory': {
            const folders = await vscode.window.showOpenDialog({
              canSelectFiles: false,
              canSelectFolders: true,
              canSelectMany: false,
              openLabel: 'Attach Directory to Agent',
            });
            if (folders && folders.length > 0) {
              this.sessionManager.attachFileToActiveSession(folders[0].fsPath);
              this.syncActiveSession();
            }
            break;
          }

          case 'attachGit': {
            this.sessionManager.attachFileToActiveSession('git:changes');
            this.syncActiveSession();
            vscode.window.showInformationMessage('Attached active Git status & changes to agent context.');
            break;
          }

          case 'attachTerminal': {
            this.sessionManager.attachFileToActiveSession('terminal:output');
            this.syncActiveSession();
            vscode.window.showInformationMessage('Attached recent terminal output to agent context.');
            break;
          }

          case 'attachCodemap': {
            this.sessionManager.attachFileToActiveSession('codemap:workspace');
            this.syncActiveSession();
            vscode.window.showInformationMessage('Attached codebase structure map to agent context.');
            break;
          }

          case 'removeAttachment': {
            if (data.filePath) {
              this.sessionManager.removeAttachmentFromActiveSession(data.filePath);
              this.syncActiveSession();
            }
            break;
          }

          case 'openRules': {
            await this.openCockpitModal('rules');
            break;
          }

          case 'openSkills': {
            await this.openCockpitModal('agents');
            break;
          }

          case 'getFileDiff': {
            const diff = await this.changesManager.getFileDiff(data.path);
            this.postMessageSafe({
              type: 'fileDiffResponse',
              path: data.path,
              diff,
            });
            break;
          }

          case 'openDiff':
            // Disabled in Agent Mode so external VS Code diff tabs never open.
            break;

          case 'acceptAll':
            await this.changesManager.acceptAll();
            break;

          case 'rejectAll':
            await this.changesManager.rejectAll();
            break;

          case 'acceptFile':
            await this.changesManager.acceptFile(data.path);
            break;

          case 'rejectFile':
            await this.changesManager.rejectFile(data.path);
            break;

          case 'reviewCritic':
            vscode.commands.executeCommand('localcoders.reviewGitChanges');
            break;

          case 'switchToIde':
            vscode.commands.executeCommand('localcoders.activateIDEView');
            break;

          case 'openSecurity':
            await this.openCockpitModal('settings');
            break;

          case 'openReview':
            this.postMessageSafe({ type: 'switchInspectorTab', tab: 'changes' });
            break;

          case 'openWiki':
            await this.openCockpitModal('rules');
            break;

          case 'openAgents':
            await this.openCockpitModal('agents');
            break;

          case 'openMcp':
            await this.openCockpitModal('mcp');
            break;

          case 'loadCockpitModal':
            await this.openCockpitModal((data.modalType || 'settings') as CockpitModalType, data.statusText);
            break;

          case 'cockpitRefreshModels':
            await this.modelRegistry.refreshAll(true);
            await this.syncActiveSession();
            await this.openCockpitModal('models', 'Model discovery refreshed.');
            break;

          case 'cockpitSetOllamaEndpoint': {
            const res = await this.modelRegistry.setOllamaEndpoint(data.url || '');
            await this.syncActiveSession();
            await this.openCockpitModal('models', res.ok ? 'Connected to Ollama endpoint.' : (res.error || 'Failed to connect to Ollama endpoint.'));
            break;
          }

          case 'cockpitPullOllamaModel': {
            const tag = String(data.modelName || '').trim();
            if (tag) {
              try {
                await this.ollama.pullModel(tag, () => {});
                await this.modelRegistry.refreshAll(true);
                await this.syncActiveSession();
                await this.openCockpitModal('models', `Pulled ${tag} successfully.`);
              } catch (err: any) {
                await this.openCockpitModal('models', `Pull failed: ${err?.message || String(err)}`);
              }
            }
            break;
          }

          case 'cockpitSaveProviderKey': {
            if (data.providerId && data.apiKey) {
              const res = await this.modelRegistry.setProviderApiKey(data.providerId, data.apiKey);
              await this.syncActiveSession();
              await this.openCockpitModal('models', res.ok ? `${data.providerId} connected.` : (res.error || 'Provider validation failed.'));
            }
            break;
          }

          case 'cockpitToggleCritic': {
            const reg = AgentWorkspaceEditorPanel._registry;
            if (reg) {
              const curr = reg.getCriticConfig();
              reg.setCriticConfig({ enabled: !curr.enabled });
            }
            await this.openCockpitModal((data.returnModal || 'agents') as CockpitModalType);
            break;
          }

          case 'cockpitUpdateCritic': {
            const reg = AgentWorkspaceEditorPanel._registry;
            if (reg) {
              const updates: any = {};
              if (typeof data.model === 'string') {
                updates.model = data.model.trim();
              }
              if (typeof data.strictness === 'string' && ['lenient', 'moderate', 'strict', 'paranoid'].includes(data.strictness)) {
                updates.strictness = data.strictness;
              }
              reg.setCriticConfig(updates);
            }
            if (typeof data.maxCycles === 'number' && !Number.isNaN(data.maxCycles)) {
              const cfg = vscode.workspace.getConfiguration('localcoders');
              const val = Math.max(0, Math.floor(data.maxCycles));
              await cfg.update('maxCriticCycles', val, vscode.ConfigurationTarget.Global);
            }
            await this.openCockpitModal('agents', 'Critic Agent configuration updated.');
            break;
          }

          case 'cockpitAddSubagent': {
            const reg = AgentWorkspaceEditorPanel._registry;
            const name = String(data.name || '').trim();
            if (reg && name) {
              const roleName = String(data.role || 'Backend Developer');
              const roles = AgentRegistry.getPredefinedRoles();
              const matched = roles.find((r) => r.role === roleName);
              const model = typeof data.model === 'string' ? data.model.trim() : '';
              const customPrompt = typeof data.systemPrompt === 'string' ? data.systemPrompt.trim() : '';
              reg.addSubagent({
                id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                name,
                role: roleName as any,
                model,
                systemPrompt: customPrompt || matched?.defaultPrompt || `You are ${name}, specializing in ${roleName}.`,
                enabled: true,
                maxConcurrency: 1,
                temperature: 0.2,
                contextWindow: 32768,
              });
            }
            await this.openCockpitModal('agents', name ? `Subagent "${name}" added.` : undefined);
            break;
          }

          case 'cockpitUpdateSubagent': {
            const reg = AgentWorkspaceEditorPanel._registry;
            const id = String(data.id || '').trim();
            if (reg && id) {
              const updates: any = {};
              if (typeof data.model === 'string') {
                updates.model = data.model.trim();
              }
              if (typeof data.systemPrompt === 'string') {
                const promptText = data.systemPrompt.trim();
                const current = reg.getManageableSubagents(true).find((s) => s.id === id);
                const roleDefault = current
                  ? AgentRegistry.getPredefinedRoles().find((r) => r.role === current.role)?.defaultPrompt
                  : undefined;
                updates.systemPrompt = promptText || roleDefault || `You are a specialized ${current?.role || 'Subagent'}.`;
              }
              reg.updateSubagent(id, updates);
            }
            await this.openCockpitModal('agents', 'Subagent configuration updated.');
            break;
          }

          case 'cockpitToggleSubagent': {
            const reg = AgentWorkspaceEditorPanel._registry;
            const id = String(data.id || '').trim();
            if (reg && id) {
              const current = reg.getManageableSubagents(true).find((s) => s.id === id);
              if (current) {
                reg.updateSubagent(id, { enabled: !current.enabled });
              }
            }
            await this.openCockpitModal('agents');
            break;
          }

          case 'cockpitRemoveSubagent': {
            const reg = AgentWorkspaceEditorPanel._registry;
            const id = String(data.id || '').trim();
            if (reg && id) {
              reg.removeSubagent(id);
            }
            await this.openCockpitModal('agents', 'Subagent updated.');
            break;
          }

          case 'cockpitAddMcpServer': {
            const mcp = AgentWorkspaceEditorPanel._mcpHost;
            const name = String(data.name || '').trim();
            const target = String(data.target || '').trim();
            if (mcp && name && target) {
              const id = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
              if (data.transport === 'sse') {
                await mcp.addServer({ id, name, transport: 'sse', url: target, enabled: true });
              } else {
                const parts = target.split(/\s+/);
                await mcp.addServer({ id, name, transport: 'stdio', command: parts[0], args: parts.slice(1), enabled: true });
              }
            }
            await this.openCockpitModal('mcp');
            break;
          }

          case 'cockpitRemoveMcpServer': {
            const mcp = AgentWorkspaceEditorPanel._mcpHost;
            if (mcp && data.id) {
              await mcp.removeServer(data.id);
            }
            await this.openCockpitModal('mcp');
            break;
          }

          case 'cockpitSaveRules': {
            const wsRoot = this.getActiveWorkspaceRoot();
            if (wsRoot) {
              const dirPath = path.join(wsRoot, '.localcoders');
              const rulesPath = path.join(dirPath, 'rules.md');
              fs.mkdirSync(dirPath, { recursive: true });
              fs.writeFileSync(rulesPath, String(data.content || ''), 'utf8');
            }
            await this.openCockpitModal('rules', 'Saved .localcoders/rules.md');
            break;
          }

          case 'cockpitUpdateSetting': {
            if (data.key) {
              await vscode.workspace.getConfiguration('localcoders').update(data.key, data.value, vscode.ConfigurationTarget.Global);
            }
            await this.openCockpitModal('settings');
            break;
          }

          case 'selectWorkspace': {
            const currentRoot = this.getActiveWorkspaceRoot();
            const picked = await vscode.window.showOpenDialog({
              canSelectFiles: false,
              canSelectFolders: true,
              canSelectMany: false,
              defaultUri: currentRoot ? vscode.Uri.file(currentRoot) : undefined,
              openLabel: 'Use Folder for Agent',
              title: 'Select Workspace Folder for Agent',
            });
            const selectedRoot = picked?.[0]?.fsPath;
            if (selectedRoot) {
              this.sessionManager.setTargetWorkspaceRoot(selectedRoot);
              this.applyWorkingFolder(selectedRoot);
              await this.syncActiveSession();
            }
            break;
          }

          case 'createTerminalTab': {
            const cwd = this.getActiveWorkspaceRoot();
            terminalManager.createTab(cwd);
            break;
          }

          case 'closeTerminalTab':
            if (data.tabId) terminalManager.closeTab(data.tabId);
            break;

          case 'clearTerminalTab':
            if (data.tabId) terminalManager.clearTab(data.tabId);
            break;

          case 'runTerminalCommand': {
            const shellCmd = data.cmd !== undefined ? data.cmd : data.input;
            if (data.tabId && shellCmd !== undefined) {
              terminalManager.runCommand(data.tabId, shellCmd);
            }
            break;
          }

          case 'terminateTerminalTab':
            if (data.tabId) terminalManager.terminateTab(data.tabId);
            break;

          case 'refreshSystemTelemetry':
            await this.pushSystemTelemetry();
            break;
        }
      },
      null,
      this._disposables
    );

    this.syncActiveSession();
  }

  private getActiveWorkspaceRoot(): string {
    const sessionRoot = this.sessionManager.getActiveSession()?.workspaceRoot;
    if (sessionRoot && fs.existsSync(sessionRoot)) {
      return sessionRoot;
    }
    return this.orchestrator.getWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  }

  private applyWorkingFolder(targetRoot: string): void {
    this.orchestrator.setWorkspace(targetRoot);
    this.changesManager.setWorkspace(targetRoot);
    this.permissionManager?.setWorkspace(targetRoot);
    AgentWorkspaceEditorPanel._mcpHost?.setWorkspace(targetRoot);
    TerminalSessionManager.getInstance().setDefaultCwd(targetRoot);
  }

  public updateTitle(): void {
    const active = this.sessionManager.getActiveSession();
    if (active) {
      this._panel.title = `${active.title}`;
    } else {
      this._panel.title = 'Agent Workspace';
    }
  }

  private _slashAbortController?: AbortController;

  private async executeSlashCommand(rawInput: string, confirmed: boolean): Promise<void> {
    const workspaceRoot = this.getActiveWorkspaceRoot();
    this.applyWorkingFolder(workspaceRoot);
    this._slashAbortController?.abort();
    const abortController = new AbortController();
    this._slashAbortController = abortController;

    const result = await runSlashCommandForWorkspace({
      rawInput,
      confirmed,
      abortSignal: abortController.signal,
      workspaceRoot,
      viewMode: 'agent',
      orchestrator: this.orchestrator,
      sessionManager: this.sessionManager,
      modelRegistry: this.modelRegistry,
      permissionManager: this.permissionManager,
      changesManager: this.changesManager,
      toolManager: this.toolManager,
      mcpHost: AgentWorkspaceEditorPanel._mcpHost,
      registry: AgentWorkspaceEditorPanel._registry,
      ollama: this.ollama,
      queueManager: this.queueManager,
      ui: {
        openCockpitModal: async (modal, statusText) => {
          await this.openCockpitModal(modal, statusText);
        },
        switchInspectorTab: (tab) => {
          this.postMessageSafe({ type: 'switchInspectorTab', tab, forceShow: true });
        },
        openFilesExplorerOrPicker: async () => {
          await vscode.commands.executeCommand('workbench.view.explorer');
        },
        syncSession: async () => {
          await this.syncActiveSession();
        },
        updateTitle: () => {
          this.updateTitle();
        },
        applyWorkingFolder: (root) => {
          this.applyWorkingFolder(root);
        },
      },
    });

    if (this._slashAbortController === abortController) {
      this._slashAbortController = undefined;
    }

    await this.syncActiveSession();
    this.postMessageSafe({ type: 'slashCommandResult', result });
  }

  public async syncActiveSession(): Promise<void> {
    if (!this._panel || this._isDisposed) return;
    const session = this.sessionManager.getActiveSession();
    const allSessions = this.sessionManager.getAllSessions();
    const workspacePath = this.getActiveWorkspaceRoot();
    this.changesManager.setWorkspace(workspacePath);
    const workspaceName = path.basename(workspacePath) || vscode.workspace.workspaceFolders?.[0]?.name || 'LocalCoders';
    const changesSummary = await this.changesManager.getSummary();

    let modelsGrouped: any = { local: [], cloud: [], providers: [] };
    let allModels: ModelMetadata[] = [];
    try {
      modelsGrouped = await this.modelRegistry.getGroupedModels();
      allModels = await this.modelRegistry.getAvailableModels();
    } catch (e) {
      console.warn('[AgentWorkspace] Error loading models:', e);
    }

    const firstAvailable = await this.modelRegistry.getDefaultOrFirstAvailableModel();
    const fallbackModelId = session?.model || firstAvailable?.id || '';
    const fallbackModelName = firstAvailable?.displayName || fallbackModelId || 'Select Model';

    const currentConfig = session?.config || {
      providerId: firstAvailable?.providerId || 'ollama',
      modelId: fallbackModelId,
      modelName: fallbackModelName,
      reasoningEffort: firstAvailable?.defaultReasoningEffort || 'medium',
      fastMode: false,
      executionMode: 'code',
      permissionMode: 'smart',
      attachedFiles: [],
      projectContext: [],
    };
    const permissionMode = this.permissionManager?.getMode() || currentConfig.permissionMode || 'smart';
    this.permissionManager?.setMode(permissionMode as SecurityMode);
    const slashCommands = ensureBuiltinSlashCommandsRegistered(
      SlashCommandRegistry.getInstance(),
      workspacePath
    ).getSerializableCatalog();

    const telemetry = await this.collectTelemetrySafe();
    const queueSnapshot = session ? this.queueManager.getSnapshot(session.id) : undefined;
    this.postMessageSafe({
      type: 'loadSession',
      session,
      allSessions,
      workspaceName,
      workspacePath,
      changesSummary,
      modelsGrouped,
      allModels,
      currentConfig,
      permissionMode,
      slashCommands,
      terminalTabs: TerminalSessionManager.getInstance().getTabs(),
      systemTelemetry: telemetry,
      queueSnapshot,
    });
    this.updateTitle();
  }

  private async collectTelemetrySafe(): Promise<LiveSystemTelemetry | undefined> {
    try {
      return await collectLiveSystemTelemetry(this.ollama.getHost());
    } catch {
      return undefined;
    }
  }

  public async pushSystemTelemetry(): Promise<void> {
    if (this._isDisposed || this._telemetryInFlight) return;
    this._telemetryInFlight = true;
    try {
      const telemetry = await this.collectTelemetrySafe();
      if (telemetry && !this._isDisposed) {
        this.postMessageSafe({ type: 'systemTelemetry', telemetry });
      }
    } finally {
      this._telemetryInFlight = false;
    }
  }

  public focusPrompt(): void {
    this.postMessageSafe({ type: 'focusPrompt' });
  }

  public async openCockpitModal(modalType: CockpitModalType, statusText?: string): Promise<void> {
    if (this._isDisposed) return;

    const session = this.sessionManager.getActiveSession();
    const activeModelId = session?.config?.modelId || this.modelRegistry.getDefaultModelId() || '';

    if (modalType === 'models') {
      const [providers, models] = await Promise.all([
        this.modelRegistry.getProviderStatuses(false),
        this.modelRegistry.getAvailableModels({ includeDisabled: false }),
      ]);
      this.postMessageSafe({
        type: 'cockpitModalData',
        modalType,
        data: { providers, models, activeModelId, statusText },
      });
      return;
    }

    if (modalType === 'agents') {
      const reg = AgentWorkspaceEditorPanel._registry;
      const cfg = vscode.workspace.getConfiguration('localcoders');
      const availableModels = await this.modelRegistry.getAvailableModels({ includeDisabled: false }).catch(() => []);
      const customSubagents = reg?.getSubagents() || [];
      const manageableSubagents = reg ? reg.getManageableSubagents(true) : [];
      const builtinSubagents =
        customSubagents.length === 0 && reg ? reg.getEffectiveSubagents(activeModelId || 'active model', true) : [];
      this.postMessageSafe({
        type: 'cockpitModalData',
        modalType,
        data: {
          mainAgent: reg?.getMainAgent() || null,
          critic: reg?.getCriticConfig() || { enabled: true },
          maxCriticCycles: cfg.get<number>('maxCriticCycles', 0),
          subagents: customSubagents,
          builtinSubagents,
          manageableSubagents,
          predefinedRoles: AgentRegistry.getPredefinedRoles(),
          availableModels,
          activeModelId,
          statusText,
        },
      });
      return;
    }

    if (modalType === 'mcp') {
      const mcp = AgentWorkspaceEditorPanel._mcpHost;
      const servers = (mcp?.getAllServers() || []).map((s: any) => ({
        id: s.config?.id || '',
        name: s.config?.name || s.config?.id || 'MCP Server',
        transport: s.config?.transport || 'stdio',
        target: s.config?.url || [s.config?.command, ...(s.config?.args || [])].filter(Boolean).join(' '),
        connected: Boolean(s.connected || s.status === 'connected'),
        toolCount: Array.isArray(s.tools) ? s.tools.length : 0,
      }));
      this.postMessageSafe({
        type: 'cockpitModalData',
        modalType,
        data: { servers },
      });
      return;
    }

    if (modalType === 'rules') {
      const wsRoot = this.getActiveWorkspaceRoot();
      const rulesPath = wsRoot ? path.join(wsRoot, '.localcoders', 'rules.md') : '';
      let content = '';
      if (rulesPath && fs.existsSync(rulesPath)) {
        try {
          content = fs.readFileSync(rulesPath, 'utf8');
        } catch {}
      }
      this.postMessageSafe({
        type: 'cockpitModalData',
        modalType,
        data: { content, statusText },
      });
      return;
    }

    if (modalType === 'settings') {
      const cfg = vscode.workspace.getConfiguration('localcoders');
      const reg = AgentWorkspaceEditorPanel._registry;
      this.postMessageSafe({
        type: 'cockpitModalData',
        modalType,
        data: {
          defaultView: cfg.get<'agent' | 'ide'>('defaultView', 'agent'),
          permissionMode: this.permissionManager?.getMode() || session?.config?.permissionMode || 'smart',
          stopOllamaOnExit: cfg.get<boolean>('stopOllamaOnExit', true),
          criticEnabled: reg ? reg.getCriticConfig().enabled : true,
        },
      });
    }
  }

  public dispose(): void {
    const wasInternal = AgentWorkspaceEditorPanel._closingInternally;
    this._isDisposed = true;
    if (this._telemetryTimer) {
      clearInterval(this._telemetryTimer);
      this._telemetryTimer = undefined;
    }
    AgentWorkspaceEditorPanel.currentPanel = undefined;
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) {
        d.dispose();
      }
    }
    try {
      this._panel.dispose();
    } catch {}
    if (!wasInternal && AgentWorkspaceEditorPanel.onDidDisposeUnexpected) {
      AgentWorkspaceEditorPanel.onDidDisposeUnexpected();
    }
  }

  private _update() {
    this._panel.webview.html = this._getHtmlForWebview();
  }

  private _getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LocalCoders</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #111214);
      --fg: var(--vscode-editor-foreground, #e4e4e7);
      --card-bg: var(--vscode-sideBar-background, #16171a);
      --card-border: var(--vscode-widget-border, rgba(161, 161, 170, 0.16));
      --border: var(--vscode-widget-border, rgba(161, 161, 170, 0.16));
      --hover-bg: color-mix(in srgb, var(--vscode-editor-foreground, #e4e4e7) 6%, transparent);
      --input-bg: var(--vscode-input-background, #18191d);
      --accent: var(--vscode-textLink-foreground, #60a5fa);
      --accent-glow: rgba(96, 165, 250, 0.14);
      --success: #22c55e;
      --danger: #ef4444;
      --warning: #f59e0b;
      --text-muted: var(--vscode-descriptionForeground, #8b8f98);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    ${getLucideCss()}
    .btn-toggle-pane, .btn-switch-ide, .workspace-pill, .execution-title-wrap, .session-item-time, .nav-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .icon-btn-xs, .btn-send, .btn-stop, .tool-btn-icon, .attached-chip-remove, .popover-icon, .option-icon, .option-check, .pill-arrow, .chevron {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
      font-size: 13.5px;
      line-height: 1.6;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      user-select: text;
    }

    /* Local System Hardware Telemetry Bar (replaces single-tab strip in Agent Mode) */
    .lc-sys-bar {
      height: 30px;
      min-height: 30px;
      padding: 0 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      background: color-mix(in srgb, var(--card-bg) 92%, #000 8%);
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      color: var(--text-muted);
      flex-shrink: 0;
      overflow: hidden;
    }
    .lc-sys-metrics {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .lc-sys-metrics::-webkit-scrollbar {
      display: none;
    }
    .lc-sys-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 8px;
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(255, 255, 255, 0.07);
      white-space: nowrap;
      line-height: 1.3;
    }
    .lc-sys-badge.local-runtime {
      border-color: rgba(34, 197, 94, 0.25);
      background: rgba(34, 197, 94, 0.07);
      color: var(--fg);
    }
    .lc-sys-badge.local-runtime.offline {
      border-color: rgba(148, 163, 184, 0.18);
      background: rgba(148, 163, 184, 0.06);
      color: var(--text-muted);
    }
    .lc-sys-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #22c55e;
      flex-shrink: 0;
    }
    .lc-sys-dot.warn { background: #f59e0b; }
    .lc-sys-dot.hot { background: #ef4444; }
    .lc-sys-dot.idle { background: #64748b; }
    .lc-sys-k {
      font-weight: 600;
      color: var(--text-muted);
      letter-spacing: 0.2px;
    }
    .lc-sys-v {
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--fg);
      font-size: 11px;
    }
    .lc-sys-actions {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    /* Devin 3-Column Workspace Layout */
    ${getQueuePanelStyles({ compact: false })}
    .devin-workspace-layout {
      display: flex;
      width: 100vw;
      flex: 1;
      min-height: 0;
      height: 100%;
      overflow: hidden;
    }

    /* 1. LEFT SESSIONS SIDEBAR */
    .devin-sidebar {
      width: 250px;
      min-width: 200px;
      max-width: 320px;
      background: var(--card-bg);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      overflow: hidden;
      transition: width 0.2s ease, opacity 0.2s ease;
      z-index: 20;
    }
    .devin-sidebar.hidden {
      width: 0;
      min-width: 0;
      border-right: none;
      opacity: 0;
      pointer-events: none;
    }
    .sidebar-brand-header {
      padding: 10px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border-bottom: 1px solid var(--border);
    }
    .user-header-icons {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .btn-new-session {
      margin: 10px 12px 6px 12px;
      padding: 7px 10px;
      background: color-mix(in srgb, var(--fg) 5%, transparent);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--fg);
      font-weight: 500;
      font-size: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .btn-new-session:hover {
      background: var(--hover-bg);
      border-color: color-mix(in srgb, var(--fg) 26%, transparent);
    }
    .devin-nav {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px 8px 8px 8px;
      border-bottom: 1px solid var(--border);
    }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 6px;
      color: #cbd5e1;
      font-size: 12.5px;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .nav-item:hover {
      background: var(--hover-bg);
      color: #ffffff;
    }
    .session-search-box {
      padding: 6px 12px 2px 12px;
    }
    .session-search-input {
      width: 100%;
      height: 26px;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--fg);
      padding: 0 8px;
      font-size: 11.5px;
      outline: none;
      box-sizing: border-box;
    }
    .session-search-input:focus {
      border-color: var(--accent);
    }
    .composer-modes-row {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 6px;
    }
    .mode-tab {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-muted);
      padding: 2px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .mode-tab:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.05);
    }
    .mode-tab.active {
      color: var(--fg);
      background: color-mix(in srgb, var(--fg) 8%, transparent);
      border-color: var(--border);
      font-weight: 600;
    }
    .diff-header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .sessions-heading-row {
      padding: 12px 14px 6px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-muted);
    }
    .sessions-heading-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .icon-btn-xs {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 13px;
      padding: 2px 4px;
      border-radius: 4px;
    }
    .icon-btn-xs:hover {
      background: var(--hover-bg);
      color: #ffffff;
    }
    .sessions-list-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 4px 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .session-item {
      padding: 8px 10px;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 2px;
      transition: background 0.15s ease;
      position: relative;
    }
    .session-item:hover {
      background: var(--hover-bg);
    }
    .session-item.active {
      background: var(--hover-bg);
      border-left: 2px solid var(--fg);
    }
    .session-item-title {
      font-size: 12px;
      color: var(--fg);
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .session-item.active .session-item-title {
      color: var(--fg);
      font-weight: 600;
    }
    .session-item-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      min-width: 0;
    }
    .session-item-header .session-item-title {
      flex: 1;
      min-width: 0;
    }
    .session-item-actions {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      opacity: 0.45;
      flex-shrink: 0;
      transition: opacity 0.12s ease;
    }
    .session-item:hover .session-item-actions,
    .session-item.active .session-item-actions,
    .session-item.confirming .session-item-actions {
      opacity: 1;
    }
    .session-act-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-muted);
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
      color: var(--fg);
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
      color: var(--fg);
      font-size: 12px;
      font-family: inherit;
      padding: 2px 6px;
      outline: none;
    }
    .session-item-time {
      font-size: 10.5px;
      color: var(--text-muted);
    }

    /* 2. CENTER CONVERSATION WORKSPACE */
    .devin-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      height: 100%;
      overflow: hidden;
      position: relative;
      background: var(--bg);
      min-width: 0;
    }

    /* Top Session Bar */
    .top-session-bar {
      height: 40px;
      min-height: 40px;
      padding: 0 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      background: var(--bg);
      z-index: 10;
    }
    .session-left-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      overflow: hidden;
    }
    .btn-toggle-pane {
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 5px;
      color: var(--text-muted);
      padding: 3px 8px;
      font-size: 11.5px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .btn-toggle-pane:hover {
      background: var(--hover-bg);
      color: var(--fg);
    }
    .session-title {
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--fg);
    }
    .workspace-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--vscode-editor-font-family, monospace);
      cursor: pointer;
      user-select: none;
    }
    .workspace-pill:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--fg);
      border-color: rgba(255, 255, 255, 0.18);
    }
    .top-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .status-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 4px;
      font-weight: 500;
      border: 1px solid var(--border);
      color: var(--text-muted);
      background: transparent;
    }
    .status-ready { color: #22c55e; border-color: color-mix(in srgb, #22c55e 28%, transparent); }
    .status-running { color: var(--fg); border-color: var(--border); }
    .status-failed { color: #ef4444; border-color: color-mix(in srgb, #ef4444 28%, transparent); }

    .btn-switch-ide {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 3px 8px;
      border-radius: 5px;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .btn-switch-ide:hover {
      background: var(--hover-bg);
      color: var(--fg);
    }

    /* Scrollable Conversation Workspace */
    .workspace-scroll {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      scrollbar-gutter: stable;
      scrollbar-width: thin;
      padding: 24px 20px 20px 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
      position: relative;
    }
    .workspace-container {
      width: 100%;
      max-width: 820px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    /* Message Item */
    .message-card {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
    }
    .message-card.user {
      align-self: flex-end;
    }
    .message-user-bubble {
      align-self: flex-end;
      background: color-mix(in srgb, var(--fg) 7%, transparent);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 14px;
      max-width: 78%;
      color: var(--fg);
      font-size: 13px;
      line-height: 1.55;
    }
    .message-agent-wrap {
      display: flex;
      gap: 10px;
      width: 100%;
    }
    .agent-avatar {
      width: 22px;
      height: 22px;
      border-radius: 5px;
      background: color-mix(in srgb, var(--fg) 7%, transparent);
      border: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      flex-shrink: 0;
      margin-top: 2px;
    }
    .agent-content-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }
    .agent-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .agent-name {
      font-weight: 600;
      font-size: 12px;
      color: var(--text-muted);
    }
    .agent-text {
      color: var(--fg);
      font-size: 13.5px;
      line-height: 1.6;
      word-break: break-word;
    }
    .lc-empty-workspace {
      margin: 12vh auto 0 auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      text-align: center;
      color: var(--text-muted);
    }
    .lc-empty-workspace-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--fg);
    }
    .lc-empty-workspace-sub {
      font-size: 12px;
      color: var(--text-muted);
    }
    .agent-text pre {
      background: #09090b;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      overflow-x: auto;
      margin: 10px 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }
    .agent-text code {
      background: rgba(255, 255, 255, 0.08);
      padding: 2px 5px;
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }

    /* Expandable Execution Cards (Devin Style) */
    .execution-group-card {
      border: 1px solid var(--card-border);
      background: rgba(24, 24, 27, 0.6);
      border-radius: 8px;
      overflow: hidden;
      margin: 4px 0;
      transition: border-color 0.15s ease;
    }
    .execution-group-card:hover {
      border-color: rgba(255, 255, 255, 0.16);
    }
    .execution-header {
      padding: 8px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      user-select: none;
      background: rgba(255, 255, 255, 0.02);
      font-size: 12px;
      color: #94a3b8;
    }
    .execution-header:hover {
      background: rgba(255, 255, 255, 0.05);
      color: #f1f5f9;
    }
    .execution-title-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 500;
    }
    .execution-body {
      padding: 10px 14px;
      border-top: 1px solid var(--card-border);
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: #09090b;
    }
    .cmd-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.05);
      padding: 6px 10px;
      border-radius: 4px;
      border-left: 3px solid #38bdf8;
    }
    .thought-block {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      background: rgba(24, 24, 27, 0.5);
      overflow: hidden;
    }
    .thought-header {
      padding: 6px 10px;
      font-size: 11.5px;
      color: #a1a1aa;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      user-select: none;
    }
    .thought-header:hover {
      color: #f4f4f5;
    }
    .thought-content {
      padding: 8px 12px;
      font-size: 12px;
      color: #cbd5e1;
      font-style: italic;
      line-height: 1.5;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      white-space: pre-wrap;
    }

    /* Live Execution Plan Checklist */
    .plan-card {
      background: rgba(24, 24, 27, 0.7);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .plan-header {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .plan-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .plan-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 5px 8px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 4px;
      font-size: 12.5px;
    }
    .plan-item.completed {
      color: #94a3b8;
      text-decoration: line-through;
    }
    .plan-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 600;
    }
    .plan-pending { background: rgba(255, 255, 255, 0.08); color: #a1a1aa; }
    .plan-in_progress { background: rgba(56, 189, 248, 0.2); color: #38bdf8; }
    .plan-completed { background: rgba(34, 197, 94, 0.2); color: #4ade80; }

    /* Minimalist Matte Bottom Prompt Bar (docked flex footer — never covers chat content) */
    .floating-prompt-bar {
      position: relative;
      flex-shrink: 0;
      width: calc(100% - 40px);
      max-width: 780px;
      margin: 8px auto 14px auto;
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.22);
      padding: 9px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      z-index: 30;
      transition: border-color 0.15s ease;
    }
    .floating-prompt-bar:focus-within {
      border-color: color-mix(in srgb, var(--fg) 32%, transparent);
    }
    .prompt-tip {
      font-size: 10.5px;
      color: #64748b;
      padding-left: 4px;
    }
    .prompt-textarea {
      width: 100%;
      min-height: 40px;
      max-height: 160px;
      background: transparent;
      border: none;
      outline: none;
      color: #f1f5f9;
      font-family: inherit;
      font-size: 13.5px;
      line-height: 1.5;
      resize: none;
    }
    .prompt-controls-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      padding-top: 8px;
    }
    .prompt-left-tools {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .prompt-right-tools {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .tool-btn {
      width: 28px;
      height: 28px;
      box-sizing: border-box;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      line-height: 1;
      flex-shrink: 0;
      transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
    }
    .tool-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.2);
      color: #ffffff;
    }
    .tool-btn-pill,
    .code-context-pill,
    .model-selector-pill,
    .effort-selector-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      height: 28px;
      box-sizing: border-box;
      padding: 0 10px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #e2e8f0;
      font-family: inherit;
      font-size: 11.5px;
      font-weight: 500;
      line-height: 1;
      white-space: nowrap;
      user-select: none;
      cursor: pointer;
      flex-shrink: 0;
      transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
    }
    .tool-btn-pill:hover,
    .code-context-pill:hover,
    .model-selector-pill:hover,
    .effort-selector-pill:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.2);
      color: #ffffff;
    }
    .lc-icon-gap {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .model-provider-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      flex-shrink: 0;
    }
    .btn-send {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: var(--accent);
      border: none;
      color: #0f172a;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 14px;
      font-weight: 700;
      transition: all 0.15s ease;
    }
    .btn-send:hover {
      background: #7dd3fc;
      transform: scale(1.05);
    }
    .btn-stop {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: var(--danger);
      border: none;
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 13px;
    }

    /* 3. RIGHT CHANGES & DIFF PANEL */
    .devin-changes {
      width: 320px;
      min-width: 250px;
      max-width: 480px;
      background: var(--card-bg);
      border-left: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      overflow: hidden;
      transition: width 0.2s ease, opacity 0.2s ease;
      z-index: 20;
    }
    .devin-changes.hidden {
      width: 0;
      min-width: 0;
      border-left: none;
      opacity: 0;
      pointer-events: none;
    }
    .changes-header-bar {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .changes-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .changes-title {
      font-size: 13px;
      font-weight: 600;
      color: #f1f5f9;
    }
    .changes-stats-badge {
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--text-muted);
    }
    .changes-actions-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .btn-action-sm {
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      border: none;
    }
    .btn-accept {
      background: rgba(34, 197, 94, 0.18);
      color: #4ade80;
      border: 1px solid rgba(34, 197, 94, 0.35);
    }
    .btn-accept:hover {
      background: rgba(34, 197, 94, 0.3);
    }
    .btn-reject {
      background: rgba(239, 68, 68, 0.18);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.35);
    }
    .btn-reject:hover {
      background: rgba(239, 68, 68, 0.3);
    }
    .btn-review-critic {
      background: rgba(56, 189, 248, 0.18);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.35);
    }
    .btn-review-critic:hover {
      background: rgba(56, 189, 248, 0.3);
    }
    .changes-files-scroll {
      max-height: 180px;
      overflow-y: auto;
      border-bottom: 1px solid var(--border);
      padding: 4px 6px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .change-file-item {
      padding: 6px 8px;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11.5px;
    }
    .change-file-item:hover {
      background: var(--hover-bg);
    }
    .change-file-item.selected {
      background: rgba(56, 189, 248, 0.12);
      border-left: 2px solid var(--accent);
    }
    .file-name-wrap {
      display: flex;
      align-items: center;
      gap: 6px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .file-status-tag {
      font-size: 10px;
      padding: 1px 4px;
      border-radius: 3px;
      font-weight: 700;
    }
    .file-status-tag.m { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
    .file-status-tag.a { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
    .file-status-tag.d { background: rgba(239, 68, 68, 0.2); color: #f87171; }

    /* Live Diff Viewer Area */
    .diff-viewer-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: #09090b;
    }
    .diff-header-tab {
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      color: #94a3b8;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(255, 255, 255, 0.02);
    }
    .diff-code-scroll {
      flex: 1;
      overflow: auto;
      padding: 8px 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
      line-height: 1.5;
    }
    .diff-line {
      padding: 0 10px;
      white-space: pre;
    }
    .diff-line.add {
      background: rgba(34, 197, 94, 0.15);
      color: #86efac;
    }
    .diff-line.del {
      background: rgba(239, 68, 68, 0.15);
      color: #fca5a5;
    }
    .diff-line.info {
      color: #64748b;
    }

    /* Popover Backdrop & Base Styles */
    .popover-backdrop {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: none;
      background: transparent;
    }
    .popover-backdrop.active {
      display: block;
    }

    .popover-menu, .popover-card {
      position: absolute;
      z-index: 110;
      display: none;
      background: #18181b;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(16px);
      color: #f1f5f9;
      user-select: none;
    }
    .popover-menu.open, .popover-card.open {
      display: flex;
      flex-direction: column;
      animation: popoverFadeIn 0.12s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes popoverFadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Attach Menu */
    .popover-menu {
      min-width: 200px;
      padding: 6px 0;
      font-size: 13px;
    }
    .popover-menu-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 14px;
      cursor: pointer;
      color: #e2e8f0;
      transition: background 0.1s ease;
    }
    .popover-menu-item:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #ffffff;
    }
    .popover-menu-item .popover-icon {
      font-size: 14px;
      width: 18px;
      text-align: center;
      color: var(--accent);
    }

    /* Execution & Permission Option Cards */
    .popover-card {
      padding: 8px;
    }
    .popover-card-option {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 10px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.1s ease;
    }
    .popover-card-option:hover {
      background: rgba(255, 255, 255, 0.07);
    }
    .popover-card-option .option-icon {
      font-size: 15px;
      width: 22px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #38bdf8;
      flex-shrink: 0;
    }
    .popover-card-option .option-content {
      flex: 1;
      min-width: 0;
    }
    .popover-card-option .option-title {
      font-size: 12.5px;
      font-weight: 600;
      color: #f8fafc;
    }
    .popover-card-option .option-desc {
      font-size: 11px;
      color: #94a3b8;
      line-height: 1.3;
      margin-top: 1px;
    }
    .popover-card-option .option-check {
      font-size: 13px;
      font-weight: 700;
      color: #38bdf8;
      display: none;
    }
    .popover-card-option.active .option-check {
      display: block;
    }
    .popover-divider {
      height: 1px;
      background: rgba(255, 255, 255, 0.08);
      margin: 6px 0;
    }

    /* Model Selector & Configuration Popovers */
    ${getModelSelectorStyles()}

    /* Attached Context Chips Bar */
    .composer-attached-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 6px 10px 4px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .attached-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.25);
      color: #e0f2fe;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .attached-chip-remove {
      cursor: pointer;
      opacity: 0.7;
      font-weight: 700;
      font-size: 12px;
    }
    .attached-chip-remove:hover {
      opacity: 1;
      color: #f87171;
    }

    /* Controls Pills (see unified composer controls above) */
    .tool-btn-icon {
      width: 28px;
      height: 28px;
      box-sizing: border-box;
      background: transparent;
      border: 1px solid transparent;
      color: #94a3b8;
      cursor: pointer;
      font-size: 15px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border-radius: 6px;
      flex-shrink: 0;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .tool-btn-icon:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.08);
    }
    .pill-arrow {
      display: inline-flex;
      align-items: center;
      opacity: 0.72;
      flex-shrink: 0;
    }
    ${getActivityStreamStyles()}
    ${getCockpitModalStyles()}
    ${getSlashCommandStyles()}
    ${getSessionsBarStyles()}
  </style>
</head>
<body>

  <header class="lc-sys-bar" id="systemTelemetryBar">
    <div class="lc-sys-metrics" id="systemTelemetryMetrics">
      <span class="lc-sys-badge local-runtime idle"><span class="lc-sys-dot idle"></span><span class="lc-sys-k">LOCAL</span><span class="lc-sys-v">Detecting hardware...</span></span>
    </div>
    <div class="lc-sys-actions">
      <button type="button" class="icon-btn-xs" id="btnRefreshTelemetry" title="Refresh System Hardware Stats">${lucideSvg('refresh-cw', 12)}</button>
    </div>
  </header>

  <div class="devin-workspace-layout">

    <!-- 1. LEFT SESSIONS SIDEBAR -->
    <aside class="devin-sidebar" id="devinSidebar">
      <div class="sidebar-brand-header">
        ${getUserProfileBadgeMarkup()}
        <div class="user-header-icons">
          <button class="icon-btn-xs" id="btnSettingsHeader" title="Settings">${lucideSvg('settings', 14)}</button>
        </div>
      </div>

      <nav class="devin-nav">
        <div class="nav-item" id="navReview">${lucideSvg('eye', 14)} <span>Changes Review</span></div>
        <div class="nav-item" id="navAgents">${lucideSvg('users', 14)} <span>Agents</span></div>
        <div class="nav-item" id="navMcp">${lucideSvg('plug', 14)} <span>MCP Servers</span></div>
        <div class="nav-item" id="navWiki">${lucideSvg('file-text', 14)} <span>Project Rules</span></div>
      </nav>

      <div class="lc-sessions-header">
        <span class="lc-sessions-heading">Sessions</span>
        <div class="lc-sessions-hdr-actions">
          <button type="button" class="lc-sess-hdr-btn" id="btnHeaderNewSession" title="New Session">${lucideSvg('plus', 15)}</button>
          <button type="button" class="lc-sess-hdr-btn" id="btnHeaderFilter" title="Filter &amp; Sort">${lucideSvg('sliders-horizontal', 14)}</button>
          <button type="button" class="lc-sess-hdr-btn" id="btnHeaderMore" title="Session Options">${lucideSvg('ellipsis', 14)}</button>
          <div class="lc-sessions-menu" id="sessionsMoreMenu">
            <button type="button" class="lc-sessions-menu-item" data-sess-action="new">${lucideSvg('plus', 12)}<span>New Session</span></button>
            <button type="button" class="lc-sessions-menu-item" data-sess-action="toggleGroup">${lucideSvg('folder', 12)}<span id="sessGroupMenuLabel">Group by Folder</span></button>
            <button type="button" class="lc-sessions-menu-item" data-sess-action="toggleSort">${lucideSvg('arrow-up-down', 12)}<span id="sessSortMenuLabel">Sort: Alphabetical</span></button>
            <div class="lc-sessions-menu-sep"></div>
            <button type="button" class="lc-sessions-menu-item" data-sess-action="renameActive">${lucideSvg('pencil', 12)}<span>Rename Active</span></button>
            <button type="button" class="lc-sessions-menu-item danger" data-sess-action="deleteActive">${lucideSvg('trash-2', 12)}<span>Delete Active</span></button>
          </div>
        </div>
      </div>

      <div class="lc-sessions-filter-bar" id="sessionsFilterBar">
        <div class="lc-sessions-search-wrap">
          <span class="lc-sessions-search-ico">${lucideSvg('search', 12)}</span>
          <input type="text" class="lc-sessions-filter-input" id="sessionSearchInput" placeholder="Filter sessions...">
        </div>
        <div class="lc-sessions-filter-pills">
          <button type="button" class="lc-sess-filter-pill active" id="pillSortRecent">Recent</button>
          <button type="button" class="lc-sess-filter-pill" id="pillSortAlpha">A–Z</button>
          <button type="button" class="lc-sess-filter-pill" id="pillGroupFolder">By Folder</button>
        </div>
      </div>

      <button type="button" class="lc-recent-subheader" id="btnToggleRecentGroup" title="Collapse / Expand Recent">
        ${lucideSvg('clock', 12)}
        <span>Recent</span>
      </button>

      <div class="lc-sessions-scroll" id="sessionsList">
        <!-- Sessions dynamically rendered -->
      </div>
    </aside>

    <!-- 2. CENTER CONVERSATION WORKSPACE -->
    <main class="devin-main">
      <div class="top-session-bar">
        <div class="session-left-meta">
          <button class="btn-toggle-pane" id="btnToggleSidebar" title="Toggle Sessions Sidebar">${lucideSvg('panel-left', 14)}</button>
          <span class="session-title" id="topSessionTitle" title="Double-click to rename session">New session</span>
          <button class="icon-btn-xs" id="btnRenameActiveSession" title="Rename active session">${lucideSvg('pencil', 12)}</button>
          <button type="button" class="workspace-pill" id="topWorkspacePill" title="Choose Working Folder for Agent">${lucideSvg('folder', 12)} <span>workspace</span></button>
        </div>
        <div class="top-actions">
          <span class="status-badge status-ready" id="topStatusBadge">Ready</span>
          <button class="btn-toggle-pane" id="btnToggleTerminal" title="Terminal">${lucideSvg('terminal', 13)} <span>Terminal</span></button>
          <button class="btn-toggle-pane" id="btnToggleChanges" title="Changes">${lucideSvg('panel-right', 13)} <span>Changes</span></button>
          <button class="btn-switch-ide" id="btnSwitchToIde" title="Switch to IDE Editor View">${lucideSvg('code', 13)} <span>IDE</span></button>
        </div>
      </div>

      <div class="workspace-scroll" id="scrollContainer">
        <div class="workspace-container" id="conversationFlow">
          <!-- Messages, execution cards, plans -->
        </div>
      </div>

      ${getQueuePanelMarkup()}

      <!-- Floating Bottom Prompt Bar with Popovers -->
      <div class="floating-prompt-bar">
        <!-- Floating Popovers Backdrop -->
        <div class="popover-backdrop" id="popoverBackdrop"></div>

        <!-- 1. Attachment / Context Popover (Screenshot 1) -->
        <div class="popover-menu" id="attachMenuPopover">
          <div class="popover-menu-item" data-action="attachFiles">
            <span class="popover-icon">${lucideSvg('paperclip', 14)}</span>
            <span class="popover-label">Attach files</span>
          </div>
          <div class="popover-menu-item" data-action="quickFile">
            <span class="popover-icon">${lucideSvg('file-text', 14)}</span>
            <span class="popover-label">Files</span>
          </div>
          <div class="popover-menu-item" data-action="quickDirectory">
            <span class="popover-icon">${lucideSvg('folder', 14)}</span>
            <span class="popover-label">Directories</span>
          </div>
          <div class="popover-menu-item" data-action="attachGit">
            <span class="popover-icon">${lucideSvg('git-branch', 14)}</span>
            <span class="popover-label">Git</span>
          </div>
          <div class="popover-menu-item" data-action="openMcp">
            <span class="popover-icon">${lucideSvg('plug', 14)}</span>
            <span class="popover-label">MCP servers</span>
          </div>
          <div class="popover-menu-item" data-action="openRules">
            <span class="popover-icon">${lucideSvg('scroll-text', 14)}</span>
            <span class="popover-label">Rules</span>
          </div>
          <div class="popover-menu-item" data-action="openSkills">
            <span class="popover-icon">${lucideSvg('lightbulb', 14)}</span>
            <span class="popover-label">Skills</span>
          </div>
          <div class="popover-menu-item" data-action="attachPlan">
            <span class="popover-icon">${lucideSvg('list-checks', 14)}</span>
            <span class="popover-label">Plans</span>
          </div>
          <div class="popover-menu-item" data-action="attachConversation">
            <span class="popover-icon">${lucideSvg('message-square', 14)}</span>
            <span class="popover-label">Conversations</span>
          </div>
          <div class="popover-menu-item" data-action="attachTerminal">
            <span class="popover-icon">${lucideSvg('terminal', 14)}</span>
            <span class="popover-label">Terminal</span>
          </div>
          <div class="popover-menu-item" data-action="attachCodemap">
            <span class="popover-icon">${lucideSvg('map', 14)}</span>
            <span class="popover-label">Codemaps</span>
          </div>
        </div>

        <!-- 2. Execution Mode Popover (Screenshot 2/3) -->
        <div class="popover-card" id="execModePopover" style="width: 290px;">
          <div class="popover-card-option" data-exec="code">
            <div class="option-icon">&lt;/&gt;</div>
            <div class="option-content">
              <div class="option-title">Code</div>
              <div class="option-desc">Write and edit code</div>
            </div>
            <div class="option-check" id="checkExec_code">${lucideSvg('check', 13)}</div>
          </div>
          <div class="popover-card-option" data-exec="smart">
            <div class="option-icon">${lucideSvg('sparkles', 14)}</div>
            <div class="option-content">
              <div class="option-title">Smart</div>
              <div class="option-desc">Auto-approve actions the model judges safe</div>
            </div>
            <div class="option-check" id="checkExec_smart">${lucideSvg('check', 13)}</div>
          </div>
          <div class="popover-card-option" data-exec="ask">
            <div class="option-icon">${lucideSvg('message-square', 14)}</div>
            <div class="option-content">
              <div class="option-title">Ask</div>
              <div class="option-desc">Answer questions without code changes</div>
            </div>
            <div class="option-check" id="checkExec_ask">${lucideSvg('check', 13)}</div>
          </div>
          <div class="popover-card-option" data-exec="plan">
            <div class="option-icon">${lucideSvg('list-checks', 14)}</div>
            <div class="option-content">
              <div class="option-title">Plan</div>
              <div class="option-desc">Plan changes before implementing</div>
            </div>
            <div class="option-check" id="checkExec_plan">${lucideSvg('check', 13)}</div>
          </div>
          <div class="popover-divider"></div>
          <div class="popover-card-option" data-perm="bypass" id="optBypassPerms">
            <div class="option-icon">${lucideSvg('shield', 14)}</div>
            <div class="option-content">
              <div class="option-title">Bypass Permissions</div>
              <div class="option-desc">Auto-approve all tool calls unless blocked by hard safety boundaries</div>
            </div>
            <div class="option-check" id="checkPerm_bypass">${lucideSvg('check', 13)}</div>
          </div>
        </div>

        <!-- 3. Permission Mode Popover -->
        <div class="popover-card" id="permModePopover" style="width: 300px;">
          <div class="popover-card-option" data-perm="ask">
            <div class="option-icon">${lucideSvg('shield', 14)}</div>
            <div class="option-content">
              <div class="option-title">Ask Before Actions</div>
              <div class="option-desc">Prompt for manual confirmation before every tool call or edit</div>
            </div>
            <div class="option-check" id="checkPerm_ask">${lucideSvg('check', 13)}</div>
          </div>
          <div class="popover-card-option" data-perm="smart">
            <div class="option-icon">${lucideSvg('shield-check', 14)}</div>
            <div class="option-content">
              <div class="option-title">Smart Approval</div>
              <div class="option-desc">Auto-approve safe reads; prompt on file modifications and terminal runs</div>
            </div>
            <div class="option-check" id="checkPerm_smart">${lucideSvg('check', 13)}</div>
          </div>
          <div class="popover-card-option" data-perm="bypass">
            <div class="option-icon">${lucideSvg('shield-alert', 14)}</div>
            <div class="option-content">
              <div class="option-title">Bypass Permissions</div>
              <div class="option-desc">Auto-approve all tool calls unless your organization's policy requires approval</div>
            </div>
            <div class="option-check" id="checkPerm_bypass_modal">${lucideSvg('check', 13)}</div>
          </div>
        </div>

        ${getSlashCommandPopupMarkup()}
        ${getModelSelectorMarkup({ compact: false })}

        <!-- Attached Chips Row -->
        <div class="composer-attached-row" id="attachedChipsRow" style="display:none;"></div>

        <div class="composer-modes-row">
          <button class="mode-tab active" data-mode="agent">Agent</button>
          <button class="mode-tab" data-mode="plan">Plan</button>
          <button class="mode-tab" data-mode="ask">Ask</button>
          <button class="mode-tab" data-mode="review">Review</button>
        </div>
        <textarea class="prompt-textarea" id="promptInput" rows="1" placeholder="Ask anything, @ to mention, / for actions... (Enter to send, Shift+Enter for newline)"></textarea>
        
        <div class="prompt-controls-row">
          <div class="prompt-left-tools">
            <button class="tool-btn" id="btnAttachment" title="Add File / Context (Attach, Git, MCP, Rules, Skills)">+</button>
            <button class="tool-btn-pill" id="btnExecMode" title="Change Execution Mode">
              <span id="execModeLabel" class="lc-icon-gap">${lucideSvg('code', 13)}<span>Code</span></span>
              <span class="pill-arrow">${lucideSvg('chevron-down', 11)}</span>
            </button>
            <button class="tool-btn-pill" id="btnPermMode" title="Change Security Permission Policy">
              <span id="permModeLabel" class="lc-icon-gap">${lucideSvg('shield-check', 13)}<span>Smart Approval</span></span>
              <span class="pill-arrow">${lucideSvg('chevron-down', 11)}</span>
            </button>
            <button type="button" class="code-context-pill" id="btnWorkspaceContext" title="Choose Folder for Model to Work In">
              ${lucideSvg('folder', 13)}
              <span id="promptWorkspaceLabel">workspace</span>
              <span class="pill-arrow">${lucideSvg('chevron-down', 11)}</span>
            </button>
          </div>
          <div class="prompt-right-tools">
            <button type="button" class="model-selector-pill" id="modelSelector" title="Select AI Model (Ctrl+K)">
              <span class="model-provider-icon" id="modelProviderIcon"></span>
              <span id="activeModelLabel">Select Model</span>
              <span class="pill-arrow">${lucideSvg('chevron-down', 11)}</span>
            </button>
            <button type="button" class="effort-selector-pill" id="btnEffortConfig" title="Configure Model Effort &amp; Parameters">
              <span id="activeEffortLabel">Params</span>
              <span class="pill-arrow">${lucideSvg('chevron-down', 11)}</span>
            </button>
            <button type="button" class="tool-btn-icon" id="btnMic" title="Voice Input (Dictation)">${lucideSvg('mic', 14)}</button>
            <button type="button" class="btn-send" id="btnSend" title="Send Prompt (Enter)">${lucideSvg('arrow-up', 14)}</button>
            <button type="button" class="btn-stop" id="btnStop" style="display:none;" title="Stop Execution">${lucideSvg('square', 12, '', 'currentColor')}</button>
          </div>
        </div>
      </div>
    </main>

    <!-- 3. RIGHT INSPECTOR DOCK (TERMINAL | CHANGES PANEL — COLLAPSED BY DEFAULT) -->
    <aside class="devin-changes lc-inspector-dock hidden" id="devinChanges">
      <div class="lc-inspector-tabs" id="inspectorTabBar">
        <button class="lc-inspector-tab" data-inspector-tab="terminal" id="tabBtnTerminal">
          ${inspectorTabIcon('terminal')}
          <span>Terminal</span>
        </button>
        <button class="lc-inspector-tab active" data-inspector-tab="changes" id="tabBtnChanges">
          ${inspectorTabIcon('changes')}
          <span>Changes</span>
          <span class="lc-tab-count" id="changesCountBadge">0</span>
        </button>
      </div>

      <!-- AREA C: INTERACTIVE MULTI-TAB TERMINAL PANE -->
      <div class="lc-inspector-pane" id="inspectorPaneTerminal">
        <div class="lc-term-tabs-bar" id="termTabsBar"></div>
        <div class="lc-term-meta-bar">
          <span class="lc-term-cwd" id="termCwdLabel">workspace</span>
          <div class="lc-term-controls">
            <span class="lc-act-status-pill completed" id="termStatusBadge">Idle</span>
            <button class="icon-btn-xs" id="btnTermStop" title="Terminate Running Process" style="display:none;">${lucideSvg('square', 11, '', 'currentColor')} <span>Stop</span></button>
            <button class="icon-btn-xs" id="btnTermClear" title="Clear Terminal Output">${lucideSvg('trash-2', 12)}</button>
            <button class="icon-btn-xs" id="btnTermNew" title="New Terminal Tab">${lucideSvg('plus', 13)}</button>
          </div>
        </div>
        <div class="lc-term-output" id="termOutputScroll"></div>
        <div class="lc-term-input-row">
          <span class="lc-term-prompt-sym">$</span>
          <input type="text" class="lc-term-input" id="termCmdInput" placeholder="Run command in workspace..." autocomplete="off" />
          <button type="button" class="icon-btn-xs" id="btnTermRun" title="Run Command (Enter)">${lucideSvg('play', 11)}</button>
        </div>
      </div>

      <!-- AREA D: CHANGES & DIFF VIEWER PANE -->
      <div class="lc-inspector-pane active" id="inspectorPaneChanges">
        <div class="changes-header-bar">
          <div class="changes-title-row">
            <span class="changes-title">Changes</span>
            <span class="changes-stats-badge" id="changesStats">0 files</span>
          </div>
          <div class="changes-actions-row">
            <button class="btn-action-sm btn-accept" id="btnAcceptAll">Accept All</button>
            <button class="btn-action-sm btn-reject" id="btnRejectAll">Reject All</button>
            <button class="btn-action-sm btn-review-critic" id="btnCriticReview">Critic Review</button>
          </div>
        </div>

        <div class="changes-files-scroll" id="changesFilesList">
          <!-- Changed files injected dynamically -->
        </div>

        <div class="diff-viewer-area">
          <div class="diff-header-tab">
            <span id="diffActiveFileLabel">No file selected</span>
            <div class="diff-header-actions">
              <button class="icon-btn-xs" id="btnRevertFile" title="Revert Changes to this File">${lucideSvg('rotate-ccw', 13)} <span>Revert</span></button>
            </div>
          </div>
          <div class="diff-code-scroll" id="diffCodeContainer">
            <div class="diff-line info">// Select a changed file above to inspect live diff</div>
          </div>
        </div>
      </div>
    </aside>

  </div>

  ${getCockpitModalMarkup(lucideSvg('x', 14))}

  <script>
    const vscode = acquireVsCodeApi();

    let currentSession = null;
    let allSessionsList = [];
    let activePlan = [];
    let planExplicit = false;
    let isWorking = false;
    let currentChanges = { totalFiles: 0, totalAdded: 0, totalRemoved: 0, files: [] };
    let selectedDiffFile = null;
    let currentActivities = [];
    let slashCommandsCatalog = [];
    let currentCommandResults = [];
    let ephemeralCommandResults = [];
    let lastLoadedSessionId = null;
    let activeActivityFilter = 'all';
    const expandedActivityIds = new Set();
    const expandedTurnIds = new Set();
    const expandedThoughtIds = new Set();
    const streamingMessages = {};
    let liveStatusState = { active: false, phase: 'idle', summary: '' };
    let activeInspectorTab = 'changes';
    let terminalTabsState = [];
    let activeTermTabId = null;
    const termCmdHistory = [];
    let termHistoryIdx = -1;

    const conversationFlow = document.getElementById('conversationFlow');
    ${getLucideClientScript()}
    ${getActivityClientScript()}
    ${getSlashCommandClientScript()}
    ${getSessionsBarClientScript()}
    ${getQueuePanelClientScript()}
    let sessionSortMode = 'recent';
    let groupSessionsByFolder = false;
    let sessionsRecentCollapsed = false;
    const collapsedFolderGroups = new Set();
    const scrollContainer = document.getElementById('scrollContainer');
    const floatingPromptBar = document.querySelector('.floating-prompt-bar');
    let chatPinnedToBottom = true;
    if (scrollContainer && typeof scrollContainer.addEventListener === 'function') {
      scrollContainer.addEventListener('scroll', () => {
        const gap = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
        chatPinnedToBottom = gap <= 32;
      });
    }
    if ((floatingPromptBar || lcQueueDock) && scrollContainer && typeof ResizeObserver !== 'undefined') {
      const promptBarResizeObserver = new ResizeObserver(() => {
        if (chatPinnedToBottom) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      });
      if (floatingPromptBar) promptBarResizeObserver.observe(floatingPromptBar);
      if (lcQueueDock) promptBarResizeObserver.observe(lcQueueDock);
    }
    const promptInput = document.getElementById('promptInput');
    const btnSend = document.getElementById('btnSend');
    const btnStop = document.getElementById('btnStop');
    const topSessionTitle = document.getElementById('topSessionTitle');
    const topWorkspacePill = document.getElementById('topWorkspacePill');
    const topStatusBadge = document.getElementById('topStatusBadge');
    const promptWorkspaceLabel = document.getElementById('promptWorkspaceLabel');
    const activeModelLabel = document.getElementById('activeModelLabel');
    const modelSelector = document.getElementById('modelSelector');

    const btnWorkspaceContext = document.getElementById('btnWorkspaceContext');
    if (btnWorkspaceContext) {
      btnWorkspaceContext.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ command: 'selectWorkspace' });
      });
    }
    if (topWorkspacePill) {
      topWorkspacePill.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ command: 'selectWorkspace' });
      });
    }

    // Panes & Inspector Tabs
    const devinSidebar = document.getElementById('devinSidebar');
    const devinChanges = document.getElementById('devinChanges');
    const btnToggleSidebar = document.getElementById('btnToggleSidebar');
    const btnToggleActivity = document.getElementById('btnToggleActivity');
    const btnToggleTerminal = document.getElementById('btnToggleTerminal');
    const btnToggleChanges = document.getElementById('btnToggleChanges');
    const btnSwitchToIde = document.getElementById('btnSwitchToIde');

    function switchInspectorTab(tabName, forceShow = false) {
      const targetTab = tabName === 'terminal' ? 'terminal' : 'changes';
      activeInspectorTab = targetTab;
      if (forceShow) devinChanges.classList.remove('hidden');
      document.querySelectorAll('.lc-inspector-tab').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-inspector-tab') === targetTab);
      });
      document.getElementById('inspectorPaneTerminal')?.classList.toggle('active', targetTab === 'terminal');
      document.getElementById('inspectorPaneChanges')?.classList.toggle('active', targetTab === 'changes');
      if (targetTab === 'terminal') {
        const termInput = document.getElementById('termCmdInput');
        if (termInput) setTimeout(() => termInput.focus(), 20);
      }
    }

    document.querySelectorAll('.lc-inspector-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchInspectorTab(btn.getAttribute('data-inspector-tab') || 'changes', true);
      });
    });

    btnToggleSidebar.addEventListener('click', () => {
      devinSidebar.classList.toggle('hidden');
    });
    if (btnToggleActivity) {
      btnToggleActivity.addEventListener('click', () => {
        if (devinChanges.classList.contains('hidden') || activeInspectorTab !== 'activity') {
          switchInspectorTab('activity', true);
        } else {
          devinChanges.classList.add('hidden');
        }
      });
    }
    if (btnToggleTerminal) {
      btnToggleTerminal.addEventListener('click', () => {
        if (devinChanges.classList.contains('hidden') || activeInspectorTab !== 'terminal') {
          switchInspectorTab('terminal', true);
        } else {
          devinChanges.classList.add('hidden');
        }
      });
    }
    btnToggleChanges.addEventListener('click', () => {
      if (devinChanges.classList.contains('hidden') || activeInspectorTab !== 'changes') {
        switchInspectorTab('changes', true);
      } else {
        devinChanges.classList.add('hidden');
      }
    });
    btnSwitchToIde.addEventListener('click', () => {
      vscode.postMessage({ command: 'switchToIde' });
    });

    // Activity Filter Pills
    document.querySelectorAll('#activityFilterRow .lc-filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#activityFilterRow .lc-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeActivityFilter = btn.getAttribute('data-act-filter') || 'all';
        renderActivityPane();
      });
    });

    // Terminal Interactive Controls
    const termCmdInput = document.getElementById('termCmdInput');
    const termOutputScroll = document.getElementById('termOutputScroll');
    const btnTermRun = document.getElementById('btnTermRun');
    const btnTermNew = document.getElementById('btnTermNew');
    const btnTermClear = document.getElementById('btnTermClear');
    const btnTermStop = document.getElementById('btnTermStop');

    function submitTerminalCommand() {
      if (!termCmdInput) return;
      const cmd = termCmdInput.value;
      if (!activeTermTabId && terminalTabsState && terminalTabsState.length > 0) {
        activeTermTabId = terminalTabsState[0].id;
      }
      if (!activeTermTabId) return;
      const activeTab = terminalTabsState.find((t) => t.id === activeTermTabId);
      const isRunningTab = activeTab && activeTab.status === 'running';
      if (!cmd.trim() && !isRunningTab) return;
      if (cmd.trim()) {
        termCmdHistory.push(cmd);
        termHistoryIdx = termCmdHistory.length;
      }
      termCmdInput.value = '';
      vscode.postMessage({ command: 'runTerminalCommand', tabId: activeTermTabId, cmd: cmd });
    }

    if (btnTermNew) {
      btnTermNew.addEventListener('click', () => {
        vscode.postMessage({ command: 'createTerminalTab' });
        if (termCmdInput) setTimeout(() => termCmdInput.focus(), 40);
      });
    }
    if (btnTermClear) {
      btnTermClear.addEventListener('click', () => {
        if (activeTermTabId) vscode.postMessage({ command: 'clearTerminalTab', tabId: activeTermTabId });
      });
    }
    if (btnTermStop) {
      btnTermStop.addEventListener('click', () => {
        if (activeTermTabId) vscode.postMessage({ command: 'terminateTerminalTab', tabId: activeTermTabId });
      });
    }
    if (btnTermRun) {
      btnTermRun.addEventListener('click', () => {
        submitTerminalCommand();
        if (termCmdInput) termCmdInput.focus();
      });
    }
    if (termOutputScroll && termCmdInput) {
      termOutputScroll.addEventListener('click', () => {
        const sel = typeof window !== 'undefined' && typeof window.getSelection === 'function'
          ? String(window.getSelection()?.toString() || '')
          : '';
        if (!sel) termCmdInput.focus();
      });
    }
    if (termCmdInput) {
      termCmdInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          submitTerminalCommand();
        } else if (e.key === 'ArrowUp') {
          if (termCmdHistory.length > 0 && termHistoryIdx > 0) {
            e.preventDefault();
            termHistoryIdx--;
            termCmdInput.value = termCmdHistory[termHistoryIdx] || '';
          }
        } else if (e.key === 'ArrowDown') {
          if (termHistoryIdx < termCmdHistory.length - 1) {
            e.preventDefault();
            termHistoryIdx++;
            termCmdInput.value = termCmdHistory[termHistoryIdx] || '';
          } else {
            termHistoryIdx = termCmdHistory.length;
            termCmdInput.value = '';
          }
        }
      });
    }

    // Sidebar header actions (stay inside single Agent tab)
    const sessionsFilterBar = document.getElementById('sessionsFilterBar');
    const btnHeaderFilter = document.getElementById('btnHeaderFilter');
    const btnHeaderMore = document.getElementById('btnHeaderMore');
    const sessionsMoreMenu = document.getElementById('sessionsMoreMenu');

    document.getElementById('btnSearchHeader')?.addEventListener('click', () => {
      if (sessionsFilterBar) sessionsFilterBar.classList.add('open');
      if (btnHeaderFilter) btnHeaderFilter.classList.add('active');
      document.getElementById('sessionSearchInput')?.focus();
    });
    document.getElementById('btnSettingsHeader')?.addEventListener('click', () => {
      requestCockpitModal('settings');
    });

    // Nav items
    document.getElementById('navSecurity')?.addEventListener('click', () => vscode.postMessage({ command: 'openSecurity' }));
    document.getElementById('navReview')?.addEventListener('click', () => vscode.postMessage({ command: 'openReview' }));
    document.getElementById('navWiki')?.addEventListener('click', () => vscode.postMessage({ command: 'openWiki' }));
    document.getElementById('navCustomize')?.addEventListener('click', () => vscode.postMessage({ command: 'openAgents' }));
    document.getElementById('navAgents')?.addEventListener('click', () => vscode.postMessage({ command: 'openAgents' }));
    document.getElementById('navMcp')?.addEventListener('click', () => vscode.postMessage({ command: 'openMcp' }));

    // Session search & filter bar
    const sessionSearchInput = document.getElementById('sessionSearchInput');
    function syncSessionsFilterUI() {
      document.getElementById('pillSortRecent')?.classList.toggle('active', sessionSortMode === 'recent');
      document.getElementById('pillSortAlpha')?.classList.toggle('active', sessionSortMode === 'alpha');
      document.getElementById('pillGroupFolder')?.classList.toggle('active', groupSessionsByFolder);
      const sortLbl = document.getElementById('sessSortMenuLabel');
      if (sortLbl) sortLbl.textContent = sessionSortMode === 'recent' ? 'Sort: Alphabetical' : 'Sort: Most Recent';
      const grpLbl = document.getElementById('sessGroupMenuLabel');
      if (grpLbl) grpLbl.textContent = groupSessionsByFolder ? 'Ungroup Sessions' : 'Group by Folder';
    }
    if (btnHeaderFilter) {
      btnHeaderFilter.addEventListener('click', (e) => {
        e.stopPropagation();
        sessionsMoreMenu?.classList.remove('open');
        const nextOpen = sessionsFilterBar ? !sessionsFilterBar.classList.contains('open') : false;
        sessionsFilterBar?.classList.toggle('open', nextOpen);
        btnHeaderFilter.classList.toggle('active', nextOpen);
        if (nextOpen) {
          sessionSearchInput?.focus();
        } else if (sessionSearchInput && sessionSearchInput.value) {
          sessionSearchInput.value = '';
          renderSessionsList('');
        }
      });
    }
    if (btnHeaderMore && sessionsMoreMenu) {
      btnHeaderMore.addEventListener('click', (e) => {
        e.stopPropagation();
        syncSessionsFilterUI();
        sessionsMoreMenu.classList.toggle('open');
      });
      document.addEventListener('click', (e) => {
        if (!sessionsMoreMenu.contains(e.target) && e.target !== btnHeaderMore) {
          sessionsMoreMenu.classList.remove('open');
        }
      });
      sessionsMoreMenu.querySelectorAll('.lc-sessions-menu-item[data-sess-action]').forEach((item) => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const act = item.getAttribute('data-sess-action');
          sessionsMoreMenu.classList.remove('open');
          if (act === 'new') {
            vscode.postMessage({ command: 'newSession' });
          } else if (act === 'toggleGroup') {
            groupSessionsByFolder = !groupSessionsByFolder;
            syncSessionsFilterUI();
            renderSessionsList(sessionSearchInput?.value.trim() || '');
          } else if (act === 'toggleSort') {
            sessionSortMode = sessionSortMode === 'recent' ? 'alpha' : 'recent';
            syncSessionsFilterUI();
            renderSessionsList(sessionSearchInput?.value.trim() || '');
          } else if (act === 'renameActive' && currentSession?.id) {
            beginInlineSessionRename(currentSession.id);
          } else if (act === 'deleteActive' && currentSession?.id) {
            confirmingDeleteSessionId = currentSession.id;
            renderSessionsList(sessionSearchInput?.value.trim() || '');
          }
        });
      });
    }
    document.getElementById('pillSortRecent')?.addEventListener('click', () => {
      sessionSortMode = 'recent';
      syncSessionsFilterUI();
      renderSessionsList(sessionSearchInput?.value.trim() || '');
    });
    document.getElementById('pillSortAlpha')?.addEventListener('click', () => {
      sessionSortMode = 'alpha';
      syncSessionsFilterUI();
      renderSessionsList(sessionSearchInput?.value.trim() || '');
    });
    document.getElementById('pillGroupFolder')?.addEventListener('click', () => {
      groupSessionsByFolder = !groupSessionsByFolder;
      syncSessionsFilterUI();
      renderSessionsList(sessionSearchInput?.value.trim() || '');
    });
    document.getElementById('btnToggleRecentGroup')?.addEventListener('click', () => {
      sessionsRecentCollapsed = !sessionsRecentCollapsed;
      const listEl = document.getElementById('sessionsList');
      if (listEl) listEl.style.display = sessionsRecentCollapsed ? 'none' : 'flex';
    });
    if (sessionSearchInput) {
      sessionSearchInput.addEventListener('input', () => {
        renderSessionsList(sessionSearchInput.value.trim());
      });
    }

    // Composer modes
    let activeComposerMode = 'agent';
    document.querySelectorAll('.mode-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const m = tab.getAttribute('data-mode') || 'agent';
        activeComposerMode = m;
        document.querySelectorAll('.mode-tab').forEach((t) => t.classList.toggle('active', t === tab));
        if (m === 'review') {
          if (typeof switchInspectorTab === 'function') switchInspectorTab('changes');
          vscode.postMessage({ command: 'reviewCritic' });
          return;
        }
        const mappedExec = m === 'plan' ? 'plan' : m === 'ask' ? 'ask' : 'code';
        setExecutionModeUI(mappedExec);
        vscode.postMessage({ command: 'setExecutionMode', executionMode: mappedExec });
      });
    });

    // New Session
    document.getElementById('btnNewSession')?.addEventListener('click', () => vscode.postMessage({ command: 'newSession' }));
    document.getElementById('btnHeaderNewSession')?.addEventListener('click', () => vscode.postMessage({ command: 'newSession' }));

    // Changes actions
    document.getElementById('btnAcceptAll').addEventListener('click', () => vscode.postMessage({ command: 'acceptAll' }));
    document.getElementById('btnRejectAll').addEventListener('click', () => vscode.postMessage({ command: 'rejectAll' }));
    document.getElementById('btnCriticReview').addEventListener('click', () => vscode.postMessage({ command: 'reviewCritic' }));
    const btnRevertFile = document.getElementById('btnRevertFile');
    if (btnRevertFile) {
      btnRevertFile.addEventListener('click', () => {
        if (!selectedDiffFile) return;
        vscode.postMessage({ command: 'rejectFile', path: selectedDiffFile });
      });
    }

    const slashPopupEl = document.getElementById('slashCommandPopup');
    function dispatchSlashCommand(rawCmd) {
      if (!rawCmd) return;
      if (slashCtrl) slashCtrl.close();
      promptInput.value = '';
      promptInput.style.height = 'auto';
      const subId = 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      vscode.postMessage({
        command: 'runSlashCommand',
        text: rawCmd,
        attachments: Array.isArray(cachedConfig?.attachedFiles) ? cachedConfig.attachedFiles.slice() : [],
        clientSubmissionId: subId,
      });
    }

    const slashCtrl = lcCreateSlashController({
      promptEl: promptInput,
      popupEl: slashPopupEl,
      getCatalog: () => slashCommandsCatalog,
      getModels: () => (typeof cachedAllModelsList !== 'undefined' ? cachedAllModelsList : []),
      onSubmitSlash: (cmdLine) => dispatchSlashCommand(cmdLine),
    });

    document.addEventListener('click', (e) => {
      if (slashPopupEl && !slashPopupEl.contains(e.target) && e.target !== promptInput) {
        slashCtrl.close();
      }
    });

    // Prompt input
    promptInput.addEventListener('input', () => {
      promptInput.style.height = 'auto';
      promptInput.style.height = Math.min(promptInput.scrollHeight, 160) + 'px';
      slashCtrl.refreshFromInput();
    });

    promptInput.addEventListener('keydown', (e) => {
      if (slashCtrl.handleKeyDown(e)) {
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitPrompt();
      }
    });

    btnSend.addEventListener('click', submitPrompt);
    btnStop.addEventListener('click', () => {
      isWorking = false;
      liveStatusState = { active: false, phase: 'cancelled', summary: 'Cancelled' };
      updateStatusUI();
      vscode.postMessage({ command: 'stopTask' });
    });

    modelSelector.addEventListener('click', () => {
      vscode.postMessage({ command: 'selectModel' });
    });

    let lastPromptSentSig = '';
    let lastPromptSentAt = 0;

    function submitPrompt() {
      const text = promptInput.value.trim();
      if (!text) return;
      if (lcIsSlashCommandInput(text)) {
        dispatchSlashCommand(text);
        return;
      }
      const now = Date.now();
      const attachedSnapshot = Array.isArray(cachedConfig?.attachedFiles) ? cachedConfig.attachedFiles.slice() : [];
      const sig = text + '::' + attachedSnapshot.join('|');
      if (sig === lastPromptSentSig && now - lastPromptSentAt < 300) {
        return;
      }
      lastPromptSentSig = sig;
      lastPromptSentAt = now;

      slashCtrl.close();
      promptInput.value = '';
      promptInput.style.height = 'auto';
      chatPinnedToBottom = true;

      if (!isWorking) {
        isWorking = true;
        liveStatusState = { active: true, phase: 'analyzing', summary: 'Analyzing the task' };
        updateStatusUI();
      }
      const clientSubmissionId = 'sub_' + now + '_' + Math.random().toString(36).slice(2, 7);
      vscode.postMessage({
        command: 'sendMessage',
        text,
        attachments: attachedSnapshot,
        clientSubmissionId,
      });
    }

    function updateStatusUI() {
      btnSend.style.display = 'flex';
      btnSend.disabled = false;
      if (isWorking) {
        btnSend.title = 'Add to Queue (Enter)';
        btnStop.style.display = 'flex';
        topStatusBadge.className = 'status-badge status-running';
        topStatusBadge.textContent = 'Running';
      } else {
        btnSend.title = 'Send Prompt (Enter)';
        btnStop.style.display = 'none';
        topStatusBadge.className = 'status-badge status-ready';
        topStatusBadge.textContent = 'Ready';
      }
    }

    function formatTimeAgo(ts) {
      return lcFormatSessionTimeAgo(ts);
    }

    let renamingSessionId = null;
    let confirmingDeleteSessionId = null;

    function beginInlineSessionRename(sessionId) {
      if (!sessionId) return;
      confirmingDeleteSessionId = null;
      renamingSessionId = sessionId;
      renderSessionsList(document.getElementById('sessionSearchInput')?.value.trim() || '');
    }

    document.getElementById('btnRenameActiveSession')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentSession?.id) {
        beginInlineSessionRename(currentSession.id);
      }
    });
    document.getElementById('topSessionTitle')?.addEventListener('dblclick', () => {
      if (currentSession?.id) {
        beginInlineSessionRename(currentSession.id);
      }
    });

    function buildSessionRowElement(s, filterQuery, isChild = false) {
      const isRenaming = renamingSessionId === s.id;
      const isConfirmingDelete = confirmingDeleteSessionId === s.id;
      const isRunningSess = s.status === 'running';
      const item = document.createElement('div');
      item.className = 'lc-sess-row' +
        (currentSession && s.id === currentSession.id ? ' active' : '') +
        (isConfirmingDelete ? ' confirming' : '') +
        (isChild ? ' child' : '');

      const actionsHtml = isConfirmingDelete
        ? '<button class="session-confirm-btn" type="button" title="Confirm delete">Delete</button>' +
          '<button class="session-act-btn btn-cancel-delete" type="button" title="Cancel">' + lcIcon('x', 12) + '</button>'
        : '<button class="session-act-btn btn-rename-session" type="button" title="Rename session">' + lcIcon('pencil', 12) + '</button>' +
          '<button class="session-act-btn btn-delete-session" type="button" title="Delete session">' + lcIcon('trash-2', 12) + '</button>';

      const titleHtml = isRenaming
        ? '<input class="session-rename-input" type="text" value="' + escapeHtml(s.title) + '" />'
        : '<div class="lc-sess-name" title="' + escapeHtml(s.title) + '">' + escapeHtml(s.title) + '</div>';

      item.innerHTML =
        '<span class="lc-sess-gutter"><span class="lc-sess-dot' + (isRunningSess ? ' running' : '') + '"></span></span>' +
        '<div class="lc-sess-main">' +
          '<div class="lc-sess-top">' +
            titleHtml +
            '<div class="lc-sess-row-actions">' + actionsHtml + '</div>' +
          '</div>' +
          '<div class="lc-sess-meta">' +
            '<span class="lc-sess-time">' + escapeHtml(formatTimeAgo(s.updatedAt || s.createdAt)) + '</span>' +
          '</div>' +
        '</div>';

      if (isRenaming) {
        const input = item.querySelector('.session-rename-input');
        let committed = false;
        const finishRename = (save) => {
          if (committed) return;
          committed = true;
          const nextTitle = input ? input.value.trim() : '';
          renamingSessionId = null;
          if (save && nextTitle && nextTitle !== s.title) {
            vscode.postMessage({ command: 'renameSession', sessionId: s.id, title: nextTitle });
          } else {
            renderSessionsList(filterQuery);
          }
        };
        if (input) {
          input.addEventListener('click', (e) => e.stopPropagation());
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              finishRename(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              finishRename(false);
            }
          });
          input.addEventListener('blur', () => finishRename(true));
          setTimeout(() => {
            input.focus();
            input.select();
          }, 0);
        }
      } else {
        item.querySelector('.lc-sess-name')?.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          beginInlineSessionRename(s.id);
        });
        item.querySelector('.btn-rename-session')?.addEventListener('click', (e) => {
          e.stopPropagation();
          beginInlineSessionRename(s.id);
        });
        item.querySelector('.btn-delete-session')?.addEventListener('click', (e) => {
          e.stopPropagation();
          renamingSessionId = null;
          confirmingDeleteSessionId = s.id;
          renderSessionsList(filterQuery);
        });
        item.querySelector('.session-confirm-btn')?.addEventListener('click', (e) => {
          e.stopPropagation();
          confirmingDeleteSessionId = null;
          vscode.postMessage({ command: 'deleteSession', sessionId: s.id, confirmed: true });
        });
        item.querySelector('.btn-cancel-delete')?.addEventListener('click', (e) => {
          e.stopPropagation();
          confirmingDeleteSessionId = null;
          renderSessionsList(filterQuery);
        });
        item.addEventListener('click', (e) => {
          if (e.target.closest('.lc-sess-row-actions')) return;
          confirmingDeleteSessionId = null;
          vscode.postMessage({ command: 'switchSession', sessionId: s.id });
        });
      }

      return item;
    }

    function renderSessionsList(filterQuery = '') {
      const container = document.getElementById('sessionsList');
      if (!container) return;
      container.innerHTML = '';

      let list = filterQuery
        ? allSessionsList.filter((s) => (s.title || '').toLowerCase().includes(filterQuery.toLowerCase()))
        : allSessionsList.slice();

      if (sessionSortMode === 'alpha') {
        list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      } else {
        list.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      }

      if (list.length === 0) {
        container.innerHTML = '<div class="lc-sess-empty">No sessions found</div>';
        return;
      }

      if (groupSessionsByFolder) {
        const byFolder = new Map();
        list.forEach((s) => {
          const root = s.workspaceRoot || 'Workspace';
          const folderLabel = root.split(/[\\/]/).filter(Boolean).pop() || 'Workspace';
          if (!byFolder.has(folderLabel)) byFolder.set(folderLabel, []);
          byFolder.get(folderLabel).push(s);
        });

        for (const [folderName, groupItems] of byFolder.entries()) {
          if (groupItems.length === 1) {
            container.appendChild(buildSessionRowElement(groupItems[0], filterQuery, false));
            continue;
          }
          const isCollapsed = collapsedFolderGroups.has(folderName);
          const groupHdr = document.createElement('div');
          groupHdr.className = 'lc-sess-group-header';
          const latestTs = groupItems[0]?.updatedAt || groupItems[0]?.createdAt;
          groupHdr.innerHTML =
            '<span class="lc-sess-gutter">' + lcIcon(isCollapsed ? 'chevron-right' : 'chevron-down', 12) + '</span>' +
            '<div class="lc-sess-main">' +
              '<div class="lc-sess-top"><div class="lc-sess-name">' + escapeHtml(folderName) + ' (' + groupItems.length + ')</div></div>' +
              '<div class="lc-sess-meta"><span class="lc-sess-time">' + escapeHtml(formatTimeAgo(latestTs)) + '</span></div>' +
            '</div>';
          groupHdr.addEventListener('click', () => {
            if (collapsedFolderGroups.has(folderName)) collapsedFolderGroups.delete(folderName);
            else collapsedFolderGroups.add(folderName);
            renderSessionsList(filterQuery);
          });
          container.appendChild(groupHdr);

          if (!isCollapsed) {
            const childrenWrap = document.createElement('div');
            childrenWrap.className = 'lc-sess-group-children';
            groupItems.forEach((s) => childrenWrap.appendChild(buildSessionRowElement(s, filterQuery, true)));
            container.appendChild(childrenWrap);
          }
        }
        return;
      }

      list.forEach((s) => {
        container.appendChild(buildSessionRowElement(s, filterQuery, false));
      });
    }

    function renderChangesList() {
      const statsBadge = document.getElementById('changesStats');
      statsBadge.textContent = currentChanges.totalFiles + ' files +' + currentChanges.totalAdded + ' -' + currentChanges.totalRemoved;
      const changesCountBadge = document.getElementById('changesCountBadge');
      if (changesCountBadge) changesCountBadge.textContent = String(currentChanges.totalFiles || 0);

      const listContainer = document.getElementById('changesFilesList');
      listContainer.innerHTML = '';
      if (!currentChanges.files || currentChanges.files.length === 0) {
        selectedDiffFile = null;
        const lbl = document.getElementById('diffActiveFileLabel');
        if (lbl) lbl.textContent = 'Select a file to view live diff';
        const diffEl = document.getElementById('diffCodeContainer');
        if (diffEl) diffEl.innerHTML = '<div class="diff-line info">// No diff available</div>';
        listContainer.innerHTML = '<div style="padding:10px;font-size:11.5px;color:#64748b;text-align:center;">No changes in workspace</div>';
        return;
      }

      if (selectedDiffFile && !currentChanges.files.some((f) => f.path === selectedDiffFile)) {
        selectedDiffFile = null;
      }

      currentChanges.files.forEach((f) => {
        const item = document.createElement('div');
        item.className = 'change-file-item' + (selectedDiffFile === f.path ? ' selected' : '');
        const statusClass = f.status === 'M' ? 'm' : f.status === 'A' ? 'a' : 'd';
        item.innerHTML = '<div class="file-name-wrap">' +
          '<span class="file-status-tag ' + statusClass + '">' + f.status + '</span>' +
          '<span>' + escapeHtml(f.filename) + '</span>' +
          '</div>' +
          '<span style="font-size:10px;color:#94a3b8;">+' + f.added + ' -' + f.removed + '</span>';

        item.addEventListener('click', () => {
          selectedDiffFile = f.path;
          renderChangesList();
          document.getElementById('diffActiveFileLabel').textContent = f.path;
          vscode.postMessage({ command: 'getFileDiff', path: f.path });
        });
        listContainer.appendChild(item);
      });

      if (!selectedDiffFile && currentChanges.files.length > 0) {
        selectedDiffFile = currentChanges.files[0].path;
        document.getElementById('diffActiveFileLabel').textContent = selectedDiffFile;
        vscode.postMessage({ command: 'getFileDiff', path: selectedDiffFile });
      }
    }

    function renderDiffCode(diff) {
      const container = document.getElementById('diffCodeContainer');
      container.innerHTML = '';
      if (!diff) {
        container.innerHTML = '<div class="diff-line info">// No diff available</div>';
        return;
      }
      const lines = diff.split('\\n');
      lines.forEach((line) => {
        const el = document.createElement('div');
        if (line.startsWith('+') && !line.startsWith('+++')) {
          el.className = 'diff-line add';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          el.className = 'diff-line del';
        } else if (line.startsWith('@@') || line.startsWith('diff')) {
          el.className = 'diff-line info';
        } else {
          el.className = 'diff-line';
        }
        el.textContent = line;
        container.appendChild(el);
      });
    }

    function matchesActivityFilter(item) {
      if (!item) return false;
      if (activeActivityFilter === 'all') return true;
      if (activeActivityFilter === 'tool') {
        return item.category === 'tool' || item.category === 'mcp' || item.category === 'browser';
      }
      return item.category === activeActivityFilter;
    }

    function upsertActivityInPane(item) {
      const countBadge = document.getElementById('activityCountBadge');
      if (countBadge) countBadge.textContent = String(currentActivities.length);
      const feed = document.getElementById('activityFeedList');
      if (!feed || !item || !matchesActivityFilter(item)) return;
      const existingCard = lcFindChildByAttr(feed, 'data-act-id', item.id);
      if (existingCard) {
        lcUpdateActivityCardElement(existingCard, item);
        return;
      }
      renderActivityPane();
    }

    function renderActivityPane() {
      const countBadge = document.getElementById('activityCountBadge');
      if (countBadge) countBadge.textContent = String(currentActivities.length);

      const planMini = document.getElementById('activityPlanMini');
      if (planMini) {
        if (activePlan && activePlan.length > 0) {
          planMini.style.display = 'flex';
          planMini.innerHTML = lcBuildPlanMiniHtml(activePlan);
        } else {
          planMini.style.display = 'none';
          planMini.innerHTML = '';
        }
      }

      const feed = document.getElementById('activityFeedList');
      if (!feed) return;

      const filtered = currentActivities.filter(matchesActivityFilter);
      if (filtered.length === 0) {
        feed.innerHTML = '<div class="lc-empty-pane">' + lcIcon('zap', 20) + '<span>No activity recorded for this filter.</span></div>';
        return;
      }

      const prevTop = Number(feed.scrollTop || 0);
      const wasPinned = (feed.scrollHeight - prevTop - feed.clientHeight) <= 32;

      feed.innerHTML = '';
      filtered.forEach((item) => {
        const card = lcBuildActivityCardElement(
          item,
          expandedActivityIds.has(item.id),
          (id, isOpen) => {
            if (isOpen) expandedActivityIds.add(id);
            else expandedActivityIds.delete(id);
          }
        );
        feed.appendChild(card);
      });
      if (wasPinned) {
        feed.scrollTop = feed.scrollHeight;
      } else if (prevTop > 0) {
        feed.scrollTop = prevTop;
      }
    }

    document.getElementById('btnRefreshTelemetry')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'refreshSystemTelemetry' });
    });

    function telemetryLoadDotClass(pct) {
      if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'idle';
      if (pct >= 90) return 'hot';
      if (pct >= 75) return 'warn';
      return '';
    }

    function renderSystemTelemetry(t) {
      const container = document.getElementById('systemTelemetryMetrics');
      if (!container || !t) return;
      const parts = [];
      const ol = t.ollama || {};
      const activeList = Array.isArray(ol.activeModels) ? ol.activeModels : [];
      const olLabel = ol.running
        ? (activeList.length > 0 ? activeList.join(', ') + (ol.totalVramGb ? ' (' + ol.totalVramGb + ' GB VRAM)' : '') : 'Ollama Ready')
        : 'Ollama Offline';
      parts.push(
        '<span class="lc-sys-badge local-runtime' + (ol.running ? '' : ' offline') + '" title="Local Ollama Runtime">' +
        '<span class="lc-sys-dot ' + (ol.running ? '' : 'idle') + '"></span>' +
        '<span class="lc-sys-k">LOCAL</span>' +
        '<span class="lc-sys-v">' + escapeHtml(olLabel) + '</span>' +
        '</span>'
      );

      if (t.cpu) {
        const cpuPct = typeof t.cpu.usagePercent === 'number' ? t.cpu.usagePercent : 0;
        parts.push(
          '<span class="lc-sys-badge" title="' + escapeHtml(t.cpu.model || 'CPU') + ' (' + (t.cpu.cores || 0) + ' threads)">' +
          lcIcon('cpu', 11) +
          '<span class="lc-sys-dot ' + telemetryLoadDotClass(cpuPct) + '"></span>' +
          '<span class="lc-sys-k">CPU</span>' +
          '<span class="lc-sys-v">' + escapeHtml(t.cpu.shortModel || 'CPU') + ' (' + (t.cpu.cores || 0) + 'c) · ' + cpuPct + '%</span>' +
          '</span>'
        );
      }

      if (t.ram) {
        const ramPct = typeof t.ram.usagePercent === 'number' ? t.ram.usagePercent : 0;
        parts.push(
          '<span class="lc-sys-badge" title="System Memory Used / Total">' +
          lcIcon('server', 11) +
          '<span class="lc-sys-dot ' + telemetryLoadDotClass(ramPct) + '"></span>' +
          '<span class="lc-sys-k">RAM</span>' +
          '<span class="lc-sys-v">' + (t.ram.usedGb ?? 0) + ' / ' + (t.ram.totalGb ?? 0) + ' GB (' + ramPct + '%)</span>' +
          '</span>'
        );
      }

      if (t.gpu) {
        const usedGb = (t.gpu.memoryUsedMb / 1024).toFixed(1);
        const totalGb = (t.gpu.memoryTotalMb / 1024).toFixed(1);
        const vramPct = t.gpu.memoryTotalMb > 0 ? Math.round((t.gpu.memoryUsedMb / t.gpu.memoryTotalMb) * 100) : 0;
        const util = typeof t.gpu.utilizationPercent === 'number' ? t.gpu.utilizationPercent : 0;
        const tempStr = typeof t.gpu.temperatureC === 'number' ? ' · ' + t.gpu.temperatureC + '°C' : '';
        parts.push(
          '<span class="lc-sys-badge" title="' + escapeHtml(t.gpu.name || 'GPU') + ' | VRAM ' + t.gpu.memoryUsedMb + '/' + t.gpu.memoryTotalMb + ' MB">' +
          lcIcon('zap', 11) +
          '<span class="lc-sys-dot ' + telemetryLoadDotClass(Math.max(vramPct, util)) + '"></span>' +
          '<span class="lc-sys-k">GPU</span>' +
          '<span class="lc-sys-v">' + escapeHtml(t.gpu.shortName || 'GPU') + ' · ' + usedGb + ' / ' + totalGb + ' GB · ' + util + '%' + tempStr + '</span>' +
          '</span>'
        );
      } else {
        parts.push(
          '<span class="lc-sys-badge" title="No discrete NVIDIA GPU detected via nvidia-smi">' +
          lcIcon('zap', 11) +
          '<span class="lc-sys-dot idle"></span>' +
          '<span class="lc-sys-k">GPU</span>' +
          '<span class="lc-sys-v">CPU / Integrated</span>' +
          '</span>'
        );
      }

      container.innerHTML = parts.join('');
    }

    function updateTerminalTabs(nextTabs) {
      const prevIds = new Set((terminalTabsState || []).map((t) => t.id));
      terminalTabsState = Array.isArray(nextTabs) ? nextTabs : [];
      if (prevIds.size > 0) {
        const addedTab = terminalTabsState.find((t) => !prevIds.has(t.id));
        if (addedTab) {
          activeTermTabId = addedTab.id;
        }
      }
      renderTerminalPane();
    }

    function renderTerminalPane() {
      const tabsBar = document.getElementById('termTabsBar');
      const outputEl = document.getElementById('termOutputScroll');
      const cwdEl = document.getElementById('termCwdLabel');
      const statusEl = document.getElementById('termStatusBadge');
      const stopBtn = document.getElementById('btnTermStop');
      if (!tabsBar || !outputEl) return;

      if (!terminalTabsState || terminalTabsState.length === 0) {
        tabsBar.innerHTML = '';
        outputEl.innerHTML = '<div class="lc-term-line system">Initializing terminal...</div>';
        return;
      }

      let activeTab = terminalTabsState.find((t) => t.id === activeTermTabId);
      if (!activeTab) {
        activeTab = terminalTabsState[0];
        activeTermTabId = activeTab.id;
      }

      tabsBar.innerHTML = '';
      terminalTabsState.forEach((t) => {
        const btn = document.createElement('div');
        btn.className = 'lc-term-tab' + (t.id === activeTab.id ? ' active' : '');
        btn.innerHTML = '<span>' + escapeHtml(t.name) + '</span>' +
          (terminalTabsState.length > 1 ? '<span class="lc-term-tab-close" data-close-tab="' + escapeHtml(t.id) + '" title="Close">' + lcIcon('x', 11) + '</span>' : '');
        btn.addEventListener('click', (e) => {
          const closeEl = e.target.closest('[data-close-tab]');
          if (closeEl) {
            e.stopPropagation();
            vscode.postMessage({ command: 'closeTerminalTab', tabId: t.id });
            return;
          }
          activeTermTabId = t.id;
          renderTerminalPane();
        });
        tabsBar.appendChild(btn);
      });

      if (cwdEl) cwdEl.textContent = activeTab.cwd || 'workspace';
      if (statusEl) {
        const st = activeTab.status || 'idle';
        statusEl.className = 'lc-act-status-pill ' + (st === 'running' ? 'running' : st === 'failed' ? 'failed' : st === 'killed' ? 'cancelled' : 'completed');
        statusEl.textContent = st === 'running' ? 'Running' : st === 'killed' ? 'Stopped' : st === 'failed' ? 'Failed' : 'Ready';
      }
      if (stopBtn) {
        stopBtn.style.display = activeTab.status === 'running' ? 'inline-flex' : 'none';
      }
      if (termCmdInput) {
        termCmdInput.placeholder = activeTab.status === 'running'
          ? 'Send input to running process (Enter)...'
          : 'Run command in workspace...';
      }

      outputEl.innerHTML = (activeTab.lines || []).map((line) => {
        return '<div class="lc-term-line ' + escapeHtml(line.stream || 'stdout') + '">' + escapeHtml(line.text) + '</div>';
      }).join('');
      outputEl.scrollTop = outputEl.scrollHeight;
    }

    function createAssistantCardElement(msg) {
      const card = document.createElement('div');
      card.className = 'message-card ' + (msg.senderRole || 'assistant');
      card.setAttribute('data-msg-id', msg.id || '');
      card.innerHTML = '<div class="message-agent-wrap">' +
        '<div class="agent-avatar">' + lcIcon('bot', 13) + '</div>' +
        '<div class="agent-content-area">' +
        '<div class="agent-header">' +
        '<span class="agent-name">' + escapeHtml(msg.senderName || 'Main Agent') + '</span>' +
        '</div>' +
        '<div class="agent-text">' + formatMarkdown(msg.content) + '</div>' +
        '</div>' +
        '</div>';
      return card;
    }

    function updateOrAppendSafeStatus() {
      let row = document.getElementById('liveSafeStatusRow');
      if (liveStatusState.active && isWorking) {
        if (!row) {
          row = document.createElement('div');
          row.id = 'liveSafeStatusRow';
          row.className = 'lc-live-status-row';
          conversationFlow.appendChild(row);
        }
        row.innerHTML = '<span class="lc-status-pulse"></span>' +
          '<span class="lc-live-status-text">' + escapeHtml(liveStatusState.summary || 'Agent is working') + '</span>';
      } else if (row) {
        row.remove();
      }
    }

    function getDisplayMessages() {
      const displayMessages = [];
      if (currentSession && currentSession.messages) {
        const seenIds = new Set();
        let prevUserText = '';
        currentSession.messages.forEach((msg) => {
          if (msg.id) {
            if (seenIds.has(msg.id)) return;
            seenIds.add(msg.id);
          }
          if (msg.senderRole === 'user') {
            const trimmed = (msg.content || '').trim();
            if (trimmed && trimmed === prevUserText) {
              return;
            }
            prevUserText = trimmed;
          } else {
            prevUserText = '';
          }
          displayMessages.push(msg);
        });
      }
      return displayMessages;
    }

    function thinkingGroupHandlers() {
      return {
        expandedActivityIds,
        expandedThoughtIds,
        onToggleTurn: (k, open) => {
          if (open) expandedTurnIds.add(k);
          else expandedTurnIds.delete(k);
        },
        onToggleActivity: (id, open) => {
          if (open) expandedActivityIds.add(id);
          else expandedActivityIds.delete(id);
        },
        onToggleExpandThought: (id, open) => {
          if (open) expandedThoughtIds.add(id);
          else expandedThoughtIds.delete(id);
        },
      };
    }

    function captureInnerScrollState() {
      const thoughtScrolls = new Map();
      const preScrolls = new Map();
      conversationFlow.querySelectorAll('.lc-thought-entry[data-act-id]').forEach((entry) => {
        const actId = entry.getAttribute('data-act-id');
        const body = entry.querySelector('.lc-thought-body');
        if (!actId || !body) return;
        const top = Number(body.scrollTop || 0);
        const gap = Number(body.scrollHeight || 0) - top - Number(body.clientHeight || 0);
        thoughtScrolls.set(actId, { scrollTop: top, wasAtBottom: top > 0 && gap <= 24 });
      });
      conversationFlow.querySelectorAll('.lc-activity-card[data-act-id]').forEach((card) => {
        const actId = card.getAttribute('data-act-id');
        if (!actId) return;
        const outPre = card.querySelector('.lc-terminal-pre.is-stdout');
        const errPre = card.querySelector('.lc-terminal-pre.is-stderr');
        const snap = (el) => {
          if (!el) return null;
          const top = Number(el.scrollTop || 0);
          const gap = Number(el.scrollHeight || 0) - top - Number(el.clientHeight || 0);
          return { scrollTop: top, wasAtBottom: top > 0 && gap <= 24 };
        };
        const outSnap = snap(outPre);
        const errSnap = snap(errPre);
        if (outSnap || errSnap) {
          preScrolls.set(actId, { out: outSnap, err: errSnap });
        }
      });
      return { thoughtScrolls, preScrolls };
    }

    function restoreInnerScrollState(saved) {
      if (!saved) return;
      const applySnap = (el, snap) => {
        if (!el || !snap) return;
        if (snap.wasAtBottom) {
          el.scrollTop = Math.max(0, Number(el.scrollHeight || 0) - Number(el.clientHeight || 0));
        } else if (snap.scrollTop > 0) {
          el.scrollTop = snap.scrollTop;
        }
      };
      saved.thoughtScrolls.forEach((snap, actId) => {
        const entry = lcFindChildByAttr(conversationFlow, 'data-act-id', actId);
        const body = entry ? entry.querySelector('.lc-thought-body') : null;
        applySnap(body, snap);
      });
      saved.preScrolls.forEach((pair, actId) => {
        const card = lcFindChildByAttr(conversationFlow, 'data-act-id', actId);
        if (!card) return;
        applySnap(card.querySelector('.lc-terminal-pre.is-stdout'), pair.out);
        applySnap(card.querySelector('.lc-terminal-pre.is-stderr'), pair.err);
      });
    }

    function syncContainerScroll(forceBottom, prevTop) {
      if (!scrollContainer) return;
      if (forceBottom || chatPinnedToBottom) {
        const targetTop = Math.max(0, Number(scrollContainer.scrollHeight || 0) - Number(scrollContainer.clientHeight || 0));
        if (forceBottom || Math.abs(Number(scrollContainer.scrollTop || 0) - targetTop) > 2) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
        chatPinnedToBottom = true;
      } else if (typeof prevTop === 'number' && prevTop >= 0) {
        if (Math.abs(Number(scrollContainer.scrollTop || 0) - prevTop) > 1) {
          scrollContainer.scrollTop = prevTop;
        }
      }
    }

    function upsertActivityInConversation(item) {
      if (!item || !item.id) return false;
      const displayMessages = getDisplayMessages();
      const turnGrouping = lcGroupActivitiesByUserTurn(displayMessages, currentActivities);
      let targetTurnIdx = -1;
      const turnKeys = Object.keys(turnGrouping.byMsgIndex || {});
      for (let i = 0; i < turnKeys.length; i++) {
        const list = turnGrouping.byMsgIndex[turnKeys[i]] || [];
        if (list.some((a) => a && a.id === item.id)) {
          targetTurnIdx = Number(turnKeys[i]);
          break;
        }
      }

      let turnKey = 'turn_fallback';
      let turnActs = currentActivities;
      let isLatestTurn = turnGrouping.lastTurnMsgIndex === -1;
      if (targetTurnIdx >= 0 && displayMessages[targetTurnIdx]) {
        turnKey = displayMessages[targetTurnIdx].id || ('turn_' + targetTurnIdx);
        turnActs = turnGrouping.byMsgIndex[targetTurnIdx] || [];
        isLatestTurn = targetTurnIdx === turnGrouping.lastTurnMsgIndex;
      } else if (turnGrouping.lastTurnMsgIndex >= 0 && displayMessages[turnGrouping.lastTurnMsgIndex]) {
        const lt = turnGrouping.lastTurnMsgIndex;
        turnKey = displayMessages[lt].id || ('turn_' + lt);
        turnActs = turnGrouping.byMsgIndex[lt] || [];
        isLatestTurn = true;
      }

      const groupEl = lcFindChildByAttr(conversationFlow, 'data-turn-key', turnKey);
      if (!groupEl) {
        renderFullConversation();
        return false;
      }

      lcUpdateInlineThinkingGroupHeader(groupEl, {
        activities: turnActs,
        isLive: isLatestTurn && isWorking,
        statusSummary: isLatestTurn ? liveStatusState.summary : '',
      });

      const drawer = groupEl.querySelector('.lc-thinking-drawer');
      if (!drawer) {
        renderFullConversation();
        return false;
      }

      const emptyNote = drawer.querySelector('.lc-thinking-empty-note');
      if (emptyNote) emptyNote.remove();

      const liveRow = document.getElementById('liveSafeStatusRow');
      if (liveRow && isLatestTurn && isWorking) liveRow.remove();

      const existingNode = lcFindChildByAttr(drawer, 'data-act-id', item.id);
      if (existingNode) {
        if (item.category === 'thinking_summary') {
          lcUpdateThoughtEntryElement(existingNode, item, {
            isExpanded: expandedThoughtIds.has(item.id),
          });
        } else {
          lcUpdateActivityCardElement(existingNode, item);
        }
      } else {
        const handlers = thinkingGroupHandlers();
        if (item.category === 'thinking_summary') {
          drawer.appendChild(lcBuildThoughtEntryElement(item, {
            isExpanded: expandedThoughtIds.has(item.id),
            onToggleExpand: handlers.onToggleExpandThought,
          }));
        } else {
          drawer.appendChild(lcBuildActivityCardElement(
            item,
            expandedActivityIds.has(item.id),
            handlers.onToggleActivity
          ));
        }
      }

      if (chatPinnedToBottom) {
        syncContainerScroll(false);
      }
      return true;
    }

    function updatePlanInConversation() {
      if (planExplicit) {
        renderFullConversation();
        return;
      }
      const displayMessages = getDisplayMessages();
      const turnGrouping = lcGroupActivitiesByUserTurn(displayMessages, currentActivities);
      let turnKey = 'turn_fallback';
      if (turnGrouping.lastTurnMsgIndex >= 0 && displayMessages[turnGrouping.lastTurnMsgIndex]) {
        const lt = turnGrouping.lastTurnMsgIndex;
        turnKey = displayMessages[lt].id || ('turn_' + lt);
      }
      const groupEl = lcFindChildByAttr(conversationFlow, 'data-turn-key', turnKey);
      const drawer = groupEl ? groupEl.querySelector('.lc-thinking-drawer') : null;
      if (!drawer) {
        renderFullConversation();
        return;
      }
      const emptyNote = drawer.querySelector('.lc-thinking-empty-note');
      if (emptyNote && activePlan.length > 0) emptyNote.remove();
      let planListEl = drawer.querySelector('.lc-plan-checklist-mini');
      if (activePlan && activePlan.length > 0) {
        if (!planListEl) {
          planListEl = document.createElement('div');
          planListEl.className = 'lc-plan-checklist-mini';
          planListEl.style.borderBottom = 'none';
          planListEl.style.padding = '2px 0 4px 0';
          drawer.insertBefore(planListEl, drawer.firstChild || null);
        }
        planListEl.innerHTML = lcBuildPlanMiniHtml(activePlan);
      } else if (planListEl) {
        planListEl.remove();
      }
      if (chatPinnedToBottom) {
        syncContainerScroll(false);
      }
    }

    function renderFullConversation(opts) {
      const forceBottom = Boolean(opts && opts.forceScrollBottom);
      const prevContainerTop = scrollContainer ? Number(scrollContainer.scrollTop || 0) : 0;
      const shouldStickBottom = forceBottom || chatPinnedToBottom;
      const savedScrolls = captureInnerScrollState();

      conversationFlow.innerHTML = '';

      if (planExplicit && activePlan && activePlan.length > 0) {
        const planCard = document.createElement('div');
        planCard.className = 'plan-card';
        let planHtml = '<div class="plan-header"><span>Execution Plan</span><span>' +
          activePlan.filter(p => p.status === 'completed').length + '/' + activePlan.length + ' Done</span></div><ul class="plan-list">';
        activePlan.forEach((p) => {
          const isDone = p.status === 'completed';
          const badgeClass = p.status === 'completed' ? 'plan-completed' : p.status === 'in_progress' ? 'plan-in_progress' : 'plan-pending';
          planHtml += '<li class="plan-item' + (isDone ? ' completed' : '') + '">' +
            '<span>' + escapeHtml(p.description || p.title) + '</span>' +
            '<span class="plan-badge ' + badgeClass + '">' + p.status + '</span>' +
            '</li>';
        });
        planHtml += '</ul>';
        planCard.innerHTML = planHtml;
        conversationFlow.appendChild(planCard);
      }

      const displayMessages = getDisplayMessages();
      const turnGrouping = lcGroupActivitiesByUserTurn(displayMessages, currentActivities);
      const handlers = thinkingGroupHandlers();
      let renderedLatestLiveBlock = false;

      const mergedCmdMap = new Map();
      (Array.isArray(currentCommandResults) ? currentCommandResults : []).forEach((cr) => {
        if (cr && cr.id) mergedCmdMap.set(cr.id, cr);
      });
      (Array.isArray(ephemeralCommandResults) ? ephemeralCommandResults : []).forEach((cr) => {
        if (cr && cr.id) mergedCmdMap.set(cr.id, cr);
      });
      const allCmdResults = Array.from(mergedCmdMap.values()).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      let nextCmdIdx = 0;
      const appendCmdCard = (cr) => {
        conversationFlow.appendChild(lcBuildCommandResultElement(cr, {
          onConfirm: (commandLine, cardId) => {
            ephemeralCommandResults = ephemeralCommandResults.filter((x) => x.id !== cardId);
            vscode.postMessage({ command: 'confirmSlashCommand', text: commandLine });
          },
          onCancel: (cardId) => {
            ephemeralCommandResults = ephemeralCommandResults.filter((x) => x.id !== cardId);
            renderFullConversation();
          },
        }));
      };

      displayMessages.forEach((msg, idx) => {
        const msgTs = msg.timestamp || 0;
        while (nextCmdIdx < allCmdResults.length && msgTs > 0 && (allCmdResults[nextCmdIdx].timestamp || 0) <= msgTs) {
          appendCmdCard(allCmdResults[nextCmdIdx++]);
        }
        if (msg.senderRole === 'user') {
          const card = document.createElement('div');
          card.className = 'message-card user';
          card.setAttribute('data-msg-id', msg.id || '');
          card.innerHTML = '<div class="message-user-bubble">' + escapeHtml(msg.content) + '</div>';
          conversationFlow.appendChild(card);

          const turnActs = turnGrouping.byMsgIndex[idx] || [];
          const isLatestTurn = idx === turnGrouping.lastTurnMsgIndex;
          const turnPlan = isLatestTurn && !planExplicit ? activePlan : [];
          if (turnActs.length > 0 || (isLatestTurn && isWorking) || turnPlan.length > 0) {
            if (isLatestTurn && isWorking) renderedLatestLiveBlock = true;
            const turnKey = msg.id || ('turn_' + idx);
            conversationFlow.appendChild(lcBuildInlineThinkingGroup(Object.assign({
              turnKey,
              activities: turnActs,
              planItems: turnPlan,
              isLive: isLatestTurn && isWorking,
              isExpanded: expandedTurnIds.has(turnKey),
              statusSummary: isLatestTurn ? liveStatusState.summary : '',
            }, handlers)));
          }
        } else {
          conversationFlow.appendChild(createAssistantCardElement(msg));
        }
      });

      if (turnGrouping.lastTurnMsgIndex === -1 && (currentActivities.length > 0 || isWorking)) {
        if (isWorking) renderedLatestLiveBlock = true;
        conversationFlow.appendChild(lcBuildInlineThinkingGroup(Object.assign({
          turnKey: 'turn_fallback',
          activities: currentActivities,
          planItems: !planExplicit ? activePlan : [],
          isLive: isWorking,
          isExpanded: expandedTurnIds.has('turn_fallback'),
          statusSummary: liveStatusState.summary,
        }, handlers)));
      }

      while (nextCmdIdx < allCmdResults.length) {
        appendCmdCard(allCmdResults[nextCmdIdx++]);
      }

      // Render any active streaming assistant responses (in-place without duplicates)
      Object.keys(streamingMessages).forEach((mId) => {
        const sm = streamingMessages[mId];
        if (sm && sm.content) {
          conversationFlow.appendChild(createAssistantCardElement({
            id: mId,
            senderName: sm.agentName || 'Main Agent',
            senderRole: sm.senderRole || 'assistant',
            content: sm.content,
          }));
        }
      });

      if (!renderedLatestLiveBlock) {
        updateOrAppendSafeStatus();
      }

      const hasMsgs = (currentSession && currentSession.messages && currentSession.messages.length > 0) || allCmdResults.length > 0 || Object.keys(streamingMessages).length > 0;
      if (!hasMsgs && !isWorking) {
        const wsName = document.getElementById('topWorkspacePill')?.textContent?.trim() || 'workspace';
        const empty = document.createElement('div');
        empty.className = 'lc-empty-workspace';
        empty.innerHTML =
          '<div class="lc-empty-workspace-title">' + escapeHtml(wsName) + '</div>' +
          '<div class="lc-empty-workspace-sub">Enter a task or question below. Ctrl+K switches models.</div>';
        conversationFlow.appendChild(empty);
      }

      restoreInnerScrollState(savedScrolls);
      syncContainerScroll(shouldStickBottom, prevContainerTop);
    }

    function formatDuration(ms) {
      if (!ms || ms <= 0) return '0s';
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return sec + 's';
      const min = Math.floor(sec / 60);
      const remSec = sec % 60;
      return min + 'm ' + remSec + 's';
    }


    // Popovers Elements & State
    const popoverBackdrop = document.getElementById('popoverBackdrop');
    const attachMenuPopover = document.getElementById('attachMenuPopover');
    const execModePopover = document.getElementById('execModePopover');
    const permModePopover = document.getElementById('permModePopover');
    const modelSelectorPopover = document.getElementById('modelSelectorPopover');
    const modelConfigPopover = document.getElementById('modelConfigPopover');

    const btnAttachment = document.getElementById('btnAttachment');
    const btnExecMode = document.getElementById('btnExecMode');
    const btnPermMode = document.getElementById('btnPermMode');
    const btnEffortConfig = document.getElementById('btnEffortConfig');
    const modelSearchInput = document.getElementById('modelSearchInput');
    const btnClearModelSearch = document.getElementById('btnClearModelSearch');
    const modelCategoriesContainer = document.getElementById('modelCategoriesContainer');
    const attachedChipsRow = document.getElementById('attachedChipsRow');

    const execModeLabel = document.getElementById('execModeLabel');
    const permModeLabel = document.getElementById('permModeLabel');
    const activeEffortLabel = document.getElementById('activeEffortLabel');
    const modelProviderIcon = document.getElementById('modelProviderIcon');
    const cfgActiveModelName = document.getElementById('cfgActiveModelName');
    const cfgResourceTitle = document.getElementById('cfgResourceTitle');
    const cfgResourceDesc = document.getElementById('cfgResourceDesc');
    const chkFastMode = document.getElementById('chkFastMode');

    let cachedGroupedModels = { local: [], cloud: [], providers: [] };
    let cachedConfig = {
      modelId: '',
      modelName: '',
      providerId: 'ollama',
      reasoningEffort: 'medium',
      fastMode: false,
      executionMode: 'code',
      permissionMode: 'smart',
      attachedFiles: [],
    };

    function closeAllPopovers() {
      popoverBackdrop.classList.remove('active');
      attachMenuPopover.classList.remove('open');
      execModePopover.classList.remove('open');
      permModePopover.classList.remove('open');
      modelSelectorPopover.classList.remove('open');
      modelConfigPopover.classList.remove('open');
    }

    popoverBackdrop.addEventListener('click', closeAllPopovers);

    function togglePopover(popover, triggerEl, alignRight = false) {
      const isOpen = popover.classList.contains('open');
      closeAllPopovers();
      if (!isOpen) {
        popoverBackdrop.classList.add('active');
        popover.classList.add('open');
        popover.style.bottom = 'calc(100% + 8px)';
        if (alignRight) {
          popover.style.right = '12px';
          popover.style.left = 'auto';
        } else {
          popover.style.left = '12px';
          popover.style.right = 'auto';
        }
      }
    }

    btnAttachment.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover(attachMenuPopover, btnAttachment, false);
    });

    btnExecMode.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover(execModePopover, btnExecMode, false);
    });

    btnPermMode.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover(permModePopover, btnPermMode, false);
    });

    modelSelector.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover(modelSelectorPopover, modelSelector, true);
      setTimeout(() => {
        modelSearchInput.focus();
        modelSearchInput.select();
      }, 50);
    });

    btnEffortConfig.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover(modelConfigPopover, btnEffortConfig, true);
    });

    // Keyboard Shortcuts (Ctrl+K / Cmd+K and Escape)
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        togglePopover(modelSelectorPopover, modelSelector, true);
        setTimeout(() => {
          modelSearchInput.focus();
          modelSearchInput.select();
        }, 50);
      } else if (e.key === 'Escape') {
        closeAllPopovers();
        if (slashCtrl) slashCtrl.close();
      }
    });

    ${getModelSelectorScript({ modelLabelElementId: 'activeModelLabel' })}

    // Execution Mode Handling
    document.querySelectorAll('#execModePopover .popover-card-option[data-exec]').forEach((opt) => {
      opt.addEventListener('click', () => {
        const mode = opt.getAttribute('data-exec');
        setExecutionModeUI(mode);
        vscode.postMessage({ command: 'setExecutionMode', executionMode: mode });
        closeAllPopovers();
      });
    });

    function setExecutionModeUI(mode) {
      cachedConfig.executionMode = mode;
      document.querySelectorAll('#execModePopover .popover-card-option[data-exec]').forEach((el) => {
        el.classList.toggle('active', el.getAttribute('data-exec') === mode);
      });
      const tabTarget = mode === 'plan' ? 'plan' : mode === 'ask' ? 'ask' : 'agent';
      document.querySelectorAll('.mode-tab').forEach((t) => {
        t.classList.toggle('active', t.getAttribute('data-mode') === tabTarget);
      });
      const labels = {
        code: lcIcon('code', 13) + '<span>Code</span>',
        smart: lcIcon('sparkles', 13) + '<span>Smart</span>',
        ask: lcIcon('message-square', 13) + '<span>Ask</span>',
        plan: lcIcon('list-checks', 13) + '<span>Plan</span>',
      };
      execModeLabel.innerHTML = labels[mode] || (lcIcon('code', 13) + '<span>Code</span>');
    }

    // Permission Mode Handling
    document.querySelectorAll('#permModePopover .popover-card-option[data-perm], #execModePopover .popover-card-option[data-perm]').forEach((opt) => {
      opt.addEventListener('click', () => {
        const mode = opt.getAttribute('data-perm');
        setPermissionModeUI(mode);
        vscode.postMessage({ command: 'setPermissionMode', permissionMode: mode });
        closeAllPopovers();
      });
    });

    function setPermissionModeUI(mode) {
      cachedConfig.permissionMode = mode;
      document.querySelectorAll('#permModePopover .popover-card-option[data-perm]').forEach((el) => {
        el.classList.toggle('active', el.getAttribute('data-perm') === mode);
      });
      const bypassOpt = document.getElementById('optBypassPerms');
      if (bypassOpt) {
        bypassOpt.classList.toggle('active', mode === 'bypass');
      }
      const btnPerm = document.getElementById('btnPermMode');
      if (btnPerm) {
        btnPerm.classList.toggle('bypass-active', mode === 'bypass');
      }
      const labels = {
        ask: lcIcon('shield', 13) + '<span>Ask Before Actions</span>',
        smart: lcIcon('shield-check', 13) + '<span>Smart Approval</span>',
        bypass: lcIcon('shield-alert', 13) + '<span>Bypass Permissions</span>',
      };
      permModeLabel.innerHTML = labels[mode] || (lcIcon('shield-check', 13) + '<span>Smart Approval</span>');
    }

    chkFastMode.addEventListener('change', () => {
      cachedConfig.fastMode = chkFastMode.checked;
      vscode.postMessage({ command: 'setFastMode', fastMode: chkFastMode.checked });
    });

    // Attachment Actions
    document.querySelectorAll('#attachMenuPopover .popover-menu-item').forEach((item) => {
      item.addEventListener('click', () => {
        const action = item.getAttribute('data-action');
        closeAllPopovers();
        if (action === 'attachFiles') {
          vscode.postMessage({ command: 'attachFiles' });
        } else if (action === 'quickFile') {
          vscode.postMessage({ command: 'quickFile' });
        } else if (action === 'quickDirectory') {
          vscode.postMessage({ command: 'quickDirectory' });
        } else if (action === 'attachGit') {
          vscode.postMessage({ command: 'attachGit' });
        } else if (action === 'openMcp') {
          vscode.postMessage({ command: 'openMcp' });
        } else if (action === 'openRules') {
          vscode.postMessage({ command: 'openRules' });
        } else if (action === 'openSkills') {
          vscode.postMessage({ command: 'openSkills' });
        } else if (action === 'attachTerminal') {
          vscode.postMessage({ command: 'attachTerminal' });
        } else if (action === 'attachCodemap') {
          vscode.postMessage({ command: 'attachCodemap' });
        }
      });
    });

    function renderAttachedChips(attachedFiles = []) {
      if (!attachedChipsRow) return;
      if (!attachedFiles || attachedFiles.length === 0) {
        attachedChipsRow.style.display = 'none';
        attachedChipsRow.innerHTML = '';
        return;
      }
      attachedChipsRow.style.display = 'flex';
      attachedChipsRow.innerHTML = '';
      for (const filePath of attachedFiles) {
        const chip = document.createElement('div');
        chip.className = 'attached-chip';
        const isSpecial = filePath.includes(':');
        const icon = isSpecial ? lcIcon('zap', 12) : lcIcon('file-text', 12);
        const label = isSpecial ? filePath : filePath.split('/').pop() || filePath;
        chip.innerHTML =
          '<span style="display:inline-flex;align-items:center;">' + icon + '</span>' +
          '<span>' + escapeHtml(label) + '</span>' +
          '<span class="attached-chip-remove" data-path="' + escapeHtml(filePath) + '" title="Remove">' + lcIcon('x', 11) + '</span>';

        chip.querySelector('.attached-chip-remove').addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'removeAttachment', filePath });
        });

        attachedChipsRow.appendChild(chip);
      }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'loadSession':
          currentSession = msg.session;
          allSessionsList = msg.allSessions || [];
          cachedAllModelsList = msg.allModels || [];
          if (Array.isArray(msg.slashCommands)) {
            slashCommandsCatalog = msg.slashCommands;
            if (slashCtrl && slashCtrl.isOpen()) {
              slashCtrl.refreshFromInput();
            }
          }
          if (msg.workspaceName) {
            topWorkspacePill.innerHTML = lcIcon('folder-open', 13) + '<span>' + escapeHtml(msg.workspaceName) + '</span>';
            promptWorkspaceLabel.textContent = msg.workspaceName;
            if (msg.workspacePath) {
              topWorkspacePill.title = 'Working folder: ' + msg.workspacePath + ' (click to change)';
              if (btnWorkspaceContext) {
                btnWorkspaceContext.title = 'Working folder: ' + msg.workspacePath + ' (click to change)';
              }
            }
          }
          if (msg.currentConfig) {
            cachedConfig = Object.assign({}, cachedConfig, msg.currentConfig);
            if (msg.permissionMode) cachedConfig.permissionMode = msg.permissionMode;
            setExecutionModeUI(cachedConfig.executionMode || 'code');
            setPermissionModeUI(cachedConfig.permissionMode || 'smart');
            chkFastMode.checked = !!cachedConfig.fastMode;
            renderAttachedChips(cachedConfig.attachedFiles || []);
          }
          if (msg.modelsGrouped) {
            cachedGroupedModels = msg.modelsGrouped;
            renderModelCategories(cachedGroupedModels, modelSearchInput.value.trim());
          }
          {
            const activeModel = cachedAllModelsList.find(
              (m) => m.id === cachedConfig.modelId || m.modelIdentifier === cachedConfig.modelId
            );
            activeModelLabel.textContent = activeModel?.displayName || cachedConfig.modelName || cachedConfig.modelId || 'Select Model';
            if (modelProviderIcon) {
              modelProviderIcon.innerHTML = activeModel
                ? getProviderSvgIcon(activeModel.providerType === 'LOCAL' ? (activeModel.providerId === 'ollama' ? 'ollama' : 'custom') : activeModel.providerId.split('-')[0])
                : '';
            }
            updateModelConfigurationUI(activeModel);
          }
          let isNewSessionLoad = false;
          {
            const nextSessionId = currentSession ? currentSession.id : null;
            if (lastLoadedSessionId !== nextSessionId) {
              isNewSessionLoad = true;
              ephemeralCommandResults = [];
              lcQueueUserToggled = false;
              lcQueueEditingId = null;
              lastLoadedSessionId = nextSessionId;
            }
          }
          if (currentSession) {
            topSessionTitle.textContent = currentSession.title;
            isWorking = Boolean(currentSession.status === 'running' || (msg.queueSnapshot && msg.queueSnapshot.isBusy));
            activePlan = currentSession.plan || [];
            planExplicit = !!currentSession.planExplicit;
            currentActivities = Array.isArray(currentSession.activities) ? currentSession.activities : [];
            currentCommandResults = Array.isArray(currentSession.commandResults) ? currentSession.commandResults : [];
            liveStatusState = {
              active: isWorking,
              phase: currentSession.activePhase || (isWorking ? 'working' : 'idle'),
              summary: currentSession.activePhaseSummary || '',
            };
            renderFullConversation({ forceScrollBottom: isNewSessionLoad });
            renderActivityPane();
          } else {
            topSessionTitle.textContent = 'No active session';
            isWorking = false;
            activePlan = [];
            planExplicit = false;
            currentActivities = [];
            currentCommandResults = [];
            liveStatusState = { active: false, phase: 'idle', summary: '' };
            renderFullConversation({ forceScrollBottom: true });
            renderActivityPane();
          }
          if (msg.queueSnapshot) {
            lcSetQueueSnapshot(msg.queueSnapshot);
          } else {
            lcSetQueueSnapshot({
              sessionId: currentSession ? currentSession.id : '',
              state: isWorking ? 'running' : 'idle',
              paused: false,
              activeItemId: null,
              activeExecutionId: null,
              isBusy: isWorking,
              capacity: 200,
              queuedCount: 0,
              failedCount: 0,
              completedCount: 0,
              lastError: '',
              items: [],
            });
          }
          if (Array.isArray(msg.terminalTabs)) {
            updateTerminalTabs(msg.terminalTabs);
          }
          if (msg.systemTelemetry) {
            renderSystemTelemetry(msg.systemTelemetry);
          }
          renderSessionsList();
          if (msg.changesSummary) {
            currentChanges = msg.changesSummary;
            renderChangesList();
          }
          updateStatusUI();
          break;

        case 'modelsGroupedResponse':
          if (msg.modelsGrouped) {
            cachedGroupedModels = msg.modelsGrouped;
            renderModelCategories(cachedGroupedModels, msg.query || '');
          }
          break;

        case 'changesSummary':
          currentChanges = msg.summary;
          renderChangesList();
          break;

        case 'fileDiffResponse':
          if (msg.path === selectedDiffFile) {
            renderDiffCode(msg.diff);
          }
          break;

        case 'addMessage':
          if (currentSession && currentSession.messages) {
            const incoming = msg.message;
            if (!incoming) break;
            if (incoming.id && streamingMessages[incoming.id]) {
              delete streamingMessages[incoming.id];
            }
            if (incoming.id && currentSession.messages.some(m => m.id === incoming.id)) {
              renderFullConversation();
              break;
            }
            if (incoming.senderRole === 'user' && currentSession.messages.length > 0) {
              const last = currentSession.messages[currentSession.messages.length - 1];
              if (last.senderRole === 'user' && (last.content || '').trim() === (incoming.content || '').trim()) {
                break; // Ignore duplicate user message
              }
            }
            currentSession.messages.push(incoming);
            renderFullConversation({ forceScrollBottom: incoming.senderRole === 'user' });
          }
          break;

        case 'messageDelta': {
          const ev = msg.event;
          if (!ev || !ev.messageId) break;
          streamingMessages[ev.messageId] = {
            agentName: ev.agentName,
            senderRole: ev.senderRole || 'assistant',
            content: ev.fullContent || '',
          };
          const existingCard = lcFindChildByAttr(conversationFlow, 'data-msg-id', ev.messageId);
          const existingEl = existingCard ? existingCard.querySelector('.agent-text') : null;
          if (existingEl) {
            existingEl.innerHTML = formatMarkdown(ev.fullContent || '');
            if (chatPinnedToBottom) {
              syncContainerScroll(false);
            }
          } else {
            renderFullConversation();
          }
          break;
        }

        case 'streamStatus': {
          const ev = msg.event;
          if (!ev) break;
          const terminal = ev.phase === 'completed' || ev.phase === 'failed' || ev.phase === 'cancelled';
          isWorking = !terminal;
          liveStatusState = { active: !terminal, phase: ev.phase, summary: ev.summary || '' };
          updateStatusUI();
          const groups = conversationFlow.querySelectorAll('.lc-thinking-group');
          const activeGroup = groups.length > 0 ? groups[groups.length - 1] : null;
          if (!terminal && activeGroup) {
            const displayMsgs = getDisplayMessages();
            const grouped = lcGroupActivitiesByUserTurn(displayMsgs, currentActivities);
            const turnActs = grouped.lastTurnMsgIndex >= 0 ? (grouped.byMsgIndex[grouped.lastTurnMsgIndex] || []) : currentActivities;
            lcUpdateInlineThinkingGroupHeader(activeGroup, {
              activities: turnActs,
              isLive: true,
              statusSummary: liveStatusState.summary,
            });
          } else {
            renderFullConversation();
          }
          break;
        }

        case 'activityUpsert':
          if (msg.item) {
            currentActivities = lcUpsertActivityList(currentActivities, msg.item);
            if (currentSession) currentSession.activities = currentActivities;
            upsertActivityInConversation(msg.item);
            upsertActivityInPane(msg.item);
          }
          break;

        case 'queueUpdated':
          if (msg.snapshot) {
            isWorking = Boolean(msg.snapshot.isBusy);
            updateStatusUI();
            lcSetQueueSnapshot(msg.snapshot);
          }
          break;

        case 'queueActionError':
          if (msg.error) {
            lcQueueUserToggled = true;
            lcQueueExpanded = true;
            lcSetQueueSnapshot(Object.assign({}, lcGetQueueSnapshot(), { lastError: msg.error }));
          }
          break;

        case 'runFinished':
          isWorking = Boolean(lcGetQueueSnapshot()?.isBusy);
          liveStatusState = { active: isWorking, phase: msg.status || 'completed', summary: '' };
          updateStatusUI();
          renderFullConversation();
          break;

        case 'terminalTabs':
          updateTerminalTabs(msg.tabs);
          break;

        case 'systemTelemetry':
          if (msg.telemetry) {
            renderSystemTelemetry(msg.telemetry);
          }
          break;

        case 'planUpdate':
          activePlan = msg.plan || [];
          if (msg.explicit !== undefined) planExplicit = !!msg.explicit;
          updatePlanInConversation();
          break;

        case 'activity':
          break;

        case 'approvalRequest':
          renderApprovalPrompt(msg.request);
          break;

        case 'focusPrompt':
          if (promptInput) {
            promptInput.focus();
          }
          break;

        case 'switchInspectorTab':
          if (typeof switchInspectorTab === 'function') {
            switchInspectorTab(msg.tab || 'changes', msg.forceShow !== false);
          }
          break;

        case 'slashCommandResult': {
          const res = msg.result;
          if (!res) break;
          if (res.status === 'confirmation_required') {
            ephemeralCommandResults = ephemeralCommandResults.filter(
              (x) => x.status !== 'confirmation_required' || x.command !== res.command
            );
            ephemeralCommandResults.push(res);
          } else if (res.command === 'clear' && res.ok) {
            ephemeralCommandResults = [res];
            currentCommandResults = [];
          } else if (res.command === 'delete-session' && res.ok) {
            ephemeralCommandResults = [res];
          } else {
            if (!currentCommandResults.some((x) => x.id === res.id)) {
              currentCommandResults.push(res);
            }
          }
          renderFullConversation();
          if (res.uiAction) {
            const act = res.uiAction.type;
            if (act === 'openModelSelector' && typeof togglePopover === 'function' && typeof modelSelectorPopover !== 'undefined') {
              togglePopover(modelSelectorPopover, modelSelector, true);
              setTimeout(() => {
                modelSearchInput?.focus();
                modelSearchInput?.select();
              }, 50);
            } else if (act === 'openTerminal' && typeof switchInspectorTab === 'function') {
              switchInspectorTab('terminal', true);
            } else if (act === 'openChanges' && typeof switchInspectorTab === 'function') {
              switchInspectorTab('changes', true);
            } else if (act === 'focusSessions') {
              if (devinSidebar) devinSidebar.classList.remove('hidden');
              if (sessionsFilterBar) sessionsFilterBar.classList.add('open');
              if (btnHeaderFilter) btnHeaderFilter.classList.add('active');
              document.getElementById('sessionSearchInput')?.focus();
            } else if (act === 'focusPrompt' && promptInput) {
              promptInput.focus();
            }
          }
          break;
        }

        case 'cockpitModalData':
          renderCockpitModal(msg.modalType, msg.data);
          break;
      }
    });

    ${getCockpitModalScript()}

    function renderApprovalPrompt(req) {
      const card = document.createElement('div');
      card.className = 'approval-card';
      card.innerHTML = '<div style="font-weight:700;color:#f59e0b;font-size:12.5px;display:flex;align-items:center;gap:6px;">' + lcIcon('triangle-alert', 14) + '<span>Security Approval Required</span></div>' +
        '<div style="font-size:12px;color:#f1f5f9;">' + escapeHtml(req.description) + '</div>' +
        '<div style="font-family:monospace;font-size:11.5px;background:rgba(0,0,0,0.4);padding:6px 10px;border-radius:4px;color:#38bdf8;">' +
        escapeHtml(req.tool || req.toolName || 'tool') + ' ' + escapeHtml(JSON.stringify(req.args || req.params || {})) +
        '</div>' +
        '<div class="approval-actions" style="display:flex;gap:8px;margin-top:6px;">' +
        '<button class="btn-action-sm btn-accept" id="btnApprove_' + req.id + '">Approve Action</button>' +
        '<button class="btn-action-sm btn-reject" id="btnReject_' + req.id + '">Reject Action</button>' +
        '</div>';

      conversationFlow.appendChild(card);
      scrollContainer.scrollTop = scrollContainer.scrollHeight;

      document.getElementById('btnApprove_' + req.id).addEventListener('click', () => {
        card.remove();
        vscode.postMessage({ command: 'resolveApproval', requestId: req.id, approved: true });
      });
      document.getElementById('btnReject_' + req.id).addEventListener('click', () => {
        card.remove();
        vscode.postMessage({ command: 'resolveApproval', requestId: req.id, approved: false });
      });
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function formatMarkdown(text) {
      return lcRenderMarkdown(text);
    }
  </script>
</body>
</html>`;
  }
}
