import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { CriticAgent } from '../agents/critic-agent';
import { MemoryManager } from '../context/memory-manager';
import { ModelMetadata, ReasoningEffort } from '../models/types';
import { MessageQueueManager } from '../sessions/message-queue';
import { PermissionMode } from '../sessions/session-manager';
import { ToolExecutionContext } from '../tools/types';
import { inspectDiagnosticsTool, searchCodebaseTool } from '../tools/search-tools';
import { gitCommitTool, inspectGitStatusTool, readGitDiffTool } from '../tools/git-tools';
import { runCommandTool } from '../tools/terminal-tools';
import { SlashCommandRegistry } from './registry';
import { CommandContext, CommandResult, ParsedSlashCommand, SlashCommand } from './types';

const execAsync = promisify(exec);

function okResult(
  command: string,
  parsed: ParsedSlashCommand,
  title: string,
  message: string,
  extra: Partial<CommandResult> = {}
): CommandResult {
  return {
    id: `cmdres_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    command,
    rawInput: parsed.raw,
    ok: true,
    status: extra.status || 'success',
    title,
    message,
    timestamp: Date.now(),
    ...extra,
  };
}

function errResult(command: string, parsed: ParsedSlashCommand, title: string, message: string): CommandResult {
  return {
    id: `cmdres_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    command,
    rawInput: parsed.raw,
    ok: false,
    status: 'error',
    title,
    message,
    timestamp: Date.now(),
  };
}

function buildToolContext(ctx: CommandContext): ToolExecutionContext {
  return {
    workspaceRoot: ctx.workspaceRoot,
    agentId: 'slash-command',
    agentName: 'Slash Command',
    requireApproval: false,
    requestApproval: async () => false,
  };
}

export function detectConfiguredProjectCommand(
  workspaceRoot: string,
  kind: 'run' | 'test'
): { command?: string; source: string; candidates?: string[]; reason?: string } {
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
    return { source: 'none', reason: 'Workspace directory does not exist.' };
  }

  const pkgPath = path.join(workspaceRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const scripts = pkg?.scripts || {};
      if (kind === 'test') {
        const testScript = String(scripts.test || '').trim();
        if (testScript && !/no test specified/i.test(testScript)) {
          return { command: 'npm test', source: 'package.json (scripts.test)' };
        }
      } else {
        if (scripts.start && String(scripts.start).trim()) {
          return { command: 'npm start', source: 'package.json (scripts.start)' };
        }
        if (scripts.dev && String(scripts.dev).trim()) {
          return { command: 'npm run dev', source: 'package.json (scripts.dev)' };
        }
        const available = Object.keys(scripts);
        if (available.length > 0) {
          return {
            source: 'package.json',
            candidates: available.map((k) => `npm run ${k}`),
            reason: `No default 'start' or 'dev' script is configured in package.json. Available scripts: ${available.join(', ')}.`,
          };
        }
      }
    } catch {
      // Fall through to other project configs
    }
  }

  let rootEntries: string[] = [];
  try {
    rootEntries = fs.readdirSync(workspaceRoot);
  } catch {
    rootEntries = [];
  }

  if (kind === 'test') {
    const hasPyTests =
      rootEntries.some((f) => /^test_.*\.py$/i.test(f) || /_test\.py$/i.test(f)) || fs.existsSync(path.join(workspaceRoot, 'tests'));
    const hasPyProject = fs.existsSync(path.join(workspaceRoot, 'pyproject.toml')) || fs.existsSync(path.join(workspaceRoot, 'pytest.ini'));
    if (hasPyTests || hasPyProject) {
      return {
        command: fs.existsSync(path.join(workspaceRoot, 'pytest.ini')) ? 'pytest' : 'python3 -m unittest discover',
        source: hasPyProject ? 'pyproject.toml / pytest' : 'Python test discovery',
      };
    }
    if (fs.existsSync(path.join(workspaceRoot, 'Cargo.toml'))) {
      return { command: 'cargo test', source: 'Cargo.toml' };
    }
    if (fs.existsSync(path.join(workspaceRoot, 'go.mod'))) {
      return { command: 'go test ./...', source: 'go.mod' };
    }
    return { source: 'none', reason: 'No test script or test suite configuration was detected in this workspace.' };
  }

  if (fs.existsSync(path.join(workspaceRoot, 'Cargo.toml'))) {
    return { command: 'cargo run', source: 'Cargo.toml' };
  }
  if (fs.existsSync(path.join(workspaceRoot, 'go.mod'))) {
    return { command: 'go run .', source: 'go.mod' };
  }
  if (rootEntries.includes('main.py')) {
    return { command: 'python3 main.py', source: 'main.py' };
  }
  if (rootEntries.includes('app.py')) {
    return { command: 'python3 app.py', source: 'app.py' };
  }
  if (fs.existsSync(path.join(workspaceRoot, 'Makefile'))) {
    const mk = fs.readFileSync(path.join(workspaceRoot, 'Makefile'), 'utf-8');
    if (/^run:/m.test(mk)) {
      return { command: 'make run', source: 'Makefile (run target)' };
    }
  }
  return { source: 'none', reason: 'No run command or entrypoint (e.g. package.json start/dev, main.py, Cargo.toml) is configured in this workspace.' };
}

export async function compactSessionContext(ctx: CommandContext): Promise<{
  ok: boolean;
  beforeMessages: number;
  afterMessages: number;
  summaryText: string;
  preservedItems: Record<string, string>;
}> {
  const session = ctx.sessionManager.getActiveSession();
  if (!session) {
    return {
      ok: false,
      beforeMessages: 0,
      afterMessages: 0,
      summaryText: 'No active session to compact.',
      preservedItems: {},
    };
  }

  const msgs = session.messages || [];
  const beforeCount = msgs.length;
  const userPrompts = msgs.filter((m) => m.senderRole === 'user').map((m) => m.content.trim()).filter(Boolean);
  const assistantDecisions = msgs
    .filter((m) => m.senderRole === 'assistant')
    .map((m) => m.content.trim().split(/\n+/)[0] || '')
    .filter(Boolean);

  const changesSummary = await ctx.changesManager.getSummary().catch(() => ({
    totalFiles: 0,
    totalAdded: 0,
    totalRemoved: 0,
    files: [] as Array<{ path: string; status: string; added: number; removed: number }>,
  }));

  const modifiedFilesList = new Set<string>();
  for (const f of changesSummary.files || []) {
    modifiedFilesList.add(`${f.path} (${f.status}, +${f.added}/-${f.removed})`);
  }
  for (const act of session.activities || []) {
    if (act.filePath) modifiedFilesList.add(act.filePath);
  }

  const planItems = (session.plan || []).map((p) => `[${p.status}] ${p.title}: ${p.description}`);
  const toolResults = (session.activities || [])
    .filter((a) => a.category === 'command' || a.category === 'tool' || a.category === 'file')
    .slice(-12)
    .map((a) => {
      const exitStr = a.exitCode !== undefined ? ` (exit ${a.exitCode})` : '';
      const target = a.command || a.filePath || a.toolName || a.summary || a.category;
      return `- [${a.status}] ${target}${exitStr}`;
    });

  let workspaceEntries: string[] = [];
  if (ctx.workspaceRoot && fs.existsSync(ctx.workspaceRoot)) {
    try {
      workspaceEntries = fs
        .readdirSync(ctx.workspaceRoot)
        .filter((e) => e !== 'node_modules' && e !== '.git' && e !== 'dist' && e !== 'out')
        .slice(0, 20);
    } catch {}
  }

  const requirementsText =
    userPrompts.length > 0 ? userPrompts.map((p, idx) => `${idx + 1}. ${p.slice(0, 220)}`).join('\n') : session.userGoal || 'None recorded';
  const structureText =
    workspaceEntries.length > 0 ? `Root (${ctx.workspaceRoot}): ${workspaceEntries.join(', ')}` : ctx.workspaceRoot || 'No workspace';
  const decisionsText =
    assistantDecisions.length > 0 ? assistantDecisions.slice(-4).map((d) => `- ${d.slice(0, 200)}`).join('\n') : 'No prior decisions recorded';
  const filesText = modifiedFilesList.size > 0 ? Array.from(modifiedFilesList).join('\n') : 'No modified files tracked';
  const tasksText = planItems.length > 0 ? planItems.join('\n') : 'No pending tasks';
  const toolsText = toolResults.length > 0 ? toolResults.join('\n') : 'No recent tool executions';

  const summaryText = [
    '### Compacted Session Context',
    `#### User Requirements\n${requirementsText}`,
    `#### Project Structure\n${structureText}`,
    `#### Important Decisions\n${decisionsText}`,
    `#### Files Modified\n${filesText}`,
    `#### Tasks & Status\n${tasksText}`,
    `#### Tool Execution Results\n${toolsText}`,
  ].join('\n\n');

  // Preserve compacted summary plus recent tail messages (at most last 4 non-system turns) so conversation continuity holds
  const nonCompact = msgs.filter((m) => !String(m.id || '').startsWith('msg_compact_'));
  const tailKeep = nonCompact.length > 4 ? nonCompact.slice(-4) : nonCompact;
  const compactMsg = {
    id: `msg_compact_${Date.now()}`,
    senderId: 'system',
    senderName: 'Context Summary',
    senderRole: 'system' as const,
    content: summaryText,
    timestamp: Date.now(),
  };

  ctx.sessionManager.updateActiveSession((s) => {
    s.messages = [compactMsg, ...tailKeep];
  });

  if (ctx.memoryManager) {
    await ctx.memoryManager
      .appendToMemory(`Compacted session '${session.title}' (${beforeCount} -> ${tailKeep.length + 1} messages).\n${filesText}`)
      .catch(() => {});
  }

  return {
    ok: true,
    beforeMessages: beforeCount,
    afterMessages: tailKeep.length + 1,
    summaryText,
    preservedItems: {
      requirements: `${userPrompts.length} requirement(s)`,
      structure: `${workspaceEntries.length} root entries`,
      decisions: `${assistantDecisions.length} assistant note(s)`,
      filesModified: `${modifiedFilesList.size} file(s)`,
      tasks: `${planItems.length} task(s)`,
      toolResults: `${toolResults.length} recent tool result(s)`,
    },
  };
}

