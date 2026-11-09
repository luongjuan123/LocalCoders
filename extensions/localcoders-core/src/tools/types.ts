import { ToolApprovalRequest, ToolCall } from '../agents/types';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface ToolExecutionContext {
  workspaceRoot: string;
  agentId: string;
  agentName: string;
  taskId?: string;
  requireApproval: boolean;
  requestApproval: (req: ToolApprovalRequest) => Promise<boolean>;
}

export interface ToolResult {
  success: boolean;
  output?: any;
  error?: string;
  diffPreview?: string;
}
