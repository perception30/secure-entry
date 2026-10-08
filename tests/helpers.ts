import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { JWTPayload } from 'jose';

export async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

export async function signingKey(kid: string) {
  const keys = await generateKeyPair('RS256');
  return { ...keys, jwk: { ...await exportJWK(keys.publicKey), kid, alg: 'RS256', use: 'sig' } };
}

export const audience = 'https://secure-entry.example/api';
export const clientId = 'test-client';
export function claims(issuer: string): JWTPayload {
  return { iss: issuer, aud: audience, sub: 'user-123', exp: Math.floor(Date.now() / 1000) + 3600, token_use: 'access', client_id: clientId, scope: `${audience}/users` };
}

export function sign(key: Awaited<ReturnType<typeof signingKey>>, payload: JWTPayload, kid = key.jwk.kid) {
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid }).sign(key.privateKey);
}
