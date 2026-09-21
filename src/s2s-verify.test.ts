import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyS2sHeader } from './s2s-verify.js';

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

  it('rejects when the secret is empty (dark-by-default guarantee)', () => {
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
