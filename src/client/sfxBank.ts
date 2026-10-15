/** Efectos grabados (ElevenLabs) generados por scripts/generate-sfx.mjs. */
export type SfxId =
  | 'amb_tension_low'
  | 'amb_tension_high'
  | 'impact_light'
  | 'impact_medium'
  | 'impact_heavy'
  | 'dmg_sparks'
  | 'dmg_critical'
  | 'shield_double'
  | 'shield_up'
  | 'shield_deflect'
  | 'destroy_metal'
  | 'repair'
  | 'turbo'
  | 'radar_ping'
  | 'reward_rescue';

const SFX_MANIFEST_URL = '/assets/sfx/manifest.json';

interface SfxManifest {
  sounds?: Partial<Record<SfxId, { files: string[]; loop?: boolean }>>;
}

/**
 * Carga public/assets/sfx/manifest.json y decodifica todas las variantes. Solo se piden los archivos
 * que lista el manifiesto, así que un efecto aún no generado no produce 404: simplemente no está
 * (`has()` devuelve false) y el motor usa su versión sintetizada.
 */
export class SfxBank {
  private buffers = new Map<SfxId, AudioBuffer[]>();
  private lastVariant = new Map<SfxId, number>();
  private loading: Promise<void> | null = null;

  constructor(private readonly ctx: AudioContext) {}

  public load(): Promise<void> {
    if (!this.loading) this.loading = this.loadAll();
    return this.loading;
  }

  private async loadAll(): Promise<void> {
    let manifest: SfxManifest = {};
    try {
      const res = await fetch(SFX_MANIFEST_URL);
      if (res.ok) manifest = (await res.json()) as SfxManifest;
    } catch {
      return;
    }
    const entries = Object.entries(manifest.sounds ?? {}) as Array<[SfxId, { files: string[] }]>;
    await Promise.all(
      entries.map(async ([id, entry]) => {
        const decoded = await Promise.all(
          entry.files.map(async (file) => {
            try {
              const res = await fetch(`/assets/sfx/${file}`);
              if (!res.ok) return null;
              return await this.ctx.decodeAudioData(await res.arrayBuffer());
            } catch {
              return null;
            }
          })
        );
        const usable = decoded.filter((b): b is AudioBuffer => b !== null);
        if (usable.length > 0) this.buffers.set(id, usable);
      })
    );
  }

  public has(id: SfxId): boolean {
    return (this.buffers.get(id)?.length ?? 0) > 0;
  }

  /** Variante al azar sin repetir la última. */
  public pick(id: SfxId): AudioBuffer | null {
    const variants = this.buffers.get(id);
    if (!variants || variants.length === 0) return null;
    const last = this.lastVariant.get(id) ?? -1;
    let idx = Math.floor(Math.random() * variants.length);
    if (variants.length > 1 && idx === last) {
      idx = (idx + 1 + Math.floor(Math.random() * (variants.length - 1))) % variants.length;
    }
    this.lastVariant.set(id, idx);
    return variants[idx];
  }

  /** Diagnóstico: efectos cargados y número de variantes. */
  public loaded(): Record<string, number> {
    return Object.fromEntries([...this.buffers].map(([id, list]) => [id, list.length]));
  }
}
