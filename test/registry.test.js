const { describe, it } = require('node:test');
const assert = require('node:assert');
const { AgentRegistry } = require('../extensions/localcoders-core/dist/agents/agent-registry');

describe('AgentRegistry — Agent Team Configuration & Mandatory Validation', () => {
  const mockContext = {
    globalState: {
      data: new Map(),
      get(k) { return this.data.get(k); },
      update(k, v) { this.data.set(k, v); return Promise.resolve(); },
    },
  };

  it('should provide standard predefined expert roles', () => {
    const roles = AgentRegistry.getPredefinedRoles();
    assert.ok(roles.length >= 10);
    const roleNames = roles.map(r => r.role);
    assert.ok(roleNames.includes('Frontend Developer'));
    assert.ok(roleNames.includes('Backend Developer'));
    assert.ok(roleNames.includes('Software Architect'));
    assert.ok(roleNames.includes('Database Engineer'));
    assert.ok(roleNames.includes('Debugging Specialist'));
    assert.ok(roleNames.includes('Test Engineer'));
    assert.ok(roleNames.includes('Security Auditor'));
    assert.ok(roleNames.includes('Performance Engineer'));
    assert.ok(roleNames.includes('Documentation Writer'));
    assert.ok(roleNames.includes('Research Agent'));
    assert.ok(roleNames.includes('Refactoring Specialist'));
  });

  it('should configure and persist mandatory Main Agent', () => {
    const reg = new AgentRegistry(mockContext);
    reg.setMainAgent({
      id: 'main',
      name: 'Lead Main Agent',
      role: 'Lead Architect',
      model: 'qwen3.8:27b',
      systemPrompt: 'Coordinates project',
      enabled: true,
      maxConcurrency: 1,
      temperature: 0.2,
      contextWindow: 32768,
    });

    const saved = reg.getMainAgent();
    assert.ok(saved);
    assert.strictEqual(saved.model, 'qwen3.8:27b');
  });

  it('should add, list, update, and remove subagents dynamically', () => {
    const reg = new AgentRegistry(mockContext);
    reg.removeSubagent('sub-test');
    const initialCount = reg.getSubagents().length;

    reg.addSubagent({
      id: 'sub-test',
      name: 'Testing Specialist',
      role: 'Test Engineer',
      model: 'qwen2.5-coder:7b',
      systemPrompt: 'Writes unit and integration tests',
      enabled: true,
      maxConcurrency: 2,
      temperature: 0.1,
      contextWindow: 16384,
    });

    assert.strictEqual(reg.getSubagents().length, initialCount + 1);
    assert.strictEqual(reg.getSubagent('sub-test')?.role, 'Test Engineer');

    // Update subagent
    reg.updateSubagent('sub-test', { enabled: false });
    assert.strictEqual(reg.getSubagent('sub-test')?.enabled, false);

    // Remove subagent
    reg.removeSubagent('sub-test');
    assert.strictEqual(reg.getSubagents().length, initialCount);
  });

  it('should configure Critic Agent parameters', () => {
    const reg = new AgentRegistry(mockContext);
    reg.setCriticConfig({
      enabled: true,
      model: 'deepseek-r1:8b',
      strictness: 'paranoid',
    });

    const critic = reg.getCriticConfig();
    assert.strictEqual(critic.enabled, true);
    assert.strictEqual(critic.model, 'deepseek-r1:8b');
    assert.strictEqual(critic.strictness, 'paranoid');
  });

  it('should customize built-in and custom subagent models and instructions without losing defaults', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const vscode = require('vscode');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-reg-sub-'));
    const origFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    try {
      const data = new Map();
      const isoCtx = {
        globalState: {
          get(k) { return data.get(k); },
          update(k, v) { data.set(k, v); return Promise.resolve(); },
        },
      };
      const reg = new AgentRegistry(isoCtx);

      // Update a built-in subagent model & custom instructions
      reg.updateSubagent('builtin_test', {
        model: 'qwen3.8:27b',
        systemPrompt: 'Use pytest with isolated tmp_path fixtures only.',
      });

      // Add a custom subagent inheriting the active coding model ('') with custom instructions
      reg.addSubagent({
        id: 'sub_sec',
        name: 'Security Reviewer',
        role: 'Security Auditor',
        model: '',
        systemPrompt: 'Check every input path for traversal and command injection.',
        enabled: true,
        maxConcurrency: 1,
        temperature: 0.1,
        contextWindow: 32768,
      });

      const effective = reg.getEffectiveSubagents('qwen2.5-coder:7b', true);
      const testSub = effective.find((s) => s.id === 'builtin_test');
      const frontSub = effective.find((s) => s.id === 'builtin_frontend');
      const secSub = effective.find((s) => s.id === 'sub_sec');

      assert.strictEqual(testSub?.model, 'qwen3.8:27b');
      assert.match(testSub?.systemPrompt || '', /pytest with isolated tmp_path/);
      assert.strictEqual(frontSub?.model, 'qwen2.5-coder:7b', 'Uncustomized built-ins remain active & inherit active model');
      assert.strictEqual(secSub?.model, 'qwen2.5-coder:7b', 'Blank subagent model inherits active coding model dynamically');

      // Reset built-in override and remove custom subagent cleanly
      reg.removeSubagent('builtin_test');
      reg.removeSubagent('sub_sec');
      const afterReset = reg.getManageableSubagents(true);
      const resetTest = afterReset.find((s) => s.id === 'builtin_test');
      assert.strictEqual(resetTest?.isCustomized, false);
      assert.strictEqual(resetTest?.model, '');
      assert.strictEqual(afterReset.some((s) => s.id === 'sub_sec'), false);

      // Verify deletion of built-in subagents and restore
      assert.strictEqual(reg.getDeletedBuiltinCount(), 0);
      reg.deleteSubagent('builtin_frontend');
      assert.strictEqual(reg.getDeletedBuiltinCount(), 1);
      const afterDelete = reg.getManageableSubagents(true);
      assert.strictEqual(afterDelete.some((s) => s.id === 'builtin_frontend'), false, 'Deleted built-in is excluded from manageable roster');
      const effectiveAfterDelete = reg.getEffectiveSubagents('qwen2.5-coder:7b', true);
      assert.strictEqual(effectiveAfterDelete.some((s) => s.id === 'builtin_frontend'), false, 'Deleted built-in is excluded from execution roster');

      // Restore built-ins
      reg.restoreBuiltinSubagents();
      assert.strictEqual(reg.getDeletedBuiltinCount(), 0);
      const afterRestore = reg.getManageableSubagents(true);
      assert.strictEqual(afterRestore.some((s) => s.id === 'builtin_frontend'), true, 'Restored built-in returns to active roster');
    } finally {
      vscode.workspace.workspaceFolders = origFolders;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
