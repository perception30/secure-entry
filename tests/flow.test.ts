import http from 'node:http';
import express from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGateway } from '../gateway/src/app.js';
import { createBackend } from '../backend/src/app.js';
import { audience, claims, clientId, listen, sign, signingKey } from './helpers.js';

describe('gateway -> backend over actual HTTP sockets', () => {
  let key: Awaited<ReturnType<typeof signingKey>>;
  let provider: Awaited<ReturnType<typeof listen>>;
  let backend: Awaited<ReturnType<typeof listen>>;
  let gateway: Awaited<ReturnType<typeof listen>>;
  let token: string;
  let forwarded: http.IncomingHttpHeaders[];
  let logs: Record<string, unknown>[];
  beforeAll(async () => { key = await signingKey('flow'); });
  beforeEach(async () => {
    forwarded = []; logs = [];
    provider = await listen((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ keys: [key.jwk] })); });
    const app = express();
    app.use((req, _res, next) => { forwarded.push(req.headers); next(); });
    app.use(createBackend());
    backend = await listen(app);
    gateway = await listen(createGateway({ issuer: provider.url, audience, clientId, jwksUrl: new URL(provider.url), backendUrl: new URL(backend.url) }, { log: entry => logs.push(entry) }));
    token = await sign(key, claims(provider.url));
  });
  afterEach(async () => { await Promise.all([gateway.close(), backend.close(), provider.close()]); });
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const json = () => ({ ...auth(), 'Content-Type': 'application/json' });

  it.each([
    ['no token', {}], ['malformed token', { Authorization: 'Bearer invalid' }],
    ['wrong scheme', { Authorization: 'Basic abc' }], ['empty bearer', { Authorization: 'Bearer ' }],
    ['forged identity only', { 'X-Verified-User': 'admin' }],
  ])('blocks %s before contacting the backend', async (_label, headers) => {
    const response = await fetch(`${gateway.url}/api/users`, { headers });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    expect(forwarded).toHaveLength(0);
  });
  it('blocks expired JWTs and does not log their subject as verified', async () => {
    const expired = await sign(key, { ...claims(provider.url), exp: 1 });
    expect((await fetch(`${gateway.url}/api/users`, { headers: { Authorization: `Bearer ${expired}` } })).status).toBe(401);
    expect(forwarded).toHaveLength(0);
    expect(logs[0]).toMatchObject({ userId: null, failureCode: 'ERR_JWT_EXPIRED' });
  });
  it('rejects duplicate authorization fields instead of silently picking one', async () => {
    const status = await new Promise(resolve => {
      const request = http.request(`${gateway.url}/api/users`, { headers: ['Host', new URL(gateway.url).host, 'Authorization', `Bearer ${token}`, 'Authorization', `Bearer ${token}`] }, response => { response.resume(); resolve(response.statusCode); });
      request.end();
    });
    expect(status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });
  it('blocks a verified caller without API scope in the policy layer', async () => {
    const limited = await sign(key, { ...claims(provider.url), scope: 'openid' });
    expect((await fetch(`${gateway.url}/api/users`, { headers: { Authorization: `Bearer ${limited}` } })).status).toBe(403);
    expect(forwarded).toHaveLength(0);
    expect(logs[0]).toMatchObject({ userId: 'user-123', failureCode: 'INSUFFICIENT_SCOPE' });
  });
  it('overwrites forged identity and strips credentials, forwarding and hop-by-hop headers', async () => {
    const response = await fetch(`${gateway.url}/api/users?private=hidden`, { headers: { ...auth(), 'X-Verified-User': 'admin', 'X-Forwarded-For': '203.0.113.1', 'X-Request-ID': 'forged', Cookie: 'secret=cookie' } });
    expect(response.status).toBe(200);
    expect(forwarded[0]).toMatchObject({ 'x-verified-user': 'user-123', 'x-request-id': response.headers.get('x-request-id') });
    expect(forwarded[0]).not.toHaveProperty('authorization');
    expect(forwarded[0]).not.toHaveProperty('cookie');
    expect(forwarded[0]).not.toHaveProperty('x-forwarded-for');
    expect(logs[0]).toMatchObject({ method: 'GET', path: '/api/users', sourceIp: '127.0.0.1', userId: 'user-123', status: 200 });
    expect(new Date(logs[0]?.timestamp as string).toISOString()).toBe(logs[0]?.timestamp);
    const output = JSON.stringify(logs);
    for (const secret of [token, 'hidden', 'secret=cookie', '203.0.113.1']) expect(output).not.toContain(secret);
  });
  it('does not let a caller nominate the verified identity as a hop-by-hop header', async () => {
    const status = await new Promise(resolve => {
      const request = http.request(`${gateway.url}/api/users`, { headers: { ...auth(), Connection: 'x-verified-user', 'X-Verified-User': 'forged' } }, response => { response.resume(); resolve(response.statusCode); });
      request.end();
    });
    expect(status).toBe(200);
    expect(forwarded[0]?.['x-verified-user']).toBe('user-123');
    expect(forwarded[0]?.connection).not.toBe('x-verified-user');
  });
  it.each(['GET', 'POST', 'PUT', 'DELETE'])('blocks direct %s requests without a trusted identity', async method => {
    const response = await fetch(`${backend.url}/api/users`, { method, headers: auth() });
    expect(response.status).toBe(403);
  });
  it('implements the required header trust contract without backend JWT validation', async () => {
    const response = await fetch(`${backend.url}/api/users`, { headers: { 'X-Verified-User': 'trusted-user', Authorization: 'not a jwt' } });
    expect(response.status).toBe(200);
    // This deliberately documents why the backend must be unreachable externally.
  });
  it('rejects ambiguous backend identity headers', async () => {
    expect((await fetch(`${backend.url}/api/users`, { headers: { 'X-Verified-User': 'one,two' } })).status).toBe(403);
  });
  it('completes create, list, read, replace, delete and not-found flows', async () => {
    const created = await fetch(`${gateway.url}/api/users`, { method: 'POST', headers: json(), body: JSON.stringify({ name: ' Alice ', email: 'alice@example.test' }) });
    expect(created.status).toBe(201);
    const user = await created.json();
    expect(user).toEqual({ id: expect.any(String), name: 'Alice', email: 'alice@example.test' });
    expect(created.headers.get('location')).toBe(`/api/users/${user.id}`);
    expect(await (await fetch(`${gateway.url}/api/users`, { headers: auth() })).json()).toEqual([user]);
    expect(await (await fetch(`${gateway.url}/api/users/${user.id}`, { headers: auth() })).json()).toEqual(user);
    const updated = await fetch(`${gateway.url}/api/users/${user.id}`, { method: 'PUT', headers: json(), body: JSON.stringify({ name: 'Bob', email: 'bob@example.test' }) });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ id: user.id, name: 'Bob', email: 'bob@example.test' });
    const deleted = await fetch(`${gateway.url}/api/users/${user.id}`, { method: 'DELETE', headers: auth() });
    expect(deleted.status).toBe(204); expect(await deleted.text()).toBe('');
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await fetch(`${gateway.url}/api/users/${user.id}`, { method, headers: json() });
      expect(response.status).toBe(404);
    }
  });
  it.each([null, [], {}, { name: 'Alice' }, { name: 1, email: 'a@b.test' }, { name: '', email: 'a@b.test' }, { name: 'A', email: 'invalid' }, { name: 'A', email: 1 }, { name: 'a'.repeat(101), email: 'a@b.test' }, { name: 'A\u0000', email: 'a@b.test' }, { name: 'A', email: 'a\u0000@b.test' }, { name: 'A', email: 'a@b.test', id: 'chosen' }])('rejects invalid create bodies: %j', async body => {
    const response = await fetch(`${gateway.url}/api/users`, { method: 'POST', headers: json(), body: JSON.stringify(body) });
    expect(response.status).toBe(400);
  });
  it('rejects malformed, oversized, compressed, and unsupported request bodies cleanly', async () => {
    for (const [body, headers, expected] of [
      ['{', json(), 400], ['x'.repeat(17000), json(), 413],
      ['{}', { ...json(), 'Content-Encoding': 'gzip' }, 415],
      ['{}', { ...auth(), 'Content-Type': 'text/plain' }, 415],
      ['{}', { ...auth(), 'Content-Type': 'application/json; charset=unknown' }, 415],
    ] as const) {
      const response = await fetch(`${gateway.url}/api/users`, { method: 'POST', headers, body });
      expect(response.status).toBe(expected);
      const result = await response.json();
      expect(result.requestId).toBe(response.headers.get('x-request-id'));
      expect(result).not.toHaveProperty('stack');
      expect(result.error).not.toContain('SyntaxError');
    }
  });
  it('rejects an invalid update without modifying the existing user', async () => {
    const user = await (await fetch(`${gateway.url}/api/users`, { method: 'POST', headers: json(), body: JSON.stringify({ name: 'A', email: 'a@b.test' }) })).json();
    const response = await fetch(`${gateway.url}/api/users/${user.id}`, { method: 'PUT', headers: json(), body: '{}' });
    expect(response.status).toBe(400);
    expect(await (await fetch(`${gateway.url}/api/users/${user.id}`, { headers: auth() })).json()).toEqual(user);
  });
  it('returns 400 for malformed URL encoding without exposing parser errors', async () => {
    const response = await fetch(`${gateway.url}/api/users/%ZZ`, { headers: auth() });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Invalid path' });
  });
  it('handles health, unknown paths and unsupported methods without forwarding arbitrary paths', async () => {
    expect((await fetch(`${gateway.url}/health`)).status).toBe(200);
    expect((await fetch(`${gateway.url}/api/users-elsewhere`, { headers: auth() })).status).toBe(404);
    expect(forwarded).toHaveLength(0);
    expect((await fetch(`${gateway.url}/api/users`, { method: 'PATCH', headers: auth() })).status).toBe(405);
  });
  it('returns a sanitized 502 and logs a stable code when the backend is down', async () => {
    await backend.close();
    const response = await fetch(`${gateway.url}/api/users`, { headers: auth() });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'Bad gateway' });
    expect(logs[0]).toMatchObject({ failureCode: 'UPSTREAM_UNAVAILABLE', status: 502 });
    // Replace the close function so cleanup is idempotent after this intentional outage.
    backend.close = async () => {};
  });
});
