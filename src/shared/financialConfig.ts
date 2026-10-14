export interface PayphoneGatewayConfig {
  percentage_fee: number; // 0.05
  tax_on_fee_percentage: number; // 0.15
  fixed_fee_usd: number; // 0.00
  effective_fee_percentage_calculated: number; // 0.0575
  description: string;
}

export interface RevenueAllocationPercentages {
  prize_pool: {
    percentage_of_gross: number; // 0.60
    description: string;
  };
  animal_charity: {
    percentage_of_gross: number; // 0.15
    description: string;
  };
  gross_operating_margin: {
    percentage_of_gross: number; // 0.1925
    description: string;
  };
}

export interface MarginSubDistribution {
  platform_developer_share: {
    percentage_of_operating_margin: number; // 0.70
    effective_percentage_of_gross: number; // 0.13475
    description: string;
  };
  collaborator_pool_share: {
    percentage_of_operating_margin: number; // 0.30
    effective_percentage_of_gross: number; // 0.05775
    description: string;
  };
}

export interface PrizePodiumBreakdown {
  first_place_percentage: number; // 0.6666
  second_place_percentage: number; // 0.2333
  third_place_percentage: number; // 0.1001
}

export interface TournamentFinancialConfig {
  currency: string; // 'USD'
  entry_fee_per_pair: number; // 10.00
  max_couples_limit: number; // 50
  pricing_structure: {
    payphone_gateway: PayphoneGatewayConfig;
    revenue_allocation_percentages: RevenueAllocationPercentages;
    margin_sub_distribution: MarginSubDistribution;
  };
  prize_podium_breakdown: PrizePodiumBreakdown;
}

export interface TournamentSecurityConfig {
  networking: {
    architecture: 'Server-Authoritative';
    tick_rate_hz: number; // 60
    allowed_latency_variance_ms: number; // 150
    client_input_validation: {
      max_vector_speed: number; // 250.0
      reject_impossible_position_jumps: boolean; // true
      max_shield_activations_per_second: number; // 3
    };
  };
  webhook_security: {
    payphone_signature_validation: {
      enabled: boolean; // true
      header_key: string; // 'x-payphone-signature'
      algorithm: 'HMAC-SHA256';
      replay_attack_prevention_window_seconds: number; // 300
    };
    rate_limiting: {
      max_payment_attempts_per_ip_per_hour: number; // 10
      max_failed_webhooks_threshold: number; // 5
    };
  };
  gameplay_integrity: {
    prevent_multi_session_per_user: boolean; // true
    require_pair_authentication_tokens: boolean; // true
    score_submission_policy: {
      submit_from_client: boolean; // false
      submit_from_server_only: boolean; // true
      audit_log_telemetry: boolean; // true
    };
  };
}

export const DEFAULT_FINANCIAL_CONFIG: TournamentFinancialConfig = {
  currency: 'USD',
  entry_fee_per_pair: 10.0,
  max_couples_limit: 50,
  pricing_structure: {
    payphone_gateway: {
      percentage_fee: 0.05,
      tax_on_fee_percentage: 0.15,
      fixed_fee_usd: 0.0,
      effective_fee_percentage_calculated: 0.0575,
      description: 'Comisión oficial Payphone: 5% + IVA del 15% sobre la comisión = 5.75% efectivo total.'
    },
    revenue_allocation_percentages: {
      prize_pool: {
        percentage_of_gross: 0.6,
        description: '60% acumulado directo para los ganadores (Top 3).'
      },
      animal_charity: {
        percentage_of_gross: 0.15,
        description: '15% destinado al refugio de animales para alimento y medicina.'
      },
      gross_operating_margin: {
        percentage_of_gross: 0.1925,
        description: '19.25% de margen restante retenido por la plataforma.'
      }
    },
    margin_sub_distribution: {
      platform_developer_share: {
        percentage_of_operating_margin: 0.7,
        effective_percentage_of_gross: 0.13475,
        description: '70% del margen operativo para infraestructura y ganancia neta.'
      },
      collaborator_pool_share: {
        percentage_of_operating_margin: 0.3,
        effective_percentage_of_gross: 0.05775,
        description: '30% del margen operativo para el colaborador/referido que trajo la pareja.'
      }
    }
  },
  prize_podium_breakdown: {
    first_place_percentage: 0.6666,
    second_place_percentage: 0.2333,
    third_place_percentage: 0.1001
  }
};

