import { describe, expect, it } from 'vitest';
import { checkAABB, checkCircleToLine, clampVector } from '../math.js';
import {
  computeCollisionDamage,
  computeScoreIncrement,
  computeVehicleSpeed,
  GAMEPLAY_CONSTANTS,
  updateSelfDestructCountdown
} from '../rules.js';
import { GameSimulation } from '../simulation.js';

describe('PACIFIC SPEED: OVERDRIVE - Core Rules & Math Engine', () => {
  it('calculates vehicle speed using the exact formula and clamps between 0 and max_speed (250)', () => {
    const speedAtStart = computeVehicleSpeed(0, 0, 0);
    expect(speedAtStart).toBe(GAMEPLAY_CONSTANTS.BASE_SPEED); // 100

    const speedWithDistance = computeVehicleSpeed(1000, 15, 0, 100, 250, 0.05);
    // 100 + (1000 * 0.05) - 15 = 135
    expect(speedWithDistance).toBe(135);

    const clampedMax = computeVehicleSpeed(10000, 0, 1);
    expect(clampedMax).toBe(GAMEPLAY_CONSTANTS.MAX_SPEED); // 250
  });

  it('triggers 3.0s self-destruct countdown when speed drops below critical threshold (50)', () => {
    const step1 = updateSelfDestructCountdown(42, null, 1.0);
    expect(step1.timer).toBeCloseTo(2.0);
    expect(step1.exploded).toBe(false);

    const step2 = updateSelfDestructCountdown(40, step1.timer, 2.0);
    expect(step2.timer).toBe(0);
    expect(step2.exploded).toBe(true);

    // Resets immediately if speed recovers >= 50
    const recovered = updateSelfDestructCountdown(85, 1.2, 0.5);
    expect(recovered.timer).toBeNull();
    expect(recovered.exploded).toBe(false);
  });

  it('scores per tick: Overdrive (2.0x) only doubles survival points earned while active', () => {
    // Δscore = Δdistance * 10 + Δt * 50 * (is_overdrive ? 2.0 : 1.0)
    expect(computeScoreIncrement(12, 1, false)).toBe(12 * 10 + 1 * 50); // 170
    expect(computeScoreIncrement(12, 1, true)).toBe(12 * 10 + 1 * 50 * 2); // 220
    expect(computeScoreIncrement(-5, -1, true)).toBe(0); // never negative
  });

  it('negates 100% of collision damage when corresponding flank shield is active', () => {
    const unshieldedLeft = computeCollisionDamage('left', { left: false, right: true });
    expect(unshieldedLeft.damage).toBe(35);
    expect(unshieldedLeft.deflected).toBe(false);

    const shieldedLeft = computeCollisionDamage('left', { left: true, right: false });
    expect(shieldedLeft.damage).toBe(0);
    expect(shieldedLeft.deflected).toBe(true);

    const shieldedRight = computeCollisionDamage('right', { left: false, right: true });
    expect(shieldedRight.damage).toBe(0);
    expect(shieldedRight.deflected).toBe(true);
  });

  it('performs accurate AABB and Circle-to-Line collision checks', () => {
    const boxA = { x: 100, y: 100, width: 50, height: 50 };
    const boxB = { x: 120, y: 130, width: 40, height: 40 };
    const boxC = { x: 300, y: 300, width: 40, height: 40 };

    expect(checkAABB(boxA, boxB)).toBe(true);
    expect(checkAABB(boxA, boxC)).toBe(false);

    const circle = { x: 255, y: 700, radius: 20 };
    const shieldStart = { x: 245, y: 660 };
    const shieldEnd = { x: 245, y: 740 };
    expect(checkCircleToLine(circle, shieldStart, shieldEnd)).toBe(true);

    const farCircle = { x: 180, y: 700, radius: 20 };
    expect(checkCircleToLine(farCircle, shieldStart, shieldEnd)).toBe(false);

    const clamped = clampVector({ x: 300, y: 400 }, 250);
    expect(Math.hypot(clamped.x, clamped.y)).toBeCloseTo(250);
  });

  it('supports Rewarded Ad revival restoring 100% integrity and resetting self-destruct timer', () => {
    const sim = new GameSimulation(true);
    sim.forcePenaltyForTest(90, 20);

    const stateBefore = sim.getWorldStatePayload();
    sim.spawnObstacleForTest({
      id: 'test-barrier',
      type: 'barrier',
      lane: 1,
      x: stateBefore.entity_positions.mecha.x,
      y: stateBefore.entity_positions.mecha.y,
      width: 80,
      height: 40,
      vx: 0,
      vy: 0
    });

    const afterHit = sim.step(1 / 60);
    expect(afterHit.world_state.integrity).toBe(0);
    expect(afterHit.world_state.status).toBe('ad_revive_prompt');

    const revived = sim.reviveWithRewardedAd();
    expect(revived).toBe(true);

    const afterRevive = sim.getWorldStatePayload();
    expect(afterRevive.world_state.status).toBe('running');
    expect(afterRevive.world_state.integrity).toBe(100);
    expect(afterRevive.world_state.self_destruct_timer).toBeNull();
  });
});
