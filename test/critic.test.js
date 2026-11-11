const { describe, it } = require('node:test');
const assert = require('node:assert');
const { CriticAgent } = require('../extensions/localcoders-core/dist/agents/critic-agent');

describe('CriticAgent — Independent Code Review & Finding Verification', () => {
  const mockConfig = {
    enabled: true,
    model: 'qwen3.8:27b',
    strictness: 'strict',
    categories: ['Security vulnerabilities', 'Logical correctness', 'Memory leaks'],
    trigger: 'on_diff',
    reviewMode: 'changed_files',
  };

  const critic = new CriticAgent(
    { chatStream: async () => {} },
    mockConfig,
    { getProjectRules: async () => ({ rulesText: 'Strict Rules' }) },
    { executeTool: async () => ({ output: { diff: 'Mock Diff' } }) },
    '/mock/workspace'
  );

  it('should parse structured findings and evaluate severity levels', () => {
    const rawModelOutput = `
Here is my independent audit:
\`\`\`json
{
  "verdict": "changes_requested",
  "summary": "Discovered 2 defects: 1 high severity SQL injection risk, 1 missing null check",
  "findings": [
    {
      "id": "crit-1",
      "severity": "High",
      "category": "Security vulnerabilities",
      "filePath": "src/db/users.ts",
      "lineRange": "34-36",
      "evidence": "db.query(\`SELECT * FROM users WHERE id = \${userId}\`)",
      "explanation": "Direct string interpolation in SQL query permits SQL injection attacks.",
      "reproduction": "Pass userId = \\"1 OR 1=1\\"",
      "recommendedFix": "Use parameterized queries: db.query('SELECT * FROM users WHERE id = ?', [userId])",
      "confidence": "Confirmed"
    },
    {
      "id": "crit-2",
      "severity": "Medium",
      "category": "Logical correctness",
      "filePath": "src/auth/session.ts",
      "lineRange": "82",
      "evidence": "const token = req.headers['authorization'].split(' ')[1];",
      "explanation": "No check that authorization header exists before accessing property.",
      "reproduction": "Send request without Authorization header -> TypeError: Cannot read properties of undefined",
      "recommendedFix": "if (!req.headers['authorization']) return res.status(401);",
      "confidence": "Confirmed"
    }
  ]
}
\`\`\`
`;

    const parsed = critic['parseCriticResponse'](rawModelOutput);
    assert.strictEqual(parsed.verdict, 'changes_requested');
    assert.strictEqual(parsed.findings.length, 2);

    const f1 = parsed.findings[0];
    assert.strictEqual(f1.severity, 'High');
    assert.strictEqual(f1.filePath, 'src/db/users.ts');
    assert.ok(f1.evidence.includes('SELECT * FROM users'));
    assert.ok(f1.recommendedFix.includes('parameterized'));

    const f2 = parsed.findings[1];
    assert.strictEqual(f2.severity, 'Medium');
    assert.strictEqual(f2.filePath, 'src/auth/session.ts');
  });

  it('should classify blocker verdict if any critical finding exists', () => {
    const rawOutput = `\`\`\`json
{
  "verdict": "blocker",
  "summary": "Critical authentication bypass detected",
  "findings": [
    {
      "id": "crit-0",
      "severity": "Critical",
      "category": "Authentication and authorization",
      "filePath": "src/auth.ts",
      "evidence": "if (token == null) return next();",
      "explanation": "Allows unauthenticated users to bypass middleware.",
      "reproduction": "Omit token",
      "recommendedFix": "if (!token) return res.status(401).send();",
      "confidence": "Confirmed"
    }
  ]
}
\`\`\``;

    const parsed = critic['parseCriticResponse'](rawOutput);
    assert.strictEqual(parsed.verdict, 'blocker');
    assert.strictEqual(parsed.findings[0].severity, 'Critical');
  });

  it('should inspect non-Git workspace files and failing verification output, and avoid false approvals on error prose', async () => {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-critic-ws-'));
    try {
      fs.writeFileSync(path.join(tmpWs, 'clock.py'), 'def run_clock(:\n    pass\n', 'utf8');
      let capturedPrompt = '';
      const nonGitCritic = new CriticAgent(
        {
          chatStream: async (req, onChunk) => {
            capturedPrompt = req.messages.map((m) => m.content).join('\n');
            onChunk({
              content:
                'Here is my review:\n{"verdict": "blocker", "summary": "Syntax error in clock.py", "findings": [{"severity": "Critical", "filePath": "clock.py", "lineRange": "1", "explanation": "Missing closing parenthesis", "recommendedFix": "def run_clock():"}]}',
              done: true,
            });
          },
        },
        mockConfig,
        { getProjectRules: async () => ({ rulesText: 'None' }) },
        { executeTool: async () => ({ success: false, output: { diff: 'fatal: not a git repository' } }) },
        tmpWs
      );

      const report = await nonGitCritic.review({
        userRequirements: 'Build Python clock',
        changedFiles: ['clock.py'],
        verificationSummary: 'Command: python3 -m py_compile clock.py\nExit code: 1\nSyntaxError: invalid syntax',
      });

      assert.ok(capturedPrompt.includes('def run_clock(:'), 'Critic sees actual file contents even without Git');
      assert.ok(capturedPrompt.includes('SyntaxError: invalid syntax'), 'Critic sees failed verification output');
      assert.strictEqual(report.verdict, 'blocker');
      assert.strictEqual(report.findings.length, 1);

      // Unstructured error prose must NOT silently auto-approve
      const unstructured = nonGitCritic['parseCriticResponse'](
        'I inspected clock.py and found a SyntaxError: unterminated string literal on line 1.'
      );
      assert.strictEqual(unstructured.verdict, 'changes_requested');
      assert.strictEqual(unstructured.findings.length, 1);

      // Neutral/clean unstructured text still approves cleanly
      const cleanProse = nonGitCritic['parseCriticResponse']('Looks good, no issues found.');
      assert.strictEqual(cleanProse.verdict, 'approved');
      assert.strictEqual(cleanProse.findings.length, 0);
    } finally {
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });

  it('should prevent JSON tool calls with nested fences from corrupting Python files and evaluate cycle policy accurately', () => {
    const {
      parseToolCallsFromContent,
      parseCodeBlocksFromContent,
      shouldIterateCriticFix,
    } = require('../extensions/localcoders-core/dist/agents/main-agent');

    // Nested backticks inside JSON content caused old regex fallback to overwrite clock.py with README JSON
    const nestedToolText =
      '```json\n' +
      '{"name": "write_file", "arguments": {"path": "README.md", "content": "# Clock\\n\\n```bash\\npip install -r requirements.txt\\n```"}}\n' +
      '```';
    const parsedCalls = parseToolCallsFromContent(nestedToolText);
    assert.strictEqual(parsedCalls.length, 1);
    assert.strictEqual(parsedCalls[0].name, 'write_file');
    assert.strictEqual(parsedCalls[0].args.path, 'README.md');

    const extracted = parseCodeBlocksFromContent(nestedToolText, ['clock.py', 'test_clock.py']);
    assert.strictEqual(extracted.length, 0, 'JSON tool payload must never fall back into clock.py');

    assert.strictEqual(
      shouldIterateCriticFix({ verdict: 'changes_requested', findings: [] }, 'strict', false),
      true
    );
    assert.strictEqual(
      shouldIterateCriticFix({ verdict: 'approved', findings: [] }, 'strict', true),
      true
    );
    assert.strictEqual(
      shouldIterateCriticFix(
        { verdict: 'changes_requested', findings: [{ category: 'Critic execution', resolved: false }] },
        'strict',
        false
      ),
      false,
      'Missing/broken Critic model should not loop Main Agent'
    );
  });

  it('should extract structured markdown findings from raw thinking streams and unclosed <think> blocks', () => {
    const rawThinking = `
Let me focus on the critical issues:

**CRITICAL**: 'main.cpp' references 'ClockUI' class which doesn't exist anywhere in the codebase. This is a compilation error.

**CRITICAL**: 'clock_tests.cpp' references 'ClockUI' class with methods 'update_time()' and 'get_time()' which don't exist. This is a compilation error.

**CRITICAL**: Test verification FAILED - gtest not found, compilation error.

**HIGH**: CMakeLists.txt doesn't include 'main.cpp' in the executable target, so even if 'ClockUI' existed, the app wouldn't build correctly.

**MEDIUM**: Timing feature lacks bounds checking.
`;

    // Test extraction when output was stuck in <think> without JSON
    const parsed = critic['parseCriticResponse']('<think>' + rawThinking, rawThinking);
    assert.strictEqual(parsed.verdict, 'blocker');
    assert.strictEqual(parsed.findings.length, 5);

    const f1 = parsed.findings[0];
    assert.strictEqual(f1.severity, 'Critical');
    assert.strictEqual(f1.filePath, 'main.cpp');
    assert.ok(f1.explanation.includes('ClockUI'));

    const f2 = parsed.findings[1];
    assert.strictEqual(f2.severity, 'Critical');
    assert.strictEqual(f2.filePath, 'clock_tests.cpp');

    const f4 = parsed.findings[3];
    assert.strictEqual(f4.severity, 'High');
    assert.strictEqual(f4.filePath, 'CMakeLists.txt');
  });

  it('should enforce hard timeout in review() and gracefully return extracted findings without hanging', async () => {
    let streamAborted = false;
    let receivedMaxTokens;

    const timeoutCritic = new CriticAgent(
      {
        chatStream: async (req, onChunk, abortSignal) => {
          receivedMaxTokens = req.maxOutputTokens;
          onChunk({
            content: '',
            thinking: `**CRITICAL**: 'src/clock.ts' has unhandled exception in loop.\n**HIGH**: Missing validation in input.`,
            done: false,
          });

          // Simulate slow LLM stuck generating
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 5000);
            if (abortSignal) {
              abortSignal.addEventListener('abort', () => {
                streamAborted = true;
                clearTimeout(timer);
                reject(new Error('Aborted by timeout watchdog'));
              });
            }
          });
        },
      },
      mockConfig,
      { getProjectRules: async () => ({ rulesText: 'None' }) },
      { executeTool: async () => ({ output: { diff: 'Mock diff' } }) },
      '/mock/workspace'
    );

    const startTime = Date.now();
    const report = await timeoutCritic.review({
      userRequirements: 'Build clock',
      changedFiles: ['src/clock.ts'],
      timeoutMs: 80, // 80ms fast timeout for testing
    });
    const elapsed = Date.now() - startTime;

    assert.ok(elapsed < 2000, `Expected fast timeout under 2s, but took ${elapsed}ms`);
    assert.strictEqual(streamAborted, true, 'Stream should be cleanly aborted by timeout watchdog');
    assert.strictEqual(receivedMaxTokens, 2048, 'Should cap maxOutputTokens to 2048');
    assert.strictEqual(report.verdict, 'blocker', 'Should extract CRITICAL finding as blocker');
    assert.strictEqual(report.findings.length, 2);
    assert.strictEqual(report.findings[0].filePath, 'src/clock.ts');
    assert.strictEqual(report.findings[0].severity, 'Critical');
  });
});