async function applyPermissionMode(ctx: CommandContext, mode: PermissionMode): Promise<void> {
  ctx.permissionManager.setMode(mode);
  ctx.sessionManager.updateActiveConfig((cfg) => {
    cfg.permissionMode = mode;
  });
  await ctx.ui?.persistPermissionDefault?.(mode);
  await ctx.ui?.syncSession?.();
}

function registerPermissionCommands(registry: SlashCommandRegistry): void {
  registry.register({
    name: 'bypass',
    aliases: ['bp', 'permissions-bypass'],
    description: 'Enable Bypass Permissions mode for supported tool, file, and terminal operations.',
    usage: '/bypass',
    category: 'Permissions',
    source: 'builtin',
    changesState: true,
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'shield-alert',
    securityNotes:
      'Auto-approves workspace reads, edits, safe terminal commands, and tool calls without individual prompts. Hard safety boundaries (prohibited commands, credential/secret redaction, restricted OS paths, and explicit destructive guards) remain enforced.',
    execute: async (ctx, _args, parsed) => {
      await applyPermissionMode(ctx, 'bypass');
      const summary = ctx.permissionManager.getModeSummary();
      return okResult(
        'bypass',
        parsed,
        'Permission Mode Updated',
        'Bypass mode enabled.\n\nSafe operations can now execute without individual approval.\nDestructive and protected operations remain subject to safety checks.',
        {
          changesState: true,
          details: [
            { label: 'Active Mode', value: summary.label },
            { label: 'Normalized Policy', value: summary.normalizedMode },
            { label: 'Safety Boundaries', value: 'Secrets, OS paths & destructive actions guarded' },
          ],
          warnings: [
            'Protected system paths, secret patterns, and destructive operations still require explicit confirmation.',
          ],
        }
      );
    },
  });

  registry.register({
    name: 'normal',
    aliases: ['safe', 'ask-mode'],
    description: 'Restore normal permission mode (ask before edits and commands).',
    usage: '/normal',
    category: 'Permissions',
    source: 'builtin',
    changesState: true,
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'shield',
    securityNotes: 'Allows harmless reads; requires approval before writes, terminal commands, or network actions.',
    execute: async (ctx, _args, parsed) => {
      await applyPermissionMode(ctx, 'ask');
      const summary = ctx.permissionManager.getModeSummary();
      return okResult(
        'normal',
        parsed,
        'Permission Mode Restored',
        'Normal permission mode enabled.\n\nHarmless reads stay automatic; edits and command executions ask for approval.',
        {
          changesState: true,
          details: [
            { label: 'Active Mode', value: summary.label },
            { label: 'Normalized Policy', value: summary.normalizedMode },
          ],
        }
      );
    },
  });

  registry.register({
    name: 'auto-approve',
    aliases: ['smart', 'auto'],
    description: 'Enable automatic approval for operations covered by the safe-operation policy.',
    usage: '/auto-approve',
    category: 'Permissions',
    source: 'builtin',
    changesState: true,
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'shield-check',
    securityNotes: 'Auto-approves read and safe inspection/search tools while prompting on writes and execution.',
    execute: async (ctx, _args, parsed) => {
      await applyPermissionMode(ctx, 'smart');
      const summary = ctx.permissionManager.getModeSummary();
      return okResult(
        'auto-approve',
        parsed,
        'Safe Auto-Approval Enabled',
        'Smart Approval enabled for safe inspection operations.\n\nCode edits, terminal commands, and destructive actions continue to prompt.',
        {
          changesState: true,
          details: [
            { label: 'Active Mode', value: summary.label },
            { label: 'Normalized Policy', value: summary.normalizedMode },
          ],
        }
      );
    },
  });

  registry.register({
    name: 'permissions',
    aliases: ['perm', 'security'],
    description: 'Display current permission configuration, active policy, and available modes.',
    usage: '/permissions',
    category: 'Permissions',
    source: 'builtin',
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'shield',
    execute: async (ctx, _args, parsed) => {
      const summary = ctx.permissionManager.getModeSummary();
      const historyCount = ctx.permissionManager.getAuditHistory(100).length;
      return okResult('permissions', parsed, 'Permission Configuration', summary.policy, {
        status: 'info',
        details: [
          { label: 'Current Mode', value: summary.label },
          { label: 'Raw Mode Key', value: summary.rawMode },
          { label: 'Normalized Mode', value: summary.normalizedMode },
          { label: 'Recent Audit Events', value: String(historyCount) },
          { label: 'Available Slash Commands', value: '/bypass, /auto-approve, /normal' },
        ],
      });
    },
  });
}

function registerModeCommands(registry: SlashCommandRegistry): void {
  const modeDefs: Array<{
    name: 'agent' | 'plan' | 'ask';
    aliases: string[];
    execMode: 'code' | 'plan' | 'ask';
    label: string;
    desc: string;
    detail: string;
    icon: string;
  }> = [
    {
      name: 'agent',
      aliases: ['code'],
      execMode: 'code',
      label: 'Agent Mode (Autonomous Code)',
      desc: 'Switch to Agent mode (autonomous planning, editing, tools, and terminal).',
      detail: 'Agent can plan tasks, read/modify files, execute tools & terminal commands, and track diffs.',
      icon: 'bot',
    },
    {
      name: 'plan',
      aliases: ['p'],
      execMode: 'plan',
      label: 'Plan Mode',
      desc: 'Switch to Plan mode (inspect and create structured plans without editing files).',
      detail: 'Inspects source files and creates structured implementation plans without modifying workspace files.',
      icon: 'list-checks',
    },
    {
      name: 'ask',
      aliases: ['q'],
      execMode: 'ask',
      label: 'Ask Mode',
      desc: 'Switch to Ask mode (read-only answers and code explanations).',
      detail: 'Answers questions and explains architecture without file mutations or destructive commands.',
      icon: 'message-square',
    },
  ];

  for (const m of modeDefs) {
    registry.register({
      name: m.name,
      aliases: m.aliases,
      description: m.desc,
      usage: `/${m.name} [optional task or question]`,
      category: 'Modes',
      source: 'builtin',
      changesState: true,
      permissionRequirement: 'safe',
      autoExecuteOnSelect: true,
      icon: m.icon,
      arguments: [{ name: 'prompt', description: 'Optional task or question to immediately run in this mode', required: false, type: 'string' }],
      execute: async (ctx, _args, parsed) => {
        ctx.sessionManager.updateActiveConfig((cfg) => {
          cfg.executionMode = m.execMode;
        });
        await ctx.ui?.syncSession?.();

        if (parsed.argString && ctx.ui?.submitAgentPrompt) {
          await ctx.ui.submitAgentPrompt(parsed.argString, m.execMode);
          return okResult(m.name, parsed, `Switched to ${m.label}`, `${m.detail}\nSubmitted prompt in ${m.label}.`, {
            changesState: true,
            details: [
              { label: 'Execution Mode', value: m.execMode },
              { label: 'Prompt Dispatched', value: parsed.argString.slice(0, 80) },
            ],
          });
        }

        return okResult(m.name, parsed, `Switched to ${m.label}`, m.detail, {
          changesState: true,
          details: [{ label: 'Execution Mode', value: m.execMode }],
        });
      },
    });
  }

  registry.register({
    name: 'review',
    aliases: ['critic'],
    description: 'Run code review across workspace changes with bug, security, and architecture checks.',
    usage: '/review [target file]',
    category: 'Modes',
    source: 'builtin',
    requiresWorkspace: true,
    changesState: true,
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'eye',
    arguments: [{ name: 'target', description: 'Optional file or scope note to review', required: false, type: 'string' }],
    execute: async (ctx, _args, parsed) => {
      const changes = await ctx.changesManager.getSummary();
      await ctx.ui?.switchInspectorTab?.('changes');

      if (!ctx.toolManager || !ctx.registry || !ctx.ollama) {
        return okResult('review', parsed, 'Workspace Review Inspection', `Found ${changes.totalFiles} changed file(s) ready for review.`, {
          status: 'info',
          details: [
            { label: 'Changed Files', value: String(changes.totalFiles) },
            { label: 'Diff Summary', value: `+${changes.totalAdded} / -${changes.totalRemoved}` },
          ],
          uiAction: { type: 'openChanges' },
        });
      }

      const mainCfg = ctx.registry.getMainAgent();
      const criticCfg = { ...ctx.registry.getCriticConfig() };
      const sessionCfg = ctx.sessionManager.getActiveSession()?.config;
      const reviewModel = criticCfg.model || sessionCfg?.modelId || mainCfg?.model || '';

      if (changes.totalFiles === 0 && !parsed.argString) {
        return okResult(
          'review',
          parsed,
          'Workspace Clean — Review Mode',
          'No uncommitted changes detected in git working tree. Modify files or specify a file target (`/review path/to/file`) to audit.',
          {
            status: 'info',
            details: [{ label: 'Changed Files', value: '0' }],
            uiAction: { type: 'openChanges' },
          }
        );
      }

      if (!reviewModel) {
        return okResult(
          'review',
          parsed,
          'Changes Ready for Review',
          `Detected ${changes.totalFiles} changed file(s) (+${changes.totalAdded}/-${changes.totalRemoved}). Select a model in /model to run automated Critic Agent analysis.`,
          {
            status: 'info',
            details: [
              { label: 'Changed Files', value: changes.files.map((f) => `${f.path} (${f.status})`).join(', ') || 'None' },
            ],
            uiAction: { type: 'openChanges' },
          }
        );
      }

      const mem = ctx.memoryManager || new MemoryManager(ctx.workspaceRoot);
      const critic = new CriticAgent(
        ctx.ollama,
        { ...criticCfg, model: reviewModel },
        mem,
        ctx.toolManager,
        ctx.workspaceRoot,
        ctx.orchestrator.getLLMRouter()
      );
      const report = await critic.review({
        userRequirements: parsed.argString || 'Review current workspace changes for bugs, security issues, architecture, and regressions.',
        changedFiles: changes.files.map((f) => f.path),
      });

      const findingsText =
        report.findings.length > 0
          ? report.findings
              .map(
                (f, i) =>
                  `${i + 1}. [${f.severity.toUpperCase()}] ${f.filePath}${f.lineRange ? `:${f.lineRange}` : ''}\n   ${f.explanation}\n   Fix: ${f.recommendedFix}`
              )
              .join('\n\n')
          : 'No issues reported by Critic Agent.';

      return okResult('review', parsed, `Code Review (${report.verdict.toUpperCase()})`, report.summary || 'Review finished.', {
        details: [
          { label: 'Verdict', value: report.verdict },
          { label: 'Findings', value: String(report.findings.length) },
          { label: 'Reviewed Model', value: reviewModel },
          { label: 'Changed Files', value: String(changes.totalFiles) },
        ],
        codeBlock: { language: 'text', content: findingsText },
        uiAction: { type: 'openChanges' },
      });
    },
  });
}

