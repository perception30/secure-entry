import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = process.env.GATEWAY_URL || 'http://127.0.0.1:3000';
const token = (await readFile('.local/access-token', 'utf8')).trim();
async function request(path, status, { auth = true, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method, signal: AbortSignal.timeout(10000),
    headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, status, `${method} ${path}`);
  assert.ok(response.headers.get('x-request-id'));
  console.log(`PASS ${method} ${path} -> ${status}`);
  return status === 204 ? undefined : response.json();
}
await request('/api/users', 401, { auth: false });
await request('/api/users', 401, { auth: false, headers: { 'X-Verified-User': 'forged' } });
await request('/api/users', 401, { auth: false, headers: { Authorization: 'Bearer invalid' } });
await request('/api/users', 200);
await request('/api/users', 400, { method: 'POST', body: { name: '', email: 'invalid' } });
const user = await request('/api/users', 201, { method: 'POST', body: { name: 'Smoke Test', email: 'smoke@example.test' } });
try {
  assert.equal((await request(`/api/users/${user.id}`, 200)).name, 'Smoke Test');
  assert.equal((await request(`/api/users/${user.id}`, 200, { method: 'PUT', body: { name: 'Updated', email: 'updated@example.test' } })).name, 'Updated');
} finally {
  await request(`/api/users/${user.id}`, 204, { method: 'DELETE' });
}
await request(`/api/users/${user.id}`, 404);
console.log('Live access-token smoke test passed.');
