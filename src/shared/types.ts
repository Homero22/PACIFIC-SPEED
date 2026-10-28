import type {
  ConfigFieldChange,
  FinancialConfigUpdate,
  TournamentFinancialConfig,
  TournamentSecurityConfig,
  TransactionCalculationResult
} from './financialConfig.js';

export type PlayerRole = 'driver' | 'navigator';
export type ShieldSide = 'left' | 'right';
export type LaneIndex = 0 | 1 | 2;
export type GameMode = 'online' | 'local_coop' | 'local_bot';

export type TacticalCommsPreset =
  | 'bogey_alert'
  | 'nice_deflect'
  | 'engage_overdrive'
  | 'mayday_panic';

export interface TacticalCommsEvent {
  id: string;
  sender_name: string;
  sender_role: PlayerRole;
  preset: TacticalCommsPreset;
  code: string;
  label: string;
  timestamp: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Circle {
  x: number;
  y: number;
  radius: number;
}

export interface CosmeticLoadout {
  paintJob: 'crimson_jaeger' | 'cyber_gold' | 'phantom_stealth';
  neonTrail: 'plasma_cyan' | 'overdrive_magenta' | 'solar_flare';
  hudTheme: 'tactical_amber' | 'neural_green' | 'abyssal_violet';
}

export interface ClientInputPayload {
  player_id: string;
  role: PlayerRole;
  input_vector: Vec2; // x: steering [-1, 1], y: throttle [-1, 1]
  action_flags: {
    shield_left: boolean;
    shield_right: boolean;
    radar_pulse: boolean;
    ping_lane: LaneIndex | null;
  };
  timestamp: number;
  seq: number;
}

export type ObstacleType =
  | 'barrier'
  | 'flank_left'
  | 'flank_right'
  /** Branch blown across the whole road at the vehicle's height (blocked by the shield on its origin side). */
  | 'flank_cross'
  | 'overdrive_cell'
  | 'repair_cell';

export interface ObstacleEntity {
  id: string;
  type: ObstacleType;
  lane: LaneIndex;
  x: number;
  y: number;
  width: number;
  height: number;
  vx: number;
  vy: number;
  side_threat?: ShieldSide;
  /** flank_cross only: true once it is sweeping across the road at the vehicle's height. */
  crossing?: boolean;
}

export interface TacticalPing {
  id: string;
  lane: LaneIndex;
  x: number;
  y_offset: number;
  ttl: number;
  max_ttl: number;
}

export type SoundEventType =
  | 'shield_deflect'
  | 'collision_damage'
  | 'ping_deployed'
  | 'overdrive_activated'
  | 'explosion'
  | 'revive'
  | 'repair_collected'
  | 'shield_up'
  | 'shield_double';

export interface SoundEvent {
  id: string;
  type: SoundEventType;
  timestamp: number;
  /** Posición estéreo del origen: -1 izquierda, 0 centro, 1 derecha. */
  pan?: number;
  /** 0..1. En choques: gravedad según la integridad que queda (1 = destruida). */
  intensity?: number;
}

export interface ServerWorldStatePayload {
  tick: number;
  timestamp: number;
  world_state: {
    status: 'lobby' | 'running' | 'ad_revive_prompt' | 'gameover';
    distance_traveled: number;
    survival_time: number;
    total_score: number;
    integrity: number;
    max_integrity: number;
    self_destruct_timer: number | null;
    is_overdrive: boolean;
    overdrive_timer: number;
    ad_revive_used: boolean;
    collision_penalty: number;
    active_shields: {
      left: boolean;
      right: boolean;
      energy: number;
      max_energy: number;
    };
    active_pings: TacticalPing[];
    events: SoundEvent[];
    /** Current difficulty phase name (e.g. "Tormenta") or "Respiro". */
    difficulty_phase?: string;
    /** Seed of the track: tournament matches share it, practice matches get a new one. */
    track_seed?: number;
  };
  /**
   * Last input `seq` the server applied for each player (player_id → seq). Lets the driver's
   * client re-apply only the inputs the server has not seen yet (client-side prediction).
   */
  input_acks?: Record<string, number>;
  entity_positions: {
    mecha: {
      x: number;
      y: number;
      vx: number;
      vy: number;
      width: number;
      height: number;
      radius: number;
      current_lane: LaneIndex;
    };
    obstacles: ObstacleEntity[];
  };
  speed_multiplier: {
    current_speed: number;
    base_speed: number;
    max_speed: number;
    critical_threshold: number;
    normalized: number;
  };
  fog_matrix: {
    visibility_radius: number;
    tunnel_intensity: number;
    radar_reveal_timer: number;
  };
}

export interface RoomPlayerInfo {
  /** Public, server-generated id. Not a credential (see session_token). */
  player_id: string;
  name: string;
  role: PlayerRole;
  ready: boolean;
  cosmetics: CosmeticLoadout;
  is_host: boolean;
  connected: boolean;
  /** While disconnected: ms left before the seat is released. */
  grace_remaining_ms?: number;
}

export interface RoomLobbyState {
  room_code: string;
  players: RoomPlayerInfo[];
  max_players: number;
  status: 'lobby' | 'running' | 'ad_revive_prompt' | 'gameover';
  is_tournament_verified?: boolean;
  pending_role_swap?: { from_player_id: string; to_player_id: string };
}

/** Room codes: 6 chars, no ambiguous 0/O/1/I. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

export function normalizeRoomCode(raw: unknown): string {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
}

export type RoomErrorCode =
  | 'invalid_code'
  | 'not_found'
  | 'full'
  | 'expired'
  | 'server_full'
  | 'not_in_room'
  | 'not_allowed';

export interface LeaderboardEntry {
  id: string;
  room_code: string;
  driver_name: string;
  navigator_name: string;
  total_score: number;
  distance_traveled: number;
  survival_time: number;
  region: string;
  created_at: string;
  is_tournament?: boolean;
  /** Server-only: the paid registration that played this tournament score. Never sent to clients. */
  payment_audit_id?: string;
  /** Server-only: tournament the score counts for. */
  tournament_id?: string;
}

