import { randomBytes, randomInt } from 'crypto';
import type { WebSocket } from 'ws';
import { GameSimulation } from '../shared/simulation.js';
import { antiCheatEngine } from './antiCheat.js';
import {
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_CODE_PATTERN
} from '../shared/types.js';
import type {
  ClientInputPayload,
  CosmeticLoadout,
  LeaderboardEntry,
  PlayerRole,
  RoomErrorCode,
  RoomLobbyState,
  TacticalCommsEvent,
  TacticalCommsPreset,
  WsServerMessage
} from '../shared/types.js';

export const MAX_PLAYERS_PER_ROOM = 2;

interface Seat {
  player_id: string;
  session_token: string;
  name: string;
  role: PlayerRole;
  ready: boolean;
  cosmetics: CosmeticLoadout;
  /** null while disconnected (grace period running). */
  ws: WebSocket | null;
  disconnectedAt: number | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

interface PendingRoleSwap {
  fromPlayerId: string;
  toPlayerId: string;
  timer: ReturnType<typeof setTimeout>;
}

interface GameRoom {
  code: string;
  hostPlayerId: string | null;
  players: Map<string, Seat>;
  simulation: GameSimulation;
  lastStatus: 'lobby' | 'running' | 'ad_revive_prompt' | 'gameover';
  scoreRecorded: boolean;
  lastActivity: number;
  pendingSwap: PendingRoleSwap | null;
  isTournamentVerified?: boolean;
  tournamentPass?: string;
  tournamentPair?: { driver_name: string; navigator_name: string };
}

export type TournamentPassVerifier = (passCode: string) => Promise<{
  valid: boolean;
  driver_name?: string;
  navigator_name?: string;
}>;

export interface RoomManagerOptions {
  /** Seat is kept this long after its socket closes. */
  reconnectGraceMs?: number;
  /** Rooms with nobody connected are dropped after this much inactivity. */
  idleExpiryMs?: number;
  /** Rooms are dropped after this much inactivity even if sockets are still open. */
  hardIdleExpiryMs?: number;
  roleSwapTimeoutMs?: number;
  maxRooms?: number;
  /** Disable the 60 Hz simulation loop and the expiry sweep (tests drive them manually). */
  autoTick?: boolean;
}

const ROOM_ERROR_MESSAGES: Record<RoomErrorCode, string> = {
  invalid_code: 'El código de sala no es válido. Debe tener 6 caracteres (letras y números).',
  not_found: 'La sala no existe o ya expiró. Pide a tu pareja un enlace nuevo o crea una sala.',
  full: 'Sala llena: ya hay 2 pilotos en esta sala.',
  expired: 'La sala expiró por inactividad.',
  server_full: 'El servidor está al máximo de salas. Intenta de nuevo en unos minutos.',
  not_in_room: 'No estás en ninguna sala.',
  not_allowed: 'Acción no permitida.'
};

export const COMMS_PRESET_MAP: Record<TacticalCommsPreset, { code: string; label: string }> = {
  bogey_alert: { code: 'TAC-01 // BOGEY LOCK', label: '⚠️ BOGEY INBOUND — DEPLOY FLANK SHIELD' },
  nice_deflect: { code: 'TAC-02 // INTERCEPT', label: '🛡️ DIRECT INTERCEPT CONFIRMED — GOOD SAVE' },
  engage_overdrive: { code: 'TAC-03 // MACH BURN', label: '⚡ ENGAGE AFTERBURNER OVERDRIVE NOW' },
  mayday_panic: { code: 'TAC-04 // VELOCITY CRIT', label: '💀 CRITICAL STALL — INCREASE THROTTLE!' }
};

export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

export class RoomManager {
  private rooms = new Map<string, GameRoom>();
  private clientToRoom = new Map<WebSocket, { roomCode: string; playerId: string }>();
  // A tournament pass can only be active in one room at a time
  private passToRoom = new Map<string, string>();
  private intervals: ReturnType<typeof setInterval>[] = [];
  private readonly reconnectGraceMs: number;
  private readonly idleExpiryMs: number;
  private readonly hardIdleExpiryMs: number;
  private readonly roleSwapTimeoutMs: number;
  private readonly maxRooms: number;
  private leaderboard: LeaderboardEntry[] = [
    {
      id: 'seed-1',
      room_code: 'NEURAL-01',
      driver_name: 'KAI_DRIFT',
      navigator_name: 'MAKO_SYNC',
      total_score: 14850,
      distance_traveled: 840,
      survival_time: 92.4,
      region: 'LATAM-PACIFIC',
      created_at: new Date().toISOString()
    },
    {
      id: 'seed-2',
      room_code: 'NEURAL-88',
      driver_name: 'VORTEX_99',
      navigator_name: 'ECHO_RADAR',
      total_score: 11200,
      distance_traveled: 650,
      survival_time: 74.0,
      region: 'NA-WEST',
      created_at: new Date().toISOString()
    },
    {
      id: 'seed-3',
      room_code: 'NEURAL-42',
      driver_name: 'AKIRA_ZERO',
      navigator_name: 'NOVA_PULSE',
      total_score: 8940,
      distance_traveled: 512,
      survival_time: 61.2,
      region: 'AP-TOKYO',
      created_at: new Date().toISOString()
    }
  ];

