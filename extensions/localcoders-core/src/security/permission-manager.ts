import * as fs from 'fs';
import * as path from 'path';
import { ToolDefinition, ToolAuditEvent } from '../tools/types';
import { PermissionMode } from '../sessions/session-manager';

export type SecurityMode = 'ask' | 'smart' | 'bypass' | 'ask_every_time' | 'supervised' | 'autonomous' | 'restricted';

export class PermissionManager {
  private mode: SecurityMode = 'supervised';
  private sessionApprovals: Set<string> = new Set(); // toolName or toolName:sessionId
  private auditLog: ToolAuditEvent[] = [];
  private readonly maxAuditLogSize = 1000;
  private auditLogPath: string;
  private workspaceRoot: string;

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

  // Commands or patterns strictly prohibited even under Bypass Permissions mode (hard safety boundaries)
  private readonly dangerousPatterns: RegExp[] = [
    /rm\s+-rf\s+(\/|~|\$HOME|\.\.)/i,
    /mkfs(\.[a-z0-9]+)?\s+/i,
    /dd\s+if=.*of=\/dev\/(sd[a-z]|nvme)/i,
    /:(){ :\|:& };:/, // Fork bomb
    /DROP\s+(DATABASE|SCHEMA)\s+/i,
    />\s*\/dev\/(sd[a-z]|nvme)/i,
    /chmod\s+-R\s+777\s+\//i,
  ];

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.auditLogPath = path.join(workspaceRoot, '.localcoders', 'audit.log');
    this.ensureAuditDir();
  }

  public setWorkspace(root: string): void {
    this.workspaceRoot = root;
    this.auditLogPath = path.join(root, '.localcoders', 'audit.log');
    this.ensureAuditDir();
  }

  public getMode(): SecurityMode {
    return this.mode;
  }

  public setMode(mode: SecurityMode | PermissionMode): void {
    this.mode = mode as SecurityMode;
  }

  public isApprovalRequired(tool: ToolDefinition, sessionId?: string, rawCommandOrArgs?: any): boolean {
    const activeMode = this.getNormalizedMode();

    // 1. Ask Before Actions / Ask Every Time mode:
    if (activeMode === 'ask') {
      if (this.mode === 'ask_every_time' || this.mode === 'restricted') return true;
      if (tool.permissionLevel === 'read') return false; // Harmless file reads don't prompt in ask mode
      return true;
    }

    // 2. Hard safety boundaries check (always enforced across all modes including Bypass Permissions)
    if (this.isStrictlyProhibited(rawCommandOrArgs)) {
      return true; // Must pause for explicit critical confirmation
    }

    // 3. User granted explicit approval for this tool or session
    if (this.sessionApprovals.has(tool.name)) {
      if (tool.permissionLevel === 'destructive') return true;
      return false;
    }
    if (sessionId && this.sessionApprovals.has(`${tool.name}:${sessionId}`)) {
      if (tool.permissionLevel === 'destructive') return true;
      return false;
    }

    // 4. Bypass Permissions mode:
    // Auto-approve all tool calls unless organizational policy requires approval or destructive
    if (activeMode === 'bypass') {
      return tool.permissionLevel === 'destructive';
    }

    // 5. Smart Approval mode (default):
    // - Read / search / safe inspections: auto-approved
    // - Write / execute / network / destructive: require approval according to policy
    if (tool.permissionLevel === 'read') {
      return false;
    }

    return true;
  }

  public isStrictlyProhibited(payload?: any): boolean {
    if (!payload) return false;
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return this.dangerousPatterns.some((pattern) => pattern.test(str));
  }

  public getNormalizedMode(): 'ask' | 'smart' | 'bypass' {
    if (this.mode === 'ask' || this.mode === 'ask_every_time' || this.mode === 'restricted') return 'ask';
    if (this.mode === 'bypass' || this.mode === 'autonomous') return 'bypass';
    return 'smart';
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
    } catch (e) {
      console.error('[PermissionManager] Failed to create audit log dir:', e);
    }
  }

  private persistEvent(event: ToolAuditEvent): void {
    try {
      this.ensureAuditDir();
      const line = JSON.stringify(event) + '\n';
      fs.appendFileSync(this.auditLogPath, line, 'utf-8');
    } catch (e) {
      console.error('[PermissionManager] Failed to persist audit event:', e);
    }
  }
}
