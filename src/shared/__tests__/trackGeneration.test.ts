import { describe, expect, it } from 'vitest';
import { createRng, seedFromString, tournamentTrackSeed } from '../random.js';
import { DIFFICULTY_PHASES, getDifficultyPhase, isBreatherStretch, TRACK_RULES } from '../rules.js';
import { GameSimulation } from '../simulation.js';
import type { LaneIndex, ObstacleEntity } from '../types.js';

const DT = 1 / 60;

interface WaveRecord {
  meter: number;
  type: ObstacleEntity['type'];
  lane: LaneIndex;
}

/**
 * Plays a match with both AI co-pilots and records every obstacle when it first appears,
 * keyed by the meter it was generated at.
 */
function recordTrack(seed: number, seconds: number, driveStyle: 'bot' | 'idle' = 'bot') {
  const sim = new GameSimulation(false);
  sim.startMatch(seed);
  const seen = new Set<string>();
  const waves: WaveRecord[] = [];
  const scores: number[] = [];
  let lastDistance = 0;
  for (let t = 0; t < seconds; t += DT) {
    if (driveStyle === 'bot') {
      sim.updateBotCoPilot('driver');
      sim.updateBotCoPilot('navigator');
    }
    const p = sim.step(DT);
    for (const o of p.entity_positions.obstacles) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      // The wave meter is recovered from where it was placed (23.5 px per meter, spawned at y≈-60..-40)
      waves.push({ meter: Math.round(lastDistance), type: o.type, lane: o.lane });
    }
    lastDistance = p.world_state.distance_traveled;
    scores.push(p.world_state.total_score);
    if (p.world_state.status === 'ad_revive_prompt') sim.reviveWithRewardedAd();
    if (p.world_state.status === 'gameover') break;
  }
  return { waves, scores, sim };
}

describe('Seeded random generator', () => {
  it('same seed → same sequence; different seeds → different sequences', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const seqA = Array.from({ length: 5 }, a);
    expect(Array.from({ length: 5 }, b)).toEqual(seqA);
    expect(Array.from({ length: 5 }, c)).not.toEqual(seqA);
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it('the tournament seed is stable per tournament id', () => {
    expect(tournamentTrackSeed('tourney-01')).toBe(tournamentTrackSeed('tourney-01'));
    expect(tournamentTrackSeed('tourney-01')).not.toBe(tournamentTrackSeed('tourney-02'));
    expect(seedFromString('abc')).toBe(seedFromString('abc'));
  });
});

describe('Score never goes down (Overdrive bug fixed)', () => {
  it('total_score is monotonic over many full matches', () => {
    for (let seed = 1; seed <= 15; seed++) {
      const { scores } = recordTrack(seed, 200);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
      }
    }
  });

  it('Overdrive only adds the bonus for the seconds it is active', () => {
    const plain = new GameSimulation(false);
    plain.startMatch(7);
    const boosted = new GameSimulation(false);
    boosted.startMatch(7);
    // Collect an overdrive cell placed right on the vehicle
    const mecha = boosted.getWorldStatePayload().entity_positions.mecha;
    boosted.spawnObstacleForTest({
      id: 'od', type: 'overdrive_cell', lane: 1, x: mecha.x, y: mecha.y, width: 42, height: 42, vx: 0, vy: 0
    });
    let p1 = plain.step(DT);
    let p2 = boosted.step(DT);
    // Run past the 6 s overdrive window
    for (let i = 0; i < 60 * 8; i++) {
      p1 = plain.step(DT);
      p2 = boosted.step(DT);
    }
    expect(p2.world_state.is_overdrive).toBe(false);
    const extra = p2.world_state.total_score - p1.world_state.total_score;
    // ≈ 6 s * 50 extra survival points, plus a little extra distance from the speed bonus
    expect(extra).toBeGreaterThan(250);
    expect(extra).toBeLessThan(2500);
  });
});

describe('Deterministic track', () => {
  it('two crews with the same seed face the same obstacles at the same meters', () => {
    const seed = tournamentTrackSeed('tourney-default-01');
    const bot = recordTrack(seed, 60, 'bot').waves;
    const idle = recordTrack(seed, 60, 'idle').waves; // different driving, different speed
    const overlap = Math.min(bot.length, idle.length, 25);
    expect(overlap).toBeGreaterThan(10);
    for (let i = 0; i < overlap; i++) {
      expect(idle[i].type).toBe(bot[i].type);
      expect(idle[i].lane).toBe(bot[i].lane);
      expect(Math.abs(idle[i].meter - bot[i].meter)).toBeLessThanOrEqual(1);
    }
  });

  it('practice matches without a seed get a different track each time', () => {
    const a = new GameSimulation(false);
    a.startMatch();
    const b = new GameSimulation(false);
    b.startMatch();
    expect(a.getTrackSeed()).not.toBe(b.getTrackSeed());
  });

  it('exposes the phase and seed in the world state', () => {
    const sim = new GameSimulation(false);
    sim.startMatch(99);
    const p = sim.step(DT);
    expect(p.world_state.track_seed).toBe(99);
    expect(p.world_state.difficulty_phase).toBe('Calentamiento');
  });
});

