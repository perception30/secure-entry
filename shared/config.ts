export class ConfigurationError extends Error {
  constructor(public readonly key: string, public readonly code: string) {
    super(`${key}: ${code}`);
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigurationError(name, 'CONFIG_REQUIRED');
  return value;
}

function url(value: string, name: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ConfigurationError(name, 'CONFIG_INVALID_URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new ConfigurationError(name, 'CONFIG_INVALID_URL');
  }
  return parsed;
}

export function port(value: string | undefined, fallback: number, name = 'PORT'): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(result) || result < 1 || result > 65535) throw new ConfigurationError(name, 'CONFIG_INVALID_PORT');
  return result;
}

export function gatewayConfig(env: NodeJS.ProcessEnv) {
  const issuer = required(env, 'OIDC_ISSUER');
  const issuerUrl = url(issuer, 'OIDC_ISSUER');
  const jwksUrl = url(required(env, 'OIDC_JWKS_URI'), 'OIDC_JWKS_URI');
  if (issuerUrl.protocol !== 'https:') throw new ConfigurationError('OIDC_ISSUER', 'CONFIG_HTTPS_REQUIRED');
  if (jwksUrl.protocol !== 'https:') throw new ConfigurationError('OIDC_JWKS_URI', 'CONFIG_HTTPS_REQUIRED');
  const backendUrl = url(required(env, 'BACKEND_URL'), 'BACKEND_URL');
  if (backendUrl.pathname !== '/') throw new ConfigurationError('BACKEND_URL', 'CONFIG_INVALID_BACKEND_ORIGIN');
  return {
    issuer, jwksUrl, backendUrl,
    audience: required(env, 'OIDC_AUDIENCE'),
    clientId: required(env, 'OIDC_CLIENT_ID'),
    host: env.GATEWAY_HOST || '127.0.0.1',
    port: port(env.GATEWAY_PORT, 3000, 'GATEWAY_PORT'),
  };
}
