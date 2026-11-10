import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  CommandAgentMode,
  CommandContext,
  CommandMetadata,
  CommandResult,
  CommandSource,
  ParsedSlashCommand,
  SlashCommand,
} from './types';

const execAsync = promisify(exec);

const PROTECTED_BUILTIN_NAMES = new Set([
  'bypass',
  'normal',
  'auto-approve',
  'permissions',
  'agent',
  'plan',
  'ask',
  'review',
  'help',
]);

export interface CustomCommandManifestEntry {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  category?: string;
  kind: 'prompt' | 'shell';
  template: string;
  requiresWorkspace?: boolean;
  requiresConfirmation?: boolean;
  allowedModes?: CommandAgentMode[];
}

export class SlashCommandRegistry {
  private static instance: SlashCommandRegistry;
  private commands: Map<string, SlashCommand> = new Map();
  private aliasIndex: Map<string, string> = new Map();

  public static getInstance(): SlashCommandRegistry {
    if (!SlashCommandRegistry.instance) {
      SlashCommandRegistry.instance = new SlashCommandRegistry();
    }
    return SlashCommandRegistry.instance;
  }

  public register(command: SlashCommand, options: { allowOverrideBuiltin?: boolean } = {}): { ok: boolean; error?: string } {
    const cleanName = (command.name || '').trim().toLowerCase();
    if (!cleanName || !/^[a-zA-Z?][a-zA-Z0-9_-]*$/.test(cleanName)) {
      return { ok: false, error: `Invalid slash command name '${command.name}'.` };
    }

    const source: CommandSource = command.source || 'builtin';
    if (source !== 'builtin') {
      if (PROTECTED_BUILTIN_NAMES.has(cleanName) && !options.allowOverrideBuiltin) {
        return { ok: false, error: `External ${source} command cannot override protected built-in '/${cleanName}'.` };
      }
      if (command.permissionRequirement === 'elevated') {
        return { ok: false, error: `External ${source} command '/${cleanName}' cannot claim 'elevated' permission tier.` };
      }
    }

    // Check alias collisions across existing commands
    const aliases = (command.aliases || []).map((a) => a.trim().toLowerCase()).filter(Boolean);
    for (const alias of aliases) {
      if (source !== 'builtin' && PROTECTED_BUILTIN_NAMES.has(alias)) {
        return { ok: false, error: `External ${source} command alias '/${alias}' collides with protected built-in.` };
      }
      const owner = this.commands.has(alias) ? alias : this.aliasIndex.get(alias);
      if (owner && owner !== cleanName && source !== 'builtin') {
        return { ok: false, error: `Alias '/${alias}' is already registered by '/${owner}'.` };
      }
    }

    // Clear previous aliases for clean replacement
    this.unregister(cleanName);

    const normalized: SlashCommand = {
      ...command,
      name: cleanName,
      aliases,
      usage: command.usage || `/${cleanName}`,
      category: command.category || 'General',
      source,
      permissionRequirement: command.permissionRequirement || 'safe',
    };

    this.commands.set(cleanName, normalized);
    for (const alias of aliases) {
      this.aliasIndex.set(alias, cleanName);
    }
    return { ok: true };
  }

  /**
   * Public plugin/MCP registration entry point enforcing strict permission & privilege checks.
   */
  public registerExternalCommand(
    command: Omit<SlashCommand, 'source'>,
    source: Exclude<CommandSource, 'builtin'>
  ): { ok: boolean; error?: string } {
    return this.register({
      ...command,
      source,
      requiresConfirmation: command.requiresConfirmation ?? (command.permissionRequirement === 'workspace_write'),
      permissionRequirement: command.permissionRequirement || 'workspace_write',
    });
  }

  public unregister(name: string): void {
    const clean = name.trim().toLowerCase();
    const existing = this.commands.get(clean);
    if (existing?.aliases) {
      for (const alias of existing.aliases) {
        if (this.aliasIndex.get(alias) === clean) {
          this.aliasIndex.delete(alias);
        }
      }
    }
    this.commands.delete(clean);
  }

