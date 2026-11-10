const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChangesManager } = require('../extensions/localcoders-core/dist/context/changes-manager');
const { writeFileTool, editFileTool } = require('../extensions/localcoders-core/dist/tools/fs-tools');
const { OperationHistoryManager } = require('../extensions/localcoders-core/dist/commands/operation-history');

const mockWorkspace = path.resolve(__dirname, 'mock-workspace');

describe('ChangesManager — Git Diff & Working Tree Inspection', () => {
  it('should initialize and produce structured changes summary', async () => {
    const cm = new ChangesManager(mockWorkspace);
    const summary = await cm.getSummary();

    assert.ok(typeof summary.totalFiles === 'number');
    assert.ok(typeof summary.totalAdded === 'number');
    assert.ok(typeof summary.totalRemoved === 'number');
    assert.ok(Array.isArray(summary.files));
  });

  it('should track added/modified files, unified diffs, acceptAll, and rejectFile in non-Git workspaces', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-nongit-changes-'));
    try {
      OperationHistoryManager.getInstance().clearWorkspace(tmpDir);
      fs.writeFileSync(path.join(tmpDir, 'clock.py'), 'class Clock:\n    pass\n', 'utf-8');

      const cm = new ChangesManager(tmpDir);
      const toolCtx = {
        workspaceRoot: tmpDir,
        agentId: 'main',
        agentName: 'Main Agent',
        requireApproval: false,
        requestApproval: async () => true,
      };

      await editFileTool({ path: 'clock.py', target: '    pass', replacement: '    def tick(self):\n        return 1' }, toolCtx);
      await writeFileTool({ path: 'timer.py', content: 'def start():\n    return True\n' }, toolCtx);

      const summary = await cm.getSummary();
      assert.strictEqual(summary.totalFiles, 2);
      assert.ok(summary.files.some((f) => f.path === 'clock.py' && f.status === 'M'));
      assert.ok(summary.files.some((f) => f.path === 'timer.py' && f.status === 'A'));
      assert.ok(summary.totalAdded >= 4);

      const diffClock = await cm.getFileDiff('clock.py');
      assert.match(diffClock, /-    pass/);
      assert.match(diffClock, /\+    def tick\(self\):/);

      // Rejecting single file reverts it back to original baseline cleanly
      await cm.rejectFile('clock.py');
      assert.strictEqual(fs.readFileSync(path.join(tmpDir, 'clock.py'), 'utf-8'), 'class Clock:\n    pass\n');
      const afterRejectOne = await cm.getSummary();
      assert.strictEqual(afterRejectOne.totalFiles, 1);
      assert.strictEqual(afterRejectOne.files[0].path, 'timer.py');

      // Accepting remaining changes clears pending list while preserving disk file
      await cm.acceptAll();
      assert.strictEqual(fs.existsSync(path.join(tmpDir, 'timer.py')), true);
      const afterAccept = await cm.getSummary();
      assert.strictEqual(afterAccept.totalFiles, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
