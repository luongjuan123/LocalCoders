// LocalCoders Types

export type PredefinedRole =
  | 'Frontend Developer'
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

export interface CriticFinding {
  id: string;
  severity: FindingSeverity;
  category: string;
  filePath: string;
  lineRange?: string;
  evidence: string;
  explanation: string;
  reproduction: string;
  recommendedFix: string;
  confidence: string;
  resolved: boolean;
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
  assignedTo: string;
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
  senderId: string;
  senderName: string;
  senderRole: 'user' | 'assistant' | 'system' | 'critic';
  content: string;
  thinking?: string;
  timestamp: number;
  taskId?: string;
}

export interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details: {
    format: string;
    family: string;
    parameter_size: string;
    quantization_level: string;
  };
}

export interface OllamaCatalogueItem {
  name: string;
  tag: string;
  description: string;
  category: 'coding' | 'reasoning' | 'general' | 'vision';
  parameters: string;
  size: string;
  minRamGb: number;
  installed: boolean;
}

export interface HardwareInfo {
  os: string;
  platform: string;
  cpu: { model: string; cores: number };
  ram: { totalGb: number; availableGb: number };
  gpu?: { name: string; memoryTotalMb: number };
  ollamaInstalled: boolean;
  ollamaRunning: boolean;
  ollamaVersion?: string;
}

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  size?: number;
}

export interface EditorTab {
  id: string;
  path: string;
  title: string;
  isDirty: boolean;
  content: string;
  language: string;
  isDiff?: boolean;
  diffOriginal?: string;
  diffModified?: string;
}

export interface GitStatus {
  branch: string;
  isRepo: boolean;
  staged: string[];
  modified: string[];
  untracked: string[];
}
