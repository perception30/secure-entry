import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const { COGNITO_DOMAIN, OIDC_CLIENT_ID, OIDC_AUDIENCE, OIDC_ISSUER, OIDC_JWKS_URI } = process.env;
if (!COGNITO_DOMAIN || !OIDC_CLIENT_ID || !OIDC_AUDIENCE || !OIDC_ISSUER || !OIDC_JWKS_URI) throw new Error('Configure .env first');
const domain = new URL(COGNITO_DOMAIN);
if (domain.protocol !== 'https:') throw new Error('Cognito requires HTTPS');
const redirectUri = 'http://localhost:8085/callback';
const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(32).toString('base64url');
const authorization = new URL('/oauth2/authorize', domain);
authorization.search = new URLSearchParams({
  response_type: 'code', client_id: OIDC_CLIENT_ID, redirect_uri: redirectUri,
  scope: `openid ${OIDC_AUDIENCE}/users`, resource: OIDC_AUDIENCE,
  code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), state,
}).toString();
let exchanging = false;
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  const callback = new URL(req.url, redirectUri);
  if (req.method !== 'GET' || callback.pathname !== '/callback') { res.writeHead(404).end('Not found'); return; }
  if (callback.searchParams.get('state') !== state || exchanging) { res.writeHead(400).end('Invalid login state'); return; }
  const code = callback.searchParams.get('code');
  if (!code) { res.writeHead(400).end('Login did not return a code. Restart npm run login.'); return; }
  exchanging = true;
  try {
    const response = await fetch(new URL('/oauth2/token', domain), {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: OIDC_CLIENT_ID, code, redirect_uri: redirectUri, code_verifier: verifier }),
    });
    const tokens = await response.json();
    if (!response.ok || typeof tokens.access_token !== 'string') throw new Error('Token exchange failed');
    const { payload } = await jwtVerify(tokens.access_token, createRemoteJWKSet(new URL(OIDC_JWKS_URI)), {
      issuer: OIDC_ISSUER, audience: OIDC_AUDIENCE, algorithms: ['RS256'], requiredClaims: ['exp', 'aud', 'iss', 'sub'],
    });
    if (payload.token_use !== 'access' || payload.client_id !== OIDC_CLIENT_ID || !payload.scope?.split(' ').includes(`${OIDC_AUDIENCE}/users`)) throw new Error('Invalid API access token');
    await mkdir('.local', { recursive: true, mode: 0o700 });
    await writeFile('.local/access-token', tokens.access_token, { mode: 0o600 });
    res.end('Sign-in complete. Access token saved locally. You can close this tab and run npm run smoke.');
    console.log('Access token saved to .local/access-token. It is never printed.');
  } catch {
    res.writeHead(502).end('Token exchange or validation failed. Check managed login and resource binding, then restart npm run login.');
    console.error('Token exchange or validation failed. Check managed login v2 and resource binding.');
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    server.close();
  }
});
const deadline = setTimeout(() => { console.error('Login timed out.'); server.close(); process.exitCode = 1; }, 300000);
server.on('error', () => { clearTimeout(deadline); console.error('Cannot listen on localhost:8085'); process.exitCode = 1; });
server.listen(8085, 'localhost', () => console.log(`Open this URL, then sign in with the test user:\n${authorization}`));
