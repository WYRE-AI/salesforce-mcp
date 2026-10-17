/**
 * HTTP transport fail-closed auth.
 *
 * Startup requires a usable CONDUIT_S2S_SECRET unless MCP_ALLOW_INSECURE_DEV=1.
 * Known placeholders are treated as missing. That flag forces 127.0.0.1.
 * /mcp rejects a missing or invalid X-Gateway-S2S header.
 * AUTH_MODE=gateway rejects requests that omit credential headers and must
 * not fall back to SALESFORCE_* in process.env.
 */

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SalesforceMcpServer } from './server.js';
import type { EnvironmentConfig } from '../utils/config.js';
import { Logger } from '../utils/logger.js';

const S2S_SECRET = 's2s-do-not-log-7f3a';
const ENV_CLIENT_ID = 'env-client-id-must-not-be-used';
const ENV_CLIENT_SECRET = 'env-secret-must-not-be-used';
const ENV_INSTANCE_URL = 'https://env-must-not-be-used.my.salesforce.com';
const PLACEHOLDER = '${user_config.conduit_s2s_secret}';

const ENV_KEYS = [
  'CONDUIT_S2S_SECRET',
  'MCP_ALLOW_INSECURE_DEV',
  'MCP_HTTP_HOST',
  'AUTH_MODE',
  'SALESFORCE_AUTH_FLOW',
  'SALESFORCE_CLIENT_ID',
  'SALESFORCE_CLIENT_SECRET',
  'SALESFORCE_INSTANCE_URL',
  'SALESFORCE_USERNAME',
  'SALESFORCE_PASSWORD',
] as const;

const savedEnv = new Map<string, string | undefined>();

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  return {
    text: () => lines.join('\n'),
    restore: () => spy.mockRestore(),
  };
}

function envConfig(host: string, authMode: 'env' | 'gateway'): EnvironmentConfig {
  return {
    authMode,
    transport: { type: 'http', port: 0, host },
    logging: { level: 'info' },
    build: { version: 'test', commitSha: 'test', buildDate: 'test' },
  };
}

async function listen(
  host: string,
  authMode: 'env' | 'gateway' = 'gateway',
): Promise<{ port: number; address: string; close: () => Promise<void> }> {
  const server = new SalesforceMcpServer(envConfig(host, authMode), new Logger('info', true));
  await server.start();
  const bound = server.boundAddress();
  if (!bound) throw new Error('HTTP server did not bind a TCP port');
  return {
    port: bound.port,
    address: bound.address,
    close: () => server.stop(),
  };
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  };
}

const toolsList = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/list',
  params: {},
});

async function mcpBody(text: string, contentType: string | null): Promise<unknown> {
  if ((contentType ?? '').includes('text/event-stream')) {
    const dataLines = text.split('\n').filter((line) => line.startsWith('data:'));
    const last = dataLines[dataLines.length - 1];
    if (!last) return text;
    return JSON.parse(last.slice('data:'.length).trim()) as unknown;
  }
  return text ? (JSON.parse(text) as unknown) : text;
}

function assertNoSecrets(text: string): void {
  expect(text).not.toContain(S2S_SECRET);
  expect(text).not.toContain(ENV_CLIENT_ID);
  expect(text).not.toContain(ENV_CLIENT_SECRET);
  expect(text).not.toContain(ENV_INSTANCE_URL);
  expect(text).not.toContain(PLACEHOLDER);
}

function installEnvCredentials(): void {
  process.env.SALESFORCE_AUTH_FLOW = 'client_credentials';
  process.env.SALESFORCE_CLIENT_ID = ENV_CLIENT_ID;
  process.env.SALESFORCE_CLIENT_SECRET = ENV_CLIENT_SECRET;
  process.env.SALESFORCE_INSTANCE_URL = ENV_INSTANCE_URL;
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.MCP_HTTP_HOST;
  delete process.env.AUTH_MODE;
  delete process.env.SALESFORCE_AUTH_FLOW;
  delete process.env.SALESFORCE_CLIENT_ID;
  delete process.env.SALESFORCE_CLIENT_SECRET;
  delete process.env.SALESFORCE_INSTANCE_URL;
  delete process.env.SALESFORCE_USERNAME;
  delete process.env.SALESFORCE_PASSWORD;
});

