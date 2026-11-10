import { AgentMessage, AgentStatus, TaskPlanItem } from './types';

export type ExecutionEventCategory =
  | 'thinking_summary'
  | 'command'
  | 'tool'
  | 'file'
  | 'mcp'
  | 'browser'
  | 'subagent'
  | 'status';

export type ExecutionEventStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'waiting_approval';

export interface ExecutionActivityItem {
  id: string;
  runId: string;
  category: ExecutionEventCategory;
  agentId: string;
  agentName: string;
  agentRole?: string;
  toolName?: string;
  title: string;
  summary: string;
  command?: string;
  cwd?: string;
  filePath?: string;
  status: ExecutionEventStatus;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  processId?: string;
  metadata?: Record<string, any>;
  timestamp: number;
}

export type SafeAgentPhase =
  | 'working'
  | 'analyzing'
  | 'planning'
  | 'generating'
  | 'running_commands'
  | 'waiting_tool'
  | 'verifying'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentStreamStatusEvent {
  kind: 'status';
  id: string;
  runId: string;
  agentId: string;
  agentName: string;
  phase: SafeAgentPhase;
  summary: string;
  timestamp: number;
}

export interface AgentStreamMessageDeltaEvent {
  kind: 'message_delta';
  id: string;
  runId: string;
  messageId: string;
  agentId: string;
  agentName: string;
  senderRole: 'assistant' | 'critic' | 'system';
  deltaContent: string;
  fullContent: string;
  timestamp: number;
}

export interface AgentStreamMessageCompleteEvent {
  kind: 'message_complete';
  id: string;
  runId: string;
  message: AgentMessage;
  timestamp: number;
}

export interface AgentStreamActivityUpsertEvent {
  kind: 'activity_upsert';
  id: string;
  runId: string;
  item: ExecutionActivityItem;
  timestamp: number;
}

export interface AgentStreamPlanEvent {
  kind: 'plan';
  id: string;
  runId: string;
  plan: TaskPlanItem[];
  explicit: boolean;
  timestamp: number;
}

export type AgentStreamEvent =
  | AgentStreamStatusEvent
  | AgentStreamMessageDeltaEvent
  | AgentStreamMessageCompleteEvent
  | AgentStreamActivityUpsertEvent
  | AgentStreamPlanEvent;

const SAFE_PHASE_LABELS: Record<SafeAgentPhase, string> = {
  working: 'Agent is working',
  analyzing: 'Analyzing the task',
  planning: 'Planning approach',
  generating: 'Generating code',
  running_commands: 'Running commands',
  waiting_tool: 'Waiting for a tool',
  verifying: 'Verifying changes',
  waiting_approval: 'Waiting for approval',
  completed: 'Completed',
  failed: 'Task failed',
  cancelled: 'Task cancelled',
};

export function getSafePhaseLabel(phase: SafeAgentPhase): string {
  return SAFE_PHASE_LABELS[phase] || 'Agent is working';
}

/**
 * Strips raw internal reasoning tags (<think>...</think>) and embedded tool JSON blocks
 * so private chain-of-thought and tool payloads are never rendered as assistant chat prose.
 */
export function sanitizeAssistantContent(raw: string): string {
  if (!raw) return '';
  let text = String(raw);
  // Remove complete <think>...</think> and <analysis>...</analysis> blocks
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  text = text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '');
  // Remove incomplete trailing <think>... during live streaming
  const openThinkIdx = text.search(/<think>/i);
  if (openThinkIdx !== -1) {
    text = text.slice(0, openThinkIdx);
  }
  // Remove raw <tool_call>...</tool_call> tags during live streaming
  text = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');
  const openToolIdx = text.search(/<tool_call>/i);
  if (openToolIdx !== -1) {
    text = text.slice(0, openToolIdx);
  }
  return text.trimStart();
}

/**
 * Filters raw activity strings to prevent leaking internal chain-of-thought or token counters.
 * Returns a safe status summary instead of "Thinking: ..." or "Generating implementation (19 tokens)...".
 */
