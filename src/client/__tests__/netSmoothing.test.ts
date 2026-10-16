import { describe, expect, it } from 'vitest';
import { getLaneCenterX } from '../../shared/math.js';
import { GameSimulation } from '../../shared/simulation.js';
import type { ServerWorldStatePayload } from '../../shared/types.js';
import { DriverPredictor, extrapolateWorld, ServerClock, TICK_MS } from '../netSmoothing.js';

/** Deterministic pseudo-random numbers for repeatable network jitter. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

describe('ServerClock', () => {
  it('estimates the server tick despite jittered arrivals', () => {
    const clock = new ServerClock();
    const r = rng(7);
    const base = 1000;
    for (let tick = 0; tick <= 600; tick += 2) {
      const arrival = base + tick * TICK_MS + 60 + r() * 40; // 60 ms latency + up to 40 ms jitter
      clock.observe(tick, arrival);
    }
    // At "now", the true server tick is 600 + (elapsed since its send) / TICK_MS
    const now = base + 600 * TICK_MS + 60;
    const est = clock.estimateTick(now)!;
    expect(Math.abs(est - 600)).toBeLessThan(1.5);
  });

  it('resets when a new match restarts the ticks, but ignores a slightly older state', () => {
    const clock = new ServerClock();
    clock.observe(900, 20_000);
    clock.observe(898, 20_100); // stale: must not reset nor move the clock
    expect(clock.estimateTick(20_000)).toBeCloseTo(900, 5);
    clock.observe(2, 21_000);
    expect(clock.estimateTick(21_000)).toBeCloseTo(2, 5);
  });

  it('returns null before any state', () => {
    expect(new ServerClock().estimateTick(1000)).toBeNull();
  });
});

describe('extrapolateWorld', () => {
  it('predicts where obstacles will be a few ticks later (same motion as the simulation)', () => {
    const sim = new GameSimulation(false);
    sim.startMatch(42);
    let state: ServerWorldStatePayload = sim.step(1 / 60);
    // Let some obstacles spawn, keeping the AI crew alive
    for (let i = 0; i < 240; i++) {
      sim.updateBotCoPilot('driver');
      sim.updateBotCoPilot('navigator');
      state = sim.step(1 / 60);
    }
    expect(state.entity_positions.obstacles.length).toBeGreaterThan(0);

    const k = 4; // what the client advances between two 30 Hz states
    const predicted = extrapolateWorld(state, k / 60);
    let later = state;
    for (let i = 0; i < k; i++) {
      sim.updateBotCoPilot('driver');
      sim.updateBotCoPilot('navigator');
      later = sim.step(1 / 60);
    }
    for (const p of predicted.entity_positions.obstacles) {
      const actual = later.entity_positions.obstacles.find((o) => o.id === p.id);
      if (!actual) continue; // collected or deflected meanwhile
      expect(Math.abs(actual.y - p.y)).toBeLessThan(3);
      expect(Math.abs(actual.x - p.x)).toBeLessThan(3);
    }
  });

  it('does not move anything when not running, and caps long gaps', () => {
    const sim = new GameSimulation(false);
    const lobby = sim.getWorldStatePayload();
    expect(extrapolateWorld(lobby, 0.1)).toBe(lobby);

    sim.startMatch(1);
    const s = sim.step(1 / 60);
    const far = extrapolateWorld(s, 5); // a 5 s stall is capped
    const capped = extrapolateWorld(s, 0.15);
    expect(far.entity_positions.obstacles).toEqual(capped.entity_positions.obstacles);
  });
});

describe('DriverPredictor', () => {
  it('re-applies only the inputs the server has not acknowledged', () => {
    const p = new DriverPredictor();
    for (let seq = 1; seq <= 10; seq++) {
      p.recordSent(seq, 1, 0);
      p.advance(1 / 60);
    }
    const x0 = getLaneCenterX(1);
    const pos = p.predict(x0, 720, 5); // server has applied up to seq 5
    expect(pos.x).toBeCloseTo(x0 + 310 * (5 / 60), 3);
    expect(pos.y).toBe(720);
  });

  it('stays inside the road and converges to the server when everything is acknowledged', () => {
    const p = new DriverPredictor();
    for (let seq = 1; seq <= 300; seq++) {
      p.recordSent(seq, 1, 0);
      p.advance(1 / 60);
    }
    expect(p.predict(480, 720, 0).x).toBeLessThanOrEqual(510);
    expect(p.predict(300, 720, 300).x).toBe(300);
  });
});

// ---------------------------------------------------------------------------------------
// Before/after: render a real match through a jittery network, frame by frame
// ---------------------------------------------------------------------------------------

interface NetResult {
  repeatedFramePct: number;
  jumpFramePct: number;
}

/**
 * Runs a match on a "server" (60 ticks/s), sends states every `sendEvery` ticks through a
 * network with 70 ms latency + random jitter, and draws at `fps`. Tracks the vertical motion
 * of obstacles on screen: a smooth picture moves them by the same amount every frame.
 */
