const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
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
});