export function sanitizeActivityText(rawText: string, status?: AgentStatus): string {
  const txt = (rawText || '').trim();
  if (!txt) {
    if (status === 'planning') return getSafePhaseLabel('analyzing');
    if (status === 'reviewing') return getSafePhaseLabel('verifying');
    if (status === 'waiting_approval') return getSafePhaseLabel('waiting_approval');
    if (status === 'completed') return getSafePhaseLabel('completed');
    if (status === 'failed') return getSafePhaseLabel('failed');
    if (status === 'cancelled') return getSafePhaseLabel('cancelled');
    return getSafePhaseLabel('working');
  }

  // Filter raw token-by-token thinking/streaming telemetry and raw JSON tool-call lines
  if (
    /^(\[[^\]]+\]\s*)?Thinking:/i.test(txt) ||
    /^\[Thinking\]/i.test(txt) ||
    /^(\[[^\]]+\]\s*)?Generating implementation\s*\(\d+\s+tokens\)/i.test(txt) ||
    /^Formulating execution plan\s*\(\d+\s+tokens\)/i.test(txt)
  ) {
    return status === 'planning' || status === 'thinking'
      ? getSafePhaseLabel('analyzing')
      : getSafePhaseLabel('generating');
  }

  if (/^(\[[^\]]+\]\s*)?[a-zA-Z0-9_]+\(\{/.test(txt)) {
    return /run_(command|tests|build|lint)|start_process/i.test(txt)
      ? getSafePhaseLabel('running_commands')
      : getSafePhaseLabel('waiting_tool');
  }

  return txt;
}

/**
 * Classifies a tool invocation into a UI activity category.
 */
export function classifyToolCategory(toolName: string): ExecutionEventCategory {
  const n = (toolName || '').toLowerCase();
  if (n.startsWith('mcp__')) return 'mcp';
  if (n.startsWith('browser_')) return 'browser';
  if (
    n === 'run_command' ||
    n === 'run_tests' ||
    n === 'run_build' ||
    n === 'run_lint' ||
    n === 'start_process' ||
    n === 'terminate_process'
  ) {
    return 'command';
  }
  if (
    n === 'read_file' ||
    n === 'read_lines' ||
    n === 'write_file' ||
    n === 'create_file' ||
    n === 'edit_file' ||
    n === 'rename_file' ||
    n === 'delete_file' ||
    n === 'list_directory' ||
    n === 'list_files' ||
    n === 'get_project_structure' ||
    n === 'get_metadata'
  ) {
    return 'file';
  }
  return 'tool';
}

export function formatToolActivityTitle(toolName: string, args?: Record<string, any>): { title: string; summary: string; command?: string; filePath?: string } {
  const n = (toolName || '').toLowerCase();
  const safeArgs = args || {};
  const category = classifyToolCategory(n);

  if (category === 'command') {
    const cmd = String(
      safeArgs.command ||
        safeArgs.cmd ||
        safeArgs.script ||
        safeArgs.commandLine ||
        (n === 'run_tests' ? (safeArgs.testPath ? `Run tests (${safeArgs.testPath})` : 'Run test suite') : n === 'run_build' ? 'npm run build' : n === 'run_lint' ? 'npm run lint' : n)
    ).trim();
    return {
      title: 'Terminal Execution',
      summary: cmd,
      command: cmd,
    };
  }

  if (category === 'file') {
    const p = String(safeArgs.path || safeArgs.filePath || safeArgs.newPath || safeArgs.oldPath || '.');
    const actionLabel =
      n === 'write_file' || n === 'create_file'
        ? 'Write File'
        : n === 'edit_file'
        ? 'Edit File'
        : n === 'delete_file'
        ? 'Delete File'
        : n === 'rename_file'
        ? 'Rename File'
        : n === 'list_directory' || n === 'list_files' || n === 'get_project_structure'
        ? 'Inspect Directory'
        : 'Read File';
    return {
      title: actionLabel,
      summary: p,
      filePath: p,
    };
  }

  if (category === 'mcp') {
    const parts = toolName.split('__');
    const server = parts[1] || 'mcp';
    const method = parts.slice(2).join('__') || toolName;
    return {
      title: `MCP (${server})`,
      summary: method,
    };
  }

  if (category === 'browser') {
    return {
      title: 'Browser Action',
      summary: safeArgs.url ? `${toolName}: ${safeArgs.url}` : toolName,
    };
  }

  return {
    title: toolName || 'Tool Execution',
    summary: safeArgs.path || safeArgs.query || safeArgs.command || toolName,
  };
}

/**
 * Upserts an ExecutionActivityItem into an ordered activity array by unique item.id.
 * Prevents duplicate entries during live start -> output stream -> complete transitions.
 */