/** Leaderboard rows as sent to players: without the payment link. */
export function publicLeaderboardEntry(entry: LeaderboardEntry): LeaderboardEntry {
  const { payment_audit_id: _payment, tournament_id: _tournament, ...pub } = entry;
  return pub;
}

// -------------------------------------------------------------
// Tournament Financial & Security Engine Entities
// -------------------------------------------------------------

export type TournamentStatus = 'draft' | 'active' | 'in_progress' | 'completed';

export interface TournamentRecord {
  id: string; // UUID
  name: string;
  status: TournamentStatus;
  entry_fee_usd: number;
  max_couples: number;
  registered_couples_count: number;
  accumulated_prize_pool: number;
  accumulated_charity_amount: number;
  accumulated_operating_margin: number;
  config_snapshot: TournamentFinancialConfig;
  created_at: string;
  completed_at?: string;
}

export interface ReferralRecord {
  id: string; // UUID
  referral_code: string;
  collaborator_name: string;
  collaborator_payphone_number: string;
  total_couples_referred: number;
  accumulated_earnings_usd: number;
  settled_earnings_usd: number;
  pending_earnings_usd: number;
  created_at: string;
}

export type PaymentAuditStatus = 'pending' | 'APPROVED' | 'REJECTED';

export interface PaymentAuditRecord {
  id: string; // UUID
  payphone_transaction_id: string;
  tournament_id: string;
  referral_id: string | null;
  referral_code: string | null;
  pair_driver_name: string;
  pair_navigator_name: string;
  gross_amount: number;
  payphone_fee: number;
  prize_pool_share: number;
  charity_share: number;
  developer_share: number;
  collaborator_share: number;
  status: PaymentAuditStatus;
  raw_payload_json?: string;
  pass_token?: string;
  client_transaction_id?: string;
  created_at: string;
}

