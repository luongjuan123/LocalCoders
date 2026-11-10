import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { ToolExecutionContext, ToolResult } from './types';
import { ProcessManager } from './process-manager';

export function getPreferredShell(): string | boolean {
  if (process.platform === 'win32') return true;
  if (fs.existsSync('/bin/bash')) return '/bin/bash';
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) return process.env.SHELL;
  return true;
}

export function buildWorkspaceCommandEnv(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const currentPath = env[pathKey] || '';
  const extraBins: string[] = [];

  if (cwd) {
    for (const venvName of ['.venv', 'venv']) {
      const venvDir = path.join(cwd, venvName);
      const binDir = path.join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin');
      if (fs.existsSync(binDir)) {
        extraBins.push(binDir);
        if (!env.VIRTUAL_ENV) env.VIRTUAL_ENV = venvDir;
      }
    }
    const nodeBin = path.join(cwd, 'node_modules', '.bin');
    if (fs.existsSync(nodeBin)) {
      extraBins.push(nodeBin);
    }
  }

  if (extraBins.length > 0) {
    env[pathKey] = [...extraBins, currentPath].filter(Boolean).join(path.delimiter);
  }
  return env;
}

export function extractInteractivePromptTail(stdout: string, stderr: string): string | undefined {
  const combined = `${stdout || ''}\n${stderr || ''}`.trimEnd();
  if (!combined) return undefined;
  const lines = combined.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return undefined;
  // Walk back up to 3 lines to catch prompt before Python EOFError traceback
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
    const line = lines[i].trim();
    if (/EOFError:\s*EOF when reading a line/i.test(stderr) && i < lines.length - 1) {
      if (line.endsWith(':') || line.endsWith('?') || /\b(enter|input|select|choose)\b/i.test(line)) {
        return line;
      }
    }
    if (
      /^(?:enter|please\s+enter|input|type|password|passphrase|confirm|choose|select)\b.*[:?\]]\s*$/i.test(line) ||
      /(?:\[y\/n\]|\(y\/n\)|\[yes\/no\]|\(HH:MM(?::SS)?\))\s*[:?]?\s*$/i.test(line)
    ) {
      return line;
    }
  }
  if (/EOFError:\s*EOF when reading a line/i.test(stderr)) {
    return lines[0]?.trim() || 'stdin requested';
  }
  return undefined;
}

