import type { WebSocket } from 'ws';
import { GameSimulation } from '../shared/simulation.js';
import type {
  ClientInputPayload,
  CosmeticLoadout,
  LeaderboardEntry,
  PlayerRole,
  RoomLobbyState,
  RoomPlayerInfo,
  TacticalCommsEvent,
  TacticalCommsPreset,
  WsServerMessage
} from '../shared/types.js';

interface ConnectedPlayer extends RoomPlayerInfo {
  ws: WebSocket;
}

interface GameRoom {
  code: string;
  players: Map<string, ConnectedPlayer>;
  simulation: GameSimulation;
  lastStatus: 'lobby' | 'running' | 'ad_revive_prompt' | 'gameover';
  scoreRecorded: boolean;
}

export const COMMS_PRESET_MAP: Record<TacticalCommsPreset, { code: string; label: string }> = {
  bogey_alert: { code: 'TAC-01 // BOGEY LOCK', label: '⚠️ BOGEY INBOUND — DEPLOY FLANK SHIELD' },
  nice_deflect: { code: 'TAC-02 // INTERCEPT', label: '🛡️ DIRECT INTERCEPT CONFIRMED — GOOD SAVE' },
  engage_overdrive: { code: 'TAC-03 // MACH BURN', label: '⚡ ENGAGE AFTERBURNER OVERDRIVE NOW' },
  mayday_panic: { code: 'TAC-04 // VELOCITY CRIT', label: '💀 CRITICAL STALL — INCREASE THROTTLE!' }
};

export class RoomManager {
  private rooms = new Map<string, GameRoom>();
  private clientToRoom = new Map<WebSocket, { roomCode: string; playerId: string }>();
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

