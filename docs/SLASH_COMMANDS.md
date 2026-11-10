# LocalCoders Slash Command System

LocalCoders provides a centralized, extensible slash-command architecture across both **Agent View** (`AgentWorkspaceEditorPanel`) and **IDE Chat Sidebar** (`ChatViewProvider`). All commands share a single source of truth in `extensions/localcoders-core/src/commands/`.

## Architecture

### Core Modules

| File | Responsibility |
| --- | --- |
| `src/commands/types.ts` | Defines `SlashCommand`, `CommandMetadata`, `CommandContext`, `CommandResult`, `CommandPermissionTier`, and `CommandUIHooks`. |
| `src/commands/parser.ts` | Parses slash invocations (`parseSlashCommand`), detects slash intent safely (`isSlashCommandInput`), and extracts autocomplete queries (`getSlashAutocompleteQuery`). Multi-slash paths (`/home/user/file.ts`), inline URLs, and multiline prose are ignored. |
| `src/commands/registry.ts` | Central singleton `SlashCommandRegistry` storing built-in, workspace (`.localcoders/commands/*.json`), user (`~/.localcoders/commands/*.json`), and external plugin/MCP commands (`registerExternalCommand`). |
| `src/commands/executor.ts` | `SlashCommandExecutor` pipeline: syntax parsing, registry lookup with fuzzy typo hints, concurrent duplicate suppression, abort-signal checks, mode/workspace/argument validation, permission & prohibited-pattern enforcement, confirmation handling, secret redaction, and audit logging. |
| `src/commands/operation-history.ts` | Workspace-scoped undo/redo stack (`OperationHistoryManager`) populated by `writeFileTool`, `editFileTool`, `renameFileTool`, and `deleteFileTool`. |
| `src/commands/builtin-commands.ts` | Registers all 34 built-in commands plus real context compaction (`compactSessionContext`) and project run/test detection (`detectConfiguredProjectCommand`). |
| `src/commands/command-ui.ts` | Shared autocomplete popup styles/markup/controller (`lcCreateSlashController`), active bypass banner (`#bypassModeBanner`), and `.lc-cmd-result-card` UI rendering. |
| `src/commands/index.ts` | Exports the command API and `runSlashCommandForWorkspace(...)`, which wires runtime services, persists non-ephemeral command cards to `session.commandResults`, and records activity telemetry. |

---

## Autocomplete & Composer Behavior

Typing `/` at the start of the composer input opens the command suggestion popup above the prompt input box.

- **Filter as you type**: Typing `/mod` narrows results to `/model`, `/models`, and `/model-info`; aliases also match.
- **Argument suggestions**: After pressing `Space`, commands with subcommands or enumerated options (`/model`, `/reasoning`, `/help`, `/git`, `/mcp`, `/sessions`) surface argument completions.
- **Keyboard shortcuts**:
  - `ArrowDown` / `ArrowUp`: Cycle through suggestions.
  - `Tab`: Autocomplete the highlighted command into the composer.
  - `Enter`: Execute the highlighted command immediately (or insert its template if required arguments are missing); submit when arguments are already filled.
  - `Escape`: Close the popup without clearing the composer.
- **Safe coexistence**:
  - Normal messages containing `/` (e.g. `src/commands/parser.ts`, `https://localhost:11434`, `a / b`), Unix paths (`/home/user/project/file.ts`), `Shift+Enter` multiline prompts, attachments, `@` mentions, and existing toolbar popovers are unaffected.

---

## Built-in Commands Reference

### Permission Commands

| Command | Aliases | Usage | Behavior & Security |
| --- | --- | --- | --- |
| `/bypass` | `/bp`, `/permissions-bypass` | `/bypass` | Activates `bypass` mode globally and in the active session (`PermissionManager`, `MainAgent`, `AgentOrchestrator`, `localcoders.defaultPermissionMode`). Auto-approves supported tool, file, and terminal operations while still enforcing `isStrictlyProhibited` checks (secrets, SSH/system paths, privilege escalation, destructive system commands) and explicit confirmation on `/clear` and `/delete-session`. Displays `#bypassModeBanner`. |
| `/normal` | `/safe`, `/ask-mode` | `/normal` | Restores normal permission prompting (`ask` mode) and clears the bypass indicator. |
| `/auto-approve` | `/smart`, `/auto` | `/auto-approve` | Enables `smart` (`auto`) safe-operation approval policy: workspace reads and safe tools auto-approve; mutations and shell commands require confirmation unless explicitly permitted. |
| `/permissions` | `/perms` | `/permissions` | Displays the active permission mode, normalized policy, security enforcement rules, and available modes. |

