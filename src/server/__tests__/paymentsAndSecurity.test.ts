import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyFinancialConfigUpdate,
  calculateTransactionSplits,
  DEFAULT_FINANCIAL_CONFIG
} from '../../shared/financialConfig.js';
import { escapeHtml, safeHttpUrl } from '../../shared/escapeHtml.js';
import type { PendingRegistrationRecord } from '../../shared/types.js';
import { generateAdminToken, validateAdminToken, verifyAdminPassword } from '../adminSecurity.js';
import { DatabaseProvider, DatabaseUnavailableError } from '../db.js';
import { generateClientTransactionId, validateConfirmAgainstPending } from '../payphoneSecurity.js';
import { collectProductionConfigErrors } from '../runtimeConfig.js';
import { TournamentService } from '../tournamentService.js';
import { isAllowedWsOrigin, parseClientMessage, sanitizeCosmetics, SocketRateLimiter } from '../wsValidation.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacific-speed-test-'));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function freshService() {
  const db = new DatabaseProvider({ localDbPath: path.join(tmpDir, `${crypto.randomUUID()}.json`) });
  return { db, service: new TournamentService(db) };
}

async function createPending(
  service: TournamentService,
  overrides: Partial<PendingRegistrationRecord> = {}
): Promise<PendingRegistrationRecord> {
  const gate = await service.checkRegistrationOpen();
  if (!gate.open) throw new Error(gate.message);
  const record: PendingRegistrationRecord = {
    client_transaction_id: generateClientTransactionId(),
    driver_name: 'ALFA',
    navigator_name: 'BRAVO',
    amount_usd: gate.tournament.entry_fee_usd,
    status: 'PENDING',
    tournament_id: gate.tournament.id,
    created_at: new Date().toISOString(),
    ...overrides
  };
  await service.createPendingRegistration(record);
  return record;
}

