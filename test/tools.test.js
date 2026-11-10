const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ToolManager } = require('../extensions/localcoders-core/dist/tools/tool-manager');

describe('ToolManager — Filesystem, Git, and Security Boundaries', () => {
  const toolManager = new ToolManager();
  const testWorkspace = path.join(__dirname, 'mock-workspace');

  // Setup mock workspace
  if (!fs.existsSync(testWorkspace)) {
    fs.mkdirSync(testWorkspace, { recursive: true });
  }

  const mockContext = {
    workspaceRoot: testWorkspace,
    agentId: 'test-agent',
    agentName: 'Test Agent',
    requireApproval: false,
    requestApproval: async () => true,
  };

  it('should expose all required tool definitions with schemas', () => {
    const defs = toolManager.getToolDefinitions();
    const names = defs.map(d => d.name);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('write_file'));
    assert.ok(names.includes('edit_file'));
    assert.ok(names.includes('delete_file'));
    assert.ok(names.includes('list_directory'));
    assert.ok(names.includes('search_codebase'));
    assert.ok(names.includes('search_symbols'));
    assert.ok(names.includes('read_git_diff'));
    assert.ok(names.includes('run_command'));
  });

  it('should write, read, and edit files within workspace', async () => {
    // 1. Write file
    const writeRes = await toolManager.executeTool('write_file', {
      path: 'sample.txt',
      content: 'Hello LocalCoders Multi-Agent Architecture\nLine 2',
    }, mockContext);
    assert.strictEqual(writeRes.success, true);

    // 2. Read file
    const readRes = await toolManager.executeTool('read_file', { path: 'sample.txt' }, mockContext);
    assert.strictEqual(readRes.success, true);
    assert.ok(readRes.output.content.includes('LocalCoders Multi-Agent'));

    // 3. Edit file
    const editRes = await toolManager.executeTool('edit_file', {
      path: 'sample.txt',
      target: 'Line 2',
      replacement: 'Modified Line 2 by Agent',
    }, mockContext);
    assert.strictEqual(editRes.success, true);

    const reRead = await toolManager.executeTool('read_file', { path: 'sample.txt' }, mockContext);
    assert.ok(reRead.output.content.includes('Modified Line 2 by Agent'));
  });

  it('should prevent path traversal outside the workspace boundary', async () => {
    const maliciousPaths = ['../../../../etc/passwd', '../outside.txt'];
    for (const p of maliciousPaths) {
      const res = await toolManager.executeTool('read_file', { path: p }, mockContext);
      assert.strictEqual(res.success, false);
      assert.ok(res.error.includes('Security Violation') || res.error.includes('outside the workspace'));
    }
  });

  it('should search codebase and return matching files and lines', async () => {
    const searchRes = await toolManager.executeTool('search_codebase', { query: 'Modified Line' }, mockContext);
    assert.strictEqual(searchRes.success, true);
    assert.ok(searchRes.output.count > 0);
    assert.strictEqual(searchRes.output.results[0].file, 'sample.txt');
  });

  it('should enforce user approval when approval is required', async () => {
    let approvalCalled = false;
    const approvalCtx = {
      ...mockContext,
      requireApproval: true,
      requestApproval: async (req) => {
        approvalCalled = true;
        assert.ok(req.description);
        return false; // User denies
      },
    };

    const res = await toolManager.executeTool('write_file', { path: 'denied.txt', content: 'text' }, approvalCtx);
    assert.strictEqual(approvalCalled, true);
    assert.strictEqual(res.success, false);
    assert.ok(res.error.includes('rejected'));
  });

  it('should handle workspace venv activation safely without Permission denied (126) and expose venv/bin on PATH', async () => {
    const os = require('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-venv-tool-'));
    try {
      const venvBin = path.join(tmpDir, 'venv', 'bin');
      fs.mkdirSync(venvBin, { recursive: true });
      // Simulate real venv/bin/activate (non-executable -rw-r--r--) and an executable helper inside venv/bin
      fs.writeFileSync(path.join(venvBin, 'activate'), '#!/bin/sh\nVIRTUAL_ENV=venv\n', { mode: 0o644 });
      fs.writeFileSync(path.join(venvBin, 'python'), '#!/bin/sh\necho VENV_PYTHON_OK\n', { mode: 0o755 });
      fs.writeFileSync(path.join(venvBin, 'mock-venv-cli'), '#!/bin/sh\necho VENV_PATH_ACTIVE\n', { mode: 0o755 });
      // Also create a separate non-executable non-venv script to verify OS exit 126 clarity
      fs.writeFileSync(path.join(tmpDir, 'noexec.sh'), '#!/bin/sh\necho hi\n', { mode: 0o644 });

      const ctx = { ...mockContext, workspaceRoot: tmpDir };

      // Calling ./venv/bin/activate or source venv/bin/activate should not fail with exit 126/127
      const actDirect = await toolManager.executeTool('run_command', { command: './venv/bin/activate' }, ctx);
      assert.strictEqual(actDirect.success, true);
      assert.match(actDirect.output.stdout, /automatically on PATH/i);

      const actSource = await toolManager.executeTool('run_command', { command: 'source venv/bin/activate' }, ctx);
      assert.strictEqual(actSource.success, true);

      // Commands inside venv/bin should resolve automatically via PATH
      const cliRes = await toolManager.executeTool('run_command', { command: 'mock-venv-cli' }, ctx);
      assert.strictEqual(cliRes.success, true);
      assert.match(cliRes.output.stdout, /VENV_PATH_ACTIVE/);

      // Compound `source venv/bin/activate && ...` works via /bin/bash
      const compoundRes = await toolManager.executeTool('run_command', { command: 'source venv/bin/activate && mock-venv-cli' }, ctx);
      assert.strictEqual(compoundRes.success, true);
      assert.match(compoundRes.output.stdout, /VENV_PATH_ACTIVE/);

      // Genuinely non-executable script clarifies OS +x error vs LocalCoders approval policy
      const osPermRes = await toolManager.executeTool('run_command', { command: './noexec.sh' }, ctx);
      assert.strictEqual(osPermRes.success, false);
      assert.match(osPermRes.error, /OS file execute permission denied/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should handle interactive stdin prompts without timing out and support run_command stdin + start_process/write_stdin', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-stdin-'));
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'ask_alarm.py'),
        'alarm = input("Enter alarm time (HH:MM:SS): ")\nprint(f"ALARM_SET={alarm}")\n',
        'utf8'
      );

      const bypassCtx = {
        workspaceRoot: tmpDir,
        agentId: 'main',
        agentName: 'Main Agent',
        requireApproval: false,
        requestApproval: async () => true,
      };

      // 1. Running interactive script WITHOUT stdin fails fast (<5s, no 45s timeout) with clear guidance
      const startMs = Date.now();
      const missingInputRes = await toolManager.executeTool('run_command', { command: 'python3 ask_alarm.py' }, bypassCtx);
      const elapsedMs = Date.now() - startMs;
      assert.strictEqual(missingInputRes.success, false);
      assert.ok(elapsedMs < 5000, `Expected fast fail on EOF, took ${elapsedMs}ms`);
      assert.strictEqual(missingInputRes.output.interactiveRequired, true);
      assert.match(missingInputRes.output.promptDetected || '', /Enter alarm time/i);
      assert.match(missingInputRes.error, /stdin/i);

      // 2. Passing stdin feeds interactive input cleanly
      const fedInputRes = await toolManager.executeTool(
        'run_command',
        { command: 'python3 ask_alarm.py', stdin: '07:30:00' },
        bypassCtx
      );
      assert.strictEqual(fedInputRes.success, true);
      assert.match(fedInputRes.output.stdout, /ALARM_SET=07:30:00/);

      // 3. Shell heredocs continue to work cleanly with EOF stdin closure
      const heredocRes = await toolManager.executeTool(
        'run_command',
        { command: "cat << 'EOF'\nheredoc_ok\nEOF" },
        bypassCtx
      );
      assert.strictEqual(heredocRes.success, true);
      assert.match(heredocRes.output.stdout, /heredoc_ok/);

      // 4. Interactive long-running background workflow: start_process -> write_stdin -> read_output -> terminate_process
      const procId = 'test_interactive_clock';
      const started = await toolManager.executeTool(
        'start_process',
        { processId: procId, command: 'python3 -u ask_alarm.py' },
        bypassCtx
      );
      assert.strictEqual(started.success, true);
      const written = await toolManager.executeTool(
        'write_stdin',
        { processId: procId, input: '08:15:00' },
        bypassCtx
      );
      assert.strictEqual(written.success, true);
      assert.match(written.output.recentOutput || '', /ALARM_SET=08:15:00/);
      await toolManager.executeTool('terminate_process', { processId: procId }, bypassCtx);

      // 5. ToolManager exposes stdin property & interactive process tools for run/UI/interactive tasks
      const scoped = toolManager.getToolDefinitions('Main Agent', {
        prompt: 'Build an UI for the clock then run the clock',
        affectedFiles: ['clock.py'],
      });
      const runDef = scoped.find((t) => t.name === 'run_command');
      assert.ok(runDef && runDef.parameters.properties.stdin, 'run_command schema includes stdin');
      assert.ok(scoped.some((t) => t.name === 'start_process'), 'interactive UI/run tasks include start_process');
      assert.ok(scoped.some((t) => t.name === 'write_stdin'), 'interactive UI/run tasks include write_stdin');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should handle CRLF target normalization and return line-numbered file excerpt on edit_file mismatch', async () => {
    const { PermissionManager } = require('../extensions/localcoders-core/dist/security/permission-manager');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-edit-hint-'));
    try {
      const pm = new PermissionManager(tmpDir);
      pm.setMode('bypass');
      const tm = new ToolManager(undefined, pm);
      const ctx = {
        workspaceRoot: tmpDir,
        agentId: 'main',
        agentName: 'Main Agent',
        requireApproval: false,
        requestApproval: async () => true,
      };
      await tm.executeTool('write_file', {
        path: 'clock.py',
        content: 'def show_time():\r\n    return "00:00"\r\n',
      }, ctx);

      // 1. Mismatched target includes actionable numbered file preview
      const miss = await tm.executeTool('edit_file', {
        path: 'clock.py',
        target: 'return "99:99"',
        replacement: 'return "12:00"',
      }, ctx);
      assert.strictEqual(miss.success, false);
      assert.match(miss.error, /1: def show_time\(\):/);
      assert.match(miss.error, /2:     return "00:00"/);

      // 2. LF target matches CRLF file seamlessly
      const hit = await tm.executeTool('edit_file', {
        path: 'clock.py',
        target: 'def show_time():\n    return "00:00"',
        replacement: 'def show_time():\n    return "12:00"',
      }, ctx);
      assert.strictEqual(hit.success, true);
      assert.match(fs.readFileSync(path.join(tmpDir, 'clock.py'), 'utf8'), /"12:00"/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
