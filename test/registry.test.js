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
});
