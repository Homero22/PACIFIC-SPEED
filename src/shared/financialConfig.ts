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
 */
export function calculateTransactionSplits(
  grossAmount: number,
  config: TournamentFinancialConfig = DEFAULT_FINANCIAL_CONFIG
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

  const developer_net = round2(
    allocated_to_operating_margin * subDist.platform_developer_share.percentage_of_operating_margin
  );
  const collaborator_referral_payout = round2(
    allocated_to_operating_margin * subDist.collaborator_pool_share.percentage_of_operating_margin
  );

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
