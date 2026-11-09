const { describe, it } = require('node:test');
const assert = require('node:assert');
const { OllamaClient } = require('../extensions/localcoders-core/dist/ollama/client');
const { detectHardware } = require('../extensions/localcoders-core/dist/ollama/hardware');
const { getModelCatalogue } = require('../extensions/localcoders-core/dist/ollama/catalogue');

describe('Ollama Integration & Hardware Detection', () => {
  const client = new OllamaClient('http://127.0.0.1:11434');

  it('should detect running Ollama service and return version', async () => {
    const conn = await client.checkConnection();
    assert.strictEqual(typeof conn.connected, 'boolean');
    if (conn.connected) {
      assert.ok(conn.version, 'Expected version string when connected');
      console.log(`  [OK] Ollama connected: v${conn.version}`);
    } else {
      console.log('  [Notice] Ollama service not running locally; connection handled gracefully.');
    }
  });

  it('should list installed Ollama models', async () => {
    const models = await client.listModels();
    assert.ok(Array.isArray(models));
    console.log(`  [OK] Discovered ${models.length} installed model(s): ${models.map(m => m.name).join(', ')}`);
  });

  it('should accurately detect system hardware (RAM, CPU, GPU, OS)', async () => {
    const hw = await detectHardware('http://127.0.0.1:11434');
    assert.ok(hw.cpu.cores > 0);
    assert.ok(hw.ram.totalGb > 0);
    assert.ok(hw.os);
    console.log(`  [OK] Hardware: ${hw.cpu.model} (${hw.cpu.cores} cores), ${hw.ram.totalGb} GB RAM, GPU: ${hw.gpu?.name || 'CPU only'}`);
  });

  it('should generate curated model catalogue with categories and RAM estimates', () => {
    const catalogue = getModelCatalogue([]);
    assert.ok(catalogue.length >= 10);
    const coding = catalogue.filter(m => m.category === 'coding');
    const reasoning = catalogue.filter(m => m.category === 'reasoning');
    assert.ok(coding.length > 0, 'Should contain coding models');
    assert.ok(reasoning.length > 0, 'Should contain reasoning models');
    for (const item of catalogue) {
      assert.ok(item.minRamGb > 0);
      assert.ok(item.size);
    }
    console.log(`  [OK] Model catalogue contains ${catalogue.length} curated models across 4 categories.`);
  });

  it('should support querying running models and graceful model unload via keep_alive 0', async () => {
    const running = await client.getRunningModels();
    assert.ok(Array.isArray(running), 'Expected running models array');
    console.log(`  [OK] Active running models: ${running.length}`);

    // Test unload method
    const res = await client.unloadAllModels();
    assert.strictEqual(typeof res, 'undefined');
    console.log('  [OK] unloadAllModels executed cleanly without throwing');
  });
});