  constructor(
    private readonly verifyPass?: TournamentPassVerifier,
    options: RoomManagerOptions = {}
  ) {
    this.reconnectGraceMs = options.reconnectGraceMs ?? 30_000;
    this.idleExpiryMs = options.idleExpiryMs ?? 30 * 60_000;
    this.hardIdleExpiryMs = options.hardIdleExpiryMs ?? 2 * 60 * 60_000;
    this.roleSwapTimeoutMs = options.roleSwapTimeoutMs ?? 20_000;
    this.maxRooms = options.maxRooms ?? 5000;

    if (options.autoTick !== false) {
      this.intervals.push(setInterval(() => this.tickAllRooms(), 1000 / 60));
      this.intervals.push(setInterval(() => this.expireIdleRooms(), 60_000));
    }
  }

  public dispose(): void {
    this.intervals.forEach(clearInterval);
    for (const room of this.rooms.values()) this.clearRoomTimers(room);
    this.rooms.clear();
    this.clientToRoom.clear();
  }

  public getRoomCount(): number {
    return this.rooms.size;
  }

  public hasRoom(code: string): boolean {
    return this.rooms.has(normalizeRoomCode(code));
  }

  public getLeaderboard(): LeaderboardEntry[] {
    return this.leaderboard.slice(0, 15);
  }

