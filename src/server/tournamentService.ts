import {
  applyFinancialConfigUpdate,
  calculatePodiumPrizes,
  calculateTransactionSplits,
  DEFAULT_SECURITY_CONFIG,
  PodiumPrizeDistribution,
  round2,
  TournamentFinancialConfig
} from '../shared/financialConfig.js';
import type {
  AdminDashboardData,
  CreateReferralDto,
  PaymentAuditRecord,
  PayphoneWebhookPayload,
  PendingRegistrationRecord,
  ReferralRecord,
  TournamentRecord,
  TournamentStatus,
  TournamentTelemetryStatus,
  UpdateConfigDto
} from '../shared/types.js';
import { antiCheatEngine } from './antiCheat.js';
import { DatabaseProvider, DatabaseUnavailableError, dbProvider } from './db.js';
import {
  checkPaymentRateLimit,
  confirmPayphoneTransaction,
  registerFailedWebhook,
  validateConfirmAgainstPending,
  verifyPayphoneSignature,
  verifyReplayAttackTimestamp
} from './payphoneSecurity.js';

export type PaymentResult = { success: boolean; message: string; auditRecord?: PaymentAuditRecord };

const VALID_TOURNAMENT_STATUSES: TournamentStatus[] = ['draft', 'active', 'in_progress', 'completed'];

export class TournamentService {
  constructor(private readonly db: DatabaseProvider = dbProvider) {}

  public async init(): Promise<void> {
    await this.db.init();
  }

  public getDatabaseStatus() {
    return this.db.getDatabaseInfo();
  }

  /**
   * Throws DatabaseUnavailableError when money-related operations cannot be persisted safely.
   */
  public ensureDatabaseAvailable(): void {
    if (!this.db.isAvailable()) {
      throw new DatabaseUnavailableError();
    }
  }

  public async getTournamentTelemetryStatus(): Promise<TournamentTelemetryStatus> {
    const config = await this.db.getTournamentConfig();
    const tournament = await this.db.getActiveTournament();
    const podium_preview = calculatePodiumPrizes(
      tournament.accumulated_prize_pool,
      config.prize_podium_breakdown
    );

    return {
      tournament: {
        id: tournament.id,
        name: tournament.name,
        status: tournament.status,
        entry_fee_usd: tournament.entry_fee_usd,
        max_couples: tournament.max_couples,
        registered_couples: tournament.registered_couples_count,
        accumulated_prize_pool: tournament.accumulated_prize_pool,
        accumulated_charity: tournament.accumulated_charity_amount,
        podium_preview: {
          first_place: podium_preview.first_place,
          second_place: podium_preview.second_place,
          third_place: podium_preview.third_place
        }
      },
      config
    };
  }

  /**
   * Checks that the active tournament accepts a new registration (before calling Payphone Prepare).
   */
  public async checkRegistrationOpen(): Promise<
    { open: true; tournament: TournamentRecord } | { open: false; message: string }
  > {
    this.ensureDatabaseAvailable();
    const tournament = await this.db.getActiveTournament();
    if (tournament.status !== 'active') {
      return { open: false, message: 'El torneo no está abierto a inscripciones en este momento.' };
    }
    if (tournament.registered_couples_count >= tournament.max_couples) {
      return { open: false, message: `Cupo completo: ${tournament.max_couples} parejas inscritas.` };
    }
    return { open: true, tournament };
  }

  public async createPendingRegistration(record: PendingRegistrationRecord): Promise<void> {
    await this.db.savePendingRegistration(record);
  }

  public async verifyTournamentPass(passCode: string) {
    const tournament = await this.db.getActiveTournament();
    return this.db.verifyTournamentPass(passCode, tournament.id);
  }

