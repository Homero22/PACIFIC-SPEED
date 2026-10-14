import 'dotenv/config';
import { assertProductionConfig, isProductionEnv } from './runtimeConfig.js';
assertProductionConfig();

import express from 'express';
import fs from 'fs';
import { createServer, type IncomingMessage } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import {
  checkAdminRateLimit,
  generateAdminToken,
  registerFailedAdminLogin,
  requireAdminAuth,
  resetAdminAttempts,
  verifyAdminPassword
} from './adminSecurity.js';
import { antiCheatEngine } from './antiCheat.js';
import {
  generateClientTransactionId,
  getPayphoneConfig,
  preparePayphoneTransaction
} from './payphoneSecurity.js';
import { DatabaseUnavailableError, dbProvider } from './db.js';
import { RoomManager } from './roomManager.js';
import { roomFromQuery, withRoomParam } from './roomUrls.js';
import { ConfigLockedError, sanitizePairName, tournamentService } from './tournamentService.js';
import {
  isAllowedWsOrigin,
  parseClientMessage,
  rejectionReply,
  SocketRateLimiter,
  WS_MAX_PAYLOAD_BYTES
} from './wsValidation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Process-level resilience guards for Railway & long-running background tasks
process.on('uncaughtException', (err) => {
  // State may be corrupted: log and exit so Railway restarts a clean process
  console.error('[SYSTEM] ❌ Excepción no capturada. Terminando proceso para reinicio:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[SYSTEM] ⚠️ Rechazo de promesa no capturado (manejado):', reason);
});

const app = express();
// Railway terminates TLS in a single proxy hop: use X-Forwarded-For for req.ip (rate limits per real client)
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Capture rawBody for HMAC-SHA256 Payphone webhook signature validation
app.use(
  express.json({
    limit: '32kb',
    verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    }
  })
);

const server = createServer(app);
const allowedWsOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: WS_MAX_PAYLOAD_BYTES,
  verifyClient: (info: { origin: string; req: IncomingMessage }) =>
    isAllowedWsOrigin(info.origin || undefined, info.req.headers.host, allowedWsOrigins, isProductionEnv())
});
const roomManager = new RoomManager(
  (pass) => tournamentService.verifyTournamentPass(pass),
  {
    db: dbProvider
  }
);

function clientIp(req: express.Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function sendError(res: express.Response, err: unknown, fallbackStatus = 500): void {
  if (err instanceof DatabaseUnavailableError) {
    res.status(503).json({ success: false, error: err.message });
    return;
  }
  res.status(fallbackStatus).json({ success: false, error: (err as Error)?.message || 'Error interno' });
}

// Simple fixed-window limiter for public endpoints (keyed by real client IP)
function createIpLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; start: number }>();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ip = clientIp(req);
    const now = Date.now();
    const rec = hits.get(ip);
    if (!rec || now - rec.start > windowMs) {
      if (hits.size > 10000) hits.clear();
      hits.set(ip, { count: 1, start: now });
      next();
      return;
    }
    rec.count++;
    if (rec.count > max) {
      res.status(429).json({ success: false, error: 'Demasiadas solicitudes. Intenta en unos minutos.' });
      return;
    }
    next();
  };
}
const paymentLinkLimiter = createIpLimiter(10, 60 * 60 * 1000);
const passLimiter = createIpLimiter(30, 15 * 60 * 1000);

// Initialize Database, Tournament Service & Leaderboard Persistence
void tournamentService.init().then(async () => {
  await roomManager.init();
});

// Healthcheck endpoint for Railway deployment (strictly sanitized, no secret keys/tokens)
app.get('/api/health', (_req, res) => {
  const cfg = getPayphoneConfig();
  res.json({
    status: 'ok',
    game: 'PACIFIC SPEED: OVERDRIVE',
    version: '1.0.0',
    database: tournamentService.getDatabaseStatus(),
    payphone: {
      configured: cfg.isConfigured,
      storeId: cfg.storeId ? 'SET' : 'NOT_SET'
    },
    timestamp: new Date().toISOString()
  });
});

// Leaderboard endpoints
app.get('/api/leaderboard', (_req, res) => {
  res.json({ entries: roomManager.getLeaderboard() });
});

// Scores are recorded only by the server (RoomManager.recordRoomScore); no public write endpoint.

// -------------------------------------------------------------
// Public Tournament & Payphone Webhook Endpoints
// -------------------------------------------------------------

