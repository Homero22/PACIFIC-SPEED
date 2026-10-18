import { describe, expect, it } from 'vitest';
import { GameSimulation } from '../simulation.js';

const DT = 1 / 60;

/** Plays with both AI co-pilots and records every radar activation (tick and energy left). */
function playWithBots(seed: number, seconds: number) {
  const sim = new GameSimulation(false);
  sim.startMatch(seed);
  const activations: Array<{ tick: number; energyAfter: number }> = [];
  let lastTimer = 0;
  for (let tick = 0; tick < seconds * 60; tick++) {
    sim.updateBotCoPilot('driver');
    sim.updateBotCoPilot('navigator');
    const p = sim.step(DT);
    if (p.world_state.status !== 'running') break;
    const timer = p.fog_matrix.radar_reveal_timer;
    if (timer > lastTimer + 0.5) activations.push({ tick, energyAfter: p.world_state.active_shields.energy });
    lastTimer = timer;
  }
  return activations;
}

describe('AI navigator radar', () => {
  it('uses the radar sometimes during a match', () => {
    const total = [1, 2, 3, 4, 5].reduce((n, seed) => n + playWithBots(seed, 90).length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('waits at least 6 s between pulses and never drains the shield below 45%', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const acts = playWithBots(seed, 90);
      for (let i = 0; i < acts.length; i++) {
        expect(acts[i].energyAfter).toBeGreaterThanOrEqual(45);
        if (i > 0) expect(acts[i].tick - acts[i - 1].tick).toBeGreaterThanOrEqual(360);
      }
    }
  });
});
