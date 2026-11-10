const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const {
  sanitizeAssistantContent,
  sanitizeActivityText,
  classifyToolCategory,
  formatToolActivityTitle,
  upsertActivityItem,
  finalizeRunningActivities,
  isPlanExplicitlyRequested,
  getSafePhaseLabel,
  classifyUserPrompt,
  pairConversationHistory,
  sanitizeConversationHistory,
  stripCancelledTurnsFromHistory,
} = require('../extensions/localcoders-core/dist/agents/events');
const { executeTrackedTool } = require('../extensions/localcoders-core/dist/agents/tool-runner');
const { AgentOrchestrator } = require('../extensions/localcoders-core/dist/agents/orchestrator');
const { AgentRegistry } = require('../extensions/localcoders-core/dist/agents/agent-registry');
const { ToolManager } = require('../extensions/localcoders-core/dist/tools/tool-manager');
const { runCommandTool } = require('../extensions/localcoders-core/dist/tools/terminal-tools');
const { TerminalSessionManager } = require('../extensions/localcoders-core/dist/tools/terminal-session-manager');
const { SessionManager } = require('../extensions/localcoders-core/dist/sessions/session-manager');
const { ChatViewProvider } = require('../extensions/localcoders-core/dist/views/chat-view');
const { AgentWorkspaceEditorPanel } = require('../extensions/localcoders-core/dist/views/agent-workspace-editor');
const { AgentMonitorViewProvider } = require('../extensions/localcoders-core/dist/views/agent-monitor-view');

function makeMockContext(storageDir) {
  const globalData = new Map();
  const wsData = new Map();
  return {
    globalStorageUri: { fsPath: storageDir },
    globalState: {
      get(k) { return globalData.get(k); },
      update(k, v) { globalData.set(k, v); return Promise.resolve(); },
    },
    workspaceState: {
      get(k) { return wsData.get(k); },
      update(k, v) { wsData.set(k, v); return Promise.resolve(); },
    },
  };
}

function makeRegistry(ctx) {
  const registry = new AgentRegistry(ctx);
  registry.setMainAgent({
    id: 'main',
    name: 'Main Agent',
    role: 'Lead Architect',
    model: 'openai/gpt-4o',
    systemPrompt: 'Coordinate engineering work cleanly.',
    enabled: true,
    maxConcurrency: 3,
    temperature: 0.2,
    contextWindow: 32768,
  });
  return registry;
}