export interface SecurityAuditLog {
  id: string;
  event_type:
    | 'impossible_speed'
    | 'impossible_position_jump'
    | 'shield_spam'
    | 'invalid_hmac_signature'
    | 'webhook_replay_rejected'
    | 'rate_limit_exceeded'
    | 'admin_unauthorized_access'
    | 'config_modified'
    | 'payphone_confirm_rejected'
    | 'payment_mismatch'
    | 'payment_over_capacity'
    | 'ws_abuse';
  severity: 'low' | 'medium' | 'high' | 'critical';
  ip_address: string;
  details: string;
  timestamp: string;
}

export interface PayphoneWebhookPayload {
  transactionId: string;
  clientTransactionId: string;
  amount: number; // in cents or dollars (e.g. 1000 or 10.00)
  currency: string;
  status: 'Approved' | 'Rejected' | 'Pending';
  optionalParameter?: string; // referral code or pair meta
  pairMeta?: {
    driver_name: string;
    navigator_name: string;
    room_code?: string;
    referral_code?: string;
  };
  timestamp?: number;
}

export interface PendingRegistrationRecord {
  client_transaction_id: string;
  driver_name: string;
  navigator_name: string;
  referral_code?: string;
  phone?: string;
  /** Contact e-mail (required for new registrations: winners are contacted with it). */
  email?: string;
  /** When the payer accepted the tournament rules (bases). */
  terms_accepted_at?: string;
  /** Firebase account (Google sign-in) that paid: only it can activate the pass. */
  owner_uid?: string;
  owner_email?: string;
  amount_usd: number;
  status: 'PENDING' | 'COMPLETED' | 'CANCELLED' | 'REFUND_REQUIRED';
  tournament_id?: string;
  created_at: string;
  /** Room the payer was in, so the Payphone return lands in the same room. */
  room_code?: string;
  /** Financial config in force when the payment link was created; the split uses it. */
  config_snapshot?: TournamentFinancialConfig;
}

/** A prize handed out to a podium pair, recorded by the admin with its transfer reference. */
export interface PrizePayoutRecord {
  id: string;
  tournament_id: string;
  place: 1 | 2 | 3;
  payment_audit_id: string;
  amount_usd: number;
  reference: string;
  notes?: string;
  paid_at: string;
  admin_ip: string;
}

/** One podium place with everything the admin needs to verify and pay the winner. */
export interface TournamentWinner {
  place: 1 | 2 | 3;
  prize_usd: number;
  payment_audit_id: string;
  driver_name: string;
  navigator_name: string;
  best_score: number;
  distance_traveled: number;
  achieved_at: string;
  matches_played: number;
  payphone_transaction_id: string;
  paid_entry_at: string;
  pass_hint: string;
  contact_phone: string | null;
  contact_email: string | null;
  /** Google account that paid (sign-in), when the pair registered with an account. */
  account_email: string | null;
  terms_accepted_at: string | null;
  payout: PrizePayoutRecord | null;
}

export interface TournamentWinnersReport {
  tournament_id: string;
  tournament_name: string;
  tournament_status: TournamentStatus;
  completed_at: string | null;
  /** Payouts can be recorded only once the tournament is completed (ranking frozen). */
  can_record_payouts: boolean;
  winners: TournamentWinner[];
  /** Tournament scores saved before scores were linked to payments (cannot be attributed). */
  unlinked_tournament_scores: number;
}

/** A tournament pass owned by the signed-in player ("Mis pases"). */
export interface OwnedPass {
  pass_code: string;
  driver_name: string;
  navigator_name: string;
  paid_at: string;
}

export interface TournamentTelemetryStatus {
  tournament: {
    id: string;
    name: string;
    status: TournamentStatus;
    entry_fee_usd: number;
    max_couples: number;
    registered_couples: number;
    accumulated_prize_pool: number;
    accumulated_charity: number;
    podium_preview: {
      first_place: number;
      second_place: number;
      third_place: number;
    };
  };
  config: TournamentFinancialConfig;
}