### Agent Mode Commands

| Command | Aliases | Usage | Behavior |
| --- | --- | --- | --- |
| `/agent` | `/code` | `/agent` | Switches active `executionMode` to `code` (full planning, reading/editing files, running tools & commands, verification). |
| `/plan` | `/p` | `/plan` | Switches active `executionMode` to `plan` (read-only analysis, structured implementation plan, risk/file mapping). |
| `/ask` | `/q` | `/ask` | Switches active `executionMode` to `ask` (question-answering and explanation without workspace modifications). |
| `/review` | `/critic` | `/review [target]` | Inspects uncommitted workspace changes, opens the Changes panel, and runs `CriticAgent` across modified files to report findings with file paths and line ranges. |

### Model Commands

| Command | Aliases | Usage | Behavior |
| --- | --- | --- | --- |
| `/model` | `/m` | `/model [name]` | Without arguments, opens the Model Selector popover; with `<name>`, validates against `ModelProviderRegistry.getAvailableModels()` and switches the active session's model & provider. |
| `/models` | `/ls-models` | `/models` | Discovers and groups available local (via real Ollama API) and configured cloud models (OpenAI, Anthropic, Google, etc.) by provider. Never fabricates models. |
| `/model-info` | `/mi` | `/model-info [name]` | Shows real model metadata: model identifier, provider, context window (or unknown), local/cloud status, availability, capabilities, and supported reasoning efforts. |
| `/reasoning` | `/effort` | `/reasoning [level]` | Displays supported reasoning effort levels (`minimal`, `low`, `medium`, `high`, `extra_high`) for the active model, or sets the level after validating `model.reasoningEffortsSupported`. |

### Session Commands

| Command | Aliases | Usage | Behavior |
| --- | --- | --- | --- |
| `/new` | `/n` | `/new [title]` | Creates a new session using the configured active/default model and switches to it. |
| `/clear` | `/cls` | `/clear` | Clears conversation messages, plans, activities, and command history for the active session after confirmation (`requiresConfirmation`, always asks even in `/bypass`). |
| `/sessions` | `/ss` | `/sessions [switch <id\|name>]` | Lists all saved sessions with IDs and timestamps, focuses the sessions sidebar/drawer, or switches to a matching session. |
| `/rename` | `/mv-session` | `/rename <name>` | Renames the active session cleanly across state and window title. |
| `/delete-session` | `/del-session` | `/delete-session` | Deletes the active session after confirmation (`requiresConfirmation`, always asks even in `/bypass`). |
| `/export` | `/save` | `/export [md\|json]` | Writes the active session's conversation, plan, and metadata to `.localcoders/exports/` in Markdown or JSON format. |
| `/compact` | — | `/compact` | Summarizes the active session using `compactSessionContext` into a `msg_compact_*` system context message preserving User Requirements, Project Structure, Important Decisions, Files Modified, Tasks & Status, and recent Tool Execution Results while keeping recent turns intact. `sanitizeConversationHistory` preserves `msg_compact_*` entries for subsequent LLM turns. |

### Workspace, Git & Development Commands