describe('HTTP startup', () => {
  async function expectRefusal(assertLog: (text: string) => void): Promise<void> {
    const logs = captureStderr();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as typeof process.exit);

    try {
      const server = new SalesforceMcpServer(envConfig('0.0.0.0', 'gateway'), new Logger('info', true));
      await expect(server.start()).rejects.toThrow('process.exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
      const text = logs.text();
      assertLog(text);
      assertNoSecrets(text);
    } finally {
      exitSpy.mockRestore();
      logs.restore();
    }
  }

  it('refuses to start when CONDUIT_S2S_SECRET is unset', async () => {
    await expectRefusal((text) => {
      expect(text).toContain('Refusing to start HTTP transport');
      expect(text).toContain('CONDUIT_S2S_SECRET is empty');
      expect(text).toContain('CWE-306');
    });
  });

  it('refuses to start when CONDUIT_S2S_SECRET is a known placeholder', async () => {
    process.env.CONDUIT_S2S_SECRET = 'changeme';
    await expectRefusal((text) => {
      expect(text).toContain('Refusing to start HTTP transport');
      expect(text).toContain('known placeholder');
    });
  });

  it('refuses to start when CONDUIT_S2S_SECRET is an unresolved template', async () => {
    process.env.CONDUIT_S2S_SECRET = PLACEHOLDER;
    await expectRefusal((text) => {
      expect(text).toContain('known placeholder');
      expect(text).not.toContain(PLACEHOLDER);
    });
  });

  it('still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = 'true';
    await expectRefusal((text) => {
      expect(text).toContain('Refusing to start HTTP transport');
    });
  });

  it('allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1 and binds 127.0.0.1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    const logs = captureStderr();
    let close: (() => Promise<void>) | undefined;
    try {
      const server = await listen('0.0.0.0');
      close = server.close;
      expect(server.address).toBe('127.0.0.1');
      const text = logs.text();
      expect(text).toContain('SECURITY WARNING');
      expect(text).toContain('CONDUIT_S2S_SECRET is empty');
      expect(text).toContain('MCP_ALLOW_INSECURE_DEV=1');
      expect(text).toContain('127.0.0.1');
      expect(text).not.toContain('is not 127.0.0.1');
      assertNoSecrets(text);
    } finally {
      logs.restore();
      await close?.();
    }
  });

  it('forces 127.0.0.1 when the dev bypass is set and MCP_HTTP_HOST is not loopback', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    process.env.MCP_HTTP_HOST = '0.0.0.0';
    const logs = captureStderr();
    let close: (() => Promise<void>) | undefined;
    try {
      const server = await listen('10.1.2.3');
      close = server.close;
      expect(server.address).toBe('127.0.0.1');
      const text = logs.text();
      expect(text).toContain('MCP_HTTP_HOST=0.0.0.0 is not 127.0.0.1');
      expect(text).toContain('Binding 127.0.0.1 only');
      assertNoSecrets(text);
    } finally {
      logs.restore();
      await close?.();
    }
  });

  it('honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = '0.0.0.0';
    const server = await listen('127.0.0.1');
    try {
      expect(server.address).toBe('0.0.0.0');
    } finally {
      await server.close();
    }
  });

  it('keeps the configured host when the secret is set and MCP_HTTP_HOST is unset', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const server = await listen('0.0.0.0');
    try {
      expect(server.address).toBe('0.0.0.0');
    } finally {
      await server.close();
    }
  });
});