export function upsertActivityItem(
  list: ExecutionActivityItem[],
  incoming: ExecutionActivityItem,
  maxItems: number = 300
): ExecutionActivityItem[] {
  const next = [...list];
  const idx = next.findIndex((item) => item.id === incoming.id);
  if (idx !== -1) {
    const prev = next[idx];
    next[idx] = {
      ...prev,
      ...incoming,
      startTime: prev.startTime || incoming.startTime,
      command: incoming.command ?? prev.command,
      cwd: incoming.cwd ?? prev.cwd,
      filePath: incoming.filePath ?? prev.filePath,
      stdout: incoming.stdout !== undefined ? incoming.stdout : prev.stdout,
      stderr: incoming.stderr !== undefined ? incoming.stderr : prev.stderr,
    };
  } else {
    next.push(incoming);
    if (next.length > maxItems) {
      next.shift();
    }
  }
  return next;
}

/**
 * Finalizes any unfinished activity items when a run completes, fails, or is cancelled.
 */
export function finalizeRunningActivities(
  list: ExecutionActivityItem[],
  runId: string,
  terminalStatus: 'completed' | 'failed' | 'cancelled',
  now: number = Date.now()
): ExecutionActivityItem[] {
  return list.map((item) => {
    if (item.runId === runId && (item.status === 'running' || item.status === 'waiting_approval')) {
      return {
        ...item,
        status: terminalStatus,
        endTime: item.endTime || now,
        durationMs: item.durationMs ?? Math.max(0, now - item.startTime),
      };
    }
    return item;
  });
}

/**
 * Determines if a user explicitly asked for a plan, or execution mode is 'plan'.
 */
export function isPlanExplicitlyRequested(prompt: string, executionMode?: string): boolean {
  if (executionMode === 'plan') return true;
  const p = (prompt || '').toLowerCase();
  return /\b(plan|roadmap|steps|architecture plan|outline|design doc|implementation plan)\b/.test(p);
}

export type PromptIntent = 'greeting' | 'question' | 'coding_task' | 'plan';

const CONVERSATIONAL_GREETINGS = new Set([
  'hi',
  'hello',
  'hey',
  'yo',
  'hola',
  'howdy',
  'sup',
  'greetings',
  'good morning',
  'good afternoon',
  'good evening',
  'good night',
  'morning',
  'evening',
  'thanks',
  'thank you',
  'thx',
  'ty',
  'ok',
  'okay',
  'sure',
  'cool',
  'nice',
  'great',
  'awesome',
  'got it',
  'sounds good',
  'understood',
  'bye',
  'goodbye',
  'see you',
  'how are you',
  'how r u',
  'how is it going',
  'hows it going',
  'whats up',
  'what is up',
  'who are you',
  'what are you',
  'what can you do',
  'help',
  'ping',
  'test',
  'are you there',
  'are you ready',
  'are you working',
  'can you hear me',
  'do you understand',
  'do you understand me',
  'what model are you',
  'what is your name',
  'tell me about yourself',
  'can you help',
  'can you help me',
]);

const ACTION_MUTATION_REGEX =
  /\b(write|create|fix|implement|add|modify|change|refactor|delete|remove|edit|build|run|test|install|setup|generate|make|update|deploy|commit|optimize|clean|rename|move|append|insert|replace|apply|execute|start|stop|kill|debug|solve|patch|convert|port|migrate)\b/i;

const INFORMATIONAL_STARTER_REGEX =
  /^(what|why|how|when|where|who|which|explain|describe|summarize|list|show me|tell me|can you explain|can you describe|can you tell|can you check|could you explain|could you tell|is there|is this|is it|are there|does|do)\b/i;

const LEADING_GREETING_PREFIX_REGEX =
  /^(?:hi+|hello+|hey+|yo|hola|howdy|greetings|good\s+(?:morning|afternoon|evening|night)|ok(?:ay)?|sure|thanks?(?:\s+you)?)(?:\s+(?:there|localcoders|assistant|agent|ai|bot))?[\s,!.~:;?]+/i;

