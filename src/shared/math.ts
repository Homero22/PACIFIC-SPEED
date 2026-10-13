import type { Circle, LaneIndex, Rect, Vec2 } from './types.js';

/**
 * Axis-Aligned Bounding Box (AABB) collision check.
 * Minimizes CPU overhead with zero heap allocations.
 */
export function checkAABB(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * Squared distance from point (px, py) to line segment (x1, y1)-(x2, y2).
 */
export function pointToSegmentDistanceSq(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    const ex = px - x1;
    const ey = py - y1;
    return ex * ex + ey * ey;
  }

  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;

  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  const distX = px - projX;
  const distY = py - projY;
  return distX * distX + distY * distY;
}

/**
 * Circle-to-Line segment collision detection.
 * Used for checking flank shield energy barriers against incoming lateral hazards.
 */
export function checkCircleToLine(circle: Circle, lineStart: Vec2, lineEnd: Vec2): boolean {
  const distSq = pointToSegmentDistanceSq(
    circle.x,
    circle.y,
    lineStart.x,
    lineStart.y,
    lineEnd.x,
    lineEnd.y
  );
  return distSq <= circle.radius * circle.radius;
}

/**
 * Clamps a numeric scalar between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Clamps a 2D velocity vector to a maximum magnitude.
 */
export function clampVector(v: Vec2, maxMagnitude: number): Vec2 {
  const magSq = v.x * v.x + v.y * v.y;
  if (magSq <= maxMagnitude * maxMagnitude || magSq === 0) {
    return { x: v.x, y: v.y };
  }
  const scale = maxMagnitude / Math.sqrt(magSq);
  return {
    x: v.x * scale,
    y: v.y * scale
  };
}

/**
 * Linear interpolation helper for Client-Side Prediction smoothing.
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

/**
 * Track geometry constants (virtual coordinate space: 600x900).
 */
export const TRACK_CONFIG = {
  WORLD_WIDTH: 600,
  WORLD_HEIGHT: 900,
  ROAD_LEFT: 90,
  ROAD_RIGHT: 510,
  ROAD_WIDTH: 420,
  LANE_COUNT: 3,
  LANE_WIDTH: 140,
  MECHA_DEFAULT_Y: 720,
  MECHA_MIN_Y: 520,
  MECHA_MAX_Y: 810,
  MECHA_WIDTH: 56,
  MECHA_HEIGHT: 76,
  MECHA_RADIUS: 34,
  SHIELD_OFFSET_X: 44,
  SHIELD_HALF_HEIGHT: 52
} as const;

export function getLaneCenterX(lane: LaneIndex): number {
  return TRACK_CONFIG.ROAD_LEFT + TRACK_CONFIG.LANE_WIDTH * lane + TRACK_CONFIG.LANE_WIDTH * 0.5;
}

export function getClosestLane(x: number): LaneIndex {
  const rel = x - TRACK_CONFIG.ROAD_LEFT;
  const idx = Math.floor(rel / TRACK_CONFIG.LANE_WIDTH);
  if (idx <= 0) return 0;
  if (idx >= 2) return 2;
  return 1;
}
