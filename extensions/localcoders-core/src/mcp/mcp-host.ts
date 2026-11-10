import * as fs from 'fs';
import * as path from 'path';
import { ToolDefinition, ToolResult, ToolExecutionContext } from '../tools/types';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
}

export interface McpConnectedServer {
  config: McpServerConfig;
  client: any;
  transport: any;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  error?: string;
  tools: any[];
  resources: any[];
  prompts: any[];
}

export class McpHost {
  private servers: Map<string, McpConnectedServer> = new Map();
  private readonly configPath: string;

  constructor(private workspaceRoot: string) {
    this.configPath = path.join(workspaceRoot, '.localcoders', 'mcp.json');
    this.loadServers();
  }

  public setWorkspace(newRoot: string): void {
    this.workspaceRoot = newRoot;
    (this as any).configPath = path.join(newRoot, '.localcoders', 'mcp.json');
    this.loadServers();
  }

  public getAllServers(): McpConnectedServer[] {
    return Array.from(this.servers.values());
  }

  public getServer(id: string): McpConnectedServer | undefined {
    return this.servers.get(id);
  }

  public async addServer(config: McpServerConfig): Promise<void> {
    this.servers.set(config.id, {
      config,
      client: null,
      transport: null,
      status: 'disconnected',
      tools: [],
      resources: [],
      prompts: [],
    });
    this.saveServers();
    if (config.enabled) {
      await this.connectServer(config.id);
    }
  }

  public async removeServer(id: string): Promise<void> {
    await this.disconnectServer(id);
    this.servers.delete(id);
    this.saveServers();
  }

  public async connectServer(id: string): Promise<boolean> {
    const s = this.servers.get(id);
    if (!s) return false;

    try {
      s.status = 'connecting';
      s.error = undefined;

      const { Client } = require('@modelcontextprotocol/sdk/client');
      const client = new Client(
        {
          name: `LocalCoders-${id}`,
          version: '1.0.0',
        },
        {
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
        }
      );

      let transport: any;
      if (s.config.transport === 'stdio') {
        const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
        transport = new StdioClientTransport({
          command: s.config.command || 'node',
          args: s.config.args || [],
          env: { ...process.env, ...(s.config.env || {}) },
        });
      } else {
        const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
        transport = new SSEClientTransport(new URL(s.config.url || 'http://localhost:3000/sse'));
      }

      await client.connect(transport);
      s.client = client;
      s.transport = transport;
      s.status = 'connected';

      // Discover capabilities
      try {
        const toolsRes = await client.listTools();
        s.tools = toolsRes.tools || [];
      } catch {
        s.tools = [];
      }

      try {
        const resRes = await client.listResources();
        s.resources = resRes.resources || [];
      } catch {
        s.resources = [];
      }

      try {
        const promptsRes = await client.listPrompts();
        s.prompts = promptsRes.prompts || [];
      } catch {
        s.prompts = [];
      }

      return true;
    } catch (err: any) {
      s.status = 'error';
      s.error = err.message;
      return false;
    }
  }

  public async disconnectServer(id: string): Promise<void> {
    const s = this.servers.get(id);
    if (!s) return;
    try {
      if (s.client) {
        await s.client.close();
      }
    } catch {
      // ignore
    } finally {
      s.client = null;
      s.transport = null;
      s.status = 'disconnected';
      s.tools = [];
    }
  }

  public async connectAllEnabled(): Promise<void> {
    for (const [id, s] of this.servers) {
      if (s.config.enabled && s.status !== 'connected') {
        await this.connectServer(id);
      }
    }
  }

  public async disconnectAll(): Promise<void> {
    for (const [id] of this.servers) {
      await this.disconnectServer(id);
    }
  }

  public getDiscoveredToolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const [serverId, s] of this.servers) {
      if (s.status !== 'connected') continue;
      for (const t of s.tools) {
        defs.push({
          name: `mcp__${serverId}__${t.name}`,
          category: 'mcp',
          description: `[MCP Server: ${s.config.name}] ${t.description || ''}`,
          parameters: t.inputSchema || { type: 'object', properties: {} },
          permissionLevel: 'execute',
          supportedRoles: ['Main Agent', 'Backend Developer', 'Frontend Developer', 'Research Agent'],
        });
      }
    }
    return defs;
  }

  public async executeMcpTool(
    serverId: string,
    toolName: string,
    args: Record<string, any>,
    ctx: ToolExecutionContext
  ): Promise<ToolResult> {
    const s = this.servers.get(serverId);
    if (!s || s.status !== 'connected' || !s.client) {
      return { success: false, error: `MCP Server '${serverId}' is not connected.` };
    }

    if (ctx.requireApproval) {
      const approved = await ctx.requestApproval({
        id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        toolCallId: `call_${Date.now()}`,
        agentId: ctx.agentId,
        agentName: ctx.agentName,
        tool: `mcp__${serverId}__${toolName}`,
        args,
        description: `Execute external MCP tool '${toolName}' on server '${s.config.name}'`,
        isDestructive: false,
      });
      if (!approved) {
        return { success: false, error: 'User rejected MCP tool execution.' };
      }
    }

    try {
      const result = await s.client.callTool({
        name: toolName,
        arguments: args,
      });
      return {
        success: !result.isError,
        output: result.content,
        error: result.isError ? JSON.stringify(result.content) : undefined,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private saveServers(): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.servers.values()).map((s) => s.config);
      fs.writeFileSync(this.configPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // ignore
    }
  }

  private loadServers(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const configs: McpServerConfig[] = JSON.parse(raw);
        for (const c of configs) {
          this.servers.set(c.id, {
            config: c,
            client: null,
            transport: null,
            status: 'disconnected',
            tools: [],
            resources: [],
            prompts: [],
          });
        }
      }
    } catch {
      // ignore
    }
  }
}
