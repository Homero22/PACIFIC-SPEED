import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import type { WsClientMessage } from '../shared/types.js';
import { RoomManager } from './roomManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const roomManager = new RoomManager();

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    game: 'PACIFIC SPEED: OVERDRIVE',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

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
