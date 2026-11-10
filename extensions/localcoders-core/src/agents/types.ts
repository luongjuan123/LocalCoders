// Multi-Agent Architecture Types

export type PredefinedRole =
  | 'Frontend Developer'
  | 'UI/UX Designer'
  | 'Component Specialist'
  | 'Backend Developer'
  | 'Software Architect'
  | 'Database Engineer'
  | 'Debugging Specialist'
  | 'Test Engineer'
  | 'Security Auditor'
  | 'Performance Engineer'
  | 'Documentation Writer'
  | 'Research Agent'
  | 'Refactoring Specialist'
  | 'Custom';

export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'planning'
  | 'working'
  | 'delegating'
  | 'waiting_approval'
  | 'reviewing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentConfig {
  id: string;
  name: string;
  role: PredefinedRole | string;
  model: string;
  systemPrompt: string;
  enabled: boolean;
  maxConcurrency: number;
  temperature: number;
  contextWindow: number;
}

export type CriticStrictness = 'lenient' | 'moderate' | 'strict' | 'paranoid';
export type CriticReviewMode = 'changed_files' | 'entire_project' | 'security_architecture';

export interface CriticConfig {
  enabled: boolean;
  model: string;
  strictness: CriticStrictness;
  categories: string[];
  trigger: 'on_diff' | 'manual' | 'pre_commit';
  reviewMode: CriticReviewMode;
}

export type FindingSeverity = 'Critical' | 'High' | 'Medium' | 'Low' | 'Informational';
export type FindingConfidence = 'Confirmed' | 'Likely' | 'Needs verification';

export interface CriticFinding {
  id: string;
  severity: FindingSeverity;
  category: string;
  filePath: string;
  lineRange?: string;
  lineNumber?: number;
  evidence: string;
  explanation: string;
  reproduction: string;
  recommendedFix: string;
  confidence: FindingConfidence;
  resolved: boolean;
  resolvedBy?: string;
}

export interface CriticReport {
  id: string;
  timestamp: number;
  targetCommit?: string;
  filesReviewed: string[];
  findings: CriticFinding[];
  summary: string;
  verdict: 'approved' | 'changes_requested' | 'blocker';
}

export interface TaskPlanItem {
  id: string;
  title: string;
  description: string;
  assignedTo: string; // 'main' or subagent ID
  dependencies: string[];
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  output?: string;
  affectedFiles: string[];
  startTime?: number;
  endTime?: number;
}

export interface AgentTask {
  id: string;
  title: string;
  userPrompt: string;
  plan: TaskPlanItem[];
  status: 'idle' | 'running' | 'completed' | 'failed' | 'paused' | 'cancelled';
  criticReport?: CriticReport;
  createdAt: number;
  updatedAt: number;
}

export interface ToolCall {
  id: string;
  tool: string;
  args: Record<string, any>;
  result?: any;
  error?: string;
  status: 'pending' | 'requires_approval' | 'approved' | 'rejected' | 'running' | 'completed' | 'failed';
  diffPreview?: string;
  agentId?: string;
}

export interface ToolApprovalRequest {
  id: string;
  toolCallId: string;
  agentId: string;
  agentName: string;
  tool: string;
  args: Record<string, any>;
  description: string;
  isDestructive: boolean;
  proposedDiff?: string;
  filePath?: string;
}

export interface AgentMessage {
  id: string;
  senderId: string; // 'user' | agentId | 'critic' | 'system'
  senderName: string;
  senderRole: 'user' | 'assistant' | 'system' | 'critic';
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  timestamp: number;
  taskId?: string;
}

export interface AgentActivityEvent {
  agentId: string;
  agentName: string;
  status: AgentStatus;
  currentTask?: string;
  currentTool?: string;
  latestActivity: string;
  timestamp: number;
  error?: string;
}