function mockConfirm(data: Record<string, unknown>) {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => data }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Payphone callback — confirmation is validated and applied atomically', () => {
  beforeEach(() => {
    process.env.PAYPHONE_TOKEN = 'test-token';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PAYPHONE_TOKEN;
  });

  it('credits an approved payment once, issues a random pass and is idempotent', async () => {
    const { db, service } = freshService();
    const pending = await createPending(service, { referral_code: 'SPEED2026' });
    mockConfirm({
      transactionStatus: 'Approved',
      statusCode: 3,
      transactionId: 987654,
      clientTransactionId: pending.client_transaction_id,
      amount: 1000
    });

    const first = await service.handlePayphoneCallback('987654', pending.client_transaction_id);
    expect(first.success).toBe(true);
    expect(first.auditRecord?.pass_token).toMatch(/^PS(-[0-9A-F]{4}){8}$/);
    expect(first.auditRecord?.collaborator_share).toBeGreaterThan(0);

    const again = await service.handlePayphoneCallback('987654', pending.client_transaction_id);
    expect(again.success).toBe(true);
    expect(again.auditRecord?.pass_token).toBe(first.auditRecord?.pass_token);

    const tournament = await db.getActiveTournament();
    expect(tournament.registered_couples_count).toBe(1);
    expect(tournament.accumulated_prize_pool).toBe(6);
    expect(tournament.accumulated_charity_amount).toBe(1.5);

    const referral = await db.getReferralByCode('SPEED2026');
    expect(referral?.total_couples_referred).toBe(1);
    expect(referral?.pending_earnings_usd).toBe(first.auditRecord?.collaborator_share);
    expect((await db.getPendingRegistration(pending.client_transaction_id))?.status).toBe('COMPLETED');
  });

  it('does not reveal another pair\'s pass when the Payphone id is reused with a different clientTransactionId', async () => {
    const { service } = freshService();
    const victim = await createPending(service);
    mockConfirm({ transactionStatus: 'Approved', transactionId: 111, clientTransactionId: victim.client_transaction_id, amount: 1000 });
    expect((await service.handlePayphoneCallback('111', victim.client_transaction_id)).success).toBe(true);

    const attacker = await createPending(service);
    const result = await service.handlePayphoneCallback('111', attacker.client_transaction_id);
    expect(result.success).toBe(false);
    expect(result.auditRecord).toBeUndefined();
  });

  it('rejects confirmations whose amount does not match the pending entry fee', async () => {
    const { db, service } = freshService();
    const pending = await createPending(service);
    mockConfirm({ transactionStatus: 'Approved', transactionId: 222, clientTransactionId: pending.client_transaction_id, amount: 1 });

    const result = await service.handlePayphoneCallback('222', pending.client_transaction_id);
    expect(result.success).toBe(false);
    expect((await db.getActiveTournament()).registered_couples_count).toBe(0);
    expect((await db.getPendingRegistration(pending.client_transaction_id))?.status).toBe('REFUND_REQUIRED');
  });

  it('rejects confirmations for a different clientTransactionId', async () => {
    const { db, service } = freshService();
    const pending = await createPending(service);
    mockConfirm({ transactionStatus: 'Approved', transactionId: 333, clientTransactionId: 'PS-OTHER', amount: 1000 });

    expect((await service.handlePayphoneCallback('333', pending.client_transaction_id)).success).toBe(false);
    expect((await db.getActiveTournament()).registered_couples_count).toBe(0);
  });

  it('never calls Payphone for unknown or already processed registrations', async () => {
    const { service } = freshService();
    const fetchMock = mockConfirm({});
    expect((await service.handlePayphoneCallback('444', 'PS-UNKNOWN')).success).toBe(false);
    expect((await service.handlePayphoneCallback('abc', 'PS-UNKNOWN')).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records collaborator_share = 0 when the pair has no referral', async () => {
    const { service } = freshService();
    const pending = await createPending(service);
    mockConfirm({ transactionStatus: 'Approved', transactionId: 555, clientTransactionId: pending.client_transaction_id, amount: 1000 });

    const result = await service.handlePayphoneCallback('555', pending.client_transaction_id);
    expect(result.auditRecord?.collaborator_share).toBe(0);
    expect(result.auditRecord?.developer_share).toBe(1.92);
  });

  it('never exceeds max_couples: capacity is checked before Prepare and again atomically on apply', async () => {
    const { db, service } = freshService();
    await service.updateDynamicConfig({ max_couples_limit: 2 });
    const a = await createPending(service);
    const b = await createPending(service);
    const c = await createPending(service);

    let n = 600;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ transactionStatus: 'Approved', transactionId: n++, clientTransactionId: body.clientTxId, amount: 1000 }) };
      })
    );

    const results = await Promise.all([
      service.handlePayphoneCallback('601', a.client_transaction_id),
      service.handlePayphoneCallback('602', b.client_transaction_id),
      service.handlePayphoneCallback('603', c.client_transaction_id)
    ]);
    expect(results.filter((r) => r.success)).toHaveLength(2);
    const tournament = await db.getActiveTournament();
    expect(tournament.registered_couples_count).toBe(2);
    expect(tournament.status).toBe('in_progress');
    expect((await service.checkRegistrationOpen()).open).toBe(false);
  });
});

describe('Tournament pass tokens', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts only the issued random token for the active tournament (not the Payphone transaction id)', async () => {
    process.env.PAYPHONE_TOKEN = 'test-token';
    const { db, service } = freshService();
    const pending = await createPending(service);
    mockConfirm({ transactionStatus: 'Approved', transactionId: 777, clientTransactionId: pending.client_transaction_id, amount: 1000 });
    const result = await service.handlePayphoneCallback('777', pending.client_transaction_id);
    const pass = result.auditRecord!.pass_token!;
    delete process.env.PAYPHONE_TOKEN;

    expect((await service.verifyTournamentPass(pass)).valid).toBe(true);
    expect((await service.verifyTournamentPass(pass.toLowerCase())).valid).toBe(true);
    expect((await service.verifyTournamentPass('777')).valid).toBe(false);
    expect((await service.verifyTournamentPass(pending.client_transaction_id)).valid).toBe(false);
    expect((await db.verifyTournamentPass(pass, 'another-tournament')).valid).toBe(false);
  });
});

