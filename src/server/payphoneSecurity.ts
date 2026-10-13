import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

const DEFAULT_DEV_SECRET = 'dev_payphone_secret_key_pacific_overdrive_2026';

function cleanEnv(val?: string): string | undefined {
  if (!val) return undefined;
  const trimmed = val.trim();
  const unquoted = trimmed.replace(/^["'](.*)["']$/, '$1').trim();
  return unquoted.length > 0 ? unquoted : undefined;
}

export function getPayphoneSecretKey(): string {
  return cleanEnv(process.env.PAYPHONE_SECRET_KEY) || cleanEnv(process.env.PAYPHONE_SECRET) || DEFAULT_DEV_SECRET;
}

export function getPayphoneToken(): string | undefined {
  return cleanEnv(process.env.PAYPHONE_TOKEN) || cleanEnv(process.env.PAYPHONE_BEARER_TOKEN) || cleanEnv(process.env.PAYPHONE_ACCESS_TOKEN);
}

export function getPayphoneClientId(): string | undefined {
  return cleanEnv(process.env.PAYPHONE_CLIENT_ID) || cleanEnv(process.env.PAYPHONE_APP_ID);
}

export function getPayphoneConfig() {
  return {
    token: getPayphoneToken(),
    clientId: getPayphoneClientId(),
    secretKey: getPayphoneSecretKey(),
    storeId: cleanEnv(process.env.PAYPHONE_STORE_ID),
    env: cleanEnv(process.env.PAYPHONE_ENV) || 'production',
    isConfigured: Boolean(getPayphoneToken())
  };
}

export async function createPayphonePaymentLink(params: {
  amountUsd: number;
  clientTransactionId: string;
  reference: string;
  responseUrl?: string;
  cancellationUrl?: string;
  phone?: string;
}): Promise<{ success: boolean; payUrl?: string; paymentId?: number; message?: string }> {
  const token = getPayphoneToken();
  if (!token) {
    return {
      success: false,
      message: 'Credenciales de Payphone pendientes. Por favor define PAYPHONE_TOKEN en las variables de entorno.'
    };
  }

  // Payphone amounts are in cents: $10.00 -> 1000
  const amountInCents = Math.round(params.amountUsd * 100);

  const payload: Record<string, any> = {
    amount: amountInCents,
    amountWithoutTax: amountInCents,
    amountWithTax: 0,
    tax: 0,
    service: 0,
    tip: 0,
    clientTransactionId: params.clientTransactionId,
    reference: params.reference,
    currency: 'USD',
    expireIn: 30
  };

  if (params.responseUrl) payload.responseUrl = params.responseUrl;
  if (params.cancellationUrl) payload.cancellationUrl = params.cancellationUrl;
  if (params.phone) payload.phoneNumber = params.phone;

  try {
    const res = await fetch('https://pay.payphonetodo.es/api/Links/Create', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = (await res.json()) as any;
    if (res.ok && (data.payWithPayPhone || data.url)) {
      return {
        success: true,
        payUrl: data.payWithPayPhone || data.url,
        paymentId: data.paymentId || data.id
      };
    }

    return {
      success: false,
      message: data.message || data.error || 'Error generando enlace de cobro en Payphone.'
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Error de conexión con la pasarela Payphone: ${err?.message || String(err)}`
    };
  }
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
