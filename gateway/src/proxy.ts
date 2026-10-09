import http from 'node:http';
import https from 'node:https';
import type { RequestHandler } from 'express';

export function proxyTo(backend: URL): RequestHandler {
  const transport = backend.protocol === 'https:' ? https : http;
  return (req, res) => {
    // Only POST/PUT have API bodies. Decoded chunks on other methods can lose
    // outbound framing and be parsed as a second, unverified backend request.
    if (!['POST', 'PUT'].includes(req.method) &&
        (req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0)) {
      res.locals.failureCode = 'INVALID_BODY';
      res.set('Connection', 'close').status(400).json({ error: 'Request body not allowed for this method', requestId: res.locals.requestId });
      return;
    }
    // An allowlist prevents bearer tokens, cookies, spoofed identity/forwarding and
    // hop-by-hop Connection headers crossing the authentication boundary.
    const headers: http.OutgoingHttpHeaders = { 'x-verified-user': res.locals.userId, 'x-request-id': res.locals.requestId };
    for (const name of ['content-type', 'content-length', 'content-encoding', 'accept']) {
      if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    }
    const upstream = transport.request(backend, { method: req.method, path: req.originalUrl, headers }, response => {
      res.status(response.statusCode ?? 502);
      for (const name of ['content-type', 'content-length', 'location']) {
        if (response.headers[name] !== undefined) res.setHeader(name, response.headers[name]);
      }
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    const timer = setTimeout(() => upstream.destroy(new Error('Upstream deadline exceeded')), 5000);
    upstream.on('error', () => {
      res.locals.failureCode = 'UPSTREAM_UNAVAILABLE';
      if (res.headersSent) { res.destroy(); return; }
      res.status(502).json({ error: 'Bad gateway', requestId: res.locals.requestId });
    });
    res.once('close', () => { clearTimeout(timer); upstream.destroy(); });
    req.once('aborted', () => upstream.destroy());
    req.once('error', () => upstream.destroy());
    req.pipe(upstream);
  };
}