export interface AdminLoginRequest {
  password: string;
}

export interface AdminLoginResponse {
  token: string;
  expires_in_hours: number;
}

export interface AdminDashboardData {
  tournament: TournamentRecord;
  financial_summary: {
    gross_collected_total: number;
    payphone_fees_total: number;
    prize_pool_total: number;
    charity_total: number;
    developer_net_total: number;
    collaborator_payouts_total: number;
  };
  payments_audit: PaymentAuditRecord[];
  referrals: ReferralRecord[];
  security_logs: SecurityAuditLog[];
  active_config: TournamentFinancialConfig;
  security_config: TournamentSecurityConfig;
  config_lock: FinancialConfigLock;
  config_history: ConfigChangeRecord[];
}

/** Price and split are frozen once a pair has paid, unless the admin forces a change with a reason. */
export interface FinancialConfigLock {
  locked: boolean;
  registered_couples: number;
  locked_fields: Array<keyof FinancialConfigUpdate>;
}

export interface ConfigChangeRecord {
  id: string;
  changed_at: string;
  admin_ip: string;
  forced: boolean;
  reason: string | null;
  registered_couples_at_change: number;
  changes: ConfigFieldChange[];
}

export interface CreateReferralDto {
  referral_code: string;
  collaborator_name: string;
  collaborator_payphone_number: string;
}

export interface SettleReferralDto {
  referral_id: string;
  settle_amount?: number;
}

export type UpdateConfigDto = FinancialConfigUpdate & {
  /** Required to change locked fields once pairs have paid. */
  force?: boolean;
  reason?: string;
};

// -------------------------------------------------------------
// WebSocket Messages
// -------------------------------------------------------------

export type WsClientMessage =
  | {
      type: 'create_room';
      name: string;
      preferred_role?: PlayerRole;
      cosmetics: CosmeticLoadout;
    }
  | {
      type: 'join_room';
      room_code: string;
      name: string;
      cosmetics: CosmeticLoadout;
      /** Issued by the server in room_joined; resumes the same seat. */
      session_token?: string;
      /** Take the seat even if another socket currently holds it (same tab reconnecting, Payphone return). */
      takeover?: boolean;
    }
  | { type: 'leave_room' }
  | { type: 'switch_role'; role: PlayerRole }
  | { type: 'respond_role_swap'; accept: boolean }
  | { type: 'set_ready'; ready: boolean }
  | { type: 'update_cosmetics'; cosmetics: CosmeticLoadout }
  | { type: 'start_match' }
  | { type: 'instant_rematch' }
  | { type: 'set_tournament_pass'; pass_code: string; id_token?: string }
  | { type: 'watch_rewarded_ad' }
  | { type: 'decline_rewarded_ad' }
  | { type: 'send_comms'; preset: TacticalCommsPreset }
  | { type: 'player_input'; payload: ClientInputPayload };

export type WsServerMessage =
  | {
      type: 'room_joined';
      room_code: string;
      player_id: string;
      assigned_role: PlayerRole;
      /** Secret per-seat credential; send it back in join_room to reconnect. */
      session_token: string;
      created: boolean;
      resumed: boolean;
      lobby: RoomLobbyState;
    }
  | { type: 'room_error'; code: RoomErrorCode; room_code?: string; message: string }
  | { type: 'session_replaced'; message: string }
  | { type: 'role_swap_request'; from_player_id: string; from_name: string; requested_role: PlayerRole }
  | { type: 'lobby_update'; lobby: RoomLobbyState }
  | { type: 'world_state'; payload: ServerWorldStatePayload }
  | { type: 'comms_broadcast'; event: TacticalCommsEvent }
  | { type: 'leaderboard_update'; entries: LeaderboardEntry[] }
  | { type: 'error'; message: string };