describe('HTTP /mcp authentication', () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = '127.0.0.1';
    installEnvCredentials();
  });

  it('returns 401 when the S2S header is missing or invalid and does not log the secret', async () => {
    const logs = captureStderr();
    const server = await listen('127.0.0.1', 'gateway');
    try {
      const missing = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders({
          'x-salesforce-client-id': 'header-client',
          'x-salesforce-client-secret': 'header-secret',
          'x-salesforce-instance-url': 'https://header.my.salesforce.com',
        }),
        body: toolsList,
      });
      const invalid = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders({
          'x-gateway-s2s': mintS2sHeader('wrong-secret'),
          'x-salesforce-client-id': 'header-client',
          'x-salesforce-client-secret': 'header-secret',
          'x-salesforce-instance-url': 'https://header.my.salesforce.com',
        }),
        body: toolsList,
      });

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      const missingText = await missing.text();
      const invalidText = await invalid.text();
      expect(missingText).toContain('X-Gateway-S2S');
      expect(invalidText).toContain('X-Gateway-S2S');
      assertNoSecrets(missingText);
      assertNoSecrets(invalidText);
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
      await server.close();
    }
  });

  it('returns 401 in gateway mode without credential headers and does not use env credentials', async () => {
    const server = await listen('127.0.0.1', 'gateway');
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
        body: toolsList,
      });
      const text = await response.text();

      expect(response.status).toBe(401);
      expect(text).toContain('Missing credentials');
      expect(text).toContain('X-Salesforce-Client-Id');
      expect(text).toContain('X-Salesforce-Client-Secret');
      expect(text).toContain('X-Salesforce-Instance-Url');
      assertNoSecrets(text);

      const partial = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders({
          'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
          'x-salesforce-client-id': 'header-client',
        }),
        body: toolsList,
      });
      expect(partial.status).toBe(401);
      assertNoSecrets(await partial.text());

      const passwordFlow = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders({
          'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
          'x-salesforce-auth-mode': 'username_password',
          'x-salesforce-username': 'user@example.com',
        }),
        body: toolsList,
      });
      const passwordText = await passwordFlow.text();
      expect(passwordFlow.status).toBe(401);
      expect(passwordText).toContain('X-Salesforce-Password');
      assertNoSecrets(passwordText);
    } finally {
      await server.close();
    }
  });

  it('accepts a valid S2S header plus credential headers', async () => {
    const logs = captureStderr();
    const server = await listen('127.0.0.1', 'gateway');
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders({
          'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
          'x-salesforce-client-id': 'header-client',
          'x-salesforce-client-secret': 'header-secret',
          'x-salesforce-instance-url': 'https://header.my.salesforce.com',
        }),
        body: toolsList,
      });
      const text = await response.text();
      const body = await mcpBody(text, response.headers.get('content-type'));

      expect(response.status).toBe(200);
      const tools = (body as { result?: { tools?: unknown[] } }).result?.tools;
      expect(Array.isArray(tools)).toBe(true);
      expect((tools ?? []).length).toBeGreaterThan(0);
      assertNoSecrets(text);
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
      await server.close();
    }
  });

  it('uses env credentials in AUTH_MODE=env only after a valid S2S header', async () => {
    const server = await listen('127.0.0.1', 'env');
    try {
      const missing = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders(),
        body: toolsList,
      });
      expect(missing.status).toBe(401);
      expect(await missing.text()).toContain('X-Gateway-S2S');

      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
        body: toolsList,
      });
      const text = await response.text();
      const body = await mcpBody(text, response.headers.get('content-type'));
      expect(response.status).toBe(200);
      const tools = (body as { result?: { tools?: unknown[] } }).result?.tools;
      expect(Array.isArray(tools)).toBe(true);
      expect((tools ?? []).length).toBeGreaterThan(0);
      assertNoSecrets(text);
    } finally {
      await server.close();
    }
  });

  it('serves /health without authentication and without reading credentials', async () => {
    const server = await listen('127.0.0.1', 'gateway');
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`);
      const text = await response.text();
      const body = JSON.parse(text) as { status?: string; authMode?: string };
      expect(response.status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.authMode).toBe('gateway');
      assertNoSecrets(text);
    } finally {
      await server.close();
    }
  });
});
