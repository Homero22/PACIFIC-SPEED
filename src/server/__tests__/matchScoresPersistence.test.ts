import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { LeaderboardEntry } from '../../shared/types.js';
import { DatabaseProvider } from '../db.js';
import { RoomManager } from '../roomManager.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacific-match-scores-'));
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function freshDb() {
  const filePath = path.join(tmpDir, `${crypto.randomUUID()}.json`);
  return { db: new DatabaseProvider({ localDbPath: filePath }), filePath };
}

describe('DatabaseProvider — persistencia de match_scores (records)', () => {
  it('guarda una partida y la recupera con getTopMatchScores', async () => {
    const { db } = freshDb();
    const entry: LeaderboardEntry = {
      id: 'score-1',
      room_code: 'RM01',
      driver_name: 'PILOT_X',
      navigator_name: 'PILOT_Y',
      total_score: 8500,
      distance_traveled: 4200.5,
      survival_time: 145.2,
      region: 'LATAM-PACIFIC',
      is_tournament: true,
      created_at: new Date().toISOString()
    };

    await db.saveMatchScore(entry);
    const top = await db.getTopMatchScores(10);

    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({
      id: 'score-1',
      room_code: 'RM01',
      driver_name: 'PILOT_X',
      navigator_name: 'PILOT_Y',
      total_score: 8500,
      is_tournament: true
    });
  });

  it('ordena por total_score DESC y respeta el limite', async () => {
    const { db } = freshDb();

    const scores = [
      { id: 's1', total_score: 3000 },
      { id: 's2', total_score: 9500 },
      { id: 's3', total_score: 5000 },
      { id: 's4', total_score: 12000 }
    ];

    for (const s of scores) {
      await db.saveMatchScore({
        id: s.id,
        room_code: 'RMXX',
        driver_name: `D_${s.id}`,
        navigator_name: `N_${s.id}`,
        total_score: s.total_score,
        distance_traveled: s.total_score / 2,
        survival_time: 60,
        region: 'LATAM-PACIFIC',
        is_tournament: false,
        created_at: new Date().toISOString()
      });
    }

    const top2 = await db.getTopMatchScores(2);
    expect(top2).toHaveLength(2);
    expect(top2[0].id).toBe('s4');
    expect(top2[0].total_score).toBe(12000);
    expect(top2[1].id).toBe('s2');
    expect(top2[1].total_score).toBe(9500);

    const all = await db.getTopMatchScores(10);
    expect(all.map((item) => item.total_score)).toEqual([12000, 9500, 5000, 3000]);
  });

  it('actualiza un registro existente si el id coincide (upsert)', async () => {
    const { db } = freshDb();
    const entry: LeaderboardEntry = {
      id: 'score-fixed',
      room_code: 'RM01',
      driver_name: 'PILOT_A',
      navigator_name: 'PILOT_B',
      total_score: 1000,
      distance_traveled: 500,
      survival_time: 30,
      region: 'LATAM-PACIFIC',
      is_tournament: false,
      created_at: new Date().toISOString()
    };

    await db.saveMatchScore(entry);
    await db.saveMatchScore({ ...entry, total_score: 4500, distance_traveled: 2200 });

    const top = await db.getTopMatchScores(10);
    expect(top).toHaveLength(1);
    expect(top[0].total_score).toBe(4500);
    expect(top[0].distance_traveled).toBe(2200);
  });

  it('persiste los datos en disco entre instancias de DatabaseProvider', async () => {
    const { filePath } = freshDb();
    const db1 = new DatabaseProvider({ localDbPath: filePath });

    await db1.saveMatchScore({
      id: 'saved-disk',
      room_code: 'DISK',
      driver_name: 'PILOT_1',
      navigator_name: 'PILOT_2',
      total_score: 7777,
      distance_traveled: 3333,
      survival_time: 90,
      region: 'LATAM-PACIFIC',
      is_tournament: true,
      created_at: new Date().toISOString()
    });

    // Reinstanciar con el mismo path
    const db2 = new DatabaseProvider({ localDbPath: filePath });
    const loaded = await db2.getTopMatchScores(10);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('saved-disk');
    expect(loaded[0].total_score).toBe(7777);
  });

  it('seedInitialScoresIfEmpty solo inserta si la tabla está vacía', async () => {
    const { db } = freshDb();

    const seeds: LeaderboardEntry[] = [
      {
        id: 'seed-1',
        room_code: 'SEED1',
        driver_name: 'APEX',
        navigator_name: 'CIPHER',
        total_score: 15420,
        distance_traveled: 8420,
        survival_time: 312,
        region: 'LATAM-PACIFIC',
        is_tournament: true,
        created_at: new Date().toISOString()
      }
    ];

    await db.seedInitialScoresIfEmpty(seeds);
    let top = await db.getTopMatchScores(10);
    expect(top).toHaveLength(1);
    expect(top[0].id).toBe('seed-1');

    // Intentar sembrar otra vez con datos distintos no debe hacer nada
    await db.seedInitialScoresIfEmpty([
      {
        id: 'seed-2',
        room_code: 'SEED2',
        driver_name: 'OTHER',
        navigator_name: 'OTHER',
        total_score: 99999,
        distance_traveled: 9999,
        survival_time: 999,
        region: 'LATAM-PACIFIC',
        is_tournament: true,
        created_at: new Date().toISOString()
      }
    ]);

    top = await db.getTopMatchScores(10);
    expect(top).toHaveLength(1);
    expect(top[0].id).toBe('seed-1');
  });
});

