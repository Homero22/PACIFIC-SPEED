/**
 * Deterministic pseudo-random numbers for the track generator. The same seed always
 * produces the same sequence, so every tournament pair can race the same track.
 */

/** mulberry32: tiny, fast 32-bit PRNG returning floats in [0, 1). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash: turns an id (e.g. a tournament id) into a stable seed. */
export function seedFromString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Fresh seed for practice matches (different track every time). */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

/** Seed of the official track of a tournament: identical for every registered pair. */
export function tournamentTrackSeed(tournamentId: string): number {
  return seedFromString(`pacific-speed-track:${tournamentId}`);
}