describe('Database availability — no silent fallback when PostgreSQL is configured', () => {
  afterEach(() => {
    delete process.env.DATABASE_URL;
    vi.unstubAllGlobals();
  });

  it('throws DatabaseUnavailableError instead of writing to local JSON', async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@db.invalid:5432/app';
    const db = new DatabaseProvider({ localDbPath: path.join(tmpDir, 'must-not-exist.json') });
    const service = new TournamentService(db);
    const fetchMock = mockConfirm({});

    expect(db.isAvailable()).toBe(false);
    await expect(db.getActiveTournament()).rejects.toBeInstanceOf(DatabaseUnavailableError);
    await expect(service.handlePayphoneCallback('1', 'PS-X')).rejects.toBeInstanceOf(DatabaseUnavailableError);
    await expect(service.checkRegistrationOpen()).rejects.toBeInstanceOf(DatabaseUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, 'must-not-exist.json'))).toBe(false);
  });
});

describe('Admin financial configuration', () => {
  it('maps the base Payphone fee and recomputes the effective fee with IVA', () => {
    const next = applyFinancialConfigUpdate(DEFAULT_FINANCIAL_CONFIG, { payphone_percentage_fee: 0.05 });
    expect(next.pricing_structure.payphone_gateway.percentage_fee).toBe(0.05);
    expect(next.pricing_structure.payphone_gateway.effective_fee_percentage_calculated).toBe(0.0575);
    expect(next.pricing_structure.revenue_allocation_percentages.gross_operating_margin.percentage_of_gross).toBe(0.1925);
    // Saving the form unchanged must not drift the fee (old bug: 5% -> 5.75% -> 6.61%...)
    const again = applyFinancialConfigUpdate(next, { payphone_percentage_fee: next.pricing_structure.payphone_gateway.percentage_fee });
    expect(again.pricing_structure.payphone_gateway.effective_fee_percentage_calculated).toBe(0.0575);
  });

  it('rejects splits above 100% and keeps developer + collaborator = 100%', () => {
    expect(() => applyFinancialConfigUpdate(DEFAULT_FINANCIAL_CONFIG, { prize_pool_percentage: 0.9 })).toThrow(/100%/);
    expect(() =>
      applyFinancialConfigUpdate(DEFAULT_FINANCIAL_CONFIG, { developer_share_of_margin: 0.5, collaborator_share_of_margin: 0.6 })
    ).toThrow(/100%/);
    const next = applyFinancialConfigUpdate(DEFAULT_FINANCIAL_CONFIG, { developer_share_of_margin: 0.6 });
    expect(next.pricing_structure.margin_sub_distribution.collaborator_pool_share.percentage_of_operating_margin).toBe(0.4);
    expect(() => applyFinancialConfigUpdate(DEFAULT_FINANCIAL_CONFIG, { entry_fee_per_pair: -5 })).toThrow();
    expect(() => applyFinancialConfigUpdate(DEFAULT_FINANCIAL_CONFIG, { max_couples_limit: 2.5 })).toThrow();
  });

  it('syncs entry fee and capacity into the active tournament and refuses capacity below registrations', async () => {
    const { db, service } = freshService();
    await service.updateDynamicConfig({ entry_fee_per_pair: 12, max_couples_limit: 30 });
    const t = await db.getActiveTournament();
    expect(t.entry_fee_usd).toBe(12);
    expect(t.max_couples).toBe(30);

    await db.saveTournament({ ...t });
    process.env.PAYPHONE_TOKEN = 'test-token';
    const pending = await createPending(service);
    mockConfirm({ transactionStatus: 'Approved', transactionId: 888, clientTransactionId: pending.client_transaction_id, amount: 1200 });
    expect((await service.handlePayphoneCallback('888', pending.client_transaction_id)).success).toBe(true);
    vi.unstubAllGlobals();
    delete process.env.PAYPHONE_TOKEN;

    await service.updateDynamicConfig({ max_couples_limit: 2 });
    await expect(service.updateDynamicConfig({ max_couples_limit: 1 })).rejects.toThrow();
  });

  it('splits without referral leave nothing for collaborators and still add up', () => {
    const s = calculateTransactionSplits(10, DEFAULT_FINANCIAL_CONFIG, false);
    expect(s.breakdown_operating_margin.collaborator_referral_payout).toBe(0);
    expect(s.breakdown_operating_margin.developer_net).toBe(s.allocated_to_operating_margin);
    const total = s.payphone_retention + s.allocated_to_prize_pool + s.allocated_to_charity + s.allocated_to_operating_margin;
    expect(Math.round(total * 100) / 100).toBe(10);
  });
});

