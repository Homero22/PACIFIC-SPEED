import crypto from 'crypto';
import { cleanEnv, devFallbackSecret, isProductionEnv } from './runtimeConfig.js';

export function getPayphoneSecretKey(): string {
  const configured = cleanEnv(process.env.PAYPHONE_SECRET_KEY) || cleanEnv(process.env.PAYPHONE_SECRET);
  if (configured) return configured;
  if (isProductionEnv()) {
    throw new Error('PAYPHONE_SECRET_KEY no configurada en producción.');
  }
  return devFallbackSecret('PAYPHONE_SECRET_KEY');
}

export function getPayphoneToken(): string | undefined {
  return cleanEnv(process.env.PAYPHONE_TOKEN) || cleanEnv(process.env.PAYPHONE_BEARER_TOKEN) || cleanEnv(process.env.PAYPHONE_ACCESS_TOKEN);
}

export function getPayphoneClientId(): string | undefined {
  return cleanEnv(process.env.PAYPHONE_CLIENT_ID) || cleanEnv(process.env.PAYPHONE_APP_ID);
}

export function getPayphoneBaseUrl(): string {
  return cleanEnv(process.env.PAYPHONE_API_URL) || 'https://pay.payphonetodoesposible.com';
}

export function getPayphoneStoreId(): string | undefined {
  return cleanEnv(process.env.PAYPHONE_STORE_ID);
}

export function getPayphoneConfig() {
  return {
    token: getPayphoneToken(),
    clientId: getPayphoneClientId(),
    storeId: getPayphoneStoreId(),
    baseUrl: getPayphoneBaseUrl(),
    isConfigured: Boolean(getPayphoneToken())
  };
}

export async function preparePayphoneTransaction(params: {
  amountUsd: number;
  clientTransactionId: string;
  reference: string;
  responseUrl: string;
  cancellationUrl: string;
}): Promise<{
  success: boolean;
  paymentId?: number;
  payWithCard?: string;
  payWithPayPhone?: string;
  payUrl?: string;
  message?: string;
}> {
  const token = getPayphoneToken();
  if (!token) {
    return {
      success: false,
      message: 'Credenciales de Payphone pendientes. Por favor define PAYPHONE_TOKEN en las variables de entorno.'
    };
  }

  // Payphone amounts are in cents: $10.00 -> 1000
  const amountInCents = Math.round(params.amountUsd * 100);
  const storeId = getPayphoneStoreId();

  const payload: Record<string, any> = {
    responseUrl: params.responseUrl,
    cancellationUrl: params.cancellationUrl,
    amount: amountInCents,
    amountWithoutTax: amountInCents,
    amountWithTax: 0,
    tax: 0,
    service: 0,
    tip: 0,
    clientTransactionId: params.clientTransactionId,
    currency: 'USD',
    reference: params.reference,
    expireIn: 30
  };

  if (storeId) {
    payload.storeId = storeId;
  }

  const baseUrl = getPayphoneBaseUrl();

  try {
    const res = await fetch(`${baseUrl}/api/button/Prepare`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = (await res.json()) as any;
    if (res.ok && (data.payWithCard || data.payWithPayPhone || data.paymentId)) {
      const payUrl = data.payWithCard || data.payWithPayPhone;
      return {
        success: true,
        paymentId: data.paymentId || data.id,
        payWithCard: data.payWithCard,
        payWithPayPhone: data.payWithPayPhone,
        payUrl
      };
    }

    return {
      success: false,
      message: data.message || data.error || `Error generando botón en Payphone (HTTP ${res.status})`
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Error de conexión con la pasarela Payphone: ${err?.message || String(err)}`
    };
  }
}

export async function confirmPayphoneTransaction(
  id: number | string,
  clientTxId: string
): Promise<{
  success: boolean;
  approved: boolean;
  transactionId?: number | string;
  data?: any;
  message?: string;
}> {
  const token = getPayphoneToken();
  if (!token) {
    return {
      success: false,
      approved: false,
      message: 'Credenciales de Payphone pendientes. Por favor define PAYPHONE_TOKEN.'
    };
  }

  const baseUrl = getPayphoneBaseUrl();
  const payload = {
    id: Number(id),
    clientTxId: String(clientTxId)
  };

  try {
    const res = await fetch(`${baseUrl}/api/button/V2/Confirm`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = (await res.json()) as any;
    if (res.ok) {
      const isApproved =
        data.transactionStatus === 'Approved' ||
        data.statusCode === 3 ||
        data.status === 'Approved';

      return {
        success: true,
        approved: isApproved,
        transactionId: data.transactionId || id,
        data,
        message: isApproved
          ? 'Transacción confirmada y aprobada por Payphone.'
          : (data.message || `Transacción no aprobada (estado: ${data.transactionStatus || data.statusCode})`)
      };
    }

    return {
      success: false,
      approved: false,
      data,
      message: data.message || data.error || `Error en confirmación de Payphone (HTTP ${res.status})`
    };
  } catch (err: any) {
    return {
      success: false,
      approved: false,
      message: `Error de red al confirmar con Payphone: ${err?.message || String(err)}`
    };
  }
}

export async function createPayphonePaymentLink(params: {
  amountUsd: number;
  clientTransactionId: string;
  reference: string;
  responseUrl?: string;
  cancellationUrl?: string;
  phone?: string;
}): Promise<{ success: boolean; payUrl?: string; payWithCard?: string; payWithPayPhone?: string; paymentId?: number; message?: string }> {
  const respUrl = params.responseUrl || 'http://localhost:3000/api/payphone/callback';
  const cancUrl = params.cancellationUrl || 'http://localhost:3000/';

  return preparePayphoneTransaction({
    amountUsd: params.amountUsd,
    clientTransactionId: params.clientTransactionId,
    reference: params.reference,
    responseUrl: respUrl,
    cancellationUrl: cancUrl
  });
}

/**
 * Random, non-guessable clientTransactionId for Payphone Prepare (max 50 chars).
 */
export function generateClientTransactionId(): string {
  return `PS-${Date.now().toString(36)}-${crypto.randomBytes(9).toString('hex')}`.toUpperCase();
}

/**
 * Validates a Payphone V2/Confirm response against the pending registration we created.
 * Returns an error message, or null when the confirmation matches exactly.
 */
export function validateConfirmAgainstPending(
  data: { clientTransactionId?: unknown; amount?: unknown } | undefined,
  expectedClientTxId: string,
  expectedAmountUsd: number
): string | null {
  if (!data) return 'Respuesta de confirmación vacía.';
  if (String(data.clientTransactionId ?? '') !== expectedClientTxId) {
    return 'clientTransactionId confirmado por Payphone no coincide con la inscripción.';
  }
  const confirmedCents = Number(data.amount);
  const expectedCents = Math.round(expectedAmountUsd * 100);
  if (!Number.isInteger(confirmedCents) || confirmedCents !== expectedCents) {
    return `Monto confirmado (${data.amount}) no coincide con la cuota esperada (${expectedCents} centavos).`;
  }
  return null;
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