describe('Event Streaming, Thinking Filter, Command Cards & Cockpit UI (12 Scenarios)', () => {
  it('1. Normal assistant response: ask mode emits safe phases, one clean assistant message, and no implicit plan', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-1-'));
    try {
      const registry = makeRegistry(makeMockContext(tmpDir));
      const toolManager = new ToolManager();
      const mockLlm = {
        getHost: () => 'https://api.openai.com',
        chatStream: async (_params, onChunk) => {
          onChunk({ thinking: 'Internal secret reasoning step...', content: '', done: false });
          onChunk({ content: 'Here is a clean explanation of the clock module.', done: true });
        },
      };

      const orchestrator = new AgentOrchestrator(mockLlm, registry, toolManager, tmpDir);
      const streamEvents = [];
      const messages = [];
      const activities = [];
      orchestrator.onStreamEvent((ev) => streamEvents.push(ev));
      orchestrator.onMessage((msg) => messages.push(msg));
      orchestrator.onActivity((ev) => activities.push(ev));

      const task = await orchestrator.submitTask('Explain how the clock works', {
        providerId: 'openai',
        modelId: 'gpt-4o',
        modelName: 'GPT-4o',
        reasoningEffort: 'medium',
        fastMode: false,
        executionMode: 'ask',
        permissionMode: 'smart',
        enabledMcpServers: [],
        enabledSkills: [],
        activeRules: [],
        attachedFiles: [],
        projectContext: [],
      });

      assert.strictEqual(task.status, 'completed');
      const assistantMsgs = messages.filter((m) => m.senderRole === 'assistant');
      assert.strictEqual(assistantMsgs.length, 1);
      assert.strictEqual(assistantMsgs[0].content, 'Here is a clean explanation of the clock module.');

      const statusPhases = streamEvents.filter((e) => e.kind === 'status').map((e) => e.phase);
      assert.ok(statusPhases.includes('analyzing'));
      assert.strictEqual(statusPhases[statusPhases.length - 1], 'completed');

      const planEvents = streamEvents.filter((e) => e.kind === 'plan');
      assert.strictEqual(planEvents.length, 0);
      assert.ok(!activities.some((a) => /Thinking:|Internal secret/i.test(a.latestActivity)));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('2. Streaming assistant response: message_delta shares single messageId and converges to finalized message_complete', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-2-'));
    try {
      const registry = makeRegistry(makeMockContext(tmpDir));
      const toolManager = new ToolManager();
      const mockLlm = {
        getHost: () => 'https://api.openai.com',
        chatStream: async (_params, onChunk) => {
          onChunk({ content: '<think>hidden thought</think>Hello ', done: false });
          await new Promise((r) => setTimeout(r, 15));
          onChunk({ content: 'world', done: false });
          onChunk({ content: '!', done: true });
        },
      };

      const orchestrator = new AgentOrchestrator(mockLlm, registry, toolManager, tmpDir);
      const deltas = [];
      const completes = [];
      orchestrator.onStreamEvent((ev) => {
        if (ev.kind === 'message_delta') deltas.push(ev);
        if (ev.kind === 'message_complete') completes.push(ev);
      });

      await orchestrator.submitTask('Say hello world', {
        providerId: 'openai',
        modelId: 'gpt-4o',
        modelName: 'GPT-4o',
        reasoningEffort: 'medium',
        fastMode: false,
        executionMode: 'ask',
        permissionMode: 'smart',
        enabledMcpServers: [],
        enabledSkills: [],
        activeRules: [],
        attachedFiles: [],
        projectContext: [],
      });

      assert.ok(deltas.length >= 2, 'Expected multiple streaming deltas');
      const uniqueMsgIds = new Set(deltas.map((d) => d.messageId));
      assert.strictEqual(uniqueMsgIds.size, 1, 'All deltas for a response must share one messageId');
      assert.strictEqual(deltas[deltas.length - 1].fullContent, 'Hello world!');

      assert.strictEqual(completes.length, 1);
      assert.strictEqual(completes[0].message.id, deltas[0].messageId);
      assert.strictEqual(completes[0].message.content, 'Hello world!');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('3. Internal reasoning event filtering: strips <think>, <analysis>, Thinking:, and token counters everywhere', () => {
    assert.strictEqual(sanitizeAssistantContent('<think>I need to inspect...</think>Final answer.'), 'Final answer.');
    assert.strictEqual(sanitizeAssistantContent('Partial <think>unclosed internal reasoning').trim(), 'Partial');
    assert.strictEqual(
      sanitizeAssistantContent('Working.\n<tool_call>{"name":"read_file"}</tool_call>\nDone.'),
      'Working.\n\nDone.'
    );
    assert.strictEqual(sanitizeActivityText('[Main Agent] Thinking: I...', 'thinking'), 'Analyzing the task');
    assert.strictEqual(sanitizeActivityText('Generating implementation (19 tokens)...', 'working'), 'Generating code');
    assert.strictEqual(sanitizeActivityText('Thinking: of...', 'working'), 'Generating code');
    assert.strictEqual(sanitizeActivityText('[Main Agent] run_command({"command":"ls"})...', 'working'), 'Running commands');
    assert.strictEqual(sanitizeActivityText('Reading package.json', 'working'), 'Reading package.json');
    assert.strictEqual(isPlanExplicitlyRequested('Build a python clock', 'code'), false);
    assert.strictEqual(isPlanExplicitlyRequested('Create an implementation plan first', 'code'), true);
    assert.strictEqual(isPlanExplicitlyRequested('Build a python clock', 'plan'), true);
    assert.strictEqual(getSafePhaseLabel('verifying'), 'Verifying changes');
  });

  it('4 & 5. Tool call initiation and completion: executeTrackedTool + run_command updates same ID with stdout, exitCode 0 & durationMs', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-45-'));
    try {
      const toolManager = new ToolManager();
      const events = [];
      const tracked = await executeTrackedTool({
        runId: 'run_45',
        agentId: 'main',
        agentName: 'Main Agent',
        agentRole: 'Lead Architect',
        toolName: 'run_command',
        args: { command: 'echo "hello-localcoders"' },
        toolManager,
        baseCtx: {
          workspaceRoot: tmpDir,
          agentId: 'main',
          agentName: 'Main Agent',
          requireApproval: false,
        },
        onStreamEvent: (ev) => events.push(ev),
      });

      assert.strictEqual(tracked.result.success, true);
      assert.strictEqual(tracked.result.output.exitCode, 0);
      assert.ok(events.some((e) => e.kind === 'activity_upsert'));
      const actEvents = events.filter((e) => e.kind === 'activity_upsert');
      assert.ok(actEvents.length >= 2, 'Should emit running then completed events');

      const ids = new Set(actEvents.map((e) => e.item.id));
      assert.strictEqual(ids.size, 1, 'Running and completed updates must share one call ID');
      assert.strictEqual(actEvents[0].item.status, 'running');
      assert.strictEqual(actEvents[0].item.category, 'command');
      assert.strictEqual(actEvents[0].item.command, 'echo "hello-localcoders"');

      const finalItem = actEvents[actEvents.length - 1].item;
      assert.strictEqual(finalItem.status, 'completed');
      assert.strictEqual(finalItem.exitCode, 0);
      assert.ok(finalItem.durationMs >= 0);
      assert.ok((finalItem.stdout || '').includes('hello-localcoders'));
      assert.strictEqual(classifyToolCategory('read_file'), 'file');
      assert.strictEqual(formatToolActivityTitle('run_command', { command: 'pytest -q' }).title, 'Terminal Execution');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('6. Failed command: non-zero exit code records failed status, exitCode, and stderr', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-6-'));
    try {
      const toolManager = new ToolManager();
      const events = [];
      const tracked = await executeTrackedTool({
        runId: 'run_6',
        agentId: 'main',
        agentName: 'Main Agent',
        toolName: 'run_command',
        args: { command: 'echo "boom-err" >&2; exit 42' },
        toolManager,
        baseCtx: {
          workspaceRoot: tmpDir,
          agentId: 'main',
          agentName: 'Main Agent',
          requireApproval: false,
        },
        onStreamEvent: (ev) => events.push(ev),
      });

      assert.strictEqual(tracked.result.success, false);
      const actEvents = events.filter((e) => e.kind === 'activity_upsert');
      const last = actEvents[actEvents.length - 1].item;
      assert.strictEqual(last.status, 'failed');
      assert.strictEqual(last.exitCode, 42);
      assert.ok((last.stderr || '').includes('boom-err'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('7. Cancelled command: AbortController aborts live run_command cleanly and marks status cancelled', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-7-'));
    try {
      const ac = new AbortController();
      const events = [];
      const toolManager = new ToolManager();

      setTimeout(() => ac.abort(), 120);

      const started = Date.now();
      const tracked = await executeTrackedTool({
        runId: 'run_7',
        agentId: 'main',
        agentName: 'Main Agent',
        toolName: 'run_command',
        args: { command: 'sleep 30' },
        toolManager,
        abortSignal: ac.signal,
        baseCtx: {
          workspaceRoot: tmpDir,
          agentId: 'main',
          agentName: 'Main Agent',
          requireApproval: false,
        },
        onStreamEvent: (ev) => events.push(ev),
      });

      const elapsed = Date.now() - started;
      assert.ok(elapsed < 5000, `Expected quick cancellation, took ${elapsed}ms`);
      assert.strictEqual(tracked.result.success, false);
      assert.strictEqual(tracked.result.cancelled, true);

      const actEvents = events.filter((e) => e.kind === 'activity_upsert');
      const last = actEvents[actEvents.length - 1].item;
      assert.strictEqual(last.status, 'cancelled');

      // Direct toolManager run_command abort verification too
      const ac2 = new AbortController();
      setTimeout(() => ac2.abort(), 80);
      const directRes = await toolManager.executeTool(
        'run_command',
        { command: 'sleep 20' },
        { workspaceRoot: tmpDir, agentId: 'main', agentName: 'Main Agent', requireApproval: false, abortSignal: ac2.signal }
      );
      assert.strictEqual(directRes.cancelled, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('8. Multiple sequential commands preserve order and distinct activity IDs', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-8-'));
    try {
      const toolManager = new ToolManager();
      let list = [];
      const emit = (ev) => {
        if (ev.kind === 'activity_upsert') {
          list = upsertActivityItem(list, ev.item);
        }
      };

      await executeTrackedTool({
        runId: 'run_8',
        agentId: 'main',
        agentName: 'Main Agent',
        toolName: 'run_command',
        args: { command: 'echo "first-step"' },
        toolManager,
        baseCtx: { workspaceRoot: tmpDir, agentId: 'main', agentName: 'Main Agent', requireApproval: false },
        onStreamEvent: emit,
      });

      await executeTrackedTool({
        runId: 'run_8',
        agentId: 'main',
        agentName: 'Main Agent',
        toolName: 'run_command',
        args: { command: 'echo "second-step"' },
        toolManager,
        baseCtx: { workspaceRoot: tmpDir, agentId: 'main', agentName: 'Main Agent', requireApproval: false },
        onStreamEvent: emit,
      });

      assert.strictEqual(list.length, 2);
      assert.notStrictEqual(list[0].id, list[1].id);
      assert.strictEqual(list[0].command, 'echo "first-step"');
      assert.strictEqual(list[1].command, 'echo "second-step"');
      assert.ok(list[0].stdout.includes('first-step'));
      assert.ok(list[1].stdout.includes('second-step'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('9. Parallel subagents: activity_upsert events preserve exact subagent attribution without collisions', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-9-'));
    try {
      const registry = makeRegistry(makeMockContext(tmpDir));
      registry.addSubagent({
        id: 'sub_backend',
        name: 'Backend Specialist',
        role: 'Backend Developer',
        model: 'openai/gpt-4o',
        systemPrompt: 'Writes Python backend modules.',
        enabled: true,
        maxConcurrency: 2,
        temperature: 0.2,
        contextWindow: 32768,
      });
      registry.addSubagent({
        id: 'sub_test',
        name: 'QA Engineer',
        role: 'Test Engineer',
        model: 'openai/gpt-4o',
        systemPrompt: 'Writes tests.',
        enabled: true,
        maxConcurrency: 2,
        temperature: 0.2,
        contextWindow: 32768,
      });

      const toolManager = new ToolManager();
      const mockLlm = {
        getHost: () => 'https://api.openai.com',
        chatStream: async (params, onChunk) => {
          const sys = params.messages[0]?.content || '';
          const user = params.messages.filter((m) => m.role === 'user').pop()?.content || '';
          if (sys.includes('PLANNING INSTRUCTIONS')) {
            const planJson = JSON.stringify({
              tasks: [
                {
                  id: 't-be',
                  title: 'Write module file',
                  description: 'Create app.py',
                  assignedTo: 'sub_backend',
                  dependencies: [],
                  affectedFiles: ['app.py'],
                },
                {
                  id: 't-qa',
                  title: 'Write test file',
                  description: 'Create test_app.py',
                  assignedTo: 'sub_test',
                  dependencies: [],
                  affectedFiles: ['test_app.py'],
                },
              ],
            });
            onChunk({ content: '```json\n' + planJson + '\n```', done: true });
            return;
          }
          if (sys.includes('CRITICAL QUALITY AUDITOR')) {
            onChunk({ content: JSON.stringify({ verdict: 'approved', summary: 'Clean', findings: [] }), done: true });
            return;
          }
          const hasToolMsg = params.messages.some((m) => m.role === 'tool');
          if (!hasToolMsg && user.includes('Write module file')) {
            onChunk({
              content: '<tool_call>{"name":"write_file","arguments":{"path":"app.py","content":"VALUE = 1\\n"}}</tool_call>',
              done: true,
            });
            return;
          }
          if (!hasToolMsg && user.includes('Write test file')) {
            onChunk({
              content: '<tool_call>{"name":"write_file","arguments":{"path":"test_app.py","content":"assert True\\n"}}</tool_call>',
              done: true,
            });
            return;
          }
          onChunk({ content: 'Subagent task completed successfully.', done: true });
        },
      };

      const orchestrator = new AgentOrchestrator(mockLlm, registry, toolManager, tmpDir);
      const upserts = [];
      orchestrator.onStreamEvent((ev) => {
        if (ev.kind === 'activity_upsert') upserts.push(ev.item);
      });

      const task = await orchestrator.submitTask('Create app and test', {
        providerId: 'openai',
        modelId: 'gpt-4o',
        modelName: 'GPT-4o',
        reasoningEffort: 'medium',
        fastMode: false,
        executionMode: 'code',
        permissionMode: 'bypass',
        enabledMcpServers: [],
        enabledSkills: [],
        activeRules: [],
        attachedFiles: [],
        projectContext: [],
      });

      assert.strictEqual(task.status, 'completed');
      assert.ok(fs.existsSync(path.join(tmpDir, 'app.py')));
      assert.ok(fs.existsSync(path.join(tmpDir, 'test_app.py')));

      const backendItems = upserts.filter((i) => i.agentId === 'sub_backend' && i.status === 'completed');
      const testItems = upserts.filter((i) => i.agentId === 'sub_test' && i.status === 'completed');
      assert.ok(backendItems.length >= 1, 'Expected sub_backend attributed activities');
      assert.ok(testItems.length >= 1, 'Expected sub_test attributed activities');
      assert.ok(backendItems.every((i) => i.agentName === 'Backend Specialist'));
      assert.ok(testItems.every((i) => i.agentName === 'QA Engineer'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('10. Long-running terminal process: TerminalSessionManager supports multi-tab interactive execution, cd, live output & stop', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-10-'));
    const subDir = path.join(tmpDir, 'nested');
    fs.mkdirSync(subDir, { recursive: true });

    const termMgr = new TerminalSessionManager();
    termMgr.setDefaultCwd(tmpDir);
    const tab1 = termMgr.ensureDefaultTab(tmpDir);
    const tab2 = termMgr.createTab(tmpDir, 'Server Tab');

    assert.notStrictEqual(tab1.id, tab2.id);
    assert.strictEqual(tab2.cwd, tmpDir);

    // Run directory change in tab1
    termMgr.runCommand(tab1.id, 'cd nested');
    const afterCd = termMgr.getTabs().find((t) => t.id === tab1.id);
    assert.strictEqual(afterCd.cwd, subDir);

    // Start long-running command in tab2
    let sawRunning = false;
    const sub = termMgr.onDidChange((tabs) => {
      const t2 = tabs.find((x) => x.id === tab2.id);
      if (t2 && t2.status === 'running') sawRunning = true;
    });

    termMgr.runCommand(tab2.id, 'node -e "console.log(\'booting-server\'); setTimeout(()=>{}, 20000)"');
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(sawRunning, true, 'Long-running process should report running state');

    const stopped = termMgr.terminateTab(tab2.id);
    assert.strictEqual(stopped, true, 'terminateTab should kill running process');

    await new Promise((r) => setTimeout(r, 80));
    const afterStop = termMgr.getTabs().find((t) => t.id === tab2.id);
    assert.strictEqual(afterStop.status, 'killed');
    assert.ok(afterStop.lines.some((l) => l.text.includes('booting-server')));

    sub.dispose();
    termMgr.closeTab(tab2.id);
    termMgr.closeTab(tab1.id);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('11. Duplicate event prevention: upsertActivityItem, SessionManager message dedupe, and orchestrator status dedupe prevent bloat', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-11-'));
    try {
      // Activity upsert merges matching IDs rather than duplicating
      let items = [];
      const itemRunning = {
        id: 'call_dup_1',
        runId: 'run_11',
        category: 'command',
        agentId: 'main',
        agentName: 'Main Agent',
        toolName: 'run_command',
        title: 'Ran command',
        summary: 'echo ok',
        command: 'echo ok',
        status: 'running',
        startTime: 1000,
        timestamp: 1000,
      };
      items = upsertActivityItem(items, itemRunning);
      items = upsertActivityItem(items, { ...itemRunning, stdout: 'ok\n', timestamp: 1050 });
      items = upsertActivityItem(items, { ...itemRunning, status: 'completed', exitCode: 0, durationMs: 55, timestamp: 1100 });

      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].status, 'completed');
      assert.strictEqual(items[0].stdout, 'ok\n');
      assert.strictEqual(items[0].durationMs, 55);

      // SessionManager deduplicates identical message IDs and back-to-back identical messages
      const sm = new SessionManager(makeMockContext(tmpDir), tmpDir);
      sm.createSession('Dedupe test', 'qwen3.8:27b');
      sm.updateActiveSession((s) => {
        s.messages.push({
          id: 'm1',
          senderId: 'user',
          senderName: 'You',
          senderRole: 'user',
          content: 'build clock',
          timestamp: 10000,
        });
        s.messages.push({
          id: 'm1',
          senderId: 'user',
          senderName: 'You',
          senderRole: 'user',
          content: 'build clock',
          timestamp: 10005,
        });
        s.messages.push({
          id: 'm2_other_id',
          senderId: 'user',
          senderName: 'You',
          senderRole: 'user',
          content: 'build clock',
          timestamp: 10500,
        });
      });
      assert.strictEqual(sm.getActiveSession().messages.length, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('12. Final message rendering, separated 4-area cockpit DOM & zero infinite loading spinners across Webviews', () => {
    // 1. finalizeRunningActivities ensures no item stays stuck in 'running'
    const stuck = [
      { id: 'c1', runId: 'run_12', category: 'command', agentId: 'main', agentName: 'Main Agent', title: 'Test', summary: 'x', status: 'running', startTime: 100, timestamp: 100 },
      { id: 'c2', runId: 'other_run', category: 'file', agentId: 'main', agentName: 'Main Agent', title: 'Other', summary: 'y', status: 'running', startTime: 100, timestamp: 100 },
    ];
    const finalized = finalizeRunningActivities(stuck, 'run_12', 'cancelled', 500);
    assert.strictEqual(finalized[0].status, 'cancelled');
    assert.strictEqual(finalized[0].endTime, 500);
    assert.strictEqual(finalized[1].status, 'running');

    // 2. Validate generated HTML & valid JS syntax in both AgentWorkspaceEditorPanel & ChatViewProvider
    const dummy = new Proxy({}, { get: () => () => ({ dispose() {} }) });

    const chatProv = new ChatViewProvider({ fsPath: '/tmp' }, dummy, dummy, dummy, dummy, dummy, dummy);
    const chatHtml = chatProv._getHtmlForWebview();
    assert.ok(chatHtml.includes('id="chat-container"'));
    assert.ok(chatHtml.includes('id="activity-panel"'));
    assert.ok(chatHtml.includes('id="tab-btn-terminal"'));
    assert.ok(chatHtml.includes('case \'runFinished\''));
    assert.ok(chatHtml.includes('setRunningState(false)'));
    const chatScripts = [...chatHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
    chatScripts.forEach((m, i) => new vm.Script(m[1], { filename: `chat_${i}.js` }));

    const workspaceInst = Object.create(AgentWorkspaceEditorPanel.prototype);
    const workspaceHtml = workspaceInst._getHtmlForWebview();
    assert.ok(workspaceHtml.includes('id="conversationFlow"'), 'Main Conversation panel must exist');
    assert.ok(workspaceHtml.includes('class="devin-changes lc-inspector-dock hidden" id="devinChanges"'), 'Right inspector must start collapsed without Activity sidebar wall');
    assert.ok(!workspaceHtml.includes('id="inspectorPaneActivity"'), 'Separate Activity side pane must not clutter Agent View');
    assert.ok(workspaceHtml.includes('lcBuildInlineThinkingGroup'), 'Inline collapsible thinking/command group must exist');
    assert.ok(workspaceHtml.includes('id="inspectorPaneTerminal"'), 'Terminal panel must exist');
    assert.ok(workspaceHtml.includes('id="inspectorPaneChanges"'), 'Changes panel must exist');
    assert.ok(workspaceHtml.includes('lc-live-status-row'), 'Safe live status row styles must be included');
    assert.ok(!workspaceHtml.includes('Generating implementation ('), 'Hardcoded token spam must not appear');
    assert.ok(!workspaceHtml.includes('ready for instructions'), 'Boilerplate slogan must not appear');
    assert.ok(!chatHtml.includes('what should we build'), 'Cheesy welcome slogan must not appear');
    assert.ok(!chatHtml.includes('brandGlow'), 'Neon SVG glow gradient must not appear');
    const wsScripts = [...workspaceHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
    wsScripts.forEach((m, i) => new vm.Script(m[1], { filename: `workspace_${i}.js` }));

    const monProv = new AgentMonitorViewProvider({ fsPath: '/tmp' }, dummy, dummy);
    const monHtml = monProv._getHtmlForWebview();
    assert.ok(monHtml.includes('.badge-cancelled'));
    const monScripts = [...monHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
    monScripts.forEach((m, i) => new vm.Script(m[1], { filename: `monitor_${i}.js` }));
  });

  it('13. Greeting & conversational fast-path: "hello" in Code + Extra High mode skips planning, tools & Critic', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-13-'));
    try {
      assert.strictEqual(classifyUserPrompt('hello', 'code'), 'greeting');
      assert.strictEqual(classifyUserPrompt('Hi there!', 'code'), 'greeting');
      assert.strictEqual(classifyUserPrompt('thanks', 'plan'), 'greeting');
      assert.strictEqual(classifyUserPrompt('what does clock.py do?', 'code'), 'question');
      assert.strictEqual(classifyUserPrompt('hello, add alarm feature to clock.py', 'code'), 'coding_task');
      assert.strictEqual(classifyUserPrompt('delete alarm feature', 'code'), 'coding_task');

      const pollutedHistory = [
        { role: 'user', content: 'delete alarm feature' },
        { role: 'assistant', content: '### Implementation Plan\n1. Remove Alarm...' },
        { role: 'assistant', content: '### Execution Complete\nOne or more subtasks encountered issues: fetch failed' },
        { role: 'user', content: 'hello' },
      ];
      const cleaned = sanitizeConversationHistory(pollutedHistory, 'hello');
      assert.strictEqual(cleaned.length, 1);
      assert.strictEqual(cleaned[0].content, 'delete alarm feature');

      const registry = makeRegistry(makeMockContext(tmpDir));
      const toolManager = new ToolManager();
      let llmCalls = 0;
      let sawTools = false;
      let sawPlanningPrompt = false;
      let passedMaxTokens = 0;
      let passedThink = undefined;

      const mockLlm = {
        getHost: () => 'https://api.openai.com',
        chatStream: async (params, onChunk) => {
          llmCalls++;
          if (params.tools && params.tools.length > 0) sawTools = true;
          if (params.messages.some((m) => /PLANNING INSTRUCTIONS|Generate the actionable execution plan/i.test(m.content || ''))) {
            sawPlanningPrompt = true;
          }
          passedMaxTokens = params.maxOutputTokens || 0;
          passedThink = params.think;
          onChunk({ content: 'Hello! How can I help you with your code today?', done: true });
        },
      };

      const orchestrator = new AgentOrchestrator(mockLlm, registry, toolManager, tmpDir);
      const events = [];
      orchestrator.onStreamEvent((ev) => events.push(ev));

      const task = await orchestrator.submitTask(
        'hello',
        {
          providerId: 'openai',
          modelId: 'gpt-4o',
          modelName: 'GPT-4o',
          reasoningEffort: 'extra_high',
          fastMode: false,
          executionMode: 'code',
          permissionMode: 'smart',
          enabledMcpServers: [],
          enabledSkills: [],
          activeRules: [],
          attachedFiles: [],
          projectContext: [],
        },
        pollutedHistory
      );

      assert.strictEqual(task.status, 'completed');
      assert.strictEqual(llmCalls, 1, 'Greeting must execute exactly 1 lightweight LLM call');
      assert.strictEqual(sawTools, false, 'Greeting must not load coding tools');
      assert.strictEqual(sawPlanningPrompt, false, 'Greeting must never invoke createPlan');
      assert.strictEqual(passedThink, false, 'Greeting forces fast minimal thinking off to avoid CoT delay');
      assert.ok(passedMaxTokens <= 512 && passedMaxTokens > 0, 'Greeting uses compact output cap');
      assert.strictEqual(events.filter((e) => e.kind === 'plan').length, 0);
      assert.strictEqual(events.filter((e) => e.kind === 'activity_upsert').length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('14. Informational question in Code mode answers cleanly without building a task plan', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-14-'));
    try {
      const registry = makeRegistry(makeMockContext(tmpDir));
      const toolManager = new ToolManager();
      let llmCalls = 0;
      let sawTools = false;
      const mockLlm = {
        getHost: () => 'https://api.openai.com',
        chatStream: async (params, onChunk) => {
          llmCalls++;
          if (params.tools && params.tools.length > 0) sawTools = true;
          onChunk({ content: 'This file defines a basic Timer helper.', done: true });
        },
      };

      const orchestrator = new AgentOrchestrator(mockLlm, registry, toolManager, tmpDir);
      const events = [];
      orchestrator.onStreamEvent((ev) => events.push(ev));

      const task = await orchestrator.submitTask('What does main.py do?', {
        providerId: 'openai',
        modelId: 'gpt-4o',
        modelName: 'GPT-4o',
        reasoningEffort: 'medium',
        fastMode: false,
        executionMode: 'code',
        permissionMode: 'smart',
        enabledMcpServers: [],
        enabledSkills: [],
        activeRules: [],
        attachedFiles: [],
        projectContext: [],
      });

      assert.strictEqual(task.status, 'completed');
      assert.strictEqual(llmCalls, 1);
      assert.strictEqual(sawTools, false);
      assert.strictEqual(events.filter((e) => e.kind === 'plan').length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('15. Agent Mode tab lock retains only a single Agent Workspace tab and closes IDE tabs', () => {
    const lock = require('../extensions/localcoders-core/dist/views/agent-mode-lock');
    assert.strictEqual(lock.isAgentWorkspaceTabInput(null), false);
    assert.strictEqual(lock.isAgentWorkspaceTabInput({ uri: '/tmp/test_clock.py' }), false);
    assert.strictEqual(lock.isAgentWorkspaceTabInput({ viewType: 'mainThread-webviewPanel-localcoders.agentWorkspace' }), true);
    assert.strictEqual(lock.isAgentWorkspaceTabInput({ viewType: 'localcoders.agentWorkspace' }), true);

    const welcomeTab = { label: 'Welcome', input: { viewType: 'workbench.editors.gettingStartedInput' } };
    const codeTab = { label: 'test_clock.py', input: { uri: '/tmp/test_clock.py' } };
    const diffTab = { label: 'clock.py <-> clock.py', input: { original: '/a', modified: '/b' } };
    const primaryAgentTab = { label: 'LocalCoders Agent Workspace', input: { viewType: 'mainThread-webviewPanel-localcoders.agentWorkspace' } };
    const duplicateAgentTab = { label: 'Duplicate Agent', input: { viewType: 'mainThread-webviewPanel-localcoders.agentWorkspace' } };

    const result = lock.collectNonAgentTabsToClose([
      { tabs: [welcomeTab, codeTab, primaryAgentTab] },
      { tabs: [diffTab, duplicateAgentTab] },
    ]);

    assert.strictEqual(result.agentTab, primaryAgentTab);
    assert.deepStrictEqual(result.tabsToClose, [welcomeTab, codeTab, diffTab, duplicateAgentTab]);
  });

  it('16. Agent View cockpit scripts compile cleanly in vm.Script with zero IDE panel/tab escapes', () => {
    const vm = require('vm');
    const modals = require('../extensions/localcoders-core/dist/views/agent-cockpit-modals');
    const { AgentWorkspaceEditorPanel } = require('../extensions/localcoders-core/dist/views/agent-workspace-editor');
    const editorSrc = fs.readFileSync(
      path.join(__dirname, '..', 'extensions', 'localcoders-core', 'src', 'views', 'agent-workspace-editor.ts'),
      'utf8'
    );

    const forbiddenIdeCalls = [
      'agentTeamView.focus',
      'mcpServersView.focus',
      'projectMemoryView.focus',
      'securityPermissionsView.focus',
      'criticReviewsView.focus',
      'showTextDocument',
      'this.changesManager.openDiff',
      'localcoders.manageModels',
      'id="btnOpenInEditor"',
    ];
    for (const pattern of forbiddenIdeCalls) {
      assert.ok(!editorSrc.includes(pattern), `Agent Workspace must not open IDE view or tab via "${pattern}"`);
    }

    const modalScript = [
      'const vscode = { postMessage() {} };',
      'const document = { getElementById() { return null; }, addEventListener() {} };',
      'function escapeHtml(s) { return String(s || ""); }',
      modals.getCockpitModalScript(),
    ].join('\n');
    new vm.Script(modalScript);

    const html = AgentWorkspaceEditorPanel.prototype._getHtmlForWebview.call({});
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch && scriptMatch[1], 'AgentWorkspaceEditorPanel must emit an inline script');
    new vm.Script(scriptMatch[1]);
  });

  it('17. LocalCoders and Agent Team share one unified Activity Bar container with crisp mask SVG icon', () => {
    const pkgPath = path.join(__dirname, '..', 'extensions', 'localcoders-core', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const activityContainers = pkg.contributes?.viewsContainers?.activitybar || [];

    assert.strictEqual(activityContainers.length, 1, 'Expected only one unified LocalCoders Activity Bar entry');
    assert.strictEqual(activityContainers[0].id, 'localcoders-activitybar');
    assert.strictEqual(activityContainers[0].icon, 'resources/activitybar-icon.svg');
    assert.strictEqual(pkg.contributes?.views?.['localcoders-agents-activitybar'], undefined);

    const unifiedViews = (pkg.contributes?.views?.['localcoders-activitybar'] || []).map((v) => v.id);
    assert.ok(unifiedViews.includes('localcoders.navigationView'));
    assert.ok(unifiedViews.includes('localcoders.agentTeamView'));
    assert.ok(unifiedViews.includes('localcoders.modelManagerView'));
    assert.ok(unifiedViews.includes('localcoders.mcpServersView'));

    const iconPath = path.join(__dirname, '..', 'extensions', 'localcoders-core', 'resources', 'activitybar-icon.svg');
    const iconSvg = fs.readFileSync(iconPath, 'utf8');
    assert.ok(iconSvg.includes('fill="none"'), 'Activity bar SVG must use transparent fill so CSS mask renders crisp strokes');
  });

  it('18. Sessions support inline rename and removal (including deleting the last session) without stale UI', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-18-'));
    try {
      const ctx = makeMockContext(tmpDir);
      const sm = new SessionManager(ctx, tmpDir);
      const s1 = sm.createSession('New Section', 'qwen3.8:27b');
      const s2 = sm.createSession('New Session', 'qwen3.8:27b');

      sm.renameSession(s1.id, 'Clock Refactor');
      assert.strictEqual(sm.getSession(s1.id)?.title, 'Clock Refactor');

      // Delete active (s2) -> falls back to s1; then delete s1 -> active becomes null safely
      sm.deleteSession(s2.id);
      assert.strictEqual(sm.getSession(s2.id), undefined);
      assert.strictEqual(sm.getActiveSession()?.id, s1.id);

      sm.deleteSession(s1.id);
      assert.strictEqual(sm.getAllSessions().length, 0);
      assert.strictEqual(sm.getActiveSession(), undefined);

      const editorSrc = fs.readFileSync(
        path.join(__dirname, '..', 'extensions', 'localcoders-core', 'src', 'views', 'agent-workspace-editor.ts'),
        'utf8'
      );
      assert.ok(editorSrc.includes('btn-rename-session'), 'Agent View session rows must render rename button');
      assert.ok(editorSrc.includes('btn-delete-session'), 'Agent View session rows must render delete button');
      assert.ok(editorSrc.includes('btnRenameActiveSession'), 'Agent View top bar must support renaming active session');
      assert.ok(editorSrc.includes("topSessionTitle.textContent = 'No active session'"), 'Agent View must reset UI when last session is deleted');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('19. Selecting a working folder updates orchestrator, session manager, and cockpit UI cleanly', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-19a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-19b-'));
    try {
      const ctx = makeMockContext(dirA);
      const registry = makeRegistry(ctx);
      const toolManager = new ToolManager();
      const orchestrator = new AgentOrchestrator(
        { getHost: () => 'http://127.0.0.1:11434' },
        registry,
        toolManager,
        dirA
      );
      const sm = new SessionManager(ctx, dirA);

      assert.strictEqual(orchestrator.getWorkspaceRoot(), dirA);
      const sA = sm.createSession('Session A', 'qwen3.8:27b');

      // Choosing a folder tells the agent where to work WITHOUT replacing or loading historical sessions from dirB
      sm.setTargetWorkspaceRoot(dirB);
      orchestrator.setWorkspace(dirB);

      assert.strictEqual(orchestrator.getWorkspaceRoot(), dirB);
      assert.strictEqual(sm.getAllSessions().length, 1, 'Choosing a folder must preserve current sections instead of switching to past folder sessions');
      assert.strictEqual(sm.getActiveSession()?.id, sA.id);
      assert.strictEqual(sm.getActiveSession()?.workspaceRoot, dirB);

      const editorSrc = fs.readFileSync(
        path.join(__dirname, '..', 'extensions', 'localcoders-core', 'src', 'views', 'agent-workspace-editor.ts'),
        'utf8'
      );
      assert.ok(editorSrc.includes("case 'selectWorkspace':"));
      assert.ok(editorSrc.includes('setTargetWorkspaceRoot(selectedRoot)'));
      assert.ok(!editorSrc.includes('this.sessionManager.setWorkspace(selectedRoot)'));
      assert.ok(editorSrc.includes('<button type="button" class="code-context-pill" id="btnWorkspaceContext"'));
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('20. Ollama client falls back to system OLLAMA_MODELS directory when user home has no manifests', () => {
    const { hasOllamaManifests, resolveOllamaModelsDir } = require('../extensions/localcoders-core/dist/ollama/client');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-20-'));
    try {
      const fakeHome = path.join(tmpRoot, 'home');
      const fakeUserModels = path.join(fakeHome, '.ollama', 'models');
      fs.mkdirSync(path.join(fakeUserModels, 'manifests'), { recursive: true });

      const fakeSysModels = path.join(tmpRoot, 'sys', '.ollama', 'models');
      const manifestLeaf = path.join(fakeSysModels, 'manifests', 'registry.ollama.ai', 'library', 'qwen3.8');
      fs.mkdirSync(manifestLeaf, { recursive: true });
      fs.writeFileSync(path.join(manifestLeaf, '27b'), '{}', 'utf8');

      assert.strictEqual(hasOllamaManifests(fakeUserModels), false);
      assert.strictEqual(hasOllamaManifests(fakeSysModels), true);
      assert.strictEqual(resolveOllamaModelsDir(undefined, fakeHome, [fakeSysModels]), fakeSysModels);
      assert.strictEqual(resolveOllamaModelsDir('/custom/models', fakeHome, [fakeSysModels]), '/custom/models');

      const userLeaf = path.join(fakeUserModels, 'manifests', 'registry.ollama.ai', 'library', 'llama');
      fs.mkdirSync(userLeaf, { recursive: true });
      fs.writeFileSync(path.join(userLeaf, '8b'), '{}', 'utf8');
      assert.strictEqual(resolveOllamaModelsDir(undefined, fakeHome, [fakeSysModels]), undefined);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('21. Inline Thinking disclosure groups activities accurately per user turn and collapses cleanly', () => {
    const vm = require('vm');
    const actUi = require('../extensions/localcoders-core/dist/views/activity-stream-ui');
    const sandbox = {
      document: { createElement: () => ({ className: '', innerHTML: '', style: {}, setAttribute() {}, addEventListener() {}, appendChild() {}, querySelector() { return null; } }) },
      lcIcon: () => '<svg></svg>',
    };
    vm.createContext(sandbox);
    vm.runInContext(actUi.getActivityClientScript(), sandbox);

    const msgs = [
      { id: 'u1', senderRole: 'user', timestamp: 1000, content: 'hello' },
      { id: 'a1', senderRole: 'assistant', timestamp: 1200, content: 'Hi!' },
      { id: 'u2', senderRole: 'user', timestamp: 2000, content: 'run tests' },
      { id: 'a2', senderRole: 'assistant', timestamp: 2500, content: 'Done.' },
    ];
    const acts = [
      { id: 't1', category: 'command', command: 'python3 -m pytest', status: 'completed', startTime: 2100 },
      { id: 't2', category: 'file', filePath: 'clock.py', status: 'completed', startTime: 2200 },
    ];

    const grouped = sandbox.lcGroupActivitiesByUserTurn(msgs, acts);
    assert.strictEqual(grouped.byMsgIndex[0], undefined, 'Greeting turn with no tools stays clean');
    assert.strictEqual(grouped.byMsgIndex[2].length, 2, 'Coding turn receives its 2 activities');
    assert.strictEqual(grouped.lastTurnMsgIndex, 2);

    const singleCmdLabel = sandbox.lcFormatTurnThinkingLabel({ activities: [acts[0]], isLive: false });
    assert.strictEqual(singleCmdLabel, 'Thinking · python3 -m pytest');

    const multiLabel = sandbox.lcFormatTurnThinkingLabel({ activities: acts, isLive: false });
    assert.strictEqual(multiLabel, 'Thinking · 1 command, 1 file');
  });

  it('22. Conversational and combined greeting+question prompts are understood without entering coding_task', () => {
    assert.strictEqual(classifyUserPrompt('hello, who are you ?', 'code'), 'greeting');
    assert.strictEqual(classifyUserPrompt('hi! what can you do?', 'code'), 'greeting');
    assert.strictEqual(classifyUserPrompt('do you understand me?', 'code'), 'greeting');
    assert.strictEqual(classifyUserPrompt('hey, what does clock.py do?', 'code'), 'question');
    assert.strictEqual(classifyUserPrompt('hi, is this project using pytest?', 'code'), 'question');
    assert.strictEqual(classifyUserPrompt('can you remove alarm feature, only clock', 'code'), 'coding_task');

    const cleaned = sanitizeConversationHistory(
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'Execution cancelled by user.' },
        { role: 'assistant', content: '### Execution Failed\nbroken' },
        { role: 'user', content: 'can you remove alarm feature' },
      ],
      'hello, who are you ?'
    );
    assert.strictEqual(cleaned.length, 2);
    assert.strictEqual(cleaned[0].content, 'hello');
    assert.strictEqual(cleaned[1].content, 'can you remove alarm feature');
  });

  it('23. Agent Terminal posts distinct runTerminalCommand payload and executes shell/cd/ANSI/CWD-sync', async () => {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const vm = require('vm');
    const Module = require('module');
    const { TerminalSessionManager, stripAnsiSequences } = require('../extensions/localcoders-core/dist/tools/terminal-session-manager');

    assert.strictEqual(stripAnsiSequences('\u001b[32mok\u001b[0m'), 'ok');

    // 1. Verify TerminalSessionManager executes real commands, compound cd && pwd, standalone cd, and setDefaultCwd sync
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-term-23-'));
    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir, { recursive: true });
    try {
      const mgr = new TerminalSessionManager();
      mgr.setDefaultCwd(tmpDir);
      const t1 = mgr.ensureDefaultTab(tmpDir);
      assert.strictEqual(t1.cwd, tmpDir);

      // Idle untouched tab follows newly selected working folder
      mgr.setDefaultCwd(subDir);
      assert.strictEqual(mgr.getTabs()[0].cwd, subDir);

      // Standalone `cd ..` updates tab cwd
      mgr.runCommand(t1.id, 'cd ..');
      assert.strictEqual(fs.realpathSync(mgr.getTabs()[0].cwd), fs.realpathSync(tmpDir));

      // Compound `cd sub && pwd` runs via shell (not hijacked by `cd` parser) and prints stdout
      await new Promise((resolve) => {
        const sub = mgr.onDidChange((tabs) => {
          const cur = tabs.find((t) => t.id === t1.id);
          if (cur && cur.status === 'completed' && cur.lines.some((l) => l.stream === 'stdout' && l.text.includes('sub'))) {
            sub.dispose();
            resolve();
          }
        });
        mgr.runCommand(t1.id, 'cd sub && pwd');
      });

      const finalLines = mgr.getTabs()[0].lines.map((l) => `${l.stream}:${l.text}`);
      assert.ok(finalLines.some((l) => l.startsWith('stdout:') && l.includes('sub')), 'Expected compound command stdout');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // 2. Verify AgentWorkspaceEditorPanel webview posts { command: 'runTerminalCommand', tabId, cmd } (no duplicate command key!)
    const origLoad = Module._load;
    let AgentWorkspaceEditorPanel;
    Module._load = function (req, parent, isMain) {
      if (req === 'vscode') {
        return {
          ViewColumn: { One: 1 },
          Uri: { file: (p) => ({ fsPath: p }) },
          EventEmitter: class { fire() {} event() {} dispose() {} },
          workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() }, name: 'LocalCoders' }], getConfiguration: () => ({ get: () => undefined }) },
          window: { createWebviewPanel: () => ({}), showInformationMessage: () => {}, showErrorMessage: () => {}, onDidDispose: () => {} },
          commands: { executeCommand: () => {} },
        };
      }
      return origLoad.apply(this, arguments);
    };
    try {
      ({ AgentWorkspaceEditorPanel } = require('../extensions/localcoders-core/dist/views/agent-workspace-editor'));
    } finally {
      Module._load = origLoad;
    }

    const html = AgentWorkspaceEditorPanel.prototype._getHtmlForWebview.call({ _panel: { webview: { cspSource: 'vscode-webview:' } } });
    const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
    assert.ok(scriptMatch, 'Webview script block must exist');

    const elements = new Map();
    const makeEl = (id) => {
      const listeners = {};
      return {
        id, value: '', placeholder: '', textContent: '', innerHTML: '', style: {}, dataset: {},
        classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
        addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
        dispatch(ev, arg) { (listeners[ev] || []).forEach((fn) => fn(arg)); },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        appendChild() {},
        remove() {},
        closest() { return null; },
        setAttribute() {},
        getAttribute() { return ''; },
        focus() {},
        select() {},
        getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 100, height: 30 }; },
      };
    };
    const posted = [];
    const winListeners = {};
    const sandbox = {
      console, setTimeout, clearTimeout, Set, Map, Array, Object, String, Number, Math, JSON, RegExp, Date, Promise, Error,
      acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m), getState: () => ({}), setState: () => {} }),
      window: { addEventListener: (ev, fn) => (winListeners[ev] = winListeners[ev] || []).push(fn), getSelection: () => '', innerWidth: 1200, innerHeight: 800 },
      document: {
        getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        createElement(tag) { return makeEl('_' + tag); },
        addEventListener() {},
      },
    };
    vm.runInNewContext(scriptMatch[1], sandbox);

    const loadTabs = [{ id: 'term_1', name: 'Terminal 1', cwd: '/tmp', status: 'idle', lines: [{ stream: 'system', text: 'Working directory: /tmp' }] }];
    winListeners.message.forEach((fn) => fn({ data: { type: 'loadSession', session: { id: 's1', title: 'S1', messages: [], activities: [], status: 'ready' }, allSessions: [{ id: 's1', title: 'S1' }], terminalTabs: loadTabs } }));

    // New tab added should auto-become active tab
    const nextTabs = [...loadTabs, { id: 'term_2', name: 'Terminal 2', cwd: '/tmp', status: 'idle', lines: [{ stream: 'system', text: 'Working directory: /tmp' }] }];
    winListeners.message.forEach((fn) => fn({ data: { type: 'terminalTabs', tabs: nextTabs } }));

    const termInput = elements.get('termCmdInput');
    termInput.value = 'ls -la';
    termInput.dispatch('keydown', { key: 'Enter', isComposing: false, preventDefault() {} });

    assert.strictEqual(posted.length, 1);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(posted[0])), { command: 'runTerminalCommand', tabId: 'term_2', cmd: 'ls -la' });

    elements.get('termCmdInput').value = 'pwd';
    elements.get('btnTermRun').dispatch('click', {});
    assert.strictEqual(posted.length, 2);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(posted[1])), { command: 'runTerminalCommand', tabId: 'term_2', cmd: 'pwd' });
  });

  it('24. Agent Mode hides single-tab bar and renders live CPU/RAM/GPU system telemetry bar', async () => {
    const fs = require('fs');
    const vm = require('vm');
    const Module = require('module');
    const { collectLiveSystemTelemetry, shortCpuModel, shortGpuName } = require('../extensions/localcoders-core/dist/ollama/hardware');

    assert.strictEqual(shortCpuModel('13th Gen Intel(R) Core(TM) i5-13400F'), 'i5-13400F');
    assert.strictEqual(shortGpuName('NVIDIA GeForce RTX 3070'), 'RTX 3070');

    const telemetry = await collectLiveSystemTelemetry('http://127.0.0.1:11434');
    assert.ok(telemetry.cpu.cores > 0);
    assert.ok(telemetry.cpu.usagePercent >= 0 && telemetry.cpu.usagePercent <= 100);
    assert.ok(telemetry.ram.totalGb > 0);
    assert.ok(telemetry.ram.usedGb >= 0 && telemetry.ram.usedGb <= telemetry.ram.totalGb);

    // Verify Code-OSS EditorGroupView + CSS hide single redundant tab strip in Agent Mode
    const path = require('path');
    const vscodeSrcRoot = path.resolve(__dirname, '..', 'vscode-src');
    const egvSrc = fs.readFileSync(path.join(vscodeSrcRoot, 'src/vs/workbench/browser/parts/editor/editorGroupView.ts'), 'utf8');
    const tbCss = fs.readFileSync(path.join(vscodeSrcRoot, 'src/vs/workbench/browser/parts/titlebar/media/titlebarpart.css'), 'utf8');
    assert.ok(egvSrc.includes('shouldHideTitleContainer()'), 'EditorGroupView checks Agent Mode title hiding');
    assert.ok(egvSrc.includes("'localcoders.inAgentMode'"), 'EditorGroupView reacts to Agent Mode context key');
    assert.ok(tbCss.includes('.editor-group-container > .title'), 'CSS hides redundant tab title strip in Agent Mode');

    // Verify AgentWorkspaceEditorPanel renders CPU/RAM/GPU chips into #systemTelemetryMetrics
    const origLoad = Module._load;
    let AgentWorkspaceEditorPanel;
    Module._load = function (req, parent, isMain) {
      if (req === 'vscode') {
        return {
          ViewColumn: { One: 1 },
          Uri: { file: (p) => ({ fsPath: p }) },
          EventEmitter: class { fire() {} event() {} dispose() {} },
          workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() }, name: 'LocalCoders' }], getConfiguration: () => ({ get: () => undefined }) },
          window: { createWebviewPanel: () => ({}), showInformationMessage: () => {}, showErrorMessage: () => {}, onDidDispose: () => {} },
          commands: { executeCommand: () => {} },
        };
      }
      return origLoad.apply(this, arguments);
    };
    try {
      ({ AgentWorkspaceEditorPanel } = require('../extensions/localcoders-core/dist/views/agent-workspace-editor'));
    } finally {
      Module._load = origLoad;
    }

    const html = AgentWorkspaceEditorPanel.prototype._getHtmlForWebview.call({ _panel: { webview: { cspSource: 'vscode-webview:' } } });
    assert.ok(html.includes('id="systemTelemetryBar"'), 'Workspace HTML includes system telemetry bar');
    const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
    const elements = new Map();
    const makeEl = (id) => {
      const listeners = {};
      return {
        id, value: '', placeholder: '', textContent: '', innerHTML: '', style: {}, dataset: {},
        classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
        addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
        dispatch(ev, arg) { (listeners[ev] || []).forEach((fn) => fn(arg)); },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        appendChild() {},
        remove() {},
        closest() { return null; },
        setAttribute() {},
        getAttribute() { return ''; },
        focus() {},
        select() {},
        getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 100, height: 30 }; },
      };
    };
    const posted = [];
    const winListeners = {};
    const sandbox = {
      console, setTimeout, clearTimeout, Set, Map, Array, Object, String, Number, Math, JSON, RegExp, Date, Promise, Error,
      acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m), getState: () => ({}), setState: () => {} }),
      window: { addEventListener: (ev, fn) => (winListeners[ev] = winListeners[ev] || []).push(fn), getSelection: () => '', innerWidth: 1200, innerHeight: 800 },
      document: {
        getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        createElement(tag) { return makeEl('_' + tag); },
        addEventListener() {},
      },
    };
    vm.runInNewContext(scriptMatch[1], sandbox);

    winListeners.message.forEach((fn) => fn({
      data: {
        type: 'systemTelemetry',
        telemetry: {
          cpu: { model: 'Test CPU', shortModel: 'i5-13400F', cores: 16, usagePercent: 22 },
          ram: { usedGb: 8.4, totalGb: 30.6, usagePercent: 27 },
          gpu: { name: 'NVIDIA GeForce RTX 3070', shortName: 'RTX 3070', memoryUsedMb: 1024, memoryTotalMb: 8192, utilizationPercent: 14, temperatureC: 42 },
          ollama: { running: true, activeModels: ['qwen3.8:27b'], totalVramGb: 18.0 },
        },
      },
    }));

    const rendered = elements.get('systemTelemetryMetrics').innerHTML;
    assert.ok(rendered.includes('i5-13400F (16c)'), 'Shows CPU summary');
    assert.ok(rendered.includes('8.4 / 30.6 GB'), 'Shows RAM summary');
    assert.ok(rendered.includes('RTX 3070'), 'Shows GPU name');
    assert.ok(rendered.includes('qwen3.8:27b'), 'Shows loaded local model');

    elements.get('btnRefreshTelemetry').dispatch('click', {});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(posted[0])), { command: 'refreshSystemTelemetry' });
  });

  it('25. Composer toolbar dropdown controls use uniform 28px/24px height, 6px border-radius, and button markup', () => {
    const Module = require('module');
    const origLoad = Module._load;
    let AgentWorkspaceEditorPanel;
    let ChatViewProvider;
    Module._load = function (req, parent, isMain) {
      if (req === 'vscode') {
        return {
          ViewColumn: { One: 1 },
          Uri: { file: (p) => ({ fsPath: p }) },
          EventEmitter: class { fire() {} event() {} dispose() {} },
          workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() }, name: 'LocalCoders' }], getConfiguration: () => ({ get: () => undefined }) },
          window: { createWebviewPanel: () => ({}), showInformationMessage: () => {}, showErrorMessage: () => {}, onDidDispose: () => {} },
          commands: { executeCommand: () => {} },
        };
      }
      return origLoad.apply(this, arguments);
    };
    try {
      ({ AgentWorkspaceEditorPanel } = require('../extensions/localcoders-core/dist/views/agent-workspace-editor'));
      ({ ChatViewProvider } = require('../extensions/localcoders-core/dist/views/chat-view'));
    } finally {
      Module._load = origLoad;
    }

    const agentHtml = AgentWorkspaceEditorPanel.prototype._getHtmlForWebview.call({ _panel: { webview: { cspSource: 'vscode-webview:' } } });
    assert.ok(!/\.code-context-pill\s*\{[^}]*border-radius:\s*999px/s.test(agentHtml), 'Workspace folder pill must not use 999px capsule radius');
    assert.ok(agentHtml.includes('.tool-btn-pill,\n    .code-context-pill,\n    .model-selector-pill,\n    .effort-selector-pill'), 'All Agent composer pills share unified CSS block');
    assert.ok(agentHtml.includes('id="btnEffortConfig"'), 'Effort button exists');
    assert.ok(/<button[^>]+id="btnEffortConfig"[\s\S]*?pill-arrow/.test(agentHtml), 'Effort button uses <button> with uniform chevron');
    assert.ok(/<button[^>]+id="modelSelector"/.test(agentHtml), 'Model selector uses <button>');

    const chatHtml = ChatViewProvider.prototype._getHtmlForWebview.call({ _extensionUri: { fsPath: process.cwd() } }, { cspSource: 'vscode-webview:' });
    assert.ok(chatHtml.includes('.tool-btn-pill,\n    .model-selector-pill,\n    .effort-selector-pill'), 'Sidebar composer pills share unified CSS block');
    assert.ok(/<button[^>]+id="btnEffortConfig"[\s\S]*?pill-arrow/.test(chatHtml), 'Sidebar effort button uses <button> with uniform chevron');

    const fs = require('fs');
    const path = require('path');
    const vscodeSrcRoot = path.resolve(__dirname, '..', 'vscode-src');
    const wbContrib = fs.readFileSync(path.join(vscodeSrcRoot, 'src/vs/workbench/browser/workbench.contribution.ts'), 'utf8');
    const tbPart = fs.readFileSync(path.join(vscodeSrcRoot, 'src/vs/workbench/browser/parts/titlebar/titlebarPart.ts'), 'utf8');
    assert.ok(/'workbench\.statusBar\.visible':\s*\{[^}]*'default':\s*false/s.test(wbContrib), 'Bottom status bar defaults to hidden');
    assert.ok(tbPart.includes('setPartHidden(true, Parts.STATUSBAR_PART)'), 'Titlebar mode switch enforces hidden status bar');
    assert.ok(!tbPart.includes('localcoders-brand-btn'), 'Redundant Agents dropdown button removed from titlebar');
  });

  it('26. Minimalist Sessions bar renders uniform Sessions/Recent hierarchy, dot gutter, relative hours/days, filter & folder grouping', () => {
    const vm = require('vm');
    const { AgentWorkspaceEditorPanel } = require('../extensions/localcoders-core/dist/views/agent-workspace-editor');
    const { ChatViewProvider } = require('../extensions/localcoders-core/dist/views/chat-view');
    const { NavigationViewProvider } = require('../extensions/localcoders-core/dist/views/navigation-view');

    const agentHtml = AgentWorkspaceEditorPanel.prototype._getHtmlForWebview.call({ _panel: { webview: { cspSource: 'vscode-webview:' } } });
    const navHtml = NavigationViewProvider.prototype._getHtmlForWebview.call({ _extensionUri: { fsPath: process.cwd() } });
    const chatHtml = ChatViewProvider.prototype._getHtmlForWebview.call({ _extensionUri: { fsPath: process.cwd() } }, { cspSource: 'vscode-webview:' });

    for (const [label, html] of [['AgentView', agentHtml], ['NavView', navHtml], ['ChatDrawer', chatHtml]]) {
      assert.ok(html.includes('lc-sessions-header'), `${label} uses minimalist lc-sessions-header`);
      assert.ok(html.includes('lc-recent-subheader'), `${label} includes Recent clock subheader`);
      assert.ok(html.includes('lc-sess-row'), `${label} defines clean lc-sess-row styles`);
      assert.ok(!/\.lc-sess-row\.active\s*\{[^}]*border-left/s.test(html), `${label} active session uses rounded matte fill without left stripe`);
    }

    const scriptMatch = agentHtml.match(/<script>([\s\S]*)<\/script>/);
    assert.ok(scriptMatch && scriptMatch[1], 'AgentWorkspaceEditorPanel script block exists');

    const elements = new Map();
    const makeEl = (id) => {
      const listeners = {};
      const children = [];
      const el = {
        id, value: '', placeholder: '', textContent: '', style: {}, dataset: {}, children,
        classList: {
          _s: new Set(),
          add(...c) { c.forEach((x) => this._s.add(x)); },
          remove(...c) { c.forEach((x) => this._s.delete(x)); },
          toggle(c, f) { if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (f) this._s.add(c); else this._s.delete(c); },
          contains(c) { return this._s.has(c); },
        },
        addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
        dispatch(ev, arg) { (listeners[ev] || []).forEach((fn) => fn(arg || {})); },
        setAttribute() {},
        getAttribute() { return ''; },
        appendChild(ch) { children.push(ch); return ch; },
        remove() {},
        contains() { return false; },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        closest() { return null; },
        focus() {},
        select() {},
        getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 100, height: 30 }; },
      };
      Object.defineProperty(el, 'className', {
        get() { return Array.from(el.classList._s).join(' '); },
        set(v) { el.classList._s = new Set(String(v || '').split(/\s+/).filter(Boolean)); },
      });
      Object.defineProperty(el, 'innerHTML', {
        get() { return el._innerHTML || ''; },
        set(v) { el._innerHTML = String(v); if (v === '') children.length = 0; },
      });
      return el;
    };

    const posted = [];
    const winListeners = {};
    const sandbox = {
      console, setTimeout, clearTimeout, Set, Map, Array, Object, String, Number, Math, JSON, RegExp, Date, Promise, Error,
      acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m), getState: () => ({}), setState: () => {} }),
      window: { addEventListener: (ev, fn) => (winListeners[ev] = winListeners[ev] || []).push(fn), getSelection: () => '', innerWidth: 1280, innerHeight: 820 },
      document: {
        getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        createElement(tag) { return makeEl('_' + tag); },
        addEventListener() {},
      },
    };
    vm.runInNewContext(scriptMatch[1], sandbox);

    const now = Date.now();
    const sessions = [
      { id: 's1', title: 'Understand the Project Codebase', workspaceRoot: '/ws/LocalCoders', updatedAt: now - 11 * 3600 * 1000, status: 'idle', messages: [], activities: [] },
      { id: 's2', title: 'Review Current Project Status', workspaceRoot: '/ws/LocalCoders', updatedAt: now - 6 * 86400 * 1000, status: 'completed', messages: [], activities: [] },
    ];
    winListeners.message.forEach((fn) => fn({
      data: {
        type: 'loadSession',
        session: sessions[0],
        allSessions: sessions,
        allModels: [],
        modelsGrouped: { local: [], cloud: [], providers: [] },
        currentConfig: { executionMode: 'code', permissionMode: 'smart', attachedFiles: [] },
        permissionMode: 'smart',
      },
    }));

    const listEl = elements.get('sessionsList');
    assert.strictEqual(listEl.children.length, 2);
    assert.strictEqual(listEl.children[0].classList.contains('active'), true);
    assert.match(listEl.children[0].innerHTML, /11 hours ago/);
    assert.match(listEl.children[0].innerHTML, /lc-sess-dot/);
    assert.ok(!listEl.children[0].innerHTML.includes('lc-sess-meta-icon'), 'Removed Devin-style triangle icon from session rows');
    assert.match(listEl.children[1].innerHTML, /6 days ago/);

    // Toggle By Folder grouping -> creates collapsible folder parent header + indented children
    elements.get('pillGroupFolder').dispatch('click', {});
    assert.strictEqual(listEl.children[0].classList.contains('lc-sess-group-header'), true);
    assert.strictEqual(listEl.children[1].children.length, 2);
    assert.strictEqual(listEl.children[1].children[0].classList.contains('child'), true);
  });

  it('27. LocalCoders branding & desktop icons use LC Aura design while sidebar header shows logged-in device username', () => {
    const brandSvg = fs.readFileSync(path.join(__dirname, '..', 'branding', 'localcoders-logo.svg'), 'utf8');
    const extSvg = fs.readFileSync(path.join(__dirname, '..', 'extensions', 'localcoders-core', 'resources', 'icon.svg'), 'utf8');
    const actSvg = fs.readFileSync(path.join(__dirname, '..', 'extensions', 'localcoders-core', 'resources', 'activitybar-icon.svg'), 'utf8');
    const titleSvg = fs.readFileSync(path.join(__dirname, '..', 'vscode-src', 'src', 'vs', 'workbench', 'browser', 'media', 'code-icon.svg'), 'utf8');
    const brandPng = fs.readFileSync(path.join(__dirname, '..', 'branding', 'localcoders-icon.png'));
    const linuxCodePng = fs.readFileSync(path.join(__dirname, '..', 'vscode-src', 'resources', 'linux', 'code.png'));
    const linuxLocalCodersPng = fs.readFileSync(path.join(__dirname, '..', 'vscode-src', 'resources', 'linux', 'localcoders.png'));

    assert.strictEqual(brandSvg, extSvg);
    assert.strictEqual(brandSvg, titleSvg);
    assert.ok(brandSvg.includes('auraCenter') && brandSvg.includes('auraRingGrad'), 'Brand SVG defines layered Aura gradients');
    assert.ok(!brandSvg.includes('mainAgentGrad') && !brandSvg.includes('criticGrad'), 'Legacy multi-node logo removed');
    assert.ok(actSvg.includes('fill="none"') && actSvg.includes('<circle cx="12" cy="12"'), 'Activity Bar icon retains crisp LC + Aura circle mask stroke');
    assert.ok(brandPng.length > 10000, 'Rendered 512x512 PNG logo exists');
    assert.strictEqual(Buffer.compare(brandPng, linuxCodePng), 0, 'Linux desktop code.png matches LC Aura PNG icon');
    assert.strictEqual(Buffer.compare(brandPng, linuxLocalCodersPng), 0, 'Linux desktop localcoders.png matches LC Aura PNG icon');

    const { getDeviceUsername, getUserProfileBadgeMarkup } = require('../extensions/localcoders-core/dist/views/sessions-bar-ui');
    const { AgentWorkspaceEditorPanel } = require('../extensions/localcoders-core/dist/views/agent-workspace-editor');
    const { NavigationViewProvider } = require('../extensions/localcoders-core/dist/views/navigation-view');

    const expectedUser = getDeviceUsername();
    assert.ok(expectedUser.length > 0 && expectedUser !== 'LocalCoders', 'Resolved device login username');

    const agentHtml = AgentWorkspaceEditorPanel.prototype._getHtmlForWebview.call({ _panel: { webview: { cspSource: 'vscode-webview:' } } });
    const navHtml = NavigationViewProvider.prototype._getHtmlForWebview.call({ _extensionUri: { fsPath: process.cwd() } });

    assert.ok(agentHtml.includes('class="lc-user-name">' + expectedUser + '</span>'), 'Agent View header shows device login username');
    assert.ok(navHtml.includes('class="lc-user-name">' + expectedUser + '</span>'), 'Navigation View header shows device login username');
    assert.ok(!agentHtml.includes('lc-brand-svg'), 'Agent View sidebar header does not show LC brand SVG');
    assert.ok(!navHtml.includes('lc-brand-svg'), 'Navigation View sidebar header does not show LC brand SVG');

    const escapedBadge = getUserProfileBadgeMarkup('<alice&bob>');
    assert.ok(escapedBadge.includes('&lt;alice&amp;bob&gt;'), 'User profile badge escapes HTML characters');
    assert.ok(!escapedBadge.includes('<alice'), 'User profile badge prevents raw HTML injection');
  });

  it('28. Agent Workspace composer is docked in flex flow below chat scroll container so it never overlaps messages', () => {
    const { AgentWorkspaceEditorPanel } = require('../extensions/localcoders-core/dist/views/agent-workspace-editor');
    const { ChatViewProvider } = require('../extensions/localcoders-core/dist/views/chat-view');
    const agentHtml = AgentWorkspaceEditorPanel.prototype._getHtmlForWebview.call({ _panel: { webview: { cspSource: 'vscode-webview:' } } });
    const chatHtml = ChatViewProvider.prototype._getHtmlForWebview.call({ _extensionUri: { fsPath: process.cwd() } });

    const scrollCssMatch = agentHtml.match(/\.workspace-scroll\s*\{([^}]*)\}/);
    const barCssMatch = agentHtml.match(/\.floating-prompt-bar\s*\{([^}]*)\}/);
    const mainCssMatch = agentHtml.match(/\.devin-main\s*\{([^}]*)\}/);
    assert.ok(scrollCssMatch && barCssMatch && mainCssMatch, 'Expected workspace layout CSS blocks to exist');

    assert.match(mainCssMatch[1], /flex-direction:\s*column/, 'Main column stacks top bar, scroll feed, and composer');
    assert.match(mainCssMatch[1], /min-height:\s*0/, 'Main column allows scroll region to shrink');
    assert.match(scrollCssMatch[1], /flex:\s*1/, 'Chat feed fills remaining height above composer');
    assert.match(scrollCssMatch[1], /min-height:\s*0/, 'Chat feed enables bounded flex scrolling');
    assert.doesNotMatch(scrollCssMatch[1], /140px/, 'Legacy 140px bottom overlay padding workaround removed');

    assert.match(barCssMatch[1], /position:\s*relative/, 'Composer uses in-flow relative positioning instead of viewport overlay');
    assert.match(barCssMatch[1], /flex-shrink:\s*0/, 'Composer retains full height below scroll area');
    assert.doesNotMatch(barCssMatch[1], /position:\s*absolute/, 'Composer must not float absolutely over chat messages');
    assert.doesNotMatch(barCssMatch[1], /translateX\(-50%\)/, 'Removed transform so fixed backdrop covers full viewport');

    const chatContainerCss = chatHtml.match(/#chat-container\s*\{([^}]*)\}/);
    assert.ok(chatContainerCss, 'Chat sidebar feed CSS block exists');
    assert.match(chatContainerCss[1], /min-height:\s*0/, 'Sidebar chat feed includes min-height: 0');
  });

  it('29. Shared lcRenderMarkdown renders headings, lists, code fences, bold, inline code & links into HTML instead of raw markdown', () => {
    const vm = require('vm');
    const actUi = require('../extensions/localcoders-core/dist/views/activity-stream-ui');
    const { AgentWorkspaceEditorPanel } = require('../extensions/localcoders-core/dist/views/agent-workspace-editor');
    const { ChatViewProvider } = require('../extensions/localcoders-core/dist/views/chat-view');

    const sandbox = {
      document: { createElement: () => ({ className: '', innerHTML: '', style: {}, setAttribute() {}, addEventListener() {}, appendChild() {}, querySelector() { return null; } }) },
      lcIcon: () => '<svg></svg>',
    };
    vm.createContext(sandbox);
    vm.runInContext(actUi.getActivityClientScript(), sandbox);

    const sampleMd = [
      '### Execution Complete',
      'All tasks completed successfully.',
      '',
      '**Critic Verdict**: `approved`',
      '- Fixed `clock.py` syntax',
      '1. Verified tests',
      '',
      '```python',
      '# Heading comment inside code stays code',
      'print("ok")',
      '```',
    ].join('\n');

    const rendered = sandbox.lcRenderMarkdown(sampleMd);
    assert.ok(rendered.includes('<h3 class="lc-md-h lc-md-h3">Execution Complete</h3>'), 'Heading ### renders as h3');
    assert.ok(!rendered.includes('### Execution Complete'), 'Raw ### marker removed');
    assert.ok(rendered.includes('<strong>Critic Verdict</strong>'), 'Bold renders as strong');
    assert.ok(rendered.includes('<code class="lc-md-inline">approved</code>'), 'Inline code rendered cleanly');
    assert.ok(rendered.includes('<ul class="lc-md-list"><li>Fixed <code class="lc-md-inline">clock.py</code> syntax</li></ul>'), 'Unordered list rendered cleanly');
    assert.ok(rendered.includes('<ol class="lc-md-list"><li>Verified tests</li></ol>'), 'Ordered list rendered cleanly');
    assert.ok(rendered.includes('<pre class="lc-md-pre"><div class="lc-md-lang">python</div><code># Heading comment inside code stays code'), 'Fenced code block preserves # comments as code rather than h1');

    // Verify both Agent View and Chat View delegate to lcRenderMarkdown cleanly
    const agentHtml = AgentWorkspaceEditorPanel.prototype._getHtmlForWebview.call({ _panel: { webview: { cspSource: 'vscode-webview:' } } });
    const chatHtml = ChatViewProvider.prototype._getHtmlForWebview.call({ _extensionUri: { fsPath: process.cwd() } });
    assert.ok(agentHtml.includes('return lcRenderMarkdown(text);'), 'Agent view uses shared lcRenderMarkdown');
    assert.ok(chatHtml.includes('return lcRenderMarkdown(text);'), 'Chat view uses shared lcRenderMarkdown');
  });

  it('30. Built-in specialist delegation & live agent thinking entries surface multiple agents and reasoning inside Thinking drawer', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-30-'));
    const vscode = require('vscode');
    const origFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpDir }, name: 'tmp', index: 0 }];
    try {
      const registry = makeRegistry(makeMockContext(tmpDir));
      const toolManager = new ToolManager();
      const { extractAgentReasoningText } = require('../extensions/localcoders-core/dist/agents/events');

      // Registry has NO custom subagents registered -> Orchestrator should supply built-in specialists cleanly
      assert.strictEqual(registry.getSubagents().length, 0);

      assert.strictEqual(
        extractAgentReasoningText('<think>Plan clock first</think>Writing module now<tool_call>{"name":"write_file"}</tool_call>'),
        'Plan clock first\n\nWriting module now'
      );

      const mockLlm = {
        getHost: () => 'http://127.0.0.1:11434',
        chatStream: async (params, onChunk) => {
          const sys = String(params.messages[0]?.content || '');
          const userAll = params.messages.map((m) => String(m.content || '')).join('\n');

          if (sys.includes('PLANNING INSTRUCTIONS')) {
            // Mock a local LLM that leaves assignedTo='main' on all tasks -> planner normalizes UI & test tasks to specialists
            onChunk({
              content:
                '```json\n' +
                JSON.stringify({
                  tasks: [
                    { id: 't1', title: 'Implement Core Logic in clock.py', description: 'Clock class', assignedTo: 'main', dependencies: [], affectedFiles: ['clock.py'] },
                    { id: 't2', title: 'Build UI Component in index.html', description: 'Web UI', assignedTo: 'main', dependencies: ['t1'], affectedFiles: ['index.html'] },
                    { id: 't3', title: 'Write Unit Tests in test_clock.py', description: 'Verify behavior', assignedTo: 'main', dependencies: ['t1'], affectedFiles: ['test_clock.py'] },
                  ],
                }) +
                '\n```',
              thinking: 'Analyzing whether to split core, UI, and tests across agents.',
              done: true,
            });
            return;
          }

          if (sys.includes('LocalCoders Critic Agent')) {
            onChunk({
              content: '<think>All three files and tests align cleanly.</think>```json\n{"verdict":"approved","summary":"All clean","findings":[]}\n```',
              done: true,
            });
            return;
          }

          const hasTool = params.messages.some((m) => m.role === 'tool' || (m.role === 'user' && String(m.content).includes('[Tool Result')));
          if (!hasTool) {
            if (userAll.includes('index.html')) {
              onChunk({
                content: '',
                thinking: 'Structuring accessible minimal clock HTML layout.',
                toolCalls: [{ function: { name: 'write_file', arguments: { path: 'index.html', content: '<div id="clock"></div>' } } }],
                done: true,
              });
            } else if (userAll.includes('test_clock.py')) {
              onChunk({
                content: '',
                thinking: 'Writing isolated unittest assertions for clock module.',
                toolCalls: [{ function: { name: 'write_file', arguments: { path: 'test_clock.py', content: 'import unittest\nclass T(unittest.TestCase):\n  def test_ok(self): self.assertTrue(True)\n' } } }],
                done: true,
              });
            } else {
              onChunk({
                content: '',
                thinking: 'Designing Clock state class in clock.py.',
                toolCalls: [{ function: { name: 'write_file', arguments: { path: 'clock.py', content: 'class Clock:\n  pass\n' } } }],
                done: true,
              });
            }
            return;
          }
          onChunk({ content: 'Completed.', done: true });
        },
      };

      const orchestrator = new AgentOrchestrator(mockLlm, registry, toolManager, tmpDir);
      const upserts = [];
      orchestrator.onStreamEvent((ev) => {
        if (ev.kind === 'activity_upsert') upserts.push(ev.item);
      });

      const task = await orchestrator.submitTask('Build clock with HTML UI and tests', {
        providerId: 'ollama',
        modelId: 'qwen2.5-coder:7b',
        modelName: 'qwen2.5-coder:7b',
        reasoningEffort: 'medium',
        fastMode: false,
        executionMode: 'code',
        permissionMode: 'bypass',
        enabledMcpServers: [],
        enabledSkills: [],
        activeRules: [],
        attachedFiles: [],
        projectContext: [],
      });

      assert.strictEqual(task.status, 'completed');
      const agentNames = new Set(upserts.map((i) => i.agentName));
      assert.ok(agentNames.has('Main Agent'), 'Includes Main Agent');
      assert.ok(agentNames.has('Frontend Specialist'), 'Delegates UI task to Frontend Specialist');
      assert.ok(agentNames.has('Test Engineer'), 'Delegates test task to Test Engineer');
      assert.ok(agentNames.has('Critic Agent'), 'Includes Critic Agent review');

      const thoughts = upserts.filter((i) => i.category === 'thinking_summary' && i.status === 'completed');
      assert.ok(thoughts.some((t) => (t.stdout || '').includes('Analyzing whether to split core')), 'Emits planning thought');
      assert.ok(thoughts.some((t) => t.agentName === 'Frontend Specialist' && (t.stdout || '').includes('Structuring accessible minimal clock')), 'Emits Frontend Specialist thought');
      assert.ok(thoughts.some((t) => t.agentName === 'Test Engineer' && (t.stdout || '').includes('Writing isolated unittest')), 'Emits Test Engineer thought');
      assert.ok(thoughts.some((t) => t.agentName === 'Critic Agent' && (t.stdout || '').includes('All three files')), 'Emits Critic thought');

      // Verify UI drawer renders thinking_summary items cleanly as .lc-thought-entry nodes
      const vm = require('vm');
      const actUi = require('../extensions/localcoders-core/dist/views/activity-stream-ui');
      const makeDomNode = (tag) => {
        const node = { tagName: tag, className: '', innerHTML: '', textContent: '', children: [], style: {}, setAttribute() {}, addEventListener() {}, appendChild(c) { this.children.push(c); }, querySelector() { return null; } };
        return node;
      };
      const sandbox = {
        document: { createElement: makeDomNode },
        lcIcon: () => '<svg></svg>',
      };
      vm.createContext(sandbox);
      vm.runInContext(actUi.getActivityClientScript(), sandbox);

      const groupNode = sandbox.lcBuildInlineThinkingGroup({
        turnKey: 't0',
        activities: thoughts.slice(0, 2),
        isExpanded: true,
        isLive: false,
      });
      const drawerNode = groupNode.children[1];
      assert.ok(drawerNode.children.length >= 2);
      assert.ok(drawerNode.children[0].className.includes('lc-thought-entry'), 'Thoughts render using dedicated .lc-thought-entry blocks');
      assert.ok(drawerNode.children[0].innerHTML.includes('lc-thought-body'), 'Thought body is directly visible inside Thinking drawer');
    } finally {
      vscode.workspace.workspaceFolders = origFolders;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('31. Casual introductions, memory queries, and post-cancel greetings never leak cancelled tasks or trigger coding plans', async () => {
    // 1. Conversational classification cases (must stay 'greeting', never 'coding_task')
    for (const casual of [
      'My name is Nigfa',
      'I am Juan',
      "I'm Alex",
      'Call me Juan',
      'Please remember my name is Nigfa',
      'Can you remember my name if i tell you ?',
      'What is my name?',
      'Do you remember my name?',
      'Nice to meet you',
      'Never mind',
      'Yes',
      'No',
      'Today is sunny',
    ]) {
      assert.strictEqual(
        classifyUserPrompt(casual, 'code'),
        'greeting',
        `Expected casual chat "${casual}" to classify as greeting, not coding_task`
      );
    }

    // Real coding requests still classify cleanly as coding_task
    assert.strictEqual(classifyUserPrompt('Improve the settings page', 'code'), 'coding_task');
    assert.strictEqual(classifyUserPrompt('Build an UI for the clock then run the clock', 'code'), 'coding_task');
    assert.strictEqual(classifyUserPrompt('rewrite the readme.md, NO USE ICONS', 'code'), 'coding_task');

    // 2. Cancelled task turns are stripped and orphaned prompts are never passed back-to-back before "Hi"
    const postCancelRaw = [
      { role: 'user', content: 'Add an alarm feature to clock.py' },
      { role: 'assistant', content: '### Implementation Plan\n1. Modify clock.py' },
      { role: 'system', content: 'Execution cancelled by user.' },
      { role: 'user', content: 'Hi' },
    ];
    const withoutCancel = stripCancelledTurnsFromHistory(postCancelRaw);
    assert.strictEqual(withoutCancel.length, 1);
    assert.strictEqual(withoutCancel[0].content, 'Hi');

    const paired = pairConversationHistory([
      { role: 'user', content: 'unanswered coding prompt' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'trailing unpaired prompt' },
    ]);
    assert.deepStrictEqual(paired, [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ]);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-31-'));
    try {
      const registry = makeRegistry(makeMockContext(tmpDir));
      const toolManager = new ToolManager();
      const recordedPayloads = [];
      let sawPlanOrTools = false;

      const mockLlm = {
        getHost: () => 'https://api.openai.com',
        chatStream: async (params, onChunk) => {
          recordedPayloads.push(params.messages.map((m) => ({ role: m.role, content: m.content })));
          if (params.tools && params.tools.length > 0) sawPlanOrTools = true;
          if (params.messages.some((m) => /OUTPUT FORMAT:|CRITICAL PLANNING INSTRUCTIONS/i.test(m.content || ''))) {
            sawPlanOrTools = true;
          }
          const lastUser = (params.messages[params.messages.length - 1]?.content || '').toLowerCase();
          if (lastUser.includes('my name is nigfa')) {
            onChunk({ content: 'Nice to meet you, Nigfa! I will remember that.', done: true });
          } else if (lastUser.includes('what is my name')) {
            const knowsName = params.messages.some((m) => /Nigfa/.test(m.content || ''));
            onChunk({ content: knowsName ? 'Your name is Nigfa.' : 'I do not know your name yet.', done: true });
          } else {
            onChunk({ content: 'Hello! How can I help you today?', done: true });
          }
        },
      };

      const orchestrator = new AgentOrchestrator(mockLlm, registry, toolManager, tmpDir);
      const events = [];
      orchestrator.onStreamEvent((ev) => events.push(ev));

      const baseConfig = {
        providerId: 'openai',
        modelId: 'gpt-4o',
        modelName: 'GPT-4o',
        reasoningEffort: 'medium',
        fastMode: false,
        executionMode: 'code',
        permissionMode: 'smart',
        enabledMcpServers: [],
        enabledSkills: [],
        activeRules: [],
        attachedFiles: [],
        projectContext: [],
      };

      // Turn A: User says "Hi" right after cancelling a coding task -> no orphaned coding prompt passed
      const hiTask = await orchestrator.submitTask('Hi', baseConfig, postCancelRaw);
      assert.strictEqual(hiTask.status, 'completed');
      assert.strictEqual(
        recordedPayloads[0].some((m) => /alarm/i.test(m.content || '')),
        false,
        'Post-cancel Hi must not receive cancelled alarm prompt in chat history'
      );

      // Turn B: "My name is Nigfa" -> stays in casual fast chat (zero planning, zero tools, zero Critic)
      const convHistory = [
        ...postCancelRaw.slice(0, 3),
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello! How can I help you today?' },
        { role: 'user', content: 'Can you remember my name if i tell you ?' },
        { role: 'assistant', content: 'Yes, I can remember your name if you tell me.' },
      ];
      const nameTask = await orchestrator.submitTask('My name is Nigfa', baseConfig, convHistory);
      assert.strictEqual(nameTask.status, 'completed');
      assert.strictEqual(sawPlanOrTools, false, 'Casual self-introduction must never trigger planning, tools, or Critic');
      assert.strictEqual(events.filter((e) => e.kind === 'plan').length, 0);

      // Turn C: "What is my name?" recalls "Nigfa" from paired chat history without coding tools
      convHistory.push(
        { role: 'user', content: 'My name is Nigfa' },
        { role: 'assistant', content: 'Nice to meet you, Nigfa! I will remember that.' }
      );
      let recalledReply = '';
      orchestrator.onMessage((msg) => {
        if (msg.senderRole === 'assistant') recalledReply = msg.content;
      });
      await orchestrator.submitTask('What is my name?', baseConfig, convHistory);
      assert.match(recalledReply, /Nigfa/, 'Assistant recalls shared name cleanly across paired chat turns');
      assert.strictEqual(sawPlanOrTools, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('32. Execute-only prompts ("ok, now run the clock") run existing code without rewriting files or triggering coding plans/Critic', async () => {
    for (const runPrompt of [
      'ok, now run the clock',
      'run clock.py',
      'start the app',
      'launch App.vue',
      'run the test suite',
    ]) {
      assert.strictEqual(classifyUserPrompt(runPrompt, 'code'), 'execute_task', `Expected execute_task for "${runPrompt}"`);
    }
    assert.strictEqual(classifyUserPrompt('how do I run clock.py?', 'code'), 'question');
    assert.strictEqual(classifyUserPrompt('Build an UI for the clock then run the clock', 'code'), 'coding_task');
    assert.strictEqual(classifyUserPrompt('Fix clock.py and run tests', 'code'), 'coding_task');

    const vscode = require('vscode');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-32-'));
    const origFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    try {
      const originalCode = 'print("CLOCK_RUNNING_OK")\n';
      fs.writeFileSync(path.join(tmpDir, 'clock.py'), originalCode, 'utf8');

      const { PermissionManager } = require('../extensions/localcoders-core/dist/security/permission-manager');
      const pm = new PermissionManager(tmpDir);
      pm.setMode('bypass');
      const toolManager = new ToolManager(undefined, pm);
      const registry = makeRegistry(makeMockContext(tmpDir));
      registry.setCriticConfig({ enabled: true, model: 'mock-critic', strictness: 'strict', reviewMode: 'changed_files' });

      let sawPlanning = false;
      let sawCritic = false;
      let sawWriteToolSchema = false;
      let sawOldPromptInRunContext = false;
      let turn = 0;

      const mockLlm = {
        getHost: () => 'http://localhost:11434',
        chatStream: async (params, onChunk) => {
          const sys = String(params.messages[0]?.content || '');
          const allText = params.messages.map((m) => String(m.content || '')).join('\n');
          if (/CRITICAL PLANNING INSTRUCTIONS/i.test(sys)) sawPlanning = true;
          if (/LocalCoders Critic Agent/i.test(sys)) sawCritic = true;
          if ((params.tools || []).some((t) => ['write_file', 'edit_file', 'delete_file'].includes(t?.function?.name))) {
            sawWriteToolSchema = true;
          }
          if (/Add timing feature/i.test(allText)) sawOldPromptInRunContext = true;

          turn++;
          if (turn === 1) {
            // Even if a local model tries hallucinating write_file alongside run_command, execute-only blocks the write!
            onChunk({
              content: '',
              toolCalls: [
                { function: { name: 'write_file', arguments: { path: 'clock.py', content: 'OVERWRITTEN' } } },
                { function: { name: 'run_command', arguments: { command: 'python3 clock.py' } } },
              ],
              done: true,
            });
          } else {
            onChunk({ content: 'Started clock.py cleanly (output: CLOCK_RUNNING_OK).', done: true });
          }
        },
      };

      const orchestrator = new AgentOrchestrator(mockLlm, registry, toolManager, tmpDir);
      const priorHistory = [
        { role: 'user', content: 'Add timing feature' },
        { role: 'assistant', content: '### Execution Complete\nAll tasks completed successfully.' },
      ];
      const task = await orchestrator.submitTask(
        'ok, now run the clock',
        {
          providerId: 'ollama',
          modelId: 'qwen2.5-coder:7b',
          modelName: 'qwen2.5-coder:7b',
          reasoningEffort: 'medium',
          fastMode: false,
          executionMode: 'code',
          permissionMode: 'bypass',
          enabledMcpServers: [],
          enabledSkills: [],
          activeRules: [],
          attachedFiles: [],
          projectContext: [],
        },
        priorHistory
      );

      assert.strictEqual(task.status, 'completed');
      assert.strictEqual(sawPlanning, false, 'Execute-only prompt must skip multi-step coding createPlan');
      assert.strictEqual(sawCritic, false, 'Execute-only run with 0 file edits must not trigger Critic loop');
      assert.strictEqual(sawWriteToolSchema, false, 'Write/edit tools must not be exposed in execute-only mode');
      assert.strictEqual(sawOldPromptInRunContext, false, 'Prior coding goal must not pollute execute-only run prompt');
      assert.strictEqual(
        fs.readFileSync(path.join(tmpDir, 'clock.py'), 'utf8'),
        originalCode,
        'Existing finished clock.py on disk must remain untouched'
      );
    } finally {
      vscode.workspace.workspaceFolders = origFolders;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('33. Agents modal renders per-subagent model dropdowns & instruction editors and orchestrator executes delegated tasks with subagent model + instructions', async () => {
    const modals = require('../extensions/localcoders-core/dist/views/agent-cockpit-modals');
    const modalScript = modals.getCockpitModalScript();
    new vm.Script(modalScript, { filename: 'cockpit_modals_33.js' });

    // Verify modal markup builders include subagent model selector & instruction textarea + Critic-parity options
    assert.ok(modalScript.includes('data-subagent-model='), 'Subagents render per-agent model dropdowns');
    assert.ok(modalScript.includes('data-subagent-prompt='), 'Subagents render editable instruction textareas');
    assert.ok(modalScript.includes('cmSubagentModelSelect'), 'Create Subagent renders model dropdown like Critic Agent');
    assert.ok(modalScript.includes('cmSubagentPrompt'), 'Create Subagent renders instruction textarea');
    assert.ok(modalScript.includes('Same as coding model'), 'Subagent dropdown matches Critic model inheritance option');
    assert.ok(modalScript.includes('cockpitUpdateSubagent'), 'Saves updated model and instructions per subagent');

    // Verify runtime execution routes delegated subagent task to configured model & system instructions
    const vscode = require('vscode');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ev-33-'));
    const origFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    try {
      const { PermissionManager } = require('../extensions/localcoders-core/dist/security/permission-manager');
      const pm = new PermissionManager(tmpDir);
      pm.setMode('bypass');
      const tm = new ToolManager(undefined, pm);
      const reg = makeRegistry(makeMockContext(tmpDir));
      reg.setCriticConfig({ enabled: false, model: '', strictness: 'strict', reviewMode: 'changed_files' });
      reg.updateSubagent('builtin_test', {
        model: 'custom-test-model:latest',
        systemPrompt: 'CUSTOM_SUBAGENT_DIRECTIVE: Use unittest with verbose docstrings.',
      });

      let sawSubagentModel = '';
      let sawSubagentSystem = '';
      const mockLlm = {
        getHost: () => 'http://localhost:11434',
        chatStream: async (params, onChunk) => {
          const sys = String(params.messages[0]?.content || '');
          const userAll = params.messages.map((m) => String(m.content || '')).join('\n');
          if (/CRITICAL PLANNING INSTRUCTIONS/i.test(sys)) {
            onChunk({
              content:
                '```json\n' +
                JSON.stringify({
                  tasks: [
                    {
                      id: 't1',
                      title: 'Write Unit Tests in test_app.py',
                      description: 'Write tests for app',
                      assignedTo: 'builtin_test',
                      dependencies: [],
                      affectedFiles: ['test_app.py'],
                    },
                  ],
                }) +
                '\n```',
              done: true,
            });
            return;
          }
          if (sys.includes('Test Engineer')) {
            sawSubagentModel = params.model;
            sawSubagentSystem = sys;
            const hasTool = params.messages.some((m) => m.role === 'tool' || userAll.includes('[Tool Result'));
            if (!hasTool) {
              onChunk({
                content: '',
                toolCalls: [{ function: { name: 'write_file', arguments: { path: 'test_app.py', content: 'import unittest\nclass T(unittest.TestCase):\n  def test_a(self): self.assertTrue(True)\n' } } }],
                done: true,
              });
              return;
            }
            onChunk({ content: 'Wrote test_app.py cleanly.', done: true });
            return;
          }
          onChunk({ content: 'Done.', done: true });
        },
      };

      const orchestrator = new AgentOrchestrator(mockLlm, reg, tm, tmpDir);
      const task = await orchestrator.submitTask('Add unit tests in test_app.py', {
        providerId: 'ollama',
        modelId: 'qwen2.5-coder:7b',
        modelName: 'qwen2.5-coder:7b',
        reasoningEffort: 'medium',
        fastMode: false,
        executionMode: 'code',
        permissionMode: 'bypass',
        enabledMcpServers: [],
        enabledSkills: [],
        activeRules: [],
        attachedFiles: [],
        projectContext: [],
      });

      assert.strictEqual(task.status, 'completed');
      assert.strictEqual(sawSubagentModel, 'custom-test-model:latest', 'Delegated subagent runs with its configured model');
      assert.match(sawSubagentSystem, /CUSTOM_SUBAGENT_DIRECTIVE/, 'Delegated subagent receives user-written instructions');
    } finally {
      vscode.workspace.workspaceFolders = origFolders;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
