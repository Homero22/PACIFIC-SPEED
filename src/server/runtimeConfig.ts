import crypto from 'crypto';

export function cleanEnv(val?: string): string | undefined {
  if (!val) return undefined;
  const trimmed = val.trim();
  const unquoted = trimmed.replace(/^["'](.*)["']$/, '$1').trim();
  return unquoted.length > 0 ? unquoted : undefined;
}

/**
 * Production = NODE_ENV=production or running inside Railway.
 * Any deployed instance must behave as production (no dev secrets, no sandbox endpoints).
 */
export function isProductionEnv(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_SERVICE_ID)
  );
}

// Keys that were published in the public repository and must never be accepted again.
const KNOWN_LEAKED_ADMIN_KEYS = new Set(['admin_pacific_overdrive_2026', 'admin_pacific_overdrive_2026--']);

// Random per-process fallbacks for local development only (never hardcoded).
const devFallbacks = new Map<string, string>();
export function devFallbackSecret(name: string): string {
  let value = devFallbacks.get(name);
  if (!value) {
    value = crypto.randomBytes(24).toString('base64url');
    devFallbacks.set(name, value);
  }
  return value;
}

/**
 * Returns the list of configuration problems that must block a production start.
 */
export function collectProductionConfigErrors(env: NodeJS.ProcessEnv = process.env): string[] {
  const errors: string[] = [];
  const adminKey = cleanEnv(env.ADMIN_SECRET_KEY) || cleanEnv(env.ADMIN_PASSWORD);
  const tokenSecret = cleanEnv(env.ADMIN_TOKEN_SECRET);
  const payphoneSecret = cleanEnv(env.PAYPHONE_SECRET_KEY) || cleanEnv(env.PAYPHONE_SECRET);
  const payphoneToken =
    cleanEnv(env.PAYPHONE_TOKEN) || cleanEnv(env.PAYPHONE_BEARER_TOKEN) || cleanEnv(env.PAYPHONE_ACCESS_TOKEN);

  if (!adminKey) {
    errors.push('ADMIN_SECRET_KEY no está definida.');
  } else if (KNOWN_LEAKED_ADMIN_KEYS.has(adminKey)) {
    errors.push('ADMIN_SECRET_KEY usa una clave publicada en el repositorio; rótala.');
  } else if (adminKey.length < 12) {
    errors.push('ADMIN_SECRET_KEY debe tener al menos 12 caracteres.');
  }

  if (!tokenSecret) {
    errors.push('ADMIN_TOKEN_SECRET no está definida (secreto aleatorio para firmar sesiones admin).');
  } else if (tokenSecret.length < 32) {
    errors.push('ADMIN_TOKEN_SECRET debe tener al menos 32 caracteres.');
  } else if (adminKey && tokenSecret === adminKey) {
    errors.push('ADMIN_TOKEN_SECRET debe ser distinta de ADMIN_SECRET_KEY.');
  }

  if (!payphoneSecret) errors.push('PAYPHONE_SECRET_KEY no está definida.');
  if (!payphoneToken) errors.push('PAYPHONE_TOKEN no está definida.');

  return errors;
}

/**
 * Aborts startup in production when mandatory secrets are missing or insecure.
 */
export function assertProductionConfig(): void {
  if (!isProductionEnv()) return;
  const errors = collectProductionConfigErrors();
  if (errors.length > 0) {
    console.error('[CONFIG] ❌ Configuración de producción inválida. El servidor no arrancará:');
    for (const e of errors) console.error(`[CONFIG]   - ${e}`);
    process.exit(1);
  }
}
