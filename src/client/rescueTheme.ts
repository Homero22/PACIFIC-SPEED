/**
 * "Patrulla de Rescate" visual theme: pure helpers shared by the renderer and the HUD.
 * Presentation only — nothing here changes gameplay, score or payments.
 */

/** One animal waits on the roadside every this many meters; passing it counts it as rescued. */
export const RESCUE_EVERY_METERS = 120;

/**
 * Estimated cost of 1 kg of pet food in USD, used only to translate the charity pool into
 * something tangible ("≈ 60 kg de alimento"). Replace with the shelter's real figure.
 */
export const FOOD_USD_PER_KG = 2;

export type AnimalKind = 'perrito' | 'gatito' | 'conejito' | 'cachorro';

export interface RoadsideAnimal {
  index: number;
  meter: number;
  kind: AnimalKind;
  side: 'left' | 'right';
}

const ANIMAL_KINDS: AnimalKind[] = ['perrito', 'gatito', 'cachorro', 'perrito', 'gatito', 'conejito'];

/** Animals rescued after covering `distance` meters (same for both players: it only depends on distance). */
export function rescuedCount(distance: number): number {
  return Math.max(0, Math.floor(distance / RESCUE_EVERY_METERS));
}

/** Small integer hash so each animal always looks the same for every player. */
function hashIndex(i: number): number {
  let h = Math.imul(i + 1, 0x9e3779b1) >>> 0;
  h ^= h >>> 15;
  return Math.imul(h, 0x85ebca6b) >>> 0;
}

export function animalAt(index: number): RoadsideAnimal {
  const h = hashIndex(index);
  return {
    index,
    meter: (index + 1) * RESCUE_EVERY_METERS,
    kind: ANIMAL_KINDS[h % ANIMAL_KINDS.length],
    side: (h >>> 8) % 2 === 0 ? 'left' : 'right'
  };
}

/** Animals whose roadside spot lies between `fromMeter` and `toMeter`. */
export function animalsBetween(fromMeter: number, toMeter: number): RoadsideAnimal[] {
  const first = Math.max(0, Math.ceil(fromMeter / RESCUE_EVERY_METERS) - 1);
  const last = Math.floor(toMeter / RESCUE_EVERY_METERS) - 1;
  const out: RoadsideAnimal[] = [];
  for (let i = first; i <= last; i++) {
    const a = animalAt(i);
    if (a.meter >= fromMeter && a.meter <= toMeter) out.push(a);
  }
  return out;
}

export function foodKgFromUsd(usd: number): number {
  return Math.max(0, Math.floor(usd / FOOD_USD_PER_KG));
}

export interface WeatherLook {
  /** Shown to players. */
  label: string;
  /** Full-screen color grade over the road. */
  tint: string;
  /** 0..1 share of raindrops drawn. */
  rain: number;
  lightning: boolean;
  rainbow: boolean;
  /** Color of roadside lamps / verge glow. */
  lampColor: string;
}

/**
 * The weather follows the difficulty phase, so the difficulty is also visible:
 * sunset → rain → storm → deep night → dawn with a rainbow for those who get that far.
 */
export function weatherForPhase(phase: string | undefined): WeatherLook {
  switch (phase) {
    case 'Patrulla':
      return { label: 'Lluvia', tint: 'rgba(40, 70, 110, 0.18)', rain: 0.6, lightning: false, rainbow: false, lampColor: '#ffd29a' };
    case 'Tormenta':
      return { label: 'Tormenta', tint: 'rgba(20, 30, 60, 0.28)', rain: 1, lightning: true, rainbow: false, lampColor: '#ffe3b8' };
    case 'Rescate final':
      return { label: 'Noche cerrada', tint: 'rgba(5, 8, 22, 0.38)', rain: 0.8, lightning: true, rainbow: false, lampColor: '#ffb86b' };
    case 'Leyenda':
      return { label: 'Amanecer', tint: 'rgba(255, 170, 120, 0.14)', rain: 0.12, lightning: false, rainbow: true, lampColor: '#fff1d6' };
    case 'Respiro':
      return { label: 'Claro entre nubes', tint: 'rgba(255, 190, 120, 0.10)', rain: 0.2, lightning: false, rainbow: false, lampColor: '#ffd29a' };
    case 'Calentamiento':
    default:
      return { label: 'Atardecer', tint: 'rgba(255, 140, 70, 0.14)', rain: 0.25, lightning: false, rainbow: false, lampColor: '#ffc27a' };
  }
}
