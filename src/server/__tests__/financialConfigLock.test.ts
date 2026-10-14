import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyFinancialConfigUpdate,
  calculateTransactionSplits,
  DEFAULT_FINANCIAL_CONFIG,
  diffFinancialConfig,
  round2
} from '../../shared/financialConfig.js';
import { DatabaseProvider } from '../db.js';
import { ConfigLockedError, ConfigValidationError, TournamentService } from '../tournamentService.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacific-speed-cfg-'));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function freshService() {
  const db = new DatabaseProvider({ localDbPath: path.join(tmpDir, `${crypto.randomUUID()}.json`) });
  return { db, service: new TournamentService(db) };
}

describe('Reparto por pareja — siempre cuadra al centavo', () => {
  it.each([1, 5, 10, 11, 12.5, 13.37, 20, 99.99])('cuota $%s con y sin referido', (fee) => {
    for (const hasReferral of [true, false]) {
      const s = calculateTransactionSplits(fee, DEFAULT_FINANCIAL_CONFIG, hasReferral);
      const parts =
        s.payphone_retention +
        s.allocated_to_prize_pool +
        s.allocated_to_charity +
        s.breakdown_operating_margin.developer_net +
        s.breakdown_operating_margin.collaborator_referral_payout;
      expect(round2(parts)).toBe(round2(fee));
    }
  });

  it('con $11 da exactamente el desglose esperado', () => {
    const s = calculateTransactionSplits(11, DEFAULT_FINANCIAL_CONFIG, true);
    expect(s.payphone_retention).toBe(0.63);
    expect(s.allocated_to_prize_pool).toBe(6.6);
    expect(s.allocated_to_charity).toBe(1.65);
    expect(s.allocated_to_operating_margin).toBe(2.12);
    expect(s.breakdown_operating_margin.collaborator_referral_payout).toBe(0.64);
    expect(s.breakdown_operating_margin.developer_net).toBe(1.48);
  });
});

describe('diffFinancialConfig', () => {
  it('lista solo los campos que cambiaron, con etiqueta en español', () => {
    const next = applyFinancialConfigUpdate(DEFAULT_FINANCIAL_CONFIG, { entry_fee_per_pair: 11 });
    expect(diffFinancialConfig(DEFAULT_FINANCIAL_CONFIG, next)).toEqual([
      { field: 'entry_fee_per_pair', label: 'Cuota por pareja', before: 10, after: 11 }
    ]);
  });
});

describe('Bloqueo de la configuración financiera', () => {
  it('sin parejas inscritas se puede cambiar libremente y queda en el historial', async () => {
    const { db, service } = freshService();
    const { changes } = await service.updateDynamicConfig({ entry_fee_per_pair: 11 }, '1.2.3.4');
    expect(changes.map((c) => c.field)).toEqual(['entry_fee_per_pair']);

    const tournament = await db.getActiveTournament();
    expect(tournament.entry_fee_usd).toBe(11);

    const history = await db.listConfigChanges();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ admin_ip: '1.2.3.4', forced: false, registered_couples_at_change: 0 });
  });

  it('guardar sin cambios no escribe historial', async () => {
    const { db, service } = freshService();
    await service.updateDynamicConfig({ entry_fee_per_pair: 10 });
    expect(await db.listConfigChanges()).toHaveLength(0);
  });

  it('con una pareja inscrita bloquea cuota y porcentajes', async () => {
    const { service } = freshService();
    await service.simulateSandboxPayment('ALFA', 'BRAVO');

    await expect(service.updateDynamicConfig({ entry_fee_per_pair: 11 })).rejects.toBeInstanceOf(ConfigLockedError);
    await expect(service.updateDynamicConfig({ charity_percentage: 0.2 })).rejects.toBeInstanceOf(ConfigLockedError);
  });

  it('con parejas inscritas el cupo sí se puede ampliar', async () => {
    const { db, service } = freshService();
    await service.simulateSandboxPayment('ALFA', 'BRAVO');
    await service.updateDynamicConfig({ max_couples_limit: 80 });
    expect((await db.getActiveTournament()).max_couples).toBe(80);
  });

  it('forzar exige un motivo y queda marcado en el historial', async () => {
    const { db, service } = freshService();
    await service.simulateSandboxPayment('ALFA', 'BRAVO');

    await expect(
      service.updateDynamicConfig({ entry_fee_per_pair: 11, force: true, reason: 'corto' })
    ).rejects.toBeInstanceOf(ConfigValidationError);

    await service.updateDynamicConfig(
      { entry_fee_per_pair: 11, force: true, reason: 'Ajuste por costos del evento presencial' },
      '9.9.9.9'
    );
    const [last] = await db.listConfigChanges();
    expect(last).toMatchObject({
      forced: true,
      reason: 'Ajuste por costos del evento presencial',
      registered_couples_at_change: 1
    });
  });

  it('el estado de bloqueo llega al dashboard', async () => {
    const { service } = freshService();
    expect((await service.getAdminDashboardData()).config_lock.locked).toBe(false);
    await service.simulateSandboxPayment('ALFA', 'BRAVO');
    const data = await service.getAdminDashboardData();
    expect(data.config_lock).toMatchObject({ locked: true, registered_couples: 1 });
    expect(data.config_lock.locked_fields).toContain('entry_fee_per_pair');
  });
});

describe('Totales del dashboard', () => {
  it('suman todos los pagos aunque el libro solo liste 100', async () => {
    const { db, service } = freshService();
    await service.updateDynamicConfig({ max_couples_limit: 200 });
    for (let i = 0; i < 105; i++) {
      await service.simulateSandboxPayment(`P${i}`, `N${i}`);
    }
    const data = await service.getAdminDashboardData();
    expect(data.payments_audit).toHaveLength(100);
    expect(data.financial_summary.gross_collected_total).toBe(1050);
    expect(data.financial_summary.prize_pool_total).toBe(630);
    expect((await db.getActiveTournament()).accumulated_prize_pool).toBe(630);
  });
});

describe('Cada pago se reparte con la configuración del momento en que se generó el enlace', () => {
  it('usa el snapshot del registro pendiente aunque la config cambie después', async () => {
    const { db, service } = freshService();
    const gate = await service.checkRegistrationOpen();
    if (!gate.open) throw new Error(gate.message);
    const snapshot = await db.getTournamentConfig();
    await service.createPendingRegistration({
      client_transaction_id: 'PS-SNAPSHOT-1',
      driver_name: 'ALFA',
      navigator_name: 'BRAVO',
      amount_usd: gate.tournament.entry_fee_usd,
      status: 'PENDING',
      tournament_id: gate.tournament.id,
      created_at: new Date().toISOString(),
      config_snapshot: snapshot
    });

    // Admin raises charity to 25% while the payer is on the Payphone page
    await service.updateDynamicConfig({ charity_percentage: 0.25 });

    const pending = await db.getPendingRegistration('PS-SNAPSHOT-1');
    const result = await (service as any).applyConfirmedPayment(pending, '777001', '{}', '127.0.0.1');
    expect(result.success).toBe(true);
    expect(result.auditRecord.charity_share).toBe(1.5); // 15% of $10, as agreed at link time
  });
});
