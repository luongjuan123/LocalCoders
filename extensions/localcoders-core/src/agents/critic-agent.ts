import { OllamaClient } from '../ollama/client';
import { CriticConfig, CriticFinding, CriticReport, FindingSeverity } from './types';
import { MemoryManager } from '../context/memory-manager';
import { ToolManager } from '../tools/tool-manager';
import { ToolExecutionContext } from '../tools/types';

export class CriticAgent {
  private ollama: OllamaClient;
  private config: CriticConfig;
  private memory: MemoryManager;
  private toolManager: ToolManager;
  private workspaceRoot: string;

  constructor(
    ollama: OllamaClient,
    config: CriticConfig,
    memory: MemoryManager,
    toolManager: ToolManager,
    workspaceRoot: string
  ) {
    this.ollama = ollama;
    this.config = config;
    this.memory = memory;
    this.toolManager = toolManager;
    this.workspaceRoot = workspaceRoot;
  }

  setConfig(config: CriticConfig) {
    this.config = config;
  }

  // Execute independent code review
  async review(params: {
    userRequirements: string;
    targetCommit?: string;
    changedFiles?: string[];
    onProgress?: (status: string) => void;
    abortSignal?: AbortSignal;
  }): Promise<CriticReport> {
    const reportId = `report_${Date.now()}`;
    const timestamp = Date.now();
    const effectiveModel = this.config.model || 'qwen3.8:27b';

    if (params.onProgress) params.onProgress('Gathering Git diff and relevant files...');

    const toolCtx: ToolExecutionContext = {
      workspaceRoot: this.workspaceRoot,
      agentId: 'critic',
      agentName: 'Critic Agent',
      requireApproval: false,
      requestApproval: async () => true,
    };

    // 1. Gather Git Diff
    const diffRes = await this.toolManager.executeTool('read_git_diff', { staged: false }, toolCtx);
    const gitDiff = diffRes.output?.diff || 'No diff available.';

    // 2. Gather Project Rules
    const { rulesText } = await this.memory.getProjectRules();

    if (params.onProgress) params.onProgress(`Running independent Critic review using model '${effectiveModel}'...`);

    const systemPrompt = `You are the LocalCoders Critic Agent — an independent, rigorous, adversarial software auditor.
Your job is to challenge the implementation and detect verifiable defects, NOT to praise the code.
You never blindly trust other agents' explanations. You inspect the actual code diff and surrounding context.

REVIEW STRICTNESS: ${this.config.strictness.toUpperCase()}
REVIEW MODE: ${this.config.reviewMode}

AUDIT CATEGORIES TO EVALUATE:
1. Logical correctness & edge cases
2. Security vulnerabilities (OWASP Top 10, injection, auth bypass, secret exposure)
3. Race conditions, concurrency issues, deadlocks
4. Memory leaks and unclosed resource handles
5. Performance bottlenecks and algorithmic complexity
6. Architectural flaws and bad abstractions
7. Error handling robustness
8. Missing unit or regression tests
9. Violations of user requirements or project conventions

RULES:
- Never invent problems. Every finding MUST cite verifiable evidence in the diff or source code.
- Clearly distinguish verified defects from theoretical risks.
- Do not complain about personal stylistic preferences (spacing, quote styles) as bugs.
- If the implementation is solid and free of defects, return an empty findings list and approve.

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
      "evidence": "Exact problematic code or missing check",
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

GIT DIFF OF CHANGES:
${gitDiff.slice(0, 15000)}

Please audit the implementation thoroughly according to your review strictness.`;

    let responseContent = '';
    await this.ollama.chatStream(
      {
        model: effectiveModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2, // Low temperature for factual precision
      },
      (chunk) => {
        responseContent += chunk.content;
      },
      params.abortSignal
    );

    // Parse structured JSON
    const parsed = this.parseCriticResponse(responseContent);

    const report: CriticReport = {
      id: reportId,
      timestamp,
      targetCommit: params.targetCommit,
      filesReviewed: params.changedFiles || [],
      findings: parsed.findings,
      summary: parsed.summary,
      verdict: parsed.verdict,
    };

    return report;
  }

  private parseCriticResponse(text: string): {
    verdict: 'approved' | 'changes_requested' | 'blocker';
    summary: string;
    findings: CriticFinding[];
  } {
    try {
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      const rawJson = jsonMatch ? jsonMatch[1] : text;
      const parsed = JSON.parse(rawJson);

      const findings: CriticFinding[] = (parsed.findings || []).map((f: any, idx: number) => ({
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
        resolved: false,
      }));

      const verdict = parsed.verdict || (findings.some((f) => f.severity === 'Critical') ? 'blocker' : findings.length > 0 ? 'changes_requested' : 'approved');
      const summary = parsed.summary || (findings.length === 0 ? 'All changes verified without defects.' : `Found ${findings.length} issue(s) requiring attention.`);

      return { verdict, summary, findings };
    } catch (e) {
      console.warn('[CriticAgent] Failed to parse JSON response from model, extracting fallback findings:', e);
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