function normalizeCasualPhrasing(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/\bwhat['’]s\b/g, 'what is')
    .replace(/\bwho['’]s\b/g, 'who is')
    .replace(/\bhow['’]s\b/g, 'how is')
    .replace(/\bwhere['’]s\b/g, 'where is')
    .replace(/\byou['’]re\b/g, 'you are')
    .replace(/\bi['’]m\b/g, 'i am')
    .replace(/\bcan['’]t\b/g, 'can not')
    .replace(/\bdon['’]t\b/g, 'do not');
}

function stripLeadingGreeting(text: string): string {
  let out = text.trim();
  for (let i = 0; i < 3; i++) {
    const next = out.replace(LEADING_GREETING_PREFIX_REGEX, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Classifies prompt complexity & intent before entering the heavy planning/tool/critic pipeline.
 * Ensures simple greetings and read-only questions never trigger multi-step coding execution.
 */
export function classifyUserPrompt(prompt: string, executionMode: string = 'code'): PromptIntent {
  const raw = (prompt || '').trim();
  const lower = normalizeCasualPhrasing(raw);
  const bodyAfterGreeting = stripLeadingGreeting(lower);

  const hasFileOrPath = /\.[a-z0-9]{1,5}\b/i.test(raw) || /[\\\/`]/.test(raw);
  const hasCodeTaskWords =
    /\b(file|code|bug|error|function|class|script|python|typescript|javascript|repo|project|workspace|terminal|server|api|feature|app|module|alarm|clock)\b/i.test(
      lower
    );

  // Check lightweight conversational openers / identity questions first across modes
  if (raw.length > 0 && raw.length <= 100 && !hasFileOrPath && !hasCodeTaskWords && !ACTION_MUTATION_REGEX.test(lower)) {
    const normalizeForGreetingSet = (s: string) =>
      s
        .replace(/[!?.~,;:'"()]+/g, ' ')
        .replace(/\b(there|localcoders|assistant|agent|ai|bot|buddy|friend|please|pls)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const normFull = normalizeForGreetingSet(lower);
    const normStripped = normalizeForGreetingSet(bodyAfterGreeting);
    if (
      CONVERSATIONAL_GREETINGS.has(normFull) ||
      (normStripped === '' && normFull.length > 0) ||
      CONVERSATIONAL_GREETINGS.has(normStripped)
    ) {
      return 'greeting';
    }
  }

  if (executionMode === 'ask') {
    return 'question';
  }
  if (executionMode === 'plan') {
    return 'plan';
  }

  // In 'code' and 'smart' modes, route purely informational questions cleanly without coding plans/tools
  const candidateQuestion = bodyAfterGreeting || lower;
  if (!ACTION_MUTATION_REGEX.test(candidateQuestion)) {
    if (INFORMATIONAL_STARTER_REGEX.test(candidateQuestion) || /\?\s*$/.test(raw)) {
      return 'question';
    }
  }

  return 'coding_task';
}

/**
 * Cleans conversation history before passing it into LLM turns so stale failed plans or the
 * duplicate just-submitted user message never trigger unintended task re-execution.
 */
export function sanitizeConversationHistory(
  history: Array<{ role: string; content: string }> | undefined,
  currentPrompt: string,
  maxTurns: number = 4
): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
  if (!history || history.length === 0) return [];
  const trimmedCurrent = (currentPrompt || '').trim();
  const list = history.slice();

  // Strip the trailing duplicate user message if caller already appended it to session history
  if (list.length > 0) {
    const last = list[list.length - 1];
    if (last.role === 'user' && (last.content || '').trim() === trimmedCurrent) {
      list.pop();
    }
  }

  let latestCompactSummary: { role: 'system'; content: string } | null = null;
  const cleaned: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
  for (const m of list) {
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') continue;
    const text = sanitizeAssistantContent(m.content || '').trim();
    if (!text) continue;
    if (m.role === 'system') {
      if (/^### Compacted Session Context\b/i.test(text)) {
        latestCompactSummary = { role: 'system', content: text.length > 1800 ? text.slice(0, 1800) + '...' : text };
      }
      continue;
    }
    if (
      /^### Implementation Plan\b/i.test(text) ||
      /^### Execution (Complete|Failed|Cancelled)\b/i.test(text) ||
      /^### Model Unavailable\b/i.test(text) ||
      /^Execution (halted with error|cancelled by user)\b/i.test(text)
    ) {
      continue;
    }
    cleaned.push({
      role: m.role,
      content: text.length > 500 ? text.slice(0, 500) + '...' : text,
    });
  }

  const tail = cleaned.slice(-maxTurns);
  return latestCompactSummary ? [latestCompactSummary, ...tail] : tail;
}

/**
 * Extracts valid balanced top-level JSON objects from freeform LLM text,
 * ignoring `{` / `}` inside string literals (so nested markdown fences stay intact).
 */
export function extractBalancedJsonObjects(text: string): any[] {
  const results: any[] = [];
  if (!text) return results;

  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') {
      i++;
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let endIdx = -1;

    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          endIdx = j;
          break;
        }
      }
    }

    if (endIdx !== -1) {
      const candidate = text.slice(i, endIdx + 1);
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') {
          results.push(parsed);
          i = endIdx + 1;
          continue;
        }
      } catch {
        // Ignore malformed brace slices and keep scanning
      }
    }
    i++;
  }

  return results;
}
