import { escapeHtml, safeHttpUrl } from '../shared/escapeHtml.js';
import { calculateTransactionSplits, round2 } from '../shared/financialConfig.js';
import { foodKgFromUsd, rescuedCount, weatherForPhase } from './rescueTheme.js';
import { DriverPredictor, extrapolateWorld, ServerClock, TICK_MS } from './netSmoothing.js';
import { GameSimulation } from '../shared/simulation.js';
import { normalizeRoomCode } from '../shared/types.js';
import type {
  RoomErrorCode,
  RoomPlayerInfo,
  ClientInputPayload,
  CosmeticLoadout,
  GameMode,
  LeaderboardEntry,
  PlayerRole,
  RoomLobbyState,
  ServerWorldStatePayload,
  TacticalCommsEvent,
  TacticalCommsPreset,
  TournamentTelemetryStatus,
  WsClientMessage,
  WsServerMessage
} from '../shared/types.js';
import { AudioEngine, type AmbienceLevel, type VoiceMode } from './audioEngine.js';
import { InputManager } from './inputManager.js';
import { GameRenderer } from './renderer.js';

const LOCAL_COMMS_MAP: Record<TacticalCommsPreset, { code: string; label: string }> = {
  bogey_alert: { code: 'AVISO', label: '¡Cuidado, viene una rama! Sube el escudo' },
  nice_deflect: { code: 'BIEN', label: '¡Bien bloqueado! La carga está a salvo' },
  engage_overdrive: { code: 'TURBO', label: '¡Ve por el hueso dorado: turbo croqueta!' },
  mayday_panic: { code: 'PELIGRO', label: '¡Acelera, que el motor se apaga!' }
};

class PacificSpeedClientApp {
  private playerId: string;
  private pilotName: string;
  private roomCode: string;
  private roomFromUrl = false;
  private isPaymentReturn = false;
  private sessionReplaced = false;
  private roomError: { code: RoomErrorCode; message: string } | null = null;
  private pendingSwapRequest: { from_name: string; requested_role: PlayerRole } | null = null;
  private lobbyReceivedAt = 0;
  private mode: GameMode = 'online';
  private activeRole: PlayerRole = 'driver';
  private cosmetics: CosmeticLoadout = {
    paintJob: 'crimson_jaeger',
    neonTrail: 'plasma_cyan',
    hudTheme: 'tactical_amber'
  };

  private ws: WebSocket | null = null;
  private wsConnected = false;

  private localSim = new GameSimulation(false);
  private currentWorldState: ServerWorldStatePayload;
  private lobbyState: RoomLobbyState | null = null;
  private leaderboard: LeaderboardEntry[] = [];
  private leaderboardFilter: 'all' | 'tourney' | 'practice' = 'all';

  // Tournament Pass & Verification State
  private tournamentPass: string | null = null;
  private isTournamentVerified = false;

  // Tournament Public Telemetry State
  private activeTourneyStatus: TournamentTelemetryStatus | null = null;

  private audio = new AudioEngine();
  private input: InputManager;
  private renderer: GameRenderer;

  private lastFrameTime = performance.now();
  private adCountdownInterval: number | null = null;

  // Smooth online play (see netSmoothing.ts) and fixed-step local play
  private serverClock = new ServerClock();
  private driverPredictor = new DriverPredictor();
  private lastInputSentAt = 0;
  private localAccumulator = 0;

  // Hype & Near-Miss tracking for Narrator
  private evaluatedNearMissIds = new Set<string>();
  private nextScoreMilestone = 3000;

  // 9:16 TikTok / Streamer Mode & Native Video+Audio Recorder
  private isTikTokMode = false;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private isRecordingClip = false;

