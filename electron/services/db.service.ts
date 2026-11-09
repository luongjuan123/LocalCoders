import initSqlJs, { Database } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export class DbService {
  private db: Database | null = null;
  private dbPath: string;

  constructor() {
    const dataDir = path.join(os.homedir(), '.localcoders');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.dbPath = path.join(dataDir, 'localcoders.sqlite');
  }

  async init(): Promise<void> {
    const SQL = await initSqlJs();
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
      this.initSchema();
      this.persist();
    }
  }

  private initSchema() {
    if (!this.db) return;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT,
        role TEXT,
        model TEXT,
        config TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender_id TEXT,
        sender_name TEXT,
        sender_role TEXT,
        content TEXT,
        thinking TEXT,
        task_id TEXT,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT,
        status TEXT,
        data TEXT,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS critic_reports (
        id TEXT PRIMARY KEY,
        verdict TEXT,
        summary TEXT,
        findings TEXT,
        created_at INTEGER
      );
    `);
  }

  persist() {
    if (!this.db) return;
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  getSetting(key: string): string | null {
    if (!this.db) return null;
    const res = this.db.exec(`SELECT value FROM settings WHERE key = '${key}'`);
    if (res.length > 0 && res[0].values.length > 0) {
      return res[0].values[0][0] as string;
    }
    return null;
  }

  setSetting(key: string, value: string) {
    if (!this.db) return;
    const escKey = key.replace(/'/g, "''");
    const escVal = value.replace(/'/g, "''");
    this.db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('${escKey}', '${escVal}')`);
    this.persist();
  }

  getAgents(): any[] {
    if (!this.db) return [];
    const res = this.db.exec(`SELECT config FROM agents`);
    if (res.length > 0) {
      return res[0].values.map((v) => JSON.parse(v[0] as string));
    }
    return [];
  }

  saveAgent(agent: any) {
    if (!this.db) return;
    const json = JSON.stringify(agent).replace(/'/g, "''");
    this.db.run(`INSERT OR REPLACE INTO agents (id, name, role, model, config) VALUES ('${agent.id}', '${agent.name}', '${agent.role}', '${agent.model}', '${json}')`);
    this.persist();
  }

  saveMessage(msg: any) {
    if (!this.db) return;
    const content = (msg.content || '').replace(/'/g, "''");
    const thinking = (msg.thinking || '').replace(/'/g, "''");
    this.db.run(`INSERT OR REPLACE INTO messages VALUES ('${msg.id}', '${msg.senderId}', '${msg.senderName}', '${msg.senderRole}', '${content}', '${thinking}', '${msg.taskId || ''}', ${msg.timestamp || Date.now()})`);
    this.persist();
  }

  getMessages(limit: number = 50): any[] {
    if (!this.db) return [];
    const res = this.db.exec(`SELECT id, sender_id, sender_name, sender_role, content, thinking, task_id, created_at FROM messages ORDER BY created_at ASC LIMIT ${limit}`);
    if (res.length > 0) {
      return res[0].values.map((row) => ({
        id: row[0],
        senderId: row[1],
        senderName: row[2],
        senderRole: row[3],
        content: row[4],
        thinking: row[5],
        taskId: row[6],
        timestamp: row[7],
      }));
    }
    return [];
  }
}
