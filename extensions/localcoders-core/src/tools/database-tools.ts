import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fsSync from 'fs';
import { ToolExecutionContext, ToolResult } from './types';

const execAsync = promisify(exec);

async function runPythonScript(pythonCode: string): Promise<{ stdout: string; stderr: string }> {
  const b64 = Buffer.from(pythonCode, 'utf-8').toString('base64');
  return await execAsync(`python3 -c "import base64; exec(base64.b64decode('${b64}').decode('utf-8'))"`);
}

export type DatabaseProvider = 'sqlite' | 'postgres' | 'mysql';

function isMutationQuery(sql: string): boolean {
  const normalized = sql.trim().toUpperCase();
  const mutationKeywords = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'REPLACE'];
  return mutationKeywords.some((kw) => normalized.startsWith(kw) || normalized.includes(` ${kw} `));
}

export async function databaseListTablesTool(
  args: { provider?: DatabaseProvider; databasePath?: string; connectionString?: string },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const provider = args.provider || 'sqlite';
  try {
    if (provider === 'sqlite') {
      const dbPath = path.resolve(ctx.workspaceRoot, args.databasePath || 'database.sqlite');
      if (!fsSync.existsSync(dbPath)) {
        return { success: false, error: `SQLite database file not found at: '${dbPath}'` };
      }
      const pyCode = `
import sqlite3, json
conn = sqlite3.connect(${JSON.stringify(dbPath)})
cur = conn.cursor()
cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
tables = [r[0] for r in cur.fetchall()]
print(json.dumps(tables))
`;
      const { stdout } = await runPythonScript(pyCode);
      const tables = JSON.parse(stdout.trim());
      return { success: true, output: { provider, databasePath: path.relative(ctx.workspaceRoot, dbPath), tables } };
    }

    if (provider === 'postgres' && args.connectionString) {
      const { stdout } = await execAsync(
        `psql "${args.connectionString}" -t -A -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';"`
      );
      const tables = stdout.trim().split('\n').filter(Boolean);
      return { success: true, output: { provider, tables } };
    }

    return { success: false, error: `Unsupported database provider or missing configuration: ${provider}` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function databaseDescribeTableTool(
  args: { table: string; provider?: DatabaseProvider; databasePath?: string; connectionString?: string },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const provider = args.provider || 'sqlite';
  try {
    if (provider === 'sqlite') {
      const dbPath = path.resolve(ctx.workspaceRoot, args.databasePath || 'database.sqlite');
      const pyCode = `
import sqlite3, json
conn = sqlite3.connect(${JSON.stringify(dbPath)})
cur = conn.cursor()
tbl = ${JSON.stringify(args.table)}
cur.execute(f"PRAGMA table_info('{tbl}')")
cols = [{'cid': r[0], 'name': r[1], 'type': r[2], 'notnull': r[3], 'dflt_value': r[4], 'pk': r[5]} for r in cur.fetchall()]
print(json.dumps(cols))
`;
      const { stdout } = await runPythonScript(pyCode);
      const columns = JSON.parse(stdout.trim());
      return { success: true, output: { table: args.table, columns } };
    }
    return { success: false, error: `Provider '${provider}' table description requires additional connection credentials.` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function databaseQueryReadonlyTool(
  args: { query: string; provider?: DatabaseProvider; databasePath?: string; limit?: number },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  if (isMutationQuery(args.query)) {
    return {
      success: false,
      error: 'Security Warning: database.query_readonly rejected mutation statement. Use database.execute for schema and data modifications.',
    };
  }

  const provider = args.provider || 'sqlite';
  try {
    if (provider === 'sqlite') {
      const dbPath = path.resolve(ctx.workspaceRoot, args.databasePath || 'database.sqlite');
      if (!fsSync.existsSync(dbPath)) {
        return { success: false, error: `SQLite database file not found at: '${dbPath}'` };
      }
      const limit = args.limit || 100;
      const pyCode = `
import sqlite3, json
conn = sqlite3.connect(${JSON.stringify(dbPath)})
conn.row_factory = sqlite3.Row
cur = conn.cursor()
cur.execute(${JSON.stringify(args.query)})
rows = [dict(r) for r in cur.fetchmany(${limit})]
print(json.dumps(rows))
`;
      const { stdout } = await runPythonScript(pyCode);
      const rows = JSON.parse(stdout.trim());
      return { success: true, output: { rowCount: rows.length, rows } };
    }
    return { success: false, error: `Provider '${provider}' query requires connection adapter.` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function databaseExecuteTool(
  args: { query: string; provider?: DatabaseProvider; databasePath?: string },
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  if (ctx.requireApproval) {
    const isDestructive =
      args.query.toUpperCase().includes('DROP TABLE') ||
      args.query.toUpperCase().includes('TRUNCATE') ||
      args.query.toUpperCase().includes('DROP DATABASE');

    if (ctx && typeof ctx.requestApproval === 'function') {
      const approved = await ctx.requestApproval({
        id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        toolCallId: `call_${Date.now()}`,
        agentId: ctx.agentId,
        agentName: ctx.agentName,
        tool: 'database.execute',
        args,
        description: `Execute database statement: \`${args.query.substring(0, 80)}\``,
        isDestructive,
      });
      if (!approved) return { success: false, error: 'User rejected database mutation execution.' };
    }
  }

  const provider = args.provider || 'sqlite';
  try {
    if (provider === 'sqlite') {
      const dbPath = path.resolve(ctx.workspaceRoot, args.databasePath || 'database.sqlite');
      const pyCode = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(dbPath)})
cur = conn.cursor()
cur.executescript(${JSON.stringify(args.query)})
conn.commit()
print('COMMITTED')
`;
      const { stdout } = await runPythonScript(pyCode);
      return { success: true, output: { executed: true, summary: stdout.trim() } };
    }
    return { success: false, error: `Provider '${provider}' execution not configured.` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
