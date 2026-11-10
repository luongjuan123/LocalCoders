import * as fs from 'fs';
import * as path from 'path';
import { OllamaClient } from '../ollama/client';
import { LLMRouter } from '../models/llm-router';
import { CriticConfig, CriticFinding, CriticReport, FindingSeverity } from './types';
import { MemoryManager } from '../context/memory-manager';
import { ToolManager } from '../tools/tool-manager';
import { ToolExecutionContext } from '../tools/types';
import { OperationHistoryManager } from '../commands/operation-history';
import { computeUnifiedLineDiff } from '../context/changes-manager';
import { AgentStreamEvent, extractBalancedJsonObjects } from './events';
import { createTurnThoughtTracker } from './tool-runner';

const IGNORED_REVIEW_DIRS = new Set(['.git', 'node_modules', 'venv', '.venv', '.localcoders', '__pycache__', 'dist', 'out']);

export class CriticAgent {
  private ollama: OllamaClient;
  private llmRouter: LLMRouter;
  private config: CriticConfig;
  private memory: MemoryManager;
  private toolManager: ToolManager;
  private workspaceRoot: string;

  constructor(
    ollama: OllamaClient,
    config: CriticConfig,
    memory: MemoryManager,
    toolManager: ToolManager,
    workspaceRoot: string,
    llmRouter?: LLMRouter
  ) {
    this.ollama = ollama;
    this.llmRouter = llmRouter || new LLMRouter(ollama);
    this.config = config;
    this.memory = memory;
    this.toolManager = toolManager;
    this.workspaceRoot = workspaceRoot;
  }

  setConfig(config: CriticConfig) {
    this.config = config;
  }

  getConfig(): CriticConfig {
    return this.config;
  }

