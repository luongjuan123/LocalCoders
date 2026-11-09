const { describe, it } = require('node:test');
const assert = require('node:assert');
const { FileLockManager } = require('../extensions/localcoders-core/dist/agents/file-lock');

describe('FileLockManager — Workspace Isolation & Conflict Prevention', () => {
  it('should allow an agent to acquire lock on an unheld file', () => {
    const mgr = new FileLockManager();
    const res = mgr.acquireLock('src/auth.ts', 'agent-1', 'Frontend Agent', 'task-1');
    assert.strictEqual(res.success, true);
    assert.strictEqual(mgr.isLocked('src/auth.ts'), true);
  });

  it('should block a second agent from simultaneously writing to the same file', () => {
    const mgr = new FileLockManager();
    mgr.acquireLock('src/auth.ts', 'agent-1', 'Frontend Agent', 'task-1');

    // Agent 2 attempts to lock the same file
    const res2 = mgr.acquireLock('src/auth.ts', 'agent-2', 'Backend Agent', 'task-2');
    assert.strictEqual(res2.success, false);
    assert.strictEqual(res2.conflictWith?.agentId, 'agent-1');
    assert.strictEqual(res2.conflictWith?.agentName, 'Frontend Agent');
  });

  it('should allow the same agent to re-acquire lock idempotently', () => {
    const mgr = new FileLockManager();
    mgr.acquireLock('src/auth.ts', 'agent-1', 'Frontend Agent', 'task-1');
    const res = mgr.acquireLock('src/auth.ts', 'agent-1', 'Frontend Agent', 'task-1');
    assert.strictEqual(res.success, true);
  });

  it('should release locks on task completion and allow other agents to acquire', () => {
    const mgr = new FileLockManager();
    mgr.acquireLock('src/auth.ts', 'agent-1', 'Frontend Agent', 'task-1');
    mgr.releaseAllForTask('task-1');

    assert.strictEqual(mgr.isLocked('src/auth.ts'), false);

    // Now Agent 2 can acquire
    const res2 = mgr.acquireLock('src/auth.ts', 'agent-2', 'Backend Agent', 'task-2');
    assert.strictEqual(res2.success, true);
  });
});
