import * as fs from 'fs';
import { parseSlashCommand } from './parser';
import { SlashCommandRegistry } from './registry';
import { CommandContext, CommandResult, ParsedSlashCommand, SlashCommand } from './types';

function makeResult(
  command: string,
  rawInput: string,
  status: CommandResult['status'],
  title: string,
  message: string,
  extra: Partial<CommandResult> = {}
): CommandResult {
  return {
    id: `cmdres_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    command,
    rawInput,
    ok: status === 'success' || status === 'info',
    status,
    title,
    message,
    timestamp: Date.now(),
    ...extra,
  };
}

export class SlashCommandExecutor {
  private inFlightKeys: Set<string> = new Set();

  constructor(private readonly registry: SlashCommandRegistry) {}

  public async executeInput(rawInput: string, context: CommandContext): Promise<CommandResult> {
    const parsed = parseSlashCommand(rawInput);
    if (!parsed) {
      return makeResult('unknown', rawInput, 'error', 'Invalid Command Syntax', 'Commands must start with `/` followed by a valid command name. Type `/help` to list available commands.');
    }

    const command = this.registry.get(parsed.commandName);
    if (!command) {
      const suggestions = this.registry.findClosestMatches(parsed.commandName, 3);
      const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
      return makeResult(
        parsed.commandName,
        rawInput,
        'error',
        `Unknown Command: /${parsed.commandName}`,
        `Command '/${parsed.commandName}' is not registered.${hint} Run /help to see all available commands.`
      );
    }

    const dedupeKey = `${command.name}:${parsed.argString}:${context.confirmed ? '1' : '0'}`;
    if (this.inFlightKeys.has(dedupeKey)) {
      return makeResult(
        command.name,
        rawInput,
        'error',
        `Command Already Running`,
        `'/${command.name}' with these arguments is already executing. Please wait for it to finish.`
      );
    }

    if (context.abortSignal?.aborted) {
      return makeResult(command.name, rawInput, 'cancelled', `Command Cancelled`, `'/${command.name}' was cancelled before execution.`);
    }

    const validationError = this.validateCommandInvocation(command, context, parsed);
    if (validationError) {
      return validationError;
    }

    const permissionError = this.validatePermissionsAndConfirmation(command, context, parsed);
    if (permissionError) {
      return permissionError;
    }

    this.inFlightKeys.add(dedupeKey);
    const startTime = Date.now();
    try {
      const res = await command.execute(context, parsed.args, parsed);
      const result: CommandResult = {
        ...res,
        id: res.id || `cmdres_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        command: command.name,
        rawInput,
        timestamp: res.timestamp || Date.now(),
      };

      try {
        context.permissionManager.recordEvent({
          id: `aud_cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          toolName: `slash:${command.name}`,
          category: 'custom',
          agentId: 'user',
          agentName: 'Slash Command',
          argsSummary: context.permissionManager.redact(parsed.argString || '(no args)'),
          environment: 'native',
          startTime,
          endTime: Date.now(),
          durationMs: Date.now() - startTime,
          status: result.ok ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed',
          error: result.ok ? undefined : result.message,
          approved: true,
        });
      } catch {
        // Non-fatal audit logging failure
      }

      return result;
    } catch (err: any) {
      if (context.abortSignal?.aborted) {
        return makeResult(command.name, rawInput, 'cancelled', `Command Cancelled`, `'/${command.name}' execution was aborted.`);
      }
      const rawErr = err?.message || String(err);
      const safeErr = context.permissionManager.redact(rawErr);
      return makeResult(command.name, rawInput, 'error', `/${command.name} Failed`, safeErr);
    } finally {
      this.inFlightKeys.delete(dedupeKey);
    }
  }

  private validateCommandInvocation(
    command: SlashCommand,
    context: CommandContext,
    parsed: ParsedSlashCommand
  ): CommandResult | null {
    if (command.requiresWorkspace && (!context.workspaceRoot || !fs.existsSync(context.workspaceRoot))) {
      return makeResult(
        command.name,
        parsed.raw,
        'error',
        `Workspace Required`,
        `'/${command.name}' requires an active, existing workspace folder. Select a working folder first.`
      );
    }

    if (command.allowedModes && command.allowedModes.length > 0 && !command.allowedModes.includes(context.activeMode)) {
      return makeResult(
        command.name,
        parsed.raw,
        'error',
        `Unavailable in ${context.activeMode} Mode`,
        `'/${command.name}' is only available in: ${command.allowedModes.join(', ')}.`
      );
    }

    // Validate required top-level arguments when no subcommand delegates them
    const requiredArgs = (command.arguments || []).filter((a) => a.required);
    if (requiredArgs.length > 0 && parsed.args.length < requiredArgs.length) {
      return makeResult(
        command.name,
        parsed.raw,
        'error',
        `Missing Required Argument`,
        `Usage: ${command.usage}\nRequired: ${requiredArgs.map((a) => `<${a.name}> — ${a.description}`).join('; ')}`
      );
    }

    // Subcommand argument validation when subcommands are defined
    if (command.subcommands && command.subcommands.length > 0 && parsed.subcommand) {
      const sub = command.subcommands.find((s) => s.name === parsed.subcommand);
      if (sub) {
        const subRequired = (sub.arguments || []).filter((a) => a.required);
        if (parsed.args.length - 1 < subRequired.length) {
          return makeResult(
            command.name,
            parsed.raw,
            'error',
            `Missing Argument for '${command.name} ${sub.name}'`,
            `Usage: ${sub.usage || `/${command.name} ${sub.name}`}\nRequired: ${subRequired.map((a) => `<${a.name}> — ${a.description}`).join('; ')}`
          );
        }
      }
    }

    if (command.validate) {
      const check = command.validate(context, parsed);
      if (!check.ok) {
        return makeResult(
          command.name,
          parsed.raw,
          'error',
          `Invalid Arguments`,
          `${check.error || 'Argument validation failed.'}\nUsage: ${command.usage}`
        );
      }
    }

    return null;
  }

  private validatePermissionsAndConfirmation(
    command: SlashCommand,
    context: CommandContext,
    parsed: ParsedSlashCommand
  ): CommandResult | null {
    // External plugins/MCP cannot declare elevated privilege
    if (command.source !== 'builtin' && command.permissionRequirement === 'elevated') {
      return makeResult(
        command.name,
        parsed.raw,
        'error',
        'Permission Denied',
        `External ${command.source} command '/${command.name}' is not authorized for elevated execution.`
      );
    }

    // Restricted permission mode blocks workspace-mutating external/shell commands
    if (context.permissionManager.getMode() === 'restricted' && command.permissionRequirement === 'workspace_write') {
      return makeResult(
        command.name,
        parsed.raw,
        'error',
        'Blocked in Restricted Mode',
        `'/${command.name}' modifies the workspace and is blocked while PermissionManager is in 'restricted' mode.`
      );
    }

    // Block prohibited arguments regardless of bypass mode
    if (parsed.argString && context.permissionManager.isStrictlyProhibited(parsed.argString)) {
      return makeResult(
        command.name,
        parsed.raw,
        'error',
        'Blocked by Safety Policy',
        `Arguments for '/${command.name}' matched a prohibited destructive, privilege-escalation, or secret-access pattern.`
      );
    }

    const activeSub = command.subcommands?.find((s) => s.name === parsed.subcommand);
    const subRequiresConfirm = activeSub?.requiresConfirmation;
    if ((command.requiresConfirmation || subRequiresConfirm) && !context.confirmed) {
      // Bypass mode still requires confirmation for commands explicitly marked always-confirm (clear, delete-session),
      // while workspace actions can honor bypass unless destructive/restricted.
      const bypassPermitsDirect =
        command.source === 'builtin' &&
        command.permissionRequirement !== 'restricted' &&
        command.name !== 'clear' &&
        command.name !== 'delete-session' &&
        context.permissionManager.getNormalizedMode() === 'bypass';

      if (!bypassPermitsDirect) {
        return makeResult(
          command.name,
          parsed.raw,
          'confirmation_required',
          `Confirm /${command.name}`,
          `This operation (${parsed.raw.trim()}) changes workspace or session state. Confirm to proceed.`,
          {
            confirmPrompt: {
              commandLine: parsed.raw.trim(),
              title: `Confirm /${command.name}`,
              detail: activeSub?.description || command.description,
              confirmLabel: `Confirm /${command.name}`,
            },
          }
        );
      }
    }

    return null;
  }
}
