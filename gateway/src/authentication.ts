import { createRemoteJWKSet, jwtVerify, errors } from 'jose';
import type { RequestHandler } from 'express';
import { isHeaderIdentity } from '../../shared/http.js';

export interface AuthConfig {
  issuer: string;
  audience: string;
  clientId: string;
  jwksUrl: URL;
}

// Construct once per gateway, never once per request. Cache and in-flight fetches are shared.
export function createTokenVerifier(config: AuthConfig) {
  const keys = createRemoteJWKSet(config.jwksUrl, {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30 * 1000,
    timeoutDuration: 3000,
  });
  return async (token: string) => {
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iss', 'aud', 'sub'],
      clockTolerance: 0,
    });
    if (payload.token_use !== 'access' || payload.client_id !== config.clientId || !isHeaderIdentity(payload.sub)) {
      throw new errors.JWTClaimValidationFailed('Invalid access token claims', payload);
    }
    return { userId: payload.sub, scope: typeof payload.scope === 'string' ? payload.scope : '' };
  };
}

export type VerifyToken = ReturnType<typeof createTokenVerifier>;

export function authenticate(verify: VerifyToken): RequestHandler {
  return async (req, res, next) => {
    // Node can discard duplicate Authorization headers when populating req.headers.
    const count = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index]?.toLowerCase() === 'authorization').length;
    const match = count === 1 ? /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(req.headers.authorization || '') : null;
    if (!match?.[1]) {
      res.locals.failureCode = 'INVALID_AUTHORIZATION';
      res.set('WWW-Authenticate', 'Bearer realm="secure-entry"');
      res.status(401).json({ error: 'Unauthorized', requestId: res.locals.requestId });
      return;
    }
    try {
      const identity = await verify(match[1]);
      res.locals.userId = identity.userId;
      res.locals.scope = identity.scope;
    } catch (error) {
      // Only stable codes are logged; token contents and provider error text are excluded.
      res.locals.failureCode = error instanceof errors.JOSEError ? error.code : 'JWKS_UNAVAILABLE';
      res.set('WWW-Authenticate', 'Bearer realm="secure-entry", error="invalid_token"');
      res.status(401).json({ error: 'Unauthorized', requestId: res.locals.requestId });
      return;
    }
    next();
  };
}
