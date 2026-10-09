import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGateway } from '../gateway/src/app.js';
import { createBackend } from '../backend/src/app.js';
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
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()));
    for (const entry of logs) expect(entry).toMatchObject({ timestamp: expect.any(String), service: 'gateway', requestId: expect.any(String), method: expect.any(String), path: '/api/users', sourceIp: '127.0.0.1', userId: 'test-user', status: expect.any(Number), durationMs: expect.any(Number) });
    logs.length = 0;
  });
  it('bounds the total upstream request time', async () => {
    const gateway = await setup(() => {});
    const response = await fetch(`${gateway}/api/users`, { headers: { Authorization: 'Bearer aaa.bbb.ccc' } });
    expect(response.status).toBe(502);
    expect(logs[0]).toMatchObject({ failureCode: 'UPSTREAM_TIMEOUT', sourceIp: '127.0.0.1', status: 502, service: 'gateway' });
  });
  it('terminates truncated upstream responses instead of appending an error to JSON', async () => {
    const gateway = await setup((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
      res.write('{');
      setTimeout(() => res.destroy(), 30);
    });
    const response = await fetch(`${gateway}/api/users`, { headers: { Authorization: 'Bearer aaa.bbb.ccc' } });
    await expect(response.text()).rejects.toThrow();
    await vi.waitFor(() => expect(logs[0]).toMatchObject({ status: 502, responseStatus: 200, failureCode: 'UPSTREAM_RESPONSE_TRUNCATED', errorCode: 'ECONNRESET', terminationCause: 'upstream_failure', sourceIp: '127.0.0.1', userId: 'test-user' }));
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
    await vi.waitFor(() => expect(logs[0]).toMatchObject({ status: 499, failureCode: 'CLIENT_ABORTED', terminationCause: 'client_aborted', sourceIp: '127.0.0.1', userId: 'test-user' }));
  });
  it.each([200, 500])('keeps downstream cancellation of a %s response distinct from an upstream error', async status => {
    let onClosed: () => void = () => {};
    const closed = new Promise<void>(resolve => { onClosed = resolve; });
    const gateway = await setup((_req, res) => {
      res.on('close', onClosed);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.write('{');
    });
    await new Promise<void>((resolve, reject) => {
      const request = http.get(`${gateway}/api/users`, { headers: { Authorization: 'Bearer aaa.bbb.ccc' } }, response => {
        response.once('data', () => { response.destroy(); resolve(); });
      });
      request.on('error', reject);
    });
    await closed;
    await vi.waitFor(() => expect(logs[0]).toMatchObject({ status: 499, responseStatus: status, failureCode: 'CLIENT_ABORTED', sourceIp: '127.0.0.1' }));
  });
  it('logs an upstream reset before response headers as a connection error', async () => {
    const gateway = await setup(req => req.socket.destroy());
    expect((await fetch(`${gateway}/api/users`, { headers: { Authorization: 'Bearer aaa.bbb.ccc' } })).status).toBe(502);
    expect(logs[0]).toMatchObject({ status: 502, failureCode: 'UPSTREAM_CONNECTION_ERROR', errorCode: 'ECONNRESET', sourceIp: '127.0.0.1' });
  });
  it('identifies backend errors without exposing their body in logs', async () => {
    const gateway = await setup((_req, res) => { res.writeHead(500); res.end('private backend details'); });
    expect((await fetch(`${gateway}/api/users`, { headers: { Authorization: 'Bearer aaa.bbb.ccc' } })).status).toBe(500);
    expect(logs[0]).toMatchObject({ status: 500, failureCode: 'BACKEND_ERROR' });
    expect(JSON.stringify(logs)).not.toContain('private backend details');
  });
  it('does not report cancelled backend JSON uploads as internal exceptions', async () => {
    const backendLogs: Record<string, unknown>[] = [];
    let onReceive: () => void = () => {};
    const received = new Promise<void>(resolve => { onReceive = resolve; });
    const app = express();
    app.use((req, _res, next) => { req.once('data', onReceive); next(); });
    app.use(createBackend({ log: entry => backendLogs.push(entry) }));
    const gateway = await setup(app);
    const request = http.request(`${gateway}/api/users`, { method: 'POST', headers: { Authorization: 'Bearer aaa.bbb.ccc', 'Content-Type': 'application/json', 'Content-Length': '100' } });
    request.on('error', () => {});
    request.write('{');
    await received;
    request.destroy();
    await vi.waitFor(() => expect(backendLogs.some(entry => entry.event === 'request')).toBe(true));
    expect(backendLogs).toHaveLength(1);
    expect(backendLogs[0]).toMatchObject({ service: 'backend', status: 499, failureCode: 'CLIENT_ABORTED', sourceIp: '127.0.0.1' });
  });
});
