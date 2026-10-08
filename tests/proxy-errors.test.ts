import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createGateway } from '../gateway/src/app.js';
import { audience, clientId, listen } from './helpers.js';

describe('proxy connection lifecycle', () => {
  const servers: Awaited<ReturnType<typeof listen>>[] = [];
  const logs: Record<string, unknown>[] = [];
  async function setup(handler: http.RequestListener) {
    const backend = await listen(handler); servers.push(backend);
    const gateway = await listen(createGateway({ issuer: 'https://issuer.test', audience, clientId, jwksUrl: new URL('https://issuer.test/keys'), backendUrl: new URL(backend.url) }, {
      verify: async () => ({ userId: 'test-user', scope: `${audience}/users` }),
      log: entry => logs.push(entry),
    }));
    servers.push(gateway);
    return gateway.url;
  }
  afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); logs.length = 0; });
  it('bounds the total upstream request time', async () => {
    const gateway = await setup(() => {});
    const response = await fetch(`${gateway}/api/users`, { headers: { Authorization: 'Bearer aaa.bbb.ccc' } });
    expect(response.status).toBe(502);
    expect(logs[0]).toMatchObject({ failureCode: 'UPSTREAM_UNAVAILABLE' });
  });
  it('terminates truncated upstream responses instead of appending an error to JSON', async () => {
    const gateway = await setup((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
      res.write('{');
      setTimeout(() => res.destroy(), 30);
    });
    const response = await fetch(`${gateway}/api/users`, { headers: { Authorization: 'Bearer aaa.bbb.ccc' } });
    await expect(response.text()).rejects.toThrow();
  });
  it('closes the upstream when the client abandons an upload', async () => {
    let onReceive: () => void = () => {};
    const received = new Promise<void>(resolve => { onReceive = resolve; });
    let onClosed: () => void = () => {};
    const closed = new Promise<void>(resolve => { onClosed = resolve; });
    const gateway = await setup(req => { req.on('close', onClosed); req.resume(); onReceive(); });
    const request = http.request(`${gateway}/api/users`, { method: 'POST', headers: { Authorization: 'Bearer aaa.bbb.ccc', 'Content-Length': '100' } });
    request.on('error', () => {});
    request.write('{');
    await received;
    request.destroy();
    await closed;
    expect(logs[0]).toMatchObject({ status: 499 });
  });
});
