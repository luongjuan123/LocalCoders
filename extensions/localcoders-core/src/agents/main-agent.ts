import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { OllamaClient } from '../ollama/client';
import { LLMRouter } from '../models/llm-router';
import { ReasoningEffort } from '../models/types';
import { AgentConfig, CriticReport, CriticStrictness, TaskPlanItem } from './types';
import { ToolManager } from '../tools/tool-manager';
import { ToolExecutionContext } from '../tools/types';
import { MemoryManager } from '../context/memory-manager';
import { CodebaseIndexer } from '../context/indexer';
import { Subagent } from './subagent';
import { CriticAgent } from './critic-agent';
import { TaskQueue } from './task-queue';
import {
  AgentStreamEvent,
  SafeAgentPhase,
  extractBalancedJsonObjects,
  getSafePhaseLabel,
  pairConversationHistory,
  sanitizeAssistantContent,
} from './events';
import { createTurnProgressGuard, createTurnThoughtTracker, executeTrackedTool } from './tool-runner';

export const DEFAULT_MAX_CRITIC_CYCLES = 0; // 0 = unlimited review/fix cycles until approved or cancelled

export interface RuntimeModelOptions {
  reasoningEffort?: ReasoningEffort;
  fastMode?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  contextLimit?: number;
  runId?: string;
  streamMessageId?: string;
  executeOnly?: boolean;
  launchedApps?: Set<string>;
  conversationHistory?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  onStreamEvent?: (event: AgentStreamEvent) => void;
  onCriticReport?: (report: CriticReport) => void;
}

/**
 * Determines whether another Critic -> Main Agent correction cycle is required.
 */
export function shouldIterateCriticFix(
  report: CriticReport | undefined,
  strictness: CriticStrictness = 'strict',
  verificationFailed: boolean = false
): boolean {
  if (verificationFailed) return true;
  if (!report) return false;
  const unresolved = (report.findings || []).filter((f) => !f.resolved);
  // Do not ask Main Agent to edit workspace code when Critic failed due to missing/broken model config
  if (unresolved.length > 0 && unresolved.every((f) => f.category === 'Critic execution')) {
    return false;
  }
  if (report.verdict === 'blocker' || report.verdict === 'changes_requested') {
    return true;
  }
  if (unresolved.some((f) => f.severity === 'Critical' || f.severity === 'High')) {
    return true;
  }
  if (strictness !== 'lenient' && unresolved.some((f) => f.severity === 'Medium')) {
    return true;
  }
  return false;
}

/**
 * Extracts embedded tool calls from text responses (e.g. <tool_call>... or ```json {"tool": ...} ```)
 * Safely handles JSON strings containing nested markdown fences via balanced-brace fallback.
 */
export function parseToolCallsFromContent(content: string): Array<{ name: string; args: any }> {
  const calls: Array<{ name: string; args: any }> = [];
  if (!content) return calls;

  const pushParsed = (parsed: any) => {
    if (!parsed || typeof parsed !== 'object') return;
    const name = parsed.name || parsed.tool;
    if (!name || typeof name !== 'string') return;
    const args = parsed.arguments || parsed.args || parsed.parameters || { ...parsed };
    if (args && typeof args === 'object') {
      if (args === parsed) {
        delete args.name;
        delete args.tool;
      }
      calls.push({ name, args });
    }
  };

  // 1. Tagged <tool_call> ... </tool_call>
  const tagRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(content)) !== null) {
    try {
      pushParsed(JSON.parse(match[1].trim()));
    } catch {
      for (const obj of extractBalancedJsonObjects(match[1])) {
        pushParsed(obj);
      }
    }
  }

  // 2. Embedded JSON blocks or top-level tool-call JSON objects (handles nested ``` inside string literals)
  if (calls.length === 0) {
    const jsonBlockRegex = /```(?:json)?\s*(\{[\s\S]*?"(?:tool|name)"[\s\S]*?\})\s*```/gi;
    while ((match = jsonBlockRegex.exec(content)) !== null) {
      try {
        pushParsed(JSON.parse(match[1].trim()));
      } catch {}
    }
  }

  if (calls.length === 0) {
    for (const obj of extractBalancedJsonObjects(content)) {
      if (typeof obj.name === 'string' || typeof obj.tool === 'string') {
        pushParsed(obj);
      }
    }
  }

  return calls;
}

const NON_CODE_FENCE_LANGS = new Set([
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'bash', 'sh', 'zsh', 'shell', 'console', 'text', 'txt', 'diff', 'patch', 'markdown', 'md',
]);

function isLanguageCompatibleWithPath(lang: string | undefined, targetPath: string): boolean {
  if (!lang) return true;
  const l = lang.toLowerCase();
  const ext = path.extname(targetPath).toLowerCase();
  if (l === 'python' || l === 'py') return ext === '.py';
  if (l === 'typescript' || l === 'ts' || l === 'tsx') return ext === '.ts' || ext === '.tsx';
  if (l === 'javascript' || l === 'js' || l === 'jsx') return ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs';
  if (NON_CODE_FENCE_LANGS.has(l)) return false;
  return true;
}

/**
 * Extracts markdown code blocks that specify target file paths
 * Never writes raw JSON tool-call payloads or incompatible shell/markdown fences into source files.
 */
