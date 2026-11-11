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
 * Extracts human-readable internal reasoning (<think>, <thought>, <analysis>, raw chunk.thinking,
 * and pre-tool explanation prose) for display inside the Thinking drawer while stripping tool/JSON noise.
 */
export function extractAgentReasoningText(
  rawContent: string,
  rawThinking?: string,
  fallbackNote?: string
): string {
  const parts: string[] = [];
  const cleanThinking = String(rawThinking || '').trim();
  if (cleanThinking) {
    parts.push(cleanThinking);
  }

  const contentStr = String(rawContent || '');
  const tagRe = /<(think|thought|analysis)>([\s\S]*?)(?:<\/\1>|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(contentStr)) !== null) {
    const inner = (m[2] || '').trim();
    if (inner && !parts.includes(inner)) {
      parts.push(inner);
    }
  }

  // Include non-code/non-JSON explanatory prose emitted alongside tool calls
  let prose = sanitizeAssistantContent(contentStr)
    .replace(/<thought>[\s\S]*?(?:<\/thought>|$)/gi, '')
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .trim();
  if (prose && !/^\s*[\[{]/.test(prose)) {
    // Strip trailing partial JSON object fragments
    const firstBrace = prose.indexOf('{');
    if (firstBrace > 0 && /"(?:name|tool|tasks|verdict|findings)"/.test(prose.slice(firstBrace))) {
      prose = prose.slice(0, firstBrace).trim();
    }
    if (prose && !parts.some((p) => p.includes(prose))) {
      parts.push(prose);
    }
  }

  let combined = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!combined && fallbackNote) {
    combined = fallbackNote.trim();
  }
  if (combined.length > 3000) {
    combined = combined.slice(0, 2997) + '...';
  }
  return combined;
}

/**
 * Sanitizes agent output into user-visible narration prose for live streaming into the
 * conversation timeline. Removes internal reasoning tags, tool-call payloads (<tool_call>,
 * fenced ```json {name|tool} blocks, and bare {"name"|"tool"|"tasks"|"verdict"|"findings"}
 * JSON objects including their unterminated streaming prefixes) while keeping human prose,
 * code blocks, and markdown intact.
 */
