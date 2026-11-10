import { AgentOrchestrator } from '../agents/orchestrator';
import { AgentRegistry } from '../agents/agent-registry';
import { ChangesManager } from '../context/changes-manager';
import { MemoryManager } from '../context/memory-manager';
import { McpHost } from '../mcp/mcp-host';
import { ModelProviderRegistry } from '../models/model-provider-registry';
import { OllamaClient } from '../ollama/client';
import { PermissionManager } from '../security/permission-manager';
import { ExecutionMode, PermissionMode, SessionManager } from '../sessions/session-manager';
import { TerminalSessionManager } from '../tools/terminal-session-manager';
import { ToolManager } from '../tools/tool-manager';
import { OperationHistoryManager } from './operation-history';

export type CommandAgentMode = 'agent' | 'plan' | 'ask' | 'review';
export type CommandPermissionTier = 'safe' | 'workspace_write' | 'elevated' | 'restricted';
export type CommandSource = 'builtin' | 'workspace' | 'user' | 'plugin' | 'mcp';

export interface CommandArgument {
  name: string;
  description: string;
  required?: boolean;
  values?: string[];
  type?: 'string' | 'boolean' | 'enum' | 'model' | 'session';
}

export interface CommandSubcommand {
  name: string;
  description: string;
  usage?: string;
  arguments?: CommandArgument[];
  requiresConfirmation?: boolean;
  allowedModes?: CommandAgentMode[];
  permissionRequirement?: CommandPermissionTier;
}

export interface CommandMetadata {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
  category: string;
  source: CommandSource;
  arguments?: CommandArgument[];
  subcommands?: CommandSubcommand[];
  requiresWorkspace?: boolean;
  requiresConfirmation?: boolean;
  changesState?: boolean;
  allowedModes?: CommandAgentMode[];
  permissionRequirement?: CommandPermissionTier;
  securityNotes?: string;
  /** When true and no required arguments exist, selecting in autocomplete may execute directly or insert cleanly. */
  autoExecuteOnSelect?: boolean;
  /** Optional Lucide icon key from lucide-icons.ts */
  icon?: string;
}

export interface ParsedSlashCommand {
  raw: string;
  commandName: string;
  subcommand?: string;
  args: string[];
  argString: string;
}

export interface CommandResultDetail {
  label: string;
  value: string;
}

export interface CommandResult {
  id: string;
  command: string;
  rawInput: string;
  ok: boolean;
  status: 'success' | 'error' | 'cancelled' | 'confirmation_required' | 'info';
  title: string;
  message: string;
  details?: CommandResultDetail[];
  codeBlock?: {
    language?: string;
    content: string;
  };
  confirmPrompt?: {
    commandLine: string;
    title: string;
    detail: string;
    confirmLabel?: string;
  };
  warnings?: string[];
  uiAction?: {
    type:
      | 'openModelSelector'
      | 'openTerminal'
      | 'openChanges'
      | 'focusSessions'
      | 'openCockpitModal'
      | 'focusPrompt'
      | 'selectFiles';
    payload?: any;
  };
  changesState?: boolean;
  timestamp: number;
}

export interface CommandUIHooks {
  openCockpitModal?: (modal: 'models' | 'agents' | 'mcp' | 'rules' | 'settings', statusText?: string) => Promise<void> | void;
  switchInspectorTab?: (tab: 'terminal' | 'changes') => void;
  openFilesExplorerOrPicker?: (workspaceRoot: string) => Promise<string[] | void> | void;
  syncSession?: () => Promise<void> | void;
  updateTitle?: () => void;
  applyWorkingFolder?: (root: string) => void;
  submitAgentPrompt?: (prompt: string, overrideExecutionMode?: ExecutionMode) => Promise<void>;
  persistPermissionDefault?: (mode: PermissionMode) => Promise<void> | void;
}

export interface CommandContext {
  workspaceRoot: string;
  activeMode: CommandAgentMode;
  viewMode: 'agent' | 'ide';
  confirmed: boolean;
  abortSignal?: AbortSignal;
  callerSource?: CommandSource;
  orchestrator: AgentOrchestrator;
  sessionManager: SessionManager;
  modelRegistry: ModelProviderRegistry;
  permissionManager: PermissionManager;
  changesManager: ChangesManager;
  terminalManager: TerminalSessionManager;
  toolManager?: ToolManager;
  mcpHost?: McpHost;
  registry?: AgentRegistry;
  memoryManager?: MemoryManager;
  ollama?: OllamaClient;
  historyManager: OperationHistoryManager;
  ui?: CommandUIHooks;
}

export interface SlashCommand extends CommandMetadata {
  validate?: (context: CommandContext, parsed: ParsedSlashCommand) => { ok: boolean; error?: string };
  autocompleteArgs?: (context: CommandContext, partialArg: string) => Promise<string[]> | string[];
  execute: (context: CommandContext, args: string[], parsed: ParsedSlashCommand) => Promise<CommandResult>;
}
