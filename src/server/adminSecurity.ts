import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { antiCheatEngine } from './antiCheat.js';
import { cleanEnv, devFallbackSecret, isProductionEnv } from './runtimeConfig.js';

let warnedDevAdminKey = false;

export function getAdminSecretKey(): string {
  const configured = cleanEnv(process.env.ADMIN_SECRET_KEY) || cleanEnv(process.env.ADMIN_PASSWORD);
  if (configured) return configured;
  if (isProductionEnv()) {
    throw new Error('ADMIN_SECRET_KEY no configurada en producción.');
  }
  const devKey = devFallbackSecret('ADMIN_SECRET_KEY');
  if (!warnedDevAdminKey) {
    warnedDevAdminKey = true;
    console.warn(`[ADMIN] ADMIN_SECRET_KEY no definida. Clave temporal de desarrollo: ${devKey}`);
  }
  return devKey;
}

/**
 * Secret used exclusively to sign admin session tokens (kept separate from the login key).
 */
export function getAdminTokenSecret(): string {
  const configured = cleanEnv(process.env.ADMIN_TOKEN_SECRET);
  if (configured) return configured;
  if (isProductionEnv()) {
    throw new Error('ADMIN_TOKEN_SECRET no configurada en producción.');
  }
  return devFallbackSecret('ADMIN_TOKEN_SECRET');
}

/**
 * Validates admin password using constant-time comparison to prevent timing attacks.
 */
export function verifyAdminPassword(inputPassword: string): boolean {
  if (!inputPassword || typeof inputPassword !== 'string') return false;
  const masterKey = getAdminSecretKey();

  const inputBuf = Buffer.from(inputPassword, 'utf8');
  const masterBuf = Buffer.from(masterKey, 'utf8');

  // Compare fixed-length digests so the key length is not leaked by timing
  const inputDigest = crypto.createHash('sha256').update(inputBuf).digest();
  const masterDigest = crypto.createHash('sha256').update(masterBuf).digest();
  return crypto.timingSafeEqual(inputDigest, masterDigest);
}

// 8-hour signed Bearer session token
export function generateAdminToken(): { token: string; expires_in_hours: number } {
  const payload = {
    role: 'admin',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 8 * 3600 * 1000
  };
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', getAdminTokenSecret())
    .update(payloadBase64)
    .digest('base64url');

  return {
    token: `${payloadBase64}.${signature}`,
    expires_in_hours: 8
  };
}

export function validateAdminToken(authHeader: string | undefined): boolean {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [payloadBase64, signature] = parts;
  const expectedSignature = crypto
    .createHmac('sha256', getAdminTokenSecret())
    .update(payloadBase64)
    .digest('base64url');

  try {
    const sigBuf = Buffer.from(signature, 'utf8');
    const expSigBuf = Buffer.from(expectedSignature, 'utf8');
    if (sigBuf.length !== expSigBuf.length || !crypto.timingSafeEqual(sigBuf, expSigBuf)) {
      return false;
    }

    const payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf8')) as {
      role: string;
      expiresAt: number;
    };
    if (payload.role !== 'admin' || Date.now() > payload.expiresAt) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Admin Rate Limiter (Max 5 failed attempts per 15 min per IP)
const adminFailedAttempts = new Map<string, { count: number; firstAttemptTime: number }>();

export function checkAdminRateLimit(ip: string): boolean {
  const record = adminFailedAttempts.get(ip);
  if (!record) return true;

  if (Date.now() - record.firstAttemptTime > 15 * 60 * 1000) {
    adminFailedAttempts.delete(ip);
    return true;
  }
  return record.count < 5;
}

export function registerFailedAdminLogin(ip: string): void {
  const record = adminFailedAttempts.get(ip) || { count: 0, firstAttemptTime: Date.now() };
  record.count++;
  adminFailedAttempts.set(ip, record);
}

export function resetAdminAttempts(ip: string): void {
  adminFailedAttempts.delete(ip);
}

/**
 * Express middleware to enforce admin Bearer token authorization on all /api/admin/* routes.
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!validateAdminToken(authHeader)) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    antiCheatEngine.logSecurityViolation(
      'admin_unauthorized_access',
      'high',
      ip,
      `Unauthorized attempt on ${req.method} ${req.path}`
    );
    res.status(401).json({
      error: 'Unauthorized: Valid Admin Bearer token required in Authorization header'
    });
    return;
  }
  next();
}
