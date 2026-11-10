import { ParsedSlashCommand } from './types';

/**
 * Returns true if the input represents an intentional slash command rather than
 * ordinary prose containing `/` or a Unix filesystem path like `/home/juan/file.ts`.
 */
export function isSlashCommandInput(raw: string): boolean {
  if (!raw || typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return false;
  if (trimmed.length === 1) return false;

  const firstToken = trimmed.split(/\s+/)[0] || '';
  // Guard against multi-segment Unix paths like /home/user/project or /usr/bin/env
  if (firstToken.indexOf('/', 1) !== -1) {
    return false;
  }

  return /^\/[a-zA-Z?][a-zA-Z0-9_-]*$/.test(firstToken);
}

/**
 * Returns the live autocomplete context when the user is typing a slash command
 * at the start of the composer, or null if ordinary text/path entry is detected.
 */
export function getSlashAutocompleteQuery(raw: string): {
  mode: 'command' | 'arg';
  commandQuery: string;
  argQuery: string;
} | null {
  if (typeof raw !== 'string') return null;
  if (!raw.startsWith('/')) return null;

  // Multi-line message after line 1 or filesystem path (/home/...) should not pop up command list
  if (raw.includes('\n')) return null;
  const firstSpace = raw.search(/\s/);
  if (firstSpace === -1) {
    const token = raw.slice(1);
    if (token.includes('/')) return null;
    if (token.length > 0 && !/^[a-zA-Z?][a-zA-Z0-9_-]*$/.test(token)) {
      return null;
    }
    return {
      mode: 'command',
      commandQuery: token.toLowerCase(),
      argQuery: '',
    };
  }

  const commandToken = raw.slice(1, firstSpace);
  if (!commandToken || commandToken.includes('/') || !/^[a-zA-Z?][a-zA-Z0-9_-]*$/.test(commandToken)) {
    return null;
  }
  return {
    mode: 'arg',
    commandQuery: commandToken.toLowerCase(),
    argQuery: raw.slice(firstSpace + 1),
  };
}

/**
 * Splits argument string respecting single quotes, double quotes, and backslash escapes.
 */
export function tokenizeCommandArgs(argString: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let i = 0; i < argString.length; i++) {
    const ch = argString[i];
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (escaping) {
    current += '\\';
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

export function parseSlashCommand(rawInput: string): ParsedSlashCommand | null {
  if (!isSlashCommandInput(rawInput)) {
    return null;
  }
  const trimmed = rawInput.trim();
  const firstSpace = trimmed.search(/\s/);
  const commandName = (firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace)).toLowerCase();
  const argString = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
  const args = tokenizeCommandArgs(argString);
  const subcommand = args.length > 0 ? args[0].toLowerCase() : undefined;

  return {
    raw: rawInput,
    commandName,
    subcommand,
    args,
    argString,
  };
}
