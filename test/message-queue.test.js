const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { SessionManager } = require('../extensions/localcoders-core/dist/sessions/session-manager');
const {
  MessageQueueManager,
  handleQueueActionCommand,
  isQueueControlSlashCommand,
  isQueueableSlashCommand,
} = require('../extensions/localcoders-core/dist/sessions/message-queue');
const { ChangesManager } = require('../extensions/localcoders-core/dist/context/changes-manager');
const { PermissionManager } = require('../extensions/localcoders-core/dist/security/permission-manager');
const { ToolManager } = require('../extensions/localcoders-core/dist/tools/tool-manager');
const { AgentRegistry } = require('../extensions/localcoders-core/dist/agents/agent-registry');
const { AgentOrchestrator } = require('../extensions/localcoders-core/dist/agents/orchestrator');
const { OllamaClient } = require('../extensions/localcoders-core/dist/ollama/client');
const { ModelProviderRegistry } = require('../extensions/localcoders-core/dist/models/model-provider-registry');
const { runSlashCommandForWorkspace } = require('../extensions/localcoders-core/dist/commands');
const { AgentWorkspaceEditorPanel } = require('../extensions/localcoders-core/dist/views/agent-workspace-editor');
const { ChatViewProvider } = require('../extensions/localcoders-core/dist/views/chat-view');

function createMockContext(storageDir) {
  const globalData = new Map();
  const wsData = new Map();
  return {
    extensionUri: { fsPath: process.cwd() },
    globalStorageUri: { fsPath: storageDir || os.tmpdir() },
    globalState: {
      get(k, def) { return globalData.has(k) ? globalData.get(k) : def; },
      update(k, v) { globalData.set(k, v); return Promise.resolve(); },
    },
    workspaceState: {
      get(k, def) { return wsData.has(k) ? wsData.get(k) : def; },
      update(k, v) { wsData.set(k, v); return Promise.resolve(); },
    },
  };
}

