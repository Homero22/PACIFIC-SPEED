import type { SoundEventType, TacticalCommsPreset } from '../shared/types.js';
import { SfxBank, type SfxId } from './sfxBank.js';

export type VoiceCueId =
  | 'athena_online'
  | 'athena_stall'
  | 'athena_overdrive'
  | 'athena_breach'
  | 'athena_revive'
  | 'athena_eject'
  | 'cmd_bogey'
  | 'cmd_intercept'
  | 'cmd_double_streak'
  | 'cmd_unstoppable'
  | 'cmd_close_call'
  | 'cmd_overdrive'
  | 'cmd_mayday'
  | 'cmd_milestone'
  | 'social_food'
  | 'social_shelter'
  | 'social_team'
  | 'social_thanks';

/** es = voz natural limpia, es_radio = filtro de radio suave, off = sin narrador. */
export type VoiceMode = 'es' | 'es_radio' | 'off';

const VOICE_MODE_STORAGE_KEY = 'ps_voice_mode';
const VOICE_MANIFEST_URL = '/assets/voice/manifest.json';

const SOCIAL_CUES: VoiceCueId[] = ['social_food', 'social_shelter', 'social_team', 'social_thanks'];

/** Narrador que interpreta cada cue (los athena_* son la guía, el resto el capitán). */
const GUIA_CUES = new Set<VoiceCueId>([
  'athena_online',
  'athena_stall',
  'athena_overdrive',
  'athena_breach',
  'athena_revive',
  'athena_eject',
  'social_food',
  'social_shelter',
  'social_thanks'
]);

// Mezcla mientras habla el narrador (1 = sin cambio)
const DUCK_TURBINE = 0.35;
const DUCK_SFX = 0.7;
const DUCK_MUSIC = 0.4;
const DUCK_AMBIENCE = 0.5;

// Anti-solapamiento de voces
const VOICE_GAP_MS = 1600; // silencio mínimo tras una voz antes de otra no prioritaria
const PRIORITY_MIN_PLAY_MS = 900; // una prioritaria no corta a otra que lleva menos de esto
const SAME_CUE_COOLDOWN_MS = 4000;

const ALL_VOICE_CUES: VoiceCueId[] = [
  'athena_online',
  'athena_stall',
  'athena_overdrive',
  'athena_breach',
  'athena_revive',
  'athena_eject',
  'cmd_bogey',
  'cmd_intercept',
  'cmd_double_streak',
  'cmd_unstoppable',
  'cmd_close_call',
  'cmd_overdrive',
  'cmd_mayday',
  'cmd_milestone',
  ...SOCIAL_CUES
];

function loadStoredVoiceMode(): VoiceMode {
  try {
    const stored = localStorage.getItem(VOICE_MODE_STORAGE_KEY);
    if (stored === 'es' || stored === 'es_radio' || stored === 'off') return stored;
  } catch {
    // Storage bloqueado: usar el valor por defecto
  }
  return 'es';
}

