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

  it('should run code -> critic review -> fix -> re-review cycle until approved cleanly in non-Git workspace', async () => {
    const os = require('os');
    const fs = require('fs');
    const vscode = require('vscode');
    const cycleWs = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-cycle-ws-'));
    const cycleToolMgr = new ToolManager();
    const cycleReg = new AgentRegistry({
      globalState: {
        data: new Map(),
        get(k) { return this.data.get(k); },
        update(k, v) { this.data.set(k, v); return Promise.resolve(); },
      },
    });
    cycleReg.setMainAgent({
      id: 'main',
      name: 'Main Agent',
      role: 'Lead Architect',
      model: 'mock-coder:latest',
      systemPrompt: 'Writes Python code cleanly.',
      enabled: true,
      maxConcurrency: 1,
      temperature: 0.1,
      contextWindow: 32768,
    });
    cycleReg.setCriticConfig({
      enabled: true,
      model: 'mock-critic:latest',
      strictness: 'strict',
      reviewMode: 'changed_files',
    });

    try {
      let criticPass = 0;
      const criticReports = [];
      const streamEvents = [];

      const cycleOllama = {
        getHost: () => 'http://127.0.0.1:11434',
        chatStream: async (params, onChunk) => {
          const sys = String(params.messages[0]?.content || '');
          const userAll = params.messages.map((m) => String(m.content || '')).join('\n');

          if (sys.includes('PLANNING INSTRUCTIONS')) {
            onChunk({
              content:
                '```json\n' +
                JSON.stringify({
                  tasks: [
                    {
                      id: 't-clock',
                      title: 'Implement app.py',
                      description: 'Create Python greeting module',
                      assignedTo: 'main',
                      dependencies: [],
                      affectedFiles: ['app.py'],
                    },
                  ],
                }) +
                '\n```',
              done: true,
            });
            return;
          }

          if (sys.includes('LocalCoders Critic Agent')) {
            criticPass++;
            if (criticPass === 1) {
              onChunk({
                content:
                  '```json\n' +
                  JSON.stringify({
                    verdict: 'blocker',
                    summary: 'Missing return statement in greet()',
                    findings: [
                      {
                        id: 'f1',
                        severity: 'Critical',
                        category: 'Logical correctness',
                        filePath: 'app.py',
                        lineRange: '1-2',
                        evidence: 'def greet(): pass',
                        explanation: 'Function returns None instead of greeting.',
                        recommendedFix: 'Return "hello"',
                      },
                    ],
                  }) +
                  '\n```',
                done: true,
              });
            } else if (criticPass === 2) {
              onChunk({
                content:
                  '```json\n' +
                  JSON.stringify({
                    verdict: 'changes_requested',
                    summary: 'Need name parameter support',
                    findings: [
                      {
                        id: 'f2',
                        severity: 'Medium',
                        category: 'Requirement violations',
                        filePath: 'app.py',
                        lineRange: '1-2',
                        evidence: 'return "hello"',
                        explanation: 'Does not personalize greeting when name is provided.',
                        recommendedFix: 'Accept optional name parameter',
                      },
                    ],
                  }) +
                  '\n```',
                done: true,
              });
            } else {
              onChunk({
                content:
                  '```json\n' +
                  JSON.stringify({
                    verdict: 'approved',
                    summary: 'All defects fixed and verified.',
                    findings: [],
                  }) +
                  '\n```',
                done: true,
              });
            }
            return;
          }

          // Main Agent: remediation rounds vs initial implementation
          const hasToolResult = params.messages.some((m) => m.role === 'tool' || (m.role === 'user' && String(m.content).includes('[Tool Result')));
          if (userAll.includes('CRITIC REVIEW FEEDBACK (Round 1')) {
            if (!hasToolResult) {
              onChunk({
                content: '',
                toolCalls: [{ function: { name: 'write_file', arguments: { path: 'app.py', content: 'def greet():\n    return "hello"\n' } } }],
                done: true,
              });
            } else {
              onChunk({ content: 'Fixed greet() return value.', done: true });
            }
            return;
          }
          if (userAll.includes('CRITIC REVIEW FEEDBACK (Round 2')) {
            if (!hasToolResult) {
              onChunk({
                content: '',
                toolCalls: [{ function: { name: 'write_file', arguments: { path: 'app.py', content: 'def greet(name="world"):\n    return f"hello {name}"\n' } } }],
                done: true,
              });
            } else {
              onChunk({ content: 'Added optional name parameter.', done: true });
            }
            return;
          }

          // Initial Main Agent turn
          if (!hasToolResult) {
            onChunk({
              content: '',
              toolCalls: [{ function: { name: 'write_file', arguments: { path: 'app.py', content: 'def greet():\n    pass\n' } } }],
              done: true,
            });
          } else {
            onChunk({ content: 'Wrote initial app.py.', done: true });
          }
        },
      };

      const cycleOrch = new AgentOrchestrator(cycleOllama, cycleReg, cycleToolMgr, cycleWs);
      cycleOrch.onCriticReport((r) => criticReports.push(r));
      cycleOrch.onStreamEvent((ev) => streamEvents.push(ev));

      const task = await cycleOrch.submitTask('Build Python app.py with greet function', {
        executionMode: 'code',
        permissionMode: 'bypass',
        modelId: 'mock-coder:latest',
      });

      assert.strictEqual(criticPass, 3, 'Should loop code -> critic(blocker) -> fix -> critic(changes_requested) -> fix -> critic(approved)');
      assert.strictEqual(criticReports.length, 3, 'Each review round emits a Critic report');
      assert.strictEqual(criticReports[2].verdict, 'approved');
      assert.strictEqual(task.status, 'completed');
      assert.strictEqual(task.criticReport.verdict, 'approved');
      assert.ok(fs.readFileSync(path.join(cycleWs, 'app.py'), 'utf8').includes('def greet(name="world")'));
      assert.ok(
        streamEvents.some((ev) => ev.kind === 'activity_upsert' && ev.item?.agentId === 'critic' && ev.item?.title?.includes('Round 3')),
        'UI activity stream shows each Critic round card'
      );

      // Verify blocker remaining after cycles completes stops loudly with failed task status instead of claiming success
      const origGetConfig = vscode.workspace.getConfiguration;
      vscode.workspace.getConfiguration = (section) => {
        const cfg = origGetConfig(section);
        return {
          ...cfg,
          get: (k, def) => (section === 'localcoders' && k === 'maxCriticCycles' ? 2 : cfg.get(k, def)),
        };
      };
      try {
        const blockerOllama = {
          ...cycleOllama,
          chatStream: async (params, onChunk) => {
            const sys = String(params.messages[0]?.content || '');
            if (sys.includes('LocalCoders Critic Agent')) {
              onChunk({
                content: '```json\n{"verdict":"blocker","summary":"Persistent blocker","findings":[{"severity":"Critical","filePath":"app.py","explanation":"Still broken","recommendedFix":"Fix it"}]}\n```',
                done: true,
              });
              return;
            }
            return cycleOllama.chatStream(params, onChunk);
          },
        };
        const failOrch = new AgentOrchestrator(blockerOllama, cycleReg, cycleToolMgr, cycleWs);
        const failedTask = await failOrch.submitTask('Build app.py with unresolved blocker', {
          executionMode: 'code',
          permissionMode: 'bypass',
          modelId: 'mock-coder:latest',
        });
        assert.strictEqual(failedTask.status, 'failed', 'Unresolved blocker after max cycles marks task failed');
        assert.strictEqual(failedTask.criticReport.verdict, 'blocker');
      } finally {
        vscode.workspace.getConfiguration = origGetConfig;
      }
    } finally {
      fs.rmSync(cycleWs, { recursive: true, force: true });
    }
  });

  it('should halt stuck repeated failed edit_file + unittest retries cleanly without burning 20+ slow turns', async () => {
    const fs = require('fs');
    const os = require('os');
    const vscode = require('vscode');
    const { PermissionManager } = require('../extensions/localcoders-core/dist/security/permission-manager');
    const stuckWs = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-stuck-guard-'));
    const origFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: stuckWs } }];
    try {
      const ctx = {
        globalState: { get: () => undefined, update: () => Promise.resolve() },
        workspaceState: { get: () => undefined, update: () => Promise.resolve() },
      };
      const pm = new PermissionManager(stuckWs);
      pm.setMode('bypass');
      const tm = new ToolManager(undefined, pm);
      const reg = new AgentRegistry(ctx);
      reg.setMainAgent({
        id: 'main',
        name: 'Main Agent',
        role: 'Lead Architect',
        model: 'mock-coder:latest',
        systemPrompt: 'Implement and fix cleanly.',
        enabled: true,
        maxConcurrency: 1,
        temperature: 0.1,
        contextWindow: 32768,
      });
      reg.setCriticConfig({
        enabled: true,
        model: 'mock-critic:latest',
        strictness: 'strict',
        reviewMode: 'changed_files',
      });

      let remediationLlmCalls = 0;
      let criticCalls = 0;

      const stuckOllama = {
        getHost: () => 'http://localhost:11434',
        chatStream: async (params, onChunk) => {
          const sys = String(params.messages[0]?.content || '');
          const userAll = params.messages.map((m) => String(m.content || '')).join('\n');

          if (sys.includes('LocalCoders Critic Agent')) {
            criticCalls++;
            onChunk({
              content: '```json\n{"verdict":"blocker","summary":"test_clock failed","findings":[{"severity":"Critical","filePath":"clock.py","explanation":"Broken assert","recommendedFix":"Return formatted string"}]}\n```',
              done: true,
            });
            return;
          }

          if (sys.includes('PLANNING INSTRUCTIONS')) {
            onChunk({
              content:
                '```json\n' +
                JSON.stringify({
                  tasks: [{ id: 't1', title: 'Fix clock.py', description: 'Fix clock', assignedTo: 'main', dependencies: [], affectedFiles: ['clock.py'] }],
                }) +
                '\n```',
              done: true,
            });
            return;
          }

          if (userAll.includes('CRITIC REVIEW FEEDBACK')) {
            remediationLlmCalls++;
            // Pathologically repeat exact same broken edit_file + failing test every turn
            onChunk({
              content: '',
              toolCalls: [
                { function: { name: 'edit_file', arguments: { path: 'clock.py', target: 'NONEXISTENT_LINE', replacement: 'FIXED' } } },
                { function: { name: 'run_command', arguments: { command: 'python3 -c "import sys; sys.exit(1)"' } } },
              ],
              done: true,
            });
            return;
          }

          // Initial Main Agent writes broken clock.py once then stops
          const hasTool = params.messages.some((m) => m.role === 'tool' || String(m.content || '').includes('[Tool Result'));
          if (!hasTool) {
            onChunk({
              content: '',
              toolCalls: [{ function: { name: 'write_file', arguments: { path: 'clock.py', content: 'def now():\n    return "bad"\n' } } }],
              done: true,
            });
          } else {
            onChunk({ content: 'Wrote clock.py.', done: true });
          }
        },
      };

      const orch = new AgentOrchestrator(stuckOllama, reg, tm, stuckWs);
      const task = await orch.submitTask('Fix clock.py', {
        executionMode: 'code',
        permissionMode: 'bypass',
        modelId: 'mock-coder:latest',
      });

      assert.strictEqual(task.status, 'failed');
      // Previously burned up to 3 Critic rounds * 8 turns = 24 LLM calls! Now stops after Round 1 & maxStuckTurns=2!
      assert.strictEqual(criticCalls, 1, 'Stops Critic cycles early when remediation modifies zero files');
      assert.ok(remediationLlmCalls <= 3, `Expected remediation to break early (<=3 LLM calls), got ${remediationLlmCalls}`);
    } finally {
      vscode.workspace.workspaceFolders = origFolders;
      fs.rmSync(stuckWs, { recursive: true, force: true });
    }
  });

  it('should continue Critic -> fix cycles beyond 4 rounds infinitely while making progress until approved', async () => {
    const fs = require('fs');
    const os = require('os');
    const vscode = require('vscode');
    const { PermissionManager } = require('../extensions/localcoders-core/dist/security/permission-manager');
    const { DEFAULT_MAX_CRITIC_CYCLES } = require('../extensions/localcoders-core/dist/agents/main-agent');
    assert.strictEqual(DEFAULT_MAX_CRITIC_CYCLES, 0, 'Default maxCriticCycles is 0 (unlimited)');

    const infWs = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-inf-cycles-'));
    const origFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: infWs } }];
    try {
      const ctx = {
        globalState: { get: () => undefined, update: () => Promise.resolve() },
        workspaceState: { get: () => undefined, update: () => Promise.resolve() },
      };
      const pm = new PermissionManager(infWs);
      pm.setMode('bypass');
      const tm = new ToolManager(undefined, pm);
      const reg = new AgentRegistry(ctx);
      reg.setMainAgent({
        id: 'main',
        name: 'Main Agent',
        role: 'Lead Architect',
        model: 'mock-coder:latest',
        systemPrompt: 'Iterate fixes until tests and Critic pass.',
        enabled: true,
        maxConcurrency: 1,
        temperature: 0.1,
        contextWindow: 32768,
      });
      reg.setCriticConfig({
        enabled: true,
        model: 'mock-critic:latest',
        strictness: 'strict',
        reviewMode: 'changed_files',
      });

      let criticRound = 0;
      const infOllama = {
        getHost: () => 'http://localhost:11434',
        chatStream: async (params, onChunk) => {
          const sys = String(params.messages[0]?.content || '');
          const userAll = params.messages.map((m) => String(m.content || '')).join('\n');

          if (sys.includes('LocalCoders Critic Agent')) {
            criticRound++;
            if (criticRound < 6) {
              onChunk({
                content:
                  '```json\n' +
                  JSON.stringify({
                    verdict: 'changes_requested',
                    summary: `Iteration ${criticRound} issue remaining`,
                    findings: [{ severity: 'High', filePath: 'app.py', explanation: `Needs step ${criticRound}`, recommendedFix: `Write step ${criticRound}` }],
                  }) +
                  '\n```',
                done: true,
              });
            } else {
              onChunk({
                content: '```json\n{"verdict":"approved","summary":"All 6 rounds resolved cleanly","findings":[]}\n```',
                done: true,
              });
            }
            return;
          }

          if (sys.includes('PLANNING INSTRUCTIONS')) {
            onChunk({
              content: '```json\n' + JSON.stringify({ tasks: [{ id: 't1', title: 'Write app.py', description: 'Build app.py', assignedTo: 'main', dependencies: [], affectedFiles: ['app.py'] }] }) + '\n```',
              done: true,
            });
            return;
          }

          const hasTool = params.messages.some((m) => m.role === 'tool' || userAll.includes('[Tool Result'));
          if (userAll.includes('CRITIC REVIEW FEEDBACK')) {
            if (!hasTool) {
              onChunk({
                content: '',
                toolCalls: [{ function: { name: 'write_file', arguments: { path: 'app.py', content: `VERSION = ${criticRound}\n` } } }],
                done: true,
              });
            } else {
              onChunk({ content: `Updated app.py to version ${criticRound}.`, done: true });
            }
            return;
          }

          if (!hasTool) {
            onChunk({
              content: '',
              toolCalls: [{ function: { name: 'write_file', arguments: { path: 'app.py', content: 'VERSION = 0\n' } } }],
              done: true,
            });
          } else {
            onChunk({ content: 'Initial app.py written.', done: true });
          }
        },
      };

      const orch = new AgentOrchestrator(infOllama, reg, tm, infWs);
      const task = await orch.submitTask('Build app.py reliably', {
        executionMode: 'code',
        permissionMode: 'bypass',
        modelId: 'mock-coder:latest',
      });

      assert.strictEqual(criticRound, 6, 'Continues seamlessly past 4 cycles into rounds 5 and 6 until Critic approves');
      assert.strictEqual(task.status, 'completed');
      assert.strictEqual(task.criticReport?.verdict, 'approved');
      assert.strictEqual(fs.readFileSync(path.join(infWs, 'app.py'), 'utf8'), 'VERSION = 5\n');
    } finally {
      vscode.workspace.workspaceFolders = origFolders;
      fs.rmSync(infWs, { recursive: true, force: true });
    }
  });
});