  // Execute independent code review across Git or non-Git tracked workspace changes
  async review(params: {
    userRequirements: string;
    targetCommit?: string;
    changedFiles?: string[];
    verificationSummary?: string;
    runId?: string;
    round?: number;
    onStreamEvent?: (ev: AgentStreamEvent) => void;
    onProgress?: (status: string) => void;
    abortSignal?: AbortSignal;
  }): Promise<CriticReport> {
    const reportId = `report_${Date.now()}`;
    const timestamp = Date.now();
    const effectiveModel = (this.config.model || '').trim();
    if (!effectiveModel) {
      return {
        id: reportId,
        timestamp,
        targetCommit: params.targetCommit,
        filesReviewed: params.changedFiles || [],
        verdict: 'approved',
        findings: [],
        summary: 'Critic audit skipped: no Critic model configured.',
      };
    }

    if (params.onProgress) params.onProgress('Gathering workspace diff and modified source files...');

    const ctx = await this.gatherReviewContext(params);
    if (ctx.nothingToReview) {
      return {
        id: reportId,
        timestamp,
        targetCommit: params.targetCommit,
        filesReviewed: [],
        verdict: 'approved',
        findings: [],
        summary: 'Critic audit skipped: no modified files detected.',
      };
    }

    // 2. Gather Project Rules
    const { rulesText } = await this.memory.getProjectRules();

    if (params.onProgress) params.onProgress(`Running independent Critic review using model '${effectiveModel}'...`);

    const systemPrompt = `You are the LocalCoders Critic Agent — an independent, rigorous, adversarial software auditor.
Your job is to challenge the implementation and detect verifiable defects, NOT to praise the code.
You inspect the actual code diff, saved file contents on disk, and test/command verification outputs.

REVIEW STRICTNESS: ${this.config.strictness.toUpperCase()}
REVIEW MODE: ${this.config.reviewMode}

AUDIT CATEGORIES TO EVALUATE:
1. Logical correctness & edge cases (including syntax errors, broken imports, wrong file contents)
2. Security vulnerabilities (OWASP Top 10, injection, auth bypass, secret exposure)
3. Race conditions, concurrency issues, deadlocks
4. Memory leaks and unclosed resource handles
5. Performance bottlenecks and algorithmic complexity
6. Architectural flaws and bad abstractions
7. Error handling robustness
8. Missing or failing unit/regression tests
9. Violations of user requirements or project conventions

RULES:
- Never invent problems. Every finding MUST cite verifiable evidence in the diff, source files, or test output.
- If automated verification failed or a file contains syntax errors/corrupted JSON/wrong code, ALWAYS return "blocker" or "changes_requested" with exact file and recommendedFix.
- Assign "Critical" or "High" severity ONLY to real defects: failing tests, syntax/import/runtime errors, security vulnerabilities, race conditions, or clearly unmet user requirements.
- Classify stylistic preferences, naming choices, or optional cleanup (e.g. redundant helper methods when tests pass) strictly as "Low" or "Informational" — NEVER mark working code with "Critical" or "blocker" over optional refactoring.
- Do not block completion when automated verification passed (Exit code: 0) and there are no real runtime, security, or requirement defects.
- If the implementation and verification are completely solid and free of defects, return an empty findings list and "verdict": "approved".

OUTPUT FORMAT:
Respond with a STRICT JSON block in this exact structure:
\`\`\`json
{
  "verdict": "approved" | "changes_requested" | "blocker",
  "summary": "Concise executive audit summary",
  "findings": [
    {
      "id": "find-1",
      "severity": "Critical" | "High" | "Medium" | "Low" | "Informational",
      "category": "Security vulnerabilities" | "Logical correctness" | etc,
      "filePath": "src/example.ts",
      "lineRange": "45-52",
      "evidence": "Exact problematic code or failing error",
      "explanation": "Why this is an issue and potential impact",
      "reproduction": "Scenario or input that triggers the issue",
      "recommendedFix": "Concrete code correction",
      "confidence": "Confirmed" | "Likely" | "Needs verification"
    }
  ]
}
\`\`\`
`;

    const userPrompt = `ORIGINAL USER REQUIREMENTS:
${params.userRequirements}

PROJECT RULES & CONVENTIONS:
${rulesText}
${params.verificationSummary ? `\nRECENT TEST / VERIFICATION OUTPUT:\n${params.verificationSummary.slice(0, 6000)}\n` : ''}
DIFF OF CHANGES:
${ctx.diffText.slice(0, 12000)}
${ctx.fileSnapshotsText ? `\nCURRENT WORKSPACE FILE CONTENTS ON DISK:\n${ctx.fileSnapshotsText}` : ''}

Please audit the implementation thoroughly according to your review strictness and return valid JSON.`;

    let responseContent = '';
    let responseThinking = '';
    const criticThought = createTurnThoughtTracker({
      runId: params.runId || 'run_default',
      agentId: 'critic',
      agentName: 'Critic Agent',
      agentRole: 'Code Quality & Security Critic',
      title: params.round ? `Critic Reasoning (Round ${params.round})` : 'Critic Reasoning',
      stepKey: `r${params.round || 1}`,
      onStreamEvent: params.onStreamEvent,
    });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        responseContent = '';
        responseThinking = '';
        try {
          await this.llmRouter.chatStream(
            {
              model: effectiveModel,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
              temperature: 0.15,
            },
            (chunk) => {
              responseContent += chunk.content;
              if (chunk.thinking) responseThinking += chunk.thinking;
              criticThought.updateFromStream(responseContent, responseThinking);
            },
            params.abortSignal
          );
          break;
        } catch (innerErr: any) {
          if (params.abortSignal?.aborted) throw innerErr;
          const transient = /llama-server process no longer running|unexpected EOF|ECONNRESET|socket hang up/i.test(
            String(innerErr?.message || '')
          );
          if (attempt === 0 && transient) {
            if (params.onProgress) {
              params.onProgress(`Retrying Critic review with '${effectiveModel}' after transient runner error...`);
            }
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          throw innerErr;
        }
      }
    } catch (err: any) {
      criticThought.finalize(responseContent, responseThinking, `Critic review halted: ${err?.message || 'error'}`);
      if (params.abortSignal?.aborted || /cancelled/i.test(err?.message || '')) {
        throw err;
      }
      console.warn(`[CriticAgent] Audit with '${effectiveModel}' encountered error:`, err.message);
      if (params.onProgress) {
        params.onProgress(`[Critic Agent] Model '${effectiveModel}' error: ${err.message}`);
      }
      return {
        id: reportId,
        timestamp,
        targetCommit: params.targetCommit,
        filesReviewed: ctx.filesReviewed,
        verdict: 'changes_requested',
        findings: [
          {
            id: 'critic-exec-err',
            severity: 'High',
            category: 'Critic execution',
            filePath: 'workspace',
            evidence: err.message || 'Unknown Critic model execution error',
            explanation: `Critic model '${effectiveModel}' failed to complete automated review: ${err.message}`,
            reproduction: `Invoke CriticAgent.review() with model '${effectiveModel}'`,
            recommendedFix: `Verify that Critic model '${effectiveModel}' is installed/running cleanly in Agents settings.`,
            confidence: 'Confirmed',
            resolved: false,
          },
        ],
        summary: `Critic model error (${effectiveModel}): ${err.message}`,
      };
    }

