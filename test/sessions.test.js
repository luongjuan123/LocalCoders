const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { SessionManager } = require('../extensions/localcoders-core/dist/sessions/session-manager');

const mockWorkspace = path.resolve(__dirname, 'mock-workspace');
const mockContext = {
  workspaceState: {
    data: {},
    get(k) { return this.data[k]; },
    update(k, v) { this.data[k] = v; },
  },
};

describe('SessionManager — Multi-Session Persistence & Lifecycle', () => {
  it('should create, persist, switch, and delete sessions', () => {
    const sm = new SessionManager(mockContext, mockWorkspace);
    
    // Create new session
    const s1 = sm.createSession('Build Python Clock Application', 'qwen3.8:27b');
    assert.ok(s1.id);
    assert.strictEqual(s1.title, 'Build Python Clock Application');
    assert.strictEqual(s1.model, 'qwen3.8:27b');

    // Get active session
    const active = sm.getActiveSession();
    assert.ok(active);
    assert.strictEqual(active.id, s1.id);

    // Create second session
    const s2 = sm.createSession('Refactor Authentication Service', 'qwen3.8:27b');
    assert.strictEqual(sm.getActiveSession()?.id, s2.id);

    // Switch back to session 1
    const switched = sm.switchSession(s1.id);
    assert.strictEqual(switched, true);
    assert.strictEqual(sm.getActiveSession()?.id, s1.id);

    // Rename session
    sm.renameSession(s1.id, 'Python Clock v2');
    assert.strictEqual(sm.getSession(s1.id)?.title, 'Python Clock v2');

    // List all sessions
    const all = sm.getAllSessions();
    assert.ok(all.length >= 2);

    // Test saving independent chat messages per section
    sm.updateActiveSession((s) => {
      s.messages.push({
        id: 'msg_1',
        senderId: 'user',
        senderName: 'You',
        senderRole: 'user',
        content: 'Test message for section 1',
        timestamp: Date.now(),
      });
    });
    assert.strictEqual(sm.getSession(s1.id)?.messages.length, 1);
    assert.strictEqual(sm.getSession(s2.id)?.messages.length, 0);

    // Switch to section 2 and append different message
    sm.switchSession(s2.id);
    sm.updateActiveSession((s) => {
      s.messages.push({
        id: 'msg_2',
        senderId: 'assistant',
        senderName: 'Main Agent',
        senderRole: 'assistant',
        content: 'Test response for section 2',
        timestamp: Date.now(),
      });
    });
    assert.strictEqual(sm.getSession(s1.id)?.messages.length, 1);
    assert.strictEqual(sm.getSession(s2.id)?.messages.length, 1);
    assert.strictEqual(sm.getSession(s1.id)?.messages[0].content, 'Test message for section 1');
    assert.strictEqual(sm.getSession(s2.id)?.messages[0].content, 'Test response for section 2');

    // Clean up
    sm.deleteSession(s1.id);
    sm.deleteSession(s2.id);
  });

  it('should support creating and managing many independent sections', () => {
    const sm = new SessionManager(mockContext, mockWorkspace);
    const createdIds = [];

    // Create 10 independent sections
    for (let i = 1; i <= 10; i++) {
      const s = sm.createSession(`Section ${i}: Feature task`, 'qwen3.8:27b');
      createdIds.push(s.id);
    }

    const all = sm.getAllSessions();
    assert.ok(all.length >= 10, 'Expected at least 10 sections');

    // Verify all 10 are retrieved and distinct
    const ids = new Set(all.map(s => s.id));
    for (const id of createdIds) {
      assert.ok(ids.has(id), `Section ${id} should exist`);
    }

    // Clean up
    for (const id of createdIds) {
      sm.deleteSession(id);
    }
  });
});