  public addLeaderboardEntry(
    entry: Omit<LeaderboardEntry, 'id' | 'created_at'>
  ): LeaderboardEntry[] {
    const newEntry: LeaderboardEntry = {
      ...entry,
      id: `lb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      created_at: new Date().toISOString()
    };
    this.leaderboard.push(newEntry);
    this.leaderboard.sort((a, b) => b.total_score - a.total_score);
    if (this.leaderboard.length > 25) {
      this.leaderboard.length = 25;
    }
    return this.getLeaderboard();
  }

  // -------------------------------------------------------------
  // Room lifecycle
  // -------------------------------------------------------------

  public createRoom(
    ws: WebSocket,
    name: string,
    preferredRole: PlayerRole | undefined,
    cosmetics: CosmeticLoadout
  ): void {
    this.leaveCurrentRoom(ws);

    if (this.rooms.size >= this.maxRooms) {
      this.expireIdleRooms();
      if (this.rooms.size >= this.maxRooms) {
        this.sendRoomError(ws, 'server_full');
        return;
      }
    }

    let code = generateRoomCode();
    while (this.rooms.has(code)) code = generateRoomCode();

    const room: GameRoom = {
      code,
      hostPlayerId: null,
      players: new Map(),
      simulation: new GameSimulation(false),
      lastStatus: 'lobby',
      scoreRecorded: false,
      lastActivity: Date.now(),
      pendingSwap: null
    };
    this.rooms.set(code, room);

    const seat = this.addSeat(room, ws, name, preferredRole === 'navigator' ? 'navigator' : 'driver', cosmetics);
    this.announceJoin(room, seat, { created: true, resumed: false });
  }

  public joinRoom(
    ws: WebSocket,
    roomCodeRaw: string,
    name: string,
    cosmetics: CosmeticLoadout,
    sessionToken?: string,
    takeover = false
  ): void {
    const roomCode = normalizeRoomCode(roomCodeRaw);
    if (!ROOM_CODE_PATTERN.test(roomCode)) {
      this.sendRoomError(ws, 'invalid_code', roomCode);
      return;
    }

    const room = this.rooms.get(roomCode);
    if (!room) {
      this.leaveCurrentRoom(ws);
      this.sendRoomError(ws, 'not_found', roomCode);
      return;
    }

    // Resume an existing seat with its server-issued token.
    const seat = sessionToken
      ? Array.from(room.players.values()).find((p) => p.session_token === sessionToken)
      : undefined;
    if (seat && (seat.ws === null || seat.ws === ws || takeover)) {
      const current = this.clientToRoom.get(ws);
      if (!current || current.roomCode !== room.code || current.playerId !== seat.player_id) {
        this.leaveCurrentRoom(ws);
      }
      this.attachSocket(room, seat, ws);
      if (name) seat.name = this.cleanName(name);
      seat.cosmetics = cosmetics;
      this.touch(room);
      this.announceJoin(room, seat, { created: false, resumed: true });
      return;
    }

    this.leaveCurrentRoom(ws);

    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
      this.sendRoomError(ws, 'full', roomCode);
      return;
    }

    const taken = new Set(Array.from(room.players.values()).map((p) => p.role));
    const role: PlayerRole = taken.has('driver') ? 'navigator' : 'driver';
    const newSeat = this.addSeat(room, ws, name, role, cosmetics);
    this.announceJoin(room, newSeat, { created: false, resumed: false });
  }

  /** Explicit leave: the seat is released immediately (no grace period). */
  public leaveRoom(ws: WebSocket): void {
    this.leaveCurrentRoom(ws);
  }

  /**
   * Socket closed. Only acts if `ws` is the seat's current socket, so a stale
   * socket closing after a reconnect never evicts the new one.
   */
  public removeSocket(ws: WebSocket): void {
    const meta = this.clientToRoom.get(ws);
    if (!meta) return;
    this.clientToRoom.delete(ws);

    const room = this.rooms.get(meta.roomCode);
    if (!room) return;
    const seat = room.players.get(meta.playerId);
    if (!seat || seat.ws !== ws) return;

    seat.ws = null;
    seat.ready = false;
    seat.disconnectedAt = Date.now();
    seat.graceTimer = setTimeout(() => this.releaseSeat(room, seat.player_id), this.reconnectGraceMs);
    this.cancelPendingSwap(room);
    this.broadcastLobby(room);
  }

  private leaveCurrentRoom(ws: WebSocket): void {
    const meta = this.clientToRoom.get(ws);
    if (!meta) return;
    this.clientToRoom.delete(ws);
    const room = this.rooms.get(meta.roomCode);
    const seat = room?.players.get(meta.playerId);
    if (room && seat && seat.ws === ws) {
      this.releaseSeat(room, seat.player_id);
    }
  }

  private releaseSeat(room: GameRoom, playerId: string): void {
    const seat = room.players.get(playerId);
    if (!seat) return;
    if (seat.graceTimer) clearTimeout(seat.graceTimer);
    if (seat.ws) this.clientToRoom.delete(seat.ws);
    room.players.delete(playerId);
    this.cancelPendingSwap(room);

    if (room.hostPlayerId === playerId) {
      room.hostPlayerId = room.players.keys().next().value ?? null;
    }
    if (room.players.size === 0) this.releaseTournamentPass(room);
    // Empty rooms are kept (so the shared link stays valid) until idle expiry.
    this.touch(room);
    this.broadcastLobby(room);
  }

  private addSeat(
    room: GameRoom,
    ws: WebSocket,
    name: string,
    role: PlayerRole,
    cosmetics: CosmeticLoadout
  ): Seat {
    const seat: Seat = {
      player_id: `P-${randomBytes(6).toString('hex').toUpperCase()}`,
      session_token: randomBytes(24).toString('base64url'),
      name: this.cleanName(name),
      role,
      ready: false,
      cosmetics,
      ws: null,
      disconnectedAt: null,
      graceTimer: null
    };
    room.players.set(seat.player_id, seat);
    if (!room.hostPlayerId) room.hostPlayerId = seat.player_id;
    this.attachSocket(room, seat, ws);
    this.touch(room);
    return seat;
  }

  private attachSocket(room: GameRoom, seat: Seat, ws: WebSocket): void {
    if (seat.graceTimer) {
      clearTimeout(seat.graceTimer);
      seat.graceTimer = null;
    }
    const previous = seat.ws;
    if (previous && previous !== ws) {
      // Takeover: the old socket loses the seat but must not release it on close.
      this.clientToRoom.delete(previous);
      this.sendToClient(previous, {
        type: 'session_replaced',
        message: 'Tu sesión se abrió en otra pestaña o dispositivo.'
      });
      try {
        previous.close(4001, 'session_replaced');
      } catch {
        // ignore
      }
    }
    seat.ws = ws;
    seat.disconnectedAt = null;
    this.clientToRoom.set(ws, { roomCode: room.code, playerId: seat.player_id });
  }

  private announceJoin(room: GameRoom, seat: Seat, flags: { created: boolean; resumed: boolean }): void {
    if (!seat.ws) return;
    const lobby = this.buildLobbyState(room);
    this.sendToClient(seat.ws, {
      type: 'room_joined',
      room_code: room.code,
      player_id: seat.player_id,
      assigned_role: seat.role,
      session_token: seat.session_token,
      created: flags.created,
      resumed: flags.resumed,
      lobby
    });
    this.broadcastToRoom(room, { type: 'lobby_update', lobby });
    this.sendToClient(seat.ws, { type: 'leaderboard_update', entries: this.getLeaderboard() });
    if (room.lastStatus !== 'lobby') {
      this.sendToClient(seat.ws, { type: 'world_state', payload: room.simulation.getWorldStatePayload() });
    }
  }

  public expireIdleRooms(now = Date.now()): void {
    for (const room of Array.from(this.rooms.values())) {
      const idle = now - room.lastActivity;
      const anyConnected = Array.from(room.players.values()).some((p) => p.ws !== null);
      if ((!anyConnected && idle > this.idleExpiryMs) || idle > this.hardIdleExpiryMs) {
        this.closeRoom(room, 'expired');
      }
    }
  }

  private closeRoom(room: GameRoom, reason: RoomErrorCode): void {
    for (const seat of room.players.values()) {
      if (seat.ws) {
        this.sendRoomError(seat.ws, reason, room.code);
        this.clientToRoom.delete(seat.ws);
      }
    }
    this.clearRoomTimers(room);
    this.releaseTournamentPass(room);
    this.rooms.delete(room.code);
  }

  /**
   * Frees the pass when the room empties or closes, and un-verifies the room so whoever
   * joins the empty room later does not play under the paid pair. The pair re-binds it
   * on return (the client re-sends set_tournament_pass on room_joined).
   */
  private releaseTournamentPass(room: GameRoom): void {
    if (room.tournamentPass && this.passToRoom.get(room.tournamentPass) === room.code) {
      this.passToRoom.delete(room.tournamentPass);
    }
    room.isTournamentVerified = false;
    room.tournamentPass = undefined;
    room.tournamentPair = undefined;
  }

  private clearRoomTimers(room: GameRoom): void {
    for (const seat of room.players.values()) {
      if (seat.graceTimer) clearTimeout(seat.graceTimer);
    }
    if (room.pendingSwap) clearTimeout(room.pendingSwap.timer);
  }

  // -------------------------------------------------------------
  // Roles, readiness, match start
  // -------------------------------------------------------------

  public switchRole(ws: WebSocket, targetRole: PlayerRole): void {
    const ctx = this.context(ws);
    if (!ctx) return;
    const { room, seat } = ctx;
    if (targetRole !== 'driver' && targetRole !== 'navigator') return;
    if (seat.role === targetRole) return;
    this.touch(room);

    const holder = Array.from(room.players.values()).find(
      (p) => p.player_id !== seat.player_id && p.role === targetRole
    );
    if (!holder) {
      seat.role = targetRole;
      seat.ready = false;
      this.broadcastLobby(room);
      return;
    }

    if (!holder.ws) {
      this.sendRoomError(ws, 'not_allowed', room.code, 'Tu pareja está desconectada; espera a que vuelva para cambiar de rol.');
      return;
    }

    // Seat taken: ask the other player.
    this.cancelPendingSwap(room);
    room.pendingSwap = {
      fromPlayerId: seat.player_id,
      toPlayerId: holder.player_id,
      timer: setTimeout(() => {
        room.pendingSwap = null;
        this.broadcastLobby(room);
      }, this.roleSwapTimeoutMs)
    };
    this.sendToClient(holder.ws, {
      type: 'role_swap_request',
      from_player_id: seat.player_id,
      from_name: seat.name,
      requested_role: targetRole
    });
    this.broadcastLobby(room);
  }

  public respondRoleSwap(ws: WebSocket, accept: boolean): void {
    const ctx = this.context(ws);
    if (!ctx) return;
    const { room, seat } = ctx;
    const swap = room.pendingSwap;
    if (!swap || swap.toPlayerId !== seat.player_id) return;
    this.cancelPendingSwap(room);
    this.touch(room);

    const requester = room.players.get(swap.fromPlayerId);
    if (accept && requester) {
      const tmp = requester.role;
      requester.role = seat.role;
      seat.role = tmp;
      requester.ready = false;
      seat.ready = false;
    }
    this.broadcastLobby(room);
  }

  public setReady(ws: WebSocket, ready: boolean): void {
    const ctx = this.context(ws);
    if (!ctx) return;
    ctx.seat.ready = Boolean(ready);
    this.touch(ctx.room);
    this.broadcastLobby(ctx.room);
  }

  /**
   * start_match / instant_rematch: marks the sender ready and starts once the
   * crew is complete — both seats ready, or the host alone (AI co-pilot).
   */
  public startMatch(ws: WebSocket): void {
    const ctx = this.context(ws);
    if (!ctx) return;
    const { room, seat } = ctx;
    this.touch(room);
    if (room.lastStatus === 'running' || room.lastStatus === 'ad_revive_prompt') return;

    seat.ready = true;
    const seats = Array.from(room.players.values());
    const canStart =
      seats.length === 1
        ? room.hostPlayerId === seat.player_id
        : seats.every((p) => p.ready && p.ws !== null);

    if (!canStart) {
      this.broadcastLobby(room);
      return;
    }

    room.simulation.startMatch();
    room.lastStatus = 'running';
    room.scoreRecorded = false;
    seats.forEach((p) => (p.ready = false));
    this.broadcastLobby(room);
  }

  public updateCosmetics(ws: WebSocket, cosmetics: CosmeticLoadout): void {
    const ctx = this.context(ws);
    if (!ctx) return;
    ctx.seat.cosmetics = cosmetics;
    this.touch(ctx.room);
    this.broadcastLobby(ctx.room);
  }

  public handleSendComms(ws: WebSocket, preset: TacticalCommsPreset): void {
    const ctx = this.context(ws);
    if (!ctx) return;
    const { room, seat } = ctx;
    this.touch(room);

    const details = COMMS_PRESET_MAP[preset] || COMMS_PRESET_MAP.bogey_alert;
    const event: TacticalCommsEvent = {
      id: `comms-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      sender_name: seat.name,
      sender_role: seat.role,
      preset,
      code: details.code,
      label: details.label,
      timestamp: Date.now()
    };

    this.broadcastToRoom(room, {
      type: 'comms_broadcast',
      event
    });
  }

