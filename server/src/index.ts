import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@fnab/shared';
import { CAMERAS, CAMERA_BY_ID, DEFAULT_CONFIG, getGraph, validateNetwork, NETWORK } from '@fnab/shared';
import { RoomManager } from './rooms/RoomManager';
import { attachSockets } from './net/socket';
import { attachTestHooks, testConfig, testHooksEnabled } from './net/testHooks';
import { cameraConfigFromEnv, createCameraService, parseCameraMode } from './cameras';

const PORT = Number(process.env.PORT ?? 3001);
const here = dirname(fileURLToPath(import.meta.url));
const clientDist = resolve(here, '../../client/dist');

const problems = validateNetwork(NETWORK, CAMERAS);
if (problems.length) console.warn('[network] problems in network.json:\n  ' + problems.join('\n  '));

const graph = getGraph();
const cameraMode = parseCameraMode(process.env.CAMERA_MODE);
if (process.env.CAMERA_MODE && cameraMode === 'simulation' && process.env.CAMERA_MODE.trim().toLowerCase() !== 'simulation') {
  console.warn(`[cameras] unrecognised CAMERA_MODE=${process.env.CAMERA_MODE}; using simulation (valid: auto|live|snapshot|simulation)`);
}
// Real-world camera health only: independent of the game loop and of fictional sabotage. Never throws into the game.
const cameras = createCameraService(cameraMode, CAMERAS, console.log, cameraConfigFromEnv(process.env));
// `testConfig` is undefined (default balance) unless FNAB_TEST_HOOKS=1; it throws under NODE_ENV=production.
const rooms = new RoomManager({ graph, placementCount: (id) => CAMERA_BY_ID.get(id)?.placement.length ?? 1, cfg: testConfig() });

const app = express();
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.rooms.size, cameraMode: cameras.mode, nodes: graph.nodes.size, cameras: cameras.getHealth?.() ?? null });
});
// Real source status per camera (array of CameraSourceStatus). `?detail=1` adds probe diagnostics for ops.
app.get('/api/cameras', (req, res) => {
  const statuses = cameras.getStatuses();
  if (req.query.detail === undefined) return res.json(statuses);
  const diag = new Map((cameras.getDiagnostics?.() ?? []).map((d) => [d.cameraId, d]));
  res.json({
    health: cameras.getHealth?.() ?? null,
    cameras: statuses.map((s) => ({ ...s, name: CAMERA_BY_ID.get(s.cameraId)?.name ?? null, diagnostics: diag.get(s.cameraId) ?? null })),
  });
});
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api|\/socket\.io).*/, (_req, res) => res.sendFile(resolve(clientDist, 'index.html')));
}

const http = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(http, {
  cors: { origin: process.env.CORS_ORIGIN?.split(',') ?? true },
  transports: ['websocket', 'polling'],
});
const detach = attachSockets(io as never, rooms, cameras, DEFAULT_CONFIG.tickMs);
// Test-only hooks (e2e). Off unless FNAB_TEST_HOOKS=1; throws at startup under NODE_ENV=production.
if (testHooksEnabled()) attachTestHooks(io as never, rooms);
await cameras.start();

http.listen(PORT, () => {
  console.log(`[fnab] server on http://localhost:${PORT} (camera mode: ${cameras.mode}, nodes: ${graph.nodes.size})`);
});

const shutdown = () => {
  detach();
  cameras.stop();
  io.close();
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
