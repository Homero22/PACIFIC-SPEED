import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

const DEFAULT_DEV_SECRET = 'dev_payphone_secret_key_pacific_overdrive_2026';

export function getPayphoneSecretKey(): string {
  return process.env.PAYPHONE_SECRET_KEY || DEFAULT_DEV_SECRET;
}

export function generatePayphoneSignature(payloadString: string, secretKey = getPayphoneSecretKey()): string {
  return crypto.createHmac('sha256', secretKey).update(payloadString).digest('hex');
}

export function verifyPayphoneSignature(
  payloadString: string,
  providedSignature: string | undefined,
  secretKey = getPayphoneSecretKey()
): boolean {
  if (!providedSignature) return false;

  const expectedSignature = generatePayphoneSignature(payloadString, secretKey);

  try {
    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    const providedBuf = Buffer.from(providedSignature, 'utf8');

    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

export function verifyReplayAttackTimestamp(
  timestampMsOrSec: number | undefined,
  maxWindowSeconds = 300
): { valid: boolean; reason?: string } {
  if (!timestampMsOrSec) {
    // If not provided in payload, evaluate header/current time
    return { valid: true };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const payloadSec = timestampMsOrSec > 9999999999 ? Math.floor(timestampMsOrSec / 1000) : timestampMsOrSec;

  const diffSeconds = Math.abs(nowSec - payloadSec);
  if (diffSeconds > maxWindowSeconds) {
    return {
      valid: false,
      reason: `Replay attack prevention: payload timestamp diverged by ${diffSeconds}s (max allowed: ${maxWindowSeconds}s)`
    };
  }

  return { valid: true };
}

// In-Memory Rate Limiting for Webhooks & Payments
interface IpAttemptRecord {
  attempts: number;
  firstAttemptTime: number;
  failedWebhooks: number;
}

const ipPaymentTracker = new Map<string, IpAttemptRecord>();

export function checkPaymentRateLimit(ip: string): { allowed: boolean; reason?: string } {
  const now = Date.now();
  const windowMs = 3600 * 1000; // 1 hour

  const record = ipPaymentTracker.get(ip) || {
    attempts: 0,
    firstAttemptTime: now,
    failedWebhooks: 0
  };

  // Reset window
  if (now - record.firstAttemptTime > windowMs) {
    record.attempts = 0;
    record.failedWebhooks = 0;
    record.firstAttemptTime = now;
  }

  if (record.failedWebhooks >= 5) {
    return {
      allowed: false,
      reason: 'Rate limit: Threshold of 5 failed webhooks exceeded for this IP. Cooldown in progress.'
    };
  }

  if (record.attempts >= 10) {
    return {
      allowed: false,
      reason: 'Rate limit: Exceeded maximum 10 payment attempts per hour from this IP.'
    };
  }

  record.attempts++;
  ipPaymentTracker.set(ip, record);
  return { allowed: true };
}

export function registerFailedWebhook(ip: string): void {
  const now = Date.now();
  const record = ipPaymentTracker.get(ip) || {
    attempts: 1,
    firstAttemptTime: now,
    failedWebhooks: 0
  };
  record.failedWebhooks++;
  ipPaymentTracker.set(ip, record);
}
