import { describe, expect, it } from 'vitest';
import { DIFFICULTY_PHASES } from '../../shared/rules.js';
import {
  animalAt,
  animalsBetween,
  foodKgFromUsd,
  RESCUE_EVERY_METERS,
  rescuedCount,
  weatherForPhase
} from '../rescueTheme.js';

describe('Rescue theme helpers', () => {
  it('counts one rescued animal every RESCUE_EVERY_METERS meters', () => {
    expect(rescuedCount(0)).toBe(0);
    expect(rescuedCount(RESCUE_EVERY_METERS - 0.1)).toBe(0);
    expect(rescuedCount(RESCUE_EVERY_METERS)).toBe(1);
    expect(rescuedCount(RESCUE_EVERY_METERS * 10 + 5)).toBe(10);
    expect(rescuedCount(-50)).toBe(0);
  });

  it('each animal always looks the same (same kind and side for every player)', () => {
    for (let i = 0; i < 50; i++) {
      expect(animalAt(i)).toEqual(animalAt(i));
      expect(animalAt(i).meter).toBe((i + 1) * RESCUE_EVERY_METERS);
    }
    const sides = new Set(Array.from({ length: 50 }, (_, i) => animalAt(i).side));
    expect(sides.size).toBe(2);
  });

  it('lists the animals inside a meter window', () => {
    const list = animalsBetween(100, 400);
    expect(list.map((a) => a.meter)).toEqual([120, 240, 360]);
    expect(animalsBetween(0, 50)).toEqual([]);
  });

  it('every difficulty phase has its own weather', () => {
    const labels = new Set(DIFFICULTY_PHASES.map((p) => weatherForPhase(p.name).label));
    expect(labels.size).toBe(DIFFICULTY_PHASES.length);
    expect(weatherForPhase('Tormenta').lightning).toBe(true);
    expect(weatherForPhase('Leyenda').rainbow).toBe(true);
    expect(weatherForPhase(undefined).label).toBe('Atardecer');
  });

  it('translates the charity pool into kg of food', () => {
    expect(foodKgFromUsd(0)).toBe(0);
    expect(foodKgFromUsd(120)).toBeGreaterThan(0);
  });
});
