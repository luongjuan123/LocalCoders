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
    /rm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\$HOME|\.\.|\/etc|\/usr|\/var)/i,
    /mkfs(\.[a-z0-9]+)?\s+/i,
    /dd\s+if=.*of=\/dev\/(sd[a-z]|nvme)/i,
    /:(){ :\|:& };:/, // Fork bomb
    /DROP\s+(DATABASE|SCHEMA)\s+/i,
    />\s*\/dev\/(sd[a-z]|nvme)/i,
    /chmod\s+-R\s+777\s+\//i,
    /(?:cat|less|head|tail|cp|mv|scp|curl|wget)[^;\n]*(?:\/etc\/shadow|\/etc\/sudoers|~\/\.ssh\/id_|\/\.ssh\/id_)/i,
    /(?:^|["'\/\s])(?:\.env(?:\.(?:local|prod|production|staging|dev|development))?|\.ssh\/id_[a-z0-9_.-]+|\.aws\/credentials)(?:$|["'\s])/i,
    /\bsudo\s+/i,
    /(?:curl|wget)\s+[^\n|]+\|\s*(?:sh|bash|zsh)\b/i,
    /(?:ghp_[a-zA-Z0-9]{20,}|glpat-[a-zA-Z0-9\-]{15,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i,
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

    // 5. Smart Approval mode (default / auto-approve safe workspace policy):
    // - Auto-approves reads, workspace file edits, and non-destructive workspace commands
    // - Prompts on destructive tools, risky commands, or sensitive paths
    if (tool.permissionLevel === 'destructive') {
      return true;
    }
    if (this.isRiskySmartCommand(rawCommandOrArgs)) {
      return true;
    }
    if (tool.permissionLevel === 'read' || this.isSafePolicyTool(tool)) {
      return false;
    }

    return true;
  }

  public isRiskySmartCommand(payload?: any): boolean {
    if (!payload) return false;
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const riskyPatterns: RegExp[] = [
      /\brm\s+(-[a-z]*[rf][a-z]*\b|--recursive\b|--force\b)/i,
      /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\s+.*(?:--force|-f\b))/i,
      /\b(?:kill|pkill|killall)\s+-9\b/i,
      /\b(?:shutdown|reboot|poweroff|halt)\b/i,
    ];
    return riskyPatterns.some((pattern) => pattern.test(str));
  }

  public isSafePolicyTool(tool: ToolDefinition): boolean {
    if (tool.permissionLevel === 'read') return true;
    const safeNames = new Set([
      'search_codebase',
      'search_symbols',
      'inspect_diagnostics',
      'read_file',
      'read_lines',
      'list_directory',
      'get_metadata',
      'get_project_structure',
      'git_status',
      'inspect_git_status',
      'read_git_diff',
      'git_log',
      'git_show',
      'create_checkpoint',
      'write_file',
      'edit_file',
      'create_file',
      'mkdir',
      'copy_file',
      'rename_file',
      'stage_file',
      'git_commit',
      'git_branch',
      'git_checkout',
      'run_command',
      'run_tests',
      'run_build',
      'run_lint',
      'start_process',
      'write_stdin',
      'read_output',
      'terminate_process',
      'list_processes',
      'app.launch',
      'app.open_url',
      'app.open_file',
    ]);
    return safeNames.has(tool.name);
  }

  public getModeSummary(): { rawMode: SecurityMode; normalizedMode: 'ask' | 'smart' | 'bypass'; label: string; policy: string } {
    const norm = this.getNormalizedMode();
    if (norm === 'bypass') {
      return {
        rawMode: this.mode,
        normalizedMode: 'bypass',
        label: 'Bypass Permissions',
        policy: 'Supported file edits, tool calls, and terminal commands auto-approve; hard safety rules still guard secrets, OS paths, and destructive actions.',
      };
    }
    if (norm === 'ask') {
      return {
        rawMode: this.mode,
        normalizedMode: 'ask',
        label: 'Normal (Ask Before Actions)',
        policy: 'Harmless reads auto-approve; file writes, terminal commands, network calls, and destructive actions require confirmation.',
      };
    }
    return {
      rawMode: this.mode,
      normalizedMode: 'smart',
      label: 'Smart Approval (Safe Policy)',
      policy: 'Safe inspections and read-only operations auto-approve; modifications and command executions require approval.',
    };
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
