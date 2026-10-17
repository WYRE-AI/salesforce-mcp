import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { isUsableConduitS2sSecret, resolveHttpListenHost, verifyS2sHeader } from './s2s-verify.js';

function mintHeader(secret: string, unixSeconds: number): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

describe('verifyS2sHeader', () => {
  const SECRET = 'test-derived-subkey-do-not-use-in-prod';

  it('accepts a header minted with the correct secret', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifyS2sHeader(mintHeader(SECRET, now), SECRET)).toBe(true);
  });

  it('rejects a header minted with a different secret (wrong sidecar cannot forge)', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifyS2sHeader(mintHeader('a-different-secret', now), SECRET)).toBe(false);
  });

  it('rejects a stale timestamp outside the skew window', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifyS2sHeader(mintHeader(SECRET, now - 301), SECRET)).toBe(false);
  });

  it('rejects a future timestamp outside the skew window', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifyS2sHeader(mintHeader(SECRET, now + 301), SECRET)).toBe(false);
  });

  it('accepts a timestamp at the edge of the skew window', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifyS2sHeader(mintHeader(SECRET, now - 300), SECRET)).toBe(true);
  });

  it('rejects a malformed header value', () => {
    expect(verifyS2sHeader('not-a-valid-header', SECRET)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyS2sHeader(undefined, SECRET)).toBe(false);
  });

  it('rejects when the secret is empty', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifyS2sHeader(mintHeader(SECRET, now), '')).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const now = Math.floor(Date.now() / 1000);
    const header = mintHeader(SECRET, now);
    const tampered = header.slice(0, -1) + (header.endsWith('0') ? '1' : '0');
    expect(verifyS2sHeader(tampered, SECRET)).toBe(false);
  });
});

describe('isUsableConduitS2sSecret', () => {
  it('accepts a non-placeholder secret and ignores surrounding whitespace', () => {
    expect(isUsableConduitS2sSecret('  gateway-provisioned-subkey  ')).toBe(true);
  });

  it('rejects empty, whitespace, known placeholders, and unresolved templates', () => {
    expect(isUsableConduitS2sSecret(undefined)).toBe(false);
    expect(isUsableConduitS2sSecret('')).toBe(false);
    expect(isUsableConduitS2sSecret('   ')).toBe(false);
    for (const placeholder of ['changeme', 'Change-Me', 'placeholder', 'your-s2s-secret', 'secret', 'password', 'test']) {
      expect(isUsableConduitS2sSecret(placeholder)).toBe(false);
    }
    expect(isUsableConduitS2sSecret('  ${user_config.conduit_s2s_secret}  ')).toBe(false);
  });
});

describe('resolveHttpListenHost', () => {
  it('honors MCP_HTTP_HOST when a secret is configured', () => {
    expect(resolveHttpListenHost({
      s2sSecret: 'real-secret',
      configuredHost: '127.0.0.1',
      explicitHost: '0.0.0.0',
    })).toEqual({ host: '0.0.0.0', overriddenHost: undefined });
  });

  it('keeps the configured host when the secret is set and MCP_HTTP_HOST is unset', () => {
    expect(resolveHttpListenHost({
      s2sSecret: 'real-secret',
      configuredHost: '10.1.2.3',
      explicitHost: undefined,
    })).toEqual({ host: '10.1.2.3', overriddenHost: undefined });
  });

  it('binds 127.0.0.1 when there is no secret', () => {
    expect(resolveHttpListenHost({
      s2sSecret: '',
      configuredHost: '0.0.0.0',
      explicitHost: undefined,
    })).toEqual({ host: '127.0.0.1', overriddenHost: undefined });
  });

  it('forces 127.0.0.1 and reports a non-loopback MCP_HTTP_HOST when there is no secret', () => {
    expect(resolveHttpListenHost({
      s2sSecret: '',
      configuredHost: '10.1.2.3',
      explicitHost: ' 0.0.0.0 ',
    })).toEqual({ host: '127.0.0.1', overriddenHost: '0.0.0.0' });

    expect(resolveHttpListenHost({
      s2sSecret: '',
      configuredHost: '0.0.0.0',
      explicitHost: 'localhost',
    }).overriddenHost).toBe('localhost');

    expect(resolveHttpListenHost({
      s2sSecret: '',
      configuredHost: '0.0.0.0',
      explicitHost: '[::1]',
    }).overriddenHost).toBe('[::1]');
  });
});