describe('Payphone confirmation validation', () => {
  it('requires the exact clientTransactionId and amount in cents', () => {
    expect(validateConfirmAgainstPending({ clientTransactionId: 'PS-1', amount: 1000 }, 'PS-1', 10)).toBeNull();
    expect(validateConfirmAgainstPending({ clientTransactionId: 'PS-2', amount: 1000 }, 'PS-1', 10)).not.toBeNull();
    expect(validateConfirmAgainstPending({ clientTransactionId: 'PS-1', amount: 100 }, 'PS-1', 10)).not.toBeNull();
    expect(validateConfirmAgainstPending({ clientTransactionId: 'PS-1' }, 'PS-1', 10)).not.toBeNull();
    expect(validateConfirmAgainstPending(undefined, 'PS-1', 10)).not.toBeNull();
  });

  it('generates unguessable client transaction ids', () => {
    const a = generateClientTransactionId();
    const b = generateClientTransactionId();
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(50);
    expect(a).toMatch(/^PS-[0-9A-Z]+-[0-9A-F]{18}$/);
  });
});

describe('Production configuration and admin secrets', () => {
  const valid = {
    ADMIN_SECRET_KEY: 'una-clave-larga-y-nueva',
    ADMIN_TOKEN_SECRET: 'x'.repeat(40),
    PAYPHONE_SECRET_KEY: 'pp-secret',
    PAYPHONE_TOKEN: 'pp-token'
  };

  it('refuses to start without mandatory secrets or with the leaked admin key', () => {
    expect(collectProductionConfigErrors({} as NodeJS.ProcessEnv).length).toBe(4);
    expect(collectProductionConfigErrors(valid as NodeJS.ProcessEnv)).toEqual([]);
    expect(
      collectProductionConfigErrors({ ...valid, ADMIN_SECRET_KEY: 'admin_pacific_overdrive_2026--' } as NodeJS.ProcessEnv)
    ).toHaveLength(1);
    expect(
      collectProductionConfigErrors({ ...valid, ADMIN_TOKEN_SECRET: valid.ADMIN_SECRET_KEY } as NodeJS.ProcessEnv).length
    ).toBeGreaterThan(0);
  });

  it('signs admin tokens with ADMIN_TOKEN_SECRET, not with the login key', () => {
    process.env.ADMIN_SECRET_KEY = 'login-key-for-tests';
    process.env.ADMIN_TOKEN_SECRET = 'token-secret-for-tests-'.padEnd(40, 'z');
    try {
      expect(verifyAdminPassword('login-key-for-tests')).toBe(true);
      const { token } = generateAdminToken();
      expect(validateAdminToken(`Bearer ${token}`)).toBe(true);

      const [payload] = token.split('.');
      const forged = crypto.createHmac('sha256', 'login-key-for-tests').update(payload).digest('base64url');
      expect(validateAdminToken(`Bearer ${payload}.${forged}`)).toBe(false);

      process.env.ADMIN_TOKEN_SECRET = 'rotated-secret-'.padEnd(40, 'y');
      expect(validateAdminToken(`Bearer ${token}`)).toBe(false);
    } finally {
      delete process.env.ADMIN_SECRET_KEY;
      delete process.env.ADMIN_TOKEN_SECRET;
    }
  });

  it('has no hardcoded development admin key', () => {
    expect(verifyAdminPassword('admin_pacific_overdrive_2026')).toBe(false);
    expect(verifyAdminPassword('admin_pacific_overdrive_2026--')).toBe(false);
  });
});