function registerModelCommands(registry: SlashCommandRegistry): void {
  const resolveMatchingModel = async (ctx: CommandContext, query: string): Promise<{ model?: ModelMetadata; error?: string }> => {
    const models = await ctx.modelRegistry.getAvailableModels({ includeDisabled: false, forceRefresh: false });
    if (models.length === 0) {
      return { error: 'No available models discovered. Ensure Ollama is running or configure a provider API key.' };
    }
    const q = query.trim().toLowerCase();
    const exactId = models.find((m) => m.id.toLowerCase() === q);
    if (exactId) return { model: exactId };

    const exactIdent = models.find((m) => m.modelIdentifier.toLowerCase() === q || m.displayName.toLowerCase() === q);
    if (exactIdent) return { model: exactIdent };

    const partial = models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.modelIdentifier.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q)
    );
    if (partial.length === 1) return { model: partial[0] };
    if (partial.length > 1) {
      return {
        error: `Ambiguous model '${query}'. Matches: ${partial.map((p) => p.id).join(', ')}`,
      };
    }
    return {
      error: `Model '${query}' was not found among available models. Available: ${models.map((m) => m.modelIdentifier).join(', ')}`,
    };
  };

  registry.register({
    name: 'model',
    aliases: ['m'],
    description: 'Open model selector or switch directly to an available model.',
    usage: '/model [name]',
    category: 'Models',
    source: 'builtin',
    changesState: true,
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'cpu',
    arguments: [{ name: 'name', description: 'Optional model ID or identifier (e.g. qwen3.8:27b)', required: false, type: 'model' }],
    autocompleteArgs: async (ctx, partial) => {
      const models = await ctx.modelRegistry.getAvailableModels({ includeDisabled: false });
      const q = partial.trim().toLowerCase();
      return models
        .filter((m) => !q || m.modelIdentifier.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
        .map((m) => m.modelIdentifier)
        .slice(0, 12);
    },
    execute: async (ctx, args, parsed) => {
      const query = parsed.argString.trim();
      if (!query) {
        return okResult('model', parsed, 'Model Selector', 'Opened the Model Selector interface.', {
          status: 'info',
          uiAction: { type: 'openModelSelector' },
        });
      }

      const match = await resolveMatchingModel(ctx, query);
      if (!match.model) {
        return errResult('model', parsed, 'Model Not Found', match.error || `Model '${query}' is unavailable.`);
      }

      const resolved = await ctx.modelRegistry.resolveModelForExecution(match.model.id);
      if (!resolved.ok || !resolved.model) {
        return errResult('model', parsed, 'Model Unavailable', resolved.error || `Cannot use '${match.model.id}'.`);
      }

      const m = resolved.model;
      ctx.sessionManager.updateActiveConfig((cfg) => {
        cfg.modelId = m.id;
        cfg.modelName = m.displayName;
        cfg.providerId = m.providerId;
        if (m.reasoningEffortsSupported && m.reasoningEffortsSupported.length > 0 && !m.reasoningEffortsSupported.includes(cfg.reasoningEffort)) {
          cfg.reasoningEffort = m.defaultReasoningEffort || m.reasoningEffortsSupported[0];
        }
      });
      if (ctx.registry) {
        const main = ctx.registry.getMainAgent();
        if (main) {
          ctx.registry.setMainAgent({ ...main, model: m.id });
        }
      }
      await ctx.modelRegistry.setDefaultModel(m.id);
      await ctx.ui?.syncSession?.();

      return okResult('model', parsed, 'Model Switched Successfully', `Active model updated to ${m.displayName}.`, {
        changesState: true,
        details: [
          { label: 'Provider', value: m.providerName },
          { label: 'Model', value: m.modelIdentifier },
          { label: 'Canonical ID', value: m.id },
          { label: 'Status', value: m.availability === 'running' ? 'Running' : 'Available' },
        ],
      });
    },
  });

  registry.register({
    name: 'models',
    aliases: ['ml'],
    description: 'List real available models grouped by provider (Ollama, OpenAI, Anthropic, Google, etc.).',
    usage: '/models',
    category: 'Models',
    source: 'builtin',
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'layers',
    execute: async (ctx, _args, parsed) => {
      const grouped = await ctx.modelRegistry.getGroupedModels('');
      const all = [...grouped.local, ...grouped.cloud];
      const byProvider = new Map<string, ModelMetadata[]>();
      for (const m of all) {
        const list = byProvider.get(m.providerName) || [];
        list.push(m);
        byProvider.set(m.providerName, list);
      }

      const lines: string[] = [];
      for (const p of grouped.providers) {
        const list = byProvider.get(p.providerName) || [];
        lines.push(`${p.providerName} (${p.category}, ${p.status}): ${list.length} model(s)`);
        if (list.length === 0) {
          lines.push(`  - ${p.error || 'No enabled models discovered'}`);
        } else {
          for (const m of list) {
            const ctxInfo = m.contextWindow ? `, ctx=${m.contextWindow}` : '';
            lines.push(`  - ${m.modelIdentifier} [${m.availability}${ctxInfo}]`);
          }
        }
      }

      return okResult('models', parsed, 'Available Models by Provider', `Discovered ${all.length} active model(s) across ${grouped.providers.length} provider(s).`, {
        status: 'info',
        details: [
          { label: 'Local Models', value: String(grouped.local.length) },
          { label: 'Cloud Models', value: String(grouped.cloud.length) },
        ],
        codeBlock: { language: 'text', content: lines.join('\n') || 'No providers configured.' },
      });
    },
  });

  registry.register({
    name: 'model-info',
    aliases: ['mi'],
    description: 'Inspect verified capabilities, provider, context window, and reasoning support of active model.',
    usage: '/model-info [model-name]',
    category: 'Models',
    source: 'builtin',
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'cpu',
    arguments: [{ name: 'name', description: 'Optional model identifier to inspect', required: false, type: 'model' }],
    execute: async (ctx, _args, parsed) => {
      const session = ctx.sessionManager.getActiveSession();
      const targetId = parsed.argString.trim() || session?.config?.modelId || ctx.modelRegistry.getDefaultModelId() || '';
      if (!targetId) {
        return errResult('model-info', parsed, 'No Active Model', 'No model is currently selected. Run `/models` or `/model <name>`.');
      }

      const m = await ctx.modelRegistry.getModelById(targetId);
      if (!m) {
        return errResult('model-info', parsed, 'Model Not Found', `Could not resolve metadata for '${targetId}'.`);
      }

      const caps = Object.entries(m.capabilities || {})
        .filter(([, v]) => v === true)
        .map(([k]) => k)
        .join(', ');
      const reasoning = m.reasoningEffortsSupported?.length
        ? m.reasoningEffortsSupported.join(', ')
        : m.capabilities?.reasoning
          ? 'Supported (effort levels unreported)'
          : 'Not exposed by provider';

      return okResult('model-info', parsed, `Model Info: ${m.displayName}`, `Verified metadata from ${m.providerName}.`, {
        status: 'info',
        details: [
          { label: 'Model', value: m.modelIdentifier },
          { label: 'Provider', value: `${m.providerName} (${m.providerType})` },
          { label: 'Availability', value: m.availability },
          { label: 'Context Window', value: m.contextWindow ? String(m.contextWindow) : 'Unknown' },
          { label: 'Capabilities', value: caps || 'Unknown' },
          { label: 'Reasoning Support', value: reasoning },
        ],
      });
    },
  });

  registry.register({
    name: 'reasoning',
    aliases: ['effort', 'think'],
    description: 'View or update supported reasoning effort for the active model.',
    usage: '/reasoning [minimal|low|medium|high|extra_high]',
    category: 'Models',
    source: 'builtin',
    changesState: true,
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'brain',
    arguments: [
      {
        name: 'level',
        description: 'Reasoning effort level',
        required: false,
        type: 'enum',
        values: ['minimal', 'low', 'medium', 'high', 'extra_high'],
      },
    ],
    autocompleteArgs: async (ctx, partial) => {
      const session = ctx.sessionManager.getActiveSession();
      const modelId = session?.config?.modelId || ctx.modelRegistry.getDefaultModelId() || '';
      const model = modelId ? await ctx.modelRegistry.getModelById(modelId) : undefined;
      const supported = model?.reasoningEffortsSupported || ['minimal', 'low', 'medium', 'high', 'extra_high'];
      const q = partial.trim().toLowerCase();
      return supported.filter((lvl) => !q || lvl.includes(q));
    },
    execute: async (ctx, args, parsed) => {
      const session = ctx.sessionManager.getActiveSession();
      const modelId = session?.config?.modelId || ctx.modelRegistry.getDefaultModelId() || '';
      const model = modelId ? await ctx.modelRegistry.getModelById(modelId) : undefined;
      if (!model) {
        return errResult('reasoning', parsed, 'No Active Model', 'Select a model first before configuring reasoning effort.');
      }

      const supported = model.reasoningEffortsSupported || [];
      const current = session?.config?.reasoningEffort || model.defaultReasoningEffort || 'medium';

      if (args.length === 0) {
        return okResult(
          'reasoning',
          parsed,
          'Reasoning Effort Settings',
          supported.length > 0
            ? `Active effort: '${current}'. Supported levels for ${model.displayName}: ${supported.join(', ')}.`
            : `${model.displayName} (${model.providerName}) does not expose configurable reasoning effort levels.`,
          {
            status: 'info',
            details: [
              { label: 'Active Model', value: model.displayName },
              { label: 'Current Effort', value: supported.length > 0 ? current : 'Unsupported' },
              { label: 'Supported Levels', value: supported.length > 0 ? supported.join(', ') : 'None exposed' },
            ],
          }
        );
      }

      if (supported.length === 0) {
        return errResult(
          'reasoning',
          parsed,
          'Reasoning Effort Unsupported',
          `${model.displayName} (${model.providerName}) does not expose configurable reasoning effort levels.`
        );
      }

      const rawLevel = args[0].toLowerCase();
      const normalizedLevel = (rawLevel === 'xhigh' ? 'extra_high' : rawLevel) as ReasoningEffort;
      if (!supported.includes(normalizedLevel)) {
        return errResult(
          'reasoning',
          parsed,
          'Unsupported Reasoning Level',
          `Level '${args[0]}' is not supported by ${model.displayName}. Supported levels: ${supported.join(', ')}.`
        );
      }

      ctx.sessionManager.updateActiveConfig((cfg) => {
        cfg.reasoningEffort = normalizedLevel;
      });
      await ctx.ui?.syncSession?.();

      return okResult('reasoning', parsed, 'Reasoning Effort Updated', `Set reasoning effort to '${normalizedLevel}' for ${model.displayName}.`, {
        changesState: true,
        details: [
          { label: 'Model', value: model.displayName },
          { label: 'Reasoning Effort', value: normalizedLevel },
        ],
      });
    },
  });
}

