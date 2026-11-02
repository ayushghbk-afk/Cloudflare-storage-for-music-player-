import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../worker/src/auth/password';
import { createRefreshToken, hashRefreshToken, parseBearer, signAccessToken, verifyAccessToken } from '../../worker/src/auth/tokens';
import { TEST_SECRET } from '../support/env';

describe('password hashing', () => {
  it('produces a self-describing hash and verifies it', async () => {
    const hash = await hashPassword('correct horse battery staple', 50_000);
    expect(hash).toMatch(/^pbkdf2-sha256\$50000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect((await verifyPassword('correct horse battery staple', hash)).valid).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple', 50_000);
    expect((await verifyPassword('Correct horse battery staple', hash)).valid).toBe(false);
    expect((await verifyPassword('', hash)).valid).toBe(false);
  });

  it('uses a unique salt per hash', async () => {
    const first = await hashPassword('same-password-value', 50_000);
    const second = await hashPassword('same-password-value', 50_000);
    expect(first).not.toBe(second);
    expect((await verifyPassword('same-password-value', first)).valid).toBe(true);
    expect((await verifyPassword('same-password-value', second)).valid).toBe(true);
  });

  it('flags hashes with weaker parameters for rehashing', async () => {
    const hash = await hashPassword('needs-upgrade', 50_000);
    expect((await verifyPassword('needs-upgrade', hash)).needsRehash).toBe(true);
  });

  it('rejects malformed stored hashes instead of throwing', async () => {
    for (const malformed of ['', 'plaintext', 'pbkdf2-sha256$abc$x$y', 'bcrypt$10$x$y', 'pbkdf2-sha256$100$#$#']) {
      const result = await verifyPassword('anything', malformed);
      expect(result.valid).toBe(false);
    }
  });

  it('rejects out-of-range iteration counts', async () => {
    const result = await verifyPassword('x', 'pbkdf2-sha256$10$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(result.valid).toBe(false);
  });
});

describe('tokens', () => {
  const claims = { sub: 'usr_123', email: 'listener@example.com', role: 'user' as const, sid: 'ses_123' };
  const options = { ttlSeconds: 600, issuer: 'aether-test' };

  it('signs and verifies an access token', async () => {
    const { token, expiresAt } = await signAccessToken(TEST_SECRET, claims, options);
    expect(token.split('.')).toHaveLength(3);
    const verified = await verifyAccessToken(TEST_SECRET, token, options.issuer);
    expect(verified?.sub).toBe('usr_123');
    expect(verified?.role).toBe('user');
    expect(verified?.sid).toBe('ses_123');
    expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects a token signed with another secret', async () => {
    const { token } = await signAccessToken(`${TEST_SECRET}-other`, claims, options);
    expect(await verifyAccessToken(TEST_SECRET, token, options.issuer)).toBeNull();
  });

  it('rejects a token from another issuer', async () => {
    const { token } = await signAccessToken(TEST_SECRET, claims, options);
    expect(await verifyAccessToken(TEST_SECRET, token, 'someone-else')).toBeNull();
  });

  it('rejects expired tokens', async () => {
    const { token } = await signAccessToken(TEST_SECRET, claims, { ttlSeconds: -10, issuer: options.issuer });
    expect(await verifyAccessToken(TEST_SECRET, token, options.issuer)).toBeNull();
  });

  it('rejects tampered tokens', async () => {
    const { token } = await signAccessToken(TEST_SECRET, claims, options);
    const [header, payload, signature] = token.split('.');
    const tampered = `${header}.${payload}.${signature!.slice(0, -2)}xx`;
    expect(await verifyAccessToken(TEST_SECRET, tampered, options.issuer)).toBeNull();
  });

  it('creates high-entropy refresh tokens and hashes them deterministically', () => {
    const first = createRefreshToken();
    const second = createRefreshToken();
    expect(first.token).not.toBe(second.token);
    expect(first.token).toHaveLength(64);
    expect(first.hash).toBe(hashRefreshToken(first.token));
    expect(first.hash).not.toContain(first.token);
  });

  it('parses bearer headers', () => {
    expect(parseBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(parseBearer('bearer  token')).toBe('token');
    expect(parseBearer('Basic abc')).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
  });
});
