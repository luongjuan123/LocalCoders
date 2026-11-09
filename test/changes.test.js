const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { ChangesManager } = require('../extensions/localcoders-core/dist/context/changes-manager');

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
});
