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

export class AuthError extends Error {}

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
    } catch {
      throw new AuthError('Tu sesión venció o no es válida. Vuelve a iniciar sesión.');
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