export async function runCommandTool(
  args: { command: string; stdin?: string; input?: string; timeoutMs?: number; cwd?: string },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const explicitCmd = args.command || (args as any).cmd || (args as any).script || (args as any).commandLine;
  const rawCmd = explicitCmd || (args as any).input || '';
  if (!rawCmd) {
    return { success: false, error: 'runCommandTool: Missing required argument "command"' };
  }
  const stdinPayload =
    typeof args.stdin === 'string'
      ? args.stdin
      : explicitCmd && typeof args.input === 'string'
      ? args.input
      : undefined;
  const timeout = args.timeoutMs || 45000;
  const cwd = args.cwd || ctx.workspaceRoot;

  if (ctx.abortSignal?.aborted) {
    return {
      success: false,
      cancelled: true,
      error: 'Command cancelled before start.',
      output: { command: rawCmd, cwd, stdout: '', stderr: '', exitCode: null, cancelled: true, durationMs: 0 },
    };
  }

  // Handle standalone venv activation calls cleanly without failing with OS Permission denied (exit 126) on non-executable activate scripts
  const trimmedCmd = rawCmd.trim();
  const venvActivateMatch = trimmedCmd.match(/^(?:(?:source|\.)\s+|(?:\.\/)?)(\.?venv)\/bin\/activate\s*$/);
  if (venvActivateMatch) {
    const venvName = venvActivateMatch[1];
    const venvPython = path.join(cwd, venvName, 'bin', 'python');
    if (fs.existsSync(venvPython)) {
      return {
        success: true,
        output: {
          command: rawCmd,
          cwd,
          stdout: `Workspace virtual environment '${venvName}' is automatically on PATH for run_command. Call python3, python, pip, or pytest directly.`,
          stderr: '',
          exitCode: 0,
          durationMs: 0,
        },
      };
    }
    return {
      success: false,
      error: `Virtual environment '${venvName}' was not found in ${cwd}. Run 'python3 -m venv ${venvName}' first.`,
      output: { command: rawCmd, cwd, stdout: '', stderr: `Missing virtual environment: ${venvName}`, exitCode: 1, durationMs: 0 },
    };
  }

  if (ctx.requireApproval) {
    const isDestructive =
      rawCmd.includes('rm -rf') ||
      rawCmd.includes('mkfs') ||
      rawCmd.includes('dd if=') ||
      rawCmd.includes('shutdown') ||
      rawCmd.includes('reboot');

    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'run_command',
      args: { ...args, command: rawCmd },
      description: `Execute terminal command: \`${rawCmd}\``,
      isDestructive,
    });

    if (!approved) {
      return {
        success: false,
        cancelled: true,
        error: 'User rejected command execution.',
        output: { command: rawCmd, cwd, stdout: '', stderr: '', exitCode: null, cancelled: true, durationMs: 0 },
      };
    }
  }

  const startTime = Date.now();
  return new Promise<ToolResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let promptStalled = false;
    let detectedPromptText: string | undefined;
    let lastOutputAt = startTime;

    const child = spawn(rawCmd, {
      cwd,
      shell: getPreferredShell(),
      detached: process.platform !== 'win32',
      env: buildWorkspaceCommandEnv(cwd),
    });

    // Feed provided stdin or close stdin immediately (EOF) so synchronous commands waiting for input never hang 45s
    if (child.stdin) {
      if (stdinPayload !== undefined) {
        if (stdinPayload.length > 0) {
          child.stdin.write(stdinPayload.endsWith('\n') ? stdinPayload : `${stdinPayload}\n`);
        }
        child.stdin.end();
      } else {
        child.stdin.end();
      }
    }

    const killChildTree = () => {
      try {
        if (child.pid && process.platform !== 'win32') {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // Ignore already-exited child errors
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree();
    }, timeout);

    // Secondary guard for prompts reading /dev/tty or ignoring EOF without exiting
    const promptPollInterval =
      stdinPayload === undefined
        ? setInterval(() => {
            if (settled) return;
            const idleMs = Date.now() - lastOutputAt;
            if (idleMs >= 5000) {
              const tailPrompt = extractInteractivePromptTail(stdout, '');
              if (tailPrompt) {
                promptStalled = true;
                detectedPromptText = tailPrompt;
                killChildTree();
              }
            }
          }, 500)
        : undefined;

    const onAbort = () => {
      cancelled = true;
      killChildTree();
    };
    ctx.abortSignal?.addEventListener('abort', onAbort, { once: true });

    const appendBounded = (prev: string, chunk: string) => {
      const next = prev + chunk;
      const maxLen = 2 * 1024 * 1024;
      return next.length > maxLen ? next.slice(next.length - maxLen) : next;
    };

    child.stdout?.on('data', (d: Buffer) => {
      lastOutputAt = Date.now();
      const text = d.toString('utf-8');
      stdout = appendBounded(stdout, text);
      ctx.onOutput?.('stdout', text);
    });

    child.stderr?.on('data', (d: Buffer) => {
      lastOutputAt = Date.now();
      const text = d.toString('utf-8');
      stderr = appendBounded(stderr, text);
      ctx.onOutput?.('stderr', text);
    });

    const finalize = (code: number | null, errMsg?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (promptPollInterval) clearInterval(promptPollInterval);
      ctx.abortSignal?.removeEventListener('abort', onAbort);
      const durationMs = Date.now() - startTime;
      const outTrim = stdout.trim();
      const errTrim = stderr.trim();
      const interactivePrompt = detectedPromptText || extractInteractivePromptTail(outTrim, errTrim);
      const eofInteractive = Boolean(
        promptStalled ||
          (stdinPayload === undefined &&
            (/EOFError:\s*EOF when reading a line/i.test(errTrim) ||
              (timedOut && interactivePrompt)))
      );
      const interactiveHint =
        'Process expects interactive input' +
        (interactivePrompt ? ` (prompt: "${interactivePrompt}")` : '') +
        `. Re-run run_command with 'stdin' (e.g. stdin: "...\\n"), pass CLI arguments/tests, or use start_process + write_stdin for multi-step interaction.`;

      if (cancelled) {
        resolve({
          success: false,
          cancelled: true,
          error: 'Command cancelled by user.',
          output: { command: rawCmd, cwd, stdout: outTrim, stderr: errTrim, exitCode: null, cancelled: true, durationMs },
        });
        return;
      }

      if (promptStalled || (timedOut && eofInteractive)) {
        resolve({
          success: false,
          error: interactiveHint,
          output: {
            command: rawCmd,
            cwd,
            stdout: outTrim,
            stderr: errTrim ? `${errTrim}\n${interactiveHint}` : interactiveHint,
            exitCode: code ?? 124,
            timedOut: true,
            interactiveRequired: true,
            promptDetected: interactivePrompt,
            durationMs,
          },
        });
        return;
      }

      if (timedOut) {
        const timeoutHint = `Command timed out after ${timeout}ms. For long-running UIs, watch loops, or servers, use 'start_process' instead of blocking 'run_command'.`;
        resolve({
          success: false,
          error: timeoutHint,
          output: {
            command: rawCmd,
            cwd,
            stdout: outTrim,
            stderr: errTrim,
            exitCode: code ?? 124,
            timedOut: true,
            durationMs,
          },
        });
        return;
      }

      if (errMsg) {
        resolve({
          success: false,
          error: errMsg,
          output: { command: rawCmd, cwd, stdout: outTrim, stderr: errTrim, exitCode: code ?? 1, durationMs },
        });
        return;
      }

      const exitCode = code ?? 0;
      const permNote =
        exitCode === 126
          ? ' (OS file execute permission denied — target script lacks executable +x bit or OS access, unrelated to LocalCoders approval policy)'
          : '';
      const extraNote = eofInteractive ? `\n${interactiveHint}` : permNote;
      resolve({
        success: exitCode === 0,
        error: exitCode === 0 ? undefined : eofInteractive ? interactiveHint : `Command exited with code ${exitCode}${permNote}`,
        output: {
          command: rawCmd,
          cwd,
          stdout: outTrim,
          stderr: extraNote ? (errTrim ? `${errTrim}\n${extraNote.trim()}` : extraNote.trim()) : errTrim,
          exitCode,
          interactiveRequired: eofInteractive || undefined,
          promptDetected: eofInteractive ? interactivePrompt : undefined,
          durationMs,
        },
      });
    };

    child.on('error', (err) => finalize(1, err.message));
    child.on('close', (code) => finalize(code));
  });
}