export function parseCodeBlocksFromContent(
  content: string,
  affectedFiles: string[] = []
): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  if (!content) return files;

  const blockRegex = /```(?:([a-zA-Z0-9_\-]+))?(?:[\s:=]+`?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9_]+)`?)?\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(content)) !== null) {
    const lang = match[1];
    let filePath = match[2];
    const code = match[3] || '';
    const matchIndex = match.index;
    const trimmedCode = code.trim();

    if (!trimmedCode) continue;
    // Guard against serialized tool-call JSON accidentally matching a fence fallback
    if (/^\{\s*"(?:name|tool)"\s*:/.test(trimmedCode)) continue;

    // 1. Look before the code block (after previous block, up to 300 chars)
    if (!filePath && !NON_CODE_FENCE_LANGS.has((lang || '').toLowerCase())) {
      const precedingText = content.slice(Math.max(0, matchIndex - 300), matchIndex);
      const lastFence = precedingText.lastIndexOf('```');
      const relevantPreceding = lastFence >= 0 ? precedingText.slice(lastFence + 3) : precedingText;
      const preRegex = /(?:###|####|\*\*|\*|File:|filename:|\d+\.|\bCreate|\bUpdate|\bIn)\s*`?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9_]+)`?\*?\*?[:\s]*$/im;
      const preMatch = relevantPreceding.match(preRegex);
      if (preMatch && preMatch[1] && isLanguageCompatibleWithPath(lang, preMatch[1])) {
        filePath = preMatch[1];
      }
    }

    // 2. Look at the first line of the code block for a comment with filename
    if (!filePath && !NON_CODE_FENCE_LANGS.has((lang || '').toLowerCase())) {
      const firstLine = trimmedCode.split('\n')[0].trim();
      const commentMatch = firstLine.match(/^(?:#|\/\/|\/\*)\s*(?:file(?:name)?:\s*)?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9_]+)/i);
      if (commentMatch && commentMatch[1] && isLanguageCompatibleWithPath(lang, commentMatch[1])) {
        filePath = commentMatch[1];
      }
    }

    // 3. Fallback to affectedFiles only if fence language matches source code
    if (!filePath && affectedFiles.length > 0 && trimmedCode.length > 20 && !NON_CODE_FENCE_LANGS.has((lang || '').toLowerCase())) {
      const compatFiles = affectedFiles.filter((f) => isLanguageCompatibleWithPath(lang, f));
      if (compatFiles.length > 0) {
        if (/import\s+unittest|import\s+pytest|class\s+Test|def\s+test_/i.test(code)) {
          filePath = compatFiles.find((f) => /test/i.test(f)) || compatFiles[0];
        } else {
          filePath = compatFiles.find((f) => !/test/i.test(f)) || compatFiles[0];
        }
      }
    }

    if (filePath) {
      const cleanPath = filePath.trim().replace(/^[`*'"\s]+|[`*'"\s]+$/g, '');
      if (cleanPath.includes('.') && !cleanPath.endsWith('.md')) {
        if (!files.some((f) => f.path === cleanPath)) {
          files.push({ path: cleanPath, content: code });
        }
      }
    }
  }

  return files;
}

export class MainAgent {
  public config: AgentConfig;
  private ollama: OllamaClient;
  private llmRouter: LLMRouter;
  private toolManager: ToolManager;
  private memoryManager: MemoryManager;
  private indexer: CodebaseIndexer;
  private workspaceRoot: string;

  constructor(
    config: AgentConfig,
    ollama: OllamaClient,
    toolManager: ToolManager,
    memoryManager: MemoryManager,
    indexer: CodebaseIndexer,
    workspaceRoot: string,
    llmRouter?: LLMRouter
  ) {
    this.config = config;
    this.ollama = ollama;
    this.llmRouter = llmRouter || new LLMRouter(ollama);
    this.toolManager = toolManager;
    this.memoryManager = memoryManager;
    this.indexer = indexer;
    this.workspaceRoot = workspaceRoot;
  }

  private emitSafeStatus(
    options: RuntimeModelOptions | undefined,
    phase: SafeAgentPhase,
    summary?: string
  ): void {
    const runId = options?.runId || 'run_default';
    options?.onStreamEvent?.({
      kind: 'status',
      id: `st_${runId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      runId,
      agentId: this.config.id,
      agentName: this.config.name,
      phase,
      summary: summary || getSafePhaseLabel(phase),
      timestamp: Date.now(),
    });
  }

  // 1. Plan implementation for a user request
  async createPlan(
    userPrompt: string,
    availableSubagents: Subagent[],
    onActivity: (msg: string) => void,
    options?: RuntimeModelOptions,
    abortSignal?: AbortSignal
  ): Promise<TaskPlanItem[]> {
    onActivity('Analyzing the task');
    this.emitSafeStatus(options, 'analyzing', 'Analyzing the task');

    if (abortSignal?.aborted) {
      throw new Error('Multi-agent execution cancelled by user.');
    }

    const summary = await this.indexer.index();
    const { rulesText } = await this.memoryManager.getProjectRules();

    const subagentDescriptions =
      availableSubagents
        .map((s) => {
          const hint = (s.config.systemPrompt || '').replace(/\s+/g, ' ').trim().slice(0, 140);
          return `- ID: "${s.config.id}", Name: "${s.config.name}", Role: "${s.config.role}"${hint ? `, Instructions: "${hint}"` : ''}`;
        })
        .join('\n') || 'None (Main Agent handles all tasks)';

    const findSubagentId = (rolePat: RegExp): string | undefined =>
      availableSubagents.find((s) => rolePat.test(s.config.role) || rolePat.test(s.config.name))?.config.id;
    const testSubId = findSubagentId(/\b(test|qa)\b/i) || 'main';
    const frontendSubId = findSubagentId(/\b(frontend|ui|designer|component)\b/i) || 'main';

    const systemPrompt = `You are the Lead Main Agent in LocalCoders.
You are responsible for understanding the user request, inspecting project architecture, and creating a structured, actionable task breakdown.

AVAILABLE SUBAGENTS FOR DELEGATION:
${subagentDescriptions}

DELEGATION POLICY:
- Use "assignedTo": "${availableSubagents.length > 0 ? frontendSubId : 'main'}" for UI/frontend layout, styles, or interactive view tasks when a Frontend specialist is available.
- Use "assignedTo": "${availableSubagents.length > 0 ? testSubId : 'main'}" for writing or running automated unit/integration test suites when a Test specialist is available.
- Use "assignedTo": "main" for core architecture, primary backend/domain logic, and final coordination.

PROJECT STRUCTURE:
Root: ${summary.rootName}
Type: ${summary.projectType}
Key Files: ${summary.keyFiles.join(', ')}
${summary.fileTreeSummary}

PROJECT RULES & CONVENTIONS:
${rulesText}

CRITICAL PLANNING INSTRUCTIONS:
- LocalCoders is an autonomous software development environment.
- Every task plan MUST culminate in real code files written to disk (via write_file/edit_file) and automated test execution (via run_command).
- NEVER create plans that ONLY inspect, review, or recommend next steps without implementing them!
- Plan ONLY tasks explicitly requested in USER REQUEST. NEVER invent unrelated features or copy example filenames.
- Include concrete steps appropriate to the user request:
  1. Source code implementation tasks (specify actual target filenames from the request/repo in affectedFiles).
  2. UI or entry-point updates when requested (assign UI tasks to "${frontendSubId}" if available).
  3. Unit/integration test updates and verification via run_command (assign test tasks to "${testSubId}" if available).
- If dependencies exist (e.g. tests depend on implementation), link them using dependencies.

OUTPUT FORMAT:
Respond with a STRICT JSON block matching this schema (replace placeholders with real task details):
\`\`\`json
{
  "tasks": [
    {
      "id": "task-1",
      "title": "<Implement requested changes in target file>",
      "description": "<Specific implementation details for the user request>",
      "assignedTo": "main",
      "dependencies": [],
      "affectedFiles": ["<target_file>"]
    },
    {
      "id": "task-2",
      "title": "<Update or add tests>",
      "description": "<Verify requested behavior with automated tests>",
      "assignedTo": "${testSubId}",
      "dependencies": ["task-1"],
      "affectedFiles": ["<test_file>"]
    },
    {
      "id": "task-3",
      "title": "Execute Tests and Verify Implementation",
      "description": "Run the automated tests using terminal execution and verify zero failures",
      "assignedTo": "${testSubId}",
      "dependencies": ["task-2"],
      "affectedFiles": []
    }
  ]
}
\`\`\`
`;

    let responseContent = '';
    let responseThinking = '';
    let planningNotified = false;
    const planThought = createTurnThoughtTracker({
      runId: options?.runId || 'run_default',
      agentId: this.config.id,
      agentName: this.config.name,
      agentRole: this.config.role,
      title: 'Planning Approach',
      stepKey: 'plan',
      onStreamEvent: options?.onStreamEvent,
    });
    // Cap planning reasoning effort & tokens so local models formulate JSON plans quickly instead of multi-minute CoT
    const planEffort: ReasoningEffort | undefined =
      options?.reasoningEffort === 'extra_high'
        ? 'medium'
        : options?.reasoningEffort === 'high'
        ? 'low'
        : options?.reasoningEffort;
    const planMaxTokens = options?.maxOutputTokens ? Math.min(options.maxOutputTokens, 1500) : 1500;

    await this.llmRouter.chatStream(
      {
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `USER REQUEST:\n${userPrompt}\n\nGenerate the actionable execution plan with real implementation tasks.` },
        ],
        temperature: options?.temperature ?? 0.1,
        maxOutputTokens: planMaxTokens,
        contextWindow: options?.contextLimit,
        reasoningEffort: planEffort,
        fastMode: options?.fastMode,
      },
      (chunk) => {
        responseContent += chunk.content;
        if (chunk.thinking) responseThinking += chunk.thinking;
        planThought.updateFromStream(responseContent, responseThinking);
        if (!planningNotified && (chunk.content || chunk.thinking)) {
          planningNotified = true;
          this.emitSafeStatus(options, 'planning', 'Planning approach');
        }
      },
      abortSignal
    );

    const normalizePlanDelegation = (list: TaskPlanItem[]): TaskPlanItem[] => {
      if (availableSubagents.length === 0 || list.length <= 1) return list;
      const alreadyDelegated = list.some((t) => t.assignedTo && t.assignedTo !== 'main');
      if (alreadyDelegated) return list;
      const validIds = new Set(availableSubagents.map((s) => s.config.id));
      const backendSubId = findSubagentId(/\b(backend|api|server|database)\b/i);
      const debugSubId = findSubagentId(/\b(debug|fix|diagnos)\b/i);

      return list.map((t, idx) => {
        if (t.assignedTo && validIds.has(t.assignedTo)) return t;
        const text = `${t.title} ${t.description} ${(t.affectedFiles || []).join(' ')}`.toLowerCase();
        const isTest = /\b(test|unittest|pytest|spec|verify|verification|execute tests)\b/i.test(text) ||
          (t.affectedFiles || []).some((f) => /test|spec/i.test(f));
        const isUi = /\b(ui|frontend|gui|component|css|html|tkinter|react|vue)\b/i.test(text) ||
          (t.affectedFiles || []).some((f) => /\.(vue|tsx|jsx|css|html|svelte)$/i.test(f));
        const isDebug = /\b(debug|troubleshoot)\b/i.test(text);
        if (isUi && frontendSubId !== 'main' && validIds.has(frontendSubId)) {
          return { ...t, assignedTo: frontendSubId };
        }
        if (isTest && testSubId !== 'main' && validIds.has(testSubId)) {
          return { ...t, assignedTo: testSubId };
        }
        if (isDebug && debugSubId && validIds.has(debugSubId)) {
          return { ...t, assignedTo: debugSubId };
        }
        if (idx > 0 && backendSubId && validIds.has(backendSubId) && /\b(backend|api|database|endpoint|server)\b/i.test(text)) {
          return { ...t, assignedTo: backendSubId };
        }
        return t;
      });
    };

    try {
      const match = responseContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      const rawJson = match ? match[1] : responseContent;
      const parsed = JSON.parse(rawJson);
      let tasks: TaskPlanItem[] = (parsed.tasks || []).map((t: any, idx: number) => ({
        id: t.id || `task-${idx + 1}`,
        title: t.title || `Subtask ${idx + 1}`,
        description: t.description || '',
        assignedTo: t.assignedTo || 'main',
        dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
        status: 'pending',
        affectedFiles: Array.isArray(t.affectedFiles) ? t.affectedFiles : [],
      }));

      // Guardrail: If model only created inspection/summary tasks without implementation or execution, augment plan
      const hasImplementationOrExec = tasks.some(
        (t) =>
          t.affectedFiles.length > 0 ||
          /\b(implement|create|write|build|add|code|fix|develop|run|execute|launch|start|serve|verify|test)\b/i.test(
            t.title + ' ' + t.description
          )
      );

      if (!hasImplementationOrExec && tasks.length > 0) {
        tasks.push({
          id: `task-${tasks.length + 1}`,
          title: 'Direct Code Implementation',
          description: `Implement the requested functionality directly: ${userPrompt}`,
          assignedTo: 'main',
          dependencies: [tasks[tasks.length - 1].id],
          status: 'pending',
          affectedFiles: [],
        });
        tasks.push({
          id: `task-${tasks.length + 1}`,
          title: 'Automated Testing and Verification',
          description: 'Run automated tests and verify working implementation',
          assignedTo: testSubId !== 'main' ? testSubId : 'main',
          dependencies: [`task-${tasks.length}`],
          status: 'pending',
          affectedFiles: [],
        });
      }

      if (tasks.length === 0) {
        tasks = [
          {
            id: 'task-1',
            title: 'Direct Implementation',
            description: userPrompt,
            assignedTo: 'main',
            dependencies: [],
            status: 'pending',
            affectedFiles: [],
          },
        ];
      }

      tasks = normalizePlanDelegation(tasks);
      const planSummaryText = `Plan (${tasks.length} step${tasks.length === 1 ? '' : 's'}): ` +
        tasks.map((t) => `${t.title} [${t.assignedTo}]`).join(' -> ');
      planThought.finalize(responseContent, responseThinking, planSummaryText);
      return tasks;
    } catch {
      planThought.finalize(responseContent, responseThinking, `Direct execution plan for: ${userPrompt}`);
      return [
        {
          id: 'task-1',
          title: 'Direct Implementation',
          description: userPrompt,
          assignedTo: 'main',
          dependencies: [],
          status: 'pending',
          affectedFiles: [],
        },
      ];
    }
  }

  // Lightweight direct reply for casual greetings & conversational messages (zero planning/tools/indexing)
  async answerConversationalFast(
    prompt: string,
    abortSignal?: AbortSignal,
    options?: RuntimeModelOptions
  ): Promise<string> {
    const systemPrompt =
      'You are LocalCoders AI (running model: ' +
      (this.config.model || 'local LLM') +
      '), an assistant inside the LocalCoders IDE. You are currently in casual conversation mode. Respond ONLY to the user\'s latest message clearly and naturally in 1-3 sentences. Remember conversational details the user shared earlier in this chat (such as their name or preferences). Do NOT invent code plans or claim you will add, edit, or run code/files unless the user explicitly asked for a code change.';

    let rawResponse = '';
    let prevSanitized = '';
    const messageId = options?.streamMessageId || `conv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const runId = options?.runId || 'run_default';
    const safeChatHistory = pairConversationHistory(options?.conversationHistory, 3).filter(
      (m) => m.role !== 'system'
    );

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...safeChatHistory,
      { role: 'user', content: prompt },
    ];

    this.emitSafeStatus(options, 'analyzing', 'Responding');

    await this.llmRouter.chatStream(
      {
        model: this.config.model,
        messages,
        temperature: options?.temperature ?? 0.4,
        maxOutputTokens: options?.maxOutputTokens ? Math.min(options.maxOutputTokens, 512) : 512,
        contextWindow: options?.contextLimit,
        reasoningEffort: 'minimal',
        fastMode: true,
      },
      (chunk) => {
        rawResponse += chunk.content;
        const cleanFull = sanitizeAssistantContent(rawResponse);
        if (cleanFull.length > prevSanitized.length) {
          const delta = cleanFull.slice(prevSanitized.length);
          prevSanitized = cleanFull;
          options?.onStreamEvent?.({
            kind: 'message_delta',
            id: `md_${messageId}_${Date.now()}`,
            runId,
            messageId,
            agentId: this.config.id,
            agentName: this.config.name,
            senderRole: 'assistant',
            deltaContent: delta,
            fullContent: cleanFull,
            timestamp: Date.now(),
          });
        }
      },
      abortSignal
    );

    return sanitizeAssistantContent(rawResponse).trim() || 'Hello! How can I help you today?';
  }

  // Answer user questions in Ask / Q&A flow without modifying any files
  async answerQuestion(
    question: string,
    abortSignal?: AbortSignal,
    options?: RuntimeModelOptions
  ): Promise<string> {
    const summary = await this.indexer.index();
    const { rulesText } = await this.memoryManager.getProjectRules();
    const systemPrompt = `You are LocalCoders AI, a senior software architect and coding partner.
Your objective is to answer questions, explain concepts, review architecture, or analyze code accurately and concisely without making unrequested file modifications.

PROJECT ARCHITECTURE:
Root: ${summary.rootName}
Type: ${summary.projectType}
Key Files: ${summary.keyFiles.join(', ')}
${summary.fileTreeSummary}

PROJECT RULES & CONVENTIONS:
${rulesText}
`;

    let temperature = options?.temperature ?? 0.2;
    if (options?.temperature === undefined) {
      if (options?.reasoningEffort === 'extra_high' || options?.reasoningEffort === 'high') {
        temperature = 0.1;
      } else if (options?.fastMode) {
        temperature = 0.3;
      }
    }

    let rawResponse = '';
    let prevSanitized = '';
    let notifiedAnalyzing = false;
    const messageId = options?.streamMessageId || `ans_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const runId = options?.runId || 'run_default';

    this.emitSafeStatus(options, 'analyzing', 'Analyzing the task');

    const safeQaHistory = pairConversationHistory(options?.conversationHistory, 4);
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...safeQaHistory,
      { role: 'user', content: question },
    ];

    await this.llmRouter.chatStream(
      {
        model: this.config.model,
        messages,
        temperature,
        maxOutputTokens: options?.maxOutputTokens,
        contextWindow: options?.contextLimit,
        reasoningEffort: options?.reasoningEffort,
        fastMode: options?.fastMode,
      },
      (chunk) => {
        rawResponse += chunk.content;
        if (!notifiedAnalyzing && chunk.thinking && !rawResponse) {
          notifiedAnalyzing = true;
          this.emitSafeStatus(options, 'analyzing', 'Analyzing the task');
        }
        const cleanFull = sanitizeAssistantContent(rawResponse);
        if (cleanFull.length > prevSanitized.length) {
          const delta = cleanFull.slice(prevSanitized.length);
          prevSanitized = cleanFull;
          options?.onStreamEvent?.({
            kind: 'message_delta',
            id: `md_${messageId}_${Date.now()}`,
            runId,
            messageId,
            agentId: this.config.id,
            agentName: this.config.name,
            senderRole: 'assistant',
            deltaContent: delta,
            fullContent: cleanFull,
            timestamp: Date.now(),
          });
        }
      },
      abortSignal
    );

    return sanitizeAssistantContent(rawResponse).trim() || 'No response generated.';
  }

  // 2. Execute plan with multi-agent coordination
  async executePlan(
    plan: TaskPlanItem[],
    userPrompt: string,
    subagents: Subagent[],
    criticAgent: CriticAgent | null,
    onActivity: (msg: string) => void,
    onPlanUpdate: (updatedPlan: TaskPlanItem[]) => void,
    requestApproval: (req: any) => Promise<boolean>,
    abortSignal?: AbortSignal,
    runtimeOptions?: RuntimeModelOptions
  ): Promise<{ success: boolean; criticReport?: CriticReport; summary: string }> {
    const vsConfig = vscode.workspace.getConfiguration('localcoders');
    const configuredConcurrency = vsConfig.get<number>('maxConcurrentSubagents') || 3;
    const isLocalExecution =
      !this.config.model ||
      this.config.model.startsWith('ollama/') ||
      !this.config.model.includes('/');
    // Local Ollama defaults to OLLAMA_NUM_PARALLEL=1; serializing prevents queue starvation and llama-server OOM crashes
    const maxConcurrency = isLocalExecution ? 1 : configuredConcurrency;
    const pmMode = this.toolManager.getPermissionManager()?.getNormalizedMode();
    const requireApprovalForEdits = pmMode === 'bypass' ? false : (vsConfig.get<boolean>('requireApprovalForEdits') ?? true);

    const queue = new TaskQueue(maxConcurrency);
    queue.setPlan(plan);
    const subagentMap = new Map<string, Subagent>(subagents.map((s) => [s.config.id, s]));
    const modifiedFilesSet = new Set<string>();
    const launchedApps = runtimeOptions?.launchedApps || new Set<string>();
    const runRuntimeOptions: RuntimeModelOptions = {
      ...runtimeOptions,
      launchedApps,
    };

    const toolCtx: ToolExecutionContext = {
      workspaceRoot: this.workspaceRoot,
      agentId: this.config.id,
      agentName: this.config.name,
      requireApproval: requireApprovalForEdits,
      requestApproval,
    };

    // Pre-execution safe checkpoint (non-fatal; skipped for execute-only runs)
    if (!runtimeOptions?.executeOnly) {
      try {
        await this.toolManager.executeTool('create_checkpoint', { description: 'Pre-multiagent task run' }, toolCtx);
      } catch (checkpointErr: any) {
        console.warn('[MainAgent] Non-fatal checkpoint note:', checkpointErr.message);
      }
    }

    onActivity(
      runtimeOptions?.executeOnly
        ? 'Executing requested application or command...'
        : 'Starting orchestrated multi-agent plan execution...'
    );

    let initialVerificationFailed = false;
    let verificationSummary = '';
    let lastMainTaskOutput = '';

    while (!queue.isComplete()) {
      if (abortSignal?.aborted) {
        throw new Error('Multi-agent execution cancelled by user.');
      }

      const readyTasks = queue.getReadyTasks();
      if (readyTasks.length === 0) {
        // Deadlock check: if no active tasks and no ready tasks, resolve deadlock
        if (queue.hasDeadlock()) {
          onActivity('Resolving unfulfilled task dependencies to complete execution...');
          queue.resolveDeadlock();
          onPlanUpdate(queue.getAllTasks());
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }

      // Execute ready tasks concurrently up to concurrency limit
      const executions = readyTasks.map(async (task) => {
        queue.updateTaskStatus(task.id, 'in_progress');
        onPlanUpdate(queue.getAllTasks());

        try {
          if (task.assignedTo !== 'main' && subagentMap.has(task.assignedTo)) {
            const worker = subagentMap.get(task.assignedTo)!;
            const subActId = `sub_${task.id}_${Date.now()}`;
            const subStart = Date.now();
            const runId = runtimeOptions?.runId || 'run_default';
            onActivity(`[${worker.config.name}] Starting task: ${task.title}`);
            runtimeOptions?.onStreamEvent?.({
              kind: 'activity_upsert',
              id: `up_${subActId}`,
              runId,
              item: {
                id: subActId,
                runId,
                category: 'subagent',
                agentId: worker.config.id,
                agentName: worker.config.name,
                agentRole: worker.config.role,
                title: `Subagent: ${worker.config.name}`,
                summary: task.title,
                status: 'running',
                startTime: subStart,
                timestamp: subStart,
              },
              timestamp: subStart,
            });

            const res = await worker.executeTask(
              task,
              `User Goal: ${userPrompt}\nWorkspace: ${this.workspaceRoot}`,
              onActivity,
              requestApproval,
              abortSignal,
              runRuntimeOptions
            );

            const subEnd = Date.now();
            const subCancelled = Boolean(abortSignal?.aborted);
            runtimeOptions?.onStreamEvent?.({
              kind: 'activity_upsert',
              id: `up_${subActId}_done`,
              runId,
              item: {
                id: subActId,
                runId,
                category: 'subagent',
                agentId: worker.config.id,
                agentName: worker.config.name,
                agentRole: worker.config.role,
                title: `Subagent: ${worker.config.name}`,
                summary: task.title,
                status: subCancelled ? 'cancelled' : res.success ? 'completed' : 'failed',
                startTime: subStart,
                endTime: subEnd,
                durationMs: subEnd - subStart,
                timestamp: subEnd,
              },
              timestamp: subEnd,
            });

            for (const f of res.affectedFiles || []) modifiedFilesSet.add(f);
            if (res.verificationSummary) {
              verificationSummary = res.verificationSummary;
              initialVerificationFailed = Boolean(res.verificationFailed);
            }

            queue.updateTaskStatus(
              task.id,
              subCancelled ? 'cancelled' : res.success ? 'completed' : 'failed',
              res.output
            );
          } else {
            // Main Agent executes task directly
            this.emitSafeStatus(
              runtimeOptions,
              'working',
              runtimeOptions?.executeOnly ? 'Running application' : `Working on ${task.title}`
            );
            const res = await this.executeMainTask(task, userPrompt, onActivity, requestApproval, abortSignal, runRuntimeOptions);
            if (res.output) lastMainTaskOutput = res.output;
            for (const f of res.modifiedFiles || []) modifiedFilesSet.add(f);
            if (res.verificationSummary) {
              verificationSummary = res.verificationSummary;
              initialVerificationFailed = Boolean(res.verificationFailed);
            }
            const wasCancelled = Boolean(abortSignal?.aborted);
            queue.updateTaskStatus(
              task.id,
              wasCancelled ? 'cancelled' : res.success ? 'completed' : 'failed',
              res.output
            );
          }
        } catch (err: any) {
          if (abortSignal?.aborted || /cancelled/i.test(err?.message || '')) {
            queue.updateTaskStatus(task.id, 'cancelled', 'Task cancelled by user.');
          } else {
            onActivity(`Error executing ${task.title}: ${err.message}`);
            queue.updateTaskStatus(task.id, 'failed', err.message);
          }
        }

        onPlanUpdate(queue.getAllTasks());
      });

      await Promise.all(executions);
    }

    if (abortSignal?.aborted) {
      throw new Error('Multi-agent execution cancelled by user.');
    }

    if (queue.hasFailedTasks()) {
      const failed = queue.getAllTasks().filter((t) => t.status === 'failed');
      const failReasons = failed.map((f) => `- ${f.title}: ${f.output || 'Unknown error'}`).join('\n');
      return {
        success: false,
        summary: `One or more subtasks encountered issues:\n${failReasons}`,
      };
    }

    // 3. Iterative Code -> Critic Review -> Remediation Cycle (skipped for execute-only runs with zero file edits)
    let criticReport: CriticReport | undefined = undefined;
    let verificationFailed = initialVerificationFailed;
    let cyclesExecuted = 0;
    const runId = runtimeOptions?.runId || `run_${Date.now()}`;
    const isExecuteOnlyRun = Boolean(runtimeOptions?.executeOnly) && modifiedFilesSet.size === 0;

    if (criticAgent && !abortSignal?.aborted && !isExecuteOnlyRun) {
      const rawMaxCycles = vsConfig.get<number>('maxCriticCycles');
      const maxCycles =
        typeof rawMaxCycles === 'number' && !Number.isNaN(rawMaxCycles)
          ? Math.max(0, Math.floor(rawMaxCycles))
          : DEFAULT_MAX_CRITIC_CYCLES;
      const strictness = criticAgent.getConfig().strictness || 'strict';
      const criticModel = criticAgent.getConfig().model || this.config.model;
      let prevFingerprint = '';
      let lastFixMadeNoChanges = false;

      for (let cycle = 1; ; cycle++) {
        if (abortSignal?.aborted) {
          throw new Error('Multi-agent execution cancelled by user.');
        }

        cyclesExecuted = cycle;
        const reviewTitle = cycle === 1 ? 'Critic Review' : `Critic Re-review (Round ${cycle})`;
        const criticActId = `critic_${runId}_r${cycle}`;
        const criticStart = Date.now();
        this.emitSafeStatus(runtimeOptions, 'verifying', `${reviewTitle} (${criticModel})`);
        onActivity(`[Critic Agent] ${reviewTitle} using model '${criticModel}'...`);

        runtimeOptions?.onStreamEvent?.({
          kind: 'activity_upsert',
          id: `up_${criticActId}`,
          runId,
          item: {
            id: criticActId,
            runId,
            category: 'subagent',
            agentId: 'critic',
            agentName: 'Critic Agent',
            agentRole: 'Code Quality & Security Critic',
            title: reviewTitle,
            summary: `Auditing workspace changes (${criticModel})`,
            status: 'running',
            startTime: criticStart,
            timestamp: criticStart,
          },
          timestamp: criticStart,
        });

        criticReport = await criticAgent.review({
          userRequirements: userPrompt,
          changedFiles: Array.from(modifiedFilesSet),
          verificationSummary,
          runId,
          round: cycle,
          onStreamEvent: runtimeOptions?.onStreamEvent,
          onProgress: onActivity,
          abortSignal,
        });

        runtimeOptions?.onCriticReport?.(criticReport);

        const criticEnd = Date.now();
        const findings = criticReport.findings || [];
        const reviewDetails = [
          `Verdict: ${criticReport.verdict.toUpperCase()}`,
          criticReport.summary,
          ...findings.map(
            (f, idx) =>
              `${idx + 1}. [${f.severity}] ${f.filePath}${f.lineRange ? ':' + f.lineRange : ''} — ${f.explanation}${f.recommendedFix ? '\n   Fix: ' + f.recommendedFix : ''}`
          ),
        ]
          .filter(Boolean)
          .join('\n');

        const isCriticInfraError = findings.length > 0 && findings.every((f) => f.category === 'Critic execution');
        const needsFix = shouldIterateCriticFix(criticReport, strictness, verificationFailed);

        runtimeOptions?.onStreamEvent?.({
          kind: 'activity_upsert',
          id: `up_${criticActId}_done`,
          runId,
          item: {
            id: criticActId,
            runId,
            category: 'subagent',
            agentId: 'critic',
            agentName: 'Critic Agent',
            agentRole: 'Code Quality & Security Critic',
            title: reviewTitle,
            summary: isCriticInfraError
              ? `Critic model error (${criticModel})`
              : `${criticReport.verdict.toUpperCase()} · ${findings.length} finding(s)`,
            stdout: reviewDetails,
            status: isCriticInfraError ? 'failed' : 'completed',
            startTime: criticStart,
            endTime: criticEnd,
            durationMs: criticEnd - criticStart,
            timestamp: criticEnd,
          },
          timestamp: criticEnd,
        });

        if (!needsFix) {
          onActivity(`[Critic Agent] Approved after ${cycle} review cycle(s).`);
          break;
        }

        const fingerprint = `${criticReport.verdict}|${verificationFailed}|${findings
          .map((f) => `${f.filePath}:${f.lineRange || ''}:${f.explanation}`)
          .join('||')}`;

        if (maxCycles > 0 && cycle >= maxCycles) {
          onActivity(`[Critic Agent] Reached max review cycles (${maxCycles}); stopping with verdict '${criticReport.verdict}'.`);
          break;
        }

        if (lastFixMadeNoChanges && prevFingerprint === fingerprint) {
          onActivity(`[Critic Agent] Stopping remediation cycle cleanly: identical findings persisted with no further edits.`);
          break;
        }
        prevFingerprint = fingerprint;

        const feedbackCount = findings.length;
        onActivity(
          feedbackCount > 0
            ? `[Critic -> Main Agent] Found ${feedbackCount} issue(s) (${criticReport.verdict}). Instructing Main Agent to fix (Round ${cycle})...`
            : `[Critic -> Main Agent] Test verification failed. Instructing Main Agent to fix (Round ${cycle})...`
        );
        this.emitSafeStatus(runtimeOptions, 'working', `Fixing Critic feedback (Round ${cycle})`);

        const fixRes = await this.addressCriticFindings(
          criticReport,
          Array.from(modifiedFilesSet),
          verificationSummary,
          cycle,
          onActivity,
          requestApproval,
          abortSignal,
          runRuntimeOptions
        );

        const prevVerifFailed: boolean = verificationFailed;
        for (const mf of fixRes.modifiedFiles) modifiedFilesSet.add(mf);
        lastFixMadeNoChanges = fixRes.modifiedFiles.length === 0;

        if (fixRes.verificationSummary) {
          verificationSummary = fixRes.verificationSummary;
          verificationFailed = fixRes.verificationFailed;
        }

        if (lastFixMadeNoChanges && verificationFailed === prevVerifFailed) {
          onActivity(`[Critic Agent] Stopping remediation cycle cleanly after Round ${cycle}: no files were modified to alter failing state.`);
          break;
        }
      }
    } else if (verificationFailed && !abortSignal?.aborted && !isExecuteOnlyRun) {
      // Critic disabled, but automated verification failed — allow direct Main Agent repair pass
      onActivity('[Main Agent] Verification failed; applying targeted fix pass...');
      const syntheticReport: CriticReport = {
        id: `verify_err_${Date.now()}`,
        timestamp: Date.now(),
        filesReviewed: Array.from(modifiedFilesSet),
        verdict: 'blocker',
        summary: 'Automated verification tests failed.',
        findings: [
          {
            id: 'verify-1',
            severity: 'Critical',
            category: 'Verification failure',
            filePath: Array.from(modifiedFilesSet)[0] || 'workspace',
            evidence: verificationSummary.slice(0, 1500),
            explanation: 'Workspace verification command returned a non-zero exit code.',
            reproduction: 'Run workspace tests',
            recommendedFix: 'Inspect error output and fix broken code or tests.',
            confidence: 'Confirmed',
            resolved: false,
          },
        ],
      };
      const fixRes = await this.addressCriticFindings(
        syntheticReport,
        Array.from(modifiedFilesSet),
        verificationSummary,
        1,
        onActivity,
        requestApproval,
        abortSignal,
        runRuntimeOptions
      );
      verificationFailed = fixRes.verificationFailed;
      verificationSummary = fixRes.verificationSummary || verificationSummary;
    }

    const unresolvedBlockers = criticReport?.verdict === 'blocker' || verificationFailed;
    if (unresolvedBlockers) {
      return {
        success: false,
        criticReport,
        summary: verificationFailed
          ? `Execution finished with failing verification tests after ${Math.max(1, cyclesExecuted)} review cycle(s).`
          : `Critic Agent blocked completion after ${cyclesExecuted} review cycle(s): ${criticReport?.summary || 'unresolved critical defects'}.`,
      };
    }

    const cycleNote =
      criticReport && cyclesExecuted > 0
        ? criticReport.verdict === 'approved'
          ? ` Passed Critic review (${cyclesExecuted} cycle(s)).`
          : ` Completed ${cyclesExecuted} Critic review cycle(s) with verdict '${criticReport.verdict}'.`
        : '';

    return {
      success: true,
      criticReport,
      summary: isExecuteOnlyRun
        ? lastMainTaskOutput || 'Execution completed successfully.'
        : `All tasks completed successfully. Files created/modified and verified.${cycleNote}`,
    };
  }

  // Execute a single implementation task autonomously with real tool calls and code persistence
  private async executeMainTask(
    task: TaskPlanItem,
    userPrompt: string,
    onActivity: (msg: string) => void,
    requestApproval: (req: any) => Promise<boolean>,
    abortSignal?: AbortSignal,
    runtimeOptions?: RuntimeModelOptions
  ): Promise<{ success: boolean; output: string; modifiedFiles: string[]; verificationSummary?: string; verificationFailed?: boolean }> {
    const vsConfig = vscode.workspace.getConfiguration('localcoders');
    const pmMode = this.toolManager.getPermissionManager()?.getNormalizedMode();
    const requireApprovalForEdits = pmMode === 'bypass' ? false : (vsConfig.get<boolean>('requireApprovalForEdits') ?? true);

    const toolCtx: ToolExecutionContext = {
      workspaceRoot: this.workspaceRoot,
      agentId: this.config.id,
      agentName: this.config.name,
      taskId: task.id,
      requireApproval: requireApprovalForEdits,
      requestApproval,
    };

    const taskContext = {
      affectedFiles: task.affectedFiles,
      prompt: `${task.title} ${task.description} ${userPrompt}`,
    };
    let rootListingText = '(empty)';
    try {
      const rootEntries = require('fs')
        .readdirSync(this.workspaceRoot, { withFileTypes: true })
        .filter((e: any) => !['.git', 'node_modules', '__pycache__', '.localcoders', 'venv', '.venv'].includes(e.name))
        .slice(0, 25)
        .map((e: any) => (e.isDirectory() ? `${e.name}/` : e.name));
      if (rootEntries.length > 0) rootListingText = rootEntries.join(', ');
    } catch {}

    const isExecuteOnly = Boolean(runtimeOptions?.executeOnly);
    const executeOnlyBlockedTools = new Set([
      'write_file',
      'edit_file',
      'rename_file',
      'delete_file',
      'create_file',
      'revert_file',
      'stage_file',
      'unstage_file',
      'git_commit',
      'git_checkout',
      'git_create_branch',
      'git_worktree_create',
      'git_worktree_remove',
    ]);
    const rawTools = this.toolManager.getOllamaTools(this.config.role, taskContext);
    const tools = isExecuteOnly
      ? rawTools.filter((t: any) => !executeOnlyBlockedTools.has(t?.function?.name || ''))
      : rawTools;
    const systemPrompt = isExecuteOnly
      ? `You are the Lead Main Agent in LocalCoders.
${this.config.systemPrompt}

EXECUTION-ONLY MODE:
- The project code is ALREADY implemented on disk (Workspace Root Files: ${rootListingText}).
- Do NOT rewrite, recreate, or modify existing source files or tests. Write/edit tools are disabled.
- Use read_file / list_directory only if you need to check the entrypoint filename or start command.
- Run the requested existing application or command right now using:
  * start_process(command) + read_output(id): for GUI applications (Tkinter, Qt, Pygame, Electron), dev servers, or continuously running clocks/timers.
  * run_command(command, stdin?): for finite scripts, CLIs (pass stdin if input() is needed), or test commands.
- Never execute standalone 'source venv/bin/activate' or './venv/bin/activate' in run_command; any workspace venv/bin is already on PATH so run 'python3', 'pip', or 'pytest' directly.
- Once executed, concisely report the exact command run and observed output/process status.`
      : `You are the Lead Main Agent in LocalCoders, an autonomous development environment.
${this.config.systemPrompt}

CRITICAL EXECUTION MANDATE:
- You are NOT a chatbot. Talking about code or describing an implementation does NOT complete the task.
- YOU MUST EXECUTE REAL TOOLS:
  * write_file(path, content): Create or overwrite source files in the workspace.
  * edit_file(path, target, replacement): Modify existing files with targeted changes.
  * run_command(command, stdin?): Run shell commands, tests, package managers, and builds. If a CLI script asks for interactive input (e.g. input()), pass 'stdin' with newline-separated responses, or use 'start_process' + 'write_stdin' + 'read_output' + 'terminate_process'. For GUI/UI apps or long-running servers, use 'start_process' rather than blocking 'run_command'.
  * read_file(path): Inspect file contents.
  * list_directory(path): Inspect directory structures.
- Whenever you implement a feature, module, or test, YOU MUST CALL write_file TO SAVE THE CODE TO DISK.
- Match the existing language and structure of the workspace (Workspace Root Files: ${rootListingText}). Never create TypeScript/JS files inside a Python workspace unless explicitly asked.
- Never execute standalone 'source venv/bin/activate' or './venv/bin/activate' in run_command; any workspace venv/bin is already on PATH so run 'python3', 'pip', or 'pytest' directly.
- Never retry the exact same timed-out or interactive-input-blocked command with identical arguments; pass 'stdin', add non-interactive CLI options/tests, or run via 'start_process' + 'write_stdin'.
- Never call write_file multiple times in a loop with identical path and content. Once a file is written and tests pass, provide your final concise summary.
- Always write complete, production-ready, clean code with zero placeholders or omissions.`;

    const targetFilePrompt = isExecuteOnly
      ? `Inspect root files (${rootListingText}) if needed and run the existing entrypoint using run_command or start_process now. Do NOT modify or rewrite code files.`
      : task.affectedFiles.length > 0
      ? `You MUST immediately write/update the required code for: ${task.affectedFiles.join(', ')} using write_file. Do not waste turns reading directory listings when files must be written.`
      : `Inspect/match existing workspace files (${rootListingText}) and use tools (write_file, edit_file, run_command) to execute this task now.`;

    const userMsg = isExecuteOnly
      ? `TASK TO EXECUTE:
Title: ${task.title}
Description: ${task.description}
USER REQUEST: ${userPrompt}

MANDATORY ACTION:
${targetFilePrompt}`
      : `TASK TO IMPLEMENT:
Title: ${task.title}
Description: ${task.description}
Affected Files: ${task.affectedFiles.join(', ') || 'Determine needed files'}
OVERALL GOAL: ${userPrompt}

MANDATORY ACTION:
${targetFilePrompt}`;

    const messages: any[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMsg },
    ];

    let turns = 0;
    const maxTurns = isExecuteOnly ? 6 : 12;
    let finalOutput = '';
    const filesWritten: string[] = [];
    const launchedApps = runtimeOptions?.launchedApps || new Set<string>();
    const progressGuard = createTurnProgressGuard({ maxStuckTurns: 2, launchedApps });
    let toolsExecutedCount = 0;
    let lastExecutedAppCmd = '';

    const isImplementationTask =
      !isExecuteOnly &&
      (task.affectedFiles.length > 0 ||
        /\b(implement|create|write|build|add|code|fix|develop|test|setup)\b/i.test(task.title + ' ' + task.description));

    const runId = runtimeOptions?.runId || `run_${Date.now()}`;

    while (turns < maxTurns) {
      turns++;
      if (abortSignal?.aborted) {
        throw new Error('Multi-agent execution cancelled by user.');
      }

      let content = '';
      let rawThinking = '';
      let toolCalls: any = undefined;
      let phaseNotified = false;
      this.emitSafeStatus(runtimeOptions, 'analyzing', 'Analyzing the task');
      const turnThought = createTurnThoughtTracker({
        runId,
        agentId: this.config.id,
        agentName: this.config.name,
        agentRole: this.config.role,
        title: `${this.config.name} Thinking`,
        stepKey: `${task.id}_t${turns}`,
        onStreamEvent: runtimeOptions?.onStreamEvent,
      });

      for (let streamAttempt = 0; streamAttempt < 2; streamAttempt++) {
        content = '';
        rawThinking = '';
        toolCalls = undefined;
        phaseNotified = false;
        try {
          await this.llmRouter.chatStream(
            {
              model: this.config.model,
              messages,
              tools,
              temperature: runtimeOptions?.temperature ?? this.config.temperature ?? 0.2,
              maxOutputTokens: runtimeOptions?.maxOutputTokens,
              contextWindow: runtimeOptions?.contextLimit,
              reasoningEffort: runtimeOptions?.reasoningEffort,
              fastMode: runtimeOptions?.fastMode,
            },
            (chunk) => {
              content += chunk.content;
              if (chunk.thinking) rawThinking += chunk.thinking;
              turnThought.updateFromStream(content, rawThinking);
              if (chunk.toolCalls && chunk.toolCalls.length > 0) {
                toolCalls = [...(toolCalls || []), ...chunk.toolCalls];
              }
              if (!phaseNotified && (chunk.content || chunk.thinking)) {
                phaseNotified = true;
                this.emitSafeStatus(
                  runtimeOptions,
                  isExecuteOnly ? 'working' : 'generating',
                  isExecuteOnly ? 'Running application' : 'Generating code'
                );
              }
            },
            abortSignal
          );
          break;
        } catch (streamErr: any) {
          const msg = String(streamErr?.message || '');
          const transient =
            /llama-server process no longer running|unexpected EOF|ECONNRESET|socket hang up/i.test(msg);
          if (streamAttempt === 0 && transient && !abortSignal?.aborted) {
            this.emitSafeStatus(runtimeOptions, 'working', 'Retrying local model execution');
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          turnThought.finalize(content, rawThinking);
          throw streamErr;
        }
      }

      // 1. Check for native tool calls
      let activeCalls: Array<{ name: string; args: any }> = [];
      if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          const fn = tc.function || tc;
          let args = {};
          try {
            args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments || {};
          } catch {
            args = {};
          }
          activeCalls.push({ name: fn.name, args });
        }
      }

      // 2. Check for embedded text tool calls (<tool_call>... or ```json {"tool": ...} ```)
      if (activeCalls.length === 0) {
        const embeddedCalls = parseToolCallsFromContent(content);
        if (embeddedCalls.length > 0) {
          activeCalls = embeddedCalls;
        }
      }

      const fallbackThoughtNote =
        activeCalls.length > 0
          ? `Step "${task.title}": executing ${activeCalls.map((c) => `${c.name}(${c.args?.path || c.args?.command || ''})`).join(', ')}`
          : undefined;
      turnThought.finalize(content, rawThinking, fallbackThoughtNote);

      // 3. Fallback: Parse code blocks with filenames and automatically persist them via write_file
      if (activeCalls.length === 0 && !isExecuteOnly) {
        const extractedFiles = parseCodeBlocksFromContent(content, task.affectedFiles);
        if (extractedFiles.length > 0) {
          for (const ef of extractedFiles) {
            const { result: writeRes } = await executeTrackedTool({
              runId,
              agentId: this.config.id,
              agentName: this.config.name,
              agentRole: this.config.role,
              toolName: 'write_file',
              args: { path: ef.path, content: ef.content },
              toolManager: this.toolManager,
              baseCtx: toolCtx,
              abortSignal,
              onStreamEvent: runtimeOptions?.onStreamEvent,
            });
            if (writeRes.success) {
              filesWritten.push(ef.path);
              toolsExecutedCount++;
            }
          }
        }
      }

      messages.push({
        role: 'assistant',
        content,
        tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      });

      // 4. Execute tool calls if any were found
      if (activeCalls.length > 0) {
        let skippedAllAsDuplicate = true;
        let turnMadeProgress = false;
        let executedReadOnly = false;
        let lastCommandHint = '';
        for (const call of activeCalls) {
          if (abortSignal?.aborted) {
            throw new Error('Multi-agent execution cancelled by user.');
          }

          if (isExecuteOnly && executeOnlyBlockedTools.has(call.name)) {
            const blockedJson = JSON.stringify({
              success: false,
              error: `Tool '${call.name}' is disabled because the user asked to run existing code without modifying files. Use 'run_command' or 'start_process' to run existing files.`,
            });
            skippedAllAsDuplicate = false;
            lastCommandHint = `Do NOT use ${call.name}. Run the existing application using 'run_command' or 'start_process'.`;
            if (toolCalls && toolCalls.length > 0) {
              messages.push({ role: 'tool', tool_name: call.name, content: blockedJson });
            } else {
              messages.push({ role: 'user', content: `[Tool Result for ${call.name}]: ${blockedJson}` });
            }
            continue;
          }

          const preCheck = progressGuard.checkBeforeCall(call.name, call.args);
          if (preCheck.skip) {
            if (preCheck.reason) lastCommandHint = preCheck.reason;
            if (toolCalls && toolCalls.length > 0) {
              messages.push({ role: 'tool', tool_name: call.name, content: preCheck.cachedResultJson });
            } else {
              messages.push({ role: 'user', content: `[Tool Result for ${call.name}]: ${preCheck.cachedResultJson}` });
            }
            continue;
          }

          skippedAllAsDuplicate = false;
          toolsExecutedCount++;
          if (
            call.name === 'read_file' ||
            call.name === 'list_directory' ||
            call.name === 'search_codebase' ||
            call.name === 'search_symbols'
          ) {
            executedReadOnly = true;
          }

          const { result: res } = await executeTrackedTool({
            runId,
            agentId: this.config.id,
            agentName: this.config.name,
            agentRole: this.config.role,
            toolName: call.name,
            args: call.args,
            toolManager: this.toolManager,
            baseCtx: toolCtx,
            abortSignal,
            onStreamEvent: runtimeOptions?.onStreamEvent,
          });

          if (res.cancelled || abortSignal?.aborted) {
            throw new Error('Multi-agent execution cancelled by user.');
          }

          const outcome = progressGuard.recordOutcome(call.name, call.args, res);
          if (outcome.modifiedFile) filesWritten.push(outcome.modifiedFile);
          if (outcome.madeProgress) {
            turnMadeProgress = true;
            if (
              call.name === 'start_process' ||
              call.name === 'app.launch' ||
              call.name === 'run_command'
            ) {
              const rawCmd = String(call.args?.command || call.args?.cmd || '').trim();
              if (rawCmd) lastExecutedAppCmd = rawCmd;
            }
          }
          if (outcome.commandHint) lastCommandHint = outcome.commandHint;

          const resStr = JSON.stringify(res);
          const boundedStr = resStr.length > 12000 ? resStr.slice(0, 12000) + '... [truncated]' : resStr;

          if (toolCalls && toolCalls.length > 0) {
            messages.push({
              role: 'tool',
              tool_name: call.name,
              content: boundedStr,
            });
          } else {
            messages.push({
              role: 'user',
              content: `[Tool Result for ${call.name}]: ${boundedStr}\n${
                lastCommandHint
                  ? lastCommandHint
                  : isExecuteOnly && launchedApps.size > 0
                  ? `Application '${lastExecutedAppCmd || 'command'}' already ran/started. Do NOT reopen or rerun it if the user closes it — concisely summarize completion now.`
                  : isExecuteOnly
                  ? 'Execution step recorded. If the application/command has now run or started, reply concisely with the observed command and output. Do NOT rewrite existing files.'
                  : filesWritten.length > 0
                  ? 'If code changes are complete, run verification tests or provide a concise summary without repeating identical file writes.'
                  : 'Continue implementing the task.'
              }`,
            });
          }
        }

        if (progressGuard.shouldStopTurn({ skippedAll: skippedAllAsDuplicate, turnMadeProgress, executedReadOnly })) {
          finalOutput =
            launchedApps.size > 0 && lastExecutedAppCmd
              ? `Executed \`${lastExecutedAppCmd}\` successfully.`
              : `Stopped task after repeated unchanged/blocked operations (${Array.from(new Set(filesWritten)).join(', ') || 'no file changes'}).`;
          break;
        }

        // If native tool calls were emitted, append a prompt so Qwen template always has a user turn
        if (toolCalls && toolCalls.length > 0) {
          messages.push({
            role: 'user',
            content: lastCommandHint
              ? `Command guidance: ${lastCommandHint}`
              : isExecuteOnly && launchedApps.size > 0
              ? `Application '${lastExecutedAppCmd || 'target'}' has already been started/executed. Do NOT call run_command or start_process again — summarize what was run and finish now.`
              : isExecuteOnly
              ? `Tool executions completed. If you already ran or started the target application/command, report the exact command and output concisely. Otherwise run it with 'run_command' or 'start_process' now.`
              : filesWritten.length > 0
              ? `Tool executions completed. If all required files (${Array.from(new Set(filesWritten)).join(', ')}) are complete, run verification tests with 'run_command' or reply with a concise completion summary.`
              : `Tool executions completed. Continue implementing the task. Use 'write_file' to save code to disk, and 'run_command' to run tests.`,
          });
        }

        continue;
      }

      // 5. Nudge if task produced pure text without invoking required tools
      if (isExecuteOnly && toolsExecutedCount === 0 && turns < 3) {
        this.emitSafeStatus(runtimeOptions, 'working', 'Requesting application execution');
        messages.push({
          role: 'user',
          content: 'Please execute the requested existing file or command right now using run_command or start_process (inspecting root files with list_directory/read_file first if needed), without modifying source files.',
        });
        continue;
      }
      if (isImplementationTask && filesWritten.length === 0 && toolsExecutedCount === 0 && turns < 3) {
        this.emitSafeStatus(runtimeOptions, 'working', 'Requesting file write execution');
        messages.push({
          role: 'user',
          content: 'CRITICAL: You explained the solution, but NO files were written to disk. You must call write_file(path, content) right now to persist the code into the workspace.',
        });
        continue;
      }

      finalOutput = sanitizeAssistantContent(content);
      break;
    }

    // 6. Automated Verification: run real workspace tests / syntax checks without inventing fake commands
    let verificationSummary = '';
    let verificationFailed = false;
    if (filesWritten.length > 0 && !abortSignal?.aborted) {
      const verifyRes = await this.verifyWorkspaceCode(filesWritten, toolCtx, runId, runtimeOptions, abortSignal);
      if (verifyRes.executed) {
        verificationSummary = verifyRes.summary;
        verificationFailed = !verifyRes.passed;
      }
    }

    const summary = filesWritten.length > 0
      ? `Successfully implemented and persisted files: ${filesWritten.join(', ')}`
      : finalOutput || 'Task completed.';

    return {
      success: true,
      output: summary,
      modifiedFiles: filesWritten,
      verificationSummary,
      verificationFailed,
    };
  }

  /**
   * Detects real workspace test or syntax verification commands (without inventing nonexistent runners)
   * and captures pass/fail state + stdout/stderr for the Critic -> Main Agent feedback loop.
   */
  private async verifyWorkspaceCode(
    candidateFiles: string[],
    toolCtx: ToolExecutionContext,
    runId: string,
    runtimeOptions?: RuntimeModelOptions,
    abortSignal?: AbortSignal
  ): Promise<{ executed: boolean; passed: boolean; summary: string }> {
    let rootFiles: string[] = [];
    try {
      rootFiles = fs.readdirSync(this.workspaceRoot);
    } catch {
      return { executed: false, passed: true, summary: '' };
    }

    const combinedFiles = Array.from(new Set([...candidateFiles, ...rootFiles]));
    const pyTestFiles = combinedFiles.filter((f) => /(?:^|\/)(?:test_.*\.py|.*_test\.py)$/i.test(f));
    const pySourceFiles = candidateFiles.filter((f) => /\.py$/i.test(f));

    let cmd = '';
    if (pyTestFiles.length > 0) {
      cmd = pyTestFiles.length === 1
        ? `python3 -m unittest "${pyTestFiles[0]}"`
        : 'python3 -m unittest discover -s . -p "*test*.py"';
    } else if (pySourceFiles.length > 0) {
      cmd = `python3 -m py_compile ${pySourceFiles.map((f) => `"${f}"`).join(' ')}`;
    } else if (rootFiles.includes('package.json') && candidateFiles.some((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(f))) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(this.workspaceRoot, 'package.json'), 'utf8'));
        const testScript = String(pkg?.scripts?.test || '');
        if (testScript && !/no test specified/i.test(testScript)) {
          cmd = 'npm test';
        }
      } catch {}
    }

    if (!cmd) {
      return { executed: false, passed: true, summary: '' };
    }

    this.emitSafeStatus(runtimeOptions, 'verifying', `Running ${cmd}`);
    const { result: res } = await executeTrackedTool({
      runId,
      agentId: this.config.id,
      agentName: this.config.name,
      agentRole: this.config.role,
      toolName: 'run_command',
      args: { command: cmd },
      toolManager: this.toolManager,
      baseCtx: toolCtx,
      abortSignal,
      onStreamEvent: runtimeOptions?.onStreamEvent,
    });

    const out = res?.output || {};
    const exitCode = typeof out.exitCode === 'number' ? out.exitCode : (res?.success ? 0 : 1);
    const passed = Boolean(res?.success && exitCode === 0);
    const stdout = String(out.stdout || '').trim();
    const stderr = String(out.stderr || res?.error || '').trim();
    const combinedOut = [stdout, stderr].filter(Boolean).join('\n').slice(0, 4000);
    const summary = `Command: ${cmd}\nExit code: ${exitCode}${combinedOut ? `\nOutput:\n${combinedOut}` : ''}`;

    return { executed: true, passed, summary };
  }

  // Address Critic findings and re-verify updated code before next Critic review round
  private async addressCriticFindings(
    report: CriticReport,
    affectedFiles: string[],
    verificationSummary: string,
    round: number,
    onActivity: (msg: string) => void,
    requestApproval: (req: any) => Promise<boolean>,
    abortSignal?: AbortSignal,
    runtimeOptions?: RuntimeModelOptions
  ): Promise<{ modifiedFiles: string[]; verificationFailed: boolean; verificationSummary: string }> {
    const pmMode = this.toolManager.getPermissionManager()?.getNormalizedMode();
    const toolCtx: ToolExecutionContext = {
      workspaceRoot: this.workspaceRoot,
      agentId: this.config.id,
      agentName: this.config.name,
      requireApproval: pmMode === 'bypass' ? false : true,
      requestApproval,
    };

    const remediationBlockedTools = new Set([
      'start_process',
      'write_stdin',
      'app.launch',
      'app.open_url',
      'app.open_file',
    ]);
    const tools = this.toolManager
      .getOllamaTools()
      .filter((t: any) => !remediationBlockedTools.has(t?.function?.name || ''));
    const findingsList = (report.findings || [])
      .map(
        (f, i) =>
          `${i + 1}. [${f.severity}] in ${f.filePath} (lines ${f.lineRange || 'N/A'}):\n` +
          `   Evidence: ${f.evidence}\n` +
          `   Problem: ${f.explanation}\n` +
          `   Recommended Fix: ${f.recommendedFix}`
      )
      .join('\n\n');

    const targetCandidates = Array.from(
      new Set([
        ...affectedFiles,
        ...(report.findings || []).map((f) => f.filePath).filter((p) => Boolean(p && p !== 'workspace')),
      ])
    ).slice(0, 4);

    const fileSnapshots: string[] = [];
    for (const rel of targetCandidates) {
      try {
        const abs = path.resolve(this.workspaceRoot, rel);
        if (abs.startsWith(path.resolve(this.workspaceRoot)) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          const rawText = fs.readFileSync(abs, 'utf-8');
          const numbered = rawText
            .split(/\r?\n/)
            .slice(0, 100)
            .map((l, idx) => `${idx + 1}: ${l}`)
            .join('\n')
            .slice(0, 2500);
          fileSnapshots.push(`--- CURRENT FILE: ${rel} ---\n${numbered}`);
        }
      } catch {
        // non-fatal snapshot skip
      }
    }

    const prompt = `CRITIC REVIEW FEEDBACK (Round ${round}, Verdict: ${report.verdict.toUpperCase()}):
Summary: ${report.summary}

${findingsList || 'No structured findings array provided; see verification output below.'}
${verificationSummary ? `\nRECENT VERIFICATION OUTPUT:\n${verificationSummary}\n` : ''}
Currently affected files: ${affectedFiles.join(', ') || '(inspect workspace)'}
${fileSnapshots.length > 0 ? `\nACTUAL FILE CONTENTS ON DISK:\n${fileSnapshots.join('\n\n')}\n` : ''}
INSTRUCTIONS:
1. Fix EVERY defect reported above using exact substrings in 'edit_file' or complete corrected contents in 'write_file'.
2. Ensure valid, complete source code — never write JSON tool payloads into source files, and never repeat an identical failing 'edit_file'.
3. Run automated verification tests (unittest, pytest, py_compile, npm test) with 'run_command' ONLY AFTER saving edits. Do NOT launch interactive GUI applications.`;

    const messages: any[] = [
      {
        role: 'system',
        content: `You are the Lead Main Agent working in ${this.workspaceRoot}. Fix all defects reported by the Critic Agent using file tools and run automated tests only (never launch interactive GUI applications).`,
      },
      { role: 'user', content: prompt },
    ];

    const modifiedFiles: string[] = [];
    const fixRunId = runtimeOptions?.runId || `run_${Date.now()}`;
    const progressGuard = createTurnProgressGuard({
      maxStuckTurns: 2,
      blockInteractiveApps: true,
      launchedApps: runtimeOptions?.launchedApps,
    });
    let turns = 0;

    while (turns < 5) {
      turns++;
      if (abortSignal?.aborted) {
        throw new Error('Multi-agent execution cancelled by user.');
      }

      let content = '';
      let rawThinking = '';
      let toolCalls: any = undefined;
      const fixThought = createTurnThoughtTracker({
        runId: fixRunId,
        agentId: this.config.id,
        agentName: this.config.name,
        agentRole: this.config.role,
        title: `Fixing Critic Feedback (Round ${round})`,
        stepKey: `fix_r${round}_t${turns}`,
        onStreamEvent: runtimeOptions?.onStreamEvent,
      });

      await this.llmRouter.chatStream(
        {
          model: this.config.model,
          messages,
          tools,
          temperature: runtimeOptions?.temperature ?? 0.1,
          maxOutputTokens: runtimeOptions?.maxOutputTokens,
          contextWindow: runtimeOptions?.contextLimit,
          reasoningEffort: runtimeOptions?.reasoningEffort,
          fastMode: runtimeOptions?.fastMode,
        },
        (chunk) => {
          content += chunk.content;
          if (chunk.thinking) rawThinking += chunk.thinking;
          fixThought.updateFromStream(content, rawThinking);
          if (chunk.toolCalls && chunk.toolCalls.length > 0) {
            toolCalls = [...(toolCalls || []), ...chunk.toolCalls];
          }
        },
        abortSignal
      );

      let activeCalls: Array<{ name: string; args: any }> = [];
      if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          const fn = tc.function || tc;
          let args = {};
          try {
            args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments || {};
          } catch {}
          activeCalls.push({ name: fn.name, args });
        }
      }

      if (activeCalls.length === 0) {
        activeCalls = parseToolCallsFromContent(content);
      }

      if (activeCalls.length === 0) {
        const fallbackFiles = parseCodeBlocksFromContent(content, affectedFiles);
        for (const ff of fallbackFiles) {
          activeCalls.push({ name: 'write_file', args: { path: ff.path, content: ff.content } });
        }
      }

      fixThought.finalize(
        content,
        rawThinking,
        activeCalls.length > 0
          ? `Applying Critic Round ${round} fixes: ${activeCalls.map((c) => `${c.name}(${c.args?.path || c.args?.command || ''})`).join(', ')}`
          : undefined
      );

      messages.push({ role: 'assistant', content, tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined });
      if (activeCalls.length === 0) break;

      let skippedAll = true;
      let turnMadeProgress = false;
      let executedReadOnly = false;
      for (const call of activeCalls) {
        const preCheck = progressGuard.checkBeforeCall(call.name, call.args);
        if (preCheck.skip) {
          if (toolCalls && toolCalls.length > 0) {
            messages.push({ role: 'tool', tool_name: call.name, content: preCheck.cachedResultJson });
          } else {
            messages.push({ role: 'user', content: `[Tool Result for ${call.name}]: ${preCheck.cachedResultJson}` });
          }
          continue;
        }
        skippedAll = false;
        if (
          call.name === 'read_file' ||
          call.name === 'list_directory' ||
          call.name === 'search_codebase' ||
          call.name === 'search_symbols'
        ) {
          executedReadOnly = true;
        }

        const { result: res } = await executeTrackedTool({
          runId: fixRunId,
          agentId: this.config.id,
          agentName: this.config.name,
          agentRole: this.config.role,
          toolName: call.name,
          args: call.args,
          toolManager: this.toolManager,
          baseCtx: toolCtx,
          abortSignal,
          onStreamEvent: runtimeOptions?.onStreamEvent,
        });

        if (res?.cancelled || abortSignal?.aborted) {
          throw new Error('Multi-agent execution cancelled by user.');
        }

        const outcome = progressGuard.recordOutcome(call.name, call.args, res);
        if (outcome.modifiedFile) modifiedFiles.push(outcome.modifiedFile);
        if (outcome.madeProgress) turnMadeProgress = true;

        const resStr = JSON.stringify(res);
        const boundedStr = resStr.length > 12000 ? resStr.slice(0, 12000) + '... [truncated]' : resStr;
        if (toolCalls && toolCalls.length > 0) {
          messages.push({ role: 'tool', tool_name: call.name, content: boundedStr });
        } else {
          messages.push({ role: 'user', content: `[Tool Result for ${call.name}]: ${boundedStr}` });
        }
      }
      if (progressGuard.shouldStopTurn({ skippedAll, turnMadeProgress, executedReadOnly })) {
        break;
      }
      if (toolCalls && toolCalls.length > 0) {
        messages.push({
          role: 'user',
          content: 'Correction tools executed. Verify whether tests pass now or summarize remaining fixes.',
        });
      }
    }

    const candidates = Array.from(new Set([...modifiedFiles, ...affectedFiles]));
    const verifyRes = await this.verifyWorkspaceCode(candidates, toolCtx, fixRunId, runtimeOptions, abortSignal);
    onActivity(
      modifiedFiles.length > 0
        ? `[Main Agent] Applied fixes to: ${Array.from(new Set(modifiedFiles)).join(', ')}. Submitting for Critic re-review...`
        : '[Main Agent] Remediation pass completed. Submitting for Critic re-review...'
    );

    return {
      modifiedFiles: Array.from(new Set(modifiedFiles)),
      verificationFailed: verifyRes.executed ? !verifyRes.passed : false,
      verificationSummary: verifyRes.executed ? verifyRes.summary : verificationSummary,
    };
  }
}
