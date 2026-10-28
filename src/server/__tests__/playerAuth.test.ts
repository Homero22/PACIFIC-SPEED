import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseProvider } from '../db.js';
import { bearerToken, createFirebaseVerifier, readFirebaseWebConfig, type IdTokenVerifier } from '../firebaseAuth.js';
import { TournamentService } from '../tournamentService.js';
import { parseClientMessage } from '../wsValidation.js';

const PROJECT = 'patrulla-test';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacific-auth-'));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

let privateKey: CryptoKey;
let verify: IdTokenVerifier;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256' };
  verify = createFirebaseVerifier(PROJECT, createLocalJWKSet({ keys: [jwk] }));
});

function token(claims: Record<string, unknown> = {}, opts: { aud?: string; iss?: string; exp?: string } = {}) {
  return new SignJWT({ email: 'Ana@Gmail.com', email_verified: true, firebase: { sign_in_provider: 'google.com' }, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject('uid-ana')
    .setIssuer(opts.iss ?? `https://securetoken.google.com/${PROJECT}`)
    .setAudience(opts.aud ?? PROJECT)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '1h')
    .sign(privateKey);
}

describe('Firebase ID token verification', () => {
  it('accepts a valid Google sign-in token', async () => {
    const user = await verify(await token());
    expect(user).toEqual({ uid: 'uid-ana', email: 'ana@gmail.com', emailVerified: true, provider: 'google.com' });
  });

  it('rejects tokens for another project, another issuer, expired or tampered', async () => {
    await expect(verify(await token({}, { aud: 'otro-proyecto' }))).rejects.toThrow(/sesión/);
    await expect(verify(await token({}, { iss: 'https://evil.example.com' }))).rejects.toThrow(/sesión/);
    await expect(verify(await token({}, { exp: '-1m' }))).rejects.toThrow(/sesión/);
    const t = await token();
    const tampered = t.slice(0, -4) + (t.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await expect(verify(tampered)).rejects.toThrow(/sesión/);
    await expect(verify('')).rejects.toThrow();
  });

  it('reads the public web config and bearer headers', () => {
    expect(readFirebaseWebConfig({})).toBeNull();
    expect(readFirebaseWebConfig({ FIREBASE_API_KEY: 'k', FIREBASE_PROJECT_ID: 'p', FIREBASE_APP_ID: 'a' })).toEqual({
      apiKey: 'k',
      projectId: 'p',
      appId: 'a',
      authDomain: 'p.firebaseapp.com'
    });
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(bearerToken('Basic x')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('Tournament pass tied to the Google account that paid', () => {
  async function setup() {
    const db = new DatabaseProvider({ localDbPath: path.join(tmpDir, `${crypto.randomUUID()}.json`) });
    const service = new TournamentService(db);
    await service.simulateSandboxPayment('ANA', 'LUIS', undefined, '127.0.0.1', {
      phone: '0991112233',
      email: 'ana@gmail.com',
      owner_uid: 'uid-ana',
      owner_email: 'ana@gmail.com'
    });
    await service.simulateSandboxPayment('VIEJA', 'PAREJA'); // registered before accounts existed
    const payments = await db.listPaymentAudits();
    const pass = (driver: string) => payments.find((p) => p.pair_driver_name === driver)!.pass_token!;
    return { db, service, pass };
  }

  it('only the owner account can activate its pass', async () => {
    const { service, pass } = await setup();
    expect((await service.verifyTournamentPass(pass('ANA'), 'uid-ana')).valid).toBe(true);
    const stranger = await service.verifyTournamentPass(pass('ANA'), 'uid-otro');
    expect(stranger.valid).toBe(false);
    expect(stranger.message).toMatch(/otra cuenta/);
    const anonymous = await service.verifyTournamentPass(pass('ANA'), null);
    expect(anonymous.valid).toBe(false);
    expect(anonymous.message).toMatch(/Inicia sesión/);
  });

  it('older passes without an account keep working', async () => {
    const { service, pass } = await setup();
    expect((await service.verifyTournamentPass(pass('VIEJA'), null)).valid).toBe(true);
  });

  it('"Mis pases" returns only the passes of that account', async () => {
    const { service, pass } = await setup();
    const mine = await service.getMyPasses('uid-ana');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ pass_code: pass('ANA'), driver_name: 'ANA', navigator_name: 'LUIS' });
    expect(await service.getMyPasses('uid-otro')).toEqual([]);
  });

  it('the winners report shows the paying account', async () => {
    const { db, service } = await setup();
    const payments = await db.listPaymentAudits();
    const ana = payments.find((p) => p.pair_driver_name === 'ANA')!;
    await db.saveMatchScore({
      id: 's-ana',
      room_code: 'ROOM01',
      driver_name: 'ANA',
      navigator_name: 'LUIS',
      total_score: 1000,
      distance_traveled: 500,
      survival_time: 60,
      region: 'PACIFIC-NET',
      is_tournament: true,
      created_at: '2026-10-28T10:00:00Z',
      payment_audit_id: ana.id,
      tournament_id: ana.tournament_id
    });
    const report = await service.getWinnersReport();
    expect(report.winners[0].account_email).toBe('ana@gmail.com');
  });
});

describe('WebSocket pass message', () => {
  it('keeps the sign-in token and drops oversized ones', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'set_tournament_pass', pass_code: 'PS-1', id_token: 'abc' }))).toEqual({
      type: 'set_tournament_pass',
      pass_code: 'PS-1',
      id_token: 'abc'
    });
    expect(parseClientMessage(JSON.stringify({ type: 'set_tournament_pass', pass_code: 'PS-1', id_token: 'x'.repeat(5000) }))).toEqual({
      type: 'set_tournament_pass',
      pass_code: 'PS-1'
    });
  });
});