  public clearExternalSources(sources: Array<Exclude<CommandSource, 'builtin'>>): void {
    for (const [name, cmd] of this.commands.entries()) {
      if (sources.includes(cmd.source as Exclude<CommandSource, 'builtin'>)) {
        this.unregister(name);
      }
    }
  }

  public get(nameOrAlias: string): SlashCommand | undefined {
    const clean = (nameOrAlias || '').trim().toLowerCase().replace(/^\//, '');
    if (!clean) return undefined;
    const direct = this.commands.get(clean);
    if (direct) return direct;
    const target = this.aliasIndex.get(clean);
    return target ? this.commands.get(target) : undefined;
  }

  public list(): SlashCommand[] {
    return Array.from(this.commands.values());
  }

  public filter(query: string = '', mode?: CommandAgentMode): SlashCommand[] {
    const q = (query || '').trim().toLowerCase().replace(/^\//, '');
    const inMode = this.list().filter((cmd) => {
      if (mode && cmd.allowedModes && cmd.allowedModes.length > 0 && !cmd.allowedModes.includes(mode)) {
        return false;
      }
      return true;
    });
    if (!q) return inMode;
    const nameOrAlias = inMode.filter(
      (cmd) => cmd.name.toLowerCase().includes(q) || (cmd.aliases || []).some((a) => a.toLowerCase().includes(q))
    );
    if (nameOrAlias.length > 0) return nameOrAlias;
    return inMode.filter((cmd) => cmd.description.toLowerCase().includes(q));
  }

  public findClosestMatches(unknownName: string, limit: number = 3): string[] {
    const q = (unknownName || '').toLowerCase();
    const scored = this.list()
      .map((cmd) => {
        const name = cmd.name.toLowerCase();
        let score = 999;
        if (name.startsWith(q) || q.startsWith(name)) score = Math.abs(name.length - q.length);
        else if (name.includes(q) || q.includes(name)) score = 10 + Math.abs(name.length - q.length);
        else score = 50 + Math.abs(name.length - q.length);
        return { name, score };
      })
      .sort((a, b) => a.score - b.score);
    return scored.slice(0, limit).map((s) => `/${s.name}`);
  }

  public getSerializableCatalog(): CommandMetadata[] {
    return this.list().map((c) => ({
      name: c.name,
      aliases: c.aliases,
      description: c.description,
      usage: c.usage,
      category: c.category,
      source: c.source,
      arguments: c.arguments,
      subcommands: c.subcommands,
      requiresWorkspace: c.requiresWorkspace,
      requiresConfirmation: c.requiresConfirmation,
      changesState: c.changesState,
      allowedModes: c.allowedModes,
      permissionRequirement: c.permissionRequirement,
      securityNotes: c.securityNotes,
      autoExecuteOnSelect: c.autoExecuteOnSelect,
      icon: c.icon,
    }));
  }

  /**
   * Discovers workspace-local (.localcoders/commands/*.json) and user (~/.localcoders/commands/*.json)
   * custom slash command definitions safely through the central registry & permission system.
   */
  public loadCustomCommands(workspaceRoot?: string): number {
    this.clearExternalSources(['workspace', 'user']);
    let count = 0;

    const dirs: Array<{ dir: string; source: 'workspace' | 'user' }> = [];
    const userDir = path.join(os.homedir(), '.localcoders', 'commands');
    dirs.push({ dir: userDir, source: 'user' });
    if (workspaceRoot && fs.existsSync(workspaceRoot)) {
      dirs.push({ dir: path.join(workspaceRoot, '.localcoders', 'commands'), source: 'workspace' });
    }

    for (const { dir, source } of dirs) {
      if (!fs.existsSync(dir)) continue;
      let files: string[] = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }

      for (const file of files) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
          const entries: CustomCommandManifestEntry[] = Array.isArray(parsed) ? parsed : [parsed];
          for (const entry of entries) {
            if (!entry || !entry.name || !entry.template) continue;
            const res = this.registerExternalCommand(
              {
                name: entry.name,
                aliases: entry.aliases,
                description: entry.description || `Custom ${source} command`,
                usage: entry.usage || `/${entry.name}`,
                category: entry.category || (source === 'workspace' ? 'Workspace' : 'User'),
                requiresWorkspace: entry.requiresWorkspace ?? entry.kind === 'shell',
                requiresConfirmation: entry.requiresConfirmation ?? entry.kind === 'shell',
                changesState: entry.kind === 'shell',
                allowedModes: entry.allowedModes,
                permissionRequirement: entry.kind === 'shell' ? 'workspace_write' : 'safe',
                icon: entry.kind === 'shell' ? 'terminal' : 'sparkles',
                execute: async (ctx: CommandContext, args: string[], parsedCmd: ParsedSlashCommand): Promise<CommandResult> => {
                  const interpolated = entry.template
                    .replace(/\{\{args\}\}/g, parsedCmd.argString)
                    .replace(/\{\{arg(\d+)\}\}/g, (_, idx) => args[Number(idx)] || '');

                  if (entry.kind === 'shell') {
                    if (ctx.permissionManager.isStrictlyProhibited(interpolated)) {
                      return {
                        id: `cmd_${Date.now()}`,
                        command: entry.name,
                        rawInput: parsedCmd.raw,
                        ok: false,
                        status: 'error',
                        title: 'Blocked by Security Policy',
                        message: 'Custom command matches a prohibited system or credential pattern and cannot execute.',
                        timestamp: Date.now(),
                      };
                    }
                    const needConfirm = entry.requiresConfirmation !== false && ctx.permissionManager.getNormalizedMode() !== 'bypass';
                    if (needConfirm && !ctx.confirmed) {
                      return {
                        id: `cmd_${Date.now()}`,
                        command: entry.name,
                        rawInput: parsedCmd.raw,
                        ok: false,
                        status: 'confirmation_required',
                        title: `Confirm Custom Command /${entry.name}`,
                        message: `Execute custom shell command in ${ctx.workspaceRoot}?`,
                        confirmPrompt: {
                          commandLine: parsedCmd.raw,
                          title: `Run /${entry.name}`,
                          detail: interpolated,
                          confirmLabel: 'Run Command',
                        },
                        timestamp: Date.now(),
                      };
                    }
                    const { stdout, stderr } = await execAsync(interpolated, { cwd: ctx.workspaceRoot, timeout: 30000 });
                    return {
                      id: `cmd_${Date.now()}`,
                      command: entry.name,
                      rawInput: parsedCmd.raw,
                      ok: true,
                      status: 'success',
                      title: `Custom Command /${entry.name}`,
                      message: 'Command finished with exit code 0.',
                      codeBlock: { language: 'text', content: [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)' },
                      timestamp: Date.now(),
                    };
                  }

                  if (ctx.ui?.submitAgentPrompt) {
                    await ctx.ui.submitAgentPrompt(interpolated);
                    return {
                      id: `cmd_${Date.now()}`,
                      command: entry.name,
                      rawInput: parsedCmd.raw,
                      ok: true,
                      status: 'success',
                      title: `Custom Command /${entry.name}`,
                      message: 'Submitted custom prompt workflow to the agent.',
                      timestamp: Date.now(),
                    };
                  }
                  return {
                    id: `cmd_${Date.now()}`,
                    command: entry.name,
                    rawInput: parsedCmd.raw,
                    ok: true,
                    status: 'info',
                    title: `Custom Command /${entry.name}`,
                    message: interpolated,
                    timestamp: Date.now(),
                  };
                },
              },
              source
            );
            if (res.ok) count++;
          }
        } catch {
          // Ignore malformed custom command file safely
        }
      }
    }
    return count;
  }
}