  /**
   * Processes authentic incoming Payphone webhooks with HMAC-SHA256 signature and replay validation.
   */
  public async processPayphoneWebhook(
    payload: PayphoneWebhookPayload,
    rawBody: string,
    signatureHeader: string | undefined,
    clientIp = '127.0.0.1'
  ): Promise<PaymentResult> {
    // 1. IP Rate Limiting Check
    const rateCheck = checkPaymentRateLimit(clientIp);
    if (!rateCheck.allowed) {
      registerFailedWebhook(clientIp);
      antiCheatEngine.logSecurityViolation(
        'rate_limit_exceeded',
        'high',
        clientIp,
        rateCheck.reason || 'Rate limit exceeded on webhook'
      );
      return { success: false, message: rateCheck.reason || 'Rate limit exceeded' };
    }

    // 2. Replay Attack Timestamp Check (300 seconds window)
    const replayCheck = verifyReplayAttackTimestamp(payload?.timestamp);
    if (!replayCheck.valid) {
      registerFailedWebhook(clientIp);
      antiCheatEngine.logSecurityViolation(
        'webhook_replay_rejected',
        'high',
        clientIp,
        replayCheck.reason || 'Replay attack window exceeded'
      );
      return { success: false, message: replayCheck.reason || 'Replay attack prevented' };
    }

    // 3. Cryptographic HMAC-SHA256 Signature Verification
    const signatureValid = verifyPayphoneSignature(rawBody, signatureHeader);
    if (!signatureValid) {
      registerFailedWebhook(clientIp);
      // Never log the attacker-controlled header value itself
      antiCheatEngine.logSecurityViolation(
        'invalid_hmac_signature',
        'critical',
        clientIp,
        `Invalid HMAC-SHA256 signature (header ${signatureHeader ? `present, ${signatureHeader.length} chars` : 'missing'})`
      );
      return {
        success: false,
        message: 'Invalid HMAC-SHA256 signature: authenticity verification failed'
      };
    }

    // 4. Check if payment is Approved by Payphone
    if (payload.status !== 'Approved') {
      return { success: false, message: `Payphone payment not approved (status: ${String(payload.status)})` };
    }

    this.ensureDatabaseAvailable();

    // 5. Must match a pending registration created by us, with the exact entry fee
    const clientTxId = String(payload.clientTransactionId || '');
    const pending = clientTxId ? await this.db.getPendingRegistration(clientTxId) : null;
    if (!pending) {
      return { success: false, message: 'Inscripción pendiente no encontrada para esta transacción.' };
    }
    if (!webhookAmountMatches(payload.amount, pending.amount_usd)) {
      antiCheatEngine.logSecurityViolation(
        'payment_mismatch',
        'critical',
        clientIp,
        `Webhook amount mismatch for ${clientTxId}`
      );
      return { success: false, message: 'El monto pagado no coincide con la cuota de inscripción.' };
    }

    return this.applyConfirmedPayment(pending, String(payload.transactionId), rawBody, clientIp);
  }