function renderThroughNetwork(method: 'raw' | 'smoothed', sendEvery: number, jitterMs: number, fps: number): NetResult {
  const sim = new GameSimulation(false);
  sim.startMatch(9);
  const r = rng(3);
  const packets: Array<{ arrival: number; state: ServerWorldStatePayload }> = [];
  const seconds = 20;
  for (let tick = 1; tick <= seconds * 60; tick++) {
    sim.updateBotCoPilot('driver');
    sim.updateBotCoPilot('navigator');
    const state = sim.step(1 / 60);
    if (state.world_state.status !== 'running') sim.reviveWithRewardedAd();
    if (tick % sendEvery === 0) {
      const jitter = (r() + r() + r() - 1.5) * 2 * jitterMs; // bell-shaped
      packets.push({ arrival: tick * TICK_MS + 70 + Math.max(-60, jitter), state: JSON.parse(JSON.stringify(state)) });
    }
  }
  // WebSocket runs over TCP: packets never overtake each other, a late one holds back the rest
  for (let i = 1; i < packets.length; i++) {
    packets[i].arrival = Math.max(packets[i].arrival, packets[i - 1].arrival);
  }

  const clock = new ServerClock();
  let latest: ServerWorldStatePayload | null = null;
  let next = 0;
  let prevY: Map<string, number> = new Map();
  let frames = 0;
  let repeated = 0;
  let jumps = 0;
  const frameMs = 1000 / fps;
  for (let now = 2000; now < seconds * 1000; now += frameMs) {
    while (next < packets.length && packets[next].arrival <= now) {
      const pk = packets[next++];
      if (!latest || pk.state.tick > latest.tick) latest = pk.state; // drop out-of-order
      clock.observe(pk.state.tick, pk.arrival);
    }
    if (!latest) continue;
    let drawn = latest;
    if (method === 'smoothed') {
      const est = clock.estimateTick(now)!;
      drawn = extrapolateWorld(latest, ((est - latest.tick) * TICK_MS) / 1000);
    }
    // Expected on-screen motion this frame for obstacles (scroll speed)
    const expected = drawn.speed_multiplier.current_speed * 2.35 * (frameMs / 1000);
    const moves: number[] = [];
    for (const o of drawn.entity_positions.obstacles) {
      if (o.side_threat) continue;
      const py = prevY.get(o.id);
      if (py !== undefined) moves.push(o.y - py);
    }
    prevY = new Map(drawn.entity_positions.obstacles.map((o) => [o.id, o.y]));
    if (moves.length === 0) continue;
    frames++;
    const avg = moves.reduce((a, b) => a + b, 0) / moves.length;
    if (avg < expected * 0.25) repeated++;
    else if (avg > expected * 1.75) jumps++;
  }
  return { repeatedFramePct: (100 * repeated) / frames, jumpFramePct: (100 * jumps) / frames };
}

describe('Online smoothness: before vs after (simulated network)', () => {
  it('raw 60 Hz states stutter with jitter; smoothed 30 Hz states stay fluid', () => {
    const results: Record<string, NetResult> = {};
    for (const jitter of [5, 15, 30]) {
      results[`antes_60Hz_jitter${jitter}ms`] = renderThroughNetwork('raw', 1, jitter, 60);
      results[`despues_30Hz_jitter${jitter}ms`] = renderThroughNetwork('smoothed', 2, jitter, 60);
    }
    results['antes_144fps_jitter15ms'] = renderThroughNetwork('raw', 1, 15, 144);
    results['despues_144fps_jitter15ms'] = renderThroughNetwork('smoothed', 2, 15, 144);
    // eslint-disable-next-line no-console
    console.table(
      Object.fromEntries(
        Object.entries(results).map(([k, v]) => [k, { repetidos: `${v.repeatedFramePct.toFixed(1)}%`, saltos: `${v.jumpFramePct.toFixed(1)}%` }])
      )
    );

    for (const jitter of [15, 30]) {
      const before = results[`antes_60Hz_jitter${jitter}ms`];
      const after = results[`despues_30Hz_jitter${jitter}ms`];
      expect(before.repeatedFramePct + before.jumpFramePct).toBeGreaterThan(10);
      expect(after.repeatedFramePct + after.jumpFramePct).toBeLessThan(3);
    }
    const hiBefore = results['antes_144fps_jitter15ms'];
    const hiAfter = results['despues_144fps_jitter15ms'];
    expect(hiAfter.repeatedFramePct + hiAfter.jumpFramePct).toBeLessThan(hiBefore.repeatedFramePct + hiBefore.jumpFramePct);
  });
});