export const DEFAULT_SECURITY_CONFIG: TournamentSecurityConfig = {
  networking: {
    architecture: 'Server-Authoritative',
    tick_rate_hz: 60,
    allowed_latency_variance_ms: 150,
    client_input_validation: {
      max_vector_speed: 250.0,
      reject_impossible_position_jumps: true,
      max_shield_activations_per_second: 3
    }
  },
  webhook_security: {
    payphone_signature_validation: {
      enabled: true,
      header_key: 'x-payphone-signature',
      algorithm: 'HMAC-SHA256',
      replay_attack_prevention_window_seconds: 300
    },
    rate_limiting: {
      max_payment_attempts_per_ip_per_hour: 10,
      max_failed_webhooks_threshold: 5
    }
  },
  gameplay_integrity: {
    prevent_multi_session_per_user: true,
    require_pair_authentication_tokens: true,
    score_submission_policy: {
      submit_from_client: false,
      submit_from_server_only: true,
      audit_log_telemetry: true
    }
  }
};

export interface TransactionCalculationResult {
  gross_collected: number;
  payphone_retention: number;
  allocated_to_prize_pool: number;
  allocated_to_charity: number;
  allocated_to_operating_margin: number;
  breakdown_operating_margin: {
    developer_net: number;
    collaborator_referral_payout: number;
  };
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Pure math calculation engine for transaction revenue splits based on exact schema formulas.
 * When the pair has no referral, nobody earns the collaborator share: it stays with the
 * platform (developer_net = full operating margin) and collaborator_referral_payout is 0.
 */
export function calculateTransactionSplits(
  grossAmount: number,
  config: TournamentFinancialConfig = DEFAULT_FINANCIAL_CONFIG,
  hasReferral = true
): TransactionCalculationResult {
  const pGateway = config.pricing_structure.payphone_gateway;
  const alloc = config.pricing_structure.revenue_allocation_percentages;
  const subDist = config.pricing_structure.margin_sub_distribution;

  const payphone_retention = round2(grossAmount * pGateway.effective_fee_percentage_calculated);
  const allocated_to_prize_pool = round2(grossAmount * alloc.prize_pool.percentage_of_gross);
  const allocated_to_charity = round2(grossAmount * alloc.animal_charity.percentage_of_gross);

  // Exact net operating margin remainder as defined in schema:
  // "19.25% de margen restante retenido por la plataforma"
  const allocated_to_operating_margin = round2(
    grossAmount - payphone_retention - allocated_to_prize_pool - allocated_to_charity
  );

  const collaborator_referral_payout = hasReferral
    ? round2(allocated_to_operating_margin * subDist.collaborator_pool_share.percentage_of_operating_margin)
    : 0;
  // Developer gets the exact remainder so both shares always add up to the margin
  const developer_net = round2(allocated_to_operating_margin - collaborator_referral_payout);

  return {
    gross_collected: round2(grossAmount),
    payphone_retention,
    allocated_to_prize_pool,
    allocated_to_charity,
    allocated_to_operating_margin,
    breakdown_operating_margin: {
      developer_net,
      collaborator_referral_payout
    }
  };
}

export interface FinancialConfigUpdate {
  entry_fee_per_pair?: number;
  max_couples_limit?: number;
  payphone_percentage_fee?: number;
  prize_pool_percentage?: number;
  charity_percentage?: number;
  developer_share_of_margin?: number;
  collaborator_share_of_margin?: number;
}

const PCT_EPSILON = 1e-9;

function assertFraction(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} debe ser una fracción entre 0 y 1 (recibido: ${value}).`);
  }
}

/**
 * Applies an admin config update on a copy of `current`, recomputing every derived value
 * (effective Payphone fee with IVA, operating margin, effective shares of gross) and
 * validating that the split never exceeds 100% of the gross amount.
 */
export function applyFinancialConfigUpdate(
  current: TournamentFinancialConfig,
  dto: FinancialConfigUpdate
): TournamentFinancialConfig {
  const next: TournamentFinancialConfig = JSON.parse(JSON.stringify(current));
  const gateway = next.pricing_structure.payphone_gateway;
  const alloc = next.pricing_structure.revenue_allocation_percentages;
  const sub = next.pricing_structure.margin_sub_distribution;

  if (dto.entry_fee_per_pair !== undefined) {
    const fee = Number(dto.entry_fee_per_pair);
    if (!Number.isFinite(fee) || fee < 1 || fee > 1000) {
      throw new Error('La cuota por pareja debe estar entre $1 y $1000.');
    }
    next.entry_fee_per_pair = round2(fee);
  }
  if (dto.max_couples_limit !== undefined) {
    const max = Number(dto.max_couples_limit);
    if (!Number.isInteger(max) || max < 2 || max > 10000) {
      throw new Error('El límite de parejas debe ser un entero entre 2 y 10000.');
    }
    next.max_couples_limit = max;
  }
  if (dto.payphone_percentage_fee !== undefined) {
    const fee = Number(dto.payphone_percentage_fee);
    assertFraction('La tasa base de Payphone', fee);
    gateway.percentage_fee = fee;
  }
  if (dto.prize_pool_percentage !== undefined) {
    assertFraction('El porcentaje del pozo', Number(dto.prize_pool_percentage));
    alloc.prize_pool.percentage_of_gross = Number(dto.prize_pool_percentage);
  }
  if (dto.charity_percentage !== undefined) {
    assertFraction('El porcentaje del refugio', Number(dto.charity_percentage));
    alloc.animal_charity.percentage_of_gross = Number(dto.charity_percentage);
  }

  const devGiven = dto.developer_share_of_margin !== undefined;
  const collabGiven = dto.collaborator_share_of_margin !== undefined;
  if (devGiven) assertFraction('La participación del desarrollador', Number(dto.developer_share_of_margin));
  if (collabGiven) assertFraction('La participación del colaborador', Number(dto.collaborator_share_of_margin));
  if (devGiven && collabGiven) {
    sub.platform_developer_share.percentage_of_operating_margin = Number(dto.developer_share_of_margin);
    sub.collaborator_pool_share.percentage_of_operating_margin = Number(dto.collaborator_share_of_margin);
  } else if (devGiven) {
    sub.platform_developer_share.percentage_of_operating_margin = Number(dto.developer_share_of_margin);
    sub.collaborator_pool_share.percentage_of_operating_margin = round6(1 - Number(dto.developer_share_of_margin));
  } else if (collabGiven) {
    sub.collaborator_pool_share.percentage_of_operating_margin = Number(dto.collaborator_share_of_margin);
    sub.platform_developer_share.percentage_of_operating_margin = round6(1 - Number(dto.collaborator_share_of_margin));
  }

  // Derived values
  gateway.effective_fee_percentage_calculated = round6(gateway.percentage_fee * (1 + gateway.tax_on_fee_percentage));
  const committed =
    gateway.effective_fee_percentage_calculated +
    alloc.prize_pool.percentage_of_gross +
    alloc.animal_charity.percentage_of_gross;
  if (committed > 1 + PCT_EPSILON) {
    throw new Error(
      `Premio + refugio + comisión Payphone suman ${(committed * 100).toFixed(2)}% (máximo 100%).`
    );
  }
  alloc.gross_operating_margin.percentage_of_gross = round6(Math.max(0, 1 - committed));

  const subSum =
    sub.platform_developer_share.percentage_of_operating_margin +
    sub.collaborator_pool_share.percentage_of_operating_margin;
  if (Math.abs(subSum - 1) > 1e-6) {
    throw new Error('Desarrollador + colaborador deben sumar 100% del margen operativo.');
  }
  sub.platform_developer_share.effective_percentage_of_gross = round6(
    alloc.gross_operating_margin.percentage_of_gross * sub.platform_developer_share.percentage_of_operating_margin
  );
  sub.collaborator_pool_share.effective_percentage_of_gross = round6(
    alloc.gross_operating_margin.percentage_of_gross * sub.collaborator_pool_share.percentage_of_operating_margin
  );

  return next;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export interface ConfigFieldChange {
  field: keyof FinancialConfigUpdate;
  label: string;
  before: number;
  after: number;
}

/**
 * Fields that change what a pair pays or where its money goes. They are frozen once a pair
 * has paid in the active tournament; capacity can still grow.
 */
export const LOCKABLE_CONFIG_FIELDS: Array<keyof FinancialConfigUpdate> = [
  'entry_fee_per_pair',
  'payphone_percentage_fee',
  'prize_pool_percentage',
  'charity_percentage',
  'developer_share_of_margin',
  'collaborator_share_of_margin'
];

const CONFIG_FIELD_LABELS: Record<keyof FinancialConfigUpdate, string> = {
  entry_fee_per_pair: 'Cuota por pareja',
  max_couples_limit: 'Límite de parejas',
  payphone_percentage_fee: 'Comisión Payphone (sin IVA)',
  prize_pool_percentage: 'Pozo de premios',
  charity_percentage: 'Refugio animal',
  developer_share_of_margin: 'Plataforma (del margen)',
  collaborator_share_of_margin: 'Colaborador (del margen)'
};

/** Flattens a config into the editable values, in the same units as FinancialConfigUpdate. */
export function configToUpdateValues(config: TournamentFinancialConfig): Required<FinancialConfigUpdate> {
  const ps = config.pricing_structure;
  return {
    entry_fee_per_pair: config.entry_fee_per_pair,
    max_couples_limit: config.max_couples_limit,
    payphone_percentage_fee: ps.payphone_gateway.percentage_fee,
    prize_pool_percentage: ps.revenue_allocation_percentages.prize_pool.percentage_of_gross,
    charity_percentage: ps.revenue_allocation_percentages.animal_charity.percentage_of_gross,
    developer_share_of_margin: ps.margin_sub_distribution.platform_developer_share.percentage_of_operating_margin,
    collaborator_share_of_margin: ps.margin_sub_distribution.collaborator_pool_share.percentage_of_operating_margin
  };
}

export function diffFinancialConfig(
  before: TournamentFinancialConfig,
  after: TournamentFinancialConfig
): ConfigFieldChange[] {
  const a = configToUpdateValues(before);
  const b = configToUpdateValues(after);
  return (Object.keys(CONFIG_FIELD_LABELS) as Array<keyof FinancialConfigUpdate>)
    .filter((field) => Math.abs(a[field] - b[field]) > 1e-9)
    .map((field) => ({ field, label: CONFIG_FIELD_LABELS[field], before: a[field], after: b[field] }));
}

export interface PodiumPrizeDistribution {
  accumulated_prize_pool: number;
  first_place: number;
  second_place: number;
  third_place: number;
  total_distributed: number;
}

export function calculatePodiumPrizes(
  accumulatedPrizePool: number,
  podium: PrizePodiumBreakdown = DEFAULT_FINANCIAL_CONFIG.prize_podium_breakdown
): PodiumPrizeDistribution {
  const first_place = round2(accumulatedPrizePool * podium.first_place_percentage);
  const second_place = round2(accumulatedPrizePool * podium.second_place_percentage);
  const third_place = round2(accumulatedPrizePool * podium.third_place_percentage);
  const total_distributed = round2(first_place + second_place + third_place);

  return {
    accumulated_prize_pool: round2(accumulatedPrizePool),
    first_place,
    second_place,
    third_place,
    total_distributed
  };
}
