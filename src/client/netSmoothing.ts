/**
 * Smooth online play: the server sends ~30 states per second and they arrive with network
 * jitter. Instead of drawing the last state "raw" (repeated frames, then jumps), the client:
 *  1. estimates the server clock from the arrival times (ServerClock),
 *  2. advances the latest state to "now" using the known motion (extrapolateWorld),
 *  3. moves the driver's own vehicle instantly with its own inputs (DriverPredictor).
 * Presentation only: the server stays authoritative for collisions, score and pickups.
 */
import { clamp, clampVector, TRACK_CONFIG } from '../shared/math.js';
import { TRACK_RULES } from '../shared/rules.js';
import type { ServerWorldStatePayload } from '../shared/types.js';

export const TICK_MS = 1000 / 60;
/** Obstacles scroll at speed * 2.35 px/s (same formula as the simulation). */
const SCROLL_PX_PER_SPEED = 2.35;
/** Never extrapolate further than this: if states stop arriving, the picture just holds. */
const MAX_EXTRAPOLATION_S = 0.25;
/** Same steering/vertical speeds as the simulation. */
const LATERAL_SPEED = 310;
const VERTICAL_SPEED = 160;

/**
 * Estimates which server tick is happening "now". Keeps the smallest (arrival - tick time)
 * seen recently, i.e. the fastest delivery, so late packets do not make the clock jump.
 */
export class ServerClock {
  private samples: Array<{ at: number; offset: number }> = [];
  private lastTick = -1;

  constructor(private readonly windowMs = 3000) {}

  public observe(tick: number, arrivalMs: number): void {
    // New match (ticks restart at 0). A small step back is just a stale state: ignore it.
    if (tick < this.lastTick - 120) this.reset();
    if (tick < this.lastTick) return;
    this.lastTick = tick;
    this.samples.push({ at: arrivalMs, offset: arrivalMs - tick * TICK_MS });
    const cutoff = arrivalMs - this.windowMs;
    while (this.samples.length > 1 && this.samples[0].at < cutoff) this.samples.shift();
  }

  /** Estimated server tick at `nowMs` (fractional), or null before the first state. */
  public estimateTick(nowMs: number): number | null {
    if (this.samples.length === 0) return null;
    // Fastest delivery seen in the window. Measured against a slow-gliding variant, this
    // plain minimum gave far fewer stuck/jumping frames (see netSmoothing.test.ts).
    let offset = Infinity;
    for (const s of this.samples) offset = Math.min(offset, s.offset);
    return (nowMs - offset) / TICK_MS;
  }

  public reset(): void {
    this.samples = [];
    this.lastTick = -1;
  }
}

/**
 * Returns a copy of `state` advanced by `seconds` using the motion the simulation applies
 * every tick (scroll, drift and the flank drones homing in). Clamped to MAX_EXTRAPOLATION_S.
 */
export function extrapolateWorld(state: ServerWorldStatePayload, seconds: number): ServerWorldStatePayload {
  let remaining = clamp(seconds, 0, MAX_EXTRAPOLATION_S);
  if (remaining === 0 || state.world_state.status !== 'running') return state;

  const mecha = state.entity_positions.mecha;
  const scroll = state.speed_multiplier.current_speed * SCROLL_PX_PER_SPEED;
  let mechaX = mecha.x;
  let mechaY = mecha.y;
  const obstacles = state.entity_positions.obstacles.map((o) => ({ ...o }));

  // Same order as the simulation, in 1/60 s sub-steps (flank drones start homing mid-way)
  while (remaining > 1e-9) {
    const dt = Math.min(1 / 60, remaining);
    remaining -= dt;
    mechaX = clamp(
      mechaX + mecha.vx * dt,
      TRACK_CONFIG.ROAD_LEFT + TRACK_CONFIG.MECHA_WIDTH * 0.55,
      TRACK_CONFIG.ROAD_RIGHT - TRACK_CONFIG.MECHA_WIDTH * 0.55
    );
    mechaY = clamp(mechaY + mecha.vy * dt, TRACK_CONFIG.MECHA_MIN_Y, TRACK_CONFIG.MECHA_MAX_Y);
    for (const o of obstacles) {
      if (o.type === 'flank_cross') {
        // Same rule as the simulation: fall, then sweep across at the vehicle's height
        if (!o.crossing) {
          o.y += (scroll + o.vy) * dt;
          if (o.y >= mechaY) {
            o.crossing = true;
            o.y = mechaY;
          }
        } else {
          o.x += (o.side_threat === 'left' ? 1 : -1) * TRACK_RULES.BRANCH_CROSS_SPEED * dt;
          o.y = mechaY;
        }
        continue;
      }
      o.x += o.vx * dt;
      o.y += (scroll + o.vy) * dt;
      if (o.side_threat === 'left' || o.side_threat === 'right') {
        const dy = mechaY - o.y;
        if (dy > -50 && dy < 260) o.x += Math.sign(mechaX - o.x) * 145 * dt;
      }
    }
  }

  return {
    ...state,
    entity_positions: {
      ...state.entity_positions,
      mecha: { ...mecha, x: mechaX, y: mechaY },
      obstacles
    }
  };
}

interface SentInput {
  seq: number;
  x: number;
  y: number;
  /** Seconds this input was held before the next one was sent. */
  dt: number;
}

/**
 * Client-side prediction for the driver: start from the server position and re-apply the
 * inputs the server has not acknowledged yet, so steering responds instantly. Each new
 * server state corrects any drift.
 */
export class DriverPredictor {
  private pending: SentInput[] = [];

  /** Records an input just sent to the server. */
  public recordSent(seq: number, x: number, y: number): void {
    this.pending.push({ seq, x, y, dt: 0 });
    if (this.pending.length > 120) this.pending.shift(); // ~2 s of history at most
  }

  /** Adds elapsed time to the input currently held (the last one sent). */
  public advance(seconds: number): void {
    const last = this.pending[this.pending.length - 1];
    if (last) last.dt += Math.max(0, seconds);
  }

  /**
   * Predicted vehicle position: the server's position plus the movement of every input
   * newer than `ackSeq` (the last input the server had applied in that state).
   */
  public predict(serverX: number, serverY: number, ackSeq: number | undefined): { x: number; y: number } {
    if (ackSeq !== undefined) {
      // Keep the acknowledged input itself only if it is still being held (it is the last one)
      while (this.pending.length > 1 && this.pending[0].seq <= ackSeq) this.pending.shift();
    }
    let x = serverX;
    let y = serverY;
    for (const input of this.pending) {
      if (ackSeq !== undefined && input.seq <= ackSeq) continue;
      const v = clampVector({ x: input.x * LATERAL_SPEED, y: -input.y * VERTICAL_SPEED }, LATERAL_SPEED);
      x += v.x * input.dt;
      y += v.y * input.dt;
    }
    return {
      x: clamp(x, TRACK_CONFIG.ROAD_LEFT + TRACK_CONFIG.MECHA_WIDTH * 0.55, TRACK_CONFIG.ROAD_RIGHT - TRACK_CONFIG.MECHA_WIDTH * 0.55),
      y: clamp(y, TRACK_CONFIG.MECHA_MIN_Y, TRACK_CONFIG.MECHA_MAX_Y)
    };
  }

  public reset(): void {
    this.pending = [];
  }
}