export function sanitizeNarrativeContent(raw: string): string {
  if (!raw) return '';
  let text = sanitizeAssistantContent(raw);

  // Remove fenced blocks whose body is a JSON payload (tool calls like
  // ```json {"path":...} — any object/array body — never user-facing prose)
  text = text.replace(/```[a-zA-Z0-9_-]*\s*[[{][\s\S]*?(?:```|$)/gi, '');

  // Truncate at the first bare JSON object — `{"key":` shape — a tool-call/plan/critic
  // payload (or its partial streaming prefix), regardless of which keys it uses.
  // Skip matches inside remaining (legit code) fences so inline dict literals survive.
  const fenceRanges: Array<[number, number]> = [];
  const fenceScan = /```[\s\S]*?(?:```|$)/g;
  let fm: RegExpExecArray | null;
  while ((fm = fenceScan.exec(text)) !== null) {
    fenceRanges.push([fm.index, fm.index + fm[0].length]);
  }
  const jsonScan = /\{\s*"[A-Za-z_]{1,30}"\s*:/g;
  let jm: RegExpExecArray | null;
  let cutIdx = -1;
  while ((jm = jsonScan.exec(text)) !== null) {
    const inside = fenceRanges.some(([s, e]) => jm !== null && jm.index >= s && jm.index < e);
    if (!inside) {
      cutIdx = jm.index;
      break;
    }
  }
  if (cutIdx !== -1) {
    text = text.slice(0, cutIdx);
  }

  // Cut a trailing incomplete fence opener that may hold a tool payload next chunk
  const openFence = text.search(/```[a-zA-Z0-9_-]*\s*$/);
  if (openFence !== -1) {
    text = text.slice(0, openFence);
  }

  // Cut a trailing bare `{` / `{"x` fragment — almost always the start of a tool-call
  // JSON payload still streaming in; avoids a stray brace flashing into the bubble.
  const partialBrace = text.search(/\{\s*"?(?:[a-zA-Z]+)?"?\s*:?$/);
  if (partialBrace !== -1) {
    text = text.slice(0, partialBrace);
  }

  text = text.replace(/\n{3,}/g, '\n\n').trim();

  // Reasoning-dump guard: narration is meant to be a brief action line. When the model
  // streams its whole scratchpad into content (3+ paragraphs or a very long blob), the
  // action statement is the trailing paragraph ("Now we need to write the file") — keep
  // only that so the conversation shows a Devin-style status line. Full reasoning stays
  // in the thinking drawer via extractAgentReasoningText. Fenced code is excluded from
  // the paragraph count so legit code samples aren't mistaken for reasoning dumps.
  const proseOnly = text.replace(/```[\s\S]*?(?:```|$)/g, '').trim();
  const paragraphs = proseOnly.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length >= 3 || proseOnly.length > 400) {
    let last = paragraphs[paragraphs.length - 1] || '';
    if (last.length > 320) {
      const sentenceStart = Math.max(
        last.lastIndexOf('. ', last.length - 320),
        last.lastIndexOf('! ', last.length - 320),
        last.lastIndexOf('? ', last.length - 320),
        last.lastIndexOf('\n', last.length - 320)
      );
      last = sentenceStart > -1 ? last.slice(sentenceStart + 1).trim() : last.slice(-320).trim();
    }
    text = last;
  }

  return text;
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

export type PromptIntent = 'greeting' | 'question' | 'execute_task' | 'coding_task' | 'plan';

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

const CODE_AUTHORING_VERBS_REGEX =
  /\b(write|create|fix|implement|add|modify|change|refactor|delete|remove|edit|build|install|setup|generate|make|update|deploy|optimize|clean|rename|move|append|insert|replace|apply|debug|solve|patch|convert|port|migrate|improve|enhance|redesign|upgrade|style|format|lint|rewrite|scaffold|configure|enable|disable|integrate|connect|compile|init|initialize|document|commit|push|pull|clone|revert|undo)\b/i;

const EXECUTE_ONLY_VERBS_REGEX =
  /\b(run|execute|launch|start|serve|boot|open|re-?run|rerun|restart)\b/i;

const CLI_RUN_PREFIX_REGEX =
  /^(?:python(?:3)?|node|npm|npx|pnpm|yarn|pytest|cargo|go|uvicorn|flask|vite|streamlit)\s+/i;

const HOW_TO_QUESTION_REGEX =
  /^(?:how\s+(?:do|can|to|should|would)\b|what\s+(?:command|script|does|is|are)\b|which\s+(?:command|script|file)\b|why\s+(?:does|doesn't|did|is|won't)\b)/i;

const ACTION_MUTATION_REGEX =
  /\b(write|create|fix|implement|add|modify|change|refactor|delete|remove|edit|build|run|test|install|setup|generate|make|update|deploy|commit|optimize|clean|rename|move|append|insert|replace|apply|execute|start|stop|kill|debug|solve|patch|convert|port|migrate|improve|enhance|redesign|upgrade|style|format|lint|rewrite|scaffold|configure|enable|disable|integrate|connect|compile|serve|restart|push|pull|clone|revert|undo|init|initialize|document)\b/i;

const INFORMATIONAL_STARTER_REGEX =
  /^(what|why|how|when|where|who|which|explain|describe|summarize|list|show me|tell me|can you explain|can you describe|can you tell|can you check|could you explain|could you tell|is there|is this|is it|are there|does|do)\b/i;

const LEADING_GREETING_PREFIX_REGEX =
  /^(?:hi+|hello+|hey+|yo|hola|howdy|greetings|good\s+(?:morning|afternoon|evening|night)|ok(?:ay)?|sure|thanks?(?:\s+you)?)(?:\s+(?:there|localcoders|assistant|agent|ai|bot))?[\s,!.~:;?]+/i;

const CODE_TASK_DOMAIN_REGEX =
  /\b(file|files|folder|directory|code|codebase|bug|bugs|error|errors|exception|traceback|function|method|class|interface|type|module|package|library|dependency|dependencies|script|program|python|typescript|javascript|node|npm|pip|pytest|unittest|react|vue|html|css|sql|git|github|branch|commit|pr|diff|repo|repository|project|workspace|terminal|shell|command|cli|server|endpoint|route|api|database|db|schema|table|query|auth|login|feature|app|application|ui|ux|component|widget|button|form|page|screen|view|layout|theme|icon|logo|sidebar|header|footer|config|settings|env|yaml|json|readme|docs|documentation|test|tests|spec|clock|alarm|timer|stopwatch)\b/i;

const CASUAL_SELF_INTRO_REGEX =
  /^(?:my name(?:\s+is|'s)?|i am|i['’]?m|call me|you can call me|just call me|people call me|(?:please\s+)?remember(?:\s+that)?\s+(?:my|i)\b|don'?t forget(?:\s+that)?\s+(?:my|i)\b|nice to meet you|pleased to meet you|glad to meet you)\b/i;

const PERSONAL_MEMORY_QUERY_REGEX =
  /^(?:what(?:\s+is|'s)\s+my\s+name|who\s+am\s+i|do\s+you\s+(?:know|remember)\s+(?:my\s+name|who\s+i\s+am|me)|can\s+you\s+remember\s+(?:my\s+name|that|this|me)(?:\s+if\s+i\s+tell\s+you)?)\b/i;

const SHORT_SOCIAL_ACK_REGEX =
  /^(?:yes|yeah|yep|yup|no|nope|nah|maybe|perhaps|alright|fine|ok|okay|sure|k|lol|lmao|haha+|hehe+|wow|omg|oh|hmm+|ah+|sorry|my bad|no problem|np|you(?:\s+are|'re)\s+welcome|good\s+(?:job|work|luck|point)|well\s+done|never\s*mind|nevermind|forget\s+it|i\s+see|makes\s+sense|just\s+kidding|jk|have\s+a\s+(?:good|great|nice)\s+(?:day|night|one)|see\s+you(?:\s+later)?|take\s+care)(?:\s+(?:localcoders|assistant|agent|ai|bot|buddy|friend|thanks|thank you))?[\s,!.~:;?]*$/i;

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
 * Ensures simple greetings, casual social chat, and read-only questions never trigger coding execution.
 */
export function classifyUserPrompt(prompt: string, executionMode: string = 'code'): PromptIntent {
  const raw = (prompt || '').trim();
  const lower = normalizeCasualPhrasing(raw);
  const bodyAfterGreeting = stripLeadingGreeting(lower);
  const candidate = bodyAfterGreeting || lower;

  const hasFileOrPath = /\.[a-z][a-z0-9]{0,5}\b/.test(raw) || /[\\\/`]/.test(raw);
  const hasCodeTaskWords = CODE_TASK_DOMAIN_REGEX.test(lower);
  const hasActionVerb = ACTION_MUTATION_REGEX.test(candidate);
  const hasCodeIdentifier = /\b[a-z]+_[a-z0-9_]+\b|\b[a-z]+[A-Z][a-zA-Z0-9]*\b/.test(raw);

  // Check lightweight conversational openers, social pleasantries, self-introductions, and personal memory queries
  if (raw.length > 0 && raw.length <= 160 && !hasFileOrPath && !hasCodeTaskWords) {
    if (
      CASUAL_SELF_INTRO_REGEX.test(candidate) ||
      PERSONAL_MEMORY_QUERY_REGEX.test(candidate) ||
      SHORT_SOCIAL_ACK_REGEX.test(lower)
    ) {
      return 'greeting';
    }

    if (raw.length <= 100 && !ACTION_MUTATION_REGEX.test(lower)) {
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
  }

  if (executionMode === 'ask') {
    return 'question';
  }
  if (executionMode === 'plan') {
    return 'plan';
  }

  // In 'code' and 'smart' modes, route purely informational questions cleanly without coding plans/tools
  if (!hasActionVerb) {
    if (INFORMATIONAL_STARTER_REGEX.test(candidate) || /\?\s*$/.test(raw)) {
      return 'question';
    }
  } else if (
    !CODE_AUTHORING_VERBS_REGEX.test(candidate) &&
    HOW_TO_QUESTION_REGEX.test(candidate)
  ) {
    return 'question';
  }

  // Detect execute/run/launch requests ("ok, now run the clock", "run clock.py", "start the server")
  // that have execution verbs and NO code-authoring/mutation verbs so existing files are run without being rewritten.
  if (
    !CODE_AUTHORING_VERBS_REGEX.test(lower) &&
    (EXECUTE_ONLY_VERBS_REGEX.test(candidate) || CLI_RUN_PREFIX_REGEX.test(candidate))
  ) {
    return 'execute_task';
  }

  // Require at least one software/engineering/action signal before entering coding pipeline;
  // arbitrary casual chat statements ("My dog is happy", "Nigfa", etc.) stay in fast chat mode.
  if (!hasActionVerb && !hasFileOrPath && !hasCodeTaskWords && !hasCodeIdentifier) {
    return 'greeting';
  }

  return 'coding_task';
}

/**
 * Strips cancelled task turn groups from raw session history so an interrupted instruction
 * does not leak into subsequent greetings, Q&A, or unrelated future tasks.
 */
export function stripCancelledTurnsFromHistory(
  history: Array<{ role: string; content: string }> | undefined
): Array<{ role: string; content: string }> {
  if (!history || history.length === 0) return [];
  const out: Array<{ role: string; content: string }> = [];

  for (const m of history) {
    const content = (m.content || '').trim();
    const isCancelMarker =
      /^### Execution Cancelled\b/i.test(content) ||
      /^Execution cancelled by user\b/i.test(content);

    if (isCancelMarker) {
      // Remove any intermediate assistant plan/failure messages and the preceding user prompt of this cancelled turn
      while (out.length > 0 && out[out.length - 1].role !== 'user') {
        out.pop();
      }
      if (out.length > 0 && out[out.length - 1].role === 'user') {
        out.pop();
      }
      continue;
    }

    out.push(m);
  }

  return out;
}

/**
 * Filters sanitized history to strictly alternating completed (user -> assistant) pairs,
 * dropping orphaned/unanswered user prompts so they never collide with the user's new message.
 */
export function pairConversationHistory(
  history: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> | undefined,
  maxPairs: number = 3
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  if (!history || history.length === 0) return [];

  let compactedSystem: { role: 'system'; content: string } | null = null;
  let pendingUser: { role: 'user'; content: string } | null = null;
  const pairs: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const m of history) {
    if (m.role === 'system') {
      compactedSystem = { role: 'system', content: m.content };
      continue;
    }
    if (m.role === 'user') {
      // Overwrite any earlier user message that never got a surviving assistant response
      pendingUser = { role: 'user', content: m.content };
      continue;
    }
    if (m.role === 'assistant' && pendingUser) {
      pairs.push(pendingUser, { role: 'assistant', content: m.content });
      pendingUser = null;
    }
  }

  const maxMsgs = Math.max(2, maxPairs * 2);
  const sliced = pairs.slice(-maxMsgs);
  return compactedSystem ? [compactedSystem, ...sliced] : sliced;
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
