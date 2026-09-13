/**
 * MCP server bootstrap for salesforce-mcp.
 *
 * Per-request stateless model: each call to /mcp creates a fresh MCP Server
 * + StreamableHTTPServerTransport pair. Credentials are extracted from the
 * incoming request headers and used to build a jsforce.Connection that
 * services the call. No cross-request state is held.
 *
 * In stdio mode (for standalone testing), credentials are read from env
 * once at startup and a single jsforce.Connection is held for the process
 * lifetime.
 */

import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'node:http';
import type { Server as HttpServer } from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from 'jsforce';

import type { EnvironmentConfig, SalesforceCredentials } from '../utils/config.js';
import {
  parseCredentialsFromEnv,
  parseCredentialsFromHeaders,
  validateCredentials,
} from '../utils/config.js';
import { Logger } from '../utils/logger.js';
import { buildConnection } from '../services/connection.js';
import { SALESFORCE_TOOLS, callTool } from '../tools/index.js';
import { verifyS2sHeader, S2S_HEADER } from '../s2s-verify.js';

const SERVER_NAME = 'salesforce-mcp';
const SERVER_VERSION = '0.1.0';
const MCP_PATH = '/mcp';

// Conduit service-to-service auth (gateway#377 parity). Non-empty =
// enforce X-Gateway-S2S on every /mcp request; empty = disabled, behavior
// exactly as before (dark-by-default until the gateway provisions this
// container's derived subkey). See src/s2s-verify.ts.
const S2S_SECRET = process.env.CONDUIT_S2S_SECRET || '';

export class SalesforceMcpServer {
  private httpServer: HttpServer | undefined;

  constructor(
    private readonly envConfig: EnvironmentConfig,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.envConfig.transport.type === 'stdio') {
      await this.startStdio();
    } else {
      await this.startHttp();
    }
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = undefined;
    }
  }

  // ─────────────────────── stdio mode ───────────────────────

  private async startStdio(): Promise<void> {
    // Read creds once from env; warn but don't crash if missing.
    const creds = parseCredentialsFromEnv();
    const problems = validateCredentials(creds);
    if (problems.length) {
      this.logger.warn(
        'Stdio mode: missing or incomplete credentials in env. Tool calls will fail until SALESFORCE_* env vars are set.',
        { problems },
      );
    }

    const mcp = this.buildMcpServer(async () => {
      if (validateCredentials(creds).length) {
        throw new Error(
          'No Salesforce credentials configured. Set SALESFORCE_CLIENT_ID/SECRET/INSTANCE_URL or SALESFORCE_USERNAME/PASSWORD.',
        );
      }
      const result = await buildConnection(creds);
      return result.connection;
    });

    const transport = new StdioServerTransport();
    await mcp.connect(transport);
    this.logger.info('salesforce-mcp connected to stdio transport');
  }

  // ─────────────────────── http mode ───────────────────────

  private async startHttp(): Promise<void> {
    const { host, port } = this.envConfig.transport;

    this.httpServer = createHttpServer(async (req, res) => {
      try {
        await this.handleHttpRequest(req, res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error('Unhandled HTTP error', { err: message });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error', message }));
        }
      }
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(port, host, () => {
        this.logger.info(
          `salesforce-mcp listening on http://${host}:${port}${MCP_PATH} (health: /health)`,
          { build: this.envConfig.build, authMode: this.envConfig.authMode, s2sEnforced: S2S_SECRET !== '' },
        );
        resolve();
      });
    });
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // ── /health: no auth, gateway probe target ──
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          transport: 'http',
          authMode: this.envConfig.authMode,
          serverName: SERVER_NAME,
          serverVersion: SERVER_VERSION,
          build: this.envConfig.build,
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    // ── /mcp: gateway-proxied MCP JSON-RPC ──
    if (url.pathname === MCP_PATH) {
      // S2S guard runs first: a forged request must never reach credential
      // handling, where the first tool call would mint a jsforce.Connection.
      if (S2S_SECRET && !verifyS2sHeader(req.headers[S2S_HEADER] as string | undefined, S2S_SECRET)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error:
              'Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.',
          }),
        );
        return;
      }
      await this.handleMcpRequest(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
  }

  private async handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const creds = this.resolveCredentials(req);
    const problems = validateCredentials(creds);
    if (problems.length) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'invalid_credentials',
          message: 'Salesforce credentials missing or invalid in request headers.',
          details: problems,
        }),
      );
      return;
    }

    // Build a per-request MCP server. The jsforce.Connection is lazy-built
    // inside the tool dispatcher so list-tools calls don't pay the OAuth
    // round-trip — only actual tool calls do.
    let cachedConnection: Connection | null = null;
    const getConnection = async (): Promise<Connection> => {
      if (cachedConnection) return cachedConnection;
      const result = await buildConnection(creds);
      cachedConnection = result.connection;
      return cachedConnection;
    };

    const mcp = this.buildMcpServer(getConnection);
    // Stateless mode: no session id, every initialize is independent.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      transport.close().catch(() => undefined);
      mcp.close().catch(() => undefined);
    });

    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  }

  // ─────────────────────── shared MCP builder ───────────────────────

  private buildMcpServer(getConnection: () => Promise<Connection>): Server {
    const server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: { listChanged: false } } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = SALESFORCE_TOOLS;
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      try {
        const connection = await getConnection();
        const result = await callTool(name, args, { connection });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error('Tool call failed', { name, err: message });
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
          isError: true,
        };
      }
    });

    return server;
  }

  private resolveCredentials(req: IncomingMessage): SalesforceCredentials {
    if (this.envConfig.authMode === 'env') {
      return parseCredentialsFromEnv();
    }
    return parseCredentialsFromHeaders(
      req.headers as Record<string, string | string[] | undefined>,
    );
  }
}
