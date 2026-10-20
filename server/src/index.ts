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
import { createCameraService, parseCameraMode } from './cameras';

const PORT = Number(process.env.PORT ?? 3001);
const here = dirname(fileURLToPath(import.meta.url));
const clientDist = resolve(here, '../../client/dist');

const problems = validateNetwork(NETWORK, CAMERAS);
if (problems.length) console.warn('[network] problems in network.json:\n  ' + problems.join('\n  '));

const graph = getGraph();
const cameras = createCameraService(parseCameraMode(process.env.CAMERA_MODE), CAMERAS);
const rooms = new RoomManager({ graph, placementCount: (id) => CAMERA_BY_ID.get(id)?.placement.length ?? 1 });

const app = express();
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.rooms.size, cameraMode: cameras.mode, nodes: graph.nodes.size });
});
app.get('/api/cameras', (_req, res) => {
  res.json(cameras.getStatuses());
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
