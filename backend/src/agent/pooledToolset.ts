import { MCPToolset } from '@google/adk/tools/mcp';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getConfig, type AppConfig } from '../config.js';
import {
  MCP_TOOLS_ALLOWED,
  buildMcpServerParams,
  callMcpTool,
  createMcpClient,
  type McpClientHandle,
  type ParsedToolResult,
} from './mcp.js';

interface SessionManagerLike {
  createSession(): Promise<Client>;
  closeSession(client: Client): Promise<void>;
  getActiveSessions(): Client[];
}

export class PooledMcpToolset {
  readonly toolset: MCPToolset;

  private handle: McpClientHandle | null = null;
  private connecting: Promise<McpClientHandle> | null = null;
  private closed = false;

  sessionRequests = 0;

  private constructor(
    private readonly config: AppConfig,
    toolFilter: readonly string[],
  ) {
    this.toolset = new MCPToolset(
      { type: 'StdioConnectionParams', serverParams: buildMcpServerParams(config) },
      [...toolFilter],
    );
    const manager: SessionManagerLike = {
      createSession: async () => {
        this.sessionRequests += 1;
        const handle = await this.connect();
        return handle.client;
      },
      closeSession: async () => undefined,
      getActiveSessions: () => (this.handle ? [this.handle.client] : []),
    };
    (this.toolset as unknown as { mcpSessionManager: SessionManagerLike }).mcpSessionManager = manager;
  }

  static async create(opts: { config?: AppConfig; toolFilter?: readonly string[] } = {}): Promise<PooledMcpToolset> {
    const config = opts.config ?? (await getConfig());
    return new PooledMcpToolset(config, opts.toolFilter ?? MCP_TOOLS_ALLOWED);
  }

  private async connect(): Promise<McpClientHandle> {
    if (this.closed) throw new Error('PooledMcpToolset is closed');
    if (this.handle) return this.handle;
    if (!this.connecting) {
      this.connecting = createMcpClient(this.config)
        .then((h) => {
          this.handle = h;
          return h;
        })
        .finally(() => {
          this.connecting = null;
        });
    }
    return this.connecting;
  }

  async warmup(): Promise<{ pid: number | null; serverVersion: string }> {
    const h = await this.connect();
    return { pid: h.pid, serverVersion: h.serverVersion };
  }

  get pid(): number | null {
    return this.handle?.pid ?? null;
  }

  get serverVersion(): string {
    return this.handle?.serverVersion ?? 'unknown';
  }

  stderrTail(n = 3): string[] {
    return this.handle?.stderr.tail(n) ?? [];
  }

  async callTool(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs = 60_000,
  ): Promise<{ raw: unknown; parsed: ParsedToolResult; duration_ms: number }> {
    const handle = await this.connect();
    return callMcpTool(handle, tool, args, timeoutMs);
  }

  async listServerTools(): Promise<string[]> {
    const handle = await this.connect();
    const list = await handle.client.listTools({}, { timeout: 20_000 });
    return list.tools.map((t) => t.name).sort();
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const handle = this.handle;
    this.handle = null;
    try {
      await (this.toolset as unknown as { close?: () => Promise<void> }).close?.();
    } catch {
    }
    if (handle) await handle.close();
  }
}
