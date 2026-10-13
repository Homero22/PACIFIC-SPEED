import { clamp } from './math.js';

export const GAMEPLAY_CONSTANTS = {
  TICK_RATE: 60,
  FIXED_DT: 1 / 60,

  // Speed mechanic specification
  BASE_SPEED: 100,
  MAX_SPEED: 250,
  CRITICAL_SPEED_THRESHOLD: 50,
  SELF_DESTRUCT_COUNTDOWN_SECONDS: 3.0,
  ACCELERATION_COEFFICIENT: 0.045,
  THROTTLE_SPEED_BONUS: 65,
  BRAKE_SPEED_PENALTY: 75,
  COLLISION_SPEED_PENALTY: 65,
  PENALTY_RECOVERY_PER_SECOND: 28,

  // Scoring system specification
  DISTANCE_POINTS: 10,
  SURVIVAL_BONUS_PER_SECOND: 50,
  OVERDRIVE_MULTIPLIER: 2.0,
  OVERDRIVE_DURATION_SECONDS: 6.0,

  // Health & damage specification
  MAX_INTEGRITY: 100,
  OBSTACLE_COLLISION_DAMAGE: 35,
  REPAIR_CELL_BONUS: 25,

  // Shield & Radar energy
  MAX_SHIELD_ENERGY: 100,
  SHIELD_DRAIN_PER_SECOND: 38,
  SHIELD_RECHARGE_PER_SECOND: 24,
  RADAR_PULSE_COST: 25,
  RADAR_REVEAL_DURATION: 3.2,

  // Driver Fog of War
  BASE_VISIBILITY_RADIUS: 185,
  OVERDRIVE_VISIBILITY_RADIUS: 240,
  RADAR_PULSE_VISIBILITY_RADIUS: 420
} as const;

/**
 * Computes current vehicle speed strictly following the specification formula:
 * speed = base_speed + (distance_traveled * acceleration_coefficient) - (collision_penalty)
 * plus active driver throttle adjustment, clamped to [0, max_speed].
 */
export function computeVehicleSpeed(
  distanceTraveled: number,
  collisionPenalty: number,
  throttleInput = 0,
  baseSpeed: number = GAMEPLAY_CONSTANTS.BASE_SPEED,
  maxSpeed: number = GAMEPLAY_CONSTANTS.MAX_SPEED,
  accelerationCoefficient: number = GAMEPLAY_CONSTANTS.ACCELERATION_COEFFICIENT
): number {
  const throttleDelta =
    throttleInput >= 0
      ? throttleInput * GAMEPLAY_CONSTANTS.THROTTLE_SPEED_BONUS
      : throttleInput * GAMEPLAY_CONSTANTS.BRAKE_SPEED_PENALTY;

  const rawSpeed =
    baseSpeed +
    distanceTraveled * accelerationCoefficient -
    collisionPenalty +
    throttleDelta;

  return clamp(rawSpeed, 0, maxSpeed);
}

/**
 * Updates self-destruct countdown timer based on critical speed threshold (< 50).
 * Resets to null as soon as speed recovers at or above the threshold.
 */
export function updateSelfDestructCountdown(
  currentSpeed: number,
  currentTimer: number | null,
  dt: number
): { timer: number | null; exploded: boolean } {
  if (currentSpeed < GAMEPLAY_CONSTANTS.CRITICAL_SPEED_THRESHOLD) {
    const startTimer =
      currentTimer === null ? GAMEPLAY_CONSTANTS.SELF_DESTRUCT_COUNTDOWN_SECONDS : currentTimer;
    const nextTimer = Math.max(0, startTimer - dt);
    return {
      timer: nextTimer,
      exploded: nextTimer <= 0
    };
  }
  return {
    timer: null,
    exploded: false
  };
}

/**
 * Computes total score strictly following the specification formula:
 * total_score = (distance * 10) + (survival_time * 50) * (is_overdrive ? 2.0 : 1.0)
 */
export function computeTotalScore(
  distanceTraveled: number,
  survivalTimeSeconds: number,
  isOverdrive: boolean
): number {
  const multiplier = isOverdrive ? GAMEPLAY_CONSTANTS.OVERDRIVE_MULTIPLIER : 1.0;
  const rawScore =
    distanceTraveled * GAMEPLAY_CONSTANTS.DISTANCE_POINTS +
    survivalTimeSeconds * GAMEPLAY_CONSTANTS.SURVIVAL_BONUS_PER_SECOND * multiplier;
  return Math.floor(rawScore);
}

/**
 * Evaluates collision damage considering active flank shields.
 * Shield absorption negates 100% of damage on the corresponding side if active.
 */
export function computeCollisionDamage(
  sideThreat: 'left' | 'right' | undefined,
  activeShields: { left: boolean; right: boolean }
): { damage: number; deflected: boolean } {
  if (sideThreat === 'left' && activeShields.left) {
    return { damage: 0, deflected: true };
  }
  if (sideThreat === 'right' && activeShields.right) {
    return { damage: 0, deflected: true };
  }
  if (sideThreat === undefined && activeShields.left && activeShields.right) {
    // Dual front barrier deflection when both flank shields are synchronized
    return { damage: 0, deflected: true };
  }
  return {
    damage: GAMEPLAY_CONSTANTS.OBSTACLE_COLLISION_DAMAGE,
    deflected: false
  };
}