| Command | Aliases | Usage | Behavior |
| --- | --- | --- | --- |
| `/undo` | `/z` | `/undo` | Reverts the most recent file write/edit/rename/delete recorded in `OperationHistoryManager` within workspace boundaries. |
| `/redo` | `/y` | `/redo` | Re-applies the most recently undone workspace file operation. |
| `/terminal` | `/term` | `/terminal [command]` | Opens and focuses the integrated terminal tab; if arguments are supplied, runs the command inside `TerminalSessionManager` (subject to safety checks). |
| `/git` | `/g` | `/git <status\|diff\|commit <message>>` | Executes real git subcommands via `git-tools`: `status` (`inspectGitStatusTool`), `diff` (`readGitDiffTool`), and `commit` (`gitCommitTool`, requires confirmation when not bypassed). |
| `/files` | `/explorer` | `/files` | Focuses VS Code's File Explorer (`workbench.view.explorer`). |
| `/search` | `/grep`, `/find` | `/search <query>` | Searches text across active workspace files via `searchFilesTool`. |
| `/diagnostics` | `/diag`, `/problems` | `/diagnostics [file-filter]` | Queries `vscode.languages.getDiagnostics` and reports detected `run` / `test` scripts. |
| `/run` | — | `/run` | Detects configured project run commands (`package.json` `scripts.start`/`dev`, Python/Rust/Go/Makefile entrypoints) without inventing scripts, and executes them in the terminal (confirmation-gated when not bypassed). |
| `/test` | — | `/test` | Detects and executes the workspace's configured test suite (`package.json` `scripts.test`, `pytest`, `cargo test`, `go test ./...`), reporting actual output and exit code. |

### Agent Team, MCP & Help Commands

| Command | Aliases | Usage | Behavior |
| --- | --- | --- | --- |
| `/agents` | — | `/agents [open]` | Lists registered Main Agent, Critic Agent, and subagents along with live orchestrator task state. |
| `/agent-create` | `/new-agent` | `/agent-create [name] [role]` | Creates a subagent directly when arguments are provided, or opens the Agents modal creation form. |
| `/agent-status` | `/status` | `/agent-status` | Reports the active orchestrator task status, subtasks progress, and running background jobs. |
| `/agent-stop` | `/stop` | `/agent-stop` | Safely cancels the currently running orchestrator task and marks active session state cancelled. |
| `/mcp` | — | `/mcp [list \| connect <name> \| disconnect <name>]` | Lists MCP servers from `McpHost` and connects or disconnects configured stdio/SSE servers. |
| `/help` | `/h`, `/?` | `/help [command]` | Dynamically reads the live `SlashCommandRegistry` to show all registered commands (including custom/plugin commands) or detailed usage, aliases, arguments, and security notes for a specific command. |

---

## Extending the Command System

### 1. Custom JSON Commands (Workspace or User)

Place `.json` command definitions in either:
- Workspace-local: `<workspace>/.localcoders/commands/<name>.json` (`source: "workspace"`)
- User-global: `~/.localcoders/commands/<name>.json` (`source: "user"`)

Supported fields:
```json
{
  "name": "build-check",
  "aliases": ["bc"],
  "description": "Run TypeScript compile check",
  "usage": "/build-check",
  "category": "Custom",
  "command": "npm run compile",
  "requiresConfirmation": true
}
```
Alternatively, supply a read-only template note via `"template": "..."` instead of `"command"`.

**Security rules for custom JSON commands:**
- Cannot override built-in commands (`overrideBuiltin` is blocked for external sources).
- Cannot declare `permissionRequirement: "elevated"`.
- Commands containing strictly prohibited patterns (`sudo`, root deletion, secret access, pipe-to-shell) are rejected by `SlashCommandRegistry`.

### 2. Programmatic Plugin / MCP Command Registration

Extensions, plugins, and MCP adapters can register commands via:

```ts
SlashCommandRegistry.getInstance().registerExternalCommand({
  name: 'mcp-lint',
  description: 'Run MCP schema validation',
  usage: '/mcp-lint',
  category: 'MCP',
  source: 'plugin', // or 'mcp'
  permissionRequirement: 'safe', // 'elevated' is rejected for non-builtin sources
  execute: async (ctx, args, parsed) => { /* ... */ }
});
```

- Built-in command names and aliases cannot be overwritten by `workspace`, `user`, `plugin`, or `mcp` sources.
- External commands cannot escalate to `'elevated'` privilege; `SlashCommandExecutor` also enforces runtime checks before executing `execute(...)`.