describe('Difficulty phases', () => {
  it('phases are ordered and get denser', () => {
    for (let i = 1; i < DIFFICULTY_PHASES.length; i++) {
      expect(DIFFICULTY_PHASES[i].fromDistance).toBeGreaterThan(DIFFICULTY_PHASES[i - 1].fromDistance);
      expect(DIFFICULTY_PHASES[i].spacing).toBeLessThanOrEqual(DIFFICULTY_PHASES[i - 1].spacing);
    }
    expect(getDifficultyPhase(0).id).toBe('warmup');
    expect(getDifficultyPhase(900).id).toBe('storm');
    expect(getDifficultyPhase(5000).id).toBe('legend');
  });

  it('warm-up has no double barriers or flank pairs; breathers only contain pickups', () => {
    for (let seed = 1; seed <= 200; seed++) {
      for (const wave of GameSimulation.generateTrackLayout(seed, 6000)) {
        const barriers = wave.obstacles.filter((o) => o.type === 'barrier').length;
        const flanks = wave.obstacles.filter((o) => o.type === 'flank_left' || o.type === 'flank_right').length;
        if (wave.meter < 250) {
          expect(barriers).toBeLessThanOrEqual(1);
          expect(flanks).toBeLessThanOrEqual(1);
        }
        if (isBreatherStretch(wave.meter)) {
          expect(wave.obstacles.every((o) => o.type === 'repair_cell' || o.type === 'overdrive_cell')).toBe(true);
        }
      }
    }
  });

  it('later phases are denser: more waves and more double barriers per km', () => {
    const stats = (from: number, to: number) => {
      let waves = 0;
      let doubles = 0;
      for (let seed = 1; seed <= 100; seed++) {
        for (const w of GameSimulation.generateTrackLayout(seed, to)) {
          if (w.meter < from || w.meter >= to || isBreatherStretch(w.meter)) continue;
          waves++;
          if (w.obstacles.filter((o) => o.type === 'barrier').length === 2) doubles++;
        }
      }
      return { wavesPerKm: waves / 100 / ((to - from) / 1000), doubles };
    };
    const warmup = stats(0, 250);
    const legend = stats(2800, 4000);
    expect(legend.wavesPerKm).toBeGreaterThan(warmup.wavesPerKm);
    expect(warmup.doubles).toBe(0);
    expect(legend.doubles).toBeGreaterThan(0);
  });

  it('the layout matches what a crew actually meets in play', () => {
    const seed = 2024;
    const layout = GameSimulation.generateTrackLayout(seed, 400).flatMap((w) => w.obstacles.map((o) => `${o.type}:${o.lane}`));
    const played = recordTrack(seed, 40).waves.map((w) => `${w.type}:${w.lane}`);
    const n = Math.min(layout.length, played.length);
    expect(n).toBeGreaterThan(15);
    expect(played.slice(0, n)).toEqual(layout.slice(0, n));
  });
});

describe('No impossible barrier combinations', () => {
  it('over 200 tracks x 6 km there is always an open lane reachable in time at max speed', () => {
    const all: LaneIndex[] = [0, 1, 2];
    let barrierWaves = 0;
    for (let seed = 1; seed <= 200; seed++) {
      let prev: { meter: number; free: LaneIndex[] } | null = null;
      for (const wave of GameSimulation.generateTrackLayout(seed, 6000)) {
        const blocked = new Set(wave.obstacles.filter((o) => o.type === 'barrier').map((o) => o.lane));
        if (blocked.size === 0) continue;
        barrierWaves++;
        expect(blocked.size).toBeLessThanOrEqual(2);
        const free = all.filter((l) => !blocked.has(l));
        if (prev) {
          const gap = wave.meter - prev.meter;
          const maxShift = gap >= TRACK_RULES.SAFE_GAP_TWO_LANES ? 2 : gap >= TRACK_RULES.SAFE_GAP_ONE_LANE ? 1 : 0;
          const p = prev;
          expect(free.some((f) => p.free.some((pf) => Math.abs(f - pf) <= maxShift))).toBe(true);
        }
        prev = { meter: wave.meter, free };
      }
    }
    expect(barrierWaves).toBeGreaterThan(10000);
  });
});
