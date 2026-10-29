import { AuthError, AuthUnavailableError, bearerToken, type AuthUser, type IdTokenVerifier } from './firebaseAuth.js';

export type RegistrationAuthResult =
  | { ok: true; player: AuthUser }
  | { ok: false; status: 401 | 403 | 503; message: string };

/**
 * Gate for paid tournament registration: a configured sign-in, a valid Google session and a
 * verified e-mail, in that order. Runs before anything is saved or charged.
 */
export async function authorizeRegistration(
  verify: IdTokenVerifier | null,
  authorizationHeader: unknown
): Promise<RegistrationAuthResult> {
  if (!verify) return { ok: false, status: 503, message: 'El inicio de sesión todavía no está configurado.' };
  const token = bearerToken(authorizationHeader);
  if (!token) return { ok: false, status: 401, message: 'Inicia sesión con Google para inscribirte.' };
  let player: AuthUser;
  try {
    player = await verify(token);
  } catch (err) {
    if (err instanceof AuthUnavailableError) return { ok: false, status: 503, message: err.message };
    if (err instanceof AuthError) return { ok: false, status: 401, message: 'Inicia sesión con Google para inscribirte.' };
    throw err;
  }
  if (!player.emailVerified) return { ok: false, status: 403, message: 'Tu cuenta no tiene un correo verificado.' };
  return { ok: true, player };
}
