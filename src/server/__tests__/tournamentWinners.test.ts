import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { validateRegistrationContact } from '../../shared/registrationContact.js';
import type { LeaderboardEntry } from '../../shared/types.js';
import { DatabaseProvider } from '../db.js';
import { TournamentService } from '../tournamentService.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacific-winners-'));
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setup() {
  const db = new DatabaseProvider({ localDbPath: path.join(tmpDir, `${crypto.randomUUID()}.json`) });
  const service = new TournamentService(db);
  const pairs = ['ALFA', 'BRAVO', 'CHARLIE', 'DELTA'];
  for (const [i, name] of pairs.entries()) {
    const r = await service.simulateSandboxPayment(name, `${name}_NAV`, undefined, '127.0.0.1', {
      phone: `+59399000000${i}`,
      email: `${name.toLowerCase()}@example.com`
    });
    expect(r.success).toBe(true);
  }
  const payments = await db.listPaymentAudits();
  const byName = (n: string) => payments.find((p) => p.pair_driver_name === n)!;
  const tournament = await db.getActiveTournament();
  return { db, service, byName, tournament };
}

let seq = 0;
function score(
  partial: Partial<LeaderboardEntry> & { total_score: number; created_at: string }
): LeaderboardEntry {
  return {
    id: `s-${++seq}`,
    room_code: 'ROOM01',
    driver_name: 'X',
    navigator_name: 'Y',
    distance_traveled: 1000,
    survival_time: 60,
    region: 'PACIFIC-NET',
    is_tournament: true,
    ...partial
  };
}

describe('Tournament pass → payment link', () => {
  it('the pass check returns the exact payment it belongs to', async () => {
    const { service, byName } = await setup();
    const alfa = byName('ALFA');
    const check = await service.verifyTournamentPass(alfa.pass_token!);
    expect(check.valid).toBe(true);
    expect(check.payment_audit_id).toBe(alfa.id);
  });
});

describe('Winners report', () => {
  it('ranks one best score per paid pair, ties to whoever got there first, with contact data', async () => {
    const { db, service, byName, tournament } = await setup();
    const t = tournament.id;
    await db.saveMatchScore(score({ payment_audit_id: byName('ALFA').id, tournament_id: t, total_score: 900, created_at: '2026-10-01T10:00:00Z' }));
    await db.saveMatchScore(score({ payment_audit_id: byName('ALFA').id, tournament_id: t, total_score: 1200, created_at: '2026-10-01T11:00:00Z' }));
    await db.saveMatchScore(score({ payment_audit_id: byName('BRAVO').id, tournament_id: t, total_score: 1200, created_at: '2026-10-01T12:00:00Z' }));
    await db.saveMatchScore(score({ payment_audit_id: byName('CHARLIE').id, tournament_id: t, total_score: 500, created_at: '2026-10-01T09:00:00Z' }));
    await db.saveMatchScore(score({ payment_audit_id: byName('DELTA').id, tournament_id: t, total_score: 300, created_at: '2026-10-01T09:00:00Z' }));
    // Old tournament score without a payment link, and a practice score: neither counts
    await db.saveMatchScore(score({ total_score: 99_999, created_at: '2026-10-01T09:00:00Z' }));
    await db.saveMatchScore(score({ is_tournament: false, total_score: 50_000, created_at: '2026-10-01T09:00:00Z' }));

    const report = await service.getWinnersReport();
    expect(report.winners.map((w) => w.driver_name)).toEqual(['ALFA', 'BRAVO', 'CHARLIE']);
    expect(report.winners[0]).toMatchObject({
      place: 1,
      best_score: 1200,
      matches_played: 2,
      contact_phone: '+593990000000',
      contact_email: 'alfa@example.com',
      payphone_transaction_id: byName('ALFA').payphone_transaction_id
    });
    expect(report.winners[0].terms_accepted_at).toBeTruthy();
    expect(report.winners[0].pass_hint.startsWith('…-')).toBe(true);
    expect(report.unlinked_tournament_scores).toBe(1);
    expect(report.can_record_payouts).toBe(false);
  });

  it('prizes can be recorded only after closing, once per place, with a reference', async () => {
    const { db, service, byName, tournament } = await setup();
    const t = tournament.id;
    await db.saveMatchScore(score({ payment_audit_id: byName('ALFA').id, tournament_id: t, total_score: 800, created_at: '2026-10-01T10:00:00Z' }));
    await db.saveMatchScore(score({ payment_audit_id: byName('BRAVO').id, tournament_id: t, total_score: 700, created_at: '2026-10-01T10:00:00Z' }));

    await expect(service.recordPrizePayout(1, 'TRX-0001', '', '127.0.0.1')).rejects.toThrow(/Cierra el torneo/);

    const closed = await service.closeTournamentAndDistributePodium();
    // A score saved after closing never changes the podium
    await db.saveMatchScore(
      score({ payment_audit_id: byName('DELTA').id, tournament_id: t, total_score: 99_999, created_at: '2999-01-01T00:00:00Z' })
    );

    const report = await service.getWinnersReport();
    expect(report.can_record_payouts).toBe(true);
    expect(report.winners.map((w) => w.driver_name)).toEqual(['ALFA', 'BRAVO']);
    expect(report.winners[0].prize_usd).toBe(closed.podium_distribution.first_place);

    await expect(service.recordPrizePayout(1, 'abc', '', '127.0.0.1')).rejects.toThrow(/referencia/);
    await expect(service.recordPrizePayout(3, 'TRX-0003', '', '127.0.0.1')).rejects.toThrow(/No hay pareja/);
    await expect(service.recordPrizePayout(4, 'TRX-0004', '', '127.0.0.1')).rejects.toThrow(/Lugar inválido/);

    const payout = await service.recordPrizePayout(1, 'Transferencia #123456', 'Pagado a ALFA', '10.0.0.1');
    expect(payout).toMatchObject({ place: 1, payment_audit_id: byName('ALFA').id, reference: 'Transferencia #123456' });
    await expect(service.recordPrizePayout(1, 'Transferencia #999', '', '10.0.0.1')).rejects.toThrow(/ya fue marcado/);

    const after = await service.getWinnersReport();
    expect(after.winners[0].payout?.reference).toBe('Transferencia #123456');
    expect(after.winners[1].payout).toBeNull();
  });
});