  public handlePlayerInput(ws: WebSocket, input: ClientInputPayload): void {
    const ctx = this.context(ws);
    if (!ctx) return;
    const { room, seat } = ctx;
    room.lastActivity = Date.now();

    const mechaPos = room.simulation.getWorldStatePayload().entity_positions.mecha;
    const { sanitized } = antiCheatEngine.sanitizeClientInput(
      input,
      mechaPos.x,
      mechaPos.y
    );

    room.simulation.applyPlayerInput({
      ...sanitized,
      player_id: seat.player_id,
      role: seat.role
    });
  }

  public handleWatchRewardedAd(ws: WebSocket): void {
    const ctx = this.context(ws);
    if (!ctx) return;
    const { room } = ctx;
    this.touch(room);

    if (room.simulation.reviveWithRewardedAd()) {
      room.lastStatus = 'running';
      this.broadcastLobby(room);
    }
  }

  public handleDeclineRewardedAd(ws: WebSocket): void {
    const ctx = this.context(ws);
    if (!ctx) return;
    this.touch(ctx.room);
    ctx.room.simulation.declineRewardedAd();
  }

  public tickAllRooms(): void {
    for (const room of this.rooms.values()) {
      const status = room.simulation.getStatus();
      if (status === 'running') {
        const connected = Array.from(room.players.values()).filter((p) => p.ws !== null);
        // Nobody watching: pause until someone reconnects.
        if (connected.length === 0) continue;
        if (!connected.some((p) => p.role === 'driver')) {
          room.simulation.updateBotCoPilot('driver');
        }
        if (!connected.some((p) => p.role === 'navigator')) {
          room.simulation.updateBotCoPilot('navigator');
        }

        const statePayload = room.simulation.step(1 / 60);
        this.broadcastToRoom(room, {
          type: 'world_state',
          payload: statePayload
        });

        const nextStatus = statePayload.world_state.status;
        if (nextStatus !== room.lastStatus) {
          room.lastStatus = nextStatus;
          this.broadcastLobby(room);

          if (nextStatus === 'gameover' && !room.scoreRecorded) {
            this.recordRoomScore(room, statePayload);
          }
        }
      } else if (status === 'gameover' && !room.scoreRecorded) {
        const statePayload = room.simulation.getWorldStatePayload();
        room.lastStatus = 'gameover';
        this.recordRoomScore(room, statePayload);
        this.broadcastToRoom(room, {
          type: 'world_state',
          payload: statePayload
        });
        this.broadcastLobby(room);
      }
    }
  }