function registerSessionCommands(registry: SlashCommandRegistry): void {
  registry.register({
    name: 'new',
    aliases: ['n'],
    description: 'Create a new independent conversation session.',
    usage: '/new [session title]',
    category: 'Sessions',
    source: 'builtin',
    changesState: true,
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'plus',
    arguments: [{ name: 'title', description: 'Optional session title', required: false, type: 'string' }],
    execute: async (ctx, _args, parsed) => {
      const first = await ctx.modelRegistry.getDefaultOrFirstAvailableModel();
      const title = parsed.argString.trim() || 'New Section';
      const created = ctx.sessionManager.createSession(title, first?.id || '', {
        providerId: first?.providerId || 'ollama',
        modelId: first?.id || '',
        modelName: first?.displayName || '',
        permissionMode: ctx.permissionManager.getNormalizedMode(),
      });
      ctx.ui?.updateTitle?.();
      await ctx.ui?.syncSession?.();
      return okResult('new', parsed, 'New Session Created', `Started session '${created.title}'.`, {
        changesState: true,
        details: [
          { label: 'Session ID', value: created.id },
          { label: 'Title', value: created.title },
          { label: 'Model', value: first?.displayName || 'Unselected' },
        ],
      });
    },
  });

  registry.register({
    name: 'clear',
    aliases: ['cls'],
    description: 'Clear messages, plan, and activity history in the active session.',
    usage: '/clear',
    category: 'Sessions',
    source: 'builtin',
    changesState: true,
    requiresConfirmation: true,
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'trash-2',
    execute: async (ctx, _args, parsed) => {
      const active = ctx.sessionManager.getActiveSession();
      if (!active) {
        return errResult('clear', parsed, 'No Active Session', 'There is no active session to clear.');
      }
      const hasData = (active.messages?.length || 0) > 0 || (active.activities?.length || 0) > 0 || (active.plan?.length || 0) > 0;
      if (hasData && !ctx.confirmed) {
        return {
          id: `cmdres_${Date.now()}`,
          command: 'clear',
          rawInput: parsed.raw,
          ok: false,
          status: 'confirmation_required',
          title: 'Confirm Clear Session',
          message: `Clear ${(active.messages?.length || 0)} message(s) and ${(active.activities?.length || 0)} activity item(s) in '${active.title}'? This cannot be undone.`,
          confirmPrompt: {
            commandLine: '/clear',
            title: `Clear '${active.title}'?`,
            detail: 'Permanently clears conversation history, execution plan, and activity log for the active session.',
            confirmLabel: 'Clear Session',
          },
          timestamp: Date.now(),
        };
      }

      ctx.sessionManager.updateActiveSession((s) => {
        s.messages = [];
        s.plan = [];
        s.planExplicit = false;
        s.executionGroups = [];
        s.activities = [];
        s.commandResults = [];
        s.status = 'idle';
        s.activePhase = undefined;
        s.activePhaseSummary = '';
      });
      await ctx.ui?.syncSession?.();
      return okResult('clear', parsed, 'Session Cleared', `Cleared conversation history for '${active.title}'.`, {
        changesState: true,
      });
    },
  });

  registry.register({
    name: 'sessions',
    aliases: ['ss'],
    description: 'List all saved conversation sessions and active session metadata.',
    usage: '/sessions [switch <id|name>]',
    category: 'Sessions',
    source: 'builtin',
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'message-square',
    execute: async (ctx, args, parsed) => {
      const all = ctx.sessionManager.getAllSessions();
      const active = ctx.sessionManager.getActiveSession();
      if (args[0] === 'switch' && args.slice(1).length > 0) {
        const q = args.slice(1).join(' ').toLowerCase();
        const found = all.find((s) => s.id === args[1] || s.title.toLowerCase().includes(q));
        if (!found) {
          return errResult('sessions', parsed, 'Session Not Found', `No session matched '${args.slice(1).join(' ')}'.`);
        }
        ctx.sessionManager.switchSession(found.id);
        ctx.ui?.updateTitle?.();
        await ctx.ui?.syncSession?.();
        return okResult('sessions', parsed, 'Session Switched', `Switched to '${found.title}'.`, { changesState: true });
      }

      const lines = all.map(
        (s) => `${s.id === active?.id ? '* ' : '  '}${s.title} [${s.id}] · ${s.messages?.length || 0} msg(s) · ${s.status}`
      );
      return okResult('sessions', parsed, `Sessions (${all.length})`, active ? `Active: ${active.title}` : 'No active session selected.', {
        status: 'info',
        details: [
          { label: 'Total Sessions', value: String(all.length) },
          { label: 'Active Session', value: active ? active.title : 'None' },
        ],
        codeBlock: { language: 'text', content: lines.join('\n') || 'No sessions yet.' },
        uiAction: { type: 'focusSessions' },
      });
    },
  });

  registry.register({
    name: 'rename',
    description: 'Rename the active conversation session.',
    usage: '/rename <new-name>',
    category: 'Sessions',
    source: 'builtin',
    changesState: true,
    permissionRequirement: 'safe',
    icon: 'pencil',
    arguments: [{ name: 'name', description: 'New session title', required: true, type: 'string' }],
    execute: async (ctx, _args, parsed) => {
      const active = ctx.sessionManager.getActiveSession();
      if (!active) {
        return errResult('rename', parsed, 'No Active Session', 'Create or select a session first.');
      }
      const nextName = parsed.argString.trim();
      const prevName = active.title;
      ctx.sessionManager.renameSession(active.id, nextName);
      ctx.ui?.updateTitle?.();
      await ctx.ui?.syncSession?.();
      return okResult('rename', parsed, 'Session Renamed', `Renamed '${prevName}' to '${nextName}'.`, {
        changesState: true,
        details: [
          { label: 'Previous Title', value: prevName },
          { label: 'New Title', value: nextName },
        ],
      });
    },
  });

  registry.register({
    name: 'delete-session',
    aliases: ['del-session'],
    description: 'Delete the active session after confirmation.',
    usage: '/delete-session',
    category: 'Sessions',
    source: 'builtin',
    changesState: true,
    requiresConfirmation: true,
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'trash-2',
    execute: async (ctx, _args, parsed) => {
      const active = ctx.sessionManager.getActiveSession();
      if (!active) {
        return errResult('delete-session', parsed, 'No Active Session', 'There is no active session to delete.');
      }
      if (!ctx.confirmed) {
        return {
          id: `cmdres_${Date.now()}`,
          command: 'delete-session',
          rawInput: parsed.raw,
          ok: false,
          status: 'confirmation_required',
          title: 'Confirm Delete Session',
          message: `Permanently delete session '${active.title}' (${active.id})?`,
          confirmPrompt: {
            commandLine: '/delete-session',
            title: `Delete '${active.title}'?`,
            detail: 'This removes the saved session file permanently.',
            confirmLabel: 'Delete Session',
          },
          timestamp: Date.now(),
        };
      }
      const deletedTitle = active.title;
      ctx.sessionManager.deleteSession(active.id);
      ctx.ui?.updateTitle?.();
      await ctx.ui?.syncSession?.();
      const next = ctx.sessionManager.getActiveSession();
      return okResult('delete-session', parsed, 'Session Deleted', `Deleted session '${deletedTitle}'.`, {
        changesState: true,
        details: [{ label: 'Next Active Session', value: next ? next.title : 'None' }],
      });
    },
  });

  registry.register({
    name: 'export',
    aliases: ['save'],
    description: 'Export the active conversation, plan, and activity log to Markdown or JSON.',
    usage: '/export [md|json]',
    category: 'Sessions',
    source: 'builtin',
    permissionRequirement: 'workspace_write',
    autoExecuteOnSelect: true,
    icon: 'file-text',
    arguments: [{ name: 'format', description: 'Export format: md or json', required: false, type: 'enum', values: ['md', 'json'] }],
    validate: (_ctx, parsed) => {
      if (parsed.args[0] && !['md', 'markdown', 'json'].includes(parsed.args[0].toLowerCase())) {
        return { ok: false, error: `Unsupported export format '${parsed.args[0]}'. Use 'md' or 'json'.` };
      }
      return { ok: true };
    },
    execute: async (ctx, args, parsed) => {
      const active = ctx.sessionManager.getActiveSession();
      if (!active) {
        return errResult('export', parsed, 'No Active Session', 'There is no active session to export.');
      }
      const rawFmt = (args[0] || 'md').toLowerCase();
      const ext = rawFmt === 'json' ? 'json' : 'md';
      const baseDir = ctx.workspaceRoot && fs.existsSync(ctx.workspaceRoot) ? ctx.workspaceRoot : '/tmp';
      const exportDir = path.join(baseDir, '.localcoders', 'exports');
      fs.mkdirSync(exportDir, { recursive: true });
      const slug = (active.title || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'session';
      const outPath = path.join(exportDir, `${slug}-${Date.now()}.${ext}`);

      if (ext === 'json') {
        fs.writeFileSync(outPath, JSON.stringify(active, null, 2), 'utf-8');
      } else {
        const mdLines: string[] = [
          `# Session: ${active.title}`,
          `- ID: ${active.id}`,
          `- Workspace: ${active.workspaceRoot}`,
          `- Model: ${active.config?.modelId || active.model || 'unselected'}`,
          `- Status: ${active.status}`,
          '',
          '## Conversation',
          ...(active.messages || []).map((m) => `### ${m.senderName} (${m.senderRole})\n${m.content}\n`),
        ];
        if (active.plan && active.plan.length > 0) {
          mdLines.push('## Plan', ...active.plan.map((p, i) => `${i + 1}. [${p.status}] ${p.title}: ${p.description}`), '');
        }
        fs.writeFileSync(outPath, mdLines.join('\n'), 'utf-8');
      }

      return okResult('export', parsed, 'Conversation Exported', `Saved session export to ${outPath}.`, {
        details: [
          { label: 'Format', value: ext.toUpperCase() },
          { label: 'File Path', value: outPath },
          { label: 'Messages Exported', value: String(active.messages?.length || 0) },
        ],
      });
    },
  });

  registry.register({
    name: 'compact',
    description: 'Compact conversation context while preserving requirements, structure, decisions, files, tasks, and tool results.',
    usage: '/compact',
    category: 'Sessions',
    source: 'builtin',
    changesState: true,
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'layers',
    execute: async (ctx, _args, parsed) => {
      const outcome = await compactSessionContext(ctx);
      if (!outcome.ok) {
        return errResult('compact', parsed, 'Compaction Failed', outcome.summaryText);
      }
      await ctx.ui?.syncSession?.();
      return okResult('compact', parsed, 'Context Compacted', `Compacted session history from ${outcome.beforeMessages} to ${outcome.afterMessages} entry(s).`, {
        changesState: true,
        details: [
          { label: 'User Requirements', value: outcome.preservedItems.requirements || '0' },
          { label: 'Project Structure', value: outcome.preservedItems.structure || '0' },
          { label: 'Files Modified', value: outcome.preservedItems.filesModified || '0' },
          { label: 'Tasks', value: outcome.preservedItems.tasks || '0' },
          { label: 'Tool Results', value: outcome.preservedItems.toolResults || '0' },
        ],
        codeBlock: { language: 'markdown', content: outcome.summaryText },
      });
    },
  });
}

function registerWorkspaceCommands(registry: SlashCommandRegistry): void {
  registry.register({
    name: 'undo',
    aliases: ['z'],
    description: 'Undo the last recorded workspace file modification.',
    usage: '/undo',
    category: 'Workspace',
    source: 'builtin',
    requiresWorkspace: true,
    changesState: true,
    permissionRequirement: 'workspace_write',
    autoExecuteOnSelect: true,
    icon: 'rotate-ccw',
    execute: async (ctx, _args, parsed) => {
      const outcome = ctx.historyManager.undo(ctx.workspaceRoot);
      if (!outcome.ok) {
        return errResult('undo', parsed, 'Nothing to Undo', outcome.message);
      }
      await ctx.changesManager.refresh?.();
      await ctx.ui?.syncSession?.();
      return okResult('undo', parsed, 'Operation Undone', outcome.message, {
        changesState: true,
        details: [
          { label: 'Remaining Undo', value: String(outcome.remainingUndo) },
          { label: 'Available Redo', value: String(outcome.remainingRedo) },
        ],
      });
    },
  });

  registry.register({
    name: 'redo',
    aliases: ['y'],
    description: 'Redo the last undone workspace file modification.',
    usage: '/redo',
    category: 'Workspace',
    source: 'builtin',
    requiresWorkspace: true,
    changesState: true,
    permissionRequirement: 'workspace_write',
    autoExecuteOnSelect: true,
    icon: 'refresh-cw',
    execute: async (ctx, _args, parsed) => {
      const outcome = ctx.historyManager.redo(ctx.workspaceRoot);
      if (!outcome.ok) {
        return errResult('redo', parsed, 'Nothing to Redo', outcome.message);
      }
      await ctx.changesManager.refresh?.();
      await ctx.ui?.syncSession?.();
      return okResult('redo', parsed, 'Operation Redone', outcome.message, {
        changesState: true,
        details: [
          { label: 'Remaining Undo', value: String(outcome.remainingUndo) },
          { label: 'Remaining Redo', value: String(outcome.remainingRedo) },
        ],
      });
    },
  });

  registry.register({
    name: 'terminal',
    aliases: ['term'],
    description: 'Open or focus the integrated workspace terminal.',
    usage: '/terminal [optional command]',
    category: 'Workspace',
    source: 'builtin',
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'terminal',
    arguments: [{ name: 'cmd', description: 'Optional command to run immediately in terminal tab', required: false, type: 'string' }],
    execute: async (ctx, _args, parsed) => {
      const tab = ctx.terminalManager.ensureDefaultTab(ctx.workspaceRoot);
      ctx.ui?.switchInspectorTab?.('terminal');
      if (ctx.viewMode === 'ide') {
        try {
          vscode.commands.executeCommand('workbench.action.terminal.focus');
        } catch {}
      }
      if (parsed.argString.trim()) {
        if (ctx.permissionManager.isStrictlyProhibited(parsed.argString)) {
          return errResult('terminal', parsed, 'Blocked by Safety Policy', 'Command matches prohibited system/secret access patterns.');
        }
        ctx.terminalManager.runCommand(tab.id, parsed.argString.trim());
      }
      return okResult(
        'terminal',
        parsed,
        'Terminal Ready',
        parsed.argString.trim() ? `Executed '${parsed.argString.trim()}' in ${tab.name}.` : `Focused ${tab.name} (${tab.cwd}).`,
        {
          status: 'info',
          details: [
            { label: 'Terminal Tab', value: tab.name },
            { label: 'Working Directory', value: tab.cwd },
          ],
          uiAction: { type: 'openTerminal' },
        }
      );
    },
  });

  registry.register({
    name: 'git',
    description: 'Inspect Git status, diff, or create validated commits.',
    usage: '/git <status|diff|commit <message>>',
    category: 'Workspace',
    source: 'builtin',
    requiresWorkspace: true,
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'git-branch',
    subcommands: [
      { name: 'status', description: 'Show real working tree Git status', usage: '/git status' },
      { name: 'diff', description: 'Show real Git diff of workspace changes', usage: '/git diff' },
      {
        name: 'commit',
        description: 'Validate changes and create a Git commit',
        usage: '/git commit "<message>"',
        requiresConfirmation: true,
        arguments: [{ name: 'message', description: 'Commit message', required: true, type: 'string' }],
      },
    ],
    autocompleteArgs: (_ctx, partial) => {
      const subs = ['status', 'diff', 'commit'];
      const q = partial.trim().toLowerCase();
      return subs.filter((s) => !q || s.startsWith(q));
    },
    execute: async (ctx, args, parsed) => {
      const toolCtx = buildToolContext(ctx);
      const sub = (args[0] || '').toLowerCase();

      if (!sub) {
        const st = await inspectGitStatusTool({}, toolCtx);
        if (!st.success) {
          return errResult('git', parsed, 'Git Unavailable', st.error || 'Workspace is not a Git repository.');
        }
        return okResult('git', parsed, 'Git Workspace Overview', 'Available subcommands: `/git status`, `/git diff`, `/git commit "<message>"`.', {
          status: 'info',
          details: [
            { label: 'Branch', value: st.output.branch },
            { label: 'Staged', value: String(st.output.staged.length) },
            { label: 'Modified', value: String(st.output.modified.length) },
            { label: 'Untracked', value: String(st.output.untracked.length) },
          ],
        });
      }

      if (sub === 'status') {
        const res = await inspectGitStatusTool({}, toolCtx);
        if (!res.success) {
          return errResult('git', parsed, 'Git Status Failed', res.error || 'Could not inspect git status.');
        }
        const out = res.output;
        const block = [
          `Branch: ${out.branch}`,
          `Staged (${out.staged.length}): ${out.staged.join(', ') || 'none'}`,
          `Modified (${out.modified.length}): ${out.modified.join(', ') || 'none'}`,
          `Untracked (${out.untracked.length}): ${out.untracked.join(', ') || 'none'}`,
        ].join('\n');
        return okResult('git', parsed, `Git Status (${out.branch})`, `${out.totalChanged} total changed file(s).`, {
          status: 'info',
          details: [
            { label: 'Branch', value: out.branch },
            { label: 'Total Changed', value: String(out.totalChanged) },
          ],
          codeBlock: { language: 'text', content: block },
        });
      }

      if (sub === 'diff') {
        const res = await readGitDiffTool({ path: args[1] }, toolCtx);
        if (!res.success) {
          return errResult('git', parsed, 'Git Diff Failed', res.error || 'Could not read git diff.');
        }
        const diffText = String(res.output?.diff || '');
        const clipped = diffText.length > 12000 ? diffText.slice(0, 12000) + '\n... (diff truncated at 12KB)' : diffText;
        return okResult('git', parsed, 'Workspace Git Diff', diffText === 'No changes detected in working tree.' ? diffText : 'Current uncommitted diff:', {
          status: 'info',
          codeBlock: { language: 'diff', content: clipped },
        });
      }

      if (sub === 'commit') {
        const message = args.slice(1).join(' ').trim();
        if (!message) {
          return errResult('git', parsed, 'Missing Commit Message', 'Usage: `/git commit "<message>"`');
        }
        const statusRes = await inspectGitStatusTool({}, toolCtx);
        if (!statusRes.success) {
          return errResult('git', parsed, 'Git Error', statusRes.error || 'Failed to validate git repository.');
        }
        const st = statusRes.output;
        if (st.totalChanged === 0) {
          return errResult('git', parsed, 'Working Tree Clean', 'No staged, modified, or untracked changes to commit.');
        }
        const stageAll = st.staged.length === 0;
        const commitRes = await gitCommitTool({ message, stageAll }, toolCtx);
        if (!commitRes.success) {
          return errResult('git', parsed, 'Git Commit Failed', commitRes.error || 'Commit failed.');
        }
        await ctx.changesManager.refresh?.();
        return okResult('git', parsed, 'Git Commit Created', `Committed changes on '${st.branch}'.`, {
          changesState: true,
          details: [
            { label: 'Branch', value: st.branch },
            { label: 'Message', value: message },
          ],
          codeBlock: { language: 'text', content: String(commitRes.output?.summary || '') },
        });
      }

      return errResult('git', parsed, 'Unknown Git Subcommand', `Unsupported subcommand '${sub}'. Use \`status\`, \`diff\`, or \`commit "<message>"\`.`);
    },
  });

  registry.register({
    name: 'files',
    aliases: ['fs', 'explorer'],
    description: 'Open file explorer or inspect workspace files.',
    usage: '/files [subdir]',
    category: 'Workspace',
    source: 'builtin',
    requiresWorkspace: true,
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'folder-open',
    arguments: [{ name: 'path', description: 'Optional relative subdirectory', required: false, type: 'string' }],
    execute: async (ctx, args, parsed) => {
      if (ctx.viewMode === 'ide') {
        try {
          await vscode.commands.executeCommand('workbench.view.explorer');
        } catch {}
      }
      const targetRel = args[0] || '';
      const targetAbs = path.resolve(ctx.workspaceRoot, targetRel);
      const relCheck = path.relative(ctx.workspaceRoot, targetAbs);
      if (relCheck.startsWith('..') && !path.isAbsolute(relCheck)) {
        return errResult('files', parsed, 'Security Boundary Violation', `Path '${targetRel}' escapes the workspace root.`);
      }
      if (!fs.existsSync(targetAbs)) {
        return errResult('files', parsed, 'Directory Not Found', `Path does not exist: ${targetAbs}`);
      }
      const entries = fs
        .readdirSync(targetAbs, { withFileTypes: true })
        .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .slice(0, 60)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));

      await ctx.ui?.openFilesExplorerOrPicker?.(ctx.workspaceRoot);

      return okResult('files', parsed, 'Workspace Files', `Listed ${entries.length} entry(s) in ${targetRel || path.basename(ctx.workspaceRoot)}.`, {
        status: 'info',
        details: [{ label: 'Directory', value: targetAbs }],
        codeBlock: { language: 'text', content: entries.join('\n') || '(empty directory)' },
      });
    },
  });

  registry.register({
    name: 'search',
    aliases: ['find', 'grep'],
    description: 'Search across the active workspace files and line numbers.',
    usage: '/search <query>',
    category: 'Workspace',
    source: 'builtin',
    requiresWorkspace: true,
    permissionRequirement: 'safe',
    icon: 'search',
    arguments: [{ name: 'query', description: 'Search text or pattern', required: true, type: 'string' }],
    execute: async (ctx, _args, parsed) => {
      const toolCtx = buildToolContext(ctx);
      const res = await searchCodebaseTool({ query: parsed.argString }, toolCtx);
      if (!res.success) {
        return errResult('search', parsed, 'Search Failed', res.error || 'Workspace search failed.');
      }
      const matches: Array<{ file: string; line: number; text: string }> =
        res.output?.results || res.output?.matches || [];
      const content =
        matches.length > 0
          ? matches.slice(0, 40).map((m) => `${m.file}:${m.line}: ${m.text}`).join('\n')
          : `No matches found for '${parsed.argString}'.`;

      return okResult('search', parsed, `Search Results: '${parsed.argString}'`, `Found ${matches.length} matching line(s).`, {
        status: 'info',
        details: [
          { label: 'Workspace', value: ctx.workspaceRoot },
          { label: 'Match Count', value: String(matches.length) },
        ],
        codeBlock: { language: 'text', content },
      });
    },
  });

  registry.register({
    name: 'diagnostics',
    aliases: ['diag', 'problems'],
    description: 'Display VS Code workspace errors, warnings, and project runtime diagnostics.',
    usage: '/diagnostics [file-filter]',
    category: 'Workspace',
    source: 'builtin',
    requiresWorkspace: true,
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'triangle-alert',
    execute: async (ctx, args, parsed) => {
      let diagOut: any = { totalDiagnostics: 0, errors: 0, warnings: 0, diagnostics: [] };
      if (vscode.languages && typeof vscode.languages.getDiagnostics === 'function') {
        const res = await inspectDiagnosticsTool({ path: args[0] }, buildToolContext(ctx));
        if (res.success && res.output) diagOut = res.output;
      }

      const detectedTest = detectConfiguredProjectCommand(ctx.workspaceRoot, 'test');
      const detectedRun = detectConfiguredProjectCommand(ctx.workspaceRoot, 'run');
      const lines = (diagOut.diagnostics || []).map(
        (d: any) => `[${d.severity}] ${d.file}:${d.line} — ${d.message}`
      );

      return okResult(
        'diagnostics',
        parsed,
        'Project Diagnostics',
        `${diagOut.errors} error(s), ${diagOut.warnings} warning(s) across ${diagOut.totalDiagnostics} diagnostic(s).`,
        {
          status: 'info',
          details: [
            { label: 'Errors', value: String(diagOut.errors) },
            { label: 'Warnings', value: String(diagOut.warnings) },
            { label: 'Run Script', value: detectedRun.command || 'Not configured' },
            { label: 'Test Suite', value: detectedTest.command || 'Not configured' },
          ],
          codeBlock: lines.length > 0 ? { language: 'text', content: lines.join('\n') } : undefined,
        }
      );
    },
  });

  registry.register({
    name: 'run',
    description: 'Detect and execute the project’s configured run command without inventing scripts.',
    usage: '/run',
    category: 'Workspace',
    source: 'builtin',
    requiresWorkspace: true,
    requiresConfirmation: true,
    permissionRequirement: 'workspace_write',
    autoExecuteOnSelect: true,
    icon: 'play',
    execute: async (ctx, _args, parsed) => {
      const detected = detectConfiguredProjectCommand(ctx.workspaceRoot, 'run');
      if (!detected.command) {
        return errResult(
          'run',
          parsed,
          'No Configured Run Command',
          detected.reason || 'Configure `scripts.start` in package.json or provide a project entrypoint, then re-run.'
        );
      }

      const tab = ctx.terminalManager.ensureDefaultTab(ctx.workspaceRoot);
      ctx.ui?.switchInspectorTab?.('terminal');
      ctx.terminalManager.runCommand(tab.id, detected.command);

      return okResult('run', parsed, 'Project Run Started', `Executing '${detected.command}' (from ${detected.source}) in ${tab.name}.`, {
        details: [
          { label: 'Command', value: detected.command },
          { label: 'Source', value: detected.source },
          { label: 'Terminal Tab', value: tab.name },
        ],
        uiAction: { type: 'openTerminal' },
      });
    },
  });

  registry.register({
    name: 'test',
    description: 'Run the project’s configured test suite and report real exit status & output.',
    usage: '/test',
    category: 'Workspace',
    source: 'builtin',
    requiresWorkspace: true,
    permissionRequirement: 'workspace_write',
    autoExecuteOnSelect: true,
    icon: 'check',
    execute: async (ctx, _args, parsed) => {
      const detected = detectConfiguredProjectCommand(ctx.workspaceRoot, 'test');
      if (!detected.command) {
        return errResult('test', parsed, 'No Test Suite Configured', detected.reason || 'Could not find a configured test command.');
      }

      const toolCtx = buildToolContext(ctx);
      const res = await runCommandTool({ command: detected.command, timeoutMs: 60000 }, toolCtx);
      const out = res.output || {};
      const exitCode = out.exitCode ?? (res.success ? 0 : 1);
      const combined = [out.stdout, out.stderr, res.error].filter(Boolean).join('\n').trim();
      const clipped = combined.length > 10000 ? combined.slice(-10000) : combined;

      return {
        id: `cmdres_${Date.now()}`,
        command: 'test',
        rawInput: parsed.raw,
        ok: res.success,
        status: res.success ? 'success' : 'error',
        title: res.success ? 'Test Suite Passed' : `Test Suite Failed (Exit ${exitCode})`,
        message: `Executed \`${detected.command}\` (${detected.source})`,
        details: [
          { label: 'Command', value: detected.command },
          { label: 'Exit Code', value: String(exitCode) },
          { label: 'Source', value: detected.source },
        ],
        codeBlock: { language: 'text', content: clipped || '(no test output)' },
        timestamp: Date.now(),
      };
    },
  });
}