  /**
   * Handles Payphone Browser Callback (?id=...&clientTransactionId=...)
   * Executes the mandatory 5-minute server-to-server confirmation (POST /api/button/V2/Confirm)
   * to prevent automatic reversal by Payphone, reconciles with pending registrations,
   * and credits tournament pools and collaborator shares atomically.
   */
  public async handlePayphoneCallback(
    id: number | string,
    clientTransactionId: string,
    clientIp = '127.0.0.1'
  ): Promise<PaymentResult> {
    const txId = String(id || '').trim();
    const clientTxId = String(clientTransactionId || '').trim();
    if (!/^\d{1,20}$/.test(txId) || !clientTxId || clientTxId.length > 100) {
      return {
        success: false,
        message: 'Parámetros de retorno incompletos (se requiere id y clientTransactionId de Payphone).'
      };
    }

    // Without a database we must NOT confirm: unconfirmed payments are reversed by Payphone
    this.ensureDatabaseAvailable();

    const pending = await this.db.getPendingRegistration(clientTxId);
    if (!pending) {
      return { success: false, message: 'No existe una inscripción pendiente para esta transacción.' };
    }

    // 1. Idempotency: same Payphone transaction already credited for THIS registration
    const existingAudit = await this.db.getPaymentAuditByTransactionId(txId);
    if (existingAudit) {
      if (existingAudit.client_transaction_id === clientTxId) {
        return {
          success: true,
          message: `Transacción ${txId} ya fue procesada y acreditada exitosamente.`,
          auditRecord: existingAudit
        };
      }
      return { success: false, message: 'La transacción no corresponde a esta inscripción.' };
    }

    if (pending.status !== 'PENDING') {
      return {
        success: false,
        message:
          pending.status === 'REFUND_REQUIRED'
            ? 'Pago recibido sin cupo disponible: el reembolso será gestionado por la organización.'
            : 'Esta inscripción ya fue procesada o cancelada.'
      };
    }

    // 2. Execute mandatory 5-Minute Payphone Server-to-Server Confirmation
    const confirmResult = await confirmPayphoneTransaction(txId, clientTxId);
    if (!confirmResult.success || !confirmResult.approved) {
      antiCheatEngine.logSecurityViolation(
        'payphone_confirm_rejected',
        'high',
        clientIp,
        `Confirm rechazado para ${clientTxId}`
      );
      if (confirmResult.success && !confirmResult.approved) {
        await this.db.markPendingRegistrationStatus(clientTxId, 'CANCELLED');
      }
      return {
        success: false,
        message: 'La pasarela Payphone no aprobó la transacción.'
      };
    }

    // 3. The confirmed transaction must be exactly the one we prepared
    const txData = confirmResult.data || {};
    const mismatch = validateConfirmAgainstPending(txData, clientTxId, pending.amount_usd);
    if (mismatch) {
      antiCheatEngine.logSecurityViolation('payment_mismatch', 'critical', clientIp, `${clientTxId}: ${mismatch}`);
      await this.db.markPendingRegistrationStatus(clientTxId, 'REFUND_REQUIRED');
      return { success: false, message: 'La transacción confirmada no coincide con la inscripción.' };
    }

    // 4. Apply confirmed payment to Tournament pools, referrals, and audit
    return this.applyConfirmedPayment(
      pending,
      String(txData.transactionId ?? txId),
      JSON.stringify(txData),
      clientIp
    );
  }