  constructor() {
    // Solo en local: __audio.playSfx('impact_heavy', { pan: -0.5 }) en la consola para probar efectos
    if (['localhost', '127.0.0.1'].includes(window.location.hostname)) {
      (window as unknown as { __audio: AudioEngine }).__audio = this.audio;
    }

    // The server assigns player_id and a secret session token on room_joined.
    this.playerId = '';

    this.pilotName =
      localStorage.getItem('ps_pilot_name') ||
      `RAPTOR_${Math.floor(10 + Math.random() * 89)}`;
    // Persist the generated callsign so a reload / Payphone return keeps the same name.
    this.storageSet(localStorage, 'ps_pilot_name', this.pilotName);

    const savedCosmetics = localStorage.getItem('ps_cosmetics');
    if (savedCosmetics) {
      try {
        this.cosmetics = { ...this.cosmetics, ...JSON.parse(savedCosmetics) };
      } catch {
        // Ignore invalid JSON
      }
    }

    const params = new URLSearchParams(window.location.search);
    // Tolerate gateways that append "?x=y" to a URL that already had a query string.
    const urlRoom = normalizeRoomCode((params.get('room') || '').split(/[?&#]/)[0]);
    this.isPaymentReturn = params.has('payment');
    if (urlRoom) {
      this.roomCode = urlRoom;
      this.roomFromUrl = true;
    } else {
      // Fallback (e.g. Payphone return without ?room): last room this browser was in.
      // Empty → a fresh room is created by the server on connect.
      this.roomCode = normalizeRoomCode(this.storageGet(localStorage, 'ps_last_room'));
    }

    const urlRef = params.get('ref');
    if (urlRef) {
      const refInput = document.getElementById('tourney-referral-input') as HTMLInputElement | null;
      if (refInput) refInput.value = urlRef.trim().toUpperCase();
    }

    // Check URL parameters for Payphone Payment Callback status
    const paymentStatus = params.get('payment');
    const urlPass = params.get('pass');
    const paymentReason = params.get('reason');
    // Remove one-time payment params (pass, reason) from the address bar and history
    if (paymentStatus || urlPass || params.has('tx') || params.has('reason')) {
      ['payment', 'pass', 'tx', 'reason'].forEach((k) => params.delete(k));
      const qs = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    }
    if (paymentStatus === 'success') {
      const feedback = document.getElementById('tourney-feedback');
      if (feedback) {
        feedback.innerHTML = `<strong>[INSCRIPCION CONFIRMADA EN PAYPHONE]</strong><br>Tu pase de torneo: <code>${escapeHtml(urlPass || 'consulta con la organizacion')}</code>.<br>Guardalo: es personal para tu tripulacion.`;
        feedback.style.color = 'var(--phosphor)';
      }
      document.querySelectorAll('[data-hangar-tab]').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.hangar-panel').forEach((p) => p.classList.remove('active'));
      document.querySelector('[data-hangar-tab="hangar-tab-tournament"]')?.classList.add('active');
      document.getElementById('hangar-tab-tournament')?.classList.add('active');
    } else if (paymentStatus === 'error') {
      const reason = paymentReason || 'La pasarela no pudo procesar la transaccion.';
      const feedback = document.getElementById('tourney-feedback');
      if (feedback) {
        feedback.innerHTML = `<strong>[PAGO NO PROCESADO]:</strong> ${escapeHtml(reason)}`;
        feedback.style.color = 'var(--danger)';
      }
      document.querySelectorAll('[data-hangar-tab]').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.hangar-panel').forEach((p) => p.classList.remove('active'));
      document.querySelector('[data-hangar-tab="hangar-tab-tournament"]')?.classList.add('active');
      document.getElementById('hangar-tab-tournament')?.classList.add('active');
    } else if (paymentStatus === 'cancelled') {
      const feedback = document.getElementById('tourney-feedback');
      if (feedback) {
        feedback.innerHTML = `[AVISO] Cobro cancelado en Payphone. Puedes reintentar cuando gustes.`;
        feedback.style.color = 'var(--accent)';
      }
      document.querySelectorAll('[data-hangar-tab]').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.hangar-panel').forEach((p) => p.classList.remove('active'));
      document.querySelector('[data-hangar-tab="hangar-tab-tournament"]')?.classList.add('active');
      document.getElementById('hangar-tab-tournament')?.classList.add('active');
    }

    // Check for Tournament Pass in URL or localStorage
    const savedPass = localStorage.getItem('ps_tournament_pass');
    const candidatePass = urlPass || savedPass;
    if (candidatePass) {
      void this.verifyTournamentPass(candidatePass.trim());
    } else {
      this.updateModeBanner();
    }

    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    this.renderer = new GameRenderer(canvas);
    this.input = new InputManager(() => this.audio.init());
    this.currentWorldState = this.localSim.getWorldStatePayload();

    this.applyHudTheme(this.cosmetics.hudTheme);
    this.bindUIEvents(canvas);
    this.connectWebSocket();
    void this.fetchLeaderboardHttp();
    void this.fetchTournamentTelemetry();
    setInterval(() => void this.fetchTournamentTelemetry(), 10000);

    requestAnimationFrame((now) => this.AnimationLoop(now));
  }

  private updateUrlRoomParam(code: string): void {
    // Keep only ?room=CODE so a reload never re-processes payment params.
    const url = new URL(window.location.href);
    url.search = code ? `?room=${encodeURIComponent(code)}` : '';
    window.history.replaceState({}, '', url.toString());
    const roomInput = document.getElementById('room-code-input') as HTMLInputElement | null;
    if (roomInput) roomInput.value = code;
  }

  private getShareUrl(): string {
    return `${window.location.origin}/?room=${encodeURIComponent(this.roomCode)}`;
  }

  private storageGet(store: Storage, key: string): string {
    try {
      return store.getItem(key) || '';
    } catch {
      return '';
    }
  }

  private storageSet(store: Storage, key: string, value: string | null): void {
    try {
      if (value === null) store.removeItem(key);
      else store.setItem(key, value);
    } catch {
      // Storage unavailable (private mode): reconnect falls back to joining as new player.
    }
  }

  /**
   * Session token for a room. sessionStorage = this tab (reload / reconnect →
   * reclaim the seat). localStorage = backup for a new tab (Payphone return,
   * reopened link); it only reclaims a seat that is disconnected, unless we
   * are coming back from a payment.
   */
  private getStoredSession(room: string): { token?: string; takeover: boolean } {
    const tabToken = this.storageGet(sessionStorage, `ps_session_${room}`);
    if (tabToken) return { token: tabToken, takeover: true };
    const backup = this.storageGet(localStorage, `ps_session_${room}`);
    if (backup) return { token: backup, takeover: this.isPaymentReturn };
    return { takeover: false };
  }

  private applyHudTheme(theme: CosmeticLoadout['hudTheme']): void {
    document.body.dataset.hudTheme = theme;
  }

  private saveCosmetics(): void {
    localStorage.setItem('ps_cosmetics', JSON.stringify(this.cosmetics));
    this.applyHudTheme(this.cosmetics.hudTheme);
    this.sendWsMessage({
      type: 'update_cosmetics',
      cosmetics: this.cosmetics
    });
  }

  private bindUIEvents(canvas: HTMLCanvasElement): void {
    const nameInput = document.getElementById('pilot-name-input') as HTMLInputElement | null;
    if (nameInput) {
      nameInput.value = this.pilotName;
      nameInput.addEventListener('change', () => {
        this.pilotName = (nameInput.value || 'PILOT').toUpperCase().slice(0, 16);
        localStorage.setItem('ps_pilot_name', this.pilotName);
        this.joinCurrentOnlineRoom();
      });
    }

    const roomInput = document.getElementById('room-code-input') as HTMLInputElement | null;
    if (roomInput) {
      roomInput.value = this.roomCode;
    }

    document.getElementById('btn-join-room')?.addEventListener('click', () => {
      this.audio.init();
      const code = normalizeRoomCode(roomInput?.value);
      if (code) {
        this.roomCode = code;
        this.roomFromUrl = true;
        this.mode = 'online';
        this.syncModeButtons();
        this.joinCurrentOnlineRoom();
      }
    });

    document.getElementById('btn-create-room')?.addEventListener('click', () => {
      this.audio.init();
      this.createNewRoom();
    });

    document.getElementById('room-status-line')?.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).dataset.roomAction;
      if (action === 'create') this.createNewRoom();
      if (action === 'reclaim') {
        this.sessionReplaced = false;
        this.renderRoomStatus();
        if (this.wsConnected) this.joinCurrentOnlineRoom();
        else this.connectWebSocket();
      }
      if (action === 'swap-accept' || action === 'swap-reject') {
        this.sendWsMessage({ type: 'respond_role_swap', accept: action === 'swap-accept' });
        this.pendingSwapRequest = null;
        this.renderRoomStatus();
      }
    });
    setInterval(() => this.renderRoomStatus(), 1000);

    document.getElementById('btn-copy-link')?.addEventListener('click', async () => {
      if (!this.roomCode || !this.lobbyState) return;
      const shareUrl = this.getShareUrl();
      try {
        await navigator.clipboard.writeText(shareUrl);
        const btn = document.getElementById('btn-copy-link');
        if (btn) {
          const prev = btn.textContent;
          btn.textContent = '¡ENLACE COPIADO!';
          setTimeout(() => {
            btn.textContent = prev;
          }, 2200);
        }
      } catch {
        prompt('Copia este enlace para compartir sala:', shareUrl);
      }
    });

    // Mode Selection Buttons
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.audio.init();
        const selected = btn.dataset.mode as GameMode;
        this.mode = selected;
        this.syncModeButtons();
        if (this.mode === 'online') {
          this.joinCurrentOnlineRoom();
        } else {
          this.localSim.setStatus('lobby');
          this.currentWorldState = this.localSim.getWorldStatePayload();
          this.updateOverlayVisibility();
        }
      });
    });

    // Role Selection Buttons
    // Online, the server owns roles: a taken seat needs the partner's OK.
    const requestRole = (role: PlayerRole) => {
      this.audio.init();
      if (this.mode === 'online') {
        this.sendWsMessage({ type: 'switch_role', role });
      } else {
        this.activeRole = role;
        this.syncRoleButtons();
      }
    };
    document.getElementById('btn-role-driver')?.addEventListener('click', () => requestRole('driver'));
    document.getElementById('btn-role-navigator')?.addEventListener('click', () => requestRole('navigator'));
    document.getElementById('btn-hud-swap-role')?.addEventListener('click', () =>
      requestRole(this.activeRole === 'driver' ? 'navigator' : 'driver')
    );

    // 9:16 TikTok Streamer Mode Toggle
    document.getElementById('btn-tiktok-mode')?.addEventListener('click', () => {
      this.isTikTokMode = !this.isTikTokMode;
      document.body.classList.toggle('tiktok-916-mode', this.isTikTokMode);
      const btn = document.getElementById('btn-tiktok-mode');
      if (btn) {
        btn.classList.toggle('active', this.isTikTokMode);
        btn.textContent = this.isTikTokMode ? '9:16 ON' : '9:16';
      }
    });

    // 1-Click Native Canvas Video+Audio Clip Recorder (.webm)
    document.getElementById('btn-record-clip')?.addEventListener('click', () => {
      this.toggleCanvasRecording(canvas);
    });

    // Selector de narrador (Natural / Radio / Off), recordado entre partidas
    const voiceLabels: Record<VoiceMode, string> = {
      es: 'VOZ: NATURAL',
      es_radio: 'VOZ: RADIO',
      off: 'VOZ: OFF'
    };
    const voiceBtn = document.getElementById('btn-voice-mode');
    if (voiceBtn) voiceBtn.textContent = voiceLabels[this.audio.getVoiceMode()];
    voiceBtn?.addEventListener('click', () => {
      this.audio.init();
      voiceBtn.textContent = voiceLabels[this.audio.cycleVoiceMode()];
    });

    // Background (storm ambience) volume: alto → medio → bajo → apagado, remembered per browser
    const ambienceLabels: Record<AmbienceLevel, string> = {
      alto: 'FONDO: ALTO',
      medio: 'FONDO: MEDIO',
      bajo: 'FONDO: BAJO',
      off: 'FONDO: OFF'
    };
    const ambienceBtn = document.getElementById('btn-ambience');
    if (ambienceBtn) ambienceBtn.textContent = ambienceLabels[this.audio.getAmbienceLevel()];
    ambienceBtn?.addEventListener('click', () => {
      this.audio.init();
      ambienceBtn.textContent = ambienceLabels[this.audio.cycleAmbienceLevel()];
    });

    // Master Audio Toggle
    document.getElementById('btn-mute-audio')?.addEventListener('click', () => {
      this.audio.init();
      const muted = this.audio.toggleMute();
      const btn = document.getElementById('btn-mute-audio');
      if (btn) btn.textContent = muted ? 'SONIDO: OFF' : 'SONIDO: ON';
    });

    // Live Tactical Comms Reaction Buttons
    document.querySelectorAll<HTMLButtonElement>('[data-comms]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.comms as TacticalCommsPreset;
        this.dispatchTacticalComms(preset);
      });
    });

    // Cosmetics Selectors
    const paintSelect = document.getElementById('select-paint') as HTMLSelectElement | null;
    const trailSelect = document.getElementById('select-trail') as HTMLSelectElement | null;
    const themeSelect = document.getElementById('select-theme') as HTMLSelectElement | null;

    if (paintSelect) {
      paintSelect.value = this.cosmetics.paintJob;
      paintSelect.addEventListener('change', () => {
        this.cosmetics.paintJob = paintSelect.value as CosmeticLoadout['paintJob'];
        this.saveCosmetics();
      });
    }
    if (trailSelect) {
      trailSelect.value = this.cosmetics.neonTrail;
      trailSelect.addEventListener('change', () => {
        this.cosmetics.neonTrail = trailSelect.value as CosmeticLoadout['neonTrail'];
        this.saveCosmetics();
      });
    }
    if (themeSelect) {
      themeSelect.value = this.cosmetics.hudTheme;
      themeSelect.addEventListener('change', () => {
        this.cosmetics.hudTheme = themeSelect.value as CosmeticLoadout['hudTheme'];
        this.saveCosmetics();
      });
    }

    // Banner Quick Action (Share pass or Switch to Tournament)
    document.getElementById('btn-banner-action')?.addEventListener('click', async () => {
      this.audio.init();
      if (this.isTournamentVerified && this.tournamentPass) {
        const passUrl = `${window.location.origin}/?pass=${encodeURIComponent(this.tournamentPass)}&room=${encodeURIComponent(this.roomCode)}`;
        try {
          await navigator.clipboard.writeText(passUrl);
          const btn = document.getElementById('btn-banner-action');
          if (btn) {
            const prev = btn.textContent;
            btn.textContent = '¡ENLACE DEL TORNEO COPIADO!';
            setTimeout(() => {
              btn.textContent = prev;
            }, 2000);
          }
        } catch {
          prompt('Copia este enlace para tu copiloto:', passUrl);
        }
      } else {
        this.switchHangarTab('hangar-tab-tournament');
      }
    });

    // STEP 01: Pre-Flight Verification Modal Trigger
    document.getElementById('btn-start-match')?.addEventListener('click', () => {
      this.audio.init();
      this.openLaunchConfirmationModal();
    });

    // Step 01 Modal Buttons
    document.getElementById('btn-execute-launch')?.addEventListener('click', () => {
      this.closeModal('modal-confirm-crew');
      this.audio.playNarratorCue('athena_online', true, true);
      this.triggerStartOrRematch();
    });

    document.getElementById('btn-crew-goto-tourney')?.addEventListener('click', () => {
      this.closeModal('modal-confirm-crew');
      this.switchHangarTab('hangar-tab-tournament');
    });

    document.getElementById('btn-close-confirm-crew')?.addEventListener('click', () => {
      this.closeModal('modal-confirm-crew');
    });

    document.getElementById('btn-cancel-launch')?.addEventListener('click', () => {
      this.closeModal('modal-confirm-crew');
    });

    // Instant Rematch & Back to Lobby
    document.getElementById('btn-instant-rematch')?.addEventListener('click', () => {
      this.audio.init();
      this.audio.playNarratorCue('athena_online', true, true);
      this.triggerStartOrRematch();
    });

    document.getElementById('btn-back-lobby')?.addEventListener('click', () => {
      if (this.mode === 'online') {
        const gameoverModal = document.getElementById('modal-gameover');
        const lobbyModal = document.getElementById('modal-lobby');
        gameoverModal?.classList.add('hidden');
        lobbyModal?.classList.remove('hidden');
      } else {
        this.localSim.setStatus('lobby');
        this.currentWorldState = this.localSim.getWorldStatePayload();
        this.updateOverlayVisibility();
      }
    });

    // Rewarded Ad 5s Emergency Field Repair Hook
    document.getElementById('btn-watch-ad')?.addEventListener('click', () => {
      this.audio.init();
      this.startRewardedAdCountdown();
    });

    document.getElementById('btn-decline-ad')?.addEventListener('click', () => {
      if (this.mode === 'online') {
        this.sendWsMessage({ type: 'decline_rewarded_ad' });
      } else {
        this.localSim.declineRewardedAd();
        this.currentWorldState = this.localSim.getWorldStatePayload();
        this.recordLocalScoreIfNeeded();
        this.updateOverlayVisibility();
      }
    });

    // Canvas click/tap for Navigator direct lane ping
    canvas.addEventListener('pointerdown', (e) => {
      this.audio.init();
      if (this.activeRole === 'navigator' || this.mode === 'local_coop') {
        const lane = this.renderer.getLaneFromCanvasPoint(e.clientX);
        if (lane !== null) {
          this.input.triggerCanvasLanePing(lane);
        }
      }
    });

    // Bind Mobile / Touch Controls
    this.input.bindTouchControls(
      document.getElementById('touch-joystick-zone'),
      document.getElementById('touch-joystick-knob'),
      document.getElementById('btn-touch-shield-left'),
      document.getElementById('btn-touch-shield-right'),
      document.getElementById('btn-touch-ping'),
      document.getElementById('btn-touch-radar')
    );

    // Hangar Navigation Tab Switching
    document.querySelectorAll<HTMLButtonElement>('[data-hangar-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.audio.init();
        const tabId = btn.dataset.hangarTab;
        if (tabId) this.switchHangarTab(tabId);
      });
    });

    // STEP 02: Tournament Payment Confirmation Modal Trigger
    document.getElementById('btn-tourney-pay')?.addEventListener('click', () => {
      this.audio.init();
      this.openTourneyConfirmationModal();
    });

    // Step 02 Modal Buttons
    document.getElementById('btn-execute-tourney-pay')?.addEventListener('click', async () => {
      this.closeModal('modal-confirm-tourney');
      await this.executePayphoneLinkCreation();
    });

    document.getElementById('btn-open-redeem-from-tourney')?.addEventListener('click', () => {
      this.closeModal('modal-confirm-tourney');
      this.openModal('modal-redeem-pass-view');
    });

    document.getElementById('btn-close-confirm-tourney')?.addEventListener('click', () => {
      this.closeModal('modal-confirm-tourney');
    });

    document.getElementById('btn-cancel-confirm-tourney')?.addEventListener('click', () => {
      this.closeModal('modal-confirm-tourney');
    });

    // Redeem Pass Logic (Tab 2 Inline Box & Dedicated Sub-Modal)
    document.getElementById('btn-redeem-pass')?.addEventListener('click', async () => {
      this.audio.init();
      const input = document.getElementById('tourney-pass-redeem-input') as HTMLInputElement | null;
      const feedback = document.getElementById('redeem-feedback');
      if (input && feedback) {
        await this.handlePassRedemption(input.value, feedback);
      }
    });

    document.getElementById('btn-execute-modal-redeem')?.addEventListener('click', async () => {
      this.audio.init();
      const input = document.getElementById('modal-pass-input') as HTMLInputElement | null;
      const feedback = document.getElementById('modal-redeem-feedback');
      if (input && feedback) {
        const ok = await this.handlePassRedemption(input.value, feedback);
        if (ok) {
          setTimeout(() => this.closeModal('modal-redeem-pass-view'), 1500);
        }
      }
    });

    document.getElementById('btn-close-redeem-modal')?.addEventListener('click', () => {
      this.closeModal('modal-redeem-pass-view');
    });

    document.getElementById('btn-cancel-redeem-modal')?.addEventListener('click', () => {
      this.closeModal('modal-redeem-pass-view');
    });

    // STEP 03: Armory Loadout Confirmation
    document.getElementById('btn-save-loadout')?.addEventListener('click', () => {
      this.audio.init();
      this.openLoadoutConfirmationModal();
    });

    document.getElementById('btn-execute-save-loadout')?.addEventListener('click', () => {
      this.saveCosmetics();
      this.closeModal('modal-confirm-loadout');
      this.audio.playNarratorCue('athena_online', false);
    });

    document.getElementById('btn-close-confirm-loadout')?.addEventListener('click', () => {
      this.closeModal('modal-confirm-loadout');
    });

    document.getElementById('btn-cancel-confirm-loadout')?.addEventListener('click', () => {
      this.closeModal('modal-confirm-loadout');
    });

    // STEP 04: Leaderboard Filter Controls
    document.getElementById('btn-lb-filter-all')?.addEventListener('click', () => {
      this.audio.init();
      this.setLeaderboardFilter('all');
    });

    document.getElementById('btn-lb-filter-tourney')?.addEventListener('click', () => {
      this.audio.init();
      this.setLeaderboardFilter('tourney');
    });

    document.getElementById('btn-lb-filter-practice')?.addEventListener('click', () => {
      this.audio.init();
      this.setLeaderboardFilter('practice');
    });

    this.syncModeButtons();
    this.syncRoleButtons();
  }

  private dispatchTacticalComms(preset: TacticalCommsPreset): void {
    this.audio.init();
    if (this.mode === 'online' && this.wsConnected) {
      this.sendWsMessage({ type: 'send_comms', preset });
    } else {
      const info = LOCAL_COMMS_MAP[preset];
      const event: TacticalCommsEvent = {
        id: `local-comms-${Date.now()}`,
        sender_name: this.pilotName,
        sender_role: this.activeRole,
        preset,
        code: info.code,
        label: info.label,
        timestamp: Date.now()
      };
      this.renderer.showCommsBanner(event);
      this.audio.playCommsTransmission(preset);
    }
  }

  private toggleCanvasRecording(canvas: HTMLCanvasElement): void {
    const btn = document.getElementById('btn-record-clip');
    if (this.isRecordingClip && this.mediaRecorder) {
      this.mediaRecorder.stop();
      this.isRecordingClip = false;
      if (btn) {
        btn.textContent = 'GRABAR CLIP';
        btn.classList.remove('recording-active');
      }
      return;
    }

    try {
      this.audio.init();
      const videoStream = canvas.captureStream(60);
      const audioTracks = this.audio.getRecordingAudioTracks();
      const combinedStream = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...audioTracks
      ]);

      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : 'video/webm';

      this.recordedChunks = [];
      this.mediaRecorder = new MediaRecorder(combinedStream, { mimeType });

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.recordedChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `PACIFIC_SPEED_916_${Date.now()}.webm`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      };

      this.mediaRecorder.start();
      this.isRecordingClip = true;
      if (btn) {
        btn.textContent = 'DETENER Y GUARDAR';
        btn.classList.add('recording-active');
      }
    } catch {
      alert('Tu navegador no soporta grabación directa de Canvas.');
    }
  }

  private triggerStartOrRematch(): void {
    this.audio.resetStreak();
    this.evaluatedNearMissIds.clear();
    this.nextScoreMilestone = 3000;

    if (this.mode === 'online' && this.wsConnected) {
      this.sendWsMessage({ type: 'start_match' });
    } else {
      this.localSim.startMatch();
      this.currentWorldState = this.localSim.getWorldStatePayload();
      this.updateOverlayVisibility();
    }
  }

  private evaluateHypeMoments(state: ServerWorldStatePayload): void {
    if (state.world_state.status !== 'running') return;

    // 1. Score Milestone Narration
    if (state.world_state.total_score >= this.nextScoreMilestone) {
      this.nextScoreMilestone += 5000;
      this.audio.playNarratorCue('cmd_milestone', true);
      this.renderer.triggerCustomCallout(
        '¡NUEVO RÉCORD DE PATRULLA!',
        `Superaste ${(this.nextScoreMilestone - 5000).toLocaleString()} puntos`,
        '#ffc94d'
      );
    }

    // 2. Razor Close Call (Near-Miss) Detection
    const mecha = state.entity_positions.mecha;
    for (const obs of state.entity_positions.obstacles) {
      if (this.evaluatedNearMissIds.has(obs.id)) continue;
      if (obs.type === 'overdrive_cell' || obs.type === 'repair_cell') continue;

      // Check when obstacle just passed the Mecha's Y plane closely without hitting
      const dy = obs.y - mecha.y;
      if (dy > 38 && dy < 75) {
        this.evaluatedNearMissIds.add(obs.id);
        const dx = Math.abs(obs.x - mecha.x);
        if (dx > 38 && dx < 96 && state.speed_multiplier.current_speed >= 120) {
          this.audio.playNarratorCue('cmd_close_call', false);
          this.renderer.triggerCustomCallout(
            '¡UFF, POR POCO!',
            'Esquivaste a milímetros',
            '#7ee8d8'
          );
        }
      }
    }

    if (this.evaluatedNearMissIds.size > 80) {
      this.evaluatedNearMissIds.clear();
    }
  }

  private startRewardedAdCountdown(): void {
    if (this.adCountdownInterval !== null) return;
    const btnWatch = document.getElementById('btn-watch-ad') as HTMLButtonElement | null;
    const btnDecline = document.getElementById('btn-decline-ad') as HTMLButtonElement | null;
    const progressEl = document.getElementById('ad-progress-bar');
    const statusText = document.getElementById('ad-timer-text');

    if (btnWatch) btnWatch.disabled = true;
    if (btnDecline) btnDecline.disabled = true;

    let remaining = 5.0;
    this.adCountdownInterval = window.setInterval(() => {
      remaining = Math.max(0, remaining - 0.1);
      const pct = ((5.0 - remaining) / 5.0) * 100;
      if (progressEl) progressEl.style.width = `${pct}%`;
      if (statusText) {
        statusText.textContent = `El equipo veterinario está reparando tu vehículo... ${remaining.toFixed(1)} s`;
      }

      if (remaining <= 0) {
        if (this.adCountdownInterval !== null) {
          clearInterval(this.adCountdownInterval);
          this.adCountdownInterval = null;
        }
        if (btnWatch) btnWatch.disabled = false;
        if (btnDecline) btnDecline.disabled = false;
        if (progressEl) progressEl.style.width = '0%';
        if (statusText) {
          statusText.textContent =
            'Mira un video de 5 segundos y el equipo veterinario deja tu vehículo al 100% para seguir rescatando.';
        }

        if (this.mode === 'online' && this.wsConnected) {
          this.sendWsMessage({ type: 'watch_rewarded_ad' });
        } else {
          this.localSim.reviveWithRewardedAd();
          this.currentWorldState = this.localSim.getWorldStatePayload();
          this.updateOverlayVisibility();
        }
      }
    }, 100);
  }

  private connectWebSocket(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
      this.ws = new WebSocket(wsUrl);
      this.ws.addEventListener('open', () => {
        this.wsConnected = true;
        this.updateConnectionBadge(true);
        if (this.mode === 'online') {
          this.joinCurrentOnlineRoom();
        }
      });

      this.ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(event.data as string) as WsServerMessage;
          this.handleServerMessage(msg);
        } catch {
          // Ignore malformed packet
        }
      });

      this.ws.addEventListener('close', () => {
        this.wsConnected = false;
        this.updateConnectionBadge(false);
        // Another tab took this seat: don't fight it back automatically.
        if (!this.sessionReplaced) {
          setTimeout(() => this.connectWebSocket(), 2500);
        }
        this.renderRoomStatus();
      });
    } catch {
      this.wsConnected = false;
      this.updateConnectionBadge(false);
    }
  }

  private joinCurrentOnlineRoom(): void {
    if (this.sessionReplaced) return;
    if (!this.roomCode) {
      this.createNewRoom();
      return;
    }
    const session = this.getStoredSession(this.roomCode);
    this.sendWsMessage({
      type: 'join_room',
      room_code: this.roomCode,
      name: this.pilotName,
      cosmetics: this.cosmetics,
      session_token: session.token,
      takeover: session.takeover
    });
  }

  private createNewRoom(): void {
    this.roomError = null;
    this.roomFromUrl = false;
    this.mode = 'online';
    this.syncModeButtons();
    this.sendWsMessage({
      type: 'create_room',
      name: this.pilotName,
      preferred_role: this.activeRole,
      cosmetics: this.cosmetics
    });
  }

  /** In flight the lobby status line is hidden, so flash a callout instead. */
  private notifyPartnerConnectionChange(prev: RoomLobbyState | null, next: RoomLobbyState): void {
    if (!prev || next.status === 'lobby') return;
    const before = prev.players.find((p) => p.player_id !== this.playerId);
    const after = next.players.find((p) => p.player_id !== this.playerId);
    if (before?.connected && after && !after.connected) {
      this.renderer.triggerCustomCallout('TU PAREJA SE DESCONECTÓ', 'La IA ayuda mientras vuelve (30 s)', '#ffc94d');
    } else if (before && !before.connected && after?.connected) {
      this.renderer.triggerCustomCallout('¡TU PAREJA VOLVIÓ!', `${after.name} está de nuevo en la patrulla`, '#7bd88f');
    } else if (before && !after) {
      this.renderer.triggerCustomCallout('TU PAREJA SALIÓ DE LA SALA', 'La IA te acompaña', '#ff5a5f');
    }
  }

  private handleRoomError(code: RoomErrorCode, message: string, room?: string): void {
    if (code === 'not_allowed') {
      this.roomError = { code, message };
      this.renderRoomStatus();
      setTimeout(() => {
        if (this.roomError?.code === 'not_allowed') {
          this.roomError = null;
          this.renderRoomStatus();
        }
      }, 4000);
      return;
    }

    // The room is gone: forget it. ("full" keeps it: the stored token may belong to another tab.)
    if (room && (code === 'not_found' || code === 'expired')) {
      if (this.storageGet(localStorage, 'ps_last_room') === room) {
        this.storageSet(localStorage, 'ps_last_room', null);
      }
      this.storageSet(localStorage, `ps_session_${room}`, null);
      this.storageSet(sessionStorage, `ps_session_${room}`, null);
    }

    // Stale "last room" fallback (not a link someone shared): just start a new room.
    if (!this.roomFromUrl && (code === 'not_found' || code === 'invalid_code' || code === 'expired')) {
      this.createNewRoom();
      return;
    }

    this.roomError = { code, message };
    this.lobbyState = null;
    this.renderLobbyPlayers();
    this.renderRoomStatus();
  }

  private renderRoomStatus(): void {
    const el = document.getElementById('room-status-line');
    if (!el) return;

    const set = (html: string, tone: 'info' | 'ok' | 'warn' | 'error') => {
      if (el.innerHTML !== html) el.innerHTML = html;
      el.dataset.tone = tone;
      el.classList.toggle('hidden', html === '');
    };
    const fmt = (ms: number) => {
      const s = Math.max(0, Math.ceil(ms / 1000));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    const btn = (action: string, label: string) =>
      `<button class="btn room-status-btn" data-room-action="${action}">${label}</button>`;

    if (this.mode !== 'online') return set('', 'info');
    if (this.sessionReplaced) {
      return set(`[AVISO] Esta sala se abrió en otra pestaña o dispositivo. ${btn('reclaim', 'Usar aquí')}`, 'warn');
    }
    if (this.roomError && this.roomError.code !== 'not_allowed') {
      const icon = this.roomError.code === 'full' ? '[SALA LLENA]' : '[AVISO]';
      return set(`${icon} ${escapeHtml(this.roomError.message)} ${btn('create', 'Crear sala nueva')}`, 'error');
    }
    if (!this.wsConnected) return set('[ENLACE] Reconectando con el servidor…', 'warn');
    if (!this.lobbyState) return set('[ENLACE] Conectando a la sala…', 'info');

    const transient = this.roomError ? ` <br>[AVISO] ${escapeHtml(this.roomError.message)}` : '';
    const roleName = (r: PlayerRole) => (r === 'driver' ? 'PILOTO' : 'NAVEGANTE');

    if (this.pendingSwapRequest) {
      return set(
        `[SOLICITUD] <strong>${escapeHtml(this.pendingSwapRequest.from_name)}</strong> quiere cambiar a ${roleName(this.pendingSwapRequest.requested_role)} (intercambiar roles). ${btn('swap-accept', 'Aceptar')} ${btn('swap-reject', 'Rechazar')}`,
        'info'
      );
    }

    const players = this.lobbyState.players;
    const me = players.find((p) => p.player_id === this.playerId);
    const partner = players.find((p) => p.player_id !== this.playerId);
    const swap = this.lobbyState.pending_role_swap;

    if (!partner) {
      return set(`[ESPERANDO] Esperando copiloto… comparte el enlace de la sala <strong>${this.roomCode}</strong>.${transient}`, 'info');
    }
    if (!partner.connected) {
      const left = (partner.grace_remaining_ms ?? 0) - (Date.now() - this.lobbyReceivedAt);
      return set(`[DESCONECTADO] Tu copiloto se desconectó (reconectando ${fmt(left)})${transient}`, 'warn');
    }
    if (swap && swap.from_player_id === this.playerId) {
      return set(`[SOLICITUD] Solicitud de cambio de rol enviada a ${escapeHtml(partner.name)}…${transient}`, 'info');
    }
    if (me?.ready && !partner.ready) {
      return set(`[LISTO] Listo. Esperando a que ${escapeHtml(partner.name)} confirme el despegue…${transient}`, 'ok');
    }
    if (partner.ready && !me?.ready) {
      return set(`[LISTO] ${escapeHtml(partner.name)} está listo para despegar. Confirma tu despegue.${transient}`, 'ok');
    }
    return set(`[CONECTADOS] Pareja conectada: <strong>${escapeHtml(partner.name)}</strong> (${roleName(partner.role)}).${transient}`, 'ok');
  }

  private sendWsMessage(msg: WsClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleServerMessage(msg: WsServerMessage): void {
    switch (msg.type) {
      case 'room_joined':
        this.roomCode = msg.room_code;
        this.playerId = msg.player_id;
        this.activeRole = msg.assigned_role;
        this.lobbyState = msg.lobby;
        this.lobbyReceivedAt = Date.now();
        this.roomError = null;
        this.roomFromUrl = true;
        this.isPaymentReturn = false;
        this.storageSet(sessionStorage, `ps_session_${msg.room_code}`, msg.session_token);
        this.storageSet(localStorage, `ps_session_${msg.room_code}`, msg.session_token);
        this.storageSet(localStorage, 'ps_last_room', msg.room_code);
        this.updateConnectionBadge(this.wsConnected);
        if (this.tournamentPass) {
          // Bind our own pass to this room (the server never broadcasts pass codes)
          this.sendWsMessage({ type: 'set_tournament_pass', pass_code: this.tournamentPass });
        } else if (msg.lobby.is_tournament_verified) {
          this.isTournamentVerified = true;
          this.updateModeBanner();
        }
        this.updateUrlRoomParam(this.roomCode);
        this.syncRoleButtons();
        this.renderLobbyPlayers();
        this.renderRoomStatus();
        this.updateOverlayVisibility();
        break;

      case 'room_error':
        this.handleRoomError(msg.code, msg.message, msg.room_code);
        break;

      case 'session_replaced':
        this.sessionReplaced = true;
        this.lobbyState = null;
        this.renderRoomStatus();
        break;

      case 'role_swap_request':
        this.pendingSwapRequest = { from_name: msg.from_name, requested_role: msg.requested_role };
        this.renderRoomStatus();
        break;

      case 'lobby_update':
        if (msg.lobby.room_code !== this.roomCode) break;
        this.notifyPartnerConnectionChange(this.lobbyState, msg.lobby);
        this.lobbyState = msg.lobby;
        this.lobbyReceivedAt = Date.now();
        if (!msg.lobby.pending_role_swap) this.pendingSwapRequest = null;
        if (msg.lobby.is_tournament_verified && !this.isTournamentVerified) {
          // A teammate activated their pass in this room; we do not receive the code itself
          this.isTournamentVerified = true;
          this.updateModeBanner();
        }
        const me = msg.lobby.players.find((p) => p.player_id === this.playerId);
        if (me) {
          this.activeRole = me.role;
          this.syncRoleButtons();
        }
        this.renderLobbyPlayers();
        this.renderRoomStatus();
        this.updateOverlayVisibility();
        break;

      case 'world_state':
        if (this.mode === 'online') {
          const prevStatus = this.currentWorldState.world_state.status;
          this.currentWorldState = msg.payload;
          this.serverClock.observe(msg.payload.tick, performance.now());
          this.audio.processServerEvents(msg.payload.world_state.events);
          this.evaluateHypeMoments(msg.payload);
          // Rebuilding the lobby DOM 30-60 times per second caused stutter: only on status change
          if (msg.payload.world_state.status !== prevStatus) {
            if (msg.payload.world_state.status === 'running' && prevStatus !== 'ad_revive_prompt') {
              this.driverPredictor.reset();
            }
            this.updateOverlayVisibility();
          }
        }
        break;

      case 'comms_broadcast':
        this.renderer.showCommsBanner(msg.event);
        this.audio.playCommsTransmission(msg.event.preset);
        break;

      case 'leaderboard_update':
        this.leaderboard = msg.entries;
        this.renderLeaderboard();
        break;
    }
  }

  private async fetchLeaderboardHttp(): Promise<void> {
    try {
      const res = await fetch('/api/leaderboard');
      if (res.ok) {
        const data = (await res.json()) as { entries: LeaderboardEntry[] };
        this.leaderboard = data.entries;
        this.renderLeaderboard();
      }
    } catch {
      // Offline fallback
    }
  }

  private recordLocalScoreIfNeeded(): void {
    // Local/offline runs are simulated in the browser, so they are never sent to the server:
    // the official leaderboard only contains scores computed by the server (online rooms).
    const ws = this.currentWorldState.world_state;
    const localEntry: LeaderboardEntry = {
      id: `local-${Date.now()}`,
      room_code: this.mode === 'local_coop' ? 'LOCAL-2P' : 'SOLO-AI',
      driver_name: this.activeRole === 'driver' ? this.pilotName : 'IA_APOYO',
      navigator_name: this.activeRole === 'navigator' ? this.pilotName : 'IA_APOYO',
      total_score: ws.total_score,
      distance_traveled: ws.distance_traveled,
      survival_time: ws.survival_time,
      region: 'LOCAL-SIM',
      created_at: new Date().toISOString(),
      is_tournament: false
    };
    this.leaderboard = [...this.leaderboard, localEntry].sort((a, b) => b.total_score - a.total_score);
    this.renderLeaderboard();
  }

  private AnimationLoop(now: number): void {
    const dt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;

    let driverPredictedInputX = 0;
    // What gets drawn: the authoritative state advanced to "now" (never changes the rules)
    let renderState = this.currentWorldState;

    if (this.mode === 'online') {
      const latest = this.currentWorldState;
      if (latest.world_state.status === 'running') {
        // Inputs: at most ~60 per second whatever the monitor refresh rate
        this.driverPredictor.advance(dt);
        if (now - this.lastInputSentAt >= TICK_MS - 1) {
          this.lastInputSentAt = now;
          const inputPayload: ClientInputPayload = this.input.sampleInputPayload(
            this.playerId,
            this.activeRole
          );
          this.sendWsMessage({ type: 'player_input', payload: inputPayload });
          if (this.activeRole === 'driver') {
            this.driverPredictor.recordSent(inputPayload.seq, inputPayload.input_vector.x, inputPayload.input_vector.y);
          }
        }

        // Advance the last server state to the estimated server time of this frame
        const estTick = this.serverClock.estimateTick(now);
        if (estTick !== null) {
          renderState = extrapolateWorld(latest, ((estTick - latest.tick) * TICK_MS) / 1000);
        }

        // The driver sees their own vehicle respond instantly (prediction, corrected by the server)
        if (this.activeRole === 'driver') {
          const ack = latest.input_acks?.[this.playerId];
          const predicted = this.driverPredictor.predict(
            latest.entity_positions.mecha.x,
            latest.entity_positions.mecha.y,
            ack
          );
          renderState = {
            ...renderState,
            entity_positions: {
              ...renderState.entity_positions,
              mecha: { ...renderState.entity_positions.mecha, x: predicted.x, y: predicted.y }
            }
          };
        }
      }
    } else {
      if (this.localSim.getStatus() === 'running') {
        // Fixed timestep: 60 simulation steps per real second on any monitor (60/120/144 Hz)
        this.localAccumulator = Math.min(this.localAccumulator + dt, 0.25);
        let steps = 0;
        while (this.localAccumulator >= 1 / 60 && steps < 6 && this.localSim.getStatus() === 'running') {
          this.localAccumulator -= 1 / 60;
          steps++;
          if (this.mode === 'local_coop') {
            const driverInput = this.input.sampleInputPayload(this.playerId, 'driver');
            const navInput = this.input.sampleInputPayload(this.playerId, 'navigator');
            driverPredictedInputX = driverInput.input_vector.x;
            this.localSim.applyPlayerInput(driverInput);
            this.localSim.applyPlayerInput(navInput);
          } else {
            const humanInput = this.input.sampleInputPayload(this.playerId, this.activeRole);
            driverPredictedInputX = humanInput.input_vector.x;
            this.localSim.applyPlayerInput(humanInput);
            const botRole: PlayerRole = this.activeRole === 'driver' ? 'navigator' : 'driver';
            this.localSim.updateBotCoPilot(botRole);
          }

          const prevStatus = this.localSim.getStatus();
          this.currentWorldState = this.localSim.step(1 / 60);
          this.audio.processServerEvents(this.currentWorldState.world_state.events);
          this.evaluateHypeMoments(this.currentWorldState);

          if (this.currentWorldState.world_state.status !== prevStatus) {
            if (this.currentWorldState.world_state.status === 'gameover') {
              this.recordLocalScoreIfNeeded();
            }
            this.updateOverlayVisibility();
          }
        }
        // Frames between steps (high refresh monitors) are drawn advanced, not repeated
        renderState = extrapolateWorld(this.currentWorldState, this.localAccumulator);
      } else {
        this.localAccumulator = 0;
      }
    }

    const isRunning = this.currentWorldState.world_state.status === 'running';
    const currentSpeed = this.currentWorldState.speed_multiplier.current_speed;
    const isCritical =
      isRunning &&
      currentSpeed < this.currentWorldState.speed_multiplier.critical_threshold;
    const ws = this.currentWorldState.world_state;
    this.audio.updateTelemetryAudio(isRunning, currentSpeed, isCritical, ws.integrity / ws.max_integrity);

    this.renderer.render(
      renderState,
      this.activeRole,
      this.cosmetics,
      driverPredictedInputX,
      dt
    );

    this.updateHudTelemetry();

    requestAnimationFrame((nextNow) => this.AnimationLoop(nextNow));
  }

  private updateHudTelemetry(): void {
    const ws = this.currentWorldState.world_state;
    const sm = this.currentWorldState.speed_multiplier;

    const setTxt = (id: string, text: string) => {
      const el = document.getElementById(id);
      if (el && el.textContent !== text) el.textContent = text;
    };

    setTxt('hud-score', ws.total_score.toLocaleString());
    setTxt('hud-speed', `${Math.round(sm.current_speed)}`);
    setTxt('hud-distance', `${ws.distance_traveled.toFixed(0)} m`);
    setTxt('hud-rescued', `${rescuedCount(ws.distance_traveled)}`);
    setTxt('hud-integrity-text', `${Math.round(ws.integrity)}%`);
    setTxt('hud-shield-text', `${Math.round(ws.active_shields.energy)}%`);
    setTxt(
      'hud-role-badge',
      this.activeRole === 'driver'
        ? 'PILOTO · MANEJAS EL VEHÍCULO'
        : 'NAVEGANTE · ESCUDOS Y RADAR'
    );

    const integrityBar = document.getElementById('hud-integrity-bar');
    if (integrityBar) {
      integrityBar.style.width = `${(ws.integrity / ws.max_integrity) * 100}%`;
    }

    const shieldBar = document.getElementById('hud-shield-bar');
    if (shieldBar) {
      shieldBar.style.width = `${(ws.active_shields.energy / ws.active_shields.max_energy) * 100}%`;
    }

    const overdriveBadge = document.getElementById('hud-overdrive-badge');
    if (overdriveBadge) {
      if (ws.is_overdrive) {
        overdriveBadge.classList.remove('hidden');
        overdriveBadge.textContent = `TURBO CROQUETA · PUNTOS x2 (${ws.overdrive_timer.toFixed(1)} s)`;
      } else {
        overdriveBadge.classList.add('hidden');
      }
    }
  }

  private updateConnectionBadge(online: boolean): void {
    const el = document.getElementById('ws-status-badge');
    if (!el) return;
    if (online) {
      el.textContent = `EN LÍNEA · SALA ${this.roomCode}`;
      el.classList.add('status-online');
      el.classList.remove('status-offline');
    } else {
      el.textContent = 'SIN CONEXIÓN · MODO LOCAL';
      el.classList.add('status-offline');
      el.classList.remove('status-online');
    }
  }

  private syncModeButtons(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === this.mode);
    });
  }

  private syncRoleButtons(): void {
    document
      .getElementById('btn-role-driver')
      ?.classList.toggle('active', this.activeRole === 'driver');
    document
      .getElementById('btn-role-navigator')
      ?.classList.toggle('active', this.activeRole === 'navigator');
  }

  private renderLobbyPlayers(): void {
    const container = document.getElementById('lobby-players-list');
    if (!container) return;

    if (this.mode !== 'online') {
      container.innerHTML = `
        <div class="crew-slot">
          <span class="slot-role">ASIENTO 1 // PILOTO</span>
          <span class="slot-name">${escapeHtml(this.activeRole === 'driver' ? this.pilotName : 'IA CO-PILOTO')}</span>
        </div>
        <div class="crew-slot">
          <span class="slot-role">ASIENTO 2 // NAVEGANTE</span>
          <span class="slot-name">${escapeHtml(this.activeRole === 'navigator' ? this.pilotName : this.mode === 'local_coop' ? 'OPERADOR 2 (TECLADO)' : 'IA CO-PILOTO')}</span>
        </div>
      `;
      return;
    }

    const players = this.lobbyState?.players || [];
    const driver = players.find((p) => p.role === 'driver');
    const navigator = players.find((p) => p.role === 'navigator');

    const seatLabel = (p: RoomPlayerInfo | undefined, empty: string) => {
      if (!p) return empty;
      const you = p.player_id === this.playerId ? ' (TÚ)' : '';
      const state = !p.connected ? ' · [DESCONECTADO]' : p.ready ? ' · [LISTO]' : '';
      return `${escapeHtml(p.name)}${you}${state}`;
    };

    container.innerHTML = `
      <div class="crew-slot ${driver ? 'filled' : ''}">
        <span class="slot-role">ASIENTO 1 // PILOTO</span>
        <span class="slot-name">${seatLabel(driver, 'IA AUTO-PILOTO')}</span>
      </div>
      <div class="crew-slot ${navigator ? 'filled' : ''}">
        <span class="slot-role">ASIENTO 2 // NAVEGANTE</span>
        <span class="slot-name">${seatLabel(navigator, 'IA CO-PILOTO')}</span>
      </div>
    `;
  }

  private renderLeaderboard(): void {
    const tbody = document.getElementById('leaderboard-body');
    if (!tbody) return;

    let entries = this.leaderboard;
    if (this.leaderboardFilter === 'tourney') {
      entries = entries.filter((e) => Boolean(e.is_tournament));
    } else if (this.leaderboardFilter === 'practice') {
      entries = entries.filter((e) => !e.is_tournament);
    }

    if (entries.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:14px;">No hay registros para este filtro</td></tr>`;
      return;
    }

    tbody.innerHTML = entries
      .slice(0, 10)
      .map(
        (entry, idx) => `
        <tr>
          <td>0${idx + 1}</td>
          <td>${escapeHtml(entry.driver_name)} / ${escapeHtml(entry.navigator_name)}</td>
          <td style="color: var(--accent); font-weight: 700">${Number(entry.total_score).toLocaleString()}</td>
          <td>${Number(entry.distance_traveled).toFixed(0)} m · 🐾 ${rescuedCount(Number(entry.distance_traveled))}</td>
          <td>${entry.is_tournament ? '<span style="color:var(--accent);font-weight:700;">TORNEO</span>' : '<span style="color:var(--phosphor);">PRÁCTICA</span>'}</td>
        </tr>
      `
      )
      .join('');
  }

  private setLeaderboardFilter(filter: 'all' | 'tourney' | 'practice'): void {
    this.leaderboardFilter = filter;
    document.getElementById('btn-lb-filter-all')?.classList.toggle('active', filter === 'all');
    document.getElementById('btn-lb-filter-tourney')?.classList.toggle('active', filter === 'tourney');
    document.getElementById('btn-lb-filter-practice')?.classList.toggle('active', filter === 'practice');
    this.renderLeaderboard();
  }

  public openModal(modalId: string): void {
    const el = document.getElementById(modalId);
    if (el) el.classList.remove('hidden');
  }

  public closeModal(modalId: string): void {
    const el = document.getElementById(modalId);
    if (el) el.classList.add('hidden');
  }

  public switchHangarTab(tabId: string): void {
    document.querySelectorAll('[data-hangar-tab]').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.hangar-panel').forEach((p) => p.classList.remove('active'));
    const btn = document.querySelector(`[data-hangar-tab="${tabId}"]`);
    btn?.classList.add('active');
    document.getElementById(tabId)?.classList.add('active');
  }

  private openLaunchConfirmationModal(): void {
    const pilotNameEl = document.getElementById('confirm-pilot-name');
    const pilotRoleEl = document.getElementById('confirm-pilot-role');
    const roomCodeEl = document.getElementById('confirm-room-code');
    const copilotStatusEl = document.getElementById('confirm-copilot-status');
    const flightModeEl = document.getElementById('confirm-flight-mode');
    const execBtn = document.getElementById('btn-execute-launch');
    const tourneyGotoBtn = document.getElementById('btn-crew-goto-tourney');

    if (pilotNameEl) pilotNameEl.textContent = this.pilotName;
    if (pilotRoleEl) {
      pilotRoleEl.textContent = this.activeRole === 'driver' ? 'PILOTO' : 'NAVEGANTE';
    }
    if (roomCodeEl) roomCodeEl.textContent = this.roomCode;

    if (copilotStatusEl) {
      const players = this.lobbyState?.players || [];
      const copilot = players.find((p) => p.player_id !== this.playerId);
      if (this.mode !== 'online') {
        copilotStatusEl.textContent = this.mode === 'local_coop' ? 'JUGADOR 2 (MISMO TECLADO)' : 'IA DE APOYO';
        copilotStatusEl.style.color = 'var(--cyan)';
      } else if (copilot) {
        copilotStatusEl.textContent = `CONECTADA · ${copilot.name} (${copilot.role === 'driver' ? 'PILOTO' : 'NAVEGANTE'})`;
        copilotStatusEl.style.color = 'var(--phosphor)';
      } else {
        copilotStatusEl.textContent = 'EN ESPERA (LA IA TE ACOMPAÑA SI NO LLEGA)';
        copilotStatusEl.style.color = 'var(--accent)';
      }
    }

    if (this.isTournamentVerified && this.tournamentPass) {
      if (flightModeEl) {
        flightModeEl.textContent = `TORNEO OFICIAL · PASE ${this.tournamentPass}`;
        flightModeEl.style.color = '#ffb703';
      }
      if (execBtn) execBtn.textContent = '¡SALIR AL RESCATE! (TORNEO)';
      if (tourneyGotoBtn) tourneyGotoBtn.style.display = 'none';
    } else {
      if (flightModeEl) {
        flightModeEl.textContent = 'PRACTICA LIBRE (100% GRATIS)';
        flightModeEl.style.color = 'var(--phosphor)';
      }
      if (execBtn) execBtn.textContent = '¡SALIR AL RESCATE! (PRÁCTICA)';
      if (tourneyGotoBtn) tourneyGotoBtn.style.display = 'block';
    }

    this.openModal('modal-confirm-crew');
  }

  private openTourneyConfirmationModal(): void {
    const pilotEl = document.getElementById('confirm-tourney-pilot');
    const copilotEl = document.getElementById('confirm-tourney-copilot');
    const refEl = document.getElementById('confirm-tourney-ref');
    const phoneEl = document.getElementById('confirm-tourney-phone');

    const refInput = document.getElementById('tourney-referral-input') as HTMLInputElement | null;
    const phoneInput = document.getElementById('tourney-phone-input') as HTMLInputElement | null;

    const players = this.lobbyState?.players || [];
    const copilot = players.find((p) => p.player_id !== this.playerId);

    if (pilotEl) pilotEl.textContent = this.pilotName;
    if (copilotEl) copilotEl.textContent = copilot ? copilot.name : 'POR ASIGNAR EN SALA';
    if (refEl) refEl.textContent = refInput?.value.trim().toUpperCase() || 'NINGUNO';
    if (phoneEl) phoneEl.textContent = phoneInput?.value.trim() || 'POR DEFECTO';

    this.openModal('modal-confirm-tourney');
  }

  private openLoadoutConfirmationModal(): void {
    const paintSelect = document.getElementById('select-paint') as HTMLSelectElement | null;
    const trailSelect = document.getElementById('select-trail') as HTMLSelectElement | null;
    const themeSelect = document.getElementById('select-theme') as HTMLSelectElement | null;

    const paintEl = document.getElementById('confirm-loadout-paint');
    const trailEl = document.getElementById('confirm-loadout-trail');
    const themeEl = document.getElementById('confirm-loadout-theme');

    if (paintEl && paintSelect) {
      paintEl.textContent = paintSelect.options[paintSelect.selectedIndex]?.text || this.cosmetics.paintJob;
    }
    if (trailEl && trailSelect) {
      trailEl.textContent = trailSelect.options[trailSelect.selectedIndex]?.text || this.cosmetics.neonTrail;
    }
    if (themeEl && themeSelect) {
      themeEl.textContent = themeSelect.options[themeSelect.selectedIndex]?.text || this.cosmetics.hudTheme;
    }

    this.openModal('modal-confirm-loadout');
  }

  private async handlePassRedemption(rawCode: string, feedbackEl: HTMLElement): Promise<boolean> {
    const code = rawCode.trim().toUpperCase();
    if (!code) {
      feedbackEl.textContent = 'Por favor ingresa un código de pase o ID de transacción.';
      feedbackEl.style.color = 'var(--danger)';
      return false;
    }

    feedbackEl.textContent = 'Verificando pase con el servidor...';
    feedbackEl.style.color = 'var(--accent)';

    const ok = await this.verifyTournamentPass(code);
    if (ok) {
      feedbackEl.innerHTML = `[PASE VALIDO] Código: <code>${escapeHtml(code)}</code> vinculado a esta sala.`;
      feedbackEl.style.color = 'var(--phosphor)';
      return true;
    } else {
      feedbackEl.textContent = '[ERROR] Pase no encontrado o inválido. Revisa el código o realiza tu inscripción.';
      feedbackEl.style.color = 'var(--danger)';
      return false;
    }
  }

  private async verifyTournamentPass(passCode: string): Promise<boolean> {
    const cleanCode = passCode.trim().toUpperCase();
    if (!cleanCode) return false;

    try {
      const res = await fetch('/api/tournament/verify-pass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pass_code: cleanCode,
          room_code: this.roomCode
        })
      });

      const data = await res.json();
      if (res.ok && data.valid) {
        this.tournamentPass = cleanCode;
        this.isTournamentVerified = true;
        localStorage.setItem('ps_tournament_pass', cleanCode);
        this.updateModeBanner();
        this.sendWsMessage({ type: 'set_tournament_pass', pass_code: cleanCode });
        return true;
      }
      if (res.ok && localStorage.getItem('ps_tournament_pass') === cleanCode) {
        // Stale pass (e.g. old transaction-id passes are no longer accepted)
        localStorage.removeItem('ps_tournament_pass');
      }
      return false;
    } catch {
      return false;
    }
  }

  private updateModeBanner(): void {
    const banner = document.getElementById('mode-status-banner');
    const bannerText = document.getElementById('mode-status-text');
    const bannerBtn = document.getElementById('btn-banner-action');

    if (this.isTournamentVerified) {
      if (banner) {
        banner.className = 'tourney-badge-active';
      }
      if (bannerText) {
        bannerText.innerHTML = this.tournamentPass
          ? `MODO ACTUAL: <strong>TORNEO OFICIAL ACTIVO</strong> // PASE: <code>${escapeHtml(this.tournamentPass)}</code>`
          : `MODO ACTUAL: <strong>TORNEO OFICIAL ACTIVO</strong> // PASE ACTIVADO POR TU COPILOTO`;
      }
      if (bannerBtn && this.tournamentPass) {
        bannerBtn.textContent = 'Compartir Pase con Copiloto';
        bannerBtn.style.color = '#ffb703';
        bannerBtn.style.borderColor = 'var(--accent)';
      }
    } else {
      if (banner) {
        banner.className = 'practice-badge-active';
      }
      if (bannerText) {
        bannerText.innerHTML = `MODO ACTUAL: <strong>PRACTICA LIBRE (100% GRATUITO)</strong>`;
      }
      if (bannerBtn) {
        bannerBtn.textContent = `Inscribirse al Torneo (${this.formatEntryFee()} USD) ->`;
        bannerBtn.style.color = '#ffb703';
        bannerBtn.style.borderColor = 'var(--accent)';
      }
    }
  }

  private async executePayphoneLinkCreation(): Promise<void> {
    const feedback = document.getElementById('tourney-feedback');
    const refInput = document.getElementById('tourney-referral-input') as HTMLInputElement | null;
    const phoneInput = document.getElementById('tourney-phone-input') as HTMLInputElement | null;

    if (feedback) {
      feedback.textContent = 'GENERANDO ENLACE SEGURO DE PAGO PAYPHONE...';
      feedback.style.color = 'var(--accent)';
    }

    try {
      const res = await fetch('/api/payphone/create-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          driver_name: this.pilotName || 'PILOT_A',
          navigator_name:
            this.lobbyState?.players.find((p) => p.role === 'navigator')?.name ||
            `CO_PILOT_${Math.floor(10 + Math.random() * 89)}`,
          referral_code: refInput?.value.trim().toUpperCase() || undefined,
          phone: phoneInput?.value.trim() || undefined,
          room_code: this.roomCode || undefined
        })
      });

      const data = await res.json();
      const checkoutUrl = safeHttpUrl(data.payWithCard || data.payUrl || data.payWithPayPhone);
      if (data.success && checkoutUrl) {
        if (feedback) {
          feedback.innerHTML = `[ENLACE GENERADO] <a href="${escapeHtml(checkoutUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--phosphor);font-weight:700;text-decoration:underline;">ABRIR PASARELA PAYPHONE ($${Number(data.entry_fee_usd).toFixed(2)} USD)</a>`;
        }
        window.open(checkoutUrl, '_blank', 'noopener');
      } else {
        if (feedback) {
          feedback.innerHTML = `[AVISO] <strong>ERROR EN PASARELA:</strong> ${escapeHtml(data.message || data.error || 'No se pudo generar el enlace de cobro. Revisa tus datos e intenta nuevamente.')}`;
          feedback.style.color = 'var(--danger)';
        }
      }
    } catch (err: any) {
      if (feedback) {
        feedback.textContent = `Error conectando con la pasarela: ${err?.message || 'Fallo de conexión'}`;
        feedback.style.color = 'var(--danger)';
      }
    }
  }

  private updateOverlayVisibility(): void {
    const status = this.currentWorldState.world_state.status;
    document.body.classList.toggle('in-flight', status !== 'lobby');
    const lobbyModal = document.getElementById('modal-lobby');
    const adModal = document.getElementById('modal-ad-revive');
    const gameoverModal = document.getElementById('modal-gameover');

    lobbyModal?.classList.toggle('hidden', status !== 'lobby');
    adModal?.classList.toggle('hidden', status !== 'ad_revive_prompt');
    gameoverModal?.classList.toggle('hidden', status !== 'gameover');

    if (status === 'gameover') {
      const ws = this.currentWorldState.world_state;
      const finalScore = document.getElementById('gameover-score');
      const finalBreakdown = document.getElementById('gameover-breakdown');
      const rescuedEl = document.getElementById('gameover-rescued');
      const impactEl = document.getElementById('gameover-impact');
      if (finalScore) finalScore.textContent = ws.total_score.toLocaleString();
      if (rescuedEl) rescuedEl.textContent = `${rescuedCount(ws.distance_traveled)}`;
      if (finalBreakdown) {
        const phase = ws.difficulty_phase ?? 'Calentamiento';
        finalBreakdown.textContent = `${ws.distance_traveled.toFixed(0)} m recorridos · ${ws.survival_time.toFixed(0)} s de patrulla · llegaste a: ${phase} (${weatherForPhase(phase).label.toLowerCase()})`;
      }
      if (impactEl) impactEl.textContent = this.describeRealImpact();
    }

    this.renderLobbyPlayers();
  }

  // -------------------------------------------------------------
  // Tournament & Payphone Public Flow
  // -------------------------------------------------------------

  private async fetchTournamentTelemetry(): Promise<void> {
    try {
      const res = await fetch('/api/tournament/status');
      if (!res.ok) return;
      const data: TournamentTelemetryStatus = await res.json();
      this.activeTourneyStatus = data;

      const couplesEl = document.getElementById('tourney-couples-count');
      const prizeEl = document.getElementById('tourney-prize-pool');
      const charityEl = document.getElementById('tourney-charity-pool');
      const pod1El = document.getElementById('tourney-podium-1');
      const pod2El = document.getElementById('tourney-podium-2');
      const pod3El = document.getElementById('tourney-podium-3');
      const statusPill = document.getElementById('tourney-status-pill');

      if (couplesEl) couplesEl.textContent = `${data.tournament.registered_couples} / ${data.tournament.max_couples}`;
      if (prizeEl) prizeEl.textContent = `$${data.tournament.accumulated_prize_pool.toFixed(2)}`;
      if (charityEl) charityEl.textContent = `$${data.tournament.accumulated_charity.toFixed(2)}`;
      if (pod1El) pod1El.textContent = `$${data.tournament.podium_preview.first_place.toFixed(2)}`;
      if (pod2El) pod2El.textContent = `$${data.tournament.podium_preview.second_place.toFixed(2)}`;
      if (pod3El) pod3El.textContent = `$${data.tournament.podium_preview.third_place.toFixed(2)}`;
      if (statusPill) {
        statusPill.textContent = data.tournament.status === 'completed' ? 'FINALIZADO' : 'REGISTRO ABIERTO';
        statusPill.className = `status-badge ${data.tournament.status === 'completed' ? 'status-offline' : 'status-online'}`;
      }
      this.applyPriceBindings(data);
      this.updateModeBanner();
    } catch {
      // Offline fallback
    }
  }

  /**
   * End-of-match message tying the game to the real donation, using live server figures:
   * what this pair's entry gave (tournament) and what everyone has raised so far.
   */
  private describeRealImpact(): string {
    const status = this.activeTourneyStatus;
    if (!status) return 'Cada partida ayuda a difundir la causa del refugio. ¡Compártela!';
    const fee = status.tournament.entry_fee_usd;
    const perPair = calculateTransactionSplits(fee, status.config, true).allocated_to_charity;
    const total = status.tournament.accumulated_charity;
    const together =
      total > 0
        ? `Entre todos llevamos $${total.toFixed(2)} para el refugio (≈ ${foodKgFromUsd(total)} kg de alimento).`
        : 'El fondo del refugio recién empieza: ¡tu pareja puede ser la primera en aportar!';
    return this.isTournamentVerified
      ? `Tu inscripción aportó $${perPair.toFixed(2)} al refugio. ${together}`
      : `Esta partida fue de práctica, gratis. ${together} Con el torneo, $${perPair.toFixed(2)} de cada inscripción van al refugio.`;
  }

  /** "$11" for whole amounts, "$12.50" otherwise; `fixed` always shows cents. */
  private formatEntryFee(fixed = false): string {
    const fee = this.activeTourneyStatus?.tournament.entry_fee_usd ?? 10;
    return fixed || !Number.isInteger(fee) ? `$${fee.toFixed(2)}` : `$${fee}`;
  }

  /**
   * Fills every [data-bind] price/percentage in the hangar from the server config, so the
   * amounts shown always match what Payphone charges and how it is split.
   */
  private applyPriceBindings(data: TournamentTelemetryStatus): void {
    const fee = data.tournament.entry_fee_usd;
    const alloc = data.config.pricing_structure.revenue_allocation_percentages;
    const podium = data.config.prize_podium_breakdown;
    const splits = calculateTransactionSplits(fee, data.config, true);
    const pct = (fraction: number) => `${Number((fraction * 100).toFixed(2))}%`;
    const usd = (amount: number) => `$${amount.toFixed(2)}`;
    const opsFraction = Math.max(0, 1 - alloc.prize_pool.percentage_of_gross - alloc.animal_charity.percentage_of_gross);

    const values: Record<string, string> = {
      fee: this.formatEntryFee(),
      fee2: this.formatEntryFee(true),
      'pct-prize': pct(alloc.prize_pool.percentage_of_gross),
      'pct-charity': pct(alloc.animal_charity.percentage_of_gross),
      'pct-ops': pct(opsFraction),
      'pct-podium-1': pct(podium.first_place_percentage),
      'pct-podium-2': pct(podium.second_place_percentage),
      'pct-podium-3': pct(podium.third_place_percentage),
      'amt-prize': usd(splits.allocated_to_prize_pool),
      'amt-charity': usd(splits.allocated_to_charity),
      'amt-ops': usd(round2(fee - splits.allocated_to_prize_pool - splits.allocated_to_charity))
    };
    document.querySelectorAll<HTMLElement>('[data-bind]').forEach((el) => {
      const value = values[el.dataset.bind || ''];
      if (value !== undefined && el.textContent !== value) el.textContent = value;
    });

    // Live shelter total in the hangar mission card
    const charityTotal = data.tournament.accumulated_charity;
    const charityLine = document.getElementById('mission-charity-line');
    if (charityLine) {
      charityLine.textContent =
        charityTotal > 0
          ? `Entre todos llevamos ${usd(charityTotal)} para el refugio ≈ ${foodKgFromUsd(charityTotal)} kg de alimento`
          : 'El fondo del refugio recién empieza: ¡sé de las primeras parejas en aportar!';
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new PacificSpeedClientApp();
});
