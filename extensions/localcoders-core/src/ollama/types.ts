// Ollama Integration Types

export interface OllamaModelDetails {
  parent_model?: string;
  format: string;
  family: string;
  families?: string[];
  parameter_size: string;
  quantization_level: string;
  context_length?: number;
  embedding_length?: number;
}

export interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details: OllamaModelDetails;
  capabilities?: string[];
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
  popular?: boolean;
  featured?: boolean;
}

export interface OllamaPullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  percent?: number;
  error?: string;
}

export interface HardwareInfo {
  os: string;
  platform: string;
  cpu: {
    model: string;
    cores: number;
  };
  ram: {
    totalBytes: number;
    availableBytes: number;
    usedBytes: number;
    totalGb: number;
    availableGb: number;
  };
  gpu?: {
    name: string;
    memoryTotalMb: number;
    memoryFreeMb: number;
  };
  ollamaInstalled: boolean;
  ollamaRunning: boolean;
  ollamaVersion?: string;
}

export interface OllamaShowResponse {
  thinking?: {
    values?: Array<boolean | string>;
    default?: boolean | string;
  };
  capabilities?: string[];
  parameters?: string;
  details?: Partial<OllamaModelDetails>;
  model_info?: Record<string, any>;
  projector_info?: Record<string, any>;
  modified_at?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  tool_calls?: any[];
  tool_name?: string;
}