/**
 * Motor de audio procedural + narrador "Patrulla de Rescate" (voces en español).
 * - Banco de voces con variantes (manifest.json) elegidas al azar sin repetir la última
 * - Ducking de motor, efectos y música mientras habla el narrador
 * - Filtro de radio opcional y suave (modo es_radio)
 * - Cooldowns para que las voces no se encimen
 * - MediaStreamAudioDestinationNode para que los clips 9:16 incluyan el audio
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private turbineDuckGain: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private ambienceBus: GainNode | null = null;
  private voiceBus: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private reverbNode: ConvolverNode | null = null;
  private reverbSendGain: GainNode | null = null;
  private recordDestination: MediaStreamAudioDestinationNode | null = null;

  private isMuted = false;
  private voiceMode: VoiceMode = loadStoredVoiceMode();

  // Banco de voces precargado: cada cue tiene 1..N variantes
  private voiceBuffers = new Map<VoiceCueId, AudioBuffer[]>();
  private lastVariant = new Map<VoiceCueId, number>();
  private lastCueTime = new Map<VoiceCueId, number>();
  private loadingVoices = false;
  private activeVoiceSource: AudioBufferSourceNode | null = null;
  private activeStaticSource: AudioBufferSourceNode | null = null;
  private activeVoiceStartedAt = 0;
  private lastVoiceEndedAt = 0;
  private nextSocialCueAt = 0;

  // 3-Layer Jet Turbine nodes
  private subRotorOsc: OscillatorNode | null = null;
  private subRotorGain: GainNode | null = null;

  private spoolOsc: OscillatorNode | null = null;
  private spoolGain: GainNode | null = null;

  private jetNoiseSource: AudioBufferSourceNode | null = null;
  private jetNoiseFilter: BiquadFilterNode | null = null;
  private jetNoiseGain: GainNode | null = null;

  // Critical speed (< 50) 2Hz warning alarm & Hype streak tracking
  private alarmActive = false;
  private nextAlarmPulseTime = 0;
  private shieldStreak = 0;
  private processedEventIds = new Set<string>();

  // Efectos grabados (ElevenLabs) y capas en loop de tensión/daño
  private sfx: SfxBank | null = null;
  private loops = new Map<SfxId, { src: AudioBufferSourceNode; gain: GainNode }>();
  private silenceUntil = 0; // silencio dramático tras la destrucción (tiempo del AudioContext)

  public init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      if (!this.loadingVoices && this.voiceBuffers.size === 0) {
        void this.preloadNeuralVoiceBank();
      }
      return;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AudioCtx();

    // Master Compressor & Gain Bus
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -16;
    this.compressor.knee.value = 18;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.18;

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.88;

    // Ducking bus for engine turbine (ducks down when Narrator speaks)
    this.turbineDuckGain = this.ctx.createGain();
    this.turbineDuckGain.gain.value = 1.0;
    this.turbineDuckGain.connect(this.compressor);

    // Buses de efectos, música (reservado) y voz; efectos y música se atenúan cuando habla el narrador
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.connect(this.compressor);
    this.musicBus = this.ctx.createGain();
    this.musicBus.connect(this.compressor);
    this.voiceBus = this.ctx.createGain();
    this.voiceBus.connect(this.compressor);
    this.ambienceBus = this.ctx.createGain();
    this.ambienceBus.connect(this.compressor);

    // Spatial Acoustic Reverb (Metallic Canyon / Cockpit Impulse)
    this.reverbNode = this.ctx.createConvolver();
    this.reverbNode.buffer = this.createImpulseResponse(1.3, 3.4);
    this.reverbSendGain = this.ctx.createGain();
    this.reverbSendGain.gain.value = 0.24;

    this.reverbSendGain.connect(this.reverbNode);
    this.reverbNode.connect(this.sfxBus);
    this.compressor.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);

    // MediaStream destination so 9:16 TikTok clip recorder captures game audio + voices
    this.recordDestination = this.ctx.createMediaStreamDestination();
    this.masterGain.connect(this.recordDestination);

    this.setupJetTurbineLayers();
    void this.preloadNeuralVoiceBank();
    this.sfx = new SfxBank(this.ctx);
    void this.sfx.load();
  }

  public getRecordingAudioTracks(): MediaStreamTrack[] {
    this.init();
    if (!this.recordDestination) return [];
    return this.recordDestination.stream.getAudioTracks();
  }

  /** Bus para una futura pista de música; se atenúa automáticamente bajo la voz. */
  public getMusicBus(): GainNode | null {
    this.init();
    return this.musicBus;
  }

  private async loadVoiceManifest(): Promise<Partial<Record<VoiceCueId, string[]>>> {
    try {
      const res = await fetch(VOICE_MANIFEST_URL);
      if (res.ok) {
        const manifest = (await res.json()) as { cues?: Partial<Record<VoiceCueId, string[]>> };
        if (manifest.cues) return manifest.cues;
      }
    } catch {
      // Sin manifiesto: ruta histórica de un archivo por cue
    }
    return Object.fromEntries(ALL_VOICE_CUES.map((cueId) => [cueId, [`${cueId}.mp3`]]));
  }

  private async preloadNeuralVoiceBank(): Promise<void> {
    if (!this.ctx || this.loadingVoices) return;
    this.loadingVoices = true;

    const manifest = await this.loadVoiceManifest();
    // Un mismo archivo puede servir a varios cues (alias): se decodifica una sola vez
    const decoded = new Map<string, Promise<AudioBuffer | null>>();
    const decodeFile = (file: string): Promise<AudioBuffer | null> => {
      let pending = decoded.get(file);
      if (!pending) {
        pending = (async () => {
          try {
            const res = await fetch(`/assets/voice/${file}`);
            if (!res.ok || !this.ctx) return null;
            return await this.ctx.decodeAudioData(await res.arrayBuffer());
          } catch {
            return null;
          }
        })();
        decoded.set(file, pending);
      }
      return pending;
    };

    await Promise.all(
      ALL_VOICE_CUES.map(async (cueId) => {
        const buffers = await Promise.all((manifest[cueId] ?? []).map(decodeFile));
        const usable = buffers.filter((b): b is AudioBuffer => b !== null);
        if (usable.length > 0) this.voiceBuffers.set(cueId, usable);
      })
    );
  }

  /** Cues con audio cargado y cuántas variantes tiene cada uno (diagnóstico). */
  public getLoadedVoiceCues(): Record<string, number> {
    return Object.fromEntries([...this.voiceBuffers].map(([cueId, list]) => [cueId, list.length]));
  }

  private pickVariant(cueId: VoiceCueId): AudioBuffer | null {
    const variants = this.voiceBuffers.get(cueId);
    if (!variants || variants.length === 0) return null;
    const last = this.lastVariant.get(cueId) ?? -1;
    let idx = Math.floor(Math.random() * variants.length);
    if (variants.length > 1 && idx === last) {
      idx = (idx + 1 + Math.floor(Math.random() * (variants.length - 1))) % variants.length;
    }
    this.lastVariant.set(cueId, idx);
    return variants[idx];
  }

  private setupJetTurbineLayers(): void {
    if (!this.ctx || !this.turbineDuckGain) return;

    // Layer 1: Deep Sub-Bass Rotor Rumble
    this.subRotorOsc = this.ctx.createOscillator();
    this.subRotorOsc.type = 'sawtooth';
    this.subRotorOsc.frequency.value = 48;

    const subFilter = this.ctx.createBiquadFilter();
    subFilter.type = 'lowpass';
    subFilter.frequency.value = 135;

    this.subRotorGain = this.ctx.createGain();
    this.subRotorGain.gain.value = 0;

    this.subRotorOsc.connect(subFilter);
    subFilter.connect(this.subRotorGain);
    this.subRotorGain.connect(this.turbineDuckGain);
    this.subRotorOsc.start();

    // Layer 2: Aerodynamic Pink/Brown Noise Jet Afterburner Roar
    const noiseBuffer = this.createPinkNoiseBuffer(3.0);
    this.jetNoiseSource = this.ctx.createBufferSource();
    this.jetNoiseSource.buffer = noiseBuffer;
    this.jetNoiseSource.loop = true;

    this.jetNoiseFilter = this.ctx.createBiquadFilter();
    this.jetNoiseFilter.type = 'bandpass';
    this.jetNoiseFilter.frequency.value = 320;
    this.jetNoiseFilter.Q.value = 0.9;

    this.jetNoiseGain = this.ctx.createGain();
    this.jetNoiseGain.gain.value = 0;

    this.jetNoiseSource.connect(this.jetNoiseFilter);
    this.jetNoiseFilter.connect(this.jetNoiseGain);
    this.jetNoiseGain.connect(this.turbineDuckGain);
    this.jetNoiseSource.start();

    // Layer 3: Precision Turbofan Mechanical Spool Whine
    this.spoolOsc = this.ctx.createOscillator();
    this.spoolOsc.type = 'sine';
    this.spoolOsc.frequency.value = 440;

    this.spoolGain = this.ctx.createGain();
    this.spoolGain.gain.value = 0;

    this.spoolOsc.connect(this.spoolGain);
    this.spoolGain.connect(this.turbineDuckGain);
    this.spoolOsc.start();
  }

  public setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.88, this.ctx.currentTime, 0.05);
    }
    if (muted) {
      this.stopActiveVoice();
    }
  }

  public toggleMute(): boolean {
    this.setMuted(!this.isMuted);
    return this.isMuted;
  }

  public getVoiceMode(): VoiceMode {
    return this.voiceMode;
  }

  public cycleVoiceMode(): VoiceMode {
    const order: VoiceMode[] = ['es', 'es_radio', 'off'];
    const nextIdx = (order.indexOf(this.voiceMode) + 1) % order.length;
    this.voiceMode = order[nextIdx];
    try {
      localStorage.setItem(VOICE_MODE_STORAGE_KEY, this.voiceMode);
    } catch {
      // Storage bloqueado: el modo dura solo esta sesión
    }
    if (this.voiceMode === 'off') {
      this.stopActiveVoice();
    }
    return this.voiceMode;
  }

  public resetStreak(): void {
    this.shieldStreak = 0;
  }

  public getShieldStreak(): number {
    return this.shieldStreak;
  }

  /**
   * Updates the 3-layer jet turbine sound and 2Hz critical velocity radar alarm.
   */
  public updateTelemetryAudio(
    isRunning: boolean,
    currentSpeed: number,
    isCriticalSpeed: boolean,
    integrityRatio = 1
  ): void {
    if (
      !this.ctx ||
      !this.subRotorOsc ||
      !this.subRotorGain ||
      !this.jetNoiseFilter ||
      !this.jetNoiseGain ||
      !this.spoolOsc ||
      !this.spoolGain
    ) {
      return;
    }

    const now = this.ctx.currentTime;

    if (!isRunning || this.isMuted) {
      this.subRotorGain.gain.setTargetAtTime(0, now, 0.08);
      this.jetNoiseGain.gain.setTargetAtTime(0, now, 0.08);
      this.spoolGain.gain.setTargetAtTime(0, now, 0.08);
      this.alarmActive = false;
      this.nextSocialCueAt = 0;
      this.stopLoops();
      return;
    }

    this.updateTensionLayers(currentSpeed, integrityRatio);

    // Recordatorios de impacto social cada ~40-60 s de carrera, solo si el narrador está libre
    const nowMs = Date.now();
    if (this.nextSocialCueAt === 0) {
      this.nextSocialCueAt = nowMs + 30000;
    } else if (nowMs >= this.nextSocialCueAt) {
      if (this.playNarratorCue(this.pickOne(SOCIAL_CUES), false)) {
        this.nextSocialCueAt = nowMs + 40000 + Math.random() * 20000;
      } else {
        this.nextSocialCueAt = nowMs + 5000;
      }
    }

    const speedNorm = Math.max(0, Math.min(1, currentSpeed / 250));

    this.subRotorOsc.frequency.setTargetAtTime(42 + speedNorm * 68, now, 0.06);
    this.subRotorGain.gain.setTargetAtTime(0.055 + speedNorm * 0.045, now, 0.08);

    // Con daño alto el motor suena más apagado
    const damageMuffle = 1 - Math.max(0, Math.min(1, 1 - integrityRatio)) * 0.45;
    this.jetNoiseFilter.frequency.setTargetAtTime((220 + speedNorm * 1350) * damageMuffle, now, 0.06);
    this.jetNoiseGain.gain.setTargetAtTime(0.07 + speedNorm * 0.11, now, 0.08);

    this.spoolOsc.frequency.setTargetAtTime(390 + speedNorm * 980, now, 0.06);
    this.spoolGain.gain.setTargetAtTime(0.012 + speedNorm * 0.022, now, 0.08);

    if (isCriticalSpeed) {
      if (!this.alarmActive) {
        this.alarmActive = true;
        this.nextAlarmPulseTime = now;
        this.playNarratorCue(this.pickOne<VoiceCueId>(['cmd_mayday', 'athena_stall']), true);
      }
      if (now >= this.nextAlarmPulseTime) {
        this.triggerWarningAlarmPulse();
        this.nextAlarmPulseTime = now + 0.5;
      }
    } else {
      this.alarmActive = false;
    }
  }

  public processServerEvents(
    events: Array<{ id: string; type: SoundEventType; pan?: number; intensity?: number }>
  ): void {
    for (const ev of events) {
      if (this.processedEventIds.has(ev.id)) continue;
      this.processedEventIds.add(ev.id);
      if (this.processedEventIds.size > 60) {
        const first = this.processedEventIds.values().next().value;
        if (first) this.processedEventIds.delete(first);
      }
      this.triggerSoundEffect(ev.type, ev.pan ?? 0, ev.intensity);
    }
  }

  public triggerSoundEffect(type: SoundEventType, stereoPan = 0, intensity?: number): void {
    if (this.isMuted) return;
    this.init();
    if (!this.ctx) return;

    switch (type) {
      case 'shield_deflect':
        this.shieldStreak++;
        if (!this.playSample('shield_deflect', { pan: stereoPan, reverb: 0.3 })) {
          this.playShieldDeflect(stereoPan);
        }
        if (this.shieldStreak === 2) {
          this.playNarratorCue('cmd_double_streak', true);
        } else if (this.shieldStreak >= 3) {
          this.playNarratorCue('cmd_unstoppable', true);
        } else {
          this.playNarratorCue('cmd_intercept', false);
        }
        break;

      case 'shield_up':
        this.playSample('shield_up', { pan: stereoPan, gain: 0.7 });
        break;

      case 'shield_double':
        if (!this.playSample('shield_double', { wide: true, reverb: 0.35 })) {
          this.playShieldDeflect(0);
        }
        break;

      case 'explosion':
        this.shieldStreak = 0;
        this.playDestruction();
        this.playNarratorCue('athena_eject', true);
        break;

      case 'collision_damage':
        this.shieldStreak = 0;
        this.playCollision(stereoPan, intensity ?? 0.35);
        this.playNarratorCue('athena_breach', true);
        break;

      case 'ping_deployed':
        if (!this.playSample('radar_ping', { pan: stereoPan, gain: 0.8 })) {
          this.playTacticalPing(stereoPan);
        }
        break;

      case 'overdrive_activated':
        if (!this.playSample('turbo', { pan: stereoPan * 0.5, reverb: 0.2 })) {
          this.playOverdrivePowerup();
        }
        this.playNarratorCue(this.pickOne<VoiceCueId>(['cmd_overdrive', 'athena_overdrive']), true);
        break;

      case 'repair_collected':
        if (!this.playSample('repair', { pan: stereoPan * 0.5 })) {
          this.playOverdrivePowerup();
        }
        this.playNarratorCue('athena_revive', true);
        break;

      case 'revive':
        if (!this.playSample('repair')) {
          this.playOverdrivePowerup();
        }
        this.playNarratorCue('athena_revive', true);
        break;
    }
  }

  /** Diagnóstico/pruebas: reproduce un efecto grabado. Devuelve false si no está cargado. */
  public playSfx(id: SfxId, opts: { pan?: number; gain?: number; wide?: boolean } = {}): boolean {
    this.init();
    return this.playSample(id, opts);
  }

  /** Diagnóstico: efectos grabados cargados y número de variantes. */
  public getLoadedSfx(): Record<string, number> {
    return this.sfx?.loaded() ?? {};
  }

  /**
   * Reproduce una variante grabada. Devuelve false si el efecto no está en el banco, para que el
   * llamador use el sintetizado. `wide` añade una copia retardada 14 ms al lado opuesto (efecto Haas)
   * para que el golpe se sienta envolvente.
   */
  private playSample(
    id: SfxId,
    o: { pan?: number; gain?: number; reverb?: number; wide?: boolean; delay?: number } = {}
  ): boolean {
    if (!this.ctx || !this.sfxBus || !this.sfx) return false;
    const buffer = this.sfx.pick(id);
    if (!buffer) return false;

    const at = this.ctx.currentTime + (o.delay ?? 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = 1 + (Math.random() * 2 - 1) * 0.03; // ±3 % para que no suene repetido

    const gain = this.ctx.createGain();
    gain.gain.value = o.gain ?? 1;
    const pan = Math.max(-1, Math.min(1, o.pan ?? 0)) * 0.8;
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;

    src.connect(gain);
    gain.connect(panner);
    panner.connect(this.sfxBus);

    if (o.wide) {
      const haasDelay = this.ctx.createDelay(0.05);
      haasDelay.delayTime.value = 0.014;
      const haasGain = this.ctx.createGain();
      haasGain.gain.value = 0.55;
      const haasPan = this.ctx.createStereoPanner();
      haasPan.pan.value = pan === 0 ? 0.7 : -Math.sign(pan) * 0.7;
      gain.connect(haasDelay);
      haasDelay.connect(haasGain);
      haasGain.connect(haasPan);
      haasPan.connect(this.sfxBus);
    }
    if (o.reverb && this.reverbSendGain) {
      const send = this.ctx.createGain();
      send.gain.value = o.reverb;
      panner.connect(send);
      send.connect(this.reverbSendGain);
    }

    src.start(at);
    return true;
  }

  /** Choque: muestra según gravedad + golpe grave sintetizado para dar peso + caída breve del resto. */
  private playCollision(pan: number, intensity: number): void {
    const level = Math.max(0, Math.min(1, intensity));
    const id: SfxId = level >= 0.7 ? 'impact_heavy' : level >= 0.35 ? 'impact_medium' : 'impact_light';
    const played = this.playSample(id, {
      pan,
      wide: true,
      reverb: 0.2 + level * 0.3,
      gain: 0.85 + level * 0.15
    });
    if (!played) this.playCollisionImpact(pan);
    this.playSubBoom(90 - level * 30, 0.35 + level * 0.35, 0.3 + level * 0.4);
    this.punchDuck(0.15 + level * 0.1);
  }

  /** Destrucción: golpe pesado → desgarro metálico → cola de escombros, con silencio dramático. */
  private playDestruction(): void {
    if (!this.ctx) return;
    this.silenceUntil = this.ctx.currentTime + 1.5;
    this.stopLoops(0.08);
    if (this.sfx?.has('destroy_metal')) {
      this.playSample('impact_heavy', { wide: true, reverb: 0.3 });
      this.playSample('destroy_metal', { wide: true, reverb: 0.45, delay: 0.12 });
      this.playSubBoom(70, 1.2, 0.7);
    } else {
      this.playExplosion();
    }
  }

  private playSubBoom(freqHz: number, durationSec: number, peak: number): void {
    if (!this.ctx || !this.sfxBus) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freqHz, now);
    osc.frequency.exponentialRampToValueAtTime(22, now + durationSec);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(peak, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + durationSec);
    osc.connect(gain);
    gain.connect(this.sfxBus);
    osc.start(now);
    osc.stop(now + durationSec);
  }

  /** Baja motor y fondos un instante para que el golpe se sienta (respeta el ducking de voz). */
  private punchDuck(holdSec: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const speaking = this.activeVoiceSource !== null;
    const targets: Array<[GainNode | null, number]> = [
      [this.turbineDuckGain, speaking ? DUCK_TURBINE : 1],
      [this.ambienceBus, speaking ? DUCK_AMBIENCE : 1]
    ];
    for (const [node, restore] of targets) {
      if (!node) continue;
      node.gain.cancelScheduledValues(now);
      node.gain.setTargetAtTime(restore * 0.35, now, 0.01);
      node.gain.setTargetAtTime(restore, now + holdSec, 0.12);
    }
  }

  /**
   * Capas en loop según la tensión: fondo bajo ↔ alto según velocidad y daño, chispas desde 35 % de
   * daño y estructura crítica desde 70 %. Tras la destrucción todo queda en silencio un momento.
   */
  private updateTensionLayers(currentSpeed: number, integrityRatio: number): void {
    if (!this.ctx || !this.sfx) return;
    const damage = Math.max(0, Math.min(1, 1 - integrityRatio));
    const speedNorm = Math.max(0, Math.min(1, currentSpeed / 250));
    const tension = Math.max(speedNorm * 0.6, damage);
    const silent = this.ctx.currentTime < this.silenceUntil;
    const level = (v: number) => (silent ? 0 : v);

    this.setLoopLevel('amb_tension_low', level(0.9 * (1 - tension * 0.7)));
    this.setLoopLevel('amb_tension_high', level(0.9 * tension));
    this.setLoopLevel('dmg_sparks', level(damage >= 0.7 ? 0.35 : damage >= 0.35 ? 0.6 : 0));
    this.setLoopLevel('dmg_critical', level(damage >= 0.7 ? 0.8 : 0));
  }

  private setLoopLevel(id: SfxId, target: number): void {
    if (!this.ctx || !this.ambienceBus || !this.sfx) return;
    let layer = this.loops.get(id);
    if (!layer) {
      if (target <= 0.001) return;
      const buffer = this.sfx.pick(id);
      if (!buffer) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain);
      gain.connect(this.ambienceBus);
      src.start();
      layer = { src, gain };
      this.loops.set(id, layer);
    }
    // ~2 s de transición entre niveles de tensión
    layer.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.7);
  }

  private stopLoops(fadeSec = 0.6): void {
    if (!this.ctx || this.loops.size === 0) return;
    const now = this.ctx.currentTime;
    for (const { src, gain } of this.loops.values()) {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(0, now, fadeSec / 3);
      try {
        src.stop(now + fadeSec * 2);
      } catch {
        // Ya detenido
      }
    }
    this.loops.clear();
  }

  /**
   * Plays military radio Push-To-Talk (PTT) transmission and triggers corresponding Neural Voice.
   */
  public playCommsTransmission(preset: TacticalCommsPreset): void {
    if (this.isMuted) return;
    this.init();

    const presetToCue: Record<TacticalCommsPreset, VoiceCueId> = {
      bogey_alert: 'cmd_bogey',
      nice_deflect: 'cmd_intercept',
      engage_overdrive: 'cmd_overdrive',
      mayday_panic: 'cmd_mayday'
    };

    this.playNarratorCue(presetToCue[preset], true);
  }

  /**
   * Reproduce un cue del narrador (variante al azar). Devuelve true si sonó.
   * - No prioritario: solo si no hay voz activa y pasó VOICE_GAP_MS desde la última.
   * - Prioritario: puede cortar una voz que ya lleva PRIORITY_MIN_PLAY_MS sonando.
   */
  public playNarratorCue(cueId: VoiceCueId, priority = false): boolean {
    if (this.isMuted || this.voiceMode === 'off') return false;
    this.init();
    if (!this.ctx || !this.voiceBus || !this.turbineDuckGain) return false;

    const nowMs = Date.now();
    if (nowMs - (this.lastCueTime.get(cueId) ?? 0) < SAME_CUE_COOLDOWN_MS) return false;
    if (this.activeVoiceSource) {
      if (!priority || nowMs - this.activeVoiceStartedAt < PRIORITY_MIN_PLAY_MS) return false;
    } else if (!priority && nowMs - this.lastVoiceEndedAt < VOICE_GAP_MS) {
      return false;
    }

    const buffer = this.pickVariant(cueId);
    if (!buffer) return false;

    this.stopActiveVoice(false);
    this.lastCueTime.set(cueId, nowMs);
    this.activeVoiceStartedAt = nowMs;

    const isRadio = this.voiceMode === 'es_radio';
    const isGuia = GUIA_CUES.has(cueId);
    const now = this.ctx.currentTime;
    const startAt = now + (isRadio ? 0.06 : 0.03);

    // 1. Ducking: motor, efectos y música bajan para que la voz se entienda
    this.setDuck(true, now);

    // 2. Cadena de voz: limpia y cálida por defecto; radio suave opcional
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    const highpass = this.ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = isRadio ? 280 : 85;

    const presence = this.ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = isRadio ? 1800 : 3200;
    presence.Q.value = isRadio ? 1.2 : 0.8;
    presence.gain.value = isRadio ? 3 : 2;

    const lowpass = this.ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = isRadio ? 4200 : 14000;

    const voiceGain = this.ctx.createGain();
    voiceGain.gain.value = isGuia ? 1.0 : 1.05;

    source.connect(highpass);
    highpass.connect(presence);
    presence.connect(lowpass);
    if (isRadio) {
      const radioShaper = this.ctx.createWaveShaper();
      radioShaper.curve = this.makeDistortionCurve(5);
      radioShaper.oversample = '2x';
      lowpass.connect(radioShaper);
      radioShaper.connect(voiceGain);
    } else {
      lowpass.connect(voiceGain);
    }
    voiceGain.connect(this.voiceBus);

    const durationSec = buffer.duration;
    if (isRadio) {
      // Bip de apertura y estática muy baja
      this.playQuindarTone(isGuia ? 1600 : 1300, 0.04);

      const staticSource = this.ctx.createBufferSource();
      staticSource.buffer = this.createPinkNoiseBuffer(durationSec + 0.12);

      const staticFilter = this.ctx.createBiquadFilter();
      staticFilter.type = 'bandpass';
      staticFilter.frequency.value = 1600;
      staticFilter.Q.value = 1.2;

      const staticGain = this.ctx.createGain();
      staticGain.gain.setValueAtTime(0.008, startAt);

      staticSource.connect(staticFilter);
      staticFilter.connect(staticGain);
      staticGain.connect(this.voiceBus);

      staticSource.start(startAt);
      staticSource.stop(startAt + durationSec);
      this.activeStaticSource = staticSource;
    } else if (this.reverbSendGain) {
      // Un toque de ambiente para que no suene "seca"
      const roomSend = this.ctx.createGain();
      roomSend.gain.value = 0.12;
      voiceGain.connect(roomSend);
      roomSend.connect(this.reverbSendGain);
    }

    source.onended = () => {
      if (this.activeVoiceSource !== source) return;
      this.activeVoiceSource = null;
      this.activeStaticSource = null;
      this.lastVoiceEndedAt = Date.now();
      if (isRadio) this.playRadioSquelchTail();
      if (this.ctx) this.setDuck(false, this.ctx.currentTime + 0.08);
      // Tras una misión fallida, recordamos a quién ayudó la carrera
      if (cueId === 'athena_eject') {
        setTimeout(() => this.playNarratorCue('social_thanks', true), 500);
      }
    };

    this.activeVoiceSource = source;
    source.start(startAt);
    if (cueId === 'cmd_milestone' || SOCIAL_CUES.includes(cueId)) {
      this.playSample('reward_rescue', { gain: 0.6 });
    }
    return true;
  }

  private setDuck(active: boolean, at: number): void {
    const timeConstant = active ? 0.05 : 0.18;
    const ramps: Array<[GainNode | null, number]> = [
      [this.turbineDuckGain, active ? DUCK_TURBINE : 1],
      [this.sfxBus, active ? DUCK_SFX : 1],
      [this.musicBus, active ? DUCK_MUSIC : 1],
      [this.ambienceBus, active ? DUCK_AMBIENCE : 1]
    ];
    for (const [node, target] of ramps) {
      if (!node) continue;
      node.gain.cancelScheduledValues(at);
      node.gain.setTargetAtTime(target, at, timeConstant);
    }
  }

  private pickOne<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
  }

  private stopActiveVoice(restoreMix = true): void {
    if (this.activeVoiceSource) {
      try {
        this.activeVoiceSource.onended = null;
        this.activeVoiceSource.stop();
      } catch {
        // Ignore already stopped
      }
      this.activeVoiceSource = null;
      this.lastVoiceEndedAt = Date.now();
    }
    if (this.activeStaticSource) {
      try {
        this.activeStaticSource.stop();
      } catch {
        // Ignore
      }
      this.activeStaticSource = null;
    }
    if (restoreMix && this.ctx) {
      this.setDuck(false, this.ctx.currentTime);
    }
  }

  private playQuindarTone(freqHz: number, durationSec: number): void {
    if (!this.ctx || !this.voiceBus) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freqHz, now);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.09, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + durationSec);

    osc.connect(gain);
    gain.connect(this.voiceBus);
    osc.start(now);
    osc.stop(now + durationSec);
  }

  private playRadioSquelchTail(): void {
    if (!this.ctx || !this.voiceBus) return;
    const now = this.ctx.currentTime;
    const dur = 0.075;
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.createPinkNoiseBuffer(dur);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1950;
    filter.Q.value = 2.2;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.voiceBus);
    noise.start(now);
    noise.stop(now + dur);
  }

  private playShieldDeflect(pan = 0): void {
    if (!this.ctx || !this.sfxBus || !this.reverbSendGain) return;
    const now = this.ctx.currentTime;

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(this.sfxBus);
    panner.connect(this.reverbSendGain);

    const subOsc = this.ctx.createOscillator();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(155, now);
    subOsc.frequency.exponentialRampToValueAtTime(34, now + 0.22);

    const subGain = this.ctx.createGain();
    subGain.gain.setValueAtTime(0.45, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
    subOsc.connect(subGain);
    subGain.connect(panner);
    subOsc.start(now);
    subOsc.stop(now + 0.24);

    const duration = 0.28;
    const noiseSource = this.ctx.createBufferSource();
    noiseSource.buffer = this.createPinkNoiseBuffer(duration);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 3.5;
    filter.frequency.setValueAtTime(2600, now);
    filter.frequency.exponentialRampToValueAtTime(280, now + duration);

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.36, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    noiseSource.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(panner);
    noiseSource.start(now);
    noiseSource.stop(now + duration);
  }

  private triggerWarningAlarmPulse(): void {
    if (!this.ctx || !this.sfxBus || this.isMuted) return;
    const now = this.ctx.currentTime;
    const pulseDuration = 0.24;

    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    osc1.type = 'square';
    osc2.type = 'sawtooth';

    osc1.frequency.setValueAtTime(820, now);
    osc1.frequency.setValueAtTime(640, now + 0.12);
    osc2.frequency.setValueAtTime(410, now);
    osc2.frequency.setValueAtTime(320, now + 0.12);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1800;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.11, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + pulseDuration);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxBus);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + pulseDuration);
    osc2.stop(now + pulseDuration);
  }

  private playExplosion(): void {
    if (!this.ctx || !this.sfxBus || !this.reverbSendGain) return;
    const now = this.ctx.currentTime;
    const duration = 1.25;

    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(110, now);
    sub.frequency.exponentialRampToValueAtTime(20, now + 0.9);

    const subGain = this.ctx.createGain();
    subGain.gain.setValueAtTime(0.65, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.95);

    sub.connect(subGain);
    subGain.connect(this.sfxBus);
    sub.start(now);
    sub.stop(now + 0.95);

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.createPinkNoiseBuffer(duration);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(520, now);
    filter.frequency.exponentialRampToValueAtTime(48, now + duration);

    const distortion = this.ctx.createWaveShaper();
    distortion.curve = this.makeDistortionCurve(140);
    distortion.oversample = '4x';

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    noise.connect(filter);
    filter.connect(distortion);
    distortion.connect(gain);
    gain.connect(this.sfxBus);
    gain.connect(this.reverbSendGain);

    noise.start(now);
    noise.stop(now + duration);
  }

  private playCollisionImpact(pan = 0): void {
    if (!this.ctx || !this.sfxBus || !this.reverbSendGain) return;
    const now = this.ctx.currentTime;

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;
    panner.connect(this.sfxBus);
    panner.connect(this.reverbSendGain);

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.createPinkNoiseBuffer(0.38);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(420, now);
    filter.frequency.exponentialRampToValueAtTime(85, now + 0.36);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.48, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    noise.start(now);
    noise.stop(now + 0.38);
  }

  private playTacticalPing(pan = 0): void {
    if (!this.ctx || !this.sfxBus || !this.reverbSendGain) return;
    const now = this.ctx.currentTime;

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;
    panner.connect(this.sfxBus);
    panner.connect(this.reverbSendGain);

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1320, now);
    osc.frequency.setValueAtTime(1760, now + 0.065);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);

    osc.connect(gain);
    gain.connect(panner);
    osc.start(now);
    osc.stop(now + 0.24);
  }

  private playOverdrivePowerup(): void {
    if (!this.ctx || !this.sfxBus || !this.reverbSendGain) return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.45);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(600, now);
    filter.frequency.exponentialRampToValueAtTime(3200, now + 0.45);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.48);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxBus);
    gain.connect(this.reverbSendGain);
    osc.start(now);
    osc.stop(now + 0.48);
  }

  private createPinkNoiseBuffer(durationSeconds: number): AudioBuffer {
    if (!this.ctx) throw new Error('AudioContext not initialized');
    const sampleRate = this.ctx.sampleRate;
    const length = Math.floor(sampleRate * durationSeconds);
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const output = buffer.getChannelData(0);

    let b0 = 0,
      b1 = 0,
      b2 = 0,
      b3 = 0,
      b4 = 0,
      b5 = 0,
      b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      output[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.045;
      b6 = white * 0.115926;
    }
    return buffer;
  }

  private createImpulseResponse(durationSeconds: number, decay: number): AudioBuffer {
    if (!this.ctx) throw new Error('AudioContext not initialized');
    const sampleRate = this.ctx.sampleRate;
    const length = Math.floor(sampleRate * durationSeconds);
    const impulse = this.ctx.createBuffer(2, length, sampleRate);

    for (let ch = 0; ch < 2; ch++) {
      const channelData = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  }

  private makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
    const samples = 44100;
    const buffer = new ArrayBuffer(samples * 4);
    const curve = new Float32Array(buffer);
    const deg = Math.PI / 180;
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }
}
