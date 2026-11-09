import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolExecutionContext, ToolResult } from './types';

export async function searchCodebaseTool(
  args: { query: string; caseSensitive?: boolean; maxResults?: number },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const query = args.query;
  const isCase = args.caseSensitive || false;
  const max = args.maxResults || 50;
  const matches: Array<{ file: string; line: number; text: string }> = [];

  async function walk(dir: string) {
    if (matches.length >= max) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (
        entry.name === '.git' ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === '.localcoders' ||
        entry.name === '.cache'
      ) {
        continue;
      }

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        try {
          const stat = await fs.stat(full);
          if (stat.size > 2 * 1024 * 1024) continue; // skip > 2MB

          const content = await fs.readFile(full, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const found = isCase ? line.includes(query) : line.toLowerCase().includes(query.toLowerCase());
            if (found) {
              matches.push({
                file: path.relative(ctx.workspaceRoot, full),
                line: i + 1,
                text: line.trim(),
              });
              if (matches.length >= max) break;
            }
          }
        } catch {
          // Ignore binary or unreadable files
        }
      }
    }
  }

  try {
    await walk(ctx.workspaceRoot);
    return {
      success: true,
      output: {
        query,
        count: matches.length,
        results: matches,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function searchSymbolsTool(args: { query: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  const query = args.query.toLowerCase();
  const results: Array<{ symbol: string; kind: string; file: string; line: number }> = [];
  const symbolRegex = /(?:class|interface|function|type|const|let|def|fn|struct|enum)\s+([A-Za-z0-9_$]+)/g;

  async function walk(dir: string) {
    if (results.length >= 50) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (/\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|cs)$/i.test(entry.name)) {
        try {
          const text = await fs.readFile(full, 'utf-8');
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let match;
            while ((match = symbolRegex.exec(line)) !== null) {
              const name = match[1];
              if (name.toLowerCase().includes(query)) {
                let kind = 'variable';
                if (line.includes('class ')) kind = 'class';
                else if (line.includes('interface ')) kind = 'interface';
                else if (line.includes('function ') || line.includes('def ') || line.includes('fn ')) kind = 'function';
                else if (line.includes('type ')) kind = 'type';
                else if (line.includes('enum ')) kind = 'enum';

                results.push({
                  symbol: name,
                  kind,
                  file: path.relative(ctx.workspaceRoot, full),
                  line: i + 1,
                });
                if (results.length >= 50) break;
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }
  }

  try {
    await walk(ctx.workspaceRoot);
    return { success: true, output: { query: args.query, count: results.length, results } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function inspectDiagnosticsTool(args: { path?: string }, ctx: ToolExecutionContext): Promise<ToolResult> {
  try {
    const allDiags = vscode.languages.getDiagnostics();
    const formatted: Array<{ file: string; severity: string; message: string; line: number }> = [];

    for (const [uri, diags] of allDiags) {
      const relPath = path.relative(ctx.workspaceRoot, uri.fsPath);
      if (args.path && !relPath.includes(args.path)) continue;

      for (const d of diags) {
        let severity = 'Info';
        if (d.severity === vscode.DiagnosticSeverity.Error) severity = 'Error';
        else if (d.severity === vscode.DiagnosticSeverity.Warning) severity = 'Warning';

        formatted.push({
          file: relPath,
          severity,
          message: d.message,
          line: d.range.start.line + 1,
        });
      }
    }

    return {
      success: true,
      output: {
        totalDiagnostics: formatted.length,
        errors: formatted.filter((d) => d.severity === 'Error').length,
        warnings: formatted.filter((d) => d.severity === 'Warning').length,
        diagnostics: formatted.slice(0, 50),
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