function createQueueSandbox(html) {
  const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  const scriptCode = scriptMatches[scriptMatches.length - 1][1];
  const elements = new Map();
  const posted = [];
  const winListeners = {};
  const docListeners = {};

  function makeClassList() {
    const set = new Set();
    return {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return !!force;
      },
      contains: (c) => set.has(c),
    };
  }

  function makeNode(id) {
    const listeners = {};
    const attrs = {};
    let _innerHTML = '';
    const node = {
      id,
      value: '',
      title: '',
      checked: false,
      disabled: false,
      style: {},
      scrollHeight: 60,
      scrollTop: 0,
      clientHeight: 400,
      className: '',
      classList: makeClassList(),
      children: [],
      textContent: '',
      get innerHTML() { return _innerHTML; },
      set innerHTML(val) {
        _innerHTML = String(val || '');
        if (_innerHTML === '') node.children = [];
      },
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      appendChild: (c) => { node.children.push(c); return c; },
      focus: () => {},
      select: () => {},
      contains: () => false,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (ev, fn) => (listeners[ev] = listeners[ev] || []).push(fn),
      dispatch: (ev, payload = {}) => {
        for (const fn of (listeners[ev] || [])) fn({ target: node, stopPropagation() {}, preventDefault() {}, ...payload });
      },
    };
    return node;
  }

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Math,
    JSON,
    RegExp,
    Date,
    Promise,
    Error,
    acquireVsCodeApi: () => ({
      postMessage: (m) => posted.push(m),
      getState: () => ({}),
      setState: () => {},
    }),
    window: {
      addEventListener: (ev, fn) => (winListeners[ev] = winListeners[ev] || []).push(fn),
      getSelection: () => '',
      innerWidth: 1280,
      innerHeight: 820,
    },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeNode(id));
        return elements.get(id);
      },
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: (tag) => makeNode('_' + tag),
      addEventListener: (ev, fn) => (docListeners[ev] = docListeners[ev] || []).push(fn),
    },
  };

  vm.runInNewContext(scriptCode, sandbox);
  return {
    sandbox,
    elements,
    posted,
    sendMessageToWebview: (data) => {
      (winListeners.message || []).forEach((fn) => fn({ data }));
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Multi-Message Agent Queue System — Engine, Persistence, Recovery, Commands & UI', () => {
  it('1-2. Handles 20+ queued submissions in strict FIFO order, single-task concurrency, starting-race, capacity, and double-click dedupe', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mq-fifo-'));
    try {
      const ctx = createMockContext(tmpDir);
      const sm = new SessionManager(ctx, tmpDir);
      const sess = sm.createSession('Queue Test', 'ollama/qwen3:8b');

      const gates = new Map();
      const executionOrder = [];
      let concurrent = 0;
      let maxConcurrent = 0;

      const qm = new MessageQueueManager({
        sessionManager: sm,
        doubleClickWindowMs: 300,
        executor: async (item) => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          executionOrder.push(item.content);
          const gate = gates.get(item.content);
          if (gate) await gate.promise;
          concurrent--;
          return { ok: true };
        },
      });

      // Start Task A asynchronously (held open by gate so while it's starting/running we flood 20 messages!)
      gates.set('Task A', deferred());
      const startRes = await qm.submitMessage({ sessionId: sess.id, content: 'Task A' });
      assert.strictEqual(startRes.ok, true);
      assert.strictEqual(startRes.mode, 'started');

      // Double-click duplicate of identical message with dedupeDoubleClick=true should be prevented cleanly
      const gDup = await qm.submitMessage({
        sessionId: sess.id,
        content: 'Task 1: Build logo',
        dedupeDoubleClick: true,
        clientSubmissionId: 'btn_1',
      });
      const gDup2 = await qm.submitMessage({
        sessionId: sess.id,
        content: 'Task 1: Build logo',
        dedupeDoubleClick: true,
        clientSubmissionId: 'btn_1',
      });
      assert.strictEqual(gDup.mode, 'queued');
      assert.strictEqual(gDup2.mode, 'deduplicated');
      assert.strictEqual(qm.getSnapshot(sess.id).queuedCount, 1);

      // Submit 19 more messages (20 total queued!) while Task A is still running
      for (let i = 2; i <= 20; i++) {
        const res = await qm.submitMessage({
          sessionId: sess.id,
          content: `Task ${i}: Step ${i}`,
          clientSubmissionId: `c_${i}`,
        });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.mode, 'queued');
      }

      const midSnap = qm.getSnapshot(sess.id);
      assert.strictEqual(midSnap.queuedCount, 20);
      assert.strictEqual(midSnap.state, 'running');
      assert.strictEqual(midSnap.items[1].position, 0);
      assert.strictEqual(midSnap.items[20].position, 19);

      // Verify capacity guard gives clear feedback instead of silently dropping
      qm.setCapacity(21); // currently 1 processing + 20 queued = 21 backlog
      const overCap = await qm.submitMessage({ sessionId: sess.id, content: 'Overflow task' });
      assert.strictEqual(overCap.ok, false);
      assert.match(overCap.error, /capacity limit \(21\) reached/i);

      // Finish Task A -> all 20 queued messages process sequentially in exact FIFO order!
      gates.get('Task A').resolve();
      await qm.waitForQueueIdle(sess.id);

      assert.strictEqual(maxConcurrent, 1, 'Never run > 1 task concurrently in the same session');
      assert.strictEqual(executionOrder.length, 21);
      assert.strictEqual(executionOrder[0], 'Task A');
      assert.strictEqual(executionOrder[1], 'Task 1: Build logo');
      assert.strictEqual(executionOrder[20], 'Task 20: Step 20');

      const finalSnap = qm.getSnapshot(sess.id);
      assert.strictEqual(finalSnap.queuedCount, 0);
      assert.strictEqual(finalSnap.state, 'completed');
      assert.strictEqual(finalSnap.completedCount, 21);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('3. Fresh workspace & conversation context + model switch apply cleanly per queued message', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mq-freshctx-'));
    try {
      const ctx = createMockContext(tmpDir);
      const sm = new SessionManager(ctx, tmpDir);
      const cm = new ChangesManager(tmpDir);
      const sess = sm.createSession('Branding Flow', 'ollama/qwen2.5-coder:7b');

      const firstStarted = deferred();
      const firstGate = deferred();
      const observedRuns = [];

      const qm = new MessageQueueManager({
        sessionManager: sm,
        changesManager: cm,
        executor: async (item, execCtx) => {
          observedRuns.push({
            content: item.content,
            modelId: execCtx.effectiveConfig.modelId,
            attachedFiles: execCtx.effectiveConfig.attachedFiles,
            freshPrompt: execCtx.freshPrompt,
            historyLen: execCtx.history.length,
            sawLogoOnDisk: fs.existsSync(path.join(tmpDir, 'logo.svg')),
          });
          if (item.content === 'Create logo.svg') {
            firstStarted.resolve();
            await firstGate.promise;
            fs.writeFileSync(path.join(tmpDir, 'logo.svg'), '<svg id="aura"/>');
            sm.updateSession(sess.id, (s) => {
              s.messages.push({
                id: 'ast_1',
                senderId: 'main',
                senderName: 'Main Agent',
                senderRole: 'assistant',
                content: 'Created logo.svg with AURA LC design.',
                timestamp: Date.now(),
              });
            });
          }
          return { ok: true };
        },
      });

      await qm.submitMessage({
        sessionId: sess.id,
        content: 'Create logo.svg',
        attachments: ['docs/brand.md'],
      });
      await qm.submitMessage({
        sessionId: sess.id,
        content: 'Update desktop icon using @logo.svg',
        attachments: ['branding/desktop.png'],
      });

      // Wait until Task 1 has started executing, then switch active model between Task 1 and Task 2
      await firstStarted.promise;
      sm.updateActiveConfig((cfg) => {
        cfg.modelId = 'ollama/qwen3:14b';
        cfg.modelName = 'qwen3:14b';
      });

      firstGate.resolve();
      await qm.waitForQueueIdle(sess.id);

      assert.strictEqual(observedRuns.length, 2);
      assert.strictEqual(observedRuns[0].modelId, 'ollama/qwen2.5-coder:7b');
      assert.strictEqual(observedRuns[0].sawLogoOnDisk, false);
      assert.ok(observedRuns[0].attachedFiles.includes('docs/brand.md'));

      // Task 2 MUST see logo.svg created by Task 1, assistant history from Task 1, switched model, and its own attachments!
      assert.strictEqual(observedRuns[1].sawLogoOnDisk, true);
      assert.strictEqual(observedRuns[1].modelId, 'ollama/qwen3:14b');
      assert.match(observedRuns[1].freshPrompt, /logo\.svg/);
      assert.ok(observedRuns[1].historyLen >= 2);
      assert.ok(observedRuns[1].attachedFiles.includes('branding/desktop.png'));
      assert.ok(observedRuns[1].attachedFiles.includes('logo.svg'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('4. Edit, Delete, Reorder, Send Now (no-interrupt by default), and processing lock behave accurately', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mq-ops-'));
    try {
      const ctx = createMockContext(tmpDir);
      const sm = new SessionManager(ctx, tmpDir);
      const sess = sm.createSession('Edit Ops', 'ollama/qwen3:8b');
      const gA = deferred();
      const ran = [];

      const qm = new MessageQueueManager({
        sessionManager: sm,
        executor: async (item) => {
          ran.push(item.content);
          if (item.content === 'Active') await gA.promise;
          return { ok: true };
        },
      });

      const rA = await qm.submitMessage({ sessionId: sess.id, content: 'Active' });
      const r1 = await qm.submitMessage({ sessionId: sess.id, content: 'One' });
      const r2 = await qm.submitMessage({ sessionId: sess.id, content: 'Two' });
      const r3 = await qm.submitMessage({ sessionId: sess.id, content: 'Three @src/a.ts' });

      // Processing item cannot be edited or deleted
      const blockedEdit = qm.editQueuedMessage(sess.id, rA.item.id, 'Mutated');
      assert.strictEqual(blockedEdit.ok, false);
      assert.match(blockedEdit.error, /already processing/i);
      const blockedDel = qm.deleteQueuedMessage(sess.id, rA.item.id);
      assert.strictEqual(blockedDel.ok, false);
      assert.match(blockedDel.error, /currently executing/i);

      // Edit r3 preserves ID and position, updates content + mentions
      const edited = qm.editQueuedMessage(sess.id, r3.item.id, 'Three Edited @src/b.ts');
      assert.strictEqual(edited.ok, true);
      assert.strictEqual(edited.item.id, r3.item.id);
      assert.strictEqual(edited.item.position, r3.item.position);
      assert.deepStrictEqual(edited.item.mentions, ['src/b.ts']);

      // Reorder: Move Two up before One
      const movedUp = qm.moveQueuedMessage(sess.id, r2.item.id, 'up');
      assert.strictEqual(movedUp.ok, true);
      let qOnly = qm.getSnapshot(sess.id).items.filter((i) => i.status === 'queued');
      assert.deepStrictEqual(qOnly.map((i) => i.content), ['Two', 'One', 'Three Edited @src/b.ts']);

      // Send Now on r3 while Active runs -> moves to front WITHOUT interrupting Active!
      const prioritized = await qm.sendNow(sess.id, r3.item.id);
      assert.strictEqual(prioritized.ok, true);
      assert.match(prioritized.message, /without interrupting/i);
      qOnly = qm.getSnapshot(sess.id).items.filter((i) => i.status === 'queued');
      assert.deepStrictEqual(qOnly.map((i) => i.content), ['Three Edited @src/b.ts', 'Two', 'One']);

      // Add a completed assistant message then delete 'One' -> conversation history stays intact!
      sm.updateSession(sess.id, (s) => {
        s.messages.push({ id: 'hist_1', senderId: 'main', senderName: 'Main Agent', senderRole: 'assistant', content: 'Completed history stays', timestamp: Date.now() });
      });
      const delOne = qm.deleteQueuedMessage(sess.id, r1.item.id);
      assert.strictEqual(delOne.ok, true);
      assert.ok(sm.getSession(sess.id).messages.some((m) => m.id === 'hist_1'));

      gA.resolve();
      await qm.waitForQueueIdle(sess.id);
      assert.deepStrictEqual(ran, ['Active', 'Three Edited @src/b.ts', 'Two']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('5-6. Pause/Resume, Failure Pause -> Edit -> Retry, and Skip remaining work cleanly', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mq-fail-'));
    try {
      const ctx = createMockContext(tmpDir);
      const sm = new SessionManager(ctx, tmpDir);
      const sess = sm.createSession('Failure Flow', 'ollama/qwen3:8b');

      let failSecond = true;
      const g1 = deferred();
      const executed = [];

      const qm = new MessageQueueManager({
        sessionManager: sm,
        executor: async (item) => {
          executed.push(item.content);
          if (item.content === 'First') {
            await g1.promise;
            return { ok: true };
          }
          if (item.content.startsWith('Broken') && failSecond) {
            return { ok: false, error: 'Simulated compilation error on line 12' };
          }
          return { ok: true };
        },
      });

      await qm.submitMessage({ sessionId: sess.id, content: 'First' });
      const bItem = await qm.submitMessage({ sessionId: sess.id, content: 'Broken step' });
      const tItem = await qm.submitMessage({ sessionId: sess.id, content: 'Third step' });
      const fItem = await qm.submitMessage({ sessionId: sess.id, content: 'Fourth step' });

      // Pause before First finishes
      const pRes = qm.pauseQueue(sess.id);
      assert.strictEqual(pRes.ok, true);
      g1.resolve();
      await qm.waitForQueueIdle(sess.id);
      assert.deepStrictEqual(executed, ['First']);
      assert.strictEqual(qm.getSnapshot(sess.id).state, 'paused');

      // Resume -> Broken fails -> preserves content & error, marks state=failed, leaves Third/Fourth queued
      qm.resumeQueue(sess.id);
      await qm.waitForQueueIdle(sess.id);
      const failSnap = qm.getSnapshot(sess.id);
      assert.strictEqual(failSnap.state, 'failed');
      assert.strictEqual(failSnap.paused, true);
      const failedRec = failSnap.items.find((i) => i.id === bItem.item.id);
      assert.strictEqual(failedRec.status, 'failed');
      assert.match(failedRec.error, /Simulated compilation error/);
      assert.strictEqual(failSnap.queuedCount, 2);

      // Skip Fourth step first (testing skip on queued item), edit Broken -> fix & Retry Broken -> Third runs too!
      const skipFourth = qm.skipQueuedMessage(sess.id, fItem.item.id);
      assert.strictEqual(skipFourth.ok, true);

      failSecond = false;
      qm.editQueuedMessage(sess.id, bItem.item.id, 'Broken step fixed');
      const retryRes = qm.retryQueuedMessage(sess.id, bItem.item.id);
      assert.strictEqual(retryRes.ok, true);
      await qm.waitForQueueIdle(sess.id);

      assert.deepStrictEqual(executed, ['First', 'Broken step', 'Broken step fixed', 'Third step']);
      assert.strictEqual(qm.getSnapshot(sess.id).queuedCount, 0);
      assert.strictEqual(qm.getSnapshot(sess.id).state, 'completed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('7. Queue persistence, restart restoration, interrupted task detection & idempotency prevent duplicates', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mq-persist-'));
    try {
      const ctx1 = createMockContext(tmpDir);
      const sm1 = new SessionManager(ctx1, tmpDir);
      const sess = sm1.createSession('Restart Test', 'ollama/qwen3:8b');

      const blocker = deferred();
      let runCount = 0;
      const qm1 = new MessageQueueManager({
        sessionManager: sm1,
        executor: async (item) => {
          runCount++;
          if (item.content === 'Step 1') return { ok: true };
          await blocker.promise;
          return { ok: true };
        },
      });

      await qm1.submitMessage({ sessionId: sess.id, content: 'Step 1' });
      await new Promise((r) => setTimeout(r, 20));
      await qm1.submitMessage({ sessionId: sess.id, content: 'Step 2 (mid-flight crash)' });
      await qm1.submitMessage({ sessionId: sess.id, content: 'Step 3', attachments: ['foo.ts'] });
      await new Promise((r) => setTimeout(r, 20));
      // Simulate closing app mid-flight while Step 2 was 'processing' and Step 3 was 'queued'
      const savedBeforeCrash = sm1.getSession(sess.id).queueState;
      assert.strictEqual(savedBeforeCrash.items.some((i) => i.status === 'completed' && i.content === 'Step 1'), true);
      assert.strictEqual(savedBeforeCrash.items.some((i) => i.status === 'processing' && i.content === 'Step 2 (mid-flight crash)'), true);

      // Reopen fresh SessionManager & MessageQueueManager reading from disk
      const ctx2 = createMockContext(tmpDir);
      ctx2.workspaceState.update('localcoders.activeSessionId', sess.id);
      const sm2 = new SessionManager(ctx2, tmpDir);
      const resumedExec = [];
      const qm2 = new MessageQueueManager({
        sessionManager: sm2,
        executor: async (item) => {
          resumedExec.push(item.content);
          return { ok: true };
        },
      });

      const restoredSnap = qm2.getSnapshot(sess.id);
      assert.strictEqual(restoredSnap.paused, true, 'Interrupted session restores safely paused');
      assert.match(restoredSnap.lastError || '', /interrupted/i);
      assert.deepStrictEqual(
        restoredSnap.items.filter((i) => i.status === 'queued').map((i) => i.content),
        ['Step 2 (mid-flight crash)', 'Step 3']
      );
      assert.strictEqual(restoredSnap.items[0].interruptedOnRestart, true);
      assert.strictEqual(restoredSnap.items[1].attachments[0].path, 'foo.ts');

      // Resuming executes ONLY remaining uncompleted steps in order — Step 1 never re-runs!
      qm2.resumeQueue(sess.id);
      await qm2.waitForQueueIdle(sess.id);
      assert.deepStrictEqual(resumedExec, ['Step 2 (mid-flight crash)', 'Step 3']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('8. Session isolation & active task cancellation pause only target session without cross-session leakage', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mq-iso-'));
    try {
      const ctx = createMockContext(tmpDir);
      const sm = new SessionManager(ctx, tmpDir);
      const s1 = sm.createSession('Session One', 'ollama/qwen3:8b');
      const s2 = sm.createSession('Session Two', 'ollama/qwen3:8b');

      const gS1 = deferred();
      const s1Runs = [];
      const s2Runs = [];

      const qm = new MessageQueueManager({
        sessionManager: sm,
        executor: async (item, execCtx) => {
          if (execCtx.sessionId === s1.id) {
            s1Runs.push(item.content);
            if (item.content === 'S1 Active') await gS1.promise;
          } else {
            s2Runs.push(item.content);
          }
          return { ok: true };
        },
      });

      await qm.submitMessage({ sessionId: s1.id, content: 'S1 Active' });
      await qm.submitMessage({ sessionId: s1.id, content: 'S1 Queued Followup' });
      await qm.submitMessage({ sessionId: s2.id, content: 'S2 Immediate' });
      await qm.waitForQueueIdle(s2.id);

      assert.deepStrictEqual(s2Runs, ['S2 Immediate']);
      assert.strictEqual(qm.getSnapshot(s1.id).queuedCount, 1);
      assert.strictEqual(qm.getSnapshot(s2.id).queuedCount, 0);

      // Cancel active task in S1 -> pauses S1 queue safely & preserves S1 Queued Followup without affecting S2
      qm.cancelActiveTask(s1.id);
      gS1.resolve();
      await qm.waitForQueueIdle(s1.id);
      assert.strictEqual(qm.getSnapshot(s1.id).paused, true);
      assert.strictEqual(qm.getSnapshot(s1.id).queuedCount, 1);
      assert.deepStrictEqual(s1Runs, ['S1 Active']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('9. Real orchestrator integration: provider/model unavailability fails gracefully & slash commands (/queue + queued /test) execute without LLM', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mq-slash-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
        name: 'mq-slash-proj',
        scripts: { test: 'node -e "console.log(\'QUEUE_SLASH_TEST_OK\')"' },
      }));

      const ctx = createMockContext(tmpDir);
      const sm = new SessionManager(ctx, tmpDir);
      const sess = sm.createSession('Slash & Orches', '');
      const pm = new PermissionManager(tmpDir);
      pm.setMode('bypass');
      const cm = new ChangesManager(tmpDir);
      const tm = new ToolManager(undefined, pm);
      const reg = new AgentRegistry(ctx);
      reg.setMainAgent({ id: 'main', name: 'Main Agent', role: 'Lead', model: '', systemPrompt: 's', enabled: true, maxConcurrency: 1, temperature: 0.2, contextWindow: 8192 });
      const ollama = new OllamaClient('http://127.0.0.1:19999'); // disconnected -> model unavailable
      const mr = ModelProviderRegistry.initialize(ollama, ctx.globalState, {
        async get() { return undefined; }, async store() {}, async delete() {},
      });
      const orch = new AgentOrchestrator(ollama, reg, tm, tmpDir, mr);
      const qm = new MessageQueueManager({
        sessionManager: sm,
        orchestrator: orch,
        modelRegistry: mr,
        changesManager: cm,
        permissionManager: pm,
        toolManager: tm,
        registry: reg,
        ollama,
      });

      // Pause, queue `/test` and verify /queue status + /queue clear confirmation policy (even in bypass mode!)
      qm.pauseQueue(sess.id);
      assert.strictEqual(isQueueControlSlashCommand('/queue pause'), true);
      assert.strictEqual(isQueueableSlashCommand('/test'), true);

      await qm.submitMessage({ sessionId: sess.id, content: '/test', kind: 'slash_command' });
      const listRes = await runSlashCommandForWorkspace({
        rawInput: '/queue',
        workspaceRoot: tmpDir,
        viewMode: 'agent',
        orchestrator: orch,
        sessionManager: sm,
        modelRegistry: mr,
        permissionManager: pm,
        changesManager: cm,
        toolManager: tm,
        queueManager: qm,
      });
      assert.strictEqual(listRes.ok, true);
      assert.match(listRes.codeBlock.content, /\/test/);

      // /queue clear requires confirmation even in bypass mode
      const clearUnconfirmed = await runSlashCommandForWorkspace({
        rawInput: '/queue clear',
        confirmed: false,
        workspaceRoot: tmpDir,
        viewMode: 'agent',
        orchestrator: orch,
        sessionManager: sm,
        modelRegistry: mr,
        permissionManager: pm,
        changesManager: cm,
        toolManager: tm,
        queueManager: qm,
      });
      assert.strictEqual(clearUnconfirmed.status, 'confirmation_required');

      // Resume -> `/test` runs directly in workspace (NOT sent to LLM!) and succeeds even with offline Ollama
      qm.resumeQueue(sess.id);
      await qm.waitForQueueIdle(sess.id);
      assert.strictEqual(qm.getSnapshot(sess.id).completedCount, 1);

      // Submit a normal LLM prompt with unavailable provider/model -> fails cleanly & preserves item with real error
      await qm.submitMessage({ sessionId: sess.id, content: 'Fix app logic' });
      await qm.waitForQueueIdle(sess.id);
      const errSnap = qm.getSnapshot(sess.id);
      assert.strictEqual(errSnap.state, 'failed');
      assert.strictEqual(errSnap.failedCount, 1);
      assert.match(errSnap.items[0].error || '', /No AI model|unavailable|Select an installed Ollama model/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('10. Agent View & IDE Chat View keep composer unlocked while working, synchronize shared queue UI, and dispatch controls', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mq-ui-'));
    try {
      const ctx = createMockContext(tmpDir);
      const sm = new SessionManager(ctx, tmpDir);
      const s1 = sm.createSession('UI Queue Session', 'ollama/qwen3:8b');
      const gate = deferred();
      const qm = new MessageQueueManager({
        sessionManager: sm,
        executor: async () => {
          await gate.promise;
          return { ok: true };
        },
      });

      await qm.submitMessage({ sessionId: s1.id, content: 'Initial task' });
      await qm.submitMessage({ sessionId: s1.id, content: 'Queued one' });
      await qm.submitMessage({ sessionId: s1.id, content: 'Queued two' });
      const snap = qm.getSnapshot(s1.id);

      // 1. Verify Agent View HTML + script keep composer unlocked and render Queue UI (zero emojis)
      const agentHtml = AgentWorkspaceEditorPanel.prototype._getHtmlForWebview.call({ _panel: { webview: { cspSource: 'vscode-webview:' } } });
      const agentDom = createQueueSandbox(agentHtml);
      agentDom.sendMessageToWebview({
        type: 'loadSession',
        session: sm.getSession(s1.id),
        allSessions: sm.getAllSessions(),
        allModels: [],
        modelsGrouped: { local: [], cloud: [], providers: [] },
        currentConfig: sm.getSession(s1.id).config,
        permissionMode: 'smart',
        slashCommands: [],
        queueSnapshot: snap,
      });

      const agentSendBtn = agentDom.elements.get('btnSend');
      assert.strictEqual(agentSendBtn.style.display, 'flex', 'Send button remains visible while agent works');
      assert.strictEqual(agentSendBtn.disabled, false);

      // Submit additional messages while isWorking === true!
      const agentInput = agentDom.elements.get('promptInput');
      agentInput.value = 'Queued three from composer';
      agentSendBtn.dispatch('click', {});
      agentInput.value = 'Queued four from composer';
      agentSendBtn.dispatch('click', {});
      const sentMsgs = agentDom.posted.filter((m) => m.command === 'sendMessage');
      assert.strictEqual(sentMsgs.length, 2);

      // Verify Queue UI hides completely when queue count = 0 (both idle & single active task) and shows when queued/paused/failed
      const queueDockEl = agentDom.elements.get('lcQueueDock');
      assert.strictEqual(queueDockEl.style.display, 'flex', 'Queue dock visible when queuedCount > 0');
      assert.strictEqual(agentDom.elements.get('lcQueueTitle').textContent, 'Queued Messages (2)');
      assert.strictEqual(agentDom.elements.get('lcQueueStateBadge').textContent, 'Running');
      assert.strictEqual(agentDom.elements.get('lcQueueList').children.length, 3); // 1 processing + 2 queued

      agentDom.sendMessageToWebview({
        type: 'queueUpdated',
        snapshot: { sessionId: s1.id, state: 'running', paused: false, activeItemId: 'x', isBusy: true, capacity: 200, queuedCount: 0, failedCount: 0, completedCount: 0, lastError: '', items: [{ id: 'x', sessionId: s1.id, content: 'Single active prompt', status: 'processing', createdAt: Date.now(), position: 0 }] },
      });
      assert.strictEqual(queueDockEl.style.display, 'none', 'Queue dock stays hidden when queuedCount = 0 and not paused/failed');

      agentDom.sendMessageToWebview({
        type: 'queueUpdated',
        snapshot: { sessionId: s1.id, state: 'paused', paused: true, activeItemId: null, isBusy: false, capacity: 200, queuedCount: 0, failedCount: 0, completedCount: 0, lastError: '', items: [] },
      });
      assert.strictEqual(queueDockEl.style.display, 'flex', 'Queue dock remains accessible when explicitly paused');

      // Restore queued=2 snapshot for pause click check
      agentDom.sendMessageToWebview({ type: 'queueUpdated', snapshot: snap });
      agentDom.elements.get('btnQueuePauseResume').dispatch('click', {});
      assert.ok(agentDom.posted.some((m) => m.command === 'queueAction' && m.action === 'pause'));

      // 2. Verify IDE Chat View shares the exact same Queue UI & keeps composer unlocked too!
      const chatHtml = ChatViewProvider.prototype._getHtmlForWebview.call({ _extensionUri: { fsPath: process.cwd() } });
      const chatDom = createQueueSandbox(chatHtml);
      chatDom.sendMessageToWebview({
        type: 'loadSession',
        session: sm.getSession(s1.id),
        allSessions: sm.getAllSessions(),
        allModels: [],
        modelsGrouped: { local: [], cloud: [], providers: [] },
        currentConfig: sm.getSession(s1.id).config,
        permissionMode: 'smart',
        slashCommands: [],
        queueSnapshot: snap,
      });

      const chatSendBtn = chatDom.elements.get('btn-send');
      assert.strictEqual(chatSendBtn.style.display, 'flex', 'ChatView Send button stays available while running');
      const chatInput = chatDom.elements.get('prompt-input');
      chatInput.value = 'Queued from IDE View';
      chatSendBtn.dispatch('click', {});
      assert.ok(chatDom.posted.some((m) => m.command === 'sendMessage' && m.text === 'Queued from IDE View'));
      assert.strictEqual(chatDom.elements.get('lcQueueTitle').textContent, 'Queued Messages (2)');

      // Verify Stop button in Agent View updates UI immediately & posts stopTask, and Processing card renders stopActive button
      const processingCardHtml = agentDom.elements.get('lcQueueList').children[0]?.innerHTML || '';
      assert.ok(processingCardHtml.includes('data-q-act="stopActive"'), 'Processing row exposes active stopActive button');

      agentDom.elements.get('btnStop').dispatch('click', {});
      assert.strictEqual(agentDom.elements.get('btnStop').style.display, 'none', 'Stop button clears running UI immediately on click');
      assert.strictEqual(agentDom.elements.get('topStatusBadge').textContent, 'Ready');
      assert.ok(agentDom.posted.some((m) => m.command === 'stopTask'));

      // Verify backend shared handleQueueActionCommand works cleanly across pause and stopActive
      const actionRes = await handleQueueActionCommand(qm, s1.id, { action: 'pause' });
      assert.strictEqual(actionRes.ok, true);
      assert.strictEqual(actionRes.snapshot.paused, true);

      const stopRes = await handleQueueActionCommand(qm, s1.id, { action: 'stopActive' });
      assert.strictEqual(stopRes.ok, true);
      assert.strictEqual(stopRes.snapshot.isBusy, false, 'Snapshot immediately reflects stopped state before unwind completes');
      assert.notStrictEqual(stopRes.snapshot.state, 'running');
      assert.strictEqual(stopRes.snapshot.paused, true, 'Paused remains true because queued follow-ups remain');

      gate.resolve();
      await qm.waitForQueueIdle(s1.id);

      // Verify stopping a standalone prompt (0 remaining queued items) clears paused state cleanly
      const g2 = deferred();
      const s2 = sm.createSession('Standalone Cancel Session', 'ollama/qwen3:8b');
      const qmSingle = new MessageQueueManager({
        sessionManager: sm,
        executor: async (_item, execCtx) => {
          await new Promise((_, rej) => {
            execCtx.abortSignal.addEventListener('abort', () => rej(new Error('Task aborted')));
          });
          return { ok: true };
        },
      });
      await qmSingle.submitMessage({ sessionId: s2.id, content: 'Long task' });
      const singleStop = await handleQueueActionCommand(qmSingle, s2.id, { action: 'stopActive' });
      assert.strictEqual(singleStop.snapshot.isBusy, false);
      assert.strictEqual(singleStop.snapshot.paused, false, 'Do not trap standalone session in hidden paused queue when queue = 0');
      await qmSingle.waitForQueueIdle(s2.id);
      g2.resolve();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('11. Clicking Resume after a task failure retries the failed task and clears empty failed/paused state on delete/skip', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mq-resume-fail-'));
    try {
      const ctx = createMockContext(tmpDir);
      const sm = new SessionManager(ctx, tmpDir);
      const s1 = sm.createSession('Resume Failed Flow', 'ollama/qwen3:8b');

      let attempts = 0;
      const runs = [];
      const qm = new MessageQueueManager({
        sessionManager: sm,
        executor: async (item) => {
          attempts++;
          runs.push(`${item.content}#${attempts}`);
          if (item.content === 'Fix clock 12h' && attempts === 1) {
            return { ok: false, error: 'Critic Agent blocked completion after 7 review cycle(s)' };
          }
          return { ok: true };
        },
      });

      // Submit standalone prompt that fails with 0 remaining queued items
      await qm.submitMessage({ sessionId: s1.id, content: 'Fix clock 12h' });
      await qm.waitForQueueIdle(s1.id);
      const failedSnap = qm.getSnapshot(s1.id);
      assert.strictEqual(failedSnap.state, 'failed');
      assert.strictEqual(failedSnap.paused, true);
      assert.strictEqual(failedSnap.queuedCount, 0);
      assert.strictEqual(failedSnap.failedCount, 1);

      // Clicking Resume via shared queueAction must retry the failed task and complete!
      const resumeRes = await handleQueueActionCommand(qm, s1.id, { action: 'resume' });
      assert.strictEqual(resumeRes.ok, true);
      await qm.waitForQueueIdle(s1.id);
      assert.deepStrictEqual(runs, ['Fix clock 12h#1', 'Fix clock 12h#2']);
      const doneSnap = qm.getSnapshot(s1.id);
      assert.strictEqual(doneSnap.state, 'completed');
      assert.strictEqual(doneSnap.paused, false);
      assert.strictEqual(doneSnap.failedCount, 0);
      assert.strictEqual(doneSnap.lastError, undefined);

      // Verify UI shows Resume (not Pause) and dispatches 'resume' when failedCount > 0 even if paused is false
      const agentHtml = AgentWorkspaceEditorPanel.prototype._getHtmlForWebview.call({ _panel: { webview: { cspSource: 'vscode-webview:' } } });
      const agentDom = createQueueSandbox(agentHtml);
      agentDom.sendMessageToWebview({
        type: 'queueUpdated',
        snapshot: {
          sessionId: s1.id,
          state: 'failed',
          paused: false,
          activeItemId: null,
          activeExecutionId: null,
          isBusy: false,
          capacity: 200,
          queuedCount: 0,
          failedCount: 1,
          completedCount: 0,
          lastError: 'Critic Agent blocked completion',
          items: [{ id: 'f1', content: 'Retry me', status: 'failed', error: 'Blocked', position: 0, createdAt: Date.now(), attachments: [] }],
        },
      });
      const pauseResumeBtn = agentDom.elements.get('btnQueuePauseResume');
      assert.ok(pauseResumeBtn.innerHTML.includes('Resume'), 'Header button shows Resume when a failed item can be resumed');
      assert.ok(agentDom.elements.get('lcQueueBanner').innerHTML.includes('btnBannerResume'), 'Error banner exposes Resume button cleanly');
      pauseResumeBtn.dispatch('click', {});
      assert.ok(
        agentDom.posted.some((m) => m.command === 'queueAction' && m.action === 'resume'),
        'Clicking header button in failed state dispatches resume action'
      );

      // Verify deleting the sole failed item unpauses and returns to idle cleanly
      const s2 = sm.createSession('Delete Failed Item', 'ollama/qwen3:8b');
      const qm2 = new MessageQueueManager({
        sessionManager: sm,
        executor: async () => ({ ok: false, error: 'Simulated failure' }),
      });
      const sub2 = await qm2.submitMessage({ sessionId: s2.id, content: 'Broken' });
      await qm2.waitForQueueIdle(s2.id);
      assert.strictEqual(qm2.getSnapshot(s2.id).paused, true);
      const delRes = qm2.deleteQueuedMessage(s2.id, sub2.item.id);
      assert.strictEqual(delRes.snapshot.failedCount, 0);
      assert.strictEqual(delRes.snapshot.paused, false);
      assert.strictEqual(delRes.snapshot.state, 'idle');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
