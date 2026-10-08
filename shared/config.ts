function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function url(value: string, name: string): URL {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials, query or fragment`);
  }
  return parsed;
}

export function port(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(result) || result < 1 || result > 65535) throw new Error('Invalid port');
  return result;
}

export function gatewayConfig(env: NodeJS.ProcessEnv) {
  const issuer = required(env, 'OIDC_ISSUER');
  const issuerUrl = url(issuer, 'OIDC_ISSUER');
  const jwksUrl = url(required(env, 'OIDC_JWKS_URI'), 'OIDC_JWKS_URI');
  if (issuerUrl.protocol !== 'https:' || jwksUrl.protocol !== 'https:') throw new Error('OIDC URLs must use HTTPS');
  const backendUrl = url(required(env, 'BACKEND_URL'), 'BACKEND_URL');
  if (backendUrl.pathname !== '/') throw new Error('BACKEND_URL must be an origin without a path');
  return {
    issuer, jwksUrl, backendUrl,
    audience: required(env, 'OIDC_AUDIENCE'),
    clientId: required(env, 'OIDC_CLIENT_ID'),
    host: env.GATEWAY_HOST || '127.0.0.1',
    port: port(env.GATEWAY_PORT, 3000),
  };
}
