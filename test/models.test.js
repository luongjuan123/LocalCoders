const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('path');
const fs = require('node:fs');

const { OllamaClient } = require('../extensions/localcoders-core/dist/ollama/client');
const { ModelProviderRegistry } = require('../extensions/localcoders-core/dist/models/model-provider-registry');
const { LLMRouter, ModelUnavailableError } = require('../extensions/localcoders-core/dist/models/llm-router');
const { validateEndpointUrl, redactSecrets } = require('../extensions/localcoders-core/dist/models/security');
const { AgentRegistry } = require('../extensions/localcoders-core/dist/agents/agent-registry');
const { AgentOrchestrator } = require('../extensions/localcoders-core/dist/agents/orchestrator');
const { ToolManager } = require('../extensions/localcoders-core/dist/tools/tool-manager');
const { SessionManager } = require('../extensions/localcoders-core/dist/sessions/session-manager');

function createMockMemento() {
  const store = new Map();
  return {
    _store: store,
    get(k, def) {
      return store.has(k) ? store.get(k) : def;
    },
    async update(k, v) {
      store.set(k, v);
    },
  };
}

function createMockSecretStorage() {
  const secrets = new Map();
  return {
    _secrets: secrets,
    async get(k) {
      return secrets.get(k);
    },
    async store(k, v) {
      secrets.set(k, v);
    },
    async delete(k) {
      secrets.delete(k);
    },
  };
}

