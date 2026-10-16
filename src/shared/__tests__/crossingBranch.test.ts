import { describe, expect, it } from 'vitest';
import { extrapolateWorld } from '../../client/netSmoothing.js';
import { TRACK_CONFIG } from '../math.js';
import { TRACK_RULES } from '../rules.js';
import { GameSimulation } from '../simulation.js';
import type { ObstacleEntity } from '../types.js';

const DT = 1 / 60;
const NO_FLAGS = { shield_left: false, shield_right: false, radar_pulse: false, ping_lane: null };

function crossingBranch(fromLeft: boolean, y: number): ObstacleEntity {
  return {
    id: 'cross-test',
    type: 'flank_cross',
    lane: fromLeft ? 0 : 2,
    x: fromLeft ? TRACK_CONFIG.ROAD_LEFT - 25 : TRACK_CONFIG.ROAD_RIGHT + 25,
    y,
    width: 38,
    height: 38,
    vx: 0,
    vy: 75,
    side_threat: fromLeft ? 'left' : 'right',
    crossing: false
  };
}

/** Moves the vehicle to the far right lane (driver holding right). */
function driveToRightLane(sim: GameSimulation) {
  for (let i = 0; i < 60; i++) {
    sim.applyPlayerInput({ player_id: 'd', role: 'driver', input_vector: { x: 1, y: 0 }, action_flags: NO_FLAGS, timestamp: 0, seq: i });
    sim.step(DT);
  }
  sim.applyPlayerInput({ player_id: 'd', role: 'driver', input_vector: { x: 0, y: 0 }, action_flags: NO_FLAGS, timestamp: 0, seq: 99 });
}

function runUntilGone(sim: GameSimulation, maxTicks = 240) {
  for (let i = 0; i < maxTicks; i++) {
    const p = sim.step(DT);
    if (!p.entity_positions.obstacles.some((o) => o.id === 'cross-test')) return p;
  }
  return sim.getWorldStatePayload();
}

describe('Crossing branch (rama cruzada)', () => {
  it('sweeps across the whole road and hits the vehicle even in the far lane', () => {
    const sim = new GameSimulation(false);
    sim.startMatch(1);
    driveToRightLane(sim);
    const mecha = sim.getMechaPosition();
    expect(mecha.x).toBeGreaterThan(TRACK_CONFIG.ROAD_RIGHT - 80); // far from the left edge
    sim.spawnObstacleForTest(crossingBranch(true, mecha.y - 60));
    const after = runUntilGone(sim);
    expect(after.world_state.integrity).toBe(65); // 100 - 35
  });

  it('is blocked by the shield on the side it comes from', () => {
    const sim = new GameSimulation(false);
    sim.startMatch(1);
    driveToRightLane(sim);
    const mecha = sim.getMechaPosition();
    sim.applyPlayerInput({ player_id: 'n', role: 'navigator', input_vector: { x: 0, y: 0 }, action_flags: { ...NO_FLAGS, shield_left: true }, timestamp: 0, seq: 1 });
    sim.spawnObstacleForTest(crossingBranch(true, mecha.y - 60));
    const after = runUntilGone(sim);
    expect(after.world_state.integrity).toBe(100);
    expect(after.world_state.events.some((e) => e.type === 'shield_deflect')).toBe(true);
  });

  it('the opposite shield does not stop it', () => {
    const sim = new GameSimulation(false);
    sim.startMatch(1);
    const mecha = sim.getMechaPosition();
    sim.applyPlayerInput({ player_id: 'n', role: 'navigator', input_vector: { x: 0, y: 0 }, action_flags: { ...NO_FLAGS, shield_left: true }, timestamp: 0, seq: 1 });
    sim.spawnObstacleForTest(crossingBranch(false, mecha.y - 60)); // comes from the right
    const after = runUntilGone(sim);
    expect(after.world_state.integrity).toBe(65);
  });

  it('the AI navigator blocks it on its own', () => {
    const sim = new GameSimulation(false);
    sim.startMatch(1);
    const mecha = sim.getMechaPosition();
    sim.spawnObstacleForTest(crossingBranch(false, mecha.y - 150));
    let p = sim.getWorldStatePayload();
    for (let i = 0; i < 240 && p.entity_positions.obstacles.some((o) => o.id === 'cross-test'); i++) {
      sim.updateBotCoPilot('navigator');
      p = sim.step(DT);
    }
    expect(p.world_state.integrity).toBe(100);
  });

  it('online smoothing moves it exactly like the simulation', () => {
    const sim = new GameSimulation(false);
    sim.startMatch(1);
    driveToRightLane(sim);
    const mecha = sim.getMechaPosition();
    sim.spawnObstacleForTest(crossingBranch(true, mecha.y - 8));
    // Let it start crossing, then compare 4 ticks of extrapolation with 4 real ticks
    let state = sim.step(DT);
    for (let i = 0; i < 2; i++) state = sim.step(DT);
    const predicted = extrapolateWorld(state, 4 / 60).entity_positions.obstacles.find((o) => o.id === 'cross-test')!;
    let later = state;
    for (let i = 0; i < 4; i++) later = sim.step(DT);
    const actual = later.entity_positions.obstacles.find((o) => o.id === 'cross-test')!;
    expect(actual.crossing).toBe(true);
    expect(Math.abs(actual.x - predicted.x)).toBeLessThan(2);
    expect(Math.abs(actual.y - predicted.y)).toBeLessThan(2);
  });
});

describe('Crossing branch on the generated tracks', () => {
  const layouts = Array.from({ length: 200 }, (_, i) => GameSimulation.generateTrackLayout(i + 1, 6000));

  it('never appears before the Storm phase (800 m), and does appear later', () => {
    let total = 0;
    for (const layout of layouts) {
      for (const wave of layout) {
        const crosses = wave.obstacles.filter((o) => o.type === 'flank_cross').length;
        if (wave.meter < 800) expect(crosses).toBe(0);
        total += crosses;
      }
    }
    expect(total).toBeGreaterThan(500);
  });

  it('never comes within the heavy-flank gap of another crossing branch or flank pair', () => {
    for (const layout of layouts) {
      let lastHeavy = -Infinity;
      for (const wave of layout) {
        const flanks = wave.obstacles.filter((o) => o.type === 'flank_left' || o.type === 'flank_right').length;
        const heavy = wave.obstacles.some((o) => o.type === 'flank_cross') || flanks === 2;
        if (heavy) {
          expect(wave.meter - lastHeavy).toBeGreaterThanOrEqual(TRACK_RULES.HEAVY_FLANK_GAP);
          lastHeavy = wave.meter;
        }
      }
    }
  });

  it('never lands right after a double barrier', () => {
    for (const layout of layouts) {
      let lastDouble = -Infinity;
      for (const wave of layout) {
        const barriers = wave.obstacles.filter((o) => o.type === 'barrier').length;
        if (barriers === 2) lastDouble = wave.meter;
        if (wave.obstacles.some((o) => o.type === 'flank_cross')) {
          expect(wave.meter - lastDouble).toBeGreaterThanOrEqual(TRACK_RULES.CROSS_AFTER_DOUBLE_BARRIER_GAP);
        }
      }
    }
  });
});