function registerAgentMcpCommands(registry: SlashCommandRegistry): void {
  registry.register({
    name: 'agents',
    description: 'Display registered Main Agent, Critic Agent, and subagents along with live status.',
    usage: '/agents [open]',
    category: 'Agents & MCP',
    source: 'builtin',
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'users',
    execute: async (ctx, args, parsed) => {
      const main = ctx.registry?.getMainAgent();
      const critic = ctx.registry?.getCriticConfig();
      const subs = ctx.registry?.getSubagents() || [];
      const currentTask = ctx.orchestrator.getCurrentTask();

      if (args[0] === 'open') {
        await ctx.ui?.openCockpitModal?.('agents');
      }

      const lines = [
        `Main Agent: ${main ? `${main.name} (${main.model || 'active session model'}) [${main.enabled ? 'enabled' : 'disabled'}]` : 'Not configured'}`,
        `Critic Agent: ${critic?.enabled ? `Enabled (${critic.strictness})` : 'Disabled'}`,
        `Subagents (${subs.length}):`,
        ...(subs.length > 0 ? subs.map((s) => `  - ${s.name} (${s.role}) -> ${s.model || 'default'}`) : ['  - None registered']),
      ];

      return okResult('agents', parsed, 'Registered Agents', `Current task status: ${currentTask?.status || 'idle'}.`, {
        status: 'info',
        details: [
          { label: 'Main Agent', value: main?.name || 'Unconfigured' },
          { label: 'Subagents', value: String(subs.length) },
          { label: 'Critic', value: critic?.enabled ? 'Enabled' : 'Disabled' },
          { label: 'Task State', value: currentTask?.status || 'idle' },
        ],
        codeBlock: { language: 'text', content: lines.join('\n') },
      });
    },
  });

  registry.register({
    name: 'agent-create',
    aliases: ['create-agent'],
    description: 'Open agent creation modal or register a new subagent with name and role.',
    usage: '/agent-create [<name> <role>]',
    category: 'Agents & MCP',
    source: 'builtin',
    changesState: true,
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'bot',
    arguments: [
      { name: 'name', description: 'Optional subagent name', required: false, type: 'string' },
      { name: 'role', description: 'Optional predefined role', required: false, type: 'string' },
    ],
    execute: async (ctx, args, parsed) => {
      if (args.length >= 1 && ctx.registry) {
        const name = args[0].trim();
        const roleInput = args.slice(1).join(' ').trim() || 'Backend Developer';
        const roles = (ctx.registry.constructor as any).getPredefinedRoles?.() || [];
        const matchedRole = roles.find((r: any) => r.role.toLowerCase() === roleInput.toLowerCase());
        const sessionModel = ctx.sessionManager.getActiveSession()?.config?.modelId || ctx.registry.getMainAgent()?.model || '';
        const newSub = {
          id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name,
          role: (matchedRole?.role || roleInput) as any,
          model: sessionModel,
          systemPrompt: matchedRole?.defaultPrompt || `You are ${name}, specializing in ${roleInput}.`,
          enabled: true,
          maxConcurrency: 1,
          temperature: 0.2,
          contextWindow: 32768,
        };
        ctx.registry.addSubagent(newSub);
        return okResult('agent-create', parsed, 'Subagent Registered', `Added subagent '${newSub.name}' (${newSub.role}).`, {
          changesState: true,
          details: [
            { label: 'Name', value: newSub.name },
            { label: 'Role', value: newSub.role },
            { label: 'Model', value: newSub.model || 'Inherits session model' },
          ],
        });
      }

      await ctx.ui?.openCockpitModal?.('agents');
      return okResult('agent-create', parsed, 'Agent Creator Opened', 'Opened the Agents panel where you can add and configure subagents.', {
        status: 'info',
        uiAction: { type: 'openCockpitModal', payload: { modal: 'agents' } },
      });
    },
  });

  registry.register({
    name: 'agent-status',
    aliases: ['status'],
    description: 'Inspect live task execution state, active phase, and permission posture.',
    usage: '/agent-status',
    category: 'Agents & MCP',
    source: 'builtin',
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'zap',
    execute: async (ctx, _args, parsed) => {
      const task = ctx.orchestrator.getCurrentTask();
      const session = ctx.sessionManager.getActiveSession();
      const perm = ctx.permissionManager.getModeSummary();
      const pendingPlan = (task?.plan || session?.plan || []).filter((p) => p.status !== 'completed');
      return okResult('agent-status', parsed, 'Agent Runtime Status', task ? `Task '${task.userPrompt}' is ${task.status}.` : 'No active agent task is currently running.', {
        status: 'info',
        details: [
          { label: 'Execution Status', value: task?.status || session?.status || 'idle' },
          { label: 'Execution Mode', value: session?.config?.executionMode || ctx.activeMode },
          { label: 'Permission Policy', value: perm.label },
          { label: 'Active Model', value: session?.config?.modelId || 'Unselected' },
          { label: 'Pending Plan Steps', value: String(pendingPlan.length) },
        ],
      });
    },
  });

  registry.register({
    name: 'agent-stop',
    aliases: ['stop'],
    description: 'Safely cancel the currently running agent execution task.',
    usage: '/agent-stop',
    category: 'Agents & MCP',
    source: 'builtin',
    changesState: true,
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'square',
    execute: async (ctx, _args, parsed) => {
      const task = ctx.orchestrator.getCurrentTask();
      if (!task || task.status !== 'running') {
        return okResult('agent-stop', parsed, 'No Active Task Running', 'The agent is currently idle.', { status: 'info' });
      }
      ctx.orchestrator.cancelTask();
      ctx.sessionManager.updateActiveSession((s) => {
        if (s.status === 'running') {
          s.status = 'cancelled';
          s.activePhase = 'cancelled';
          s.activePhaseSummary = 'Cancelled';
        }
      });
      await ctx.ui?.syncSession?.();
      return okResult('agent-stop', parsed, 'Agent Execution Stopped', `Cancelled running task '${task.id}'.`, {
        changesState: true,
      });
    },
  });

  registry.register({
    name: 'mcp',
    description: 'List, connect, or disconnect configured MCP servers.',
    usage: '/mcp [list | connect <name> | disconnect <name>]',
    category: 'Agents & MCP',
    source: 'builtin',
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'plug',
    subcommands: [
      { name: 'list', description: 'List all configured MCP servers and their live statuses', usage: '/mcp list' },
      {
        name: 'connect',
        description: 'Connect to a configured MCP server by ID or name',
        usage: '/mcp connect <name>',
        arguments: [{ name: 'name', description: 'MCP server name or ID', required: true, type: 'string' }],
      },
      {
        name: 'disconnect',
        description: 'Disconnect an active MCP server by ID or name',
        usage: '/mcp disconnect <name>',
        arguments: [{ name: 'name', description: 'MCP server name or ID', required: true, type: 'string' }],
      },
    ],
    autocompleteArgs: (ctx, partial) => {
      const subs = ['list', 'connect', 'disconnect'];
      const parts = partial.trim().split(/\s+/);
      if (parts.length <= 1 && !partial.endsWith(' ')) {
        const q = (parts[0] || '').toLowerCase();
        return subs.filter((s) => !q || s.startsWith(q));
      }
      if ((parts[0] === 'connect' || parts[0] === 'disconnect') && ctx.mcpHost) {
        return ctx.mcpHost.getAllServers().map((s) => `${parts[0]} ${s.config.name || s.config.id}`);
      }
      return [];
    },
    execute: async (ctx, args, parsed) => {
      const mcp = ctx.mcpHost;
      if (!mcp) {
        return errResult('mcp', parsed, 'MCP Host Unavailable', 'McpHost service is not wired in this context.');
      }

      const servers = mcp.getAllServers();
      const sub = (args[0] || '').toLowerCase();

      if (!sub) {
        await ctx.ui?.openCockpitModal?.('mcp');
      }

      if (!sub || sub === 'list') {
        const lines = servers.map(
          (s) => `- ${s.config.name} [id=${s.config.id}, ${s.config.transport}] · status=${s.status} · ${s.tools.length} tool(s)`
        );
        return okResult('mcp', parsed, `MCP Servers (${servers.length})`, servers.length > 0 ? 'Configured MCP servers:' : 'No MCP servers configured.', {
          status: 'info',
          codeBlock: { language: 'text', content: lines.join('\n') || 'None configured. Use MCP Manager to add stdio or SSE servers.' },
        });
      }

      const targetName = args.slice(1).join(' ').trim();
      const target = servers.find(
        (s) => s.config.id.toLowerCase() === targetName.toLowerCase() || s.config.name.toLowerCase() === targetName.toLowerCase()
      );
      if (!target) {
        return errResult('mcp', parsed, 'MCP Server Not Found', `No configured MCP server matched '${targetName}'.`);
      }

      if (sub === 'connect') {
        const ok = await mcp.connectServer(target.config.id);
        return ok
          ? okResult('mcp', parsed, 'MCP Server Connected', `Connected to '${target.config.name}' (${target.tools.length} tools discovered).`, {
              changesState: true,
              details: [
                { label: 'Server', value: target.config.name },
                { label: 'Tools', value: String(target.tools.length) },
              ],
            })
          : errResult('mcp', parsed, 'MCP Connection Failed', target.error || `Failed to connect to '${target.config.name}'.`);
      }

      if (sub === 'disconnect') {
        await mcp.disconnectServer(target.config.id);
        return okResult('mcp', parsed, 'MCP Server Disconnected', `Disconnected '${target.config.name}'.`, {
          changesState: true,
        });
      }

      return errResult('mcp', parsed, 'Invalid MCP Subcommand', `Unknown subcommand '${sub}'. Use \`list\`, \`connect <name>\`, or \`disconnect <name>\`.`);
    },
  });

  registry.register({
    name: 'help',
    aliases: ['h', '?'],
    description: 'Display all registered slash commands or detailed documentation for one command.',
    usage: '/help [command]',
    category: 'General',
    source: 'builtin',
    permissionRequirement: 'safe',
    autoExecuteOnSelect: true,
    icon: 'scroll-text',
    arguments: [{ name: 'command', description: 'Optional command name to inspect', required: false, type: 'string' }],
    autocompleteArgs: (_ctx, partial) => {
      const q = partial.trim().toLowerCase();
      return registry
        .list()
        .map((c) => c.name)
        .filter((n) => !q || n.startsWith(q))
        .slice(0, 15);
    },
    execute: async (_ctx, args, parsed) => {
      const target = (args[0] || '').trim();
      if (target) {
        const cmd = registry.get(target);
        if (!cmd) {
          return errResult('help', parsed, 'Command Not Found', `No registered command matches '/${target.replace(/^\//, '')}'.`);
        }
        const argDocs = (cmd.arguments || []).map((a) => `  - <${a.name}> (${a.required ? 'required' : 'optional'}): ${a.description}`);
        const subDocs = (cmd.subcommands || []).map((s) => `  - ${s.usage || s.name}: ${s.description}`);
        const blocks = [
          `Usage: ${cmd.usage}`,
          cmd.aliases && cmd.aliases.length > 0 ? `Aliases: ${cmd.aliases.map((a) => '/' + a).join(', ')}` : undefined,
          `Category: ${cmd.category} (source: ${cmd.source})`,
          `Permission Requirement: ${cmd.permissionRequirement || 'safe'}`,
          cmd.requiresConfirmation ? 'Confirmation Required: Yes' : 'Confirmation Required: No',
          cmd.securityNotes ? `Security Notes: ${cmd.securityNotes}` : undefined,
          argDocs.length > 0 ? `Arguments:\n${argDocs.join('\n')}` : undefined,
          subDocs.length > 0 ? `Subcommands:\n${subDocs.join('\n')}` : undefined,
        ]
          .filter(Boolean)
          .join('\n');

        return okResult('help', parsed, `Help: /${cmd.name}`, cmd.description, {
          status: 'info',
          details: [
            { label: 'Usage', value: cmd.usage },
            { label: 'Category', value: cmd.category },
            { label: 'Permission Tier', value: cmd.permissionRequirement || 'safe' },
          ],
          codeBlock: { language: 'text', content: blocks },
        });
      }

      const all = registry.list();
      const byCategory = new Map<string, SlashCommand[]>();
      for (const c of all) {
        const group = byCategory.get(c.category) || [];
        group.push(c);
        byCategory.set(c.category, group);
      }
      const sections: string[] = [];
      for (const [cat, cmds] of byCategory.entries()) {
        sections.push(`[${cat}]`);
        for (const c of cmds) {
          sections.push(`  /${c.name.padEnd(16)} ${c.description}`);
        }
      }

      return okResult('help', parsed, `Slash Commands (${all.length})`, 'Generated dynamically from the central SlashCommandRegistry. Run `/help <command>` for detailed usage and security notes.', {
        status: 'info',
        details: [{ label: 'Registered Commands', value: String(all.length) }],
        codeBlock: { language: 'text', content: sections.join('\n') },
      });
    },
  });
}

