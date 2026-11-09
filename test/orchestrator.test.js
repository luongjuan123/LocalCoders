const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { AgentOrchestrator } = require('../extensions/localcoders-core/dist/agents/orchestrator');
const { AgentRegistry } = require('../extensions/localcoders-core/dist/agents/agent-registry');
const { ToolManager } = require('../extensions/localcoders-core/dist/tools/tool-manager');
const { OllamaClient } = require('../extensions/localcoders-core/dist/ollama/client');

describe('AgentOrchestrator — End-to-End Multi-Agent Lifecycle', () => {
  const mockContext = {
    globalState: {
      data: new Map(),
      get(k) { return this.data.get(k); },
      update(k, v) { this.data.set(k, v); return Promise.resolve(); },
    },
  };

  const testWorkspace = path.join(__dirname, 'mock-workspace');
  const registry = new AgentRegistry(mockContext);
  const toolManager = new ToolManager();
  const ollama = new OllamaClient('http://127.0.0.1:11434');

  it('should reject task submission if mandatory Main Agent is not configured', async () => {
    registry.setMainAgent(null);
    const orchestrator = new AgentOrchestrator(ollama, registry, toolManager, testWorkspace);
    await assert.rejects(
      async () => {
        await orchestrator.submitTask('Build a login page');
      },
      /Mandatory Main Agent has not been configured/
    );
  });

  it('should accept task and trigger lifecycle events when Main Agent is configured', async () => {
    registry.setMainAgent({
      id: 'main',
      name: 'Main Agent',
      role: 'Lead Architect',
      model: 'qwen3.8:27b',
      systemPrompt: 'Coordinates project',
      enabled: true,
      maxConcurrency: 1,
      temperature: 0.2,
      contextWindow: 32768,
    });

    // Mock client with canned planning response to ensure fast, deterministic integration test
    const mockOllama = {
      getHost: () => 'http://127.0.0.1:11434',
      chatStream: async (params, onChunk) => {
        if (params.messages[0].content.includes('PLANNING INSTRUCTIONS')) {
          const planJson = JSON.stringify({
            tasks: [
              {
                id: 't-1',
                title: 'Set up directory structure',
                description: 'Create folders',
                assignedTo: 'main',
                dependencies: [],
                affectedFiles: ['src/index.ts'],
              },
            ],
          });
          onChunk({ content: '```json\n' + planJson + '\n```', done: true });
        } else {
          onChunk({ content: 'Task completed successfully.', done: true });
        }
      },
    };

    const orchestrator = new AgentOrchestrator(mockOllama, registry, toolManager, testWorkspace);

    let activityCount = 0;
    let messageCount = 0;
    let planUpdated = false;

    orchestrator.onActivity(() => activityCount++);
    orchestrator.onMessage(() => messageCount++);
    orchestrator.onPlanUpdate(() => { planUpdated = true; });

    const task = await orchestrator.submitTask('Build a modern authentication component');
    assert.strictEqual(task.status, 'completed');
    assert.ok(activityCount > 0, 'Should emit activity events');
    assert.ok(messageCount >= 2, 'Should emit user and assistant messages');
    assert.strictEqual(planUpdated, true, 'Should update plan');
  });
});
