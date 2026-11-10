import * as vscode from 'vscode';
import { getLucideCss, getLucideClientScript, lucideSvg } from './lucide-icons';
import * as path from 'path';
import { AgentOrchestrator } from '../agents/orchestrator';
import { AgentMessage, TaskPlanItem, ToolApprovalRequest } from '../agents/types';
import { SessionManager, SessionData, ExecutionGroup, AgentSessionConfig, ExecutionMode, PermissionMode } from '../sessions/session-manager';
import { OllamaClient } from '../ollama/client';
import { ModelProviderRegistry, ModelMetadata, ReasoningEffort } from '../models/model-provider-registry';
import { getModelSelectorStyles, getModelSelectorMarkup, getModelSelectorScript } from './model-selector-ui';
import { getActivityStreamStyles, getActivityClientScript } from './activity-stream-ui';
import { getSessionsBarStyles, getSessionsBarClientScript } from './sessions-bar-ui';
import { getQueuePanelStyles, getQueuePanelMarkup, getQueuePanelClientScript } from './queue-panel-ui';
import { ToolManager } from '../tools/tool-manager';
import { PermissionManager, SecurityMode } from '../security/permission-manager';
import { AgentRegistry } from '../agents/agent-registry';
import { McpHost } from '../mcp/mcp-host';
import { ChangesManager } from '../context/changes-manager';
import {
  MessageQueueManager,
  handleQueueActionCommand,
  isQueueControlSlashCommand,
  isQueueableSlashCommand,
} from '../sessions/message-queue';
import {
  SlashCommandRegistry,
  ensureBuiltinSlashCommandsRegistered,
  runSlashCommandForWorkspace,
  isSlashCommandInput,
  getSlashCommandStyles,
  getSlashCommandPopupMarkup,
  getSlashCommandClientScript,
} from '../commands';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'localcoders.chatView';
  private _view?: vscode.WebviewView;
  private _isDisposed = false;
  private _slashAbortController?: AbortController;
  private readonly queueManager?: MessageQueueManager;

  private postMessageSafe(data: any): void {
    if (this._isDisposed || !this._view) return;
    try {
      this._view.webview.postMessage(data);
    } catch {
      // Webview disposed
    }
  }

  private getActiveWorkspaceRoot(): string {
    const sessionRoot = this.sessionManager.getActiveSession()?.workspaceRoot;
    if (sessionRoot) return sessionRoot;
    return this.orchestrator.getWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  }

  private async executeSlashCommand(rawInput: string, confirmed: boolean): Promise<void> {
    const workspaceRoot = this.getActiveWorkspaceRoot();
    this._slashAbortController?.abort();
    const abortController = new AbortController();
    this._slashAbortController = abortController;

    const result = await runSlashCommandForWorkspace({
      rawInput,
      confirmed,
      abortSignal: abortController.signal,
      workspaceRoot,
      viewMode: 'ide',
      orchestrator: this.orchestrator,
      sessionManager: this.sessionManager,
      modelRegistry: this.modelRegistry,
      permissionManager: this.permissionManager,
      changesManager: this.changesManager,
      toolManager: this.toolManager,
      mcpHost: this.mcpHost,
      registry: this.registry,
      ollama: this.ollama,
      queueManager: this.queueManager,
      ui: {
        openCockpitModal: async (modal) => {
          if (modal === 'models') {
            await vscode.commands.executeCommand('localcoders.manageModels');
          } else if (modal === 'agents') {
            await vscode.commands.executeCommand('localcoders.agentsView.focus');
          } else if (modal === 'mcp') {
            await vscode.commands.executeCommand('localcoders.manageMcp');
          }
        },
        switchInspectorTab: (tab) => {
          if (tab === 'terminal') {
            vscode.commands.executeCommand('workbench.action.terminal.focus');
          } else {
            vscode.commands.executeCommand('localcoders.changesView.focus');
          }
        },
        openFilesExplorerOrPicker: async () => {
          await vscode.commands.executeCommand('workbench.view.explorer');
        },
        syncSession: async () => {
          await this.syncActiveSession();
        },
        applyWorkingFolder: (root) => {
          this.orchestrator.setWorkspace(root);
          this.changesManager?.setWorkspace(root);
          this.permissionManager?.setWorkspace(root);
          this.mcpHost?.setWorkspace(root);
        },
      },
    });

    if (this._slashAbortController === abortController) {
      this._slashAbortController = undefined;
    }

    await this.syncActiveSession();
    this.postMessageSafe({ type: 'slashCommandResult', result });
  }

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly orchestrator: AgentOrchestrator,
    private readonly sessionManager: SessionManager,
    private readonly ollama: OllamaClient,
    private readonly modelRegistry: ModelProviderRegistry = ModelProviderRegistry.getInstance(),
    private readonly permissionManager?: PermissionManager,
    private readonly toolManager?: ToolManager,
    private readonly registry?: AgentRegistry,
    private readonly mcpHost?: McpHost,
    private readonly changesManager?: ChangesManager,
    queueManager?: MessageQueueManager
  ) {
    const canAttachQueue =
      Boolean(queueManager) ||
      typeof this.sessionManager?.saveQueueState === 'function';

    if (canAttachQueue) {
      this.queueManager =
        queueManager ||
        MessageQueueManager.getOrCreateShared({
          sessionManager: this.sessionManager,
          orchestrator: this.orchestrator,
          modelRegistry: this.modelRegistry,
          changesManager: this.changesManager,
          permissionManager: this.permissionManager,
          toolManager: this.toolManager,
          mcpHost: this.mcpHost,
          registry: this.registry,
          ollama: this.ollama,
        });

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
            break;
          case 'messageDelta':
            this.postMessageSafe({ type: 'messageDelta', event: ev.payload });
            break;
          case 'streamStatus':
            this.postMessageSafe({ type: 'statusUpdate', event: ev.payload });
            break;
          case 'activityUpsert':
            this.postMessageSafe({ type: 'activityUpsert', item: ev.payload });
            break;
          case 'planUpdate':
            this.postMessageSafe({
              type: 'planUpdate',
              plan: ev.payload?.plan || [],
              explicit: Boolean(ev.payload?.explicit),
            });
            break;
          case 'runFinished':
            this.postMessageSafe({ type: 'runFinished', status: ev.payload?.status || 'completed' });
            this.syncActiveSession();
            break;
          case 'slashCommandResult':
            this.postMessageSafe({ type: 'slashCommandResult', result: ev.payload });
            this.syncActiveSession();
            break;
        }
      });
    }

    this.orchestrator.onApproval((req) => {
      this.postMessageSafe({ type: 'approvalRequest', request: req });
    });

    this.sessionManager.onDidChangeSessions(() => {
      this.syncActiveSession();
    });

    this.modelRegistry.onDidChangeModels(() => {
      this.syncActiveSession();
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.onDidDispose(() => {
      this._view = undefined;
    });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.command) {
        case 'runSlashCommand':
        case 'confirmSlashCommand': {
          const rawCmd = String(data.text || '').trim();
          if (!rawCmd) return;
          const confirmed = data.command === 'confirmSlashCommand' || !!data.confirmed;
          const activeSess = this.sessionManager.getActiveSession();
          if (
            this.queueManager &&
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
            if (qRes.snapshot) {
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
                  message: `Added '${rawCmd}' to the queue at position #${qRes.snapshot.queuedCount}.`,
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
          if (isQueueControlSlashCommand(text)) {
            await this.executeSlashCommand(text, false);
            return;
          }
          if (isSlashCommandInput(text)) {
            if (
              this.queueManager &&
              activeSess &&
              this.queueManager.isSessionBusy(activeSess.id) &&
              isQueueableSlashCommand(text)
            ) {
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

          if (this.queueManager) {
            const prevCount = this.sessionManager.getAllSessions().length;
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
            }
            break;
          }
          break;
        }

        case 'queueAction': {
          const activeSess = this.sessionManager.getActiveSession();
          if (!activeSess || !this.queueManager) {
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

        case 'newSession':
        case 'newSection': {
          const firstAvailable = await this.modelRegistry.getDefaultOrFirstAvailableModel();
          const model = firstAvailable?.id || '';
          this.sessionManager.createSession('New Section', model, {
            providerId: firstAvailable?.providerId || 'ollama',
            modelId: model,
            modelName: firstAvailable?.displayName || '',
          });
          await this.syncActiveSession();
          break;
        }

        case 'switchSection': {
          if (data.sessionId) {
            this.sessionManager.switchSession(data.sessionId);
            this.syncActiveSession();
          }
          break;
        }

        case 'renameSection': {
          const s = this.sessionManager.getSession(data.sessionId);
          if (s) {
            const newTitle = await vscode.window.showInputBox({
              prompt: 'Rename Chat Section',
              value: s.title || '',
            });
            if (newTitle && newTitle.trim()) {
              this.sessionManager.renameSession(data.sessionId, newTitle.trim());
              this.syncActiveSession();
            }
          }
          break;
        }

        case 'deleteSection': {
          const s = this.sessionManager.getSession(data.sessionId);
          const confirm = await vscode.window.showWarningMessage(
            `Delete section "${s?.title || 'this section'}"?`,
            { modal: true },
            'Delete'
          );
          if (confirm === 'Delete') {
            this.sessionManager.deleteSession(data.sessionId);
            this.syncActiveSession();
          }
          break;
        }

        case 'selectWorkspace': {
          vscode.commands.executeCommand('vscode.openFolder');
          break;
        }

        case 'switchToAgentView': {
          vscode.commands.executeCommand('localcoders.activateAgentView');
          break;
        }

        case 'resolveApproval': {
          this.orchestrator.resolveApproval(data.requestId, data.approved);
          break;
        }

        case 'cancelTask':
        case 'stopTask': {
          this._slashAbortController?.abort();
          this._slashAbortController = undefined;
          const activeSess = this.sessionManager.getActiveSession();
          if (this.queueManager) {
            this.queueManager.cancelActiveTask(activeSess?.id);
            if (activeSess) {
              this.postMessageSafe({ type: 'queueUpdated', snapshot: this.queueManager.getSnapshot(activeSess.id) });
            }
          }
          this.orchestrator.cancelTask();
          this.postMessageSafe({ type: 'runFinished', status: 'cancelled' });
          await this.syncActiveSession();
          break;
        }

        case 'clearActivities': {
          this.sessionManager.updateActiveSession((s) => {
            s.activities = [];
          });
          this.syncActiveSession();
          break;
        }

        case 'focusIntegratedTerminal': {
          vscode.commands.executeCommand('workbench.action.terminal.focus');
          break;
        }

        case 'showMoreOptions': {
          const items = [
            { label: '$(add) New Section', action: 'newSection' },
            { label: '$(edit) Rename Active Section', action: 'renameActive' },
            { label: '$(hubot) Select Model', action: 'selectModel' },
            { label: '$(clear-all) Clear Active Messages', action: 'clearActive' },
            { label: '$(trash) Delete Active Section', action: 'deleteActive' },
          ];
          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Chat Section Options',
          });
          if (picked) {
            if (picked.action === 'newSection') {
              const firstAvailable = await this.modelRegistry.getDefaultOrFirstAvailableModel();
              const model = firstAvailable?.id || '';
              this.sessionManager.createSession('New Section', model, {
                providerId: firstAvailable?.providerId || 'ollama',
                modelId: model,
                modelName: firstAvailable?.displayName || '',
              });
              await this.syncActiveSession();
            } else if (picked.action === 'renameActive') {
              const active = this.sessionManager.getActiveSession();
              if (active) {
                const newTitle = await vscode.window.showInputBox({
                  prompt: 'Rename Active Section',
                  value: active.title || '',
                });
                if (newTitle && newTitle.trim()) {
                  this.sessionManager.renameSession(active.id, newTitle.trim());
                  this.syncActiveSession();
                }
              }
            } else if (picked.action === 'selectModel') {
              vscode.commands.executeCommand('localcoders.selectMainAgent');
            } else if (picked.action === 'clearActive') {
              this.sessionManager.updateActiveSession((s) => {
                s.messages = [];
                s.plan = [];
                s.status = 'idle';
              });
              this.syncActiveSession();
            } else if (picked.action === 'deleteActive') {
              const active = this.sessionManager.getActiveSession();
              if (active) {
                this.sessionManager.deleteSession(active.id);
                this.syncActiveSession();
              }
            }
          }
          break;
        }

        case 'openChanges':
          vscode.commands.executeCommand('localcoders.changesView.focus');
          break;

        case 'openFile': {
          const uri = vscode.Uri.file(data.path);
          vscode.window.showTextDocument(uri);
          break;
        }

        case 'openWizard':
          vscode.commands.executeCommand('localcoders.openSetupWizard');
          break;

        case 'refreshModels': {
          await this.modelRegistry.refreshAll(true);
          await this.syncActiveSession();
          break;
        }

        case 'openModelManager': {
          vscode.commands.executeCommand('localcoders.manageModels');
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
          const rulesPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.localcoders', 'rules.md');
          try {
            const doc = await vscode.workspace.openTextDocument(rulesPath);
            await vscode.window.showTextDocument(doc);
          } catch {
            vscode.commands.executeCommand('localcoders.projectMemoryView.focus');
          }
          break;
        }

        case 'openSkills': {
          vscode.commands.executeCommand('localcoders.agentTeamView.focus');
          break;
        }

        case 'openMcp': {
          vscode.commands.executeCommand('localcoders.mcpServersView.focus');
          break;
        }

        case 'showChangesPanel': {
          vscode.commands.executeCommand('localcoders.changesView.focus');
          break;
        }
      }
    });

    this.syncActiveSession();
  }

  public async syncActiveSession() {
    if (!this._view || this._isDisposed) return;
    const session = this.sessionManager.getActiveSession();
    const allSessions = this.sessionManager.getAllSessions();
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name || 'No Project';

    let modelsGrouped: any = { local: [], cloud: [], providers: [] };
    let allModels: ModelMetadata[] = [];
    try {
      modelsGrouped = await this.modelRegistry.getGroupedModels();
      allModels = await this.modelRegistry.getAvailableModels();
    } catch (e) {
      console.warn('[ChatViewProvider] Failed to fetch models:', e);
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
    const workspaceRoot = this.getActiveWorkspaceRoot();
    const slashCommands = ensureBuiltinSlashCommandsRegistered(
      SlashCommandRegistry.getInstance(),
      workspaceRoot
    ).getSerializableCatalog();
    const queueSnapshot =
      session && this.queueManager ? this.queueManager.getSnapshot(session.id) : undefined;

    this.postMessageSafe({
      type: 'loadSession',
      session,
      allSessions,
      workspaceName,
      modelsGrouped,
      allModels,
      currentConfig,
      permissionMode,
      slashCommands,
      queueSnapshot,
    });
  }

  private _getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg: var(--vscode-editor-background, #111214);
      --fg: var(--vscode-editor-foreground, #e4e4e7);
      --card-bg: var(--vscode-sideBar-background, #16171a);
      --border: var(--vscode-widget-border, rgba(161, 161, 170, 0.16));
      --hover-bg: color-mix(in srgb, var(--vscode-editor-foreground, #e4e4e7) 6%, transparent);
      --input-bg: var(--vscode-input-background, #18191d);
      --accent: var(--vscode-textLink-foreground, #60a5fa);
      --accent-muted: color-mix(in srgb, var(--vscode-editor-foreground, #e4e4e7) 8%, transparent);
      --success: #22c55e;
      --danger: #ef4444;
      --warning: #f59e0b;
      --text-muted: var(--vscode-descriptionForeground, #8b8f98);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    ${getLucideCss()}
    .btn-mode-switch, .pill, .section-dropdown-btn, .section-meta-row, .msg-agent-badge, .plan-title, .tool-card-header, .activity-group-header {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .header-icon-btn, .btn-drawer-close, .btn-card-action, .btn-send, .attached-chip-remove, .popover-icon, .option-icon, .option-check, .pill-arrow, .section-icon, .dropdown-caret {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      font-size: 13px;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* 1. Header */
    .header-bar {
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      background: var(--card-bg);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-shrink: 0;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 8px;
      overflow: hidden;
    }
    .session-title-label {
      font-weight: 600;
      font-size: 13px;
      color: var(--fg);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 180px;
    }
    .header-pills {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .pill {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 1px solid transparent;
      transition: all 0.15s ease;
    }
    .pill:hover {
      border-color: var(--border);
      color: var(--fg);
    }
    .pill-project {
      color: var(--accent);
      background: var(--accent-muted);
    }
    .pill-status {
      font-weight: 600;
      color: var(--success);
      background: rgba(34, 197, 94, 0.15);
    }
    .pill-working {
      color: var(--accent);
      background: var(--accent-muted);
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    /* 2. Chat Feed */
    #chat-container {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 16px 14px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* Quiet Empty State */
    .empty-welcome {
      margin: auto;
      text-align: center;
      max-width: 280px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      color: var(--text-muted);
      padding: 24px 12px;
    }
    .welcome-title {
      font-size: 13.5px;
      font-weight: 600;
      color: var(--fg);
      line-height: 1.4;
    }
    .welcome-sub {
      font-size: 12px;
      color: var(--text-muted);
    }

    /* Message rows */
    .msg-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: 100%;
    }
    .msg-user {
      align-self: flex-end;
      background: color-mix(in srgb, var(--fg) 7%, transparent);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 12px;
      max-width: 85%;
      word-break: break-word;
      font-size: 13px;
      line-height: 1.5;
    }
    .msg-assistant {
      align-self: flex-start;
      background: transparent;
      padding: 4px 0;
      max-width: 100%;
      word-break: break-word;
      font-size: 13px;
      line-height: 1.6;
    }
    .msg-header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 4px;
    }

    /* Devin-style Expandable Execution Groups */
    .execution-group {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 6px;
      margin: 6px 0;
      overflow: hidden;
    }
    .exec-summary {
      padding: 7px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      font-size: 11px;
      color: var(--text-muted);
      user-select: none;
    }
    .exec-summary:hover {
      background: var(--hover-bg);
      color: var(--fg);
    }
    .exec-summary-left {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .exec-details {
      display: none;
      padding: 8px 12px;
      background: rgba(0, 0, 0, 0.2);
      border-top: 1px solid var(--border);
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      color: #94a3b8;
      line-height: 1.6;
    }
    .exec-details.open {
      display: block;
    }

    /* Task Plan Card */
    .plan-box {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      margin: 8px 0;
    }
    .plan-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--fg);
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .plan-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      font-size: 12px;
    }
    .plan-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 600;
    }
    .status-pending { background: #262626; color: var(--text-muted); }
    .status-in_progress { background: #0284c7; color: white; }
    .status-completed { background: rgba(34, 197, 94, 0.2); color: var(--success); }

    /* Completion Summary Card */
    .completion-box {
      background: rgba(34, 197, 94, 0.08);
      border: 1px solid rgba(34, 197, 94, 0.3);
      border-radius: 8px;
      padding: 12px;
      margin: 10px 0;
    }
    .completion-title {
      font-weight: 600;
      color: var(--success);
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .completion-actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    .btn-action {
      padding: 5px 10px;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.05);
      color: var(--fg);
      font-size: 11px;
      cursor: pointer;
    }
    .btn-action:hover { background: var(--hover-bg); }

    /* Approval Card */
    .approval-box {
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.4);
      border-radius: 8px;
      padding: 12px;
      margin: 8px 0;
    }
    .approval-btns {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    .btn-approve {
      padding: 5px 12px;
      border-radius: 4px;
      border: none;
      background: var(--success);
      color: white;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-reject {
      padding: 5px 12px;
      border-radius: 4px;
      border: none;
      background: var(--danger);
      color: white;
      font-weight: 600;
      cursor: pointer;
    }

    /* Minimalist Matte Composer */
    .composer-surface {
      padding: 8px 12px 12px 12px;
      background: var(--bg);
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
    }
    .mode-bar {
      display: flex;
      gap: 4px;
    }
    .mode-btn {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      background: transparent;
      color: var(--text-muted);
      border: 1px solid transparent;
      cursor: pointer;
    }
    .mode-btn.active {
      background: color-mix(in srgb, var(--fg) 8%, transparent);
      border-color: var(--border);
      color: var(--fg);
      font-weight: 600;
    }
    .composer-card {
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 9px 11px;
      display: flex;
      flex-direction: column;
      gap: 7px;
      transition: border-color 0.15s ease;
    }
    .composer-card:focus-within {
      border-color: color-mix(in srgb, var(--fg) 30%, transparent);
    }
    .composer-top-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .chip-project {
      font-size: 11px;
      color: var(--text-muted);
      background: rgba(255, 255, 255, 0.05);
      padding: 2px 8px;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      user-select: none;
      border: 1px solid transparent;
      transition: all 0.15s ease;
    }
    .chip-project:hover {
      background: rgba(255, 255, 255, 0.1);
      color: var(--fg);
    }
    textarea {
      width: 100%;
      background: transparent;
      border: none;
      color: var(--fg);
      font-family: inherit;
      font-size: 13px;
      resize: none;
      outline: none;
      min-height: 40px;
      max-height: 160px;
      line-height: 1.45;
    }
    textarea::placeholder {
      color: var(--text-muted);
      opacity: 0.8;
    }
    .composer-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .composer-left-tools {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .model-chip {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 11px;
      color: var(--text-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: all 0.15s ease;
    }
    .model-chip:hover {
      background: rgba(255, 255, 255, 0.1);
      color: var(--fg);
      border-color: rgba(255, 255, 255, 0.15);
    }
    .btn-send {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: none;
      background: #ffffff;
      color: #000000;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 13px;
      font-weight: 700;
      transition: transform 0.1s ease, opacity 0.15s ease;
    }
    .btn-send:hover {
      transform: scale(1.05);
      opacity: 0.95;
    }
    .btn-send.stop-mode {
      background: var(--danger);
      color: white;
      border-radius: 6px;
    }
    .btn-stop {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: var(--danger);
      border: none;
      color: #ffffff;
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      flex-shrink: 0;
    }
    ${getQueuePanelStyles({ compact: true })}
    .header-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .header-icon-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      width: 26px;
      height: 26px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      transition: all 0.15s ease;
    }
    .header-icon-btn:hover {
      background: var(--hover-bg);
      color: var(--fg);
    }

    /* Section Selector in Header */
    .section-selector-btn {
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      color: var(--fg);
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      max-width: 170px;
      transition: all 0.15s ease;
      user-select: none;
    }
    .section-selector-btn:hover {
      background: var(--hover-bg);
      border-color: var(--border);
    }
    .section-icon {
      font-size: 12px;
      opacity: 0.9;
    }
    .session-title-label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 125px;
      font-weight: 600;
    }
    .dropdown-caret {
      font-size: 8px;
      color: var(--text-muted);
    }

    /* Sections / History Drawer Overlay */
    .sections-drawer {
      position: absolute;
      top: 43px;
      left: 0;
      right: 0;
      bottom: 0;
      background: #181818;
      border-bottom: 1px solid var(--border);
      display: none;
      flex-direction: column;
      z-index: 100;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.6);
      animation: slideDown 0.16s ease-out;
    }
    .sections-drawer.open {
      display: flex;
    }
    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .drawer-header {
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      background: var(--card-bg);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .drawer-title {
      font-weight: 600;
      font-size: 12px;
      color: var(--fg);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .drawer-count-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-muted);
    }
    .drawer-header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .btn-drawer-new {
      padding: 4px 9px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 5px;
      border: 1px solid rgba(56, 189, 248, 0.3);
      background: rgba(56, 189, 248, 0.12);
      color: var(--accent);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s ease;
    }
    .btn-drawer-new:hover {
      background: rgba(56, 189, 248, 0.22);
      border-color: var(--accent);
    }
    .btn-drawer-close {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 13px;
      padding: 3px 6px;
      border-radius: 4px;
    }
    .btn-drawer-close:hover {
      color: var(--fg);
      background: var(--hover-bg);
    }
    .drawer-search-bar {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      background: var(--card-bg);
    }
    .drawer-search-input {
      width: 100%;
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 12px;
      color: var(--fg);
      outline: none;
    }
    .drawer-search-input:focus {
      border-color: var(--accent);
    }
    .drawer-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .section-card {
      padding: 8px 10px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .section-card:hover {
      background: var(--hover-bg);
      border-color: var(--border);
    }
    .section-card.active {
      background: rgba(56, 189, 248, 0.08);
      border-color: rgba(56, 189, 248, 0.4);
    }
    .section-card-main {
      flex: 1;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .section-card-title {
      font-size: 12px;
      font-weight: 500;
      color: var(--fg);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .section-card.active .section-card-title {
      color: var(--accent);
      font-weight: 600;
    }
    .section-card-meta {
      font-size: 10px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .section-model-tag {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.06);
    }
    .section-card-actions {
      display: flex;
      align-items: center;
      gap: 3px;
      opacity: 0.5;
      transition: opacity 0.15s ease;
    }
    .section-card:hover .section-card-actions {
      opacity: 1;
    }
    .btn-card-action {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 3px 5px;
      border-radius: 4px;
      font-size: 11px;
    }
    .btn-card-action:hover {
      background: rgba(255, 255, 255, 0.12);
      color: var(--fg);
    }
    .btn-card-action.btn-delete:hover {
      color: var(--danger);
    }
    .drawer-empty-note {
      text-align: center;
      padding: 24px 12px;
      color: var(--text-muted);
      font-size: 12px;
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
      min-width: 190px;
      padding: 6px 0;
      font-size: 12.5px;
    }
    .popover-menu-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 12px;
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
      gap: 10px;
      padding: 7px 8px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.1s ease;
    }
    .popover-card-option:hover {
      background: rgba(255, 255, 255, 0.07);
    }
    .popover-card-option .option-icon {
      font-size: 14px;
      width: 20px;
      height: 20px;
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
      font-size: 12px;
      font-weight: 600;
      color: #f8fafc;
    }
    .popover-card-option .option-desc {
      font-size: 10.5px;
      color: #94a3b8;
      line-height: 1.3;
      margin-top: 1px;
    }
    .popover-card-option .option-check {
      font-size: 12px;
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

    /* Shared Model Selector & Configuration Popovers */
    ${getModelSelectorStyles()}

    /* Attached Context Chips Bar */
    .composer-attached-row {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      padding: 4px 0 6px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .attached-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.25);
      color: #e0f2fe;
      font-size: 10.5px;
      padding: 2px 7px;
      border-radius: 999px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .attached-chip-remove {
      cursor: pointer;
      opacity: 0.7;
      font-weight: 700;
      font-size: 11px;
    }
    .attached-chip-remove:hover {
      opacity: 1;
      color: #f87171;
    }

    /* Controls Pills */
    .tool-btn {
      width: 24px;
      height: 24px;
      box-sizing: border-box;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
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
    .model-selector-pill,
    .effort-selector-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      height: 24px;
      box-sizing: border-box;
      padding: 0 8px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #e2e8f0;
      font-family: inherit;
      font-size: 11px;
      font-weight: 500;
      line-height: 1;
      white-space: nowrap;
      cursor: pointer;
      flex-shrink: 0;
      transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
    }
    .tool-btn-pill:hover,
    .model-selector-pill:hover,
    .effort-selector-pill:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.2);
      color: #ffffff;
    }
    .lc-icon-gap {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .model-provider-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 13px;
      height: 13px;
      flex-shrink: 0;
    }
    .pill-arrow {
      display: inline-flex;
      align-items: center;
      opacity: 0.72;
      flex-shrink: 0;
    }

    .btn-mode-switch {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 500;
      padding: 2px 7px;
      border-radius: 4px;
      cursor: pointer;
      height: 24px;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .btn-mode-switch:hover {
      background: var(--hover-bg);
      color: var(--fg);
    }

    /* Segmented View Tabs (Conversation / Activity / Terminal) */
    .lc-side-tabs {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
      background: var(--bg);
      flex-shrink: 0;
    }
    .lc-side-tab {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--text-muted);
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .lc-side-tab:hover {
      background: var(--hover-bg);
      color: var(--fg);
    }
    .lc-side-tab.active {
      background: color-mix(in srgb, var(--fg) 8%, transparent);
      border-color: var(--border);
      color: var(--fg);
      font-weight: 600;
    }
    .lc-tab-count {
      font-size: 10px;
      padding: 0 5px;
      border-radius: 10px;
      background: rgba(148, 163, 184, 0.18);
      color: var(--fg);
      font-weight: 600;
    }
    .lc-side-tab-spacer {
      flex: 1;
    }
    #activity-panel {
      flex: 1;
      display: none;
      flex-direction: column;
      overflow: hidden;
      background: var(--bg);
    }
    #activity-panel.visible {
      display: flex;
    }
    .lc-act-filter-bar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .lc-act-filter-pill {
      padding: 2px 8px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text-muted);
      font-size: 11px;
      cursor: pointer;
    }
    .lc-act-filter-pill.active {
      background: var(--accent-muted);
      border-color: rgba(56, 189, 248, 0.35);
      color: var(--accent);
      font-weight: 600;
    }
    .lc-act-clear-btn {
      margin-left: auto;
      padding: 2px 8px;
      border-radius: 5px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text-muted);
      font-size: 10.5px;
      cursor: pointer;
    }
    .lc-act-clear-btn:hover {
      color: var(--fg);
      background: var(--hover-bg);
    }
    #activity-list {
      flex: 1;
      overflow-y: auto;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .lc-live-strip {
      padding: 0 14px 4px 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
    }
    .lc-live-strip:empty {
      display: none;
    }

    ${getActivityStreamStyles()}
    ${getSlashCommandStyles()}
    ${getSessionsBarStyles()}
  </style>
</head>
<body>
  <!-- 1. Antigravity-style Header Bar with Sections Dropdown -->
  <div class="header-bar">
    <div class="header-left">
      <button class="section-selector-btn" id="btn-section-dropdown" title="Click to view all chat sections / history">
        <span class="section-icon">${lucideSvg('message-square', 14)}</span>
        <span class="session-title-label" id="session-title">New Section</span>
        <span class="dropdown-caret">${lucideSvg('chevron-down', 12)}</span>
      </button>
    </div>
    <div class="header-actions">
      <button class="btn-mode-switch" id="btn-switch-agent-view" title="Switch to full 3-column Devin Agent cockpit">${lucideSvg('columns-2', 13)} <span>Cockpit</span></button>
      <button class="header-icon-btn" id="btn-new-section" title="New Chat Section (+)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
      </button>
      <button class="header-icon-btn" id="btn-history-toggle" title="Chat Sections History">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
      </button>
      <button class="header-icon-btn" id="btn-more-options" title="Section Options">${lucideSvg('ellipsis', 14)}</button>
    </div>
  </div>

  <!-- Sections / History Drawer -->
  <div class="sections-drawer" id="sections-drawer">
    <div class="lc-sessions-header">
      <span class="lc-sessions-heading">Sessions</span>
      <div class="lc-sessions-hdr-actions">
        <button type="button" class="lc-sess-hdr-btn" id="btn-drawer-new" title="New Session">${lucideSvg('plus', 15)}</button>
        <button type="button" class="lc-sess-hdr-btn" id="btn-drawer-filter" title="Filter &amp; Sort">${lucideSvg('sliders-horizontal', 14)}</button>
        <button type="button" class="lc-sess-hdr-btn" id="btn-drawer-more" title="Session Options">${lucideSvg('ellipsis', 14)}</button>
        <button type="button" class="lc-sess-hdr-btn" id="btn-drawer-close" title="Close">${lucideSvg('x', 14)}</button>
        <div class="lc-sessions-menu" id="drawer-sessions-menu">
          <button type="button" class="lc-sessions-menu-item" data-drawer-act="new">${lucideSvg('plus', 12)}<span>New Session</span></button>
          <button type="button" class="lc-sessions-menu-item" data-drawer-act="toggleSort">${lucideSvg('arrow-up-down', 12)}<span id="drawer-sort-lbl">Sort: Alphabetical</span></button>
          <div class="lc-sessions-menu-sep"></div>
          <button type="button" class="lc-sessions-menu-item" data-drawer-act="close">${lucideSvg('x', 12)}<span>Close Sessions</span></button>
        </div>
      </div>
    </div>
    <div class="lc-sessions-filter-bar" id="drawer-filter-bar">
      <div class="lc-sessions-search-wrap">
        <span class="lc-sessions-search-ico">${lucideSvg('search', 12)}</span>
        <input type="text" class="lc-sessions-filter-input" id="drawer-search-input" placeholder="Filter sessions..." />
      </div>
    </div>
    <button type="button" class="lc-recent-subheader" id="btn-drawer-recent">
      ${lucideSvg('clock', 12)}
      <span>Recent</span>
    </button>
    <div class="lc-sessions-scroll" id="drawer-sections-list"></div>
  </div>

  <!-- Separated Navigation Strip: Conversation vs Agent Activity vs Terminal -->
  <div class="lc-side-tabs" id="lc-side-tabs">
    <button class="lc-side-tab active" id="tab-btn-chat" data-tab="chat">
      ${lucideSvg('message-square', 12)}
      <span>Conversation</span>
    </button>
    <button class="lc-side-tab" id="tab-btn-activity" data-tab="activity">
      ${lucideSvg('zap', 12)}
      <span>Activity</span>
      <span class="lc-tab-count" id="activity-count-badge">0</span>
    </button>
    <div class="lc-side-tab-spacer"></div>
    <button class="lc-side-tab" id="tab-btn-terminal" title="Focus Integrated Terminal">
      ${lucideSvg('terminal', 12)}
      <span>Terminal</span>
    </button>
  </div>

  <!-- 2A. Chat Feed (Clean Conversation Only) -->
  <div id="chat-container">
    <div class="empty-welcome" id="empty-welcome">
      <div class="welcome-title">New session</div>
      <div class="welcome-sub">Type a task or question below. Ctrl+K switches models.</div>
    </div>
  </div>

  <!-- Safe Single Status Pill + Compact Activity Summary Strip -->
  <div class="lc-live-strip" id="lc-live-strip"></div>

  <!-- 2B. Separate Agent Activity Panel (Tool / Command / Subagent Cards) -->
  <div id="activity-panel">
    <div class="lc-act-filter-bar" id="act-filter-bar">
      <button class="lc-act-filter-pill active" data-filter="all">All</button>
      <button class="lc-act-filter-pill" data-filter="command">Commands</button>
      <button class="lc-act-filter-pill" data-filter="file">Files</button>
      <button class="lc-act-filter-pill" data-filter="subagent">Agents</button>
      <button class="lc-act-clear-btn" id="btn-clear-activity">Clear</button>
    </div>
    <div id="activity-list"></div>
  </div>

  ${getQueuePanelMarkup()}

  <!-- 3. Antigravity-style Floating Card Composer -->
  <div class="composer-surface">
    <div class="mode-bar">
      <button class="mode-btn active" data-mode="agent">Agent</button>
      <button class="mode-btn" data-mode="plan">Plan</button>
      <button class="mode-btn" data-mode="ask">Ask</button>
      <button class="mode-btn" data-mode="review">Review</button>
    </div>
    <div class="composer-card" style="position: relative;">
      <!-- Floating Popovers Backdrop -->
      <div class="popover-backdrop" id="popoverBackdrop"></div>

      <!-- 1. Attachment / Context Popover -->
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

      <!-- 2. Execution Mode Popover -->
      <div class="popover-card" id="execModePopover" style="width: 270px;">
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
            <div class="option-desc">Auto-approve safe actions</div>
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
            <div class="option-desc">Auto-approve all safe tool calls</div>
          </div>
          <div class="option-check" id="checkPerm_bypass">${lucideSvg('check', 13)}</div>
        </div>
      </div>

      <!-- 3. Permission Mode Popover -->
      <div class="popover-card" id="permModePopover" style="width: 280px;">
        <div class="popover-card-option" data-perm="ask">
          <div class="option-icon">${lucideSvg('shield', 14)}</div>
          <div class="option-content">
            <div class="option-title">Ask Before Actions</div>
            <div class="option-desc">Manual confirmation for each tool call</div>
          </div>
          <div class="option-check" id="checkPerm_ask">${lucideSvg('check', 13)}</div>
        </div>
        <div class="popover-card-option" data-perm="smart">
          <div class="option-icon">${lucideSvg('shield-check', 14)}</div>
          <div class="option-content">
            <div class="option-title">Smart Approval</div>
            <div class="option-desc">Auto-approve reads; ask on file writes/shell</div>
          </div>
          <div class="option-check" id="checkPerm_smart">${lucideSvg('check', 13)}</div>
        </div>
        <div class="popover-card-option" data-perm="bypass">
          <div class="option-icon">${lucideSvg('shield-alert', 14)}</div>
          <div class="option-content">
            <div class="option-title">Bypass Permissions</div>
            <div class="option-desc">Auto-approve all actions safely</div>
          </div>
          <div class="option-check" id="checkPerm_bypass_modal">${lucideSvg('check', 13)}</div>
        </div>
      </div>

      ${getSlashCommandPopupMarkup()}
      ${getModelSelectorMarkup({ compact: true })}

      <!-- Attached Chips Row -->
      <div class="composer-attached-row" id="attachedChipsRow" style="display:none;"></div>

      <div class="composer-top-row">
        <span class="chip-project" id="chip-project" title="Workspace Context">
          ${lucideSvg('folder', 13)}
          <span id="chip-project-name">No Project</span>
          ${lucideSvg('chevron-down', 11)}
        </span>
      </div>

      <textarea id="prompt-input" rows="2" placeholder="Ask anything, @ to mention, / for actions... (Enter to send)"></textarea>

      <div class="composer-footer">
        <div class="composer-left-tools">
          <button class="tool-btn" id="btnAttachment" title="Add File / Context">+</button>
          <button class="tool-btn-pill" id="btnExecMode" title="Change Execution Mode">
            <span id="execModeLabel" class="lc-icon-gap">${lucideSvg('code', 13)}<span>Code</span></span>
            <span class="pill-arrow">${lucideSvg('chevron-down', 11)}</span>
          </button>
          <button class="tool-btn-pill" id="btnPermMode" title="Change Security Permission Policy">
            <span id="permModeLabel" class="lc-icon-gap">${lucideSvg('shield-check', 13)}<span>Smart</span></span>
            <span class="pill-arrow">${lucideSvg('chevron-down', 11)}</span>
          </button>
        </div>
        <div class="composer-right-tools" style="display: flex; align-items: center; gap: 6px;">
          <button type="button" class="model-selector-pill" id="modelSelector" title="Select Model (Ctrl+K)">
            <span class="model-provider-icon" id="modelProviderIcon"></span>
            <span id="current-model-label">Select Model</span>
            <span class="pill-arrow">${lucideSvg('chevron-down', 11)}</span>
          </button>
          <button type="button" class="effort-selector-pill" id="btnEffortConfig" title="Configure Effort">
            <span id="activeEffortLabel">Med</span>
            <span class="pill-arrow">${lucideSvg('chevron-down', 11)}</span>
          </button>
          <button class="btn-send" id="btn-send" title="Send (Enter)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="19" x2="12" y2="5"></line>
              <polyline points="5 12 12 5 19 12"></polyline>
            </svg>
          </button>
          <button type="button" class="btn-stop" id="btn-stop" title="Stop Execution">${lucideSvg('square', 11, '', 'currentColor')}</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const chatContainer = document.getElementById('chat-container');
    const activityPanel = document.getElementById('activity-panel');
    const activityList = document.getElementById('activity-list');
    const liveStrip = document.getElementById('lc-live-strip');
    const tabBtnChat = document.getElementById('tab-btn-chat');
    const tabBtnActivity = document.getElementById('tab-btn-activity');
    const tabBtnTerminal = document.getElementById('tab-btn-terminal');
    const activityCountBadge = document.getElementById('activity-count-badge');
    const btnClearActivity = document.getElementById('btn-clear-activity');
    const emptyWelcome = document.getElementById('empty-welcome');
    const promptInput = document.getElementById('prompt-input');
    ${getLucideClientScript()}
    ${getActivityClientScript()}
    ${getSlashCommandClientScript()}
    ${getSessionsBarClientScript()}
    ${getQueuePanelClientScript()}
    let slashCommandsCatalog = [];
    let currentCommandResults = [];
    let ephemeralCommandResults = [];
    let lastLoadedSessionId = null;
    let currentSessionMessagesCache = [];
    let currentSessionPlanCache = [];
    let currentSessionPlanExplicit = false;
    const btnSend = document.getElementById('btn-send');
    const btnStop = document.getElementById('btn-stop');
    const sessionTitle = document.getElementById('session-title');
    const chipProject = document.getElementById('chip-project');
    const chipProjectName = document.getElementById('chip-project-name');
    const modelChip = document.getElementById('model-chip');
    const currentModelLabel = document.getElementById('current-model-label');
    const btnNewSection = document.getElementById('btn-new-section');
    const btnHistoryToggle = document.getElementById('btn-history-toggle');
    const btnSectionDropdown = document.getElementById('btn-section-dropdown');
    const btnMoreOptions = document.getElementById('btn-more-options');

    // Drawer Elements
    const sectionsDrawer = document.getElementById('sections-drawer');
    const btnDrawerClose = document.getElementById('btn-drawer-close');
    const btnDrawerNew = document.getElementById('btn-drawer-new');
    const drawerSearchInput = document.getElementById('drawer-search-input');
    const drawerSectionsList = document.getElementById('drawer-sections-list');
    const drawerCount = document.getElementById('drawer-count');

    let isRunning = false;
    let chatPinnedToBottom = true;
    let activityPinnedToBottom = true;
    if (chatContainer && typeof chatContainer.addEventListener === 'function') {
      chatContainer.addEventListener('scroll', () => {
        const gap = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight;
        chatPinnedToBottom = gap <= 32;
      });
    }
    if (activityList && typeof activityList.addEventListener === 'function') {
      activityList.addEventListener('scroll', () => {
        const gap = activityList.scrollHeight - activityList.scrollTop - activityList.clientHeight;
        activityPinnedToBottom = gap <= 32;
      });
    }
    let allSectionsCache = [];
    let currentActiveSessionId = null;
    let drawerSortMode = 'recent';
    let drawerRecentCollapsed = false;

    const drawerFilterBar = document.getElementById('drawer-filter-bar');
    const btnDrawerFilter = document.getElementById('btn-drawer-filter');
    const btnDrawerMore = document.getElementById('btn-drawer-more');
    const drawerMoreMenu = document.getElementById('drawer-sessions-menu');

    // Drawer Toggle Logic
    function toggleDrawer() {
      const isOpen = sectionsDrawer.classList.toggle('open');
      if (isOpen) {
        if (drawerSearchInput) drawerSearchInput.value = '';
        renderDrawerSections(allSectionsCache);
        if (drawerFilterBar?.classList.contains('open')) {
          drawerSearchInput?.focus();
        }
      }
    }

    function closeDrawer() {
      sectionsDrawer.classList.remove('open');
      drawerMoreMenu?.classList.remove('open');
    }

    btnSectionDropdown.addEventListener('click', toggleDrawer);
    btnHistoryToggle.addEventListener('click', toggleDrawer);
    btnDrawerClose.addEventListener('click', closeDrawer);

    btnDrawerFilter?.addEventListener('click', (e) => {
      e.stopPropagation();
      drawerMoreMenu?.classList.remove('open');
      const next = drawerFilterBar ? !drawerFilterBar.classList.contains('open') : false;
      drawerFilterBar?.classList.toggle('open', next);
      btnDrawerFilter.classList.toggle('active', next);
      if (next) {
        drawerSearchInput?.focus();
      } else if (drawerSearchInput && drawerSearchInput.value) {
        drawerSearchInput.value = '';
        renderDrawerSections(allSectionsCache);
      }
    });

    btnDrawerMore?.addEventListener('click', (e) => {
      e.stopPropagation();
      const lbl = document.getElementById('drawer-sort-lbl');
      if (lbl) lbl.textContent = drawerSortMode === 'recent' ? 'Sort: Alphabetical' : 'Sort: Most Recent';
      drawerMoreMenu?.classList.toggle('open');
    });

    document.addEventListener('click', (e) => {
      if (drawerMoreMenu && !drawerMoreMenu.contains(e.target) && e.target !== btnDrawerMore) {
        drawerMoreMenu.classList.remove('open');
      }
    });

    drawerMoreMenu?.querySelectorAll('.lc-sessions-menu-item[data-drawer-act]').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = item.getAttribute('data-drawer-act');
        drawerMoreMenu.classList.remove('open');
        if (act === 'new') {
          closeDrawer();
          vscode.postMessage({ command: 'newSection' });
        } else if (act === 'toggleSort') {
          drawerSortMode = drawerSortMode === 'recent' ? 'alpha' : 'recent';
          const q = (drawerSearchInput?.value || '').toLowerCase().trim();
          const base = q ? allSectionsCache.filter((s) => (s.title || '').toLowerCase().includes(q)) : allSectionsCache;
          renderDrawerSections(base);
        } else if (act === 'close') {
          closeDrawer();
        }
      });
    });

    document.getElementById('btn-drawer-recent')?.addEventListener('click', () => {
      drawerRecentCollapsed = !drawerRecentCollapsed;
      if (drawerSectionsList) drawerSectionsList.style.display = drawerRecentCollapsed ? 'none' : 'flex';
    });

    const btnSwitchAgentView = document.getElementById('btn-switch-agent-view');
    if (btnSwitchAgentView) {
      btnSwitchAgentView.addEventListener('click', () => {
        vscode.postMessage({ command: 'switchToAgentView' });
      });
    }

    btnNewSection.addEventListener('click', () => {
      closeDrawer();
      vscode.postMessage({ command: 'newSection' });
    });

    btnDrawerNew.addEventListener('click', () => {
      closeDrawer();
      vscode.postMessage({ command: 'newSection' });
    });

    drawerSearchInput.addEventListener('input', () => {
      const q = drawerSearchInput.value.toLowerCase().trim();
      if (!q) {
        renderDrawerSections(allSectionsCache);
        return;
      }
      const filtered = allSectionsCache.filter(s =>
        (s.title || '').toLowerCase().includes(q) ||
        (s.userGoal || '').toLowerCase().includes(q)
      );
      renderDrawerSections(filtered);
    });

    // Model selection
    modelChip.addEventListener('click', () => {
      vscode.postMessage({ command: 'selectModel' });
    });

    btnMoreOptions.addEventListener('click', () => {
      vscode.postMessage({ command: 'showMoreOptions' });
    });

    chipProject.addEventListener('click', () => {
      vscode.postMessage({ command: 'selectWorkspace' });
    });

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

    // Auto-grow textarea
    promptInput.addEventListener('input', () => {
      promptInput.style.height = 'auto';
      promptInput.style.height = Math.min(promptInput.scrollHeight, 160) + 'px';
      slashCtrl.refreshFromInput();
    });

    // Enter to submit, Shift+Enter for newline
    promptInput.addEventListener('keydown', (e) => {
      if (slashCtrl.handleKeyDown(e)) {
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitMessage();
      }
    });

    btnSend.addEventListener('click', () => {
      const val = promptInput.value.trim();
      if (val && lcIsSlashCommandInput(val)) {
        dispatchSlashCommand(val);
        return;
      }
      submitMessage();
    });

    if (btnStop) {
      btnStop.addEventListener('click', () => {
        setRunningState(false);
        vscode.postMessage({ command: 'cancelTask' });
      });
    }

    let lastChatSubmitSig = '';
    let lastChatSubmitAt = 0;

    function submitMessage() {
      const text = promptInput.value.trim();
      if (!text) return;
      if (lcIsSlashCommandInput(text)) {
        dispatchSlashCommand(text);
        return;
      }
      const now = Date.now();
      const attachedSnapshot = Array.isArray(cachedConfig?.attachedFiles) ? cachedConfig.attachedFiles.slice() : [];
      const sig = text + '::' + attachedSnapshot.join('|');
      if (sig === lastChatSubmitSig && now - lastChatSubmitAt < 300) {
        return;
      }
      lastChatSubmitSig = sig;
      lastChatSubmitAt = now;

      slashCtrl.close();
      promptInput.value = '';
      promptInput.style.height = 'auto';
      chatPinnedToBottom = true;
      if (!isRunning) {
        setRunningState(true);
      }
      const clientSubmissionId = 'sub_' + now + '_' + Math.random().toString(36).slice(2, 7);
      vscode.postMessage({
        command: 'sendMessage',
        text,
        attachments: attachedSnapshot,
        clientSubmissionId,
      });
    }

    function setRunningState(running) {
      isRunning = running;
      btnSend.style.display = 'flex';
      btnSend.disabled = false;
      btnSend.classList.remove('stop-mode');
      btnSend.innerHTML = lcIcon('arrow-up', 14);
      btnSend.title = running ? 'Add to Queue (Enter)' : 'Send (Enter)';
      if (btnStop) {
        btnStop.style.display = running ? 'flex' : 'none';
      }
    }

    function formatTimeAgo(timestamp) {
      return lcFormatSessionTimeAgo(timestamp);
    }

    function renderDrawerSections(sections) {
      drawerSectionsList.innerHTML = '';
      const sorted = (sections || []).slice();
      if (drawerSortMode === 'alpha') {
        sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      } else {
        sorted.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      }

      if (sorted.length === 0) {
        drawerSectionsList.innerHTML = '<div class="lc-sess-empty">No sessions found</div>';
        return;
      }

      sorted.forEach((s) => {
        const card = document.createElement('div');
        const isActive = s.id === currentActiveSessionId;
        const isRunningSess = s.status === 'running';
        card.className = 'lc-sess-row' + (isActive ? ' active' : '');

        card.innerHTML =
          '<span class="lc-sess-gutter"><span class="lc-sess-dot' + (isRunningSess ? ' running' : '') + '"></span></span>' +
          '<div class="lc-sess-main">' +
            '<div class="lc-sess-top">' +
              '<div class="lc-sess-name" title="' + escapeHtml(s.title || 'Untitled Session') + '">' + escapeHtml(s.title || 'Untitled Session') + '</div>' +
              '<div class="lc-sess-row-actions">' +
                '<button class="session-act-btn btn-rename" type="button" title="Rename">' + lcIcon('pencil', 12) + '</button>' +
                '<button class="session-act-btn btn-delete-session btn-delete" type="button" title="Delete">' + lcIcon('trash-2', 12) + '</button>' +
              '</div>' +
            '</div>' +
            '<div class="lc-sess-meta">' +
              '<span class="lc-sess-time">' + escapeHtml(formatTimeAgo(s.updatedAt || s.createdAt)) + '</span>' +
            '</div>' +
          '</div>';

        // Click to switch section
        card.addEventListener('click', (e) => {
          if (e.target.closest('.lc-sess-row-actions')) return;
          closeDrawer();
          vscode.postMessage({ command: 'switchSection', sessionId: s.id });
        });

        // Rename
        card.querySelector('.btn-rename').addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'renameSection', sessionId: s.id });
        });

        // Delete
        card.querySelector('.btn-delete').addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'deleteSection', sessionId: s.id });
        });

        drawerSectionsList.appendChild(card);
      });
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
    const modelSelector = document.getElementById('modelSelector');
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
          popover.style.right = '6px';
          popover.style.left = 'auto';
        } else {
          popover.style.left = '6px';
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

    // Keyboard Shortcuts
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

    ${getModelSelectorScript({ modelLabelElementId: 'current-model-label' })}

    // Execution Mode
    document.querySelectorAll('#execModePopover .popover-card-option[data-exec]').forEach((opt) => {
      opt.addEventListener('click', () => {
        const mode = opt.getAttribute('data-exec');
        setExecutionModeUI(mode);
        vscode.postMessage({ command: 'setExecutionMode', executionMode: mode });
        closeAllPopovers();
      });
    });

    // Composer top mode tabs (Agent / Plan / Ask / Review) synced with executionMode
    document.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = btn.getAttribute('data-mode') || 'agent';
        document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
        if (m === 'review') {
          vscode.postMessage({ command: 'showChangesPanel' });
          return;
        }
        const mappedExec = m === 'plan' ? 'plan' : m === 'ask' ? 'ask' : 'code';
        setExecutionModeUI(mappedExec);
        vscode.postMessage({ command: 'setExecutionMode', executionMode: mappedExec });
      });
    });

    function setExecutionModeUI(mode) {
      cachedConfig.executionMode = mode;
      document.querySelectorAll('#execModePopover .popover-card-option[data-exec]').forEach((el) => {
        el.classList.toggle('active', el.getAttribute('data-exec') === mode);
      });
      const tabTarget = mode === 'plan' ? 'plan' : mode === 'ask' ? 'ask' : 'agent';
      document.querySelectorAll('.mode-btn').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-mode') === tabTarget);
      });
      const labels = {
        code: lcIcon('code', 13) + '<span>Code</span>',
        smart: lcIcon('sparkles', 13) + '<span>Smart</span>',
        ask: lcIcon('message-square', 13) + '<span>Ask</span>',
        plan: lcIcon('list-checks', 13) + '<span>Plan</span>',
      };
      if (execModeLabel) execModeLabel.innerHTML = labels[mode] || (lcIcon('code', 13) + '<span>Code</span>');
    }

    // Permission Mode
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
      if (btnPermMode) {
        btnPermMode.classList.toggle('bypass-active', mode === 'bypass');
      }
      const labels = {
        ask: lcIcon('shield', 13) + '<span>Ask</span>',
        smart: lcIcon('shield-check', 13) + '<span>Smart</span>',
        bypass: lcIcon('shield-alert', 13) + '<span>Bypass</span>',
      };
      if (permModeLabel) permModeLabel.innerHTML = labels[mode] || (lcIcon('shield-check', 13) + '<span>Smart</span>');
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
          '<span>' + icon + '</span>' +
          '<span>' + escapeHtml(label) + '</span>' +
          '<span class="attached-chip-remove" data-path="' + escapeHtml(filePath) + '" title="Remove">' + lcIcon('x', 11) + '</span>';

        chip.querySelector('.attached-chip-remove').addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'removeAttachment', filePath });
        });

        attachedChipsRow.appendChild(chip);
      }
    }

    let cachedActivities = [];
    let expandedActivityIds = {};
    let expandedThoughtIds = {};
    let activityFilter = 'all';
    let currentViewTab = 'chat';
    let currentStatusSummary = '';
    const streamingMsgNodes = {};

    function switchSideTab(tab) {
      currentViewTab = tab === 'activity' ? 'activity' : 'chat';
      if (tabBtnChat) tabBtnChat.classList.toggle('active', currentViewTab === 'chat');
      if (tabBtnActivity) tabBtnActivity.classList.toggle('active', currentViewTab === 'activity');
      if (chatContainer) chatContainer.style.display = currentViewTab === 'chat' ? 'flex' : 'none';
      if (liveStrip) liveStrip.style.display = currentViewTab === 'chat' ? 'flex' : 'none';
      if (activityPanel) activityPanel.classList.toggle('visible', currentViewTab === 'activity');
      if (currentViewTab === 'activity') renderActivityPanel();
    }

    if (tabBtnChat) tabBtnChat.addEventListener('click', () => switchSideTab('chat'));
    if (tabBtnActivity) tabBtnActivity.addEventListener('click', () => switchSideTab('activity'));
    if (tabBtnTerminal) {
      tabBtnTerminal.addEventListener('click', () => {
        vscode.postMessage({ command: 'focusIntegratedTerminal' });
      });
    }
    if (btnClearActivity) {
      btnClearActivity.addEventListener('click', () => {
        cachedActivities = [];
        expandedActivityIds = {};
        updateActivityCounters();
        renderActivityPanel();
        vscode.postMessage({ command: 'clearActivities' });
      });
    }
    document.querySelectorAll('.lc-act-filter-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        activityFilter = btn.getAttribute('data-filter') || 'all';
        document.querySelectorAll('.lc-act-filter-pill').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-filter') === activityFilter);
        });
        renderActivityPanel();
      });
    });

    function updateActivityCounters() {
      const count = cachedActivities.length;
      if (activityCountBadge) activityCountBadge.textContent = String(count);
    }

    function renderLiveStrip() {
      if (!liveStrip) return;
      liveStrip.innerHTML = '';
      if (isRunning && currentStatusSummary) {
        const row = document.createElement('div');
        row.className = 'lc-live-status-row';
        row.innerHTML =
          '<span class="lc-status-pulse"></span>' +
          '<span class="lc-live-status-text">' + lcEscapeHtml(currentStatusSummary) + '</span>';
        liveStrip.appendChild(row);
      }
      if (cachedActivities.length > 0) {
        const runningCount = cachedActivities.filter((a) => a.status === 'running').length;
        const failCount = cachedActivities.filter((a) => a.status === 'failed').length;
        const label =
          runningCount > 0
            ? 'Agent activity: ' + runningCount + ' active (' + cachedActivities.length + ' total)'
            : failCount > 0
              ? 'View ' + cachedActivities.length + ' activity items (' + failCount + ' failed)'
              : 'View ' + cachedActivities.length + ' activity item' + (cachedActivities.length === 1 ? '' : 's');
        const pill = document.createElement('button');
        pill.className = 'lc-turn-summary-pill';
        pill.type = 'button';
        pill.innerHTML = lcIcon('zap', 12) + '<span>' + lcEscapeHtml(label) + '</span>' + lcIcon('chevron-right', 12);
        pill.addEventListener('click', () => switchSideTab('activity'));
        liveStrip.appendChild(pill);
      }
    }

    function matchesSideActivityFilter(item) {
      if (!item) return false;
      if (activityFilter === 'all') return true;
      if (activityFilter === 'command') return item.category === 'command';
      if (activityFilter === 'file') return item.category === 'file';
      if (activityFilter === 'subagent') return item.category === 'subagent';
      return true;
    }

    function buildSideActivityNode(item) {
      if (item.category === 'thinking_summary') {
        return lcBuildThoughtEntryElement(item, {
          isExpanded: !!expandedThoughtIds[item.id],
          onToggleExpand: (id, open) => {
            expandedThoughtIds[id] = open;
          },
        });
      }
      const isOpen = !!expandedActivityIds[item.id] || item.status === 'running' || item.status === 'failed';
      return lcBuildActivityCardElement(item, isOpen, (id, open) => {
        expandedActivityIds[id] = open;
      });
    }

    function upsertActivityPanelItem(item) {
      if (!activityList || !item || !item.id || !matchesSideActivityFilter(item)) return;
      const existing = lcFindChildByAttr(activityList, 'data-act-id', item.id);
      if (existing) {
        if (item.category === 'thinking_summary') {
          lcUpdateThoughtEntryElement(existing, item, { isExpanded: !!expandedThoughtIds[item.id] });
        } else {
          lcUpdateActivityCardElement(existing, item);
        }
        if (activityPinnedToBottom) {
          activityList.scrollTop = activityList.scrollHeight;
        }
        return;
      }
      renderActivityPanel();
    }

    function renderActivityPanel(opts) {
      if (!activityList) return;
      const forceBottom = Boolean(opts && opts.forceScrollBottom);
      const prevTop = Number(activityList.scrollTop || 0);
      const shouldStick = forceBottom || activityPinnedToBottom;
      const savedInner = new Map();
      activityList.querySelectorAll('[data-act-id]').forEach((el) => {
        const id = el.getAttribute('data-act-id');
        const body = el.querySelector('.lc-thought-body, .lc-terminal-pre.is-stdout');
        if (id && body) {
          const top = Number(body.scrollTop || 0);
          const gap = Number(body.scrollHeight || 0) - top - Number(body.clientHeight || 0);
          savedInner.set(id, { scrollTop: top, wasAtBottom: top > 0 && gap <= 24 });
        }
      });

      activityList.innerHTML = '';
      const filtered = cachedActivities.filter(matchesSideActivityFilter);
      if (filtered.length === 0) {
        activityList.innerHTML =
          '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px;">' +
          'No agent tool or command executions in this section yet.' +
          '</div>';
        return;
      }
      filtered.forEach((item) => {
        const node = buildSideActivityNode(item);
        activityList.appendChild(node);
        const snap = savedInner.get(item.id);
        if (snap) {
          const body = node.querySelector('.lc-thought-body, .lc-terminal-pre.is-stdout');
          if (body) {
            if (snap.wasAtBottom) body.scrollTop = Math.max(0, body.scrollHeight - body.clientHeight);
            else if (snap.scrollTop > 0) body.scrollTop = snap.scrollTop;
          }
        }
      });
      if (shouldStick) {
        activityList.scrollTop = activityList.scrollHeight;
      } else if (prevTop > 0) {
        activityList.scrollTop = prevTop;
      }
    }

    function renderSidebarChat(opts) {
      const forceBottom = Boolean(opts && opts.forceScrollBottom);
      const prevTop = Number(chatContainer.scrollTop || 0);
      const shouldStick = forceBottom || chatPinnedToBottom;
      const mergedCmdMap = new Map();
      (Array.isArray(currentCommandResults) ? currentCommandResults : []).forEach((cr) => {
        if (cr && cr.id) mergedCmdMap.set(cr.id, cr);
      });
      (Array.isArray(ephemeralCommandResults) ? ephemeralCommandResults : []).forEach((cr) => {
        if (cr && cr.id) mergedCmdMap.set(cr.id, cr);
      });
      const allCmdResults = Array.from(mergedCmdMap.values()).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      chatContainer.innerHTML = '';
      Object.keys(streamingMsgNodes).forEach((k) => delete streamingMsgNodes[k]);

      if (currentSessionMessagesCache.length === 0 && allCmdResults.length === 0) {
        if (emptyWelcome) {
          emptyWelcome.style.display = 'flex';
          chatContainer.appendChild(emptyWelcome);
        }
        return;
      }

      if (emptyWelcome) emptyWelcome.style.display = 'none';
      let nextCmdIdx = 0;
      const appendCmdCard = (cr) => {
        chatContainer.appendChild(lcBuildCommandResultElement(cr, {
          onConfirm: (commandLine, cardId) => {
            ephemeralCommandResults = ephemeralCommandResults.filter((x) => x.id !== cardId);
            vscode.postMessage({ command: 'confirmSlashCommand', text: commandLine });
          },
          onCancel: (cardId) => {
            ephemeralCommandResults = ephemeralCommandResults.filter((x) => x.id !== cardId);
            renderSidebarChat();
          },
        }));
      };

      currentSessionMessagesCache.forEach((m) => {
        const msgTs = m?.timestamp || 0;
        while (nextCmdIdx < allCmdResults.length && msgTs > 0 && (allCmdResults[nextCmdIdx].timestamp || 0) <= msgTs) {
          appendCmdCard(allCmdResults[nextCmdIdx++]);
        }
        renderMessage(m);
      });
      while (nextCmdIdx < allCmdResults.length) {
        appendCmdCard(allCmdResults[nextCmdIdx++]);
      }

      if (currentSessionPlanExplicit && currentSessionPlanCache && currentSessionPlanCache.length > 0) {
        renderPlan(currentSessionPlanCache);
      }
      if (shouldStick) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
        chatPinnedToBottom = true;
      } else if (prevTop > 0) {
        chatContainer.scrollTop = prevTop;
      }
    }

    window.addEventListener('message', (event) => {
      const data = event.data;
      switch (data.type) {
        case 'loadSession':
          allSectionsCache = data.allSessions || [];
          cachedAllModelsList = data.allModels || [];
          if (Array.isArray(data.slashCommands)) {
            slashCommandsCatalog = data.slashCommands;
            if (slashCtrl && slashCtrl.isOpen()) {
              slashCtrl.refreshFromInput();
            }
          }
          if (drawerCount) drawerCount.textContent = allSectionsCache.length;

          let isNewSessionLoad = false;
          {
            const nextId = data.session ? data.session.id : null;
            if (lastLoadedSessionId !== nextId) {
              isNewSessionLoad = true;
              ephemeralCommandResults = [];
              lcQueueUserToggled = false;
              lcQueueEditingId = null;
              lastLoadedSessionId = nextId;
            }
          }

          if (data.session) {
            currentActiveSessionId = data.session.id;
            sessionTitle.textContent = data.session.title || 'New Section';
          }

          if (data.currentConfig) {
            cachedConfig = Object.assign({}, cachedConfig, data.currentConfig);
            if (data.permissionMode) cachedConfig.permissionMode = data.permissionMode;
            setExecutionModeUI(cachedConfig.executionMode || 'code');
            setPermissionModeUI(cachedConfig.permissionMode || 'smart');
            if (chkFastMode) chkFastMode.checked = !!cachedConfig.fastMode;
            renderAttachedChips(cachedConfig.attachedFiles || []);
          }

          if (data.modelsGrouped) {
            cachedGroupedModels = data.modelsGrouped;
            renderModelCategories(cachedGroupedModels, modelSearchInput.value.trim());
          }

          {
            const activeModel = cachedAllModelsList.find(
              (m) => m.id === cachedConfig.modelId || m.modelIdentifier === cachedConfig.modelId
            );
            if (currentModelLabel) {
              currentModelLabel.textContent = activeModel?.displayName || cachedConfig.modelName || cachedConfig.modelId || 'Select Model';
            }
            if (modelProviderIcon) {
              modelProviderIcon.innerHTML = activeModel
                ? getProviderSvgIcon(activeModel.providerType === 'LOCAL' ? (activeModel.providerId === 'ollama' ? 'ollama' : 'custom') : activeModel.providerId.split('-')[0])
                : '';
            }
            updateModelConfigurationUI(activeModel);
          }

          if (data.workspaceName && chipProjectName) {
            chipProjectName.textContent = data.workspaceName;
          }

          // Re-render drawer if open
          if (sectionsDrawer.classList.contains('open')) {
            renderDrawerSections(allSectionsCache);
          }

          cachedActivities = Array.isArray(data.session?.activities) ? data.session.activities.slice() : [];
          updateActivityCounters();
          renderActivityPanel({ forceScrollBottom: isNewSessionLoad });

          const sessionRunning = Boolean(data.session?.status === 'running' || data.queueSnapshot?.isBusy);
          currentStatusSummary = sessionRunning ? (data.session?.activePhaseSummary || 'Agent is working') : '';
          setRunningState(sessionRunning);
          renderLiveStrip();

          if (data.queueSnapshot) {
            lcSetQueueSnapshot(data.queueSnapshot);
          } else {
            lcSetQueueSnapshot({
              sessionId: data.session ? data.session.id : '',
              state: sessionRunning ? 'running' : 'idle',
              paused: false,
              activeItemId: null,
              activeExecutionId: null,
              isBusy: sessionRunning,
              capacity: 200,
              queuedCount: 0,
              failedCount: 0,
              completedCount: 0,
              lastError: '',
              items: [],
            });
          }

          currentSessionMessagesCache = Array.isArray(data.session?.messages) ? data.session.messages.slice() : [];
          currentCommandResults = Array.isArray(data.session?.commandResults) ? data.session.commandResults.slice() : [];
          currentSessionPlanCache = Array.isArray(data.session?.plan) ? data.session.plan.slice() : [];
          currentSessionPlanExplicit = !!data.session?.planExplicit;
          renderSidebarChat({ forceScrollBottom: isNewSessionLoad });
          break;

        case 'addMessage':
          if (emptyWelcome) emptyWelcome.style.display = 'none';
          if (data.message && (!data.message.id || !currentSessionMessagesCache.some((m) => m.id === data.message.id))) {
            currentSessionMessagesCache.push(data.message);
          }
          if (data.message && data.message.id && streamingMsgNodes[data.message.id]) {
            const node = streamingMsgNodes[data.message.id];
            const contentEl = node.querySelector('.msg-content');
            if (contentEl) {
              contentEl.innerHTML = renderMarkdown(data.message.content || '');
            }
            delete streamingMsgNodes[data.message.id];
            if (chatPinnedToBottom) chatContainer.scrollTop = chatContainer.scrollHeight;
          } else {
            if (data.message?.senderRole === 'user') chatPinnedToBottom = true;
            renderMessage(data.message);
          }
          if (data.message?.senderRole === 'assistant') {
            currentStatusSummary = '';
            setRunningState(Boolean(lcGetQueueSnapshot()?.isBusy));
            renderLiveStrip();
          }
          break;

        case 'messageDelta': {
          const ev = data.event;
          if (!ev || !ev.messageId) break;
          if (emptyWelcome) emptyWelcome.style.display = 'none';
          let row = streamingMsgNodes[ev.messageId];
          if (!row) {
            row = document.createElement('div');
            row.className = 'msg-row';
            row.setAttribute('data-msg-id', ev.messageId);
            row.innerHTML =
              '<div class="msg-assistant">' +
              '<div class="msg-header">' +
              lcIcon('bot', 13) +
              '<span>' + escapeHtml(ev.agentName || 'Main Agent') + '</span>' +
              '</div>' +
              '<div class="msg-content"></div>' +
              '</div>';
            chatContainer.appendChild(row);
            streamingMsgNodes[ev.messageId] = row;
          }
          const contentEl = row.querySelector('.msg-content');
          if (contentEl) {
            contentEl.innerHTML = renderMarkdown(ev.fullContent || '');
          }
          if (chatPinnedToBottom) {
            chatContainer.scrollTop = chatContainer.scrollHeight;
          }
          break;
        }

        case 'statusUpdate': {
          const ev = data.event;
          if (!ev) break;
          const isTerminal = ev.phase === 'completed' || ev.phase === 'failed' || ev.phase === 'cancelled';
          if (isTerminal) {
            currentStatusSummary = '';
            setRunningState(false);
          } else {
            currentStatusSummary = ev.summary || 'Agent is working';
            setRunningState(true);
          }
          renderLiveStrip();
          break;
        }

        case 'activityUpsert': {
          if (!data.item || !data.item.id) break;
          cachedActivities = lcUpsertActivityList(cachedActivities, data.item);
          updateActivityCounters();
          renderLiveStrip();
          upsertActivityPanelItem(data.item);
          break;
        }

        case 'runFinished': {
          const terminalStatus = data.status || 'completed';
          currentStatusSummary = '';
          setRunningState(false);
          cachedActivities = cachedActivities.map((item) =>
            item.status === 'running' ? Object.assign({}, item, { status: terminalStatus }) : item
          );
          updateActivityCounters();
          renderLiveStrip();
          renderActivityPanel();
          break;
        }

        case 'queueUpdated': {
          if (data.snapshot) {
            setRunningState(Boolean(data.snapshot.isBusy));
            lcSetQueueSnapshot(data.snapshot);
            renderLiveStrip();
          }
          break;
        }

        case 'queueActionError': {
          if (data.error) {
            lcQueueUserToggled = true;
            lcQueueExpanded = true;
            lcSetQueueSnapshot(Object.assign({}, lcGetQueueSnapshot(), { lastError: data.error }));
          }
          break;
        }

        case 'planUpdate':
          if (data.explicit && data.plan && data.plan.length > 0) {
            renderPlan(data.plan);
          }
          break;

        case 'activity':
          break;

        case 'approvalRequest':
          renderApproval(data.request);
          break;

        case 'slashCommandResult': {
          const res = data.result;
          if (!res) break;
          if (res.status === 'confirmation_required') {
            ephemeralCommandResults = ephemeralCommandResults.filter(
              (x) => x.status !== 'confirmation_required' || x.command !== res.command
            );
            ephemeralCommandResults.push(res);
          } else if (res.command === 'clear' && res.ok) {
            ephemeralCommandResults = [res];
            currentCommandResults = [];
            currentSessionMessagesCache = [];
          } else if (res.command === 'delete-session' && res.ok) {
            ephemeralCommandResults = [res];
          } else {
            if (!currentCommandResults.some((x) => x.id === res.id)) {
              currentCommandResults.push(res);
            }
          }
          renderSidebarChat();
          if (res.uiAction) {
            const act = res.uiAction.type;
            if (act === 'openModelSelector' && typeof togglePopover === 'function' && typeof modelSelectorPopover !== 'undefined') {
              togglePopover(modelSelectorPopover, modelSelector, true);
              setTimeout(() => {
                modelSearchInput?.focus();
                modelSearchInput?.select();
              }, 50);
            } else if (act === 'focusSessions' && sectionsDrawer) {
              sectionsDrawer.classList.add('open');
              drawerFilterBar?.classList.add('open');
              btnDrawerFilter?.classList.add('active');
              renderDrawerSections(allSectionsCache);
              drawerSearchInput?.focus();
            } else if (act === 'focusPrompt' && promptInput) {
              promptInput.focus();
            }
          }
          break;
        }

        case 'modelsGroupedResponse':
          if (data.modelsGrouped) {
            cachedGroupedModels = data.modelsGrouped;
            renderModelCategories(cachedGroupedModels, data.query || '');
          }
          break;
      }
    });

    function renderMessage(msg) {
      if (!msg) return;
      if (msg.id) {
        const existing = chatContainer.querySelector('[data-msg-id="' + msg.id.replace(/"/g, '') + '"]');
        if (existing) {
          const c = existing.querySelector('.msg-content');
          if (c) c.innerHTML = renderMarkdown(msg.content || '');
          return;
        }
      }
      if (msg.senderRole === 'user') {
        const lastRow = chatContainer.lastElementChild;
        if (lastRow && lastRow.querySelector('.msg-user')) {
          const prevText = lastRow.querySelector('.msg-user').textContent || '';
          if (prevText.trim() === (msg.content || '').trim()) {
            return; // skip duplicate user bubble
          }
        }
      }
      const row = document.createElement('div');
      row.className = 'msg-row';
      if (msg.id) row.setAttribute('data-msg-id', msg.id);

      if (msg.senderRole === 'user') {
        row.innerHTML = '<div class="msg-user">' + escapeHtml(msg.content) + '</div>';
      } else {
        row.innerHTML =
          '<div class="msg-assistant">' +
          '<div class="msg-header">' +
          lcIcon('bot', 13) +
          '<span>' + escapeHtml(msg.senderName || 'Main Agent') + '</span>' +
          '</div>' +
          '<div class="msg-content">' + renderMarkdown(msg.content) + '</div>' +
          '</div>';
      }
      chatContainer.appendChild(row);
      if (chatPinnedToBottom) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }

    function renderPlan(plan) {
      if (!plan || plan.length === 0) return;
      let box = chatContainer.querySelector('.plan-box');
      if (!box) {
        box = document.createElement('div');
        box.className = 'plan-box';
        chatContainer.appendChild(box);
      }
      let html = '<div class="plan-title"><span class="lc-icon-gap">' + lcIcon('list-checks', 13) + '<span>Execution Plan</span></span><span>' + plan.length + ' steps</span></div>';
      plan.forEach((item, idx) => {
        html +=
          '<div class="plan-item">' +
          '<span>' + (idx + 1) + '. ' + escapeHtml(item.title) + '</span>' +
          '<span class="plan-badge status-' + escapeHtml(item.status) + '">' + escapeHtml(item.status) + '</span>' +
          '</div>';
      });
      box.innerHTML = html;
      if (chatPinnedToBottom) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }

    function renderApproval(req) {
      const box = document.createElement('div');
      box.className = 'approval-box';
      box.innerHTML =
        '<div style="font-weight: 600; color: var(--warning); margin-bottom: 6px; display:flex; align-items:center; gap:6px;">' + lcIcon('triangle-alert', 14) + '<span>Approval Required: ' + escapeHtml(req.toolName) + '</span></div>' +
        '<div style="font-size: 12px; color: var(--fg);">' + escapeHtml(req.description) + '</div>' +
        '<div class="approval-btns">' +
        '<button class="btn-approve" id="app-yes">Approve</button>' +
        '<button class="btn-reject" id="app-no">Reject</button>' +
        '</div>';
      box.querySelector('#app-yes').addEventListener('click', () => {
        vscode.postMessage({ command: 'resolveApproval', requestId: req.id, approved: true });
        box.remove();
      });
      box.querySelector('#app-no').addEventListener('click', () => {
        vscode.postMessage({ command: 'resolveApproval', requestId: req.id, approved: false });
        box.remove();
      });
      chatContainer.appendChild(box);
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function renderMarkdown(text) {
      return lcRenderMarkdown(text);
    }
  </script>
</body>
</html>`;
  }
}