describe('RoomManager — integración con persistencia de records', () => {
  it('init() hidrata el leaderboard en memoria desde el almacenamiento persistente', async () => {
    const { db } = freshDb();
    await db.saveMatchScore({
      id: 'custom-score-1',
      room_code: 'HYDRATE',
      driver_name: 'ACE',
      navigator_name: 'WING',
      total_score: 25000,
      distance_traveled: 12000,
      survival_time: 500,
      region: 'PACIFIC-NET',
      is_tournament: true,
      created_at: new Date().toISOString()
    });

    const rm = new RoomManager(undefined, { autoTick: false, db });
    await rm.init();

    const lb = rm.getLeaderboard();
    expect(lb.length).toBeGreaterThan(0);
    expect(lb[0].id).toBe('custom-score-1');
    expect(lb[0].total_score).toBe(25000);
    rm.dispose();
  });

  it('addLeaderboardEntry persiste la nueva puntuación en segundo plano', async () => {
    const { db } = freshDb();
    const saveSpy = vi.spyOn(db, 'saveMatchScore');

    const rm = new RoomManager(undefined, { autoTick: false, db });
    await rm.init();
    saveSpy.mockClear();

    rm.addLeaderboardEntry({
      room_code: 'ROOM_PLAY',
      driver_name: 'PILOT_ALPHA',
      navigator_name: 'PILOT_BETA',
      total_score: 18500,
      distance_traveled: 9000,
      survival_time: 240,
      region: 'PACIFIC-NET',
      is_tournament: true
    });

    expect(saveSpy).toHaveBeenCalledTimes(1);
    const savedEntry = saveSpy.mock.calls[0][0];
    expect(savedEntry.total_score).toBe(18500);
    expect(savedEntry.driver_name).toBe('PILOT_ALPHA');

    // Comprobar que en db efectivamente quedó guardado
    const topFromDb = await db.getTopMatchScores(5);
    const found = topFromDb.find((item) => item.driver_name === 'PILOT_ALPHA');
    expect(found).toBeDefined();
    expect(found?.total_score).toBe(18500);

    rm.dispose();
  });

  it('si el guardado en base de datos falla, la simulación en memoria no se interrumpe ni lanza excepción', async () => {
    const mockDb = {
      saveMatchScore: vi.fn().mockRejectedValue(new Error('DB Connection Timeout')),
      getTopMatchScores: vi.fn().mockResolvedValue([])
    };

    const rm = new RoomManager(undefined, { autoTick: false, db: mockDb });
    await rm.init();

    // No debe lanzar error
    expect(() => {
      rm.addLeaderboardEntry({
        room_code: 'ROOM_FAIL',
        driver_name: 'BRAVE',
        navigator_name: 'COPILOT',
        total_score: 9999,
        distance_traveled: 5000,
        survival_time: 120,
        region: 'PACIFIC-NET',
        is_tournament: false
      });
    }).not.toThrow();

    // El leaderboard en memoria sí tiene la entrada
    const lb = rm.getLeaderboard();
    expect(lb.some((e) => e.driver_name === 'BRAVE')).toBe(true);

    rm.dispose();
  });
});