  public async handleSetTournamentPass(ws: WebSocket, passCodeRaw: string): Promise<void> {
    if (!this.context(ws) || !this.verifyPass) return;
    const passCode = passCodeRaw.trim().toUpperCase();

    let check: Awaited<ReturnType<TournamentPassVerifier>>;
    try {
      check = await this.verifyPass(passCode);
    } catch {
      this.sendToClient(ws, { type: 'error', message: 'No se pudo verificar el pase en este momento.' });
      return;
    }

    // Re-check after the await: the socket may have left or been replaced meanwhile.
    const ctx = this.context(ws);
    if (!ctx) return;
    const { room } = ctx;
    if (!check.valid) {
      this.sendToClient(ws, { type: 'error', message: 'Pase de torneo inválido.' });
      return;
    }

    // Empty rooms stay alive until idle expiry and keep their pass meanwhile.
    const claimedBy = this.passToRoom.get(passCode);
    if (claimedBy && claimedBy !== room.code && this.rooms.has(claimedBy)) {
      this.sendToClient(ws, { type: 'error', message: 'Este pase ya está en uso en otra sala.' });
      return;
    }

    if (room.tournamentPass && room.tournamentPass !== passCode) {
      this.passToRoom.delete(room.tournamentPass);
    }
    this.passToRoom.set(passCode, room.code);
    room.isTournamentVerified = true;
    room.tournamentPass = passCode;
    room.tournamentPair = {
      driver_name: check.driver_name || 'PILOT_A',
      navigator_name: check.navigator_name || 'PILOT_B'
    };
    this.touch(room);
    this.broadcastLobby(room);
  }

