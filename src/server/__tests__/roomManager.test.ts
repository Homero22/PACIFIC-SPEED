import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tournamentTrackSeed } from '../../shared/random.js';
import { ROOM_CODE_PATTERN } from '../../shared/types.js';
import type { CosmeticLoadout, WsServerMessage } from '../../shared/types.js';

const { RoomManager, generateRoomCode } = await import('../roomManager.js');
const { roomFromQuery, withRoomParam } = await import('../roomUrls.js');

const GRACE_MS = 30_000;

const cosmetics: CosmeticLoadout = {
  paintJob: 'crimson_jaeger',
  neonTrail: 'plasma_cyan',
  hudTheme: 'tactical_amber'
};

/** Minimal stand-in for a ws socket: records what the server sends. */
class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  sent: WsServerMessage[] = [];
  closedWith: number | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.readyState = 3;
    this.closedWith = code ?? 1000;
  }
  last<T extends WsServerMessage['type']>(type: T): Extract<WsServerMessage, { type: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].type === type) return this.sent[i] as Extract<WsServerMessage, { type: T }>;
    }
    return undefined;
  }
  get ws() {
    return this as unknown as WebSocket;
  }
}

describe('RoomManager — room lifecycle', () => {
  let rm: InstanceType<typeof RoomManager>;

  beforeEach(() => {
    vi.useFakeTimers();
    rm = new RoomManager(undefined, { autoTick: false, reconnectGraceMs: GRACE_MS, idleExpiryMs: 30 * 60_000 });
  });

  afterEach(() => {
    rm.dispose();
    vi.useRealTimers();
  });

  const create = (name = 'ANA') => {
    const s = new FakeSocket();
    rm.createRoom(s.ws, name, undefined, cosmetics);
    const joined = s.last('room_joined')!;
    return { s, joined, code: joined.room_code, token: joined.session_token };
  };

  const join = (code: string, name = 'BETO', token?: string, takeover = false) => {
    const s = new FakeSocket();
    rm.joinRoom(s.ws, code, name, cosmetics, token, takeover);
    return s;
  };

  it('create_room returns a unique 6-char code without ambiguous characters', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { code, joined } = create();
      expect(code).toMatch(ROOM_CODE_PATTERN);
      expect(code).not.toMatch(/[01OI]/);
      expect(joined.created).toBe(true);
      expect(joined.session_token.length).toBeGreaterThanOrEqual(32);
      codes.add(code);
    }
    expect(codes.size).toBe(200);
    for (let i = 0; i < 1000; i++) expect(generateRoomCode()).toMatch(ROOM_CODE_PATTERN);
  });

  it('join_room to an unknown code fails instead of creating a room', () => {
    const s = join('ABCDEF');
    expect(s.last('room_error')?.code).toBe('not_found');
    expect(s.last('room_joined')).toBeUndefined();
    expect(rm.getRoomCount()).toBe(0);
  });

  it('rejects malformed / legacy codes', () => {
    expect(join('NEURAL-X7Q').last('room_error')?.code).toBe('invalid_code');
    expect(join('').last('room_error')?.code).toBe('invalid_code');
    expect(rm.getRoomCount()).toBe(0);
  });

  it('accepts lowercase codes from a typed/shared link', () => {
    const { code } = create();
    const b = join(code.toLowerCase());
    expect(b.last('room_joined')?.room_code).toBe(code);
  });

  it('partner joining via link lands in the same room with the other role', () => {
    const a = create('ANA');
    const b = join(a.code, 'BETO');
    const joined = b.last('room_joined')!;
    expect(joined.room_code).toBe(a.code);
    expect(a.joined.assigned_role).toBe('driver');
    expect(joined.assigned_role).toBe('navigator');
    expect(a.s.last('lobby_update')?.lobby.players.map((p) => p.name).sort()).toEqual(['ANA', 'BETO']);
  });

  it('a third player gets "full" and does not take a duplicate role', () => {
    const a = create();
    join(a.code, 'BETO');
    const c = join(a.code, 'CARLA');
    expect(c.last('room_error')?.code).toBe('full');
    expect(c.last('room_error')?.message).toMatch(/Sala llena/);
    const lobby = a.s.last('lobby_update')!.lobby;
    expect(lobby.players).toHaveLength(2);
    expect(new Set(lobby.players.map((p) => p.role)).size).toBe(2);
  });

  it('player_id is server-generated; a forged token cannot take a seat', () => {
    const a = create('ANA');
    join(a.code, 'BETO');
    const intruder = join(a.code, 'EVIL', 'forged-token', true);
    expect(intruder.last('room_error')?.code).toBe('full');
    expect(a.joined.player_id).toMatch(/^P-[0-9A-F]{12}$/);
  });

  it('session token is never broadcast to the partner', () => {
    const a = create();
    const b = join(a.code);
    const serialized = JSON.stringify(b.sent);
    expect(serialized).not.toContain(a.token);
  });

  describe('roles', () => {
    it('switching to a free seat is immediate', () => {
      const a = create();
      rm.switchRole(a.s.ws, 'navigator');
      expect(a.s.last('lobby_update')!.lobby.players[0].role).toBe('navigator');
    });

    it('switching to an occupied seat requires the partner to accept', () => {
      const a = create('ANA');
      const b = join(a.code, 'BETO');
      rm.switchRole(a.s.ws, 'navigator');

      const req = b.last('role_swap_request')!;
      expect(req.from_name).toBe('ANA');
      // Nothing changes until accepted
      let lobby = a.s.last('lobby_update')!.lobby;
      expect(lobby.players.find((p) => p.name === 'ANA')!.role).toBe('driver');
      expect(lobby.pending_role_swap).toBeDefined();

      // Only the target can answer
      rm.respondRoleSwap(a.s.ws, true);
      lobby = a.s.last('lobby_update')!.lobby;
      expect(lobby.players.find((p) => p.name === 'ANA')!.role).toBe('driver');

      rm.respondRoleSwap(b.ws, true);
      lobby = a.s.last('lobby_update')!.lobby;
      expect(lobby.players.find((p) => p.name === 'ANA')!.role).toBe('navigator');
      expect(lobby.players.find((p) => p.name === 'BETO')!.role).toBe('driver');
      expect(lobby.pending_role_swap).toBeUndefined();
    });

    it('a rejected swap keeps the roles', () => {
      const a = create('ANA');
      const b = join(a.code, 'BETO');
      rm.switchRole(a.s.ws, 'navigator');
      rm.respondRoleSwap(b.ws, false);
      const lobby = a.s.last('lobby_update')!.lobby;
      expect(lobby.players.find((p) => p.name === 'ANA')!.role).toBe('driver');
      expect(lobby.pending_role_swap).toBeUndefined();
    });

    it('swap requests expire', () => {
      const a = create();
      join(a.code);
      rm.switchRole(a.s.ws, 'navigator');
      vi.advanceTimersByTime(21_000);
      expect(a.s.last('lobby_update')!.lobby.pending_role_swap).toBeUndefined();
    });
  });

  describe('match start', () => {
    it('host alone can start with the AI co-pilot', () => {
      const a = create();
      rm.startMatch(a.s.ws);
      expect(a.s.last('lobby_update')!.lobby.status).toBe('running');
    });

    it('with two players, the match starts only when both are ready', () => {
      const a = create();
      const b = join(a.code);
      rm.startMatch(a.s.ws);
      let lobby = b.last('lobby_update')!.lobby;
      expect(lobby.status).toBe('lobby');
      expect(lobby.players.find((p) => p.player_id === a.joined.player_id)!.ready).toBe(true);

      rm.startMatch(b.ws);
      lobby = b.last('lobby_update')!.lobby;
      expect(lobby.status).toBe('running');
      // readiness resets for the next rematch
      expect(lobby.players.every((p) => !p.ready)).toBe(true);
    });

    it('cannot start while the partner is disconnected (grace period)', () => {
      const a = create();
      const b = join(a.code);
      rm.removeSocket(b.ws);
      rm.startMatch(a.s.ws);
      expect(a.s.last('lobby_update')!.lobby.status).toBe('lobby');
    });

    it('a socket that is not in a room cannot start anything', () => {
      const a = create();
      const stranger = new FakeSocket();
      rm.startMatch(stranger.ws);
      rm.switchRole(stranger.ws, 'navigator');
      expect(a.s.last('lobby_update')!.lobby.status).toBe('lobby');
      expect(stranger.sent).toHaveLength(0);
    });
  });

  describe('reconnection', () => {
    it('keeps the seat for the grace period and shows the countdown', () => {
      const a = create('ANA');
      const b = join(a.code, 'BETO');
      const bToken = b.last('room_joined')!.session_token;
      rm.removeSocket(b.ws);

      let partner = a.s.last('lobby_update')!.lobby.players.find((p) => p.name === 'BETO')!;
      expect(partner.connected).toBe(false);
      expect(partner.grace_remaining_ms).toBe(GRACE_MS);

      vi.advanceTimersByTime(20_000);
      const b2 = join(a.code, 'BETO', bToken);
      const rejoined = b2.last('room_joined')!;
      expect(rejoined.resumed).toBe(true);
      expect(rejoined.player_id).toBe(b.last('room_joined')!.player_id);
      expect(rejoined.assigned_role).toBe('navigator');
      partner = a.s.last('lobby_update')!.lobby.players.find((p) => p.name === 'BETO')!;
      expect(partner.connected).toBe(true);

      // Grace timer was cancelled
      vi.advanceTimersByTime(GRACE_MS * 2);
      expect(a.s.last('lobby_update')!.lobby.players).toHaveLength(2);
    });

    it('releases the seat after the grace period; the room survives for the link', () => {
      const a = create('ANA');
      const b = join(a.code, 'BETO');
      rm.removeSocket(b.ws);
      vi.advanceTimersByTime(GRACE_MS + 1);
      expect(a.s.last('lobby_update')!.lobby.players.map((p) => p.name)).toEqual(['ANA']);

      // Host leaves too: room is empty but still joinable (no instant delete)
      rm.removeSocket(a.s.ws);
      vi.advanceTimersByTime(GRACE_MS + 1);
      expect(rm.hasRoom(a.code)).toBe(true);
      const c = join(a.code, 'CARLA');
      expect(c.last('room_joined')?.room_code).toBe(a.code);
      expect(c.last('lobby_update')!.lobby.players[0].is_host).toBe(true);
    });

    it('stale socket closing after a reconnect does not evict the new one', () => {
      const a = create('ANA');
      const b = join(a.code, 'BETO');
      const token = b.last('room_joined')!.session_token;

      // Reconnect arrives before the old socket's close event (common on mobile)
      const b2 = join(a.code, 'BETO', token, true);
      expect(b2.last('room_joined')?.resumed).toBe(true);
      expect(b.last('session_replaced')).toBeDefined();
      expect(b.closedWith).toBe(4001);

      rm.removeSocket(b.ws); // late close of the old socket
      const partner = a.s.last('lobby_update')!.lobby.players.find((p) => p.name === 'BETO')!;
      expect(partner.connected).toBe(true);
      vi.advanceTimersByTime(GRACE_MS * 2);
      expect(a.s.last('lobby_update')!.lobby.players).toHaveLength(2);

      // The replaced socket can no longer act on the room
      rm.switchRole(b.ws, 'driver');
      expect(a.s.last('role_swap_request')).toBeUndefined();
    });

    it('a backup token without takeover does not steal a live seat (two tabs, same browser)', () => {
      const a = create('ANA');
      const tab2 = join(a.code, 'ANA', a.token, false);
      const joined = tab2.last('room_joined')!;
      expect(joined.resumed).toBe(false);
      expect(joined.player_id).not.toBe(a.joined.player_id);
      expect(a.s.last('session_replaced')).toBeUndefined();
    });

    it('a backup token resumes a seat that is disconnected', () => {
      const a = create('ANA');
      rm.removeSocket(a.s.ws);
      const back = join(a.code, 'ANA', a.token, false);
      expect(back.last('room_joined')?.resumed).toBe(true);
      expect(back.last('room_joined')?.player_id).toBe(a.joined.player_id);
    });

    it('explicit leave releases the seat immediately', () => {
      const a = create('ANA');
      const b = join(a.code, 'BETO');
      rm.leaveRoom(b.ws);
      expect(a.s.last('lobby_update')!.lobby.players).toHaveLength(1);
    });

    it('the guest becomes host when the host seat is released', () => {
      const a = create('ANA');
      const b = join(a.code, 'BETO');
      rm.leaveRoom(a.s.ws);
      const lobby = b.last('lobby_update')!.lobby;
      expect(lobby.players[0].name).toBe('BETO');
      expect(lobby.players[0].is_host).toBe(true);
      rm.startMatch(b.ws);
      expect(b.last('lobby_update')!.lobby.status).toBe('running');
    });
  });

  describe('Payphone round trip', () => {
    it('returning from Payphone in a new tab lands in the same room and seat', () => {
      const a = create('ANA');
      const b = join(a.code, 'BETO');
      // Payphone opened in a new tab; the return tab reads ps_session_<room> from localStorage
      // and joins with takeover because the URL carries ?payment=…&room=…
      const back = join(a.code, 'ANA', a.token, true);
      const joined = back.last('room_joined')!;
      expect(joined.room_code).toBe(a.code);
      expect(joined.player_id).toBe(a.joined.player_id);
      expect(joined.assigned_role).toBe('driver');
      expect(b.last('lobby_update')!.lobby.players).toHaveLength(2);
    });

    it('builds return URLs that carry the room', () => {
      expect(withRoomParam('/?payment=cancelled', 'ABCDEF')).toBe('/?payment=cancelled&room=ABCDEF');
      expect(withRoomParam('https://x.app/?payment=cancelled', 'ABCDEF')).toBe(
        'https://x.app/?payment=cancelled&room=ABCDEF'
      );
      expect(withRoomParam('/?payment=success&tx=1', undefined)).toBe('/?payment=success&tx=1');
      expect(roomFromQuery('abcdef')).toBe('ABCDEF');
      expect(roomFromQuery('ABCDEF?id=123&clientTransactionId=X')).toBe('ABCDEF');
      expect(roomFromQuery('NEURAL-X7Q')).toBeUndefined();
      expect(roomFromQuery(['ABCDEF'])).toBeUndefined();
    });
  });

  describe('tournament pass', () => {
    const verifier = vi.fn(async (code: string) =>
      code === 'PASS-OK'
        ? { valid: true, driver_name: 'PAID_DRIVER', navigator_name: 'PAID_NAV', tournament_id: 'T-OFFICIAL' }
        : { valid: false }
    );

    it('tournament matches run on the official track; practice matches get a new one', async () => {
      const seedOf = (code: string) => (rm as any).rooms.get(code).simulation.getTrackSeed() as number;

      const pro = create();
      await rm.handleSetTournamentPass(pro.s.ws, 'PASS-OK');
      rm.startMatch(pro.s.ws);
      expect(seedOf(pro.code)).toBe(tournamentTrackSeed('T-OFFICIAL'));

      const practiceA = create();
      rm.startMatch(practiceA.s.ws);
      const practiceB = create();
      rm.startMatch(practiceB.s.ws);
      expect(seedOf(practiceA.code)).not.toBe(tournamentTrackSeed('T-OFFICIAL'));
      expect(seedOf(practiceA.code)).not.toBe(seedOf(practiceB.code));
    });

    beforeEach(() => {
      rm.dispose();
      rm = new RoomManager(verifier, { autoTick: false, reconnectGraceMs: GRACE_MS });
    });

    it('binds a valid pass to the room without broadcasting the code', async () => {
      const a = create();
      const b = join(a.code);
      await rm.handleSetTournamentPass(a.s.ws, 'pass-ok');
      expect(b.last('lobby_update')!.lobby.is_tournament_verified).toBe(true);
      expect(JSON.stringify(b.sent)).not.toContain('PASS-OK');
    });

    it('rejects invalid passes and sockets outside a room', async () => {
      const a = create();
      await rm.handleSetTournamentPass(a.s.ws, 'nope');
      expect(a.s.last('error')?.message).toMatch(/inválido/);
      const stranger = new FakeSocket();
      await rm.handleSetTournamentPass(stranger.ws, 'PASS-OK');
      expect(stranger.sent).toHaveLength(0);
    });

    it('a pass is active in one room only, and is freed when that room empties', async () => {
      const a = create();
      const b = join(a.code);
      await rm.handleSetTournamentPass(a.s.ws, 'PASS-OK');
      const other = create();
      await rm.handleSetTournamentPass(other.s.ws, 'PASS-OK');
      expect(other.s.last('error')?.message).toMatch(/otra sala/);

      // Still claimed while any seat is held (connected or within the grace period)
      rm.leaveRoom(a.s.ws);
      rm.removeSocket(b.ws);
      await rm.handleSetTournamentPass(other.s.ws, 'PASS-OK');
      expect(other.s.last('lobby_update')!.lobby.is_tournament_verified).toBe(false);

      // Last seat released: room stays alive for the link but loses the pass
      vi.advanceTimersByTime(GRACE_MS + 1);
      expect(rm.hasRoom(a.code)).toBe(true);
      const stranger = join(a.code, 'STRANGER');
      expect(stranger.last('room_joined')!.lobby.is_tournament_verified).toBe(false);

      await rm.handleSetTournamentPass(other.s.ws, 'PASS-OK');
      expect(other.s.last('lobby_update')!.lobby.is_tournament_verified).toBe(true);
    });

    it('closing an expired room frees its pass', async () => {
      const a = create();
      await rm.handleSetTournamentPass(a.s.ws, 'PASS-OK');
      rm.expireIdleRooms(Date.now() + 3 * 60 * 60_000);
      expect(rm.hasRoom(a.code)).toBe(false);
      const other = create();
      await rm.handleSetTournamentPass(other.s.ws, 'PASS-OK');
      expect(other.s.last('lobby_update')!.lobby.is_tournament_verified).toBe(true);
    });

    it('a replaced socket can no longer bind a pass', async () => {
      const a = create();
      const takeover = join(a.code, 'ANA', a.token, true);
      await rm.handleSetTournamentPass(a.s.ws, 'PASS-OK');
      expect(takeover.last('lobby_update')!.lobby.is_tournament_verified).toBe(false);
    });

    it('scores are recorded under the paid pair names', async () => {
      const a = create('NICK');
      await rm.handleSetTournamentPass(a.s.ws, 'PASS-OK');
      rm.startMatch(a.s.ws);
      const recorded = () => a.s.last('leaderboard_update')?.entries.find((e) => e.room_code === a.code);
      for (let i = 0; i < 60 * 900 && !recorded(); i++) {
        rm.tickAllRooms();
        if (a.s.last('lobby_update')?.lobby.status === 'ad_revive_prompt') rm.handleDeclineRewardedAd(a.s.ws);
        if (i % 600 === 0) a.s.sent = a.s.sent.filter((m) => m.type !== 'world_state');
      }
      expect(recorded()?.driver_name).toBe('PAID_DRIVER');
      expect(recorded()?.navigator_name).toBe('PAID_NAV');
      expect(recorded()?.is_tournament).toBe(true);
    });
  });

  describe('expiry', () => {
    it('drops rooms with nobody connected after 30 min of inactivity', () => {
      const a = create();
      rm.removeSocket(a.s.ws);
      vi.advanceTimersByTime(GRACE_MS + 1);
      rm.expireIdleRooms(Date.now() + 29 * 60_000);
      expect(rm.hasRoom(a.code)).toBe(true);
      rm.expireIdleRooms(Date.now() + 31 * 60_000);
      expect(rm.hasRoom(a.code)).toBe(false);
      expect(join(a.code).last('room_error')?.code).toBe('not_found');
    });

    it('keeps rooms with connected players unless idle for hours', () => {
      const a = create();
      rm.expireIdleRooms(Date.now() + 31 * 60_000);
      expect(rm.hasRoom(a.code)).toBe(true);
      rm.expireIdleRooms(Date.now() + 3 * 60 * 60_000);
      expect(rm.hasRoom(a.code)).toBe(false);
      expect(a.s.last('room_error')?.code).toBe('expired');
    });

    it('refuses new rooms when the server is at capacity', () => {
      rm.dispose();
      rm = new RoomManager(undefined, { autoTick: false, maxRooms: 2 });
      create();
      create();
      const s = new FakeSocket();
      rm.createRoom(s.ws, 'X', undefined, cosmetics);
      expect(s.last('room_error')?.code).toBe('server_full');
    });
  });
});
