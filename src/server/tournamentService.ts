import {
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
  ReferralRecord,
  TournamentRecord,
  TournamentStatus,
  TournamentTelemetryStatus,
  UpdateConfigDto
} from '../shared/types.js';
import { antiCheatEngine } from './antiCheat.js';
import { dbProvider } from './db.js';
import {
  checkPaymentRateLimit,
  registerFailedWebhook,
  verifyPayphoneSignature,
  verifyReplayAttackTimestamp
} from './payphoneSecurity.js';

export class TournamentService {
  public async init(): Promise<void> {
    await dbProvider.init();
  }

  public getDatabaseStatus() {
    return dbProvider.getDatabaseInfo();
  }

  public async getTournamentTelemetryStatus(): Promise<TournamentTelemetryStatus> {
    const config = await dbProvider.getTournamentConfig();
    const tournament = await dbProvider.getActiveTournament();
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
   * Processes authentic incoming Payphone webhooks with HMAC-SHA256 signature and replay validation.
   */
  public async processPayphoneWebhook(
    payload: PayphoneWebhookPayload,
    rawBody: string,
    signatureHeader: string | undefined,
    clientIp = '127.0.0.1'
  ): Promise<{ success: boolean; message: string; auditRecord?: PaymentAuditRecord }> {
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
    const replayCheck = verifyReplayAttackTimestamp(payload.timestamp);
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
      antiCheatEngine.logSecurityViolation(
        'invalid_hmac_signature',
        'critical',
        clientIp,
        `Invalid HMAC-SHA256 signature in header: ${signatureHeader || 'none'}`
      );
      return {
        success: false,
        message: 'Invalid HMAC-SHA256 signature: authenticity verification failed'
      };
    }

    // 4. Check if payment is Approved by Payphone
    if (payload.status !== 'Approved') {
      return { success: false, message: `Payphone payment not approved (status: ${payload.status})` };
    }

    return this.applyConfirmedPayment(payload, rawBody, clientIp);
  }

