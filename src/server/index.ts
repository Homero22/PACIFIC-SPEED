import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import type { WsClientMessage } from '../shared/types.js';
import {
  checkAdminRateLimit,
  generateAdminToken,
  registerFailedAdminLogin,
  requireAdminAuth,
  resetAdminAttempts,
  verifyAdminPassword
} from './adminSecurity.js';
import { RoomManager } from './roomManager.js';
import { tournamentService } from './tournamentService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Capture rawBody for HMAC-SHA256 Payphone webhook signature validation
app.use(
  express.json({
    verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    }
  })
);

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const roomManager = new RoomManager();

// Initialize Database & Tournament Service
void tournamentService.init();

// Healthcheck endpoint for Railway deployment
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    game: 'PACIFIC SPEED: OVERDRIVE',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Leaderboard endpoints
app.get('/api/leaderboard', (_req, res) => {
  res.json({ entries: roomManager.getLeaderboard() });
});

app.post('/api/leaderboard', (req, res) => {
  const {
    room_code,
    driver_name,
    navigator_name,
    total_score,
    distance_traveled,
    survival_time,
    region
  } = req.body || {};
  const entries = roomManager.addLeaderboardEntry({
    room_code: String(room_code || 'LOCAL-SIM'),
    driver_name: String(driver_name || 'PILOT_A'),
    navigator_name: String(navigator_name || 'PILOT_B'),
    total_score: Number(total_score || 0),
    distance_traveled: Number(distance_traveled || 0),
    survival_time: Number(survival_time || 0),
    region: String(region || 'LOCAL-NODE')
  });
  res.json({ entries });
});

// -------------------------------------------------------------
// Public Tournament & Payphone Webhook Endpoints
// -------------------------------------------------------------

app.get('/api/tournament/status', async (_req, res) => {
  try {
    const data = await tournamentService.getTournamentTelemetryStatus();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/webhooks/payphone', async (req, res) => {
  try {
    const rawBody = (req as express.Request & { rawBody?: string }).rawBody || JSON.stringify(req.body);
    const signature = req.headers['x-payphone-signature'] as string | undefined;
    const clientIp = req.ip || req.socket.remoteAddress || '127.0.0.1';

    const result = await tournamentService.processPayphoneWebhook(
      req.body,
      rawBody,
      signature,
      clientIp
    );

    if (!result.success) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

app.post('/api/tournament/simulate-payment', async (req, res) => {
  try {
    const { driver_name, navigator_name, referral_code } = req.body || {};
    const clientIp = req.ip || req.socket.remoteAddress || '127.0.0.1';

    const result = await tournamentService.simulateSandboxPayment(
      driver_name,
      navigator_name,
      referral_code,
      clientIp
    );

    if (!result.success) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

app.get('/api/referrals/:code', async (req, res) => {
  try {
    const { dbProvider } = await import('./db.js');
    const referral = await dbProvider.getReferralByCode(String(req.params.code));
    if (!referral) {
      res.status(404).json({ error: 'Referral code not found' });
      return;
    }
    res.json({ referral });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// -------------------------------------------------------------
// Secure Admin Command Deck Endpoints (/api/admin/*)
// -------------------------------------------------------------

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
  if (!checkAdminRateLimit(ip)) {
    res.status(429).json({ error: 'Too many failed login attempts. Please wait 15 minutes.' });
    return;
  }

  const { password } = req.body || {};
  if (!verifyAdminPassword(password)) {
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
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/admin/config', requireAdminAuth, async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const updated = await tournamentService.updateDynamicConfig(req.body, ip);
    res.json({ success: true, config: updated });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/admin/referrals', requireAdminAuth, async (req, res) => {
  try {
    const created = await tournamentService.createReferral(req.body);
    res.json({ success: true, referral: created });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
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
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/admin/tournament/status', requireAdminAuth, async (req, res) => {
  try {
    const { status } = req.body || {};
    const updated = await tournamentService.updateTournamentStatus(status);
    res.json({ success: true, tournament: updated });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/admin/tournament/close-podium', requireAdminAuth, async (_req, res) => {
  try {
    const result = await tournamentService.closeTournamentAndDistributePodium();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
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

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as WsClientMessage;
      switch (msg.type) {
        case 'join_room':
          roomManager.joinRoom(
            ws,
            msg.room_code,
            msg.player_id,
            msg.name,
            msg.preferred_role,
            msg.cosmetics
          );
          break;
        case 'switch_role':
          roomManager.switchRole(ws, msg.role);
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
      }
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: err instanceof Error ? err.message : 'Invalid WS payload'
        })
      );
    }
  });

  ws.on('close', () => {
    roomManager.removeSocket(ws);
  });
});

const clientDistPath = path.resolve(__dirname, '../../dist/client');
app.use(express.static(clientDistPath));

app.get('/admin*', (_req, res) => {
  res.sendFile(path.join(clientDistPath, 'admin.html'), (err) => {
    if (err) {
      res.status(200).send('Admin Portal. Build with npm run build.');
    }
  });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
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

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[PACIFIC SPEED: OVERDRIVE] Server listening on http://0.0.0.0:${PORT}`);
});
