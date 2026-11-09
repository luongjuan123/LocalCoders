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
});
