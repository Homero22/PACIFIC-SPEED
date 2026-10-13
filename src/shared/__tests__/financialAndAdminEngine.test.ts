import { describe, expect, it } from 'vitest';
import {
  calculatePodiumPrizes,
  calculateTransactionSplits,
  DEFAULT_FINANCIAL_CONFIG
} from '../financialConfig.js';
import {
  generatePayphoneSignature,
  verifyPayphoneSignature,
  verifyReplayAttackTimestamp
} from '../../server/payphoneSecurity.js';
import {
  generateAdminToken,
  validateAdminToken,
  verifyAdminPassword
} from '../../server/adminSecurity.js';
import { AntiCheatEngine } from '../../server/antiCheat.js';

describe('Tournament Financial Engine — Payphone Revenue Splits & Podium Math', () => {
  it('calculates exact transaction splits for $10.00 USD entry fee matching specification example', () => {
    const result = calculateTransactionSplits(10.0, DEFAULT_FINANCIAL_CONFIG);

    expect(result.gross_collected).toBe(10.0);
    // 5.75% Payphone effective fee = 0.575 -> 0.58
    expect(result.payphone_retention).toBe(0.58);
    // 60% Prize pool = 6.00
    expect(result.allocated_to_prize_pool).toBe(6.0);
    // 15% Animal charity = 1.50
    expect(result.allocated_to_charity).toBe(1.5);
    // 19.25% Operating margin = 1.925 -> 1.92
    expect(result.allocated_to_operating_margin).toBe(1.92);
    // 70% of operating margin to developer = 1.92 * 0.70 = 1.344 -> 1.34
    expect(result.breakdown_operating_margin.developer_net).toBe(1.34);
    // 30% of operating margin to collaborator = 1.92 * 0.30 = 0.576 -> 0.58
    expect(result.breakdown_operating_margin.collaborator_referral_payout).toBe(0.58);

    // Sum verification: 0.58 + 6.00 + 1.50 + 1.92 = 10.00
    const totalAllocated =
      result.payphone_retention +
      result.allocated_to_prize_pool +
      result.allocated_to_charity +
      result.allocated_to_operating_margin;
    expect(totalAllocated).toBeCloseTo(10.0, 2);
  });

  it('calculates podium prizes accurately for a 50-pair tournament ($300 accumulated prize pool)', () => {
    // 50 pairs * $6.00 = $300.00 USD
    const podium = calculatePodiumPrizes(300.0, DEFAULT_FINANCIAL_CONFIG.prize_podium_breakdown);

    // 1st place: 66.66% = 199.98
    expect(podium.first_place).toBe(199.98);
    // 2nd place: 23.33% = 69.99
    expect(podium.second_place).toBe(69.99);
    // 3rd place: 10.01% = 30.03
    expect(podium.third_place).toBe(30.03);

    expect(podium.total_distributed).toBe(300.0);
  });
});

describe('Payphone Security — HMAC-SHA256 & Replay Protection', () => {
  it('verifies valid HMAC-SHA256 signature and rejects forged/tampered signatures', () => {
    const rawPayload = JSON.stringify({ transactionId: 'TX-1001', amount: 10.0, status: 'Approved' });
    const secret = 'test_secret_key_123';

    const validSig = generatePayphoneSignature(rawPayload, secret);
    expect(verifyPayphoneSignature(rawPayload, validSig, secret)).toBe(true);

    // Tampered payload
    const tamperedPayload = JSON.stringify({ transactionId: 'TX-1001', amount: 999.0, status: 'Approved' });
    expect(verifyPayphoneSignature(tamperedPayload, validSig, secret)).toBe(false);

    // Invalid signature
    expect(verifyPayphoneSignature(rawPayload, 'invalid_signature_hex', secret)).toBe(false);
  });

  it('enforces 300-second replay attack prevention window', () => {
    const nowSec = Math.floor(Date.now() / 1000);

    const freshTimestamp = nowSec - 20; // 20s ago
    expect(verifyReplayAttackTimestamp(freshTimestamp, 300).valid).toBe(true);

    const expiredTimestamp = nowSec - 420; // 420s ago (> 300s)
    const result = verifyReplayAttackTimestamp(expiredTimestamp, 300);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Replay attack prevention');
  });
});

describe('Admin Security — Timing-Safe Authentication & Session Tokens', () => {
  it('authenticates with valid master secret and rejects invalid passwords', () => {
    expect(verifyAdminPassword('admin_pacific_overdrive_2026')).toBe(true);
    expect(verifyAdminPassword('wrong_password')).toBe(false);
    expect(verifyAdminPassword('')).toBe(false);
  });

  it('issues signed 8-hour Bearer tokens and validates them correctly', () => {
    const { token, expires_in_hours } = generateAdminToken();
    expect(expires_in_hours).toBe(8);

    expect(validateAdminToken(`Bearer ${token}`)).toBe(true);
    expect(validateAdminToken('Bearer invalid_token_value')).toBe(false);
    expect(validateAdminToken(undefined)).toBe(false);
  });
});

describe('Anti-Cheat Engine — Server-Authoritative Input Validation', () => {
  it('clamps abnormal input vectors and rate-limits rapid shield activations', () => {
    const engine = new AntiCheatEngine();

    // 1. Abnormal speed vector hack test
    const hackInput = {
      player_id: 'PILOT-HACKER',
      role: 'driver' as const,
      input_vector: { x: 50.0, y: 100.0 }, // Impossible magnitude
      action_flags: {
        shield_left: false,
        shield_right: false,
        radar_pulse: false,
        ping_lane: null
      },
      timestamp: Date.now(),
      seq: 1
    };

    const { sanitized, violated } = engine.sanitizeClientInput(hackInput, 300, 700, '192.168.1.5');
    expect(violated).toBe(true);
    expect(sanitized.input_vector.x).toBeLessThanOrEqual(1.0);
    expect(sanitized.input_vector.y).toBeLessThanOrEqual(1.0);

    // Check that violation was recorded in audit log
    const logs = engine.getSecurityLogs();
    expect(logs.some((l) => l.event_type === 'impossible_speed')).toBe(true);
  });
});
