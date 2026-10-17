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
 * lifetime. Stdio does not use CONDUIT_S2S_SECRET.
 *
 * HTTP mode refuses to start unless CONDUIT_S2S_SECRET is a real secret.
 * MCP_ALLOW_INSECURE_DEV=1 is local-only and listens on 127.0.0.1. Gateway
 * mode requires X-Salesforce-* headers and does not fall back to env.
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
import {
  isUsableConduitS2sSecret,
  resolveHttpListenHost,
  verifyS2sHeader,
  S2S_HEADER,
} from '../s2s-verify.js';

const SERVER_NAME = 'salesforce-mcp';
const SERVER_VERSION = '0.1.0';
const MCP_PATH = '/mcp';

function headerString(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A duplicated or empty S2S header is not a proof. Fail closed. */
function s2sHeaderValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Gateway mode has no env fallback. Returns the header names still required
 * for the flow declared by X-Salesforce-Auth-Mode, or null when the request
 * carries them.
 */
function missingGatewayCredentialHeaders(
  headers: IncomingMessage['headers'],
): string[] | null {
  if (headerString(headers['x-salesforce-auth-mode']) === 'username_password') {
    const required = [
      ['x-salesforce-username', 'X-Salesforce-Username'],
      ['x-salesforce-password', 'X-Salesforce-Password'],
    ] as const;
    const missing = required
      .filter(([name]) => !headerString(headers[name]))
      .map(([, label]) => label);
    return missing.length > 0 ? missing : null;
  }

  const required = [
    ['x-salesforce-client-id', 'X-Salesforce-Client-Id'],
    ['x-salesforce-client-secret', 'X-Salesforce-Client-Secret'],
    ['x-salesforce-instance-url', 'X-Salesforce-Instance-Url'],
  ] as const;
  const missing = required
    .filter(([name]) => !headerString(headers[name]))
    .map(([, label]) => label);
  return missing.length > 0 ? missing : null;
}

export class SalesforceMcpServer {
  private httpServer: HttpServer | undefined;
  /** Set at HTTP startup. Empty only when MCP_ALLOW_INSECURE_DEV=1. */
  private s2sSecret = '';

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

  /** TCP address the HTTP transport bound, if it is listening. */
  boundAddress(): { address: string; port: number } | undefined {
    const address = this.httpServer?.address();
    if (!address || typeof address === 'string') return undefined;
    return { address: address.address, port: address.port };
  }

  /**
   * Secret for X-Gateway-S2S. Read at HTTP startup, not per request.
   * Empty and known placeholders are fail-closed: the process exits unless
   * MCP_ALLOW_INSECURE_DEV=1. The secret value is never written to logs.
   */
  private resolveHttpS2sSecret(): string {
    const trimmed = (process.env.CONDUIT_S2S_SECRET ?? '').trim();
    if (isUsableConduitS2sSecret(trimmed)) return trimmed;

    const placeholder = trimmed.length > 0;
    if (process.env.MCP_ALLOW_INSECURE_DEV === '1') {
      const why = placeholder
        ? 'CONDUIT_S2S_SECRET is a known placeholder'
        : 'CONDUIT_S2S_SECRET is empty';
      this.logger.error(
        `SECURITY WARNING: ${why} and MCP_ALLOW_INSECURE_DEV=1. ` +
          'HTTP /mcp is not enforcing X-Gateway-S2S and listens on 127.0.0.1 only. ' +
          'Do not use this outside local development.',
      );
      return '';
    }

    const why = placeholder
      ? 'CONDUIT_S2S_SECRET is a known placeholder value, not a real service-to-service secret.'
      : 'CONDUIT_S2S_SECRET is empty.';
    this.logger.error(
      `Refusing to start HTTP transport: ${why} ` +
        'An empty or placeholder secret would accept unauthenticated /mcp requests (CWE-306). ' +
        'Set CONDUIT_S2S_SECRET to the gateway-provisioned secret, or set MCP_ALLOW_INSECURE_DEV=1 for local development only.',
    );
    process.exit(1);
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
    const s2sSecret = this.resolveHttpS2sSecret();
    const listen = resolveHttpListenHost({
      s2sSecret,
      configuredHost: this.envConfig.transport.host,
      explicitHost: process.env.MCP_HTTP_HOST,
    });
    if (listen.overriddenHost !== undefined) {
      this.logger.error(
        `WARNING: MCP_HTTP_HOST=${listen.overriddenHost} is not 127.0.0.1. ` +
          'MCP_ALLOW_INSECURE_DEV=1 without a usable CONDUIT_S2S_SECRET cannot listen there. ' +
          'Binding 127.0.0.1 only.',
      );
    }
    this.s2sSecret = s2sSecret;
    const host = listen.host;
    const { port } = this.envConfig.transport;

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
          { build: this.envConfig.build, authMode: this.envConfig.authMode, s2sEnforced: this.s2sSecret !== '' },
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
      // An empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1;
      // startup refuses otherwise. A configured secret is always enforced.
      if (
        this.s2sSecret &&
        !verifyS2sHeader(s2sHeaderValue(req.headers[S2S_HEADER]), this.s2sSecret)
      ) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error:
              'Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.',
          }),
        );
        return;
      }

      // Gateway mode: credentials must arrive on this request. Falling
      // through would resolve SALESFORCE_* from the process environment.
      if (this.envConfig.authMode === 'gateway') {
        const missing = missingGatewayCredentialHeaders(req.headers);
        if (missing) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'Missing credentials',
              message: `Gateway mode requires ${missing.join(', ')} headers`,
              required: missing,
            }),
          );
          return;
        }
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
