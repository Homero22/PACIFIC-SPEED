import type {
  ClientInputPayload,
  CosmeticLoadout,
  LaneIndex,
  PlayerRole,
  TacticalCommsPreset,
  WsClientMessage
} from '../shared/types.js';

export const WS_MAX_PAYLOAD_BYTES = 16 * 1024;

const PAINT_JOBS: readonly CosmeticLoadout['paintJob'][] = ['crimson_jaeger', 'cyber_gold', 'phantom_stealth'];
const NEON_TRAILS: readonly CosmeticLoadout['neonTrail'][] = ['plasma_cyan', 'overdrive_magenta', 'solar_flare'];
const HUD_THEMES: readonly CosmeticLoadout['hudTheme'][] = ['tactical_amber', 'neural_green', 'abyssal_violet'];
const ROLES: readonly PlayerRole[] = ['driver', 'navigator'];
const COMMS: readonly TacticalCommsPreset[] = ['bogey_alert', 'nice_deflect', 'engage_overdrive', 'mayday_panic'];

export const DEFAULT_COSMETICS: CosmeticLoadout = {
  paintJob: 'crimson_jaeger',
  neonTrail: 'plasma_cyan',
  hudTheme: 'tactical_amber'
};

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function shortString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/**
 * Whitelists cosmetics: unknown values fall back to defaults instead of being relayed to other players.
 */
export function sanitizeCosmetics(raw: unknown): CosmeticLoadout {
  const c = isObject(raw) ? raw : {};
  return {
    paintJob: pick(c.paintJob, PAINT_JOBS, DEFAULT_COSMETICS.paintJob),
    neonTrail: pick(c.neonTrail, NEON_TRAILS, DEFAULT_COSMETICS.neonTrail),
    hudTheme: pick(c.hudTheme, HUD_THEMES, DEFAULT_COSMETICS.hudTheme)
  };
}

export function sanitizePlayerName(raw: unknown): string {
  const clean = String(typeof raw === 'string' ? raw : '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .trim()
    .slice(0, 16)
    .toUpperCase();
  return clean || 'PILOT';
}

function parseInput(raw: unknown): ClientInputPayload | null {
  if (!isObject(raw)) return null;
  const vec = isObject(raw.input_vector) ? raw.input_vector : {};
  const flags = isObject(raw.action_flags) ? raw.action_flags : {};
  const lane = flags.ping_lane;
  const pingLane: LaneIndex | null = lane === 0 || lane === 1 || lane === 2 ? lane : null;
  return {
    player_id: typeof raw.player_id === 'string' ? raw.player_id.slice(0, 64) : '',
    role: pick(raw.role, ROLES, 'driver'),
    input_vector: { x: finiteNumber(vec.x), y: finiteNumber(vec.y) },
    action_flags: {
      shield_left: flags.shield_left === true,
      shield_right: flags.shield_right === true,
      radar_pulse: flags.radar_pulse === true,
      ping_lane: pingLane
    },
    timestamp: finiteNumber(raw.timestamp, Date.now()),
    seq: Math.trunc(finiteNumber(raw.seq))
  };
}

/**
 * Parses and validates one client WebSocket message. Returns null for anything malformed.
 */
export function parseClientMessage(raw: string): WsClientMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(msg) || typeof msg.type !== 'string') return null;

  switch (msg.type) {
    case 'join_room': {
      const roomCode = shortString(msg.room_code, 32);
      const playerId = shortString(msg.player_id, 64);
      if (!roomCode || !playerId) return null;
      return {
        type: 'join_room',
        room_code: roomCode,
        player_id: playerId,
        name: sanitizePlayerName(msg.name),
        preferred_role:
          msg.preferred_role === undefined ? undefined : pick(msg.preferred_role, ROLES, 'driver'),
        cosmetics: sanitizeCosmetics(msg.cosmetics)
      };
    }
    case 'switch_role':
      if (!(ROLES as readonly unknown[]).includes(msg.role)) return null;
      return { type: 'switch_role', role: msg.role as PlayerRole };
    case 'update_cosmetics':
      return { type: 'update_cosmetics', cosmetics: sanitizeCosmetics(msg.cosmetics) };
    case 'start_match':
    case 'instant_rematch':
    case 'watch_rewarded_ad':
    case 'decline_rewarded_ad':
      return { type: msg.type };
    case 'send_comms':
      if (!(COMMS as readonly unknown[]).includes(msg.preset)) return null;
      return { type: 'send_comms', preset: msg.preset as TacticalCommsPreset };
    case 'player_input': {
      const payload = parseInput(msg.payload);
      return payload ? { type: 'player_input', payload } : null;
    }
    case 'set_tournament_pass': {
      const pass = shortString(msg.pass_code, 64);
      return pass ? { type: 'set_tournament_pass', pass_code: pass } : null;
    }
    default:
      return null;
  }
}

/**
 * Fixed-window per-socket message limiter.
 */
export class SocketRateLimiter {
  private windowStart = 0;
  private count = 0;

  constructor(
    private readonly maxPerSecond = 240,
    private readonly now: () => number = Date.now
  ) {}

  /** Returns 'ok', 'drop' (over the limit) or 'abuse' (far over the limit: close the socket). */
  public hit(): 'ok' | 'drop' | 'abuse' {
    const t = this.now();
    if (t - this.windowStart >= 1000) {
      this.windowStart = t;
      this.count = 0;
    }
    this.count++;
    if (this.count > this.maxPerSecond * 3) return 'abuse';
    if (this.count > this.maxPerSecond) return 'drop';
    return 'ok';
  }
}

/**
 * Accepts browser WebSocket upgrades only from our own origin (or explicitly allowed ones).
 */
export function isAllowedWsOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowedOrigins: string[],
  isProduction: boolean
): boolean {
  if (!origin) return true; // non-browser clients do not send Origin; CSWSH needs a browser
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (allowedOrigins.includes(parsed.origin)) return true;
  if (host && parsed.host === host) return true;
  if (!isProduction && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) return true;
  return false;
}
