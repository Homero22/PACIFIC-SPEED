import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * Player sign-in (Firebase Auth, Google). The server checks each Firebase ID token against
 * Google's public keys: only the project id is needed, no service account or secret.
 */
const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

export interface AuthUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  provider: string | null;
}

/** The token is missing, expired, forged or for another project: the player must sign in again. */
export class AuthError extends Error {}
/** Google's public keys could not be fetched: the sign-in may be fine, retry later (HTTP 503). */
export class AuthUnavailableError extends Error {}

/** jose error codes that mean "this token is not acceptable" (anything else is an outage). */
const INVALID_TOKEN_CODES = new Set([
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_INVALID',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED'
]);

export type IdTokenVerifier = (idToken: string) => Promise<AuthUser>;

export function createFirebaseVerifier(
  projectId: string,
  keySet: JWTVerifyGetKey = createRemoteJWKSet(new URL(FIREBASE_JWKS_URL))
): IdTokenVerifier {
  return async (idToken: string) => {
    if (!idToken || idToken.length > 4096) throw new AuthError('Sesión inválida.');
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, keySet, {
        issuer: `https://securetoken.google.com/${projectId}`,
        audience: projectId,
        algorithms: ['RS256']
      }));
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code && INVALID_TOKEN_CODES.has(code)) {
        throw new AuthError('Tu sesión venció o no es válida. Vuelve a iniciar sesión.');
      }
      // Timeout or network error fetching Google's keys (ERR_JWKS_TIMEOUT, fetch failures...)
      throw new AuthUnavailableError('No pudimos verificar tu sesión con Google. Intenta de nuevo en un momento.');
    }
    const uid = typeof payload.sub === 'string' ? payload.sub : '';
    if (!uid || uid.length > 128) throw new AuthError('Sesión inválida.');
    const firebase = (payload.firebase || {}) as { sign_in_provider?: string };
    return {
      uid,
      email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
      emailVerified: payload.email_verified === true,
      provider: firebase.sign_in_provider || null
    };
  };
}

/** Public Firebase web config (safe to expose: it identifies the project, it is not a secret). */
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

export function readFirebaseWebConfig(env: NodeJS.ProcessEnv = process.env): FirebaseWebConfig | null {
  const apiKey = env.FIREBASE_API_KEY?.trim();
  const projectId = env.FIREBASE_PROJECT_ID?.trim();
  const appId = env.FIREBASE_APP_ID?.trim();
  if (!apiKey || !projectId || !appId) return null;
  return {
    apiKey,
    projectId,
    appId,
    authDomain: env.FIREBASE_AUTH_DOMAIN?.trim() || `${projectId}.firebaseapp.com`
  };
}

/** "Bearer <token>" → token */
export function bearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