    const parsed = this.parseCriticResponse(responseContent);
    criticThought.finalize(
      responseContent,
      responseThinking,
      `Audited ${ctx.filesReviewed.join(', ') || 'workspace changes'} -> ${parsed.verdict.toUpperCase()}: ${parsed.summary}`
    );
    return {
      id: reportId,
      timestamp,
      targetCommit: params.targetCommit,
      filesReviewed: ctx.filesReviewed,
      findings: parsed.findings,
      summary: parsed.summary,
      verdict: parsed.verdict,
    };
  }

  private async gatherReviewContext(params: {
    changedFiles?: string[];
    verificationSummary?: string;
  }): Promise<{
    nothingToReview: boolean;
    diffText: string;
    fileSnapshotsText: string;
    filesReviewed: string[];
  }> {
    const toolCtx: ToolExecutionContext = {
      workspaceRoot: this.workspaceRoot,
      agentId: 'critic',
      agentName: 'Critic Agent',
      requireApproval: false,
      requestApproval: async () => true,
    };

    const diffRes = await this.toolManager.executeTool('read_git_diff', { staged: false }, toolCtx).catch(() => ({
      output: { diff: '' },
    }));
    const rawGitDiff = String(diffRes?.output?.diff || '').trim();
    const noGitDiff =
      !rawGitDiff ||
      /^(no diff|no changes|no uncommitted|not a git repository|fatal:\s*not a git)/i.test(rawGitDiff);

    let trackedChanges: ReturnType<OperationHistoryManager['getPendingTrackedChanges']> = [];
    try {
      trackedChanges = OperationHistoryManager.getInstance().getPendingTrackedChanges(this.workspaceRoot);
    } catch {}

    const candidateSet = new Set<string>();
    for (const f of params.changedFiles || []) {
      const clean = this.normalizeRelPath(f);
      if (clean) candidateSet.add(clean);
    }
    for (const tc of trackedChanges) {
      if (tc.filePath) candidateSet.add(tc.filePath);
    }
    if (candidateSet.size === 0 && (this.config.reviewMode !== 'changed_files' || params.verificationSummary)) {
      for (const f of this.listWorkspaceSourceFiles(10)) {
        candidateSet.add(f);
      }
    }

    const filesReviewed = Array.from(candidateSet).slice(0, 12);
    let diffText = '';
    if (!noGitDiff) {
      diffText = rawGitDiff;
    } else if (trackedChanges.length > 0) {
      const parts: string[] = [];
      let total = 0;
      for (const tc of trackedChanges) {
        const computed = computeUnifiedLineDiff(tc.filePath, tc.beforeExists, tc.beforeContent, tc.afterExists, tc.afterContent);
        const chunk = computed.diffText || `--- ${tc.filePath}\n(modified)`;
        parts.push(chunk);
        total += chunk.length;
        if (total > 12000) break;
      }
      diffText = parts.join('\n\n');
    } else if (filesReviewed.length > 0) {
      diffText = `Workspace modified/inspected files (non-Git): ${filesReviewed.join(', ')}`;
    }

    let fileSnapshotsText = '';
    let snapshotBudget = 16000;
    const rootResolved = path.resolve(this.workspaceRoot || '');
    if (this.workspaceRoot && fs.existsSync(rootResolved)) {
      const blocks: string[] = [];
      for (const rel of filesReviewed) {
        if (snapshotBudget <= 300) break;
        const abs = path.resolve(rootResolved, rel);
        if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) continue;
        try {
          if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) continue;
          const content = fs.readFileSync(abs, 'utf8');
          const snippet = content.length > 3500 ? content.slice(0, 3500) + '\n... [truncated]' : content;
          const numbered = snippet
            .split('\n')
            .slice(0, 140)
            .map((line, i) => `${i + 1}: ${line}`)
            .join('\n');
          const entry = `=== FILE: ${rel} ===\n${numbered}`;
          blocks.push(entry);
          snapshotBudget -= entry.length;
        } catch {}
      }
      fileSnapshotsText = blocks.join('\n\n');
    }

    const nothingToReview =
      this.config.reviewMode === 'changed_files' &&
      filesReviewed.length === 0 &&
      noGitDiff &&
      trackedChanges.length === 0 &&
      !params.verificationSummary;

    return {
      nothingToReview,
      diffText: diffText || 'No diff available.',
      fileSnapshotsText,
      filesReviewed,
    };
  }

  private normalizeRelPath(filePath: string): string {
    const raw = String(filePath || '').trim();
    if (!raw) return '';
    if (path.isAbsolute(raw) && this.workspaceRoot) {
      const rel = path.relative(path.resolve(this.workspaceRoot), path.resolve(raw)).replace(/\\/g, '/');
      if (rel && !rel.startsWith('..')) return rel;
    }
    return raw.replace(/^\.\//, '').replace(/\\/g, '/');
  }

  private listWorkspaceSourceFiles(limit: number): string[] {
    const found: string[] = [];
    const root = path.resolve(this.workspaceRoot || '');
    if (!root || !fs.existsSync(root)) return found;
    const walk = (dir: string, depth: number) => {
      if (depth > 2 || found.length >= limit) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (found.length >= limit) break;
        if (IGNORED_REVIEW_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full, depth + 1);
        } else if (e.isFile() && /\.(ts|tsx|js|jsx|py|go|rs|java|cpp|c|h|json|md)$/i.test(e.name)) {
          found.push(path.relative(root, full).replace(/\\/g, '/'));
        }
      }
    };
    walk(root, 0);
    return found;
  }

  private parseCriticResponse(text: string): {
    verdict: 'approved' | 'changes_requested' | 'blocker';
    summary: string;
    findings: CriticFinding[];
  } {
    const cleaned = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    try {
      let parsed: any = null;
      const jsonFence = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (jsonFence) {
        try {
          parsed = JSON.parse(jsonFence[1].trim());
        } catch {}
      }
      if (!parsed || typeof parsed !== 'object') {
        const objs = extractBalancedJsonObjects(cleaned);
        parsed = objs.find((o) => typeof o.verdict === 'string' || Array.isArray(o.findings)) || objs[0] || null;
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('No structured Critic JSON found');
      }

      const findings: CriticFinding[] = (Array.isArray(parsed.findings) ? parsed.findings : []).map((f: any, idx: number) => ({
        id: f.id || `find-${idx + 1}`,
        severity: this.normalizeSeverity(f.severity),
        category: f.category || 'Logical correctness',
        filePath: f.filePath || 'unknown',
        lineRange: f.lineRange,
        evidence: f.evidence || '',
        explanation: f.explanation || '',
        reproduction: f.reproduction || '',
        recommendedFix: f.recommendedFix || '',
        confidence: f.confidence || 'Confirmed',
        resolved: Boolean(f.resolved),
      }));

      const rawVerdict = String(parsed.verdict || '').toLowerCase().trim();
      let verdict: 'approved' | 'changes_requested' | 'blocker' =
        rawVerdict === 'blocker' || rawVerdict === 'blocked' || rawVerdict === 'fail' || rawVerdict === 'failed'
          ? 'blocker'
          : rawVerdict === 'changes_requested' || rawVerdict === 'needs_changes' || rawVerdict === 'warning'
          ? 'changes_requested'
          : rawVerdict === 'approved' || rawVerdict === 'pass' || rawVerdict === 'passed'
          ? 'approved'
          : findings.some((f) => f.severity === 'Critical')
          ? 'blocker'
          : findings.length > 0
          ? 'changes_requested'
          : 'approved';

      if (findings.some((f) => f.severity === 'Critical' && !f.resolved)) {
        verdict = 'blocker';
      } else if (verdict === 'approved' && findings.some((f) => (f.severity === 'High' || f.severity === 'Medium') && !f.resolved)) {
        verdict = 'changes_requested';
      }

      const summary =
        parsed.summary ||
        (findings.length === 0 ? 'All changes verified without defects.' : `Found ${findings.length} issue(s) requiring attention.`);

      return { verdict, summary, findings };
    } catch (e) {
      console.warn('[CriticAgent] Failed to parse JSON response from model, extracting fallback findings:', e);
      const explicitlyClean = /\b(no\s+(?:issues|defects|bugs|errors|problems)|0\s+(?:issues|defects|errors)|task completed successfully|all clear|looks good)\b/i.test(
        cleaned
      );
      const reportsError =
        !explicitlyClean &&
        /\b(syntaxerror|traceback|exception|typeerror|nameerror|referenceerror|blocker|critical|defect|bug\b|broken|fails?\b|failing|missing\b|not working|unterminated)\b/i.test(
          cleaned
        );
      if (reportsError && cleaned.length > 0) {
        const excerpt = cleaned.slice(0, 500);
        return {
          verdict: 'changes_requested',
          summary: 'Critic reported defects (unstructured output) requiring Main Agent attention.',
          findings: [
            {
              id: 'find-fallback-1',
              severity: 'High',
              category: 'Code review',
              filePath: 'workspace',
              evidence: excerpt,
              explanation: excerpt,
              reproduction: 'Review workspace changes and test output',
              recommendedFix: excerpt,
              confidence: 'Likely',
              resolved: false,
            },
          ],
        };
      }
      return {
        verdict: 'approved',
        summary: 'Critic completed audit: No critical defects flagged.',
        findings: [],
      };
    }
  }

  private normalizeSeverity(sev: string): FindingSeverity {
    const s = (sev || '').toLowerCase();
    if (s.includes('crit')) return 'Critical';
    if (s.includes('high')) return 'High';
    if (s.includes('med')) return 'Medium';
    if (s.includes('low')) return 'Low';
    return 'Informational';
  }
}