  private recordRoomScore(
    room: GameRoom,
    state: ReturnType<GameSimulation['getWorldStatePayload']>
  ): void {
    room.scoreRecorded = true;
    const players = Array.from(room.players.values());
    // Tournament scores are attributed to the registered (paid) pair, not to free-form nicknames
    const driver =
      room.tournamentPair?.driver_name || players.find((p) => p.role === 'driver')?.name || 'AI_DRIVER';
    const navigator =
      room.tournamentPair?.navigator_name || players.find((p) => p.role === 'navigator')?.name || 'AI_NAVIGATOR';

    const updated = this.addLeaderboardEntry({
      room_code: room.code,
      driver_name: driver,
      navigator_name: navigator,
      total_score: state.world_state.total_score,
      distance_traveled: state.world_state.distance_traveled,
      survival_time: state.world_state.survival_time,
      region: 'PACIFIC-NET',
      is_tournament: Boolean(room.isTournamentVerified)
    });

    this.broadcastToRoom(room, {
      type: 'leaderboard_update',
      entries: updated
    });
  }

  // -------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------

  private context(ws: WebSocket): { room: GameRoom; seat: Seat } | null {
    const meta = this.clientToRoom.get(ws);
    if (!meta) return null;
    const room = this.rooms.get(meta.roomCode);
    const seat = room?.players.get(meta.playerId);
    if (!room || !seat || seat.ws !== ws) return null;
    return { room, seat };
  }