export async function startProcessTool(
  args: { processId?: string; command: string; cwd?: string },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const pm = ProcessManager.getInstance();
  const id = args.processId || `proc_${Date.now()}`;
  const cwd = args.cwd || ctx.workspaceRoot;

  if (ctx.requireApproval) {
    const approved = await ctx.requestApproval({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      toolCallId: `call_${Date.now()}`,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tool: 'start_process',
      args,
      description: `Start long-running background process: \`${args.command}\``,
      isDestructive: false,
    });

    if (!approved) {
      return { success: false, error: 'User rejected background process execution.' };
    }
  }

  try {
    const proc = pm.startProcess(id, args.command, cwd, buildWorkspaceCommandEnv(cwd), getPreferredShell());
    return {
      success: true,
      output: {
        processId: id,
        pid: proc.pid,
        command: args.command,
        status: 'running',
        startTime: proc.startTime,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function readOutputTool(
  args: { processId: string; tailLines?: number },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  const pm = ProcessManager.getInstance();
  const p = pm.getProcess(args.processId);
  if (!p) {
    return { success: false, error: `Process ID '${args.processId}' not found.` };
  }
  const lines = pm.readOutput(args.processId, args.tailLines || 50);
  return {
    success: true,
    output: {
      processId: args.processId,
      status: p.status,
      exitCode: p.exitCode,
      lines,
      output: lines.join('\n'),
    },
  };
}

export async function writeStdinTool(
  args: { processId: string; input: string },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  const pm = ProcessManager.getInstance();
  const success = pm.writeStdin(args.processId, args.input);
  if (success) {
    await new Promise((r) => setTimeout(r, 120));
  }
  const proc = pm.getProcess(args.processId);
  const recentLines = success ? pm.readOutput(args.processId, 15) : [];
  return {
    success,
    output: {
      processId: args.processId,
      sent: success,
      status: proc?.status,
      recentOutput: recentLines.join('\n'),
    },
    error: success ? undefined : `Failed to write stdin to process '${args.processId}' (not running or no stdin).`,
  };
}

export async function terminateProcessTool(
  args: { processId: string },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  const pm = ProcessManager.getInstance();
  const terminated = pm.terminateProcess(args.processId);
  return {
    success: terminated,
    output: { processId: args.processId, terminated },
    error: terminated ? undefined : `Process ID '${args.processId}' not found.`,
  };
}

export async function listProcessesTool(
  _args: {},
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  const pm = ProcessManager.getInstance();
  const processes = pm.listProcesses();
  return {
    success: true,
    output: { processes },
  };
}

export async function listPortsTool(
  args: { checkPorts?: number[] },
  _ctx: ToolExecutionContext
): Promise<ToolResult> {
  const pm = ProcessManager.getInstance();
  const candidatePorts = args.checkPorts || [3000, 3001, 5000, 5173, 8000, 8080, 8888, 4200];
  const results: Record<number, boolean> = {};

  for (const port of candidatePorts) {
    results[port] = await pm.checkPortListening(port);
  }

  const openPorts = Object.entries(results)
    .filter(([_, open]) => open)
    .map(([p]) => parseInt(p, 10));

  return {
    success: true,
    output: {
      checkedPorts: candidatePorts,
      openPorts,
      status: results,
    },
  };
}

export async function runTestsTool(args: { testPath?: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  const ws = ctx.workspaceRoot;
  const hasPkgJson = fs.existsSync(path.join(ws, 'package.json'));
  const hasPyFiles = fs.readdirSync(ws).some((f) => f.endsWith('.py') || f === 'requirements.txt' || f === 'pyproject.toml');

  let cmd: string;
  if (args.testPath) {
    if (args.testPath.endsWith('.py')) {
      cmd = `python3 -m unittest "${args.testPath}"`;
    } else if (hasPkgJson) {
      cmd = `npm test -- "${args.testPath}"`;
    } else {
      cmd = `python3 -m unittest "${args.testPath}"`;
    }
  } else if (hasPkgJson) {
    cmd = 'npm test';
  } else if (hasPyFiles) {
    cmd = 'python3 -m unittest discover -s . -p "*test*.py"';
  } else {
    cmd = 'npm test';
  }

  return runCommandTool({ command: cmd }, ctx);
}

export async function runBuildTool(_args: {}, ctx: ToolExecutionContext): Promise<ToolResult> {
  return runCommandTool({ command: 'npm run build' }, ctx);
}

export async function runLintTool(_args: {}, ctx: ToolExecutionContext): Promise<ToolResult> {
  return runCommandTool({ command: 'npm run lint' }, ctx);
}