describe('HTML escaping helpers', () => {
  it('neutralizes markup from URL params, player names and logs', () => {
    const payload = '<img src=x onerror="fetch(`//evil`)">\'';
    const escaped = escapeHtml(payload);
    expect(escaped).not.toMatch(/[<>"'`]/);
    expect(escaped).toBe('&lt;img src=x onerror=&quot;fetch(&#96;//evil&#96;)&quot;&gt;&#39;');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('only allows http(s) checkout URLs', () => {
    expect(safeHttpUrl('https://pay.payphonetodoesposible.com/x')).toBe('https://pay.payphonetodoesposible.com/x');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,hi')).toBeNull();
    expect(safeHttpUrl(42)).toBeNull();
  });
});

describe('WebSocket message validation', () => {
  it('whitelists cosmetics and sanitizes names', () => {
    expect(sanitizeCosmetics({ paintJob: '<script>', neonTrail: 'solar_flare', hudTheme: 5 })).toEqual({
      paintJob: 'crimson_jaeger',
      neonTrail: 'solar_flare',
      hudTheme: 'tactical_amber'
    });
    const join = parseClientMessage(
      JSON.stringify({ type: 'join_room', room_code: 'NEURAL-01', player_id: 'p1', name: '<b>x</b>"onload', cosmetics: null })
    );
    expect(join?.type).toBe('join_room');
    if (join?.type === 'join_room') {
      expect(join.name).not.toMatch(/[<>"]/);
      expect(join.cosmetics.paintJob).toBe('crimson_jaeger');
    }
  });

  it('rejects malformed or unknown messages', () => {
    expect(parseClientMessage('not json')).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'drop_tables' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'switch_role', role: 'admin' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'send_comms', preset: '__proto__' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'join_room', room_code: 'A'.repeat(200), player_id: 'p' }))).toBeNull();
    const input = parseClientMessage(
      JSON.stringify({ type: 'player_input', payload: { input_vector: { x: 'NaN', y: 1e309 }, action_flags: { ping_lane: 7 } } })
    );
    expect(input?.type === 'player_input' && input.payload.input_vector).toEqual({ x: 0, y: 0 });
    expect(input?.type === 'player_input' && input.payload.action_flags.ping_lane).toBeNull();
  });

  it('rate limits per socket and flags floods', () => {
    let now = 0;
    const limiter = new SocketRateLimiter(5, () => now);
    const verdicts = Array.from({ length: 16 }, () => limiter.hit());
    expect(verdicts.slice(0, 5).every((v) => v === 'ok')).toBe(true);
    expect(verdicts[5]).toBe('drop');
    expect(verdicts[15]).toBe('abuse');
    now = 1500;
    expect(limiter.hit()).toBe('ok');
  });

  it('checks the Origin of WebSocket upgrades', () => {
    expect(isAllowedWsOrigin('https://game.example', 'game.example', [], true)).toBe(true);
    expect(isAllowedWsOrigin('https://evil.example', 'game.example', [], true)).toBe(false);
    expect(isAllowedWsOrigin('https://partner.example', 'game.example', ['https://partner.example'], true)).toBe(true);
    expect(isAllowedWsOrigin('http://localhost:5173', 'localhost:3000', [], false)).toBe(true);
    expect(isAllowedWsOrigin('http://localhost:5173', 'game.example', [], true)).toBe(false);
    expect(isAllowedWsOrigin(undefined, 'game.example', [], true)).toBe(true);
  });
});