function registerQueueCommands(registry: SlashCommandRegistry): void {
  const resolveQueueManager = (ctx: CommandContext): MessageQueueManager => {
    if (ctx.queueManager) return ctx.queueManager;
    return new MessageQueueManager({
      sessionManager: ctx.sessionManager,
      orchestrator: ctx.orchestrator,
      modelRegistry: ctx.modelRegistry,
      changesManager: ctx.changesManager,
      permissionManager: ctx.permissionManager,
      toolManager: ctx.toolManager,
      mcpHost: ctx.mcpHost,
      registry: ctx.registry,
      ollama: ctx.ollama,
    });
  };

  registry.register({
    name: 'queue',
    aliases: ['q'],
    description: 'Inspect and control the active session multi-message execution queue.',
    usage: '/queue [status|pause|resume|skip|clear]',
    category: 'Workflow',
    source: 'builtin',
    permissionRequirement: 'safe',
    autoExecuteOnSelect: false,
    icon: 'layers',
    subcommands: [
      { name: 'status', description: 'Show queue state, pending count, and active task.' },
      { name: 'pause', description: 'Pause advancing to the next queued message.' },
      { name: 'resume', description: 'Resume processing pending queued messages.' },
      { name: 'skip', description: 'Skip the current blocking failed or next queued message.' },
      { name: 'clear', description: 'Clear pending/failed messages from the queue (requires confirmation).', requiresConfirmation: true },
    ],
    autocompleteArgs: (_ctx, partial) => {
      const q = partial.trim().toLowerCase();
      return ['status', 'pause', 'resume', 'skip', 'clear'].filter((s) => !q || s.startsWith(q));
    },
    execute: async (ctx, args, parsed) => {
      const sub = (args[0] || 'list').toLowerCase();
      const session = ctx.sessionManager.getActiveSession();
      if (!session) {
        return errResult('queue', parsed, 'No Active Session', 'Open or create a session first to use the message queue.');
      }

      const qm = resolveQueueManager(ctx);
      const sid = session.id;

      if (sub === 'pause') {
        const res = qm.pauseQueue(sid);
        await ctx.ui?.syncSession?.();
        return okResult('queue', parsed, 'Queue Paused', res.message || 'Queue paused.', {
          changesState: true,
          details: [
            { label: 'State', value: res.snapshot.state },
            { label: 'Queued', value: String(res.snapshot.queuedCount) },
          ],
        });
      }

      if (sub === 'resume') {
        const res = qm.resumeQueue(sid);
        await ctx.ui?.syncSession?.();
        return okResult('queue', parsed, 'Queue Resumed', res.message || 'Queue resumed.', {
          changesState: true,
          details: [
            { label: 'State', value: res.snapshot.state },
            { label: 'Queued', value: String(res.snapshot.queuedCount) },
          ],
        });
      }

      if (sub === 'skip') {
        const res = qm.skipQueuedMessage(sid);
        await ctx.ui?.syncSession?.();
        if (!res.ok) {
          return errResult('queue', parsed, 'Queue Skip Failed', res.error || 'Unable to skip queued item.');
        }
        return okResult('queue', parsed, 'Skipped Queued Message', res.message || 'Skipped queued item.', {
          changesState: true,
          details: [
            { label: 'Skipped', value: res.item?.content.slice(0, 80) || '-' },
            { label: 'Remaining Queued', value: String(res.snapshot.queuedCount) },
            { label: 'State', value: res.snapshot.state },
          ],
        });
      }

      if (sub === 'clear') {
        const res = qm.clearQueue(sid, { includeFailed: true });
        await ctx.ui?.syncSession?.();
        return okResult('queue', parsed, 'Queue Cleared', res.message || 'Pending queued messages cleared.', {
          changesState: true,
          details: [
            { label: 'State', value: res.snapshot.state },
            { label: 'Remaining', value: String(res.snapshot.queuedCount) },
          ],
        });
      }

      if (sub === 'status' || sub === 'list') {
        const snap = qm.getSnapshot(sid);
        const lines = snap.items.map((it, idx) => {
          const preview = it.content.replace(/\s+/g, ' ').slice(0, 80);
          const att = it.attachments?.length ? ` [${it.attachments.length} attachment(s)]` : '';
          const err = it.error ? ` — error: ${it.error}` : '';
          return `${idx + 1}. [${it.status}] ${preview}${att}${err}`;
        });
        const title = sub === 'status' ? `Queue Status: ${snap.state}` : `Queued Messages (${snap.queuedCount})`;
        const summary =
          lines.length > 0
            ? `Session '${session.title}' has ${snap.queuedCount} pending message(s)${snap.failedCount > 0 ? ` and ${snap.failedCount} failed item(s)` : ''}.`
            : `No queued messages in session '${session.title}'. State: ${snap.state}.`;
        return okResult('queue', parsed, title, summary, {
          status: 'info',
          details: [
            { label: 'State', value: snap.state },
            { label: 'Queued', value: String(snap.queuedCount) },
            { label: 'Paused', value: snap.paused ? 'Yes' : 'No' },
            { label: 'Completed', value: String(snap.completedCount) },
            { label: 'Capacity', value: `${snap.queuedCount}/${snap.capacity}` },
          ],
          codeBlock: lines.length > 0 ? { language: 'text', content: lines.join('\n') } : undefined,
        });
      }

      return errResult(
        'queue',
        parsed,
        'Unknown /queue Subcommand',
        `Unknown subcommand '${sub}'. Use \`/queue\`, \`/queue status\`, \`/queue pause\`, \`/queue resume\`, \`/queue skip\`, or \`/queue clear\`.`
      );
    },
  });
}

const registeredRegistries = new WeakSet<SlashCommandRegistry>();

export function ensureBuiltinSlashCommandsRegistered(
  registry: SlashCommandRegistry = SlashCommandRegistry.getInstance(),
  workspaceRoot?: string
): SlashCommandRegistry {
  if (!registeredRegistries.has(registry)) {
    registerPermissionCommands(registry);
    registerModeCommands(registry);
    registerModelCommands(registry);
    registerSessionCommands(registry);
    registerWorkspaceCommands(registry);
    registerAgentMcpCommands(registry);
    registerQueueCommands(registry);
    registeredRegistries.add(registry);
  }
  if (workspaceRoot) {
    registry.loadCustomCommands(workspaceRoot);
  }
  return registry;
}
