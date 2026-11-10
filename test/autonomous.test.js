const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  parseToolCallsFromContent,
  parseCodeBlocksFromContent,
} = require('../extensions/localcoders-core/dist/agents/main-agent');
const { ToolManager } = require('../extensions/localcoders-core/dist/tools/tool-manager');

describe('Autonomous Execution & Tool Scoping Engine', () => {
  it('should parse native embedded tool calls from text', () => {
    const text = 'Here is the tool call:\n<tool_call>{"name": "write_file", "arguments": {"path": "clock.py", "content": "class Clock: pass"}}</tool_call>';
    const calls = parseToolCallsFromContent(text);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, 'write_file');
    assert.strictEqual(calls[0].args.path, 'clock.py');
  });

  it('should parse markdown code blocks with file names from headers or comments', () => {
    const text = `
### clock.py
\`\`\`python
class Clock:
    def __init__(self):
        self.time = "12:00"
\`\`\`

File: test_clock.py
\`\`\`python
import unittest
class TestClock(unittest.TestCase):
    pass
\`\`\`
`;
    const files = parseCodeBlocksFromContent(text);
    assert.strictEqual(files.length, 2);
    assert.strictEqual(files[0].path, 'clock.py');
    assert.strictEqual(files[1].path, 'test_clock.py');
    assert.ok(files[0].content.includes('class Clock'));
    assert.ok(files[1].content.includes('class TestClock'));
  });

  it('should scope tools to core coding tools when executing coding tasks', () => {
    const tm = new ToolManager();
    const codingTools = tm.getToolDefinitions('Lead Architect & Autonomous Developer', {
      prompt: 'Implement Core Clock and Alarm Logic in clock.py',
      affectedFiles: ['clock.py'],
    });

    // Should include core coding tools
    const names = codingTools.map((t) => t.name);
    assert.ok(names.includes('write_file'));
    assert.ok(names.includes('edit_file'));
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('run_command'));

    // Should NOT include heavy irrelevant tools (browser, docker, db)
    assert.ok(!names.includes('browser_launch'));
    assert.ok(!names.includes('docker_build'));
    assert.ok(!names.includes('database_query_readonly'));
    assert.ok(!names.includes('computer_mouse_click'));

    // Must be ~10 tools instead of 70+
    assert.ok(names.length <= 15, `Expected <= 15 tools, got ${names.length}`);
  });

  it('should dynamically include browser tools if task mentions web or browser', () => {
    const tm = new ToolManager();
    const webTools = tm.getToolDefinitions('Lead Architect & Autonomous Developer', {
      prompt: 'Scrape the pricing table from url with browser',
      affectedFiles: [],
    });
    const names = webTools.map((t) => t.name);
    assert.ok(names.includes('browser_launch'));
    assert.ok(names.includes('browser_navigate'));
  });
});
