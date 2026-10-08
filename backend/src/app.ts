import { randomUUID } from 'node:crypto';
import express from 'express';
import type { RequestHandler } from 'express';
import { requestContext, notFound, errorHandler, isHeaderIdentity } from '../../shared/http.js';

interface User { id: string; name: string; email: string }

const requireGateway: RequestHandler = (req, res, next) => {
  if (!isHeaderIdentity(req.headers['x-verified-user'])) {
    res.status(403).json({ error: 'Forbidden', requestId: res.locals.requestId });
    return;
  }
  const requestId = req.headers['x-request-id'];
  if (typeof requestId === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(requestId)) {
    res.locals.requestId = requestId;
    res.set('X-Request-ID', requestId);
  }
  next();
};

function userInput(body: unknown): { name: string; email: string } | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => !['name', 'email'].includes(key))) return;
  if (typeof value.name !== 'string' || typeof value.email !== 'string') return;
  const name = value.name.trim();
  const email = value.email.trim();
  const hasControl = (text: string) => [...text].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  if (!name || name.length > 100 || hasControl(name)) return;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || hasControl(email)) return;
  return { name, email };
}

export function createBackend() {
  const users = new Map<string, User>();
  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext);
  // Every backend route, including unmatched paths, requires a gateway identity.
  app.use(requireGateway);
  app.use((req, res, next) => {
    if (['POST', 'PUT'].includes(req.method) && !req.is('application/json')) {
      res.status(415).json({ error: 'Content-Type must be application/json', requestId: res.locals.requestId });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true, inflate: false }));
  app.get('/api/users', (_req, res) => res.json([...users.values()]));
  app.get('/api/users/:id', (req, res, next) => {
    const user = users.get(req.params.id);
    if (!user) { notFound(req, res, next); return; }
    res.json(user);
  });
  app.post('/api/users', (req, res) => {
    const input = userInput(req.body);
    if (!input) { res.status(400).json({ error: 'Provide only a valid name and email', requestId: res.locals.requestId }); return; }
    const user = { id: randomUUID(), ...input };
    users.set(user.id, user);
    res.status(201).location(`/api/users/${user.id}`).json(user);
  });
  app.put('/api/users/:id', (req, res, next) => {
    if (!users.has(req.params.id)) { notFound(req, res, next); return; }
    const input = userInput(req.body);
    if (!input) { res.status(400).json({ error: 'Provide only a valid name and email', requestId: res.locals.requestId }); return; }
    const user = { id: req.params.id, ...input };
    users.set(user.id, user);
    res.json(user);
  });
  app.delete('/api/users/:id', (req, res, next) => {
    if (!users.delete(req.params.id)) { notFound(req, res, next); return; }
    res.status(204).end();
  });
  app.all(['/api/users', '/api/users/:id'], (_req, res) => {
    res.set('Allow', 'GET, HEAD, POST, PUT, DELETE').status(405).json({ error: 'Method not allowed', requestId: res.locals.requestId });
  });
  app.use(notFound, errorHandler);
  return app;
}
