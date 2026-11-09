import * as fs from 'fs';
import * as path from 'path';
import { ToolDefinition, PermissionLevel, ToolAuditEvent } from '../tools/types';
import { ToolApprovalRequest } from '../agents/types';

export type SecurityMode = 'ask_every_time' | 'supervised' | 'autonomous' | 'restricted';

export class PermissionManager {
  private mode: SecurityMode = 'supervised';
  private sessionApprovals: Set<string> = new Set(); // toolName or toolName:sessionId
  private auditLog: ToolAuditEvent[] = [];
  private readonly maxAuditLogSize = 1000;
  private readonly auditLogPath: string;

  // Patterns for redacting sensitive secrets
  private readonly secretPatterns: RegExp[] = [
    /(password|passwd|pwd)[\s=:'"]+([^\s'"]+)/gi,
    /(api[_-]?key|apikey)[\s=:'"]+([^\s'"]+)/gi,
    /(secret|token|auth[_-]?token)[\s=:'"]+([^\s'"]+)/gi,
    /bearer\s+([a-zA-Z0-9_\-\.]{15,})/gi,
    /ghp_[a-zA-Z0-9]{36}/g, // GitHub personal access token
    /glpat-[a-zA-Z0-9\-]{20}/g, // GitLab token
    /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC )?PRIVATE KEY-----/g,
  ];

  constructor(private readonly workspaceRoot: string) {
    this.auditLogPath = path.join(workspaceRoot, '.localcoders', 'audit.log');
    this.ensureAuditDir();
  }

  public getMode(): SecurityMode {
    return this.mode;
  }

  public setMode(mode: SecurityMode): void {
    this.mode = mode;
  }

  public isApprovalRequired(tool: ToolDefinition, sessionId?: string): boolean {
    // 1. Restricted mode: everything other than read is blocked/requires approval
    if (this.mode === 'restricted') {
      return tool.permissionLevel !== 'read';
    }

    // 2. Ask Every Time mode: everything requires approval except harmless meta-reads
    if (this.mode === 'ask_every_time') {
      return true;
    }

    // 3. Check session or tool approvals granted by user
    if (this.sessionApprovals.has(tool.name)) {
      // Destructive tools always require confirmation
      if (tool.permissionLevel === 'destructive') return true;
      return false;
    }
    if (sessionId && this.sessionApprovals.has(`${tool.name}:${sessionId}`)) {
      if (tool.permissionLevel === 'destructive') return true;
      return false;
    }

    // 4. Autonomous mode: only destructive actions require approval
    if (this.mode === 'autonomous') {
      return tool.permissionLevel === 'destructive';
    }

    // 5. Supervised mode (default):
    // Read: allowed
    // Write / Execute / Network / Destructive: require approval
    return tool.permissionLevel !== 'read';
  }

  public grantSessionApproval(toolName: string, sessionId?: string): void {
    if (sessionId) {
      this.sessionApprovals.add(`${toolName}:${sessionId}`);
    } else {
      this.sessionApprovals.add(toolName);
    }
  }

  public clearApprovals(): void {
    this.sessionApprovals.clear();
  }

  public recordEvent(event: ToolAuditEvent): void {
    const sanitizedEvent: ToolAuditEvent = {
      ...event,
      argsSummary: this.redact(event.argsSummary),
      error: event.error ? this.redact(event.error) : undefined,
    };

    this.auditLog.push(sanitizedEvent);
    if (this.auditLog.length > this.maxAuditLogSize) {
      this.auditLog.shift();
    }

    this.persistEvent(sanitizedEvent);
  }

  public getAuditHistory(limit: number = 100): ToolAuditEvent[] {
    return this.auditLog.slice(-limit);
  }

  public redact(text: string): string {
    if (!text || typeof text !== 'string') return text;
    let result = text;
    for (const pattern of this.secretPatterns) {
      result = result.replace(pattern, (match, p1, p2) => {
        if (p2) {
          return match.replace(p2, '***REDACTED***');
        }
        return '***REDACTED_SECRET***';
      });
    }
    return result;
  }

  private ensureAuditDir(): void {
    try {
      const dir = path.dirname(this.auditLogPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch {
      // ignore
    }
  }

  private persistEvent(event: ToolAuditEvent): void {
    try {
      const line = JSON.stringify(event) + '\n';
      fs.appendFileSync(this.auditLogPath, line, 'utf-8');
    } catch {
      // ignore write errors in sandbox
    }
  }
}
