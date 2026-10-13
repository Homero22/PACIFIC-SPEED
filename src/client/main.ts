import { GameSimulation } from '../shared/simulation.js';
import type {
  AdminDashboardData,
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
import { AudioEngine } from './audioEngine.js';
import { InputManager } from './inputManager.js';
import { GameRenderer } from './renderer.js';

const LOCAL_COMMS_MAP: Record<TacticalCommsPreset, { code: string; label: string }> = {
  bogey_alert: { code: 'TAC-01 // BOGEY LOCK', label: '⚠️ BOGEY INBOUND — DEPLOY FLANK SHIELD' },
  nice_deflect: { code: 'TAC-02 // INTERCEPT', label: '🛡️ DIRECT INTERCEPT CONFIRMED — GOOD SAVE' },
  engage_overdrive: { code: 'TAC-03 // MACH BURN', label: '⚡ ENGAGE AFTERBURNER OVERDRIVE NOW' },
  mayday_panic: { code: 'TAC-04 // VELOCITY CRIT', label: '💀 CRITICAL STALL — INCREASE THROTTLE!' }
};

class PacificSpeedClientApp {
  private playerId: string;
  private pilotName: string;
  private roomCode: string;
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

  // Tournament & Admin Command Deck Engine
  private adminToken: string | null = sessionStorage.getItem('ps_admin_token');
  private activeTourneyStatus: TournamentTelemetryStatus | null = null;
  private adminDashboardData: AdminDashboardData | null = null;

  private audio = new AudioEngine();
  private input: InputManager;
  private renderer: GameRenderer;

  private lastFrameTime = performance.now();
  private adCountdownInterval: number | null = null;

  // Hype & Near-Miss tracking for Narrator
  private evaluatedNearMissIds = new Set<string>();
  private nextScoreMilestone = 3000;

  // 9:16 TikTok / Streamer Mode & Native Video+Audio Recorder
  private isTikTokMode = false;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private isRecordingClip = false;

  constructor() {
    this.playerId =
      sessionStorage.getItem('ps_player_id') ||
      `PILOT-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    sessionStorage.setItem('ps_player_id', this.playerId);

    this.pilotName =
      localStorage.getItem('ps_pilot_name') ||
      `RAPTOR_${Math.floor(10 + Math.random() * 89)}`;

    const savedCosmetics = localStorage.getItem('ps_cosmetics');
    if (savedCosmetics) {
      try {
        this.cosmetics = { ...this.cosmetics, ...JSON.parse(savedCosmetics) };
      } catch {
        // Ignore invalid JSON
      }
    }

    const params = new URLSearchParams(window.location.search);
    const urlRoom = params.get('room');
    if (urlRoom && urlRoom.trim().length > 0) {
      this.roomCode = urlRoom.trim().toUpperCase();
    } else {
      const randomSuffix = Math.random().toString(36).substring(2, 5).toUpperCase();
      this.roomCode = `NEURAL-${randomSuffix}`;
      this.updateUrlRoomParam(this.roomCode);
    }

    const urlRef = params.get('ref');
    if (urlRef) {
      const refInput = document.getElementById('tourney-referral-input') as HTMLInputElement | null;
      if (refInput) refInput.value = urlRef.trim().toUpperCase();
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
    const url = new URL(window.location.href);
    url.searchParams.set('room', code);
    window.history.replaceState({}, '', url.toString());
    const roomInput = document.getElementById('room-code-input') as HTMLInputElement | null;
    if (roomInput) roomInput.value = code;
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
      if (roomInput && roomInput.value.trim()) {
        this.roomCode = roomInput.value.trim().toUpperCase();
        this.updateUrlRoomParam(this.roomCode);
        this.mode = 'online';
        this.syncModeButtons();
        this.joinCurrentOnlineRoom();
      }
    });

    document.getElementById('btn-copy-link')?.addEventListener('click', async () => {
      this.updateUrlRoomParam(this.roomCode);
      const shareUrl = window.location.href;
      try {
        await navigator.clipboard.writeText(shareUrl);
        const btn = document.getElementById('btn-copy-link');
        if (btn) {
          const prev = btn.textContent;
          btn.textContent = '✓ ENLACE TÁCTICO COPIADO AL PORTAPAPELES';
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
    document.getElementById('btn-role-driver')?.addEventListener('click', () => {
      this.audio.init();
      this.activeRole = 'driver';
      this.syncRoleButtons();
      if (this.mode === 'online') {
        this.sendWsMessage({ type: 'switch_role', role: 'driver' });
      }
    });

    document.getElementById('btn-role-navigator')?.addEventListener('click', () => {
      this.audio.init();
      this.activeRole = 'navigator';
      this.syncRoleButtons();
      if (this.mode === 'online') {
        this.sendWsMessage({ type: 'switch_role', role: 'navigator' });
      }
    });

    document.getElementById('btn-hud-swap-role')?.addEventListener('click', () => {
      this.audio.init();
      this.activeRole = this.activeRole === 'driver' ? 'navigator' : 'driver';
      this.syncRoleButtons();
      if (this.mode === 'online') {
        this.sendWsMessage({ type: 'switch_role', role: this.activeRole });
      }
    });

    // 9:16 TikTok Streamer Mode Toggle
    document.getElementById('btn-tiktok-mode')?.addEventListener('click', () => {
      this.isTikTokMode = !this.isTikTokMode;
      document.body.classList.toggle('tiktok-916-mode', this.isTikTokMode);
      const btn = document.getElementById('btn-tiktok-mode');
      if (btn) {
        btn.classList.toggle('active', this.isTikTokMode);
        btn.textContent = this.isTikTokMode ? '9:16 ON' : '9:16 STREAM';
      }
    });

    // 1-Click Native Canvas Video+Audio Clip Recorder (.webm)
    document.getElementById('btn-record-clip')?.addEventListener('click', () => {
      this.toggleCanvasRecording(canvas);
    });

    // Voice Mode Selector (HYBRID / ES / EN / OFF)
    document.getElementById('btn-voice-mode')?.addEventListener('click', () => {
      this.audio.init();
      const mode = this.audio.cycleVoiceMode();
      const labels = {
        hybrid: 'VOICE: HYBRID',
        es_only: 'VOICE: ES CMD',
        en_only: 'VOICE: EN AI',
        off: 'VOICE: OFF'
      };
      const btn = document.getElementById('btn-voice-mode');
      if (btn) btn.textContent = labels[mode];
    });

    // Master Audio Toggle
    document.getElementById('btn-mute-audio')?.addEventListener('click', () => {
      this.audio.init();
      const muted = this.audio.toggleMute();
      const btn = document.getElementById('btn-mute-audio');
      if (btn) btn.textContent = muted ? 'SFX: OFF' : 'SFX: ON';
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

    // Start Match & Instant Rematch
    document.getElementById('btn-start-match')?.addEventListener('click', () => {
      this.audio.init();
      this.audio.playNarratorCue('athena_online', true);
      this.triggerStartOrRematch();
    });

    document.getElementById('btn-instant-rematch')?.addEventListener('click', () => {
      this.audio.init();
      this.audio.playNarratorCue('athena_online', true);
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

    // Rewarded Ad 5s Placeholder Hook
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

    // Tournament & Payphone Sandbox UI Handlers
    document.getElementById('btn-tourney-simulate-pay')?.addEventListener('click', async () => {
      this.audio.init();
      await this.handleSimulatePayphonePayment();
    });

    document.getElementById('btn-tourney-pay')?.addEventListener('click', () => {
      this.audio.init();
      const feedback = document.getElementById('tourney-feedback');
      if (feedback) {
        feedback.innerHTML = '⚡ MODO PRODUCCIÓN: Enlace Payphone SDK activo en deployment público. Usa <strong>SANDBOX PAY</strong> para acreditar $10 USD de prueba con la matemática exacta al instante.';
      }
    });

    // Admin Command Deck & Login Handlers
    document.getElementById('btn-open-admin')?.addEventListener('click', () => {
      this.audio.init();
      if (this.adminToken) {
        this.openAdminDeck();
      } else {
        document.getElementById('modal-admin-login')?.classList.remove('hidden');
      }
    });

    document.getElementById('btn-close-admin-login')?.addEventListener('click', () => {
      document.getElementById('modal-admin-login')?.classList.add('hidden');
    });

    document.getElementById('btn-submit-admin-login')?.addEventListener('click', async () => {
      await this.handleAdminLogin();
    });

    document.getElementById('admin-password-input')?.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        await this.handleAdminLogin();
      }
    });

    document.getElementById('btn-close-admin-deck')?.addEventListener('click', () => {
      document.getElementById('modal-admin-deck')?.classList.add('hidden');
    });

    document.getElementById('btn-admin-logout')?.addEventListener('click', () => {
      this.adminToken = null;
      sessionStorage.removeItem('ps_admin_token');
      document.getElementById('modal-admin-deck')?.classList.add('hidden');
    });

    document.getElementById('btn-admin-refresh')?.addEventListener('click', async () => {
      await this.fetchAdminDashboard();
    });

    // Admin Tab Switching
    document.querySelectorAll<HTMLButtonElement>('.admin-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tabId = btn.dataset.tab;
        document.querySelectorAll('.admin-tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.admin-tab-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        if (tabId) {
          document.getElementById(tabId)?.classList.add('active');
        }
      });
    });

    // Admin Action: Close Tournament & Distribute Podium
    document.getElementById('btn-close-tournament')?.addEventListener('click', async () => {
      if (!confirm('¿Confirmas el cierre del torneo y liquidación definitiva del podio? Esta acción marcará el torneo como COMPLETADO.')) {
        return;
      }
      await this.handleCloseTournamentPodium();
    });

    // Admin Action: Create Referral
    document.getElementById('btn-create-referral')?.addEventListener('click', async () => {
      await this.handleCreateReferral();
    });

    // Admin Action: Save Dynamic Config
    document.getElementById('btn-save-config')?.addEventListener('click', async () => {
      await this.handleSaveDynamicConfig();
    });

    // Admin Action: Clear Anti-Cheat Logs
    document.getElementById('btn-clear-anticheat')?.addEventListener('click', async () => {
      await this.handleClearAntiCheatLogs();
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
        btn.textContent = '🔴 REC CLIP';
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
        btn.textContent = '⏹ STOP & SAVE';
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
        'SECTOR RECORD BROKEN!',
        `SCORE PASSED ${(this.nextScoreMilestone - 5000).toLocaleString()} PTS`,
        '#ffb703'
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
            'RAZOR CLOSE CALL!',
            'EVASIVE MANEUVER // MILLIMETER CLEARANCE',
            '#00f0ff'
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
        statusText.textContent = `RECALIBRANDO BLINDAJE DE TITANIO... ${remaining.toFixed(1)}s`;
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
            'PROTOCOLO DE EMERGENCIA: TRANSMISIÓN DE 5S PARA RESTAURAR 100% DE INTEGRIDAD';
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
        setTimeout(() => this.connectWebSocket(), 2500);
      });
    } catch {
      this.wsConnected = false;
      this.updateConnectionBadge(false);
    }
  }

  private joinCurrentOnlineRoom(): void {
    this.sendWsMessage({
      type: 'join_room',
      room_code: this.roomCode,
      player_id: this.playerId,
      name: this.pilotName,
      preferred_role: this.activeRole,
      cosmetics: this.cosmetics
    });
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
        this.activeRole = msg.assigned_role;
        this.lobbyState = msg.lobby;
        this.updateUrlRoomParam(this.roomCode);
        this.syncRoleButtons();
        this.renderLobbyPlayers();
        this.updateOverlayVisibility();
        break;

      case 'lobby_update':
        this.lobbyState = msg.lobby;
        const me = msg.lobby.players.find((p) => p.player_id === this.playerId);
        if (me) {
          this.activeRole = me.role;
          this.syncRoleButtons();
        }
        this.renderLobbyPlayers();
        this.updateOverlayVisibility();
        break;

      case 'world_state':
        if (this.mode === 'online') {
          this.currentWorldState = msg.payload;
          this.audio.processServerEvents(msg.payload.world_state.events);
          this.evaluateHypeMoments(msg.payload);
          this.updateOverlayVisibility();
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
    const ws = this.currentWorldState.world_state;
    void fetch('/api/leaderboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_code: this.mode === 'local_coop' ? 'LOCAL-2P' : 'SOLO-AI',
        driver_name: this.activeRole === 'driver' ? this.pilotName : 'AWACS_AI',
        navigator_name: this.activeRole === 'navigator' ? this.pilotName : 'AWACS_AI',
        total_score: ws.total_score,
        distance_traveled: ws.distance_traveled,
        survival_time: ws.survival_time,
        region: 'LOCAL-SIM'
      })
    })
      .then((r) => r.json())
      .then((data: { entries?: LeaderboardEntry[] }) => {
        if (data.entries) {
          this.leaderboard = data.entries;
          this.renderLeaderboard();
        }
      })
      .catch(() => {});
  }

  private AnimationLoop(now: number): void {
    const dt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;

    let driverPredictedInputX = 0;

    if (this.mode === 'online') {
      if (this.currentWorldState.world_state.status === 'running') {
        const inputPayload: ClientInputPayload = this.input.sampleInputPayload(
          this.playerId,
          this.activeRole
        );
        driverPredictedInputX = inputPayload.input_vector.x;
        this.sendWsMessage({
          type: 'player_input',
          payload: inputPayload
        });
      }
    } else {
      if (this.localSim.getStatus() === 'running') {
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
    }

    const isRunning = this.currentWorldState.world_state.status === 'running';
    const currentSpeed = this.currentWorldState.speed_multiplier.current_speed;
    const isCritical =
      isRunning &&
      currentSpeed < this.currentWorldState.speed_multiplier.critical_threshold;
    this.audio.updateTelemetryAudio(isRunning, currentSpeed, isCritical);

    this.renderer.render(
      this.currentWorldState,
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
    setTxt('hud-speed', `${Math.round(sm.current_speed)} KT`);
    setTxt('hud-distance', `${ws.distance_traveled.toFixed(0)} M`);
    setTxt('hud-integrity-text', `${Math.round(ws.integrity)}%`);
    setTxt('hud-shield-text', `${Math.round(ws.active_shields.energy)}%`);
    setTxt(
      'hud-role-badge',
      this.activeRole === 'driver'
        ? 'PILOT A // STEALTH DRIVER [LOW-VIS CONE]'
        : 'PILOT B // AWACS NAVIGATOR [OVERHEAD RADAR]'
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
        overdriveBadge.textContent = `MACH 2.0 OVERDRIVE (${ws.overdrive_timer.toFixed(1)}s)`;
      } else {
        overdriveBadge.classList.add('hidden');
      }
    }
  }

  private updateConnectionBadge(online: boolean): void {
    const el = document.getElementById('ws-status-badge');
    if (!el) return;
    if (online) {
      el.textContent = `DATALINK ACTIVE // ${this.roomCode}`;
      el.classList.add('status-online');
      el.classList.remove('status-offline');
    } else {
      el.textContent = 'LOCAL SIM STANDBY';
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
          <span class="slot-role">SEAT 01 // STEALTH DRIVER</span>
          <span class="slot-name">${this.activeRole === 'driver' ? this.pilotName : 'AWACS AI CO-PILOT'}</span>
        </div>
        <div class="crew-slot">
          <span class="slot-role">SEAT 02 // TACTICAL NAVIGATOR</span>
          <span class="slot-name">${this.activeRole === 'navigator' ? this.pilotName : this.mode === 'local_coop' ? 'OPERATOR 2 (J/K/L)' : 'AWACS AI CO-PILOT'}</span>
        </div>
      `;
      return;
    }

    const players = this.lobbyState?.players || [];
    const driver = players.find((p) => p.role === 'driver');
    const navigator = players.find((p) => p.role === 'navigator');

    container.innerHTML = `
      <div class="crew-slot ${driver ? 'filled' : ''}">
        <span class="slot-role">SEAT 01 // STEALTH DRIVER</span>
        <span class="slot-name">${driver ? driver.name : 'AI AUTO-PILOT STANDBY'}</span>
      </div>
      <div class="crew-slot ${navigator ? 'filled' : ''}">
        <span class="slot-role">SEAT 02 // TACTICAL NAVIGATOR</span>
        <span class="slot-name">${navigator ? navigator.name : 'AI AWACS STANDBY'}</span>
      </div>
    `;
  }

  private renderLeaderboard(): void {
    const tbody = document.getElementById('leaderboard-body');
    if (!tbody) return;
    tbody.innerHTML = this.leaderboard
      .slice(0, 6)
      .map(
        (entry, idx) => `
        <tr>
          <td>0${idx + 1}</td>
          <td>${entry.driver_name} / ${entry.navigator_name}</td>
          <td style="color: var(--accent); font-weight: 700">${entry.total_score.toLocaleString()}</td>
          <td>${entry.distance_traveled.toFixed(0)}m (${entry.survival_time.toFixed(1)}s)</td>
          <td>${entry.region}</td>
        </tr>
      `
      )
      .join('');
  }

  private updateOverlayVisibility(): void {
    const status = this.currentWorldState.world_state.status;
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
      if (finalScore) finalScore.textContent = ws.total_score.toLocaleString();
      if (finalBreakdown) {
        finalBreakdown.textContent = `DISTANCIA: ${ws.distance_traveled.toFixed(1)}M (x10) // TIEMPO EN VUELO: ${ws.survival_time.toFixed(1)}S (x50)`;
      }
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
    } catch {
      // Offline fallback
    }
  }

  private async handleSimulatePayphonePayment(): Promise<void> {
    const feedback = document.getElementById('tourney-feedback');
    const refInput = document.getElementById('tourney-referral-input') as HTMLInputElement | null;
    const phoneInput = document.getElementById('tourney-phone-input') as HTMLInputElement | null;

    const referralCode = refInput?.value.trim().toUpperCase() || undefined;
    const driverName = this.pilotName || 'PILOT_A';
    const navigatorName =
      this.lobbyState?.players.find((p) => p.role === 'navigator')?.name ||
      `CO_PILOT_${Math.floor(10 + Math.random() * 89)}`;

    if (feedback) {
      feedback.textContent = 'PROCESANDO TRANSACCIÓN SIMULADA EN PASARELA PAYPHONE...';
      feedback.style.color = 'var(--accent)';
    }

    try {
      const res = await fetch('/api/tournament/simulate-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          driver_name: driverName,
          navigator_name: navigatorName,
          referral_code: referralCode,
          phone: phoneInput?.value.trim() || undefined
        })
      });

      const result = await res.json();
      if (!res.ok || !result.success) {
        if (feedback) {
          feedback.textContent = `❌ ERROR EN PAGO: ${result.error || 'No se pudo procesar'}`;
          feedback.style.color = 'var(--danger)';
        }
        return;
      }

      if (feedback) {
        feedback.textContent = `✓ PAGO DE $10.00 USD APROBADO // TX: ${result.audit.payphone_transaction_id.slice(0, 16)}... (Pozo +$6.00 | Refugio +$1.50 | Margin +$1.92)`;
        feedback.style.color = 'var(--phosphor)';
      }

      await this.fetchTournamentTelemetry();
      if (this.adminToken && !document.getElementById('modal-admin-deck')?.classList.contains('hidden')) {
        await this.fetchAdminDashboard();
      }
    } catch (err) {
      if (feedback) {
        feedback.textContent = `❌ FALLO DE RED: ${(err as Error).message}`;
        feedback.style.color = 'var(--danger)';
      }
    }
  }

  // -------------------------------------------------------------
  // Secure Admin Command Deck Actions
  // -------------------------------------------------------------

  private async handleAdminLogin(): Promise<void> {
    const input = document.getElementById('admin-password-input') as HTMLInputElement | null;
    const errBox = document.getElementById('admin-login-error');
    const pwd = input?.value || '';

    if (errBox) errBox.textContent = '';

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd })
      });
      const data = await res.json();
      if (!res.ok || !data.token) {
        if (errBox) errBox.textContent = data.error || 'Clave de administrador incorrecta';
        return;
      }

      this.adminToken = data.token;
      sessionStorage.setItem('ps_admin_token', this.adminToken!);
      if (input) input.value = '';
      document.getElementById('modal-admin-login')?.classList.add('hidden');
      this.openAdminDeck();
    } catch (err) {
      if (errBox) errBox.textContent = `Error de red: ${(err as Error).message}`;
    }
  }

  private openAdminDeck(): void {
    document.getElementById('modal-admin-deck')?.classList.remove('hidden');
    void this.fetchAdminDashboard();
  }

  private async fetchAdminDashboard(): Promise<void> {
    if (!this.adminToken) return;

    try {
      const res = await fetch('/api/admin/dashboard', {
        headers: { Authorization: `Bearer ${this.adminToken}` }
      });

      if (res.status === 401) {
        this.adminToken = null;
        sessionStorage.removeItem('ps_admin_token');
        document.getElementById('modal-admin-deck')?.classList.add('hidden');
        document.getElementById('modal-admin-login')?.classList.remove('hidden');
        const errBox = document.getElementById('admin-login-error');
        if (errBox) errBox.textContent = 'Sesión expirada. Ingresa de nuevo la clave secreta.';
        return;
      }

      if (!res.ok) return;

      const data: AdminDashboardData = await res.json();
      this.adminDashboardData = data;
      this.renderAdminDashboard(data);
    } catch {
      // Connection failure
    }
  }

  private renderAdminDashboard(data: AdminDashboardData): void {
    // 1. Tab Overview
    const elCouples = document.getElementById('adm-couples');
    const elGross = document.getElementById('adm-gross');
    const elFee = document.getElementById('adm-payphone-fee');
    const elPrize = document.getElementById('adm-prize-pool');
    const elCharity = document.getElementById('adm-charity');
    const elDev = document.getElementById('adm-dev-share');
    const elCollab = document.getElementById('adm-collab-share');
    const elStatus = document.getElementById('adm-status');

    if (elCouples) elCouples.textContent = `${data.tournament.registered_couples_count} / ${data.tournament.max_couples}`;
    if (elGross) elGross.textContent = `$${data.financial_summary.gross_collected_total.toFixed(2)} USD`;
    if (elFee) elFee.textContent = `$${data.financial_summary.payphone_fees_total.toFixed(2)} USD`;
    if (elPrize) elPrize.textContent = `$${data.financial_summary.prize_pool_total.toFixed(2)} USD`;
    if (elCharity) elCharity.textContent = `$${data.financial_summary.charity_total.toFixed(2)} USD`;
    if (elDev) elDev.textContent = `$${data.financial_summary.developer_net_total.toFixed(2)} USD`;
    if (elCollab) elCollab.textContent = `$${data.financial_summary.collaborator_payouts_total.toFixed(2)} USD`;
    if (elStatus) elStatus.textContent = data.tournament.status.toUpperCase();

    // Live Podium Preview
    const p1Amt = data.financial_summary.prize_pool_total * data.active_config.prize_podium_breakdown.first_place_percentage;
    const p2Amt = data.financial_summary.prize_pool_total * data.active_config.prize_podium_breakdown.second_place_percentage;
    const p3Amt = data.financial_summary.prize_pool_total * data.active_config.prize_podium_breakdown.third_place_percentage;

    const p1ElAmt = document.getElementById('adm-podium-1-amount');
    const p2ElAmt = document.getElementById('adm-podium-2-amount');
    const p3ElAmt = document.getElementById('adm-podium-3-amount');
    if (p1ElAmt) p1ElAmt.textContent = `$${p1Amt.toFixed(2)} USD`;
    if (p2ElAmt) p2ElAmt.textContent = `$${p2Amt.toFixed(2)} USD`;
    if (p3ElAmt) p3ElAmt.textContent = `$${p3Amt.toFixed(2)} USD`;

    const topTeams = data.payments_audit.slice(0, 3);
    const p1Name = document.getElementById('adm-podium-1-name');
    const p2Name = document.getElementById('adm-podium-2-name');
    const p3Name = document.getElementById('adm-podium-3-name');
    if (p1Name) p1Name.textContent = topTeams[0] ? `${topTeams[0].pair_driver_name} / ${topTeams[0].pair_navigator_name}` : 'SIN PAREJA';
    if (p2Name) p2Name.textContent = topTeams[1] ? `${topTeams[1].pair_driver_name} / ${topTeams[1].pair_navigator_name}` : 'SIN PAREJA';
    if (p3Name) p3Name.textContent = topTeams[2] ? `${topTeams[2].pair_driver_name} / ${topTeams[2].pair_navigator_name}` : 'SIN PAREJA';

    // 2. Tab Payments Audit Table
    const payTbody = document.getElementById('adm-payments-tbody');
    if (payTbody) {
      if (data.payments_audit.length === 0) {
        payTbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 12px;">No hay transacciones registradas aún.</td></tr>';
      } else {
        payTbody.innerHTML = data.payments_audit
          .map((p) => `
            <tr>
              <td style="font-family: monospace; color: var(--accent);">${p.payphone_transaction_id.slice(0, 14)}...</td>
              <td>${new Date(p.created_at).toLocaleTimeString()}</td>
              <td>$${p.gross_amount.toFixed(2)}</td>
              <td style="color: var(--danger);">$${p.payphone_fee.toFixed(2)}</td>
              <td style="color: var(--phosphor);">$${p.prize_pool_share.toFixed(2)}</td>
              <td style="color: var(--cyan);">$${p.charity_share.toFixed(2)}</td>
              <td style="color: #ff00ff;">$${p.developer_share.toFixed(2)}</td>
              <td style="color: #ffaa00;">${p.referral_code || '--'} ($${p.collaborator_share.toFixed(2)})</td>
              <td><span class="status-badge ${p.status === 'APPROVED' ? 'status-online' : 'status-offline'}">${p.status}</span></td>
            </tr>
          `)
          .join('');
      }
    }

    // 3. Tab Referrals Table
    const refTbody = document.getElementById('adm-referrals-tbody');
    if (refTbody) {
      if (data.referrals.length === 0) {
        refTbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 12px;">No hay colaboradores registrados.</td></tr>';
      } else {
        refTbody.innerHTML = data.referrals
          .map((r) => `
            <tr>
              <td style="color: var(--accent); font-weight: bold;">${r.referral_code}</td>
              <td>${r.collaborator_name}</td>
              <td>${r.collaborator_payphone_number || '--'}</td>
              <td style="text-align: center;">${r.total_couples_referred}</td>
              <td>$${r.accumulated_earnings_usd.toFixed(2)}</td>
              <td style="color: var(--phosphor); font-weight: bold;">$${r.pending_earnings_usd.toFixed(2)}</td>
              <td>
                ${r.pending_earnings_usd > 0
                  ? `<button class="btn btn-settle-ref" data-ref-id="${r.id}" style="padding: 2px 7px; font-size: 9px; border-color: var(--phosphor); color: var(--phosphor);">LIQUIDAR</button>`
                  : '<span style="color: var(--text-muted); font-size: 9px;">AL DÍA</span>'
                }
              </td>
            </tr>
          `)
          .join('');

        // Attach event listeners for settle buttons
        refTbody.querySelectorAll<HTMLButtonElement>('.btn-settle-ref').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const refId = btn.dataset.refId;
            if (refId) await this.handleSettleReferral(refId);
          });
        });
      }
    }

    // 4. Tab Dynamic Config Form (only populate if inputs not focused)
    const activeElement = document.activeElement;
    const isEditingConfig = activeElement && activeElement.id && activeElement.id.startsWith('cfg-');
    if (!isEditingConfig) {
      const cfg = data.active_config;
      const setVal = (id: string, val: number | string) => {
        const input = document.getElementById(id) as HTMLInputElement | null;
        if (input) input.value = String(val);
      };

      setVal('cfg-entry-fee', cfg.entry_fee_per_pair);
      setVal('cfg-max-couples', cfg.max_couples_limit);
      setVal('cfg-prize-pool', cfg.pricing_structure.revenue_allocation_percentages.prize_pool.percentage_of_gross);
      setVal('cfg-charity', cfg.pricing_structure.revenue_allocation_percentages.animal_charity.percentage_of_gross);
      setVal('cfg-payphone-fee', cfg.pricing_structure.payphone_gateway.percentage_fee);
      setVal('cfg-tax-fee', cfg.pricing_structure.payphone_gateway.tax_on_fee_percentage);
      setVal('cfg-dev-share', cfg.pricing_structure.margin_sub_distribution.platform_developer_share.percentage_of_operating_margin);
      setVal('cfg-collab-share', cfg.pricing_structure.margin_sub_distribution.collaborator_pool_share.percentage_of_operating_margin);
    }

    // 5. Tab Anti-Cheat Security Table
    const secTbody = document.getElementById('adm-anticheat-tbody');
    if (secTbody) {
      if (data.security_logs.length === 0) {
        secTbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--phosphor); padding: 12px;">✓ Sistema seguro. No se han registrado violaciones de red ni anti-cheat.</td></tr>';
      } else {
        secTbody.innerHTML = data.security_logs
          .map((log) => `
            <tr>
              <td>${new Date(log.timestamp).toLocaleTimeString()}</td>
              <td><span class="${log.severity === 'critical' ? 'badge-crit' : 'badge-warn'}">${log.severity.toUpperCase()}</span></td>
              <td style="color: var(--cyan);">${log.event_type}</td>
              <td style="font-family: monospace;">${log.ip_address}</td>
              <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${log.details}">${log.details}</td>
            </tr>
          `)
          .join('');
      }
    }
  }

  private async handleCloseTournamentPodium(): Promise<void> {
    if (!this.adminToken) return;

    try {
      const res = await fetch('/api/admin/tournament/close-podium', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.adminToken}` }
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(`Error al cerrar torneo: ${data.error || 'Operación fallida'}`);
        return;
      }

      alert(
        `🏆 TORNEO CERRADO CON ÉXITO!\n` +
        `Pozo Total: $${data.podium_distribution.total_prize_pool.toFixed(2)} USD\n` +
        `🥇 1er Lugar (66.66%): $${data.podium_distribution.podium.first_place.prize_usd.toFixed(2)} USD\n` +
        `🥈 2do Lugar (23.33%): $${data.podium_distribution.podium.second_place.prize_usd.toFixed(2)} USD\n` +
        `🥉 3er Lugar (10.01%): $${data.podium_distribution.podium.third_place.prize_usd.toFixed(2)} USD\n` +
        `🐾 Donación Refugio Animal: $${data.charity_total_usd.toFixed(2)} USD`
      );

      await this.fetchAdminDashboard();
      await this.fetchTournamentTelemetry();
    } catch (err) {
      alert(`Error de conexión: ${(err as Error).message}`);
    }
  }

  private async handleCreateReferral(): Promise<void> {
    if (!this.adminToken) return;

    const codeInput = document.getElementById('new-ref-code') as HTMLInputElement | null;
    const nameInput = document.getElementById('new-ref-name') as HTMLInputElement | null;
    const phoneInput = document.getElementById('new-ref-phone') as HTMLInputElement | null;
    const fb = document.getElementById('ref-create-feedback');

    const code = codeInput?.value.trim().toUpperCase();
    const name = nameInput?.value.trim();
    const phone = phoneInput?.value.trim();

    if (!code || !name) {
      if (fb) {
        fb.textContent = '❌ Por favor ingresa el código y nombre del colaborador.';
        fb.style.color = 'var(--danger)';
      }
      return;
    }

    try {
      const res = await fetch('/api/admin/referrals', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.adminToken}`
        },
        body: JSON.stringify({
          referral_code: code,
          collaborator_name: name,
          collaborator_payphone_number: phone || ''
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        if (fb) {
          fb.textContent = `❌ ${data.error || 'No se pudo crear el referido'}`;
          fb.style.color = 'var(--danger)';
        }
        return;
      }

      if (fb) {
        fb.textContent = `✓ Colaborador ${code} registrado exitosamente!`;
        fb.style.color = 'var(--phosphor)';
      }

      if (codeInput) codeInput.value = '';
      if (nameInput) nameInput.value = '';
      if (phoneInput) phoneInput.value = '';

      await this.fetchAdminDashboard();
    } catch (err) {
      if (fb) {
        fb.textContent = `❌ Error: ${(err as Error).message}`;
        fb.style.color = 'var(--danger)';
      }
    }
  }

  private async handleSettleReferral(refId: string): Promise<void> {
    if (!this.adminToken) return;
    if (!confirm('¿Liquidar ganancias pendientes acumuladas para este colaborador?')) return;

    try {
      const res = await fetch(`/api/admin/referrals/${refId}/settle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.adminToken}`
        },
        body: JSON.stringify({})
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(`Error al liquidar: ${data.error || 'Operación fallida'}`);
        return;
      }

      await this.fetchAdminDashboard();
    } catch (err) {
      alert(`Error de conexión: ${(err as Error).message}`);
    }
  }

  private async handleSaveDynamicConfig(): Promise<void> {
    if (!this.adminToken) return;

    const fb = document.getElementById('cfg-save-feedback');
    const getVal = (id: string) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      return el ? parseFloat(el.value) : undefined;
    };

    const payload = {
      entry_fee_per_pair: getVal('cfg-entry-fee'),
      max_couples_limit: getVal('cfg-max-couples'),
      prize_pool_percentage: getVal('cfg-prize-pool'),
      charity_percentage: getVal('cfg-charity'),
      effective_payphone_fee: getVal('cfg-payphone-fee'),
      developer_share_of_margin: getVal('cfg-dev-share'),
      collaborator_share_of_margin: getVal('cfg-collab-share')
    };

    if (fb) {
      fb.textContent = 'GUARDANDO CAMBIOS...';
      fb.style.color = 'var(--accent)';
    }

    try {
      const res = await fetch('/api/admin/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.adminToken}`
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        if (fb) {
          fb.textContent = `❌ ${data.error || 'Error al guardar'}`;
          fb.style.color = 'var(--danger)';
        }
        return;
      }

      if (fb) {
        fb.textContent = '✓ Configuración financiera actualizada en tiempo real (hot reload)!';
        fb.style.color = 'var(--phosphor)';
      }

      await this.fetchAdminDashboard();
      await this.fetchTournamentTelemetry();
    } catch (err) {
      if (fb) {
        fb.textContent = `❌ Error: ${(err as Error).message}`;
        fb.style.color = 'var(--danger)';
      }
    }
  }

  private async handleClearAntiCheatLogs(): Promise<void> {
    if (!this.adminToken) return;

    try {
      const res = await fetch('/api/admin/anticheat/clear', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.adminToken}` }
      });
      const data = await res.json();
      if (res.ok && data.success) {
        await this.fetchAdminDashboard();
      }
    } catch {
      // Ignore
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new PacificSpeedClientApp();
});
