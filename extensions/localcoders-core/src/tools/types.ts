import { ToolApprovalRequest, ToolCall } from '../agents/types';

export type ToolCategory =
  | 'filesystem'
  | 'terminal'
  | 'app'
  | 'browser'
  | 'computer_use'
  | 'git'
  | 'docker'
  | 'database'
  | 'http'
  | 'mcp'
  | 'custom';

export type PermissionLevel = 'read' | 'write' | 'execute' | 'network' | 'destructive';

export type ExecutionEnvironment = 'native' | 'container' | 'worktree' | 'isolated';

export interface ToolDefinition {
  name: string;
  id?: string;
  category: ToolCategory;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  outputSchema?: Record<string, any>;
  permissionLevel: PermissionLevel;
  timeoutMs?: number;
  supportedRoles?: string[];
  environment?: ExecutionEnvironment;
}

export interface ToolExecutionContext {
  workspaceRoot: string;
  agentId: string;
  agentName: string;
  agentRole?: string;
  taskId?: string;
  requireApproval: boolean;
  requestApproval: (req: ToolApprovalRequest) => Promise<boolean>;
  logEvent?: (event: ToolAuditEvent) => void;
  redactSecrets?: (input: string) => string;
}

export interface ToolResult {
  success: boolean;
  output?: any;
  error?: string;
  diffPreview?: string;
  metadata?: Record<string, any>;
}

export interface ToolAuditEvent {
  id: string;
  toolName: string;
  category: ToolCategory;
  agentId: string;
  agentName: string;
  sessionId?: string;
  taskId?: string;
  argsSummary: string;
  environment: ExecutionEnvironment;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'waiting_for_approval';
  exitCode?: number;
  error?: string;
  approved?: boolean;
}
