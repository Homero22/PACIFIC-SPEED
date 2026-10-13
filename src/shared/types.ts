export type PlayerRole = 'driver' | 'navigator';
export type ShieldSide = 'left' | 'right';
export type LaneIndex = 0 | 1 | 2;
export type GameMode = 'online' | 'local_coop' | 'local_bot';

export type TacticalCommsPreset =
  | 'bogey_alert'
  | 'nice_deflect'
  | 'engage_overdrive'
  | 'mayday_panic';

export interface TacticalCommsEvent {
  id: string;
  sender_name: string;
  sender_role: PlayerRole;
  preset: TacticalCommsPreset;
  code: string;
  label: string;
  timestamp: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Circle {
  x: number;
  y: number;
  radius: number;
}

export interface CosmeticLoadout {
  paintJob: 'crimson_jaeger' | 'cyber_gold' | 'phantom_stealth';
  neonTrail: 'plasma_cyan' | 'overdrive_magenta' | 'solar_flare';
  hudTheme: 'tactical_amber' | 'neural_green' | 'abyssal_violet';
}

export interface ClientInputPayload {
  player_id: string;
  role: PlayerRole;
  input_vector: Vec2; // x: steering [-1, 1], y: throttle [-1, 1]
  action_flags: {
    shield_left: boolean;
    shield_right: boolean;
    radar_pulse: boolean;
    ping_lane: LaneIndex | null;
  };
  timestamp: number;
  seq: number;
}

export type ObstacleType =
  | 'barrier'
  | 'flank_left'
  | 'flank_right'
  | 'overdrive_cell'
  | 'repair_cell';

export interface ObstacleEntity {
  id: string;
  type: ObstacleType;
  lane: LaneIndex;
  x: number;
  y: number;
  width: number;
  height: number;
  vx: number;
  vy: number;
  side_threat?: ShieldSide;
}

export interface TacticalPing {
  id: string;
  lane: LaneIndex;
  x: number;
  y_offset: number;
  ttl: number;
  max_ttl: number;
}

export type SoundEventType =
  | 'shield_deflect'
  | 'collision_damage'
  | 'ping_deployed'
  | 'overdrive_activated'
  | 'explosion'
  | 'revive';

export interface SoundEvent {
  id: string;
  type: SoundEventType;
  timestamp: number;
}

export interface ServerWorldStatePayload {
  tick: number;
  timestamp: number;
  world_state: {
    status: 'lobby' | 'running' | 'ad_revive_prompt' | 'gameover';
    distance_traveled: number;
    survival_time: number;
    total_score: number;
    integrity: number;
    max_integrity: number;
    self_destruct_timer: number | null;
    is_overdrive: boolean;
    overdrive_timer: number;
    ad_revive_used: boolean;
    collision_penalty: number;
    active_shields: {
      left: boolean;
      right: boolean;
      energy: number;
      max_energy: number;
    };
    active_pings: TacticalPing[];
    events: SoundEvent[];
  };
  entity_positions: {
    mecha: {
      x: number;
      y: number;
      vx: number;
      vy: number;
      width: number;
      height: number;
      radius: number;
      current_lane: LaneIndex;
    };
    obstacles: ObstacleEntity[];
  };
  speed_multiplier: {
    current_speed: number;
    base_speed: number;
    max_speed: number;
    critical_threshold: number;
    normalized: number;
  };
  fog_matrix: {
    visibility_radius: number;
    tunnel_intensity: number;
    radar_reveal_timer: number;
  };
}

export interface RoomPlayerInfo {
  player_id: string;
  name: string;
  role: PlayerRole;
  ready: boolean;
  cosmetics: CosmeticLoadout;
}

export interface RoomLobbyState {
  room_code: string;
  players: RoomPlayerInfo[];
  status: 'lobby' | 'running' | 'ad_revive_prompt' | 'gameover';
}

export interface LeaderboardEntry {
  id: string;
  room_code: string;
  driver_name: string;
  navigator_name: string;
  total_score: number;
  distance_traveled: number;
  survival_time: number;
  region: string;
  created_at: string;
}

export type WsClientMessage =
  | {
      type: 'join_room';
      room_code: string;
      player_id: string;
      name: string;
      preferred_role?: PlayerRole;
      cosmetics: CosmeticLoadout;
    }
  | { type: 'switch_role'; role: PlayerRole }
  | { type: 'update_cosmetics'; cosmetics: CosmeticLoadout }
  | { type: 'start_match' }
  | { type: 'instant_rematch' }
  | { type: 'watch_rewarded_ad' }
  | { type: 'decline_rewarded_ad' }
  | { type: 'send_comms'; preset: TacticalCommsPreset }
  | { type: 'player_input'; payload: ClientInputPayload };

export type WsServerMessage =
  | {
      type: 'room_joined';
      room_code: string;
      player_id: string;
      assigned_role: PlayerRole;
      lobby: RoomLobbyState;
    }
  | { type: 'lobby_update'; lobby: RoomLobbyState }
  | { type: 'world_state'; payload: ServerWorldStatePayload }
  | { type: 'comms_broadcast'; event: TacticalCommsEvent }
  | { type: 'leaderboard_update'; entries: LeaderboardEntry[] }
  | { type: 'error'; message: string };
