import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import type { JWK } from 'jose';
import { createTokenVerifier } from '../gateway/src/authentication.js';
import { audience, claims, clientId, listen, sign, signingKey } from './helpers.js';

describe('JWT verification against a real local mock JWKS endpoint', () => {
  let key: Awaited<ReturnType<typeof signingKey>>;
  let rotatedKey: Awaited<ReturnType<typeof signingKey>>;
  let provider: Awaited<ReturnType<typeof listen>>;
  let verify: ReturnType<typeof createTokenVerifier>;
  let hits: number;
  let keys: JWK[];
  let available: boolean;
  beforeAll(async () => { [key, rotatedKey] = await Promise.all([signingKey('one'), signingKey('two')]); });
  beforeEach(async () => {
    hits = 0; keys = [key.jwk]; available = true;
    provider = await listen((_req, res) => {
      hits++;
      res.writeHead(available ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys }));
    });
    verify = createTokenVerifier({ issuer: provider.url, audience, clientId, jwksUrl: new URL(provider.url) });
  });
  afterEach(async () => { vi.restoreAllMocks(); await provider.close(); });

  it('verifies the signature, returns the immutable subject and reuses cached keys', async () => {
    const token = await sign(key, claims(provider.url));
    expect(await verify(token)).toEqual({ userId: 'user-123', scope: `${audience}/users` });
    await Promise.all(Array.from({ length: 8 }, () => verify(token)));
    expect(hits).toBe(1);
  });
  it('coalesces concurrent cold-cache fetches', async () => {
    const token = await sign(key, claims(provider.url));
    await Promise.all(Array.from({ length: 8 }, () => verify(token)));
    expect(hits).toBe(1);
  });
  it.each([
    ['expired', { exp: 1 }], ['wrong issuer', { iss: 'https://attacker.invalid' }],
    ['wrong audience', { aud: 'another-api' }], ['future not-before', { nbf: 9999999999 }],
    ['ID token', { token_use: 'id' }], ['wrong client', { client_id: 'another-client' }],
    ['empty subject', { sub: '' }], ['unsafe subject', { sub: 'user\r\nInjected: yes' }],
    ['ambiguous subject', { sub: 'user,other' }], ['oversized subject', { sub: 'a'.repeat(256) }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(verify(await sign(key, { ...claims(provider.url), ...overrides }))).rejects.toThrow();
  });
  it.each(['exp', 'iss', 'aud', 'sub', 'client_id', 'token_use'])('requires %s', async claim => {
    const payload = claims(provider.url);
    delete payload[claim];
    await expect(verify(await sign(key, payload))).rejects.toThrow();
  });
  it('supports an audience list containing the expected API audience', async () => {
    expect(await verify(await sign(key, { ...claims(provider.url), aud: ['another-api', audience] }))).toMatchObject({ userId: 'user-123' });
  });
  it('leaves scope authorization to the policy layer', async () => {
    const payload = claims(provider.url); delete payload.scope;
    expect(await verify(await sign(key, payload))).toEqual({ userId: 'user-123', scope: '' });
  });
  it('rejects a different signature even if the kid matches', async () => {
    await expect(verify(await sign(rotatedKey, claims(provider.url), 'one'))).rejects.toThrow();
  });
  it('rejects algorithm confusion and unsigned tokens', async () => {
    const token = await new SignJWT(claims(provider.url)).setProtectedHeader({ alg: 'HS256', kid: 'one' }).sign(new Uint8Array(32));
    await expect(verify(token)).rejects.toThrow();
    await expect(verify('eyJhbGciOiJub25lIn0.eyJzdWIiOiJhIn0.')).rejects.toThrow();
    expect(hits).toBe(0);
  });
  it('throttles unknown-kid refreshes then accepts legitimate key rotation', async () => {
    await verify(await sign(key, claims(provider.url)));
    keys = [key.jwk, rotatedKey.jwk];
    const rotated = await sign(rotatedKey, claims(provider.url));
    for (let i = 0; i < 3; i++) await expect(verify(rotated)).rejects.toThrow();
    expect(hits).toBe(1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31000);
    await expect(verify(rotated)).resolves.toMatchObject({ userId: 'user-123' });
    expect(hits).toBe(2);
  });
  it('uses fresh cached keys during an outage, then fails closed after expiry', async () => {
    const token = await sign(key, claims(provider.url));
    await verify(token);
    available = false;
    await expect(verify(token)).resolves.toBeDefined();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 601000);
    await expect(verify(token)).rejects.toThrow();
    expect(hits).toBe(2);
  });
  it('fails closed when the provider is unavailable on cold start', async () => {
    available = false;
    await expect(verify(await sign(key, claims(provider.url)))).rejects.toThrow();
  });
});