  private touch(room: GameRoom): void {
    room.lastActivity = Date.now();
  }

  private cancelPendingSwap(room: GameRoom): void {
    if (room.pendingSwap) {
      clearTimeout(room.pendingSwap.timer);
      room.pendingSwap = null;
    }
  }

  private cleanName(name: string): string {
    return (String(name || '') || 'PILOT').slice(0, 16).toUpperCase() || 'PILOT';
  }

  private sendRoomError(ws: WebSocket, code: RoomErrorCode, roomCode?: string, message?: string): void {
    this.sendToClient(ws, {
      type: 'room_error',
      code,
      room_code: roomCode,
      message: message || ROOM_ERROR_MESSAGES[code]
    });
  }

  private buildLobbyState(room: GameRoom): RoomLobbyState {
    const now = Date.now();
    return {
      room_code: room.code,
      status: room.simulation.getStatus(),
      max_players: MAX_PLAYERS_PER_ROOM,
      // The pass itself is never broadcast to other clients
      is_tournament_verified: Boolean(room.isTournamentVerified),
      pending_role_swap: room.pendingSwap
        ? { from_player_id: room.pendingSwap.fromPlayerId, to_player_id: room.pendingSwap.toPlayerId }
        : undefined,
      players: Array.from(room.players.values()).map((p) => ({
        player_id: p.player_id,
        name: p.name,
        role: p.role,
        ready: p.ready,
        cosmetics: p.cosmetics,
        is_host: room.hostPlayerId === p.player_id,
        connected: p.ws !== null,
        grace_remaining_ms:
          p.disconnectedAt !== null
            ? Math.max(0, this.reconnectGraceMs - (now - p.disconnectedAt))
            : undefined
      }))
    };
  }

  private broadcastLobby(room: GameRoom): void {
    this.broadcastToRoom(room, { type: 'lobby_update', lobby: this.buildLobbyState(room) });
  }

  private sendToClient(ws: WebSocket, msg: WsServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcastToRoom(room: GameRoom, msg: WsServerMessage): void {
    const serialized = JSON.stringify(msg);
    for (const player of room.players.values()) {
      if (player.ws && player.ws.readyState === player.ws.OPEN) {
        player.ws.send(serialized);
      }
    }
  }
}