app.get('/api/tournament/status', async (_req, res) => {
  try {
    const data = await tournamentService.getTournamentTelemetryStatus();
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/webhooks/payphone', async (req, res) => {
  try {
    const rawBody = (req as express.Request & { rawBody?: string }).rawBody || JSON.stringify(req.body);
    const signatureHeader = req.headers['x-payphone-signature'];
    const signature = typeof signatureHeader === 'string' ? signatureHeader.slice(0, 256) : undefined;
    const ip = clientIp(req);

    // If payload contains Button V2 notification format
    if (req.body?.id && (req.body.clientTxId || req.body.clientTransactionId)) {
      const id = String(req.body.id);
      const clientTxId = String(req.body.clientTxId || req.body.clientTransactionId);
      const cbResult = await tournamentService.handlePayphoneCallback(id, clientTxId, ip);
      res.status(cbResult.success ? 200 : 400).json({ success: cbResult.success, message: cbResult.message });
      return;
    }

    const result = await tournamentService.processPayphoneWebhook(
      req.body,
      rawBody,
      signature,
      ip
    );

    // Never echo the audit record (it contains the pair's pass token)
    res.status(result.success ? 200 : 400).json({ success: result.success, message: result.message });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/tournament/verify-pass', passLimiter, async (req, res) => {
  try {
    const { pass_code } = req.body || {};
    if (!pass_code || typeof pass_code !== 'string') {
      res.status(400).json({ valid: false, message: 'Código de pase requerido.' });
      return;
    }
    // Only validates; the pass is bound to a room through the WebSocket of a player in that room
    const result = await tournamentService.verifyTournamentPass(pass_code);
    res.json({ valid: result.valid, message: result.message });
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) {
      res.status(503).json({ valid: false, message: err.message });
      return;
    }
    res.status(500).json({ valid: false, message: 'Error verificando el pase.' });
  }
});

// Sandbox payment simulation: never mounted in production, and admin-only in development
if (!isProductionEnv()) {
  app.post('/api/tournament/simulate-payment', requireAdminAuth, async (req, res) => {
    try {
      const { driver_name, navigator_name, referral_code } = req.body || {};
      const result = await tournamentService.simulateSandboxPayment(
        driver_name,
        navigator_name,
        referral_code,
        clientIp(req)
      );
      res.status(result.success ? 200 : 400).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });
}

app.post('/api/payphone/create-link', paymentLinkLimiter, async (req, res) => {
  try {
    const { driver_name, navigator_name, referral_code, phone } = req.body || {};
    if (!getPayphoneConfig().isConfigured) {
      res.status(503).json({ success: false, message: 'Pasarela de pago no configurada.' });
      return;
    }
    const roomCode = roomFromQuery(req.body?.room_code);

    // 1. Capacity and tournament status are checked BEFORE preparing any charge
    const gate = await tournamentService.checkRegistrationOpen();
    if (!gate.open) {
      res.status(409).json({ success: false, message: gate.message });
      return;
    }

    const tournament = gate.tournament;
    const clientTxId = generateClientTransactionId();
    const driver = sanitizePairName(driver_name, 'PILOT_A');
    const navigator = sanitizePairName(navigator_name, 'PILOT_B');
    const referral =
      typeof referral_code === 'string' && referral_code.trim()
        ? referral_code.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 50)
        : undefined;
    const cleanPhone =
      typeof phone === 'string' && phone.trim() ? phone.trim().replace(/[^0-9+]/g, '').slice(0, 20) : undefined;

    const publicBase = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, '');
    const baseUrl = publicBase || `${req.protocol}://${req.get('host') || 'localhost:3000'}`;

    // 2. Persist Pending Registration in Database
    await tournamentService.createPendingRegistration({
      client_transaction_id: clientTxId,
      driver_name: driver,
      navigator_name: navigator,
      referral_code: referral,
      phone: cleanPhone,
      amount_usd: tournament.entry_fee_usd,
      status: 'PENDING',
      tournament_id: tournament.id,
      created_at: new Date().toISOString(),
      room_code: roomCode,
      // Freeze the split the payer agreed to; the payment is credited with it
      config_snapshot: await dbProvider.getTournamentConfig()
    });

    // 3. Prepare Payphone Button V2 Transaction
    // Compatible with both /payphone/callback (Payphone portal) and /api/payphone/callback.
    // responseUrl stays query-free (Payphone appends ?id=&clientTransactionId=); the callback
    // recovers the room from pending_registrations so the payer returns to the same room.
    const responseUrl = process.env.PAYPHONE_RESPONSE_URL || `${baseUrl}/payphone/callback`;
    const cancellationUrl = withRoomParam(`${baseUrl}/?payment=cancelled`, roomCode);

    const linkResult = await preparePayphoneTransaction({
      amountUsd: tournament.entry_fee_usd,
      clientTransactionId: clientTxId,
      reference: `PACIFIC SPEED - ${driver} & ${navigator}`,
      responseUrl,
      cancellationUrl
    });

    if (!linkResult.success) {
      await dbProvider.markPendingRegistrationStatus(clientTxId, 'CANCELLED').catch(() => {});
    }

    res.status(linkResult.success ? 200 : 502).json({
      ...linkResult,
      clientTransactionId: clientTxId,
      entry_fee_usd: tournament.entry_fee_usd
    });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * Payphone Official Response URL Handler
 * Handles both /payphone/callback (as configured in Payphone portal) and /api/payphone/callback
 * Fulfills Payphone's strict 5-minute confirmation rule to avoid automatic reversals.
 */
app.get(['/payphone/callback', '/api/payphone/callback'], async (req, res) => {
  try {
    const id = String(req.query.id || req.query.transactionId || '');
    const clientTransactionId = String(req.query.clientTransactionId || req.query.clientTxId || '');
    let roomCode = roomFromQuery(req.query.room);

    if (!id || !clientTransactionId) {
      res.redirect(withRoomParam('/?payment=cancelled', roomCode));
      return;
    }

    try {
      roomCode = (await dbProvider.getPendingRegistration(String(clientTransactionId)))?.room_code || roomCode;
    } catch {
      // Fall back to the room carried in the URL
    }

    const result = await tournamentService.handlePayphoneCallback(
      id,
      clientTransactionId,
      clientIp(req)
    );

    if (result.success && result.auditRecord?.pass_token) {
      res.redirect(
        withRoomParam(`/?payment=success&pass=${encodeURIComponent(result.auditRecord.pass_token)}`, roomCode)
      );
    } else if (result.success) {
      res.redirect(withRoomParam('/?payment=success', roomCode));
    } else {
      res.redirect(withRoomParam(`/?payment=error&reason=${encodeURIComponent(result.message)}`, roomCode));
    }
  } catch (err: any) {
    console.error('[PAYPHONE CALLBACK] Error:', err);
    const reason =
      err instanceof DatabaseUnavailableError
        ? 'Servicio temporalmente no disponible. Tu pago no fue confirmado y será revertido por Payphone.'
        : 'Error procesando cobro';
    res.redirect(withRoomParam(`/?payment=error&reason=${encodeURIComponent(reason)}`, roomFromQuery(req.query.room)));
  }
});

app.get('/api/payphone/status', (_req, res) => {
  const cfg = getPayphoneConfig();
  res.json({
    configured: cfg.isConfigured,
    baseUrl: cfg.baseUrl,
    storeId: cfg.storeId ? 'SET' : 'NOT_SET'
  });
});

app.get('/api/referrals/:code', async (req, res) => {
  try {
    const referral = await dbProvider.getReferralByCode(String(req.params.code).slice(0, 50));
    if (!referral) {
      res.status(404).json({ error: 'Referral code not found' });
      return;
    }
    // Public: never expose the collaborator's phone number or earnings
    res.json({ referral: { referral_code: referral.referral_code, collaborator_name: referral.collaborator_name } });
  } catch (err) {
    sendError(res, err);
  }
});

// -------------------------------------------------------------
// Secure Admin Command Deck Endpoints (/api/admin/*)
// -------------------------------------------------------------

app.post('/api/admin/login', (req, res) => {
  const ip = clientIp(req);
  if (!checkAdminRateLimit(ip)) {
    res.status(429).json({ error: 'Too many failed login attempts. Please wait 15 minutes.' });
    return;
  }

  const { password } = req.body || {};
  if (typeof password !== 'string' || !verifyAdminPassword(password)) {
    registerFailedAdminLogin(ip);
    res.status(401).json({ error: 'Invalid master administrator secret key.' });
    return;
  }

  resetAdminAttempts(ip);
  const tokenData = generateAdminToken();
  res.json({
    success: true,
    ...tokenData,
    message: 'Admin authorization granted. Session active for 8 hours.'
  });
});

app.get('/api/admin/dashboard', requireAdminAuth, async (_req, res) => {
  try {
    const dashboard = await tournamentService.getAdminDashboardData();
    res.json(dashboard);
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/admin/config', requireAdminAuth, async (req, res) => {
  try {
    const { config, changes } = await tournamentService.updateDynamicConfig(req.body, clientIp(req));
    res.json({ success: true, config, changes });
  } catch (err) {
    sendError(res, err, err instanceof ConfigLockedError ? 409 : 400);
  }
});

app.post('/api/admin/referrals', requireAdminAuth, async (req, res) => {
  try {
    const created = await tournamentService.createReferral(req.body);
    res.json({ success: true, referral: created });
  } catch (err) {
    sendError(res, err, 400);
  }
});

app.post('/api/admin/referrals/:id/settle', requireAdminAuth, async (req, res) => {
  try {
    const { settle_amount } = req.body || {};
    const settled = await tournamentService.settleReferralPayout(
      String(req.params.id),
      settle_amount ? Number(settle_amount) : undefined
    );
    res.json({ success: true, referral: settled });
  } catch (err) {
    sendError(res, err, 400);
  }
});

app.post('/api/admin/tournament/status', requireAdminAuth, async (req, res) => {
  try {
    const { status } = req.body || {};
    const updated = await tournamentService.updateTournamentStatus(status);
    res.json({ success: true, tournament: updated });
  } catch (err) {
    sendError(res, err, 400);
  }
});

app.post('/api/admin/tournament/close-podium', requireAdminAuth, async (_req, res) => {
  try {
    const result = await tournamentService.closeTournamentAndDistributePodium();
    res.json({ success: true, ...result });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/admin/anticheat/clear', requireAdminAuth, (_req, res) => {
  try {
    tournamentService.clearSecurityLogs();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// -------------------------------------------------------------
// WebSocket Handler
// -------------------------------------------------------------

wss.on('error', (err) => {
  console.error('[WS] Error del servidor WebSocket:', err);
});

wss.on('connection', (ws, req) => {
  const limiter = new SocketRateLimiter();
  const ip = req.socket.remoteAddress || 'unknown';

  // Protocol errors (e.g. payload over maxPayload) must close only this socket, never crash the process
  ws.on('error', (err) => {
    console.warn('[WS] Conexión cerrada por error de protocolo:', err.message);
    ws.terminate();
  });

  ws.on('message', (raw, isBinary) => {
    const verdict = limiter.hit();
    if (verdict === 'abuse') {
      antiCheatEngine.logSecurityViolation('ws_abuse', 'medium', ip, 'WebSocket message flood: connection closed');
      ws.close(1008, 'Rate limit exceeded');
      return;
    }
    if (verdict === 'drop' || isBinary) return;

    const msg = parseClientMessage(raw.toString());
    if (!msg) {
      ws.send(JSON.stringify(rejectionReply(raw.toString())));
      return;
    }

    try {
      switch (msg.type) {
        case 'create_room':
          roomManager.createRoom(ws, msg.name, msg.preferred_role, msg.cosmetics);
          break;
        case 'join_room':
          roomManager.joinRoom(
            ws,
            msg.room_code,
            msg.name,
            msg.cosmetics,
            msg.session_token,
            msg.takeover === true
          );
          break;
        case 'leave_room':
          roomManager.leaveRoom(ws);
          break;
        case 'switch_role':
          roomManager.switchRole(ws, msg.role);
          break;
        case 'respond_role_swap':
          roomManager.respondRoleSwap(ws, msg.accept === true);
          break;
        case 'set_ready':
          roomManager.setReady(ws, msg.ready === true);
          break;
        case 'update_cosmetics':
          roomManager.updateCosmetics(ws, msg.cosmetics);
          break;
        case 'start_match':
        case 'instant_rematch':
          roomManager.startMatch(ws);
          break;
        case 'watch_rewarded_ad':
          roomManager.handleWatchRewardedAd(ws);
          break;
        case 'decline_rewarded_ad':
          roomManager.handleDeclineRewardedAd(ws);
          break;
        case 'send_comms':
          roomManager.handleSendComms(ws, msg.preset);
          break;
        case 'player_input':
          roomManager.handlePlayerInput(ws, msg.payload);
          break;
        case 'set_tournament_pass':
          void roomManager.handleSetTournamentPass(ws, msg.pass_code);
          break;
      }
    } catch (err) {
      console.error('[WS] Error procesando mensaje:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Error procesando mensaje' }));
    }
  });

  ws.on('close', () => {
    roomManager.removeSocket(ws);
  });
});

const clientDistCandidates = [
  path.resolve(__dirname, '../../dist/client'),
  path.resolve(__dirname, '../client'),
  path.resolve(process.cwd(), 'dist/client')
];
const clientDistPath = clientDistCandidates.find((p) => fs.existsSync(p)) || clientDistCandidates[0];

const publicPath = path.resolve(process.cwd(), 'public');
if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath));
}

app.use(express.static(clientDistPath));

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(clientDistPath, 'admin.html'), (err) => {
    if (err) res.status(200).send('Admin Portal. Build with npm run build.');
  });
});

app.get('/admin/*', (_req, res) => {
  res.sendFile(path.join(clientDistPath, 'admin.html'), (err) => {
    if (err) res.status(200).send('Admin Portal. Build with npm run build.');
  });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws') || req.path.startsWith('/payphone')) {
    return next();
  }
  res.sendFile(path.join(clientDistPath, 'index.html'), (err) => {
    if (err) {
      res
        .status(200)
        .send('PACIFIC SPEED: OVERDRIVE Server Running. Build client with npm run build.');
    }
  });
});

const rawPort = process.env.PORT ? String(process.env.PORT).trim().replace(/^["']|["']$/g, '') : '';
const PORT = parseInt(rawPort, 10) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[PACIFIC SPEED: OVERDRIVE] Server listening on http://0.0.0.0:${PORT}`);
});