  /**
   * Safe sandbox payment simulation for local development and Hangar test mode.
   */
  public async simulateSandboxPayment(
    driverName: string,
    navigatorName: string,
    referralCode?: string,
    clientIp = '127.0.0.1'
  ): Promise<{ success: boolean; message: string; auditRecord?: PaymentAuditRecord }> {
    const config = await dbProvider.getTournamentConfig();
    const mockTxId = `sim-payphone-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const mockPayload: PayphoneWebhookPayload = {
      transactionId: mockTxId,
      clientTransactionId: `client-${Date.now()}`,
      amount: config.entry_fee_per_pair,
      currency: 'USD',
      status: 'Approved',
      pairMeta: {
        driver_name: (driverName || 'PILOT_A').trim().toUpperCase(),
        navigator_name: (navigatorName || 'PILOT_B').trim().toUpperCase(),
        referral_code: referralCode ? referralCode.trim().toUpperCase() : undefined
      },
      timestamp: Math.floor(Date.now() / 1000)
    };

    return this.applyConfirmedPayment(mockPayload, JSON.stringify(mockPayload), clientIp);
  }

  private async applyConfirmedPayment(
    payload: PayphoneWebhookPayload,
    rawPayload: string,
    clientIp: string
  ): Promise<{ success: boolean; message: string; auditRecord?: PaymentAuditRecord }> {
    const config = await dbProvider.getTournamentConfig();
    const tournament = await dbProvider.getActiveTournament();

    if (tournament.status === 'completed') {
      return { success: false, message: 'Tournament has already ended and podium is settled.' };
    }

    if (tournament.registered_couples_count >= tournament.max_couples) {
      return {
        success: false,
        message: `Maximum limit of ${tournament.max_couples} couples has already been reached.`
      };
    }

    // Normalizes amount (if sent in cents e.g. 1000 -> 10.00)
    const rawAmt = Number(payload.amount);
    const grossAmount = rawAmt > 100 ? rawAmt / 100 : rawAmt || config.entry_fee_per_pair;

    // Calculate exact splits using pure financial formulas
    const splits = calculateTransactionSplits(grossAmount, config);

    // Resolve Referral / Collaborator attribution if provided
    let referralRecord: ReferralRecord | null = null;
    const refCode = payload.pairMeta?.referral_code || payload.optionalParameter;
    if (refCode) {
      referralRecord = await dbProvider.getReferralByCode(refCode);
      if (referralRecord) {
        referralRecord.total_couples_referred++;
        referralRecord.accumulated_earnings_usd = round2(
          referralRecord.accumulated_earnings_usd + splits.breakdown_operating_margin.collaborator_referral_payout
        );
        referralRecord.pending_earnings_usd = round2(
          referralRecord.pending_earnings_usd + splits.breakdown_operating_margin.collaborator_referral_payout
        );
        await dbProvider.saveReferral(referralRecord);
      }
    }

    // Create immutable Payment Audit Record
    const auditRecord: PaymentAuditRecord = {
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      payphone_transaction_id: payload.transactionId,
      tournament_id: tournament.id,
      referral_id: referralRecord ? referralRecord.id : null,
      referral_code: referralRecord ? referralRecord.referral_code : null,
      pair_driver_name: payload.pairMeta?.driver_name || 'DRIVER',
      pair_navigator_name: payload.pairMeta?.navigator_name || 'NAVIGATOR',
      gross_amount: splits.gross_collected,
      payphone_fee: splits.payphone_retention,
      prize_pool_share: splits.allocated_to_prize_pool,
      charity_share: splits.allocated_to_charity,
      developer_share: splits.breakdown_operating_margin.developer_net,
      collaborator_share: splits.breakdown_operating_margin.collaborator_referral_payout,
      status: 'APPROVED',
      raw_payload_json: rawPayload,
      created_at: new Date().toISOString()
    };

    await dbProvider.savePaymentAudit(auditRecord);

    // Increment Tournament Pools
    tournament.registered_couples_count++;
    tournament.accumulated_prize_pool = round2(
      tournament.accumulated_prize_pool + splits.allocated_to_prize_pool
    );
    tournament.accumulated_charity_amount = round2(
      tournament.accumulated_charity_amount + splits.allocated_to_charity
    );
    tournament.accumulated_operating_margin = round2(
      tournament.accumulated_operating_margin + splits.allocated_to_operating_margin
    );

    if (tournament.registered_couples_count >= tournament.max_couples) {
      tournament.status = 'in_progress';
    }

    await dbProvider.saveTournament(tournament);

    return {
      success: true,
      message: `Registration confirmed: Pair registered successfully ($${splits.allocated_to_prize_pool} -> Prize Pool, $${splits.allocated_to_charity} -> Animal Charity)`,
      auditRecord
    };
  }

  // -------------------------------------------------------------
  // Administrative Operations
  // -------------------------------------------------------------

  public async getAdminDashboardData(): Promise<AdminDashboardData> {
    const config = await dbProvider.getTournamentConfig();
    const tournament = await dbProvider.getActiveTournament();
    const payments = await dbProvider.listPaymentAudits();
    const referrals = await dbProvider.listReferrals();
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
        collaborator_payouts_total += p.collaborator_share;
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
      payments_audit: payments,
      referrals,
      security_logs,
      active_config: config,
      security_config: DEFAULT_SECURITY_CONFIG
    };
  }

  public async updateDynamicConfig(dto: UpdateConfigDto, adminIp = '127.0.0.1'): Promise<TournamentFinancialConfig> {
    const current = await dbProvider.getTournamentConfig();

    if (dto.entry_fee_per_pair !== undefined && dto.entry_fee_per_pair > 0) {
      current.entry_fee_per_pair = dto.entry_fee_per_pair;
    }
    if (dto.max_couples_limit !== undefined && dto.max_couples_limit > 0) {
      current.max_couples_limit = dto.max_couples_limit;
    }
    if (dto.effective_payphone_fee !== undefined && dto.effective_payphone_fee >= 0) {
      current.pricing_structure.payphone_gateway.effective_fee_percentage_calculated = dto.effective_payphone_fee;
    }
    if (dto.prize_pool_percentage !== undefined && dto.prize_pool_percentage >= 0) {
      current.pricing_structure.revenue_allocation_percentages.prize_pool.percentage_of_gross = dto.prize_pool_percentage;
    }
    if (dto.charity_percentage !== undefined && dto.charity_percentage >= 0) {
      current.pricing_structure.revenue_allocation_percentages.animal_charity.percentage_of_gross = dto.charity_percentage;
    }
    if (dto.operating_margin_percentage !== undefined && dto.operating_margin_percentage >= 0) {
      current.pricing_structure.revenue_allocation_percentages.gross_operating_margin.percentage_of_gross = dto.operating_margin_percentage;
    }
    if (dto.developer_share_of_margin !== undefined && dto.developer_share_of_margin >= 0) {
      current.pricing_structure.margin_sub_distribution.platform_developer_share.percentage_of_operating_margin = dto.developer_share_of_margin;
      current.pricing_structure.margin_sub_distribution.platform_developer_share.effective_percentage_of_gross =
        current.pricing_structure.revenue_allocation_percentages.gross_operating_margin.percentage_of_gross * dto.developer_share_of_margin;
    }
    if (dto.collaborator_share_of_margin !== undefined && dto.collaborator_share_of_margin >= 0) {
      current.pricing_structure.margin_sub_distribution.collaborator_pool_share.percentage_of_operating_margin = dto.collaborator_share_of_margin;
      current.pricing_structure.margin_sub_distribution.collaborator_pool_share.effective_percentage_of_gross =
        current.pricing_structure.revenue_allocation_percentages.gross_operating_margin.percentage_of_gross * dto.collaborator_share_of_margin;
    }

    await dbProvider.saveTournamentConfig(current);

    antiCheatEngine.logSecurityViolation(
      'config_modified',
      'low',
      adminIp,
      'Admin updated dynamic financial configuration'
    );

    return current;
  }

  public async createReferral(dto: CreateReferralDto): Promise<ReferralRecord> {
    const code = dto.referral_code.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
    const existing = await dbProvider.getReferralByCode(code);
    if (existing) {
      throw new Error(`Referral code ${code} already exists.`);
    }

    const record: ReferralRecord = {
      id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      referral_code: code,
      collaborator_name: dto.collaborator_name.trim().toUpperCase(),
      collaborator_payphone_number: dto.collaborator_payphone_number.trim(),
      total_couples_referred: 0,
      accumulated_earnings_usd: 0.0,
      settled_earnings_usd: 0.0,
      pending_earnings_usd: 0.0,
      created_at: new Date().toISOString()
    };

    await dbProvider.saveReferral(record);
    return record;
  }

  public async settleReferralPayout(referralId: string, settleAmount?: number): Promise<ReferralRecord> {
    const ref = await dbProvider.getReferralById(referralId);
    if (!ref) {
      throw new Error(`Referral record with ID ${referralId} not found.`);
    }

    const toSettle = settleAmount !== undefined ? settleAmount : ref.pending_earnings_usd;
    if (toSettle <= 0 || toSettle > ref.pending_earnings_usd) {
      throw new Error(`Invalid settlement amount ($${toSettle}). Pending balance is $${ref.pending_earnings_usd}.`);
    }

    ref.settled_earnings_usd = round2(ref.settled_earnings_usd + toSettle);
    ref.pending_earnings_usd = round2(ref.pending_earnings_usd - toSettle);

    await dbProvider.saveReferral(ref);
    return ref;
  }

  public async updateTournamentStatus(status: TournamentStatus): Promise<TournamentRecord> {
    const tournament = await dbProvider.getActiveTournament();
    tournament.status = status;
    if (status === 'completed') {
      tournament.completed_at = new Date().toISOString();
    }
    await dbProvider.saveTournament(tournament);
    return tournament;
  }

  public async closeTournamentAndDistributePodium(): Promise<{
    tournament: TournamentRecord;
    podium_distribution: PodiumPrizeDistribution;
    charity_total_usd: number;
  }> {
    const config = await dbProvider.getTournamentConfig();
    const tournament = await dbProvider.getActiveTournament();

    tournament.status = 'completed';
    tournament.completed_at = new Date().toISOString();
    await dbProvider.saveTournament(tournament);

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

export const tournamentService = new TournamentService();