  constructor() {
    setInterval(() => {
      this.tickAllRooms();
    }, 1000 / 60);
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

  public joinRoom(
    ws: WebSocket,
    roomCodeRaw: string,
    playerId: string,
    name: string,
    preferredRole: PlayerRole | undefined,
    cosmetics: CosmeticLoadout
  ): void {
    this.removeSocket(ws);

    const roomCode = (roomCodeRaw || 'NEURAL-01').toUpperCase().replace(/[^A-Z0-9-]/g, '');
    let room = this.rooms.get(roomCode);
    if (!room) {
      room = {
        code: roomCode,
        players: new Map(),
        simulation: new GameSimulation(false),
        lastStatus: 'lobby',
        scoreRecorded: false
      };
      this.rooms.set(roomCode, room);
    }

    const existingPlayers = Array.from(room.players.values());
    const hasDriver = existingPlayers.some((p) => p.role === 'driver' && p.player_id !== playerId);
    const hasNavigator = existingPlayers.some(
      (p) => p.role === 'navigator' && p.player_id !== playerId
    );

    let assignedRole: PlayerRole = preferredRole || 'driver';
    if (assignedRole === 'driver' && hasDriver && !hasNavigator) {
      assignedRole = 'navigator';
    } else if (assignedRole === 'navigator' && hasNavigator && !hasDriver) {
      assignedRole = 'driver';
    } else if (!preferredRole) {
      assignedRole = hasDriver ? 'navigator' : 'driver';
    }

    const playerInfo: ConnectedPlayer = {
      player_id: playerId,
      name: (name || 'PILOT').slice(0, 16).toUpperCase(),
      role: assignedRole,
      ready: true,
      cosmetics,
      ws
    };

    room.players.set(playerId, playerInfo);
    this.clientToRoom.set(ws, { roomCode, playerId });

    const lobby = this.buildLobbyState(room);
    this.sendToClient(ws, {
      type: 'room_joined',
      room_code: roomCode,
      player_id: playerId,
      assigned_role: assignedRole,
      lobby
    });

    this.broadcastToRoom(room, {
      type: 'lobby_update',
      lobby
    });

    this.sendToClient(ws, {
      type: 'leaderboard_update',
      entries: this.getLeaderboard()
    });
  }

  public switchRole(ws: WebSocket, targetRole: PlayerRole): void {
    const meta = this.clientToRoom.get(ws);
    if (!meta) return;
    const room = this.rooms.get(meta.roomCode);
    if (!room) return;
    const player = room.players.get(meta.playerId);
    if (!player) return;

    for (const other of room.players.values()) {
      if (other.player_id !== player.player_id && other.role === targetRole) {
        other.role = player.role;
      }
    }
    player.role = targetRole;

    this.broadcastToRoom(room, {
      type: 'lobby_update',
      lobby: this.buildLobbyState(room)
    });
  }

  public updateCosmetics(ws: WebSocket, cosmetics: CosmeticLoadout): void {
    const meta = this.clientToRoom.get(ws);
    if (!meta) return;
    const room = this.rooms.get(meta.roomCode);
    if (!room) return;
    const player = room.players.get(meta.playerId);
    if (!player) return;

    player.cosmetics = cosmetics;
    this.broadcastToRoom(room, {
      type: 'lobby_update',
      lobby: this.buildLobbyState(room)
    });
  }

  public startMatch(ws: WebSocket): void {
    const meta = this.clientToRoom.get(ws);
    if (!meta) return;
    const room = this.rooms.get(meta.roomCode);
    if (!room) return;

    room.simulation.startMatch();
    room.lastStatus = 'running';
    room.scoreRecorded = false;

    this.broadcastToRoom(room, {
      type: 'lobby_update',
      lobby: this.buildLobbyState(room)
    });
  }

  public handleSendComms(ws: WebSocket, preset: TacticalCommsPreset): void {
    const meta = this.clientToRoom.get(ws);
    if (!meta) return;
    const room = this.rooms.get(meta.roomCode);
    if (!room) return;
    const player = room.players.get(meta.playerId);
    if (!player) return;

    const details = COMMS_PRESET_MAP[preset] || COMMS_PRESET_MAP.bogey_alert;
    const event: TacticalCommsEvent = {
      id: `comms-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      sender_name: player.name,
      sender_role: player.role,
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
    const meta = this.clientToRoom.get(ws);
    if (!meta) return;
    const room = this.rooms.get(meta.roomCode);
    if (!room) return;
    const player = room.players.get(meta.playerId);
    if (!player) return;

    room.simulation.applyPlayerInput({
      ...input,
      role: player.role
    });
  }

  public handleWatchRewardedAd(ws: WebSocket): void {
    const meta = this.clientToRoom.get(ws);
    if (!meta) return;
    const room = this.rooms.get(meta.roomCode);
    if (!room) return;

    if (room.simulation.reviveWithRewardedAd()) {
      room.lastStatus = 'running';
      this.broadcastToRoom(room, {
        type: 'lobby_update',
        lobby: this.buildLobbyState(room)
      });
    }
  }

  public handleDeclineRewardedAd(ws: WebSocket): void {
    const meta = this.clientToRoom.get(ws);
    if (!meta) return;
    const room = this.rooms.get(meta.roomCode);
    if (!room) return;

    room.simulation.declineRewardedAd();
  }

  public removeSocket(ws: WebSocket): void {
    const meta = this.clientToRoom.get(ws);
    if (!meta) return;
    this.clientToRoom.delete(ws);

    const room = this.rooms.get(meta.roomCode);
    if (!room) return;

    room.players.delete(meta.playerId);
    if (room.players.size === 0) {
      this.rooms.delete(meta.roomCode);
    } else {
      this.broadcastToRoom(room, {
        type: 'lobby_update',
        lobby: this.buildLobbyState(room)
      });
    }
  }

  private tickAllRooms(): void {
    for (const room of this.rooms.values()) {
      const status = room.simulation.getStatus();
      if (status === 'running') {
        const players = Array.from(room.players.values());
        const hasDriver = players.some((p) => p.role === 'driver');
        const hasNavigator = players.some((p) => p.role === 'navigator');
        if (!hasDriver) {
          room.simulation.updateBotCoPilot('driver');
        }
        if (!hasNavigator) {
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
          this.broadcastToRoom(room, {
            type: 'lobby_update',
            lobby: this.buildLobbyState(room)
          });

          if (nextStatus === 'gameover' && !room.scoreRecorded) {
            this.recordRoomScore(room, statePayload);
          }
        }
      } else if (status === 'gameover' && !room.scoreRecorded) {
        const statePayload = room.simulation.getWorldStatePayload();
        this.recordRoomScore(room, statePayload);
        this.broadcastToRoom(room, {
          type: 'world_state',
          payload: statePayload
        });
        this.broadcastToRoom(room, {
          type: 'lobby_update',
          lobby: this.buildLobbyState(room)
        });
      }
    }
  }

  private recordRoomScore(
    room: GameRoom,
    state: ReturnType<GameSimulation['getWorldStatePayload']>
  ): void {
    room.scoreRecorded = true;
    const players = Array.from(room.players.values());
    const driver = players.find((p) => p.role === 'driver')?.name || 'AI_DRIVER';
    const navigator = players.find((p) => p.role === 'navigator')?.name || 'AI_NAVIGATOR';

    const updated = this.addLeaderboardEntry({
      room_code: room.code,
      driver_name: driver,
      navigator_name: navigator,
      total_score: state.world_state.total_score,
      distance_traveled: state.world_state.distance_traveled,
      survival_time: state.world_state.survival_time,
      region: 'PACIFIC-NET'
    });

    this.broadcastToRoom(room, {
      type: 'leaderboard_update',
      entries: updated
    });
  }

  private buildLobbyState(room: GameRoom): RoomLobbyState {
    return {
      room_code: room.code,
      status: room.simulation.getStatus(),
      players: Array.from(room.players.values()).map((p) => ({
        player_id: p.player_id,
        name: p.name,
        role: p.role,
        ready: p.ready,
        cosmetics: p.cosmetics
      }))
    };
  }

  private sendToClient(ws: WebSocket, msg: WsServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcastToRoom(room: GameRoom, msg: WsServerMessage): void {
    const serialized = JSON.stringify(msg);
    for (const player of room.players.values()) {
      if (player.ws.readyState === player.ws.OPEN) {
        player.ws.send(serialized);
      }
    }
  }
}
