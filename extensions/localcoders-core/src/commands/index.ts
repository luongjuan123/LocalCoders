import * as vscode from 'vscode';
import { AgentOrchestrator } from '../agents/orchestrator';
import { AgentRegistry } from '../agents/agent-registry';
import { ChangesManager } from '../context/changes-manager';
import { MemoryManager } from '../context/memory-manager';
import { McpHost } from '../mcp/mcp-host';
import { ModelProviderRegistry } from '../models/model-provider-registry';
import { OllamaClient } from '../ollama/client';
import { PermissionManager } from '../security/permission-manager';
import { MessageQueueManager } from '../sessions/message-queue';
import { SessionManager } from '../sessions/session-manager';
import { TerminalSessionManager } from '../tools/terminal-session-manager';
import { ToolManager } from '../tools/tool-manager';
import { ensureBuiltinSlashCommandsRegistered } from './builtin-commands';
import { SlashCommandExecutor } from './executor';
import { OperationHistoryManager } from './operation-history';
import { SlashCommandRegistry } from './registry';
import { CommandAgentMode, CommandContext, CommandResult, CommandUIHooks } from './types';

export * from './types';
export * from './parser';
export * from './registry';
export * from './executor';
export * from './operation-history';
export * from './builtin-commands';
export * from './command-ui';

export async function runSlashCommandForWorkspace(params: {
  rawInput: string;
  confirmed?: boolean;
  abortSignal?: AbortSignal;
  workspaceRoot: string;
  viewMode: 'agent' | 'ide';
  orchestrator: AgentOrchestrator;
  sessionManager: SessionManager;
  modelRegistry: ModelProviderRegistry;
  permissionManager?: PermissionManager;
  changesManager?: ChangesManager;
  toolManager?: ToolManager;
  mcpHost?: McpHost;
  registry?: AgentRegistry;
  ollama?: OllamaClient;
  queueManager?: MessageQueueManager;
  ui?: CommandUIHooks;
}): Promise<CommandResult> {
  const reg = ensureBuiltinSlashCommandsRegistered(SlashCommandRegistry.getInstance(), params.workspaceRoot);
  const executor = new SlashCommandExecutor(reg);

  const session = params.sessionManager.getActiveSession();
  const execMode = session?.config?.executionMode || 'code';
  const activeMode: CommandAgentMode =
    execMode === 'plan' ? 'plan' : execMode === 'ask' ? 'ask' : 'agent';

  const pm =
    params.permissionManager ||
    params.toolManager?.getPermissionManager() ||
    new PermissionManager(params.workspaceRoot);

  const cm = params.changesManager || new ChangesManager(params.workspaceRoot);
  const mem = new MemoryManager(params.workspaceRoot);
  const qm =
    params.queueManager ||
    MessageQueueManager.getShared() ||
    new MessageQueueManager({
      sessionManager: params.sessionManager,
      orchestrator: params.orchestrator,
      modelRegistry: params.modelRegistry,
      permissionManager: pm,
      changesManager: cm,
      toolManager: params.toolManager,
      mcpHost: params.mcpHost,
      registry: params.registry,
      ollama: params.ollama,
    });

  const ctx: CommandContext = {
    workspaceRoot: params.workspaceRoot,
    activeMode,
    viewMode: params.viewMode,
    confirmed: !!params.confirmed,
    abortSignal: params.abortSignal,
    callerSource: 'builtin',
    orchestrator: params.orchestrator,
    sessionManager: params.sessionManager,
    modelRegistry: params.modelRegistry,
    permissionManager: pm,
    changesManager: cm,
    terminalManager: TerminalSessionManager.getInstance(),
    toolManager: params.toolManager,
    mcpHost: params.mcpHost,
    registry: params.registry,
    memoryManager: mem,
    ollama: params.ollama,
    queueManager: qm,
    historyManager: OperationHistoryManager.getInstance(),
    ui: {
      ...params.ui,
      persistPermissionDefault: async (mode) => {
        try {
          await vscode.workspace.getConfiguration('localcoders').update('defaultPermissionMode', mode, vscode.ConfigurationTarget.Global);
        } catch {
          // Ignore when configuration update is unavailable (e.g. unit test mocks)
        }
        await params.ui?.persistPermissionDefault?.(mode);
      },
    },
  };

  const result = await executor.executeInput(params.rawInput, ctx);

  // Record non-ephemeral command results cleanly on session history (separate from LLM conversation messages)
  if (result.status !== 'confirmation_required' && result.command !== 'clear' && result.command !== 'delete-session') {
    params.sessionManager.updateActiveSession((s) => {
      if (!Array.isArray(s.commandResults)) s.commandResults = [];
      s.commandResults.push(result);
      if (s.commandResults.length > 60) {
        s.commandResults = s.commandResults.slice(-60);
      }
      if (!Array.isArray(s.activities)) s.activities = [];
      s.activities.push({
        id: `act_cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        runId: `slash_${result.id}`,
        agentId: 'user',
        agentName: 'Slash Command',
        category: 'command',
        title: `/${result.command}`,
        command: params.rawInput.trim(),
        summary: result.title,
        status: result.ok ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed',
        timestamp: result.timestamp,
        startTime: result.timestamp,
        endTime: Date.now(),
        durationMs: 0,
      });
    });
  }

  return result;
}