  /**
   * Sandbox payment simulation for local development only (route is not mounted in production).
   */
  public async simulateSandboxPayment(
    driverName: string,
    navigatorName: string,
    referralCode?: string,
    clientIp = '127.0.0.1'
  ): Promise<PaymentResult> {
    const gate = await this.checkRegistrationOpen();
    if (!gate.open) return { success: false, message: gate.message };

    const clientTxId = `SIM-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
    const pending: PendingRegistrationRecord = {
      client_transaction_id: clientTxId,
      driver_name: sanitizePairName(driverName, 'PILOT_A'),
      navigator_name: sanitizePairName(navigatorName, 'PILOT_B'),
      referral_code: referralCode ? String(referralCode).trim().toUpperCase().slice(0, 50) : undefined,
      amount_usd: gate.tournament.entry_fee_usd,
      status: 'PENDING',
      tournament_id: gate.tournament.id,
      created_at: new Date().toISOString()
    };
    await this.db.savePendingRegistration(pending);
    return this.applyConfirmedPayment(pending, `sim-${clientTxId}`, JSON.stringify(pending), clientIp);
  }

  private async applyConfirmedPayment(
    pending: PendingRegistrationRecord,
    payphoneTransactionId: string,
    rawPayload: string,
    clientIp: string
  ): Promise<PaymentResult> {
    const config = await this.db.getTournamentConfig();
    const tournament = await this.db.getActiveTournament();
    const tournamentId = pending.tournament_id || tournament.id;

    const referral = pending.referral_code ? await this.db.getReferralByCode(pending.referral_code) : null;
    const splits = calculateTransactionSplits(pending.amount_usd, config, Boolean(referral));

    const result = await this.db.applyApprovedPayment({
      client_transaction_id: pending.client_transaction_id,
      payphone_transaction_id: payphoneTransactionId,
      tournament_id: tournamentId,
      referral: referral ? { id: referral.id, referral_code: referral.referral_code } : null,
      splits,
      raw_payload_json: rawPayload
    });

    switch (result.status) {
      case 'applied':
        return {
          success: true,
          message: `Registration confirmed: Pair registered successfully ($${splits.allocated_to_prize_pool} -> Prize Pool, $${splits.allocated_to_charity} -> Animal Charity)`,
          auditRecord: result.audit
        };
      case 'duplicate':
        if (result.audit.client_transaction_id === pending.client_transaction_id) {
          return {
            success: true,
            message: `Transacción ${payphoneTransactionId} ya fue registrada previamente (idempotencia activa).`,
            auditRecord: result.audit
          };
        }
        return { success: false, message: 'La transacción ya fue usada por otra inscripción.' };
      case 'not_pending': {
        // A concurrent request may have completed this registration a moment ago
        const audit = await this.db.getPaymentAuditByTransactionId(payphoneTransactionId);
        if (audit && audit.client_transaction_id === pending.client_transaction_id) {
          return { success: true, message: 'Inscripción ya acreditada.', auditRecord: audit };
        }
        return { success: false, message: result.message };
      }
      case 'tournament_full':
        antiCheatEngine.logSecurityViolation(
          'payment_over_capacity',
          'high',
          clientIp,
          `Pago ${payphoneTransactionId} (${pending.client_transaction_id}) aprobado sin cupo: requiere reembolso.`
        );
        return {
          success: false,
          message: 'Pago recibido pero el torneo ya no tiene cupos: la organización gestionará tu reembolso.'
        };
    }
  }

  // -------------------------------------------------------------
  // Administrative Operations
  // -------------------------------------------------------------

  public async getAdminDashboardData(): Promise<AdminDashboardData> {
    const config = await this.db.getTournamentConfig();
    const tournament = await this.db.getActiveTournament();
    const payments = await this.db.listPaymentAudits();
    const referrals = await this.db.listReferrals();
    const security_logs = antiCheatEngine.getSecurityLogs();

    let gross_collected_total = 0;
    let payphone_fees_total = 0;
    let prize_pool_total = 0;
    let charity_total = 0;
    let developer_net_total = 0;
    let collaborator_payouts_total = 0;

    for (const p of payments) {
      if (p.status === 'APPROVED') {
        gross_collected_total += p.gross_amount;
        payphone_fees_total += p.payphone_fee;
        prize_pool_total += p.prize_pool_share;
        charity_total += p.charity_share;
        developer_net_total += p.developer_share;
        // Legacy rows without referral may carry a collaborator share nobody earned
        collaborator_payouts_total += p.referral_id ? p.collaborator_share : 0;
        if (!p.referral_id) developer_net_total += p.collaborator_share;
      }
    }

    return {
      tournament,
      financial_summary: {
        gross_collected_total: round2(gross_collected_total),
        payphone_fees_total: round2(payphone_fees_total),
        prize_pool_total: round2(prize_pool_total),
        charity_total: round2(charity_total),
        developer_net_total: round2(developer_net_total),
        collaborator_payouts_total: round2(collaborator_payouts_total)
      },
      payments_audit: payments.map(({ raw_payload_json: _raw, ...p }) => p),
      referrals,
      security_logs,
      active_config: config,
      security_config: DEFAULT_SECURITY_CONFIG
    };
  }

  public async updateDynamicConfig(dto: UpdateConfigDto, adminIp = '127.0.0.1'): Promise<TournamentFinancialConfig> {
    const current = await this.db.getTournamentConfig();
    const next = applyFinancialConfigUpdate(current, dto || {});

    const tournament = await this.db.getActiveTournament();
    if (tournament.status !== 'completed' && next.max_couples_limit < tournament.registered_couples_count) {
      throw new Error(
        `El límite (${next.max_couples_limit}) no puede ser menor que las parejas ya inscritas (${tournament.registered_couples_count}).`
      );
    }

    await this.db.saveTournamentConfig(next, tournament.id);

    antiCheatEngine.logSecurityViolation(
      'config_modified',
      'low',
      adminIp,
      'Admin updated dynamic financial configuration'
    );

    return next;
  }

  public async createReferral(dto: CreateReferralDto): Promise<ReferralRecord> {
    const code = String(dto?.referral_code || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 50);
    const name = String(dto?.collaborator_name || '').trim().toUpperCase().slice(0, 100);
    const phone = String(dto?.collaborator_payphone_number || '').trim().replace(/[^0-9+]/g, '').slice(0, 30);
    if (code.length < 3) throw new Error('El código de referido debe tener al menos 3 caracteres (A-Z, 0-9, -).');
    if (!name) throw new Error('El nombre del colaborador es obligatorio.');

    const existing = await this.db.getReferralByCode(code);
    if (existing) {
      throw new Error(`Referral code ${code} already exists.`);
    }

    const record: ReferralRecord = {
      id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      referral_code: code,
      collaborator_name: name,
      collaborator_payphone_number: phone,
      total_couples_referred: 0,
      accumulated_earnings_usd: 0.0,
      settled_earnings_usd: 0.0,
      pending_earnings_usd: 0.0,
      created_at: new Date().toISOString()
    };

    await this.db.createReferral(record);
    return record;
  }

  public async settleReferralPayout(referralId: string, settleAmount?: number): Promise<ReferralRecord> {
    const ref = await this.db.getReferralById(referralId);
    if (!ref) {
      throw new Error(`Referral record with ID ${referralId} not found.`);
    }

    const toSettle = round2(settleAmount !== undefined ? Number(settleAmount) : ref.pending_earnings_usd);
    if (!Number.isFinite(toSettle) || toSettle <= 0 || toSettle > ref.pending_earnings_usd) {
      throw new Error(`Invalid settlement amount ($${toSettle}). Pending balance is $${ref.pending_earnings_usd}.`);
    }

    const settled = await this.db.settleReferral(referralId, toSettle);
    if (!settled) {
      throw new Error('El saldo pendiente cambió durante la liquidación. Recarga e intenta de nuevo.');
    }
    return settled;
  }

  public async updateTournamentStatus(status: TournamentStatus): Promise<TournamentRecord> {
    if (!VALID_TOURNAMENT_STATUSES.includes(status)) {
      throw new Error(`Estado de torneo inválido: ${String(status)}`);
    }
    const tournament = await this.db.getActiveTournament();
    tournament.status = status;
    if (status === 'completed') {
      tournament.completed_at = new Date().toISOString();
    }
    await this.db.saveTournament(tournament);
    return tournament;
  }

  public async closeTournamentAndDistributePodium(): Promise<{
    tournament: TournamentRecord;
    podium_distribution: PodiumPrizeDistribution;
    charity_total_usd: number;
  }> {
    const config = await this.db.getTournamentConfig();
    const tournament = await this.db.getActiveTournament();

    tournament.status = 'completed';
    tournament.completed_at = new Date().toISOString();
    await this.db.saveTournament(tournament);

    const podium = calculatePodiumPrizes(
      tournament.accumulated_prize_pool,
      config.prize_podium_breakdown
    );

    return {
      tournament,
      podium_distribution: podium,
      charity_total_usd: tournament.accumulated_charity_amount
    };
  }

  public clearSecurityLogs(): void {
    antiCheatEngine.clearLogs();
  }
}

export function sanitizePairName(raw: unknown, fallback: string): string {
  const clean = String(raw ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .trim()
    .toUpperCase()
    .slice(0, 24);
  return clean || fallback;
}

function webhookAmountMatches(amount: unknown, expectedUsd: number): boolean {
  const value = Number(amount);
  if (!Number.isFinite(value)) return false;
  const expectedCents = Math.round(expectedUsd * 100);
  // Payphone reports cents; accept dollars only when they match exactly too
  return value === expectedCents || Math.round(value * 100) === expectedCents;
}

export const tournamentService = new TournamentService();
