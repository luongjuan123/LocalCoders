const { describe, it } = require('node:test');
const assert = require('node:assert');
const { TaskQueue } = require('../extensions/localcoders-core/dist/agents/task-queue');

describe('TaskQueue — Dependency Graph & Concurrency Throttling', () => {
  it('should only mark tasks as ready when their dependencies are completed', () => {
    const queue = new TaskQueue(3);
    queue.setPlan([
      {
        id: 'task-1',
        title: 'Design API Schema',
        description: 'Create OpenAPI specifications',
        assignedTo: 'sub-backend',
        dependencies: [],
        status: 'pending',
        affectedFiles: ['api.json'],
      },
      {
        id: 'task-2',
        title: 'Implement API Endpoints',
        description: 'Build backend routes',
        assignedTo: 'sub-backend',
        dependencies: ['task-1'], // depends on task-1
        status: 'pending',
        affectedFiles: ['src/routes.ts'],
      },
      {
        id: 'task-3',
        title: 'Run Integration Tests',
        description: 'Execute test suite',
        assignedTo: 'sub-test',
        dependencies: ['task-2'], // depends on task-2
        status: 'pending',
        affectedFiles: ['tests/api.test.ts'],
      },
    ]);

    // Initially, only task-1 is ready
    let ready = queue.getReadyTasks();
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].id, 'task-1');

    // Complete task-1
    queue.updateTaskStatus('task-1', 'completed', 'API schema ready');

    // Now task-2 should become ready
    ready = queue.getReadyTasks();
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].id, 'task-2');

    // Complete task-2
    queue.updateTaskStatus('task-2', 'completed', 'Endpoints created');

    // Now task-3 should become ready
    ready = queue.getReadyTasks();
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].id, 'task-3');

    // Complete task-3
    queue.updateTaskStatus('task-3', 'completed', 'All tests pass');

    assert.strictEqual(queue.isComplete(), true);
    assert.strictEqual(queue.hasFailedTasks(), false);
  });

  it('should enforce maximum concurrency limits', () => {
    const queue = new TaskQueue(2); // limit 2 concurrent tasks
    queue.setPlan([
      { id: 't-1', title: 'Task 1', description: '', assignedTo: 'a1', dependencies: [], status: 'pending', affectedFiles: [] },
      { id: 't-2', title: 'Task 2', description: '', assignedTo: 'a2', dependencies: [], status: 'pending', affectedFiles: [] },
      { id: 't-3', title: 'Task 3', description: '', assignedTo: 'a3', dependencies: [], status: 'pending', affectedFiles: [] },
    ]);

    const ready = queue.getReadyTasks();
    assert.strictEqual(ready.length, 2, 'Should only allow up to 2 concurrent ready tasks');
  });
});