describe('Privacy: contact data retention', () => {
  it('erases phone, e-mail and the raw Payphone payload 30 days after closing, keeping the payment', async () => {
    const { db, service, byName } = await setup();
    const alfa = byName('ALFA');

    // Open tournament: nothing is erased
    expect(await service.purgeExpiredContactData()).toBe(0);

    const closed = await service.closeTournamentAndDistributePodium();
    const closedAt = Date.parse(closed.tournament.completed_at!);
    const day = 24 * 60 * 60 * 1000;

    // Day 29 after closing: still kept (winners may still be contacted)
    expect(await service.purgeExpiredContactData(new Date(closedAt + 29 * day))).toBe(0);
    expect((await db.getPendingRegistration(alfa.client_transaction_id!))?.email).toBe('alfa@example.com');

    // Day 31: gone, but the payment record (transaction id, amounts) stays
    expect(await service.purgeExpiredContactData(new Date(closedAt + 31 * day))).toBeGreaterThan(0);
    const pending = await db.getPendingRegistration(alfa.client_transaction_id!);
    expect(pending?.phone).toBeUndefined();
    expect(pending?.email).toBeUndefined();
    const payment = await db.getPaymentAuditById(alfa.id);
    expect(payment?.raw_payload_json).toBeUndefined();
    expect(payment?.payphone_transaction_id).toBe(alfa.payphone_transaction_id);
    expect(payment?.gross_amount).toBe(alfa.gross_amount);

    const report = await service.getWinnersReport();
    expect(report.winners.every((w) => w.contact_email === null)).toBe(true);
  });
});

describe('Registration contact', () => {
  it('requires a phone, an e-mail and accepting the rules', () => {
    expect(validateRegistrationContact({ phone: '+593 99-123 4567', email: ' Ana@Mail.com ', accept_terms: true })).toEqual({
      ok: true,
      phone: '+593991234567',
      email: 'ana@mail.com'
    });
    expect(validateRegistrationContact({ phone: '123', email: 'ana@mail.com', accept_terms: true })).toMatchObject({ ok: false, field: 'phone' });
    expect(validateRegistrationContact({ phone: '0991234567', email: 'ana@mail', accept_terms: true })).toMatchObject({ ok: false, field: 'email' });
    expect(validateRegistrationContact({ phone: '0991234567', email: 'ana@mail.com', accept_terms: 'yes' })).toMatchObject({ ok: false, field: 'terms' });
    expect(validateRegistrationContact({ phone: '0991234567', email: 'ana@mail.com' })).toMatchObject({ ok: false, field: 'terms' });
  });
});