async function withHttpServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(baseUrl, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('Central Model Registry, Provider Integrations & Request Routing', () => {
  it('1. Ollama model discovery reads real tags, /api/ps, and /api/show without inventing models or aliases', async () => {
    const showPayloads = {
      'qwen3:8b': {
        capabilities: ['completion', 'tools', 'thinking'],
        thinking: { values: [false, 'low', 'medium', 'xhigh'], default: 'medium' },
        details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' },
        model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 131072 },
      },
      'llama3.1:8b': {
        capabilities: ['completion', 'tools'],
        details: { family: 'llama', parameter_size: '8.0B', quantization_level: 'Q4_0' },
        model_info: { 'general.architecture': 'llama', 'llama.context_length': 65536 },
      },
    };

    await withHttpServer(
      (req, res) => {
        if (req.url === '/api/version') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ version: '0.40.15' }));
        } else if (req.url === '/api/tags') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              models: [
                {
                  name: 'qwen3:8b',
                  model: 'qwen3:8b',
                  modified_at: '2026-11-10T01:00:00Z',
                  size: 5000000000,
                  digest: 'd1',
                  details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' },
                },
                {
                  name: 'llama3.1:8b',
                  model: 'llama3.1:8b',
                  modified_at: '2026-11-10T01:00:00Z',
                  size: 4700000000,
                  digest: 'd2',
                  details: { family: 'llama', parameter_size: '8.0B', quantization_level: 'Q4_0' },
                },
              ],
            })
          );
        } else if (req.url === '/api/ps') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ models: [{ name: 'qwen3:8b', model: 'qwen3:8b', size_vram: 4200000000 }] }));
        } else if (req.url === '/api/show') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            const parsed = JSON.parse(body || '{}');
            const detail = showPayloads[parsed.name] || null;
            res.writeHead(detail ? 200 : 404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(detail || { error: 'not found' }));
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      },
      async (baseUrl) => {
        const registry = new ModelProviderRegistry(new OllamaClient(baseUrl), createMockMemento(), createMockSecretStorage());
        const models = await registry.getAvailableModels({ forceRefresh: true });

        // Must ONLY contain the 2 discovered models — NO qwen3.8:27b, NO Fusion, NO fake cloud models!
        assert.strictEqual(models.length, 2);
        assert.ok(models.every((m) => !m.id.includes('qwen3.8:27b') && !m.id.includes('fusion')));
        assert.ok(models.every((m) => m.providerId === 'ollama' && m.providerType === 'LOCAL'));

        const qwen = models.find((m) => m.modelIdentifier === 'qwen3:8b');
        const llama = models.find((m) => m.modelIdentifier === 'llama3.1:8b');

        assert.strictEqual(qwen.displayName, 'qwen3:8b');
        assert.strictEqual(qwen.availability, 'running');
        assert.strictEqual(qwen.contextWindow, 131072);
        assert.strictEqual(qwen.capabilities.toolCalling, true);
        assert.deepStrictEqual(qwen.reasoningEffortsSupported, ['minimal', 'low', 'medium', 'extra_high']);

        // Non-thinking model must NOT pretend to support reasoning effort!
        assert.strictEqual(llama.availability, 'installed');
        assert.strictEqual(llama.contextWindow, 65536);
        assert.deepStrictEqual(llama.reasoningEffortsSupported, []);
      }
    );
  });

  it('2. Ollama unavailable reports disconnected state with zero fake models', async () => {
    // Unreachable local port
    const registry = new ModelProviderRegistry(
      new OllamaClient('http://127.0.0.1:19999'),
      createMockMemento(),
      createMockSecretStorage()
    );
    const models = await registry.getAvailableModels({ forceRefresh: true });
    const statuses = await registry.getProviderStatuses(false);
    const ollamaStatus = statuses.find((s) => s.providerId === 'ollama');

    assert.strictEqual(models.length, 0);
    assert.strictEqual(ollamaStatus.status, 'disconnected');
    assert.ok(ollamaStatus.error);
  });

  it('3. Empty Ollama model list returns connected with zero models and zero fake fallbacks', async () => {
    await withHttpServer(
      (req, res) => {
        if (req.url === '/api/version') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ version: '0.40.15' }));
        } else if (req.url === '/api/tags' || req.url === '/api/ps') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ models: [] }));
        } else {
          res.writeHead(404);
          res.end();
        }
      },
      async (baseUrl) => {
        const registry = new ModelProviderRegistry(new OllamaClient(baseUrl), createMockMemento(), createMockSecretStorage());
        const models = await registry.getAvailableModels({ forceRefresh: true });
        const statuses = await registry.getProviderStatuses(false);
        const ollamaStatus = statuses.find((s) => s.providerId === 'ollama');

        assert.strictEqual(ollamaStatus.status, 'connected');
        assert.strictEqual(models.length, 0);
        assert.strictEqual(await registry.getDefaultOrFirstAvailableModel(), undefined);
      }
    );
  });

  it('4. Cloud provider connection success discovers real API models & verifies OpenRouter pricing without faking', async () => {
    await withHttpServer(
      (req, res) => {
        // Handle OpenAI-style /models, Anthropic /v1/models, Gemini /v1beta/models, OpenRouter /auth/key + /models
        const url = req.url.split('?')[0];
        if (url === '/openai/models') {
          assert.strictEqual(req.headers['authorization'], 'Bearer sk-real-openai-test');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              data: [
                { id: 'gpt-4o', created: 1000, owned_by: 'openai' },
                { id: 'o3-mini', created: 1001, owned_by: 'openai' },
                { id: 'text-embedding-3-small', created: 1002, owned_by: 'openai' }, // filtered out
              ],
            })
          );
        } else if (url === '/anthropic/v1/models') {
          assert.strictEqual(req.headers['x-api-key'], 'sk-ant-real-test');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              data: [
                { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' },
                { id: 'claude-3-5-haiku-20241022', display_name: 'Claude 3.5 Haiku' },
              ],
            })
          );
        } else if (url === '/gemini/v1beta/models') {
          assert.strictEqual(req.headers['x-goog-api-key'], 'AIzaSyRealGeminiTestKey12345');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              models: [
                {
                  name: 'models/gemini-2.5-pro',
                  displayName: 'Gemini 2.5 Pro',
                  inputTokenLimit: 1048576,
                  outputTokenLimit: 65536,
                  supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
                  thinking: true,
                },
                {
                  name: 'models/text-embedding-004',
                  displayName: 'Embedding 004',
                  supportedGenerationMethods: ['embedContent'], // filtered out
                },
              ],
            })
          );
        } else if (url === '/openrouter/auth/key') {
          assert.strictEqual(req.headers['authorization'], 'Bearer sk-or-real-test-key');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { label: 'dev-key', limit_remaining: 10 } }));
        } else if (url === '/openrouter/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              data: [
                {
                  id: 'deepseek/deepseek-r1',
                  name: 'DeepSeek R1',
                  context_length: 64000,
                  pricing: { prompt: '0.00000055', completion: '0.00000219' },
                  supported_parameters: ['tools', 'reasoning', 'temperature'],
                  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
                },
              ],
            })
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      },
      async (baseUrl) => {
        const memento = createMockMemento();
        const secrets = createMockSecretStorage();
        const registry = new ModelProviderRegistry(new OllamaClient('http://127.0.0.1:19999'), memento, secrets);

        await registry.updateProviderConfig('openai', { baseUrl: `${baseUrl}/openai` });
        await registry.updateProviderConfig('anthropic', { baseUrl: `${baseUrl}/anthropic` });
        await registry.updateProviderConfig('gemini', { baseUrl: `${baseUrl}/gemini` });
        await registry.updateProviderConfig('openrouter', { baseUrl: `${baseUrl}/openrouter` });

        // Before setting keys -> ZERO cloud models!
        const beforeModels = await registry.getAvailableModels({ forceRefresh: true });
        assert.strictEqual(beforeModels.length, 0);

        await registry.setProviderApiKey('openai', 'sk-real-openai-test');
        await registry.setProviderApiKey('anthropic', 'sk-ant-real-test');
        await registry.setProviderApiKey('gemini', 'AIzaSyRealGeminiTestKey12345');
        await registry.setProviderApiKey('openrouter', 'sk-or-real-test-key');

        const models = await registry.getAvailableModels({ forceRefresh: false });
        assert.strictEqual(models.length, 6);

        // OpenAI check: contextWindow unknown (never fabricated!), GPT-4o no reasoning effort, o3-mini supports reasoning
        const gpt4o = models.find((m) => m.id === 'openai/gpt-4o');
        const o3mini = models.find((m) => m.id === 'openai/o3-mini');
        assert.strictEqual(gpt4o.contextWindow, undefined);
        assert.strictEqual(gpt4o.pricing, undefined);
        assert.deepStrictEqual(gpt4o.reasoningEffortsSupported, []);
        assert.deepStrictEqual(o3mini.reasoningEffortsSupported, ['low', 'medium', 'high']);

        // Anthropic check
        const claude4 = models.find((m) => m.id === 'anthropic/claude-sonnet-4-20250514');
        const claudeHaiku = models.find((m) => m.id === 'anthropic/claude-3-5-haiku-20241022');
        assert.ok(claude4.reasoningEffortsSupported.includes('high'));
        assert.deepStrictEqual(claudeHaiku.reasoningEffortsSupported, []);

        // Gemini check: exact contextWindow + output limits read from /v1beta/models
        const gem = models.find((m) => m.id === 'gemini/gemini-2.5-pro');
        assert.strictEqual(gem.contextWindow, 1048576);
        assert.strictEqual(gem.maxOutputTokens, 65536);
        assert.strictEqual(gem.pricing, undefined);

        // OpenRouter check: verified pricing from API
        const orModel = models.find((m) => m.id === 'openrouter/deepseek/deepseek-r1');
        assert.strictEqual(orModel.contextWindow, 64000);
        assert.strictEqual(orModel.pricing.inputPerM, 0.55);
        assert.strictEqual(orModel.pricing.outputPerM, 2.19);

        // Security check: API keys stored ONLY in SecretStorage, NEVER in Memento JSON!
        const persistedJson = JSON.stringify(Array.from(memento._store.entries()));
        assert.ok(!persistedJson.includes('sk-real-openai-test'));
        assert.ok(!persistedJson.includes('sk-ant-real-test'));
        assert.ok(!persistedJson.includes('AIzaSyRealGeminiTestKey12345'));
        assert.ok(!persistedJson.includes('sk-or-real-test-key'));
        assert.strictEqual(await secrets.get('localcoders.provider.apiKey.openai'), 'sk-real-openai-test');
      }
    );
  });

  it('5. Invalid API keys & 6. Discovery failures handle errors safely without leaking secrets or adding fake models', async () => {
    const secretKey = 'sk-secret-do-not-leak-99999';
    await withHttpServer(
      (req, res) => {
        if (req.url.startsWith('/openai/models')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Invalid key ${secretKey}` } }));
        } else {
          res.writeHead(500);
          res.end('Internal server error');
        }
      },
      async (baseUrl) => {
        const registry = new ModelProviderRegistry(
          new OllamaClient('http://127.0.0.1:19999'),
          createMockMemento(),
          createMockSecretStorage()
        );
        await registry.updateProviderConfig('openai', { baseUrl: `${baseUrl}/openai` });
        const testRes = await registry.setProviderApiKey('openai', secretKey);

        assert.strictEqual(testRes.ok, false);
        assert.strictEqual(testRes.status, 'error');
        assert.ok(!testRes.error.includes(secretKey), 'Error must never expose raw API key');
        assert.strictEqual((await registry.getAvailableModels()).length, 0);

        // Also test custom discovery failure
        const customRes = await registry.addCustomProvider({
          name: 'Broken Custom',
          baseUrl: `${baseUrl}/broken`,
        });
        assert.strictEqual(customRes.ok, true);
        const statuses = await registry.getProviderStatuses(false);
        const brokenStatus = statuses.find((s) => s.providerId === customRes.providerId);
        assert.strictEqual(brokenStatus.status, 'error');
        assert.strictEqual((await registry.getAvailableModels()).length, 0);
      }
    );
  });

  it('7. Duplicate model detection deduplicates identical tags/IDs in backend and grouped selector', async () => {
    await withHttpServer(
      (req, res) => {
        if (req.url === '/api/version') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ version: '0.40.15' }));
        } else if (req.url === '/api/tags') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              models: [
                { name: 'qwen3.8:27b', model: 'qwen3.8:27b', digest: 'abc', size: 17000, details: {} },
                { name: 'qwen3.8:27b', model: 'qwen3.8:27b', digest: 'abc', size: 17000, details: {} },
              ],
            })
          );
        } else if (req.url === '/api/ps') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ models: [] }));
        } else if (req.url === '/api/show') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ capabilities: ['completion', 'tools'] }));
        } else if (req.url === '/custom/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'my/custom-model' }, { id: 'my/custom-model' }] }));
        } else {
          res.writeHead(404);
          res.end();
        }
      },
      async (baseUrl) => {
        const registry = new ModelProviderRegistry(new OllamaClient(baseUrl), createMockMemento(), createMockSecretStorage());
        await registry.addCustomProvider({
          id: 'custom-lm',
          name: 'Local LM',
          baseUrl: `${baseUrl}/custom`,
          manualModels: [{ modelIdentifier: 'my/custom-model' }],
        });

        const models = await registry.getAvailableModels({ forceRefresh: true });
        assert.strictEqual(models.length, 2, 'Expected strictly deduplicated models (1 Ollama + 1 Custom)');

        // Pin both as favorite AND record usage -> getGroupedModels MUST still never duplicate rows!
        await registry.toggleFavorite('ollama/qwen3.8:27b');
        await registry.recordModelUsage('ollama/qwen3.8:27b');
        const grouped = await registry.getGroupedModels();
        assert.strictEqual(grouped.local.length + grouped.cloud.length, 2);
        const ids = [...grouped.local, ...grouped.cloud].map((m) => m.id);
        assert.strictEqual(new Set(ids).size, 2);
      }
    );
  });

  it('8-11. Model selection, Session switching, Effort mapping & API request routing + No silent fallback', async () => {
    const receivedRequests = [];

    await withHttpServer(
      (req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsedBody = body ? JSON.parse(body) : {};
          if (req.url === '/api/version') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ version: '0.40.15' }));
          } else if (req.url === '/api/tags') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                models: [
                  { name: 'qwen3:8b', model: 'qwen3:8b', digest: 'q1', size: 1000, details: {} },
                  { name: 'llama3.1:8b', model: 'llama3.1:8b', digest: 'l1', size: 1000, details: {} },
                ],
              })
            );
          } else if (req.url === '/api/ps') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: [] }));
          } else if (req.url === '/api/show') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (parsedBody.name === 'qwen3:8b') {
              res.end(JSON.stringify({ capabilities: ['completion', 'tools', 'thinking'], thinking: { values: [false, 'low', 'medium', 'xhigh'], default: 'medium' } }));
            } else {
              res.end(JSON.stringify({ capabilities: ['completion', 'tools'] }));
            }
          } else if (req.url === '/api/chat') {
            receivedRequests.push({ target: 'ollama', model: parsedBody.model, think: parsedBody.think, temp: parsedBody.options?.temperature });
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
            res.end(JSON.stringify({ message: { content: 'Ollama OK' }, done: true }) + '\n');
          } else if (req.url === '/openai/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'o3-mini' }] }));
          } else if (req.url === '/openai/chat/completions') {
            receivedRequests.push({
              target: 'openai',
              model: parsedBody.model,
              reasoning_effort: parsedBody.reasoning_effort,
              temperature: parsedBody.temperature,
            });
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(
              'data: ' + JSON.stringify({ choices: [{ delta: { content: 'OpenAI OK' } }] }) + '\n\n' +
              'data: [DONE]\n\n'
            );
          } else if (req.url === '/custom/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'org/nested-model-v1' }] }));
          } else if (req.url === '/custom/chat/completions') {
            receivedRequests.push({ target: 'custom', model: parsedBody.model });
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(
              'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Custom OK' } }] }) + '\n\n' +
              'data: [DONE]\n\n'
            );
          } else {
            res.writeHead(404);
            res.end();
          }
        });
      },
      async (baseUrl) => {
        const ollama = new OllamaClient(baseUrl);
        const registry = new ModelProviderRegistry(ollama, createMockMemento(), createMockSecretStorage());
        await registry.updateProviderConfig('openai', { baseUrl: `${baseUrl}/openai` });
        await registry.setProviderApiKey('openai', 'sk-routing-test');
        await registry.addCustomProvider({ id: 'custom-vllm', name: 'vLLM', baseUrl: `${baseUrl}/custom` });

        const mockWorkspace = path.join(__dirname, 'mock-workspace');
        const sm = new SessionManager(
          { workspaceState: createMockMemento() },
          mockWorkspace
        );

        const session = sm.createSession('Session routing test', 'ollama/qwen3:8b');
        sm.updateActiveSession((s) => {
          s.messages.push({
            id: 'u1',
            senderId: 'user',
            senderName: 'You',
            senderRole: 'user',
            content: 'First turn user question',
            timestamp: Date.now(),
          });
        });

        const agentReg = new AgentRegistry({ globalState: createMockMemento() });
        agentReg.setMainAgent({
          id: 'main',
          name: 'Main Agent',
          role: 'Developer',
          model: 'ollama/qwen3:8b',
          systemPrompt: 'Dev',
          enabled: true,
          maxConcurrency: 1,
          temperature: 0.2,
          contextWindow: 32768,
        });
        agentReg.setCriticConfig({ enabled: false, model: '', strictness: 'strict', categories: [], trigger: 'on_diff', reviewMode: 'changed_files' });

        const orchestrator = new AgentOrchestrator(ollama, agentReg, new ToolManager(), mockWorkspace, registry);

        // Turn 1: Ollama qwen3:8b with Extra High effort -> must map extra_high -> 'xhigh'!
        sm.updateActiveConfig((cfg) => {
          cfg.executionMode = 'ask';
          cfg.modelId = 'ollama/qwen3:8b';
          cfg.reasoningEffort = 'extra_high';
        });
        await orchestrator.submitTask('Explain clock module', sm.getActiveSession().config);

        // Turn 2: Switch mid-session to OpenAI o3-mini with 'high' effort -> must preserve conversation history & route to OpenAI!
        sm.updateActiveConfig((cfg) => {
          cfg.providerId = 'openai';
          cfg.modelId = 'openai/o3-mini';
          cfg.reasoningEffort = 'high';
        });
        assert.strictEqual(sm.getSession(session.id).messages.length, 1, 'Conversation history preserved after switch');
        await orchestrator.submitTask('Now optimize it', sm.getActiveSession().config);

        // Turn 3: Switch to non-thinking Ollama llama3.1:8b with 'high' set -> must NOT send unsupported 'think'!
        sm.updateActiveConfig((cfg) => {
          cfg.providerId = 'ollama';
          cfg.modelId = 'ollama/llama3.1:8b';
          cfg.reasoningEffort = 'high';
        });
        await orchestrator.submitTask('Check formatting', sm.getActiveSession().config);

        // Turn 4: Custom endpoint with nested slash model ID must preserve 'org/nested-model-v1'!
        sm.updateActiveConfig((cfg) => {
          cfg.providerId = 'custom-vllm';
          cfg.modelId = 'custom-vllm/org/nested-model-v1';
        });
        await orchestrator.submitTask('Hello nested model', sm.getActiveSession().config);

        // Verify exact wire payloads!
        assert.strictEqual(receivedRequests[0].target, 'ollama');
        assert.strictEqual(receivedRequests[0].model, 'qwen3:8b');
        assert.strictEqual(receivedRequests[0].think, 'xhigh');

        assert.strictEqual(receivedRequests[1].target, 'openai');
        assert.strictEqual(receivedRequests[1].model, 'o3-mini');
        assert.strictEqual(receivedRequests[1].reasoning_effort, 'high');
        assert.strictEqual(receivedRequests[1].temperature, undefined); // O-series doesn't allow temperature

        assert.strictEqual(receivedRequests[2].target, 'ollama');
        assert.strictEqual(receivedRequests[2].model, 'llama3.1:8b');
        assert.strictEqual(receivedRequests[2].think, undefined); // Unsupported reasoning NOT fabricated

        assert.strictEqual(receivedRequests[3].target, 'custom');
        assert.strictEqual(receivedRequests[3].model, 'org/nested-model-v1');

        // Turn 5: Unavailable / non-existent model -> MUST fail explicitly without silent substitution!
        const beforeCount = receivedRequests.length;
        sm.updateActiveConfig((cfg) => {
          cfg.modelId = 'openai/non-existent-model-xyz';
        });
        const failTask = await orchestrator.submitTask('Run with missing model', sm.getActiveSession().config);
        assert.strictEqual(failTask.status, 'failed');
        assert.strictEqual(receivedRequests.length, beforeCount, 'Must NOT silently substitute and call another model');

        // Also test router directly throws ModelUnavailableError
        const router = new LLMRouter(ollama, registry);
        await assert.rejects(
          async () => router.chatStream({ model: 'ollama/not-installed:7b', providerId: 'ollama', modelIdentifier: 'not-installed:7b', messages: [{ role: 'user', content: 'hi' }] }, () => {}),
          ModelUnavailableError
        );

        sm.deleteSession(session.id);
      }
    );
  });

  it('12-14. Model removal, Provider removal, and SSRF / Secret redaction security', async () => {
    await withHttpServer(
      (req, res) => {
        if (req.url === '/custom/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [] }));
        } else {
          res.writeHead(404);
          res.end();
        }
      },
      async (baseUrl) => {
        const secrets = createMockSecretStorage();
        const registry = new ModelProviderRegistry(
          new OllamaClient('http://127.0.0.1:19999'),
          createMockMemento(),
          secrets
        );

        const added = await registry.addCustomProvider({
          id: 'my-gateway',
          name: 'My Gateway',
          baseUrl: `${baseUrl}/custom`,
          apiKey: 'sk-gateway-secret-1234',
          manualModels: [{ modelIdentifier: 'custom-alpha' }, { modelIdentifier: 'custom-beta' }],
        });
        assert.strictEqual(added.ok, true);
        assert.strictEqual((await registry.getAvailableModels()).length, 2);

        // Disable model
        await registry.setModelEnabled('my-gateway/custom-alpha', false);
        assert.strictEqual((await registry.getAvailableModels()).length, 1);

        // Remove manual model
        await registry.removeManualModel('my-gateway', 'custom-beta');
        assert.strictEqual((await registry.getAvailableModels({ includeDisabled: true })).length, 1);

        // Remove entire provider -> must delete secret key & all models
        await registry.removeProvider('my-gateway');
        assert.strictEqual(await secrets.get('localcoders.provider.apiKey.my-gateway'), undefined);
        assert.strictEqual((await registry.getAvailableModels({ includeDisabled: true })).length, 0);

        // SSRF & Endpoint security checks
        assert.strictEqual(validateEndpointUrl('http://169.254.169.254/latest/meta-data', { allowHttp: true }).valid, false);
        assert.strictEqual(validateEndpointUrl('http://metadata.google.internal/v1', { allowHttp: true }).valid, false);
        assert.strictEqual(validateEndpointUrl('file:///etc/passwd', { allowHttp: true }).valid, false);
        assert.strictEqual(validateEndpointUrl('https://user:pass@api.openai.com/v1', { allowHttp: false }).valid, false);
        assert.strictEqual(validateEndpointUrl('http://api.openai.com/v1', { allowHttp: false }).valid, false);
        assert.strictEqual(validateEndpointUrl('https://api.openai.com/v1', { allowHttp: false }).valid, true);
        assert.strictEqual(validateEndpointUrl('http://localhost:11434', { allowHttp: false, allowHttpLocalhost: true }).valid, true);

        // Secret redaction check
        const redacted = redactSecrets('Failed with key sk-1234567890abcdef and AIzaSyAbCdEfGhIjKlMnOpQrStUvWx', []);
        assert.ok(!redacted.includes('sk-1234567890abcdef'));
        assert.ok(!redacted.includes('AIzaSyAbCdEfGhIjKlMnOpQrStUvWx'));
      }
    );
  });

  it('15. Live Local Ollama Integration Verification (real localhost:11434 if reachable)', async () => {
    const liveOllama = new OllamaClient('http://127.0.0.1:11434');
    const conn = await liveOllama.checkConnection();
    if (!conn.connected) {
      console.log(`  [LIVE SKIP] Local Ollama not reachable (${conn.error}); integration check skipped honestly.`);
      return;
    }

    const registry = new ModelProviderRegistry(liveOllama, createMockMemento(), createMockSecretStorage());
    const models = await registry.getAvailableModels({ forceRefresh: true });
    const statuses = await registry.getProviderStatuses(false);
    const ollamaStatus = statuses.find((s) => s.providerId === 'ollama');

    assert.strictEqual(ollamaStatus.status, 'connected');
    console.log(`  [LIVE OK] Real Ollama v${ollamaStatus.version}: discovered ${models.length} model(s): ${models.map((m) => `${m.displayName} [${m.availability}, ctx=${m.contextWindow || 'Unknown'}, efforts=${(m.reasoningEffortsSupported || []).join('/') || 'none'}]`).join('; ')}`);

    // Ensure no unconfigured cloud models crept in
    assert.ok(models.every((m) => m.providerId === 'ollama'));
  });

  it('16. OllamaClient serializes local inference, sanitizes tool/user turns, dynamically caps num_ctx, and retries transient runner crash', async () => {
    let activeRequests = 0;
    let maxConcurrentSeen = 0;
    let chatAttempts = 0;
    const seenPayloads = [];

    await withHttpServer(
      (req, res) => {
        if (req.url === '/api/version') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ version: '0.40.15' }));
        } else if (req.url === '/api/tags') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              models: [{ name: 'qwen3.8:27b', model: 'qwen3.8:27b', size: 16000000000, digest: 'q1' }],
            })
          );
        } else if (req.url === '/api/ps') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ models: [] }));
        } else if (req.url === '/api/show') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              capabilities: ['completion', 'tools', 'thinking'],
              model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 },
            })
          );
        } else if (req.url === '/api/chat') {
          activeRequests++;
          if (activeRequests > maxConcurrentSeen) maxConcurrentSeen = activeRequests;
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            chatAttempts++;
            const parsed = JSON.parse(body || '{}');
            seenPayloads.push(parsed);

            // First call simulates transient llama-server crash before output
            if (chatAttempts === 1) {
              activeRequests--;
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'llama-server process no longer running: unknown' }));
              return;
            }

            setTimeout(() => {
              activeRequests--;
              res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
              res.end(
                JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }) + '\n'
              );
            }, 30);
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      },
      async (baseUrl) => {
        const client = new OllamaClient(baseUrl);
        const registry = new ModelProviderRegistry(client, createMockMemento(), createMockSecretStorage());
        const router = new LLMRouter(client, registry);

        let out1 = '';
        let out2 = '';
        await Promise.all([
          router.chatStream(
            {
              model: 'ollama/qwen3.8:27b',
              messages: [
                { role: 'system', content: 'sys' },
                { role: 'user', content: '   ' },
                { role: 'assistant', content: '' },
                { role: 'tool', content: '{"success":true}' },
              ],
            },
            (c) => {
              out1 += c.content;
            }
          ),
          router.chatStream(
            {
              model: 'ollama/qwen3.8:27b',
              messages: [{ role: 'user', content: 'second task' }],
              contextWindow: 8192,
            },
            (c) => {
              out2 += c.content;
            }
          ),
        ]);

        assert.strictEqual(out1, 'ok');
        assert.strictEqual(out2, 'ok');
        // Must have serialized so never >1 concurrent inference hit Ollama
        assert.strictEqual(maxConcurrentSeen, 1);
        // Transient crash retried once -> total 3 requests for 2 logical streams
        assert.strictEqual(chatAttempts, 3);
        // Sanitizer replaced whitespace-only user message and appended continuation user message after tool
        const firstMsgs = seenPayloads[1].messages;
        assert.strictEqual(firstMsgs[1].content, 'Proceed with the task.');
        assert.strictEqual(firstMsgs[firstMsgs.length - 1].role, 'user');
        // Dynamic context defaults to 16384 on small prompt instead of forcing 32768
        assert.strictEqual(seenPayloads[1].options.num_ctx, 16384);
        // Explicit contextWindow respected on second request
        assert.strictEqual(seenPayloads[2].options.num_ctx, 8192);
      }
    );
  });
});
