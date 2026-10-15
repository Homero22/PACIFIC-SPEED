import { describe, expect, it } from 'vitest';
import { GameSimulation } from './simulation.js';

type SimInternals = {
  navigatorFlags: { shield_left: boolean; shield_right: boolean };
  recentEvents: Array<{ type: string; pan?: number; intensity?: number }>;
  obstacles: Array<Record<string, unknown>>;
  mechaX: number;
  mechaY: number;
};

const internals = (sim: GameSimulation) => sim as unknown as SimInternals;
const eventTypes = (sim: GameSimulation) => internals(sim).recentEvents.map((e) => e.type);

function startedSim(): GameSimulation {
  const sim = new GameSimulation();
  sim.startMatch();
  return sim;
}

describe('eventos de sonido de la simulación', () => {
  it('emite shield_double una vez al activar ambos escudos', () => {
    const sim = startedSim();
    const s = internals(sim);
    s.navigatorFlags.shield_left = true;
    s.navigatorFlags.shield_right = true;
    sim.step();
    sim.step();
    expect(eventTypes(sim).filter((t) => t === 'shield_double')).toHaveLength(1);
  });

  it('emite shield_up al activar un solo escudo, con pan del lado activo', () => {
    const sim = startedSim();
    internals(sim).navigatorFlags.shield_left = true;
    sim.step();
    const ev = internals(sim).recentEvents.find((e) => e.type === 'shield_up');
    expect(ev?.pan).toBeLessThan(0);
  });

  it('la celda de reparación emite repair_collected, no el turbo', () => {
    const sim = startedSim();
    const s = internals(sim);
    s.obstacles.push({
      id: 'r1', type: 'repair_cell', lane: 1, x: s.mechaX, y: s.mechaY,
      width: 42, height: 42, vx: 0, vy: 0
    });
    sim.step();
    expect(eventTypes(sim)).toContain('repair_collected');
    expect(eventTypes(sim)).not.toContain('overdrive_activated');
  });

  it('el choque lleva intensidad según el daño y pan según el lado', () => {
    const sim = startedSim();
    const s = internals(sim);
    s.obstacles.push({
      id: 'b1', type: 'barrier', lane: 1, x: s.mechaX + 30, y: s.mechaY,
      width: 96, height: 34, vx: 0, vy: 0
    });
    sim.step();
    const ev = s.recentEvents.find((e) => e.type === 'collision_damage');
    expect(ev?.intensity).toBeGreaterThan(0);
    expect(ev?.intensity).toBeLessThanOrEqual(1);
    expect(ev?.pan).toBeGreaterThan(0);
  });
});
