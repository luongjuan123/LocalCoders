import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentConfig, CriticConfig, PredefinedRole } from './types';

export class AgentRegistry {
  private mainAgent: AgentConfig | null = null;
  private subagents: Map<string, AgentConfig> = new Map();
  private criticConfig: CriticConfig = {
    enabled: true,
    model: '',
    strictness: 'strict',
    categories: [
      'Logical correctness',
      'Security vulnerabilities',
      'Authentication and authorization',
      'SQL injection',
      'XSS and input validation',
      'Race conditions',
      'Memory leaks',
      'Performance bottlenecks',
      'Architectural weaknesses',
      'Error handling and edge cases',
      'Test coverage',
      'Requirement violations',
    ],
    trigger: 'on_diff',
    reviewMode: 'changed_files',
  };

  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.loadState();
  }

  // Predefined Roles definition with customized expert system prompts
  static getPredefinedRoles(): Array<{ role: PredefinedRole; defaultPrompt: string }> {
    return [
      {
        role: 'Frontend Developer',
        defaultPrompt:
          'You are an expert Frontend Developer. You specialize in building accessible, highly responsive, performant user interfaces, components, styling, and clientside state management. You strictly adhere to the UI/UX Pro Max design intelligence (.agents/skills/ui-ux-pro-max/SKILL.md and design-system/localcoders/MASTER.md), using vector SVGs instead of emojis, OLED dark theme tokens, and smooth 150-250ms transitions.',
      },
      {
        role: 'UI/UX Designer',
        defaultPrompt:
          'You are a Lead UI/UX Designer and Design Systems Architect. You master visual hierarchy, Dark Mode developer tool aesthetics, spacing variables, typography scales (JetBrains Mono / IBM Plex Sans), and WCAG AAA/AA accessibility compliance. You query the UI/UX Pro Max design engine for all UI component specifications.',
      },
      {
        role: 'Component Specialist',
        defaultPrompt:
          'You are a Frontend Component Specialist. You build modular, pixel-perfect, accessible UI controls (popovers, segmented bars, modals, search inputs, status badges) with precision SVG vector icons and zero emoji decorators.',
      },
      {
        role: 'Backend Developer',
        defaultPrompt:
          'You are a senior Backend Developer. You specialize in scalable server architectures, REST/GraphQL APIs, service layers, microservices, business logic, asynchronous processing, and robust data pipelines with error handling.',
      },
      {
        role: 'Software Architect',
        defaultPrompt:
          'You are a Principal Software Architect. You specialize in system decomposition, domain modeling, clean architecture, SOLID principles, design patterns, separation of concerns, and future-proof abstractions.',
      },
      {
        role: 'Database Engineer',
        defaultPrompt:
          'You are a Database Engineer. You specialize in relational and NoSQL database schemas, normalization, migrations, query optimization, indexing strategies, ACID guarantees, transaction safety, and data integrity.',
      },
      {
        role: 'Debugging Specialist',
        defaultPrompt:
          'You are a Debugging Specialist. You specialize in root-cause analysis, isolating subtle bugs, analyzing stack traces, hunting race conditions, memory leaks, null references, and verifying hypotheses with minimal reproducible tests.',
      },
      {
        role: 'Test Engineer',
        defaultPrompt:
          'You are a Senior Test Engineer. You specialize in test-driven development, comprehensive unit tests, integration suites, edge case boundary validation, mocking external services, and regression testing.',
      },
      {
        role: 'Security Auditor',
        defaultPrompt:
          'You are a Cybersecurity and Application Security Auditor. You specialize in identifying OWASP Top 10 vulnerabilities, injection flaws, authentication bypasses, privilege escalations, insecure deserialization, and secrets management.',
      },
      {
        role: 'Performance Engineer',
        defaultPrompt:
          'You are a Performance Engineer. You specialize in computational complexity (Big-O), memory allocation profiling, concurrency optimization, caching strategies, I/O efficiency, and eliminating latency bottlenecks.',
      },
      {
        role: 'Documentation Writer',
        defaultPrompt:
          'You are a Technical Documentation Specialist. You craft lucid, comprehensive markdown documentation, architectural diagrams, API references, configuration guides, and inline docstrings.',
      },
      {
        role: 'Research Agent',
        defaultPrompt:
          'You are an AI Research Agent. You explore dependencies, compare libraries, investigate standard specifications, synthesize algorithms, and formulate evidence-based implementation recommendations.',
      },
      {
        role: 'Refactoring Specialist',
        defaultPrompt:
          'You are a Code Refactoring Specialist. You eliminate code smells and technical debt while strictly preserving observable behavior and ensuring tests pass continuously.',
      },
    ];
  }

  getMainAgent(): AgentConfig | null {
    return this.mainAgent;
  }

  setMainAgent(config: AgentConfig) {
    this.mainAgent = config;
    this.saveState();
  }

  getSubagents(): AgentConfig[] {
    return Array.from(this.subagents.values());
  }

  /**
   * Default specialist roster used at runtime when no custom subagents have been configured yet,
   * sharing the active coding model so local single-GPU Ollama instances incur zero model swap lag.
   */
  static getDefaultBuiltinSubagents(modelId: string): AgentConfig[] {
    const roles = AgentRegistry.getPredefinedRoles();
    const rolePrompt = (r: PredefinedRole) =>
      roles.find((x) => x.role === r)?.defaultPrompt || `You are a specialist ${r}.`;
    const mk = (id: string, name: string, role: PredefinedRole, temperature = 0.2): AgentConfig => ({
      id,
      name,
      role,
      model: modelId,
      systemPrompt: rolePrompt(role),
      enabled: true,
      maxConcurrency: 1,
      temperature,
      contextWindow: 32768,
    });
    return [
      mk('builtin_frontend', 'Frontend Specialist', 'Frontend Developer', 0.2),
      mk('builtin_backend', 'Backend Specialist', 'Backend Developer', 0.2),
      mk('builtin_test', 'Test Engineer', 'Test Engineer', 0.1),
      mk('builtin_debug', 'Debugging Specialist', 'Debugging Specialist', 0.1),
    ];
  }

  /**
   * Returns all manageable subagent entries for configuration UIs (built-ins merged
   * with any saved overrides, plus custom subagents), preserving empty model = inherit.
   */
  getManageableSubagents(
    includeBuiltinDefaults = true
  ): Array<AgentConfig & { isBuiltin: boolean; isCustomized: boolean }> {
    const builtins = includeBuiltinDefaults ? AgentRegistry.getDefaultBuiltinSubagents('') : [];
    const builtinIds = new Set(builtins.map((b) => b.id));
    const result: Array<AgentConfig & { isBuiltin: boolean; isCustomized: boolean }> = [];

    for (const def of builtins) {
      const override = this.subagents.get(def.id);
      result.push({
        ...(override ? { ...def, ...override } : def),
        isBuiltin: true,
        isCustomized: Boolean(override),
      });
    }

    for (const custom of this.subagents.values()) {
      if (!builtinIds.has(custom.id)) {
        result.push({
          ...custom,
          isBuiltin: false,
          isCustomized: true,
        });
      }
    }

    return result;
  }

  /**
   * Returns active subagent configs (inheriting fallbackModelId when model is blank),
   * merging any saved per-subagent model/instruction/enabled overrides with built-in defaults
   * and custom user-created subagents.
   */
  getEffectiveSubagents(fallbackModelId: string, includeBuiltinDefaults = true): AgentConfig[] {
    const merged: AgentConfig[] = [];
    const seenIds = new Set<string>();

    if (includeBuiltinDefaults) {
      for (const def of AgentRegistry.getDefaultBuiltinSubagents('')) {
        const override = this.subagents.get(def.id);
        merged.push(override ? { ...def, ...override } : def);
        seenIds.add(def.id);
      }
    }

    for (const custom of this.subagents.values()) {
      if (!seenIds.has(custom.id)) {
        merged.push(custom);
        seenIds.add(custom.id);
      }
    }

    return merged
      .filter((s) => s.enabled)
      .map((s) => ({ ...s, model: (s.model || '').trim() || fallbackModelId }))
      .filter((s) => Boolean(s.model));
  }

  getSubagent(id: string): AgentConfig | undefined {
    return this.subagents.get(id);
  }

  addSubagent(config: AgentConfig) {
    this.subagents.set(config.id, config);
    this.saveState();
  }

  removeSubagent(id: string) {
    this.subagents.delete(id);
    this.saveState();
  }

  updateSubagent(id: string, updates: Partial<AgentConfig>) {
    const existing = this.subagents.get(id);
    if (existing) {
      this.subagents.set(id, { ...existing, ...updates });
      this.saveState();
      return;
    }

    const builtinDefault = AgentRegistry.getDefaultBuiltinSubagents('').find((b) => b.id === id);
    if (builtinDefault) {
      this.subagents.set(id, { ...builtinDefault, ...updates });
      this.saveState();
    }
  }

  getCriticConfig(): CriticConfig {
    return this.criticConfig;
  }

  setCriticConfig(config: Partial<CriticConfig>) {
    this.criticConfig = { ...this.criticConfig, ...config };
    this.saveState();
  }

  // State Persistence
  private saveState() {
    this.context.globalState.update('localcoders.mainAgent', this.mainAgent);
    this.context.globalState.update('localcoders.subagents', Array.from(this.subagents.values()));
    this.context.globalState.update('localcoders.criticConfig', this.criticConfig);

    // Also persist to workspace .localcoders/agents.json if workspace is opened
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const root = workspaceFolders[0].uri.fsPath;
      const dotDir = path.join(root, '.localcoders');
      try {
        if (!fs.existsSync(dotDir)) {
          fs.mkdirSync(dotDir, { recursive: true });
        }
        const data = {
          mainAgent: this.mainAgent,
          subagents: Array.from(this.subagents.values()),
          criticConfig: this.criticConfig,
        };
        fs.writeFileSync(path.join(dotDir, 'agents.json'), JSON.stringify(data, null, 2), 'utf-8');
      } catch (err) {
        console.error('[AgentRegistry] Failed to save to .localcoders/agents.json:', err);
      }
    }
  }

  private loadState() {
    // 1. Try reading from workspace .localcoders/agents.json
    let loadedFromWorkspace = false;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const configPath = path.join(workspaceFolders[0].uri.fsPath, '.localcoders', 'agents.json');
      if (fs.existsSync(configPath)) {
        try {
          const raw = fs.readFileSync(configPath, 'utf-8');
          const data = JSON.parse(raw);
          if (data.mainAgent) this.mainAgent = data.mainAgent;
          if (Array.isArray(data.subagents)) {
            this.subagents.clear();
            for (const sub of data.subagents) {
              this.subagents.set(sub.id, sub);
            }
          }
          if (data.criticConfig) this.criticConfig = data.criticConfig;
          loadedFromWorkspace = true;
        } catch (e) {
          console.error('[AgentRegistry] Error parsing workspace agents.json:', e);
        }
      }
    }

    // 2. Fallback to globalState
    if (!loadedFromWorkspace) {
      const savedMain = this.context.globalState.get<AgentConfig>('localcoders.mainAgent');
      if (savedMain) this.mainAgent = savedMain;

      const savedSubs = this.context.globalState.get<AgentConfig[]>('localcoders.subagents');
      if (savedSubs && Array.isArray(savedSubs)) {
        this.subagents.clear();
        for (const s of savedSubs) {
          this.subagents.set(s.id, s);
        }
      }

      const savedCritic = this.context.globalState.get<CriticConfig>('localcoders.criticConfig');
      if (savedCritic) this.criticConfig = savedCritic;
    }
  }
}
