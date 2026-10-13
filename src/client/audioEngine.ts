import type { SoundEventType, TacticalCommsPreset } from '../shared/types.js';

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
  | 'cmd_milestone';

export type VoiceMode = 'hybrid' | 'es_only' | 'en_only' | 'off';

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
  'cmd_milestone'
];

/**
 * AAA Multi-Layer Procedural Audio & Neural Military Radio Narrator Engine.
 * Features:
 * - Pre-decoded Neural Voice Bank (ATHENA English F-35 AI + COMMANDER VORTEX Spanish AWACS)
 * - Mil-Spec Walkie-Talkie DSP Chain (Quindar PTT Beep, Bandpass 420-2850Hz, Tube Saturation, VHF Carrier Static & Squelch Tail)
 * - Automatic Audio Ducking (attenuates jet turbine by 40% while narrator speaks)
 * - MediaStreamAudioDestinationNode export so 9:16 TikTok video clips include full audio + narrator voices
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private turbineDuckGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private reverbNode: ConvolverNode | null = null;
  private reverbSendGain: GainNode | null = null;
  private recordDestination: MediaStreamAudioDestinationNode | null = null;

  private isMuted = false;
  private voiceMode: VoiceMode = 'hybrid';

  // Preloaded Neural Voice AudioBuffers
  private voiceBuffers = new Map<VoiceCueId, AudioBuffer>();
  private loadingVoices = false;
  private activeVoiceSource: AudioBufferSourceNode | null = null;
  private activeStaticSource: AudioBufferSourceNode | null = null;
  private lastVoiceTime = 0;

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

    // Spatial Acoustic Reverb (Metallic Canyon / Cockpit Impulse)
    this.reverbNode = this.ctx.createConvolver();
    this.reverbNode.buffer = this.createImpulseResponse(1.3, 3.4);
    this.reverbSendGain = this.ctx.createGain();
    this.reverbSendGain.gain.value = 0.24;

    this.reverbSendGain.connect(this.reverbNode);
    this.reverbNode.connect(this.compressor);
    this.compressor.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);

    // MediaStream destination so 9:16 TikTok clip recorder captures game audio + voices
    this.recordDestination = this.ctx.createMediaStreamDestination();
    this.masterGain.connect(this.recordDestination);

    this.setupJetTurbineLayers();
    void this.preloadNeuralVoiceBank();
  }

  public getRecordingAudioTracks(): MediaStreamTrack[] {
    this.init();
    if (!this.recordDestination) return [];
    return this.recordDestination.stream.getAudioTracks();
  }

  private async preloadNeuralVoiceBank(): Promise<void> {
    if (!this.ctx || this.loadingVoices) return;
    this.loadingVoices = true;

    await Promise.allSettled(
      ALL_VOICE_CUES.map(async (cueId) => {
        try {
          const res = await fetch(`/assets/voice/${cueId}.mp3`);
          if (!res.ok || !this.ctx) return;
          const arrayBuf = await res.arrayBuffer();
          const audioBuf = await this.ctx.decodeAudioData(arrayBuf);
          this.voiceBuffers.set(cueId, audioBuf);
        } catch {
          // Ignore individual asset decode issue
        }
      })
    );
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

  public cycleVoiceMode(): VoiceMode {
    const order: VoiceMode[] = ['hybrid', 'es_only', 'en_only', 'off'];
    const nextIdx = (order.indexOf(this.voiceMode) + 1) % order.length;
    this.voiceMode = order[nextIdx];
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
    isCriticalSpeed: boolean
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
      return;
    }

    const speedNorm = Math.max(0, Math.min(1, currentSpeed / 250));

    this.subRotorOsc.frequency.setTargetAtTime(42 + speedNorm * 68, now, 0.06);
    this.subRotorGain.gain.setTargetAtTime(0.055 + speedNorm * 0.045, now, 0.08);

    this.jetNoiseFilter.frequency.setTargetAtTime(220 + speedNorm * 1350, now, 0.06);
    this.jetNoiseGain.gain.setTargetAtTime(0.07 + speedNorm * 0.11, now, 0.08);

    this.spoolOsc.frequency.setTargetAtTime(390 + speedNorm * 980, now, 0.06);
    this.spoolGain.gain.setTargetAtTime(0.012 + speedNorm * 0.022, now, 0.08);

    if (isCriticalSpeed) {
      if (!this.alarmActive) {
        this.alarmActive = true;
        this.nextAlarmPulseTime = now;
        this.playNarratorCue(
          this.voiceMode === 'es_only' ? 'cmd_mayday' : 'athena_stall',
          true
        );
      }
      if (now >= this.nextAlarmPulseTime) {
        this.triggerWarningAlarmPulse();
        this.nextAlarmPulseTime = now + 0.5;
      }
    } else {
      this.alarmActive = false;
    }
  }

  public processServerEvents(events: Array<{ id: string; type: SoundEventType }>): void {
    for (const ev of events) {
      if (this.processedEventIds.has(ev.id)) continue;
      this.processedEventIds.add(ev.id);
      if (this.processedEventIds.size > 60) {
        const first = this.processedEventIds.values().next().value;
        if (first) this.processedEventIds.delete(first);
      }
      this.triggerSoundEffect(ev.type);
    }
  }

  public triggerSoundEffect(type: SoundEventType, stereoPan = 0): void {
    if (this.isMuted) return;
    this.init();
    if (!this.ctx) return;

    switch (type) {
      case 'shield_deflect':
        this.shieldStreak++;
        this.playShieldDeflect(stereoPan);
        if (this.shieldStreak === 2) {
          this.playNarratorCue('cmd_double_streak', true);
        } else if (this.shieldStreak >= 3) {
          this.playNarratorCue('cmd_unstoppable', true);
        } else {
          this.playNarratorCue('cmd_intercept', false);
        }
        break;

      case 'explosion':
        this.shieldStreak = 0;
        this.playExplosion();
        this.playNarratorCue('athena_eject', true);
        break;

      case 'collision_damage':
        this.shieldStreak = 0;
        this.playCollisionImpact(stereoPan);
        this.playNarratorCue('athena_breach', true);
        break;

      case 'ping_deployed':
        this.playTacticalPing(stereoPan);
        break;

      case 'overdrive_activated':
        this.playOverdrivePowerup();
        this.playNarratorCue(
          this.voiceMode === 'es_only' ? 'cmd_overdrive' : 'athena_overdrive',
          true
        );
        break;

      case 'revive':
        this.playOverdrivePowerup();
        this.playNarratorCue('athena_revive', true);
        break;
    }
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
   * Plays a pre-generated Neural Voice Cue through the Web Audio API Mil-Spec Radio DSP Chain!
   */
  public playNarratorCue(cueId: VoiceCueId, priority = false): void {
    if (this.isMuted || this.voiceMode === 'off') return;
    this.init();
    if (!this.ctx || !this.compressor || !this.turbineDuckGain) return;

    // Adapt cue if user forced EN-only or ES-only mode
    let effectiveCue = cueId;
    if (this.voiceMode === 'en_only' && cueId.startsWith('cmd_')) {
      effectiveCue =
        cueId === 'cmd_mayday'
          ? 'athena_stall'
          : cueId === 'cmd_overdrive'
          ? 'athena_overdrive'
          : 'athena_online';
    } else if (this.voiceMode === 'es_only' && cueId.startsWith('athena_')) {
      effectiveCue =
        cueId === 'athena_stall'
          ? 'cmd_mayday'
          : cueId === 'athena_overdrive'
          ? 'cmd_overdrive'
          : 'cmd_bogey';
    }

    const nowMs = Date.now();
    if (!priority && nowMs - this.lastVoiceTime < 2200) {
      return;
    }

    const buffer = this.voiceBuffers.get(effectiveCue);
    if (!buffer) return;

    this.stopActiveVoice();
    this.lastVoiceTime = nowMs;

    const isCommander = effectiveCue.startsWith('cmd_');
    const now = this.ctx.currentTime;

    // 1. Duck jet turbine volume by 40% so the voice cuts through the mix clearly
    this.turbineDuckGain.gain.cancelScheduledValues(now);
    this.turbineDuckGain.gain.setTargetAtTime(0.55, now, 0.04);

    // 2. Play Intro Quindar PTT Tone (2525Hz NASA/F-35 beep for Athena, 1850Hz VHF click for Commander)
    this.playQuindarTone(isCommander ? 1850 : 2525, 0.045);

    // 3. Build DSP Filter Chain for the Voice Buffer
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    // Slight cadence tuning: Athena crisp 1.06x, Commander authoritative 1.03x
    source.playbackRate.value = isCommander ? 1.03 : 1.06;

    const highpass = this.ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = isCommander ? 410 : 240;

    const presence = this.ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = isCommander ? 1450 : 2300;
    presence.Q.value = isCommander ? 1.8 : 1.1;
    presence.gain.value = isCommander ? 7.5 : 4.5;

    const lowpass = this.ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = isCommander ? 2950 : 4800;

    const radioShaper = this.ctx.createWaveShaper();
    radioShaper.curve = this.makeDistortionCurve(isCommander ? 26 : 8);
    radioShaper.oversample = '2x';

    const voiceGain = this.ctx.createGain();
    voiceGain.gain.value = isCommander ? 1.35 : 1.2;

    source.connect(highpass);
    highpass.connect(presence);
    presence.connect(lowpass);
    lowpass.connect(radioShaper);
    radioShaper.connect(voiceGain);
    voiceGain.connect(this.compressor);
    if (this.reverbSendGain && !isCommander) {
      // Athena gets subtle spatial cockpit helmet reverb
      voiceGain.connect(this.reverbSendGain);
    }

    // 4. Add VHF Radio Static Carrier Bed while Commander Vortex speaks
    const durationSec = buffer.duration / source.playbackRate.value;
    if (isCommander) {
      const staticSource = this.ctx.createBufferSource();
      staticSource.buffer = this.createPinkNoiseBuffer(durationSec + 0.12);

      const staticFilter = this.ctx.createBiquadFilter();
      staticFilter.type = 'bandpass';
      staticFilter.frequency.value = 1600;
      staticFilter.Q.value = 1.5;

      const staticGain = this.ctx.createGain();
      staticGain.gain.setValueAtTime(0.025, now + 0.04);

      staticSource.connect(staticFilter);
      staticFilter.connect(staticGain);
      staticGain.connect(this.compressor);

      staticSource.start(now + 0.04);
      staticSource.stop(now + 0.04 + durationSec);
      this.activeStaticSource = staticSource;
    }

    source.onended = () => {
      if (this.activeVoiceSource === source) {
        this.activeVoiceSource = null;
        this.activeStaticSource = null;
        if (this.ctx && this.turbineDuckGain) {
          // Play VHF Squelch Tail Out ("ksshh-beep") & restore turbine volume
          if (isCommander) {
            this.playRadioSquelchTail();
          } else {
            this.playQuindarTone(2475, 0.035);
          }
          this.turbineDuckGain.gain.setTargetAtTime(1.0, this.ctx.currentTime + 0.08, 0.12);
        }
      }
    };

    this.activeVoiceSource = source;
    source.start(now + 0.05);
  }

  private stopActiveVoice(): void {
    if (this.activeVoiceSource) {
      try {
        this.activeVoiceSource.onended = null;
        this.activeVoiceSource.stop();
      } catch {
        // Ignore already stopped
      }
      this.activeVoiceSource = null;
    }
    if (this.activeStaticSource) {
      try {
        this.activeStaticSource.stop();
      } catch {
        // Ignore
      }
      this.activeStaticSource = null;
    }
    if (this.ctx && this.turbineDuckGain) {
      this.turbineDuckGain.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.1);
    }
  }

  private playQuindarTone(freqHz: number, durationSec: number): void {
    if (!this.ctx || !this.compressor) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freqHz, now);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.09, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + durationSec);

    osc.connect(gain);
    gain.connect(this.compressor);
    osc.start(now);
    osc.stop(now + durationSec);
  }

  private playRadioSquelchTail(): void {
    if (!this.ctx || !this.compressor) return;
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
    gain.connect(this.compressor);
    noise.start(now);
    noise.stop(now + dur);
  }

  private playShieldDeflect(pan = 0): void {
    if (!this.ctx || !this.compressor || !this.reverbSendGain) return;
    const now = this.ctx.currentTime;

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(this.compressor);
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
    if (!this.ctx || !this.compressor || this.isMuted) return;
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
    gain.connect(this.compressor);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + pulseDuration);
    osc2.stop(now + pulseDuration);
  }

  private playExplosion(): void {
    if (!this.ctx || !this.compressor || !this.reverbSendGain) return;
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
    subGain.connect(this.compressor);
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
    gain.connect(this.compressor);
    gain.connect(this.reverbSendGain);

    noise.start(now);
    noise.stop(now + duration);
  }

  private playCollisionImpact(pan = 0): void {
    if (!this.ctx || !this.compressor || !this.reverbSendGain) return;
    const now = this.ctx.currentTime;

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;
    panner.connect(this.compressor);
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
    if (!this.ctx || !this.compressor || !this.reverbSendGain) return;
    const now = this.ctx.currentTime;

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;
    panner.connect(this.compressor);
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
    if (!this.ctx || !this.compressor || !this.reverbSendGain) return;
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
    gain.connect(this.compressor);
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
