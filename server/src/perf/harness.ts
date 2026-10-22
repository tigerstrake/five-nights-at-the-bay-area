// In-process production room/AI/view load. No sockets, listeners or network access.
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { cpus } from 'node:os';
import { createHash } from 'node:crypto';
import { CAMERA_BY_ID, DEFAULT_CONFIG, getGraph, type AiDifficulty } from '@fnab/shared';
import { RoomManager, type Room } from '../rooms/RoomManager';
import { ViewEncoder } from '../net/viewUpdates';

export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
}

export interface LoadOptions { rooms: number; minutes: number; defenders?: number; fullViews?: boolean; }

export async function runLoad(options: LoadOptions) {
  const { rooms: count, minutes } = options;
  if (!Number.isInteger(count) || count < 1 || !Number.isFinite(minutes) || minutes <= 0 ||
    (options.defenders !== undefined && (!Number.isInteger(options.defenders) || options.defenders < 1 || options.defenders > 4)))
    throw new Error('Expected positive rooms/minutes and defenders between 1 and 4');
  let now = 1_000_000, seed = 0;
  const graph = getGraph();
  const manager = new RoomManager({ graph, now: () => now, seed: () => ++seed,
    placementCount: id => CAMERA_BY_ID.get(id)?.placement.length ?? 1 });
  const slots: Array<{ room: Room; host: string; index: number; round: number }> = [];
  const encoders = new Map<string, ViewEncoder>();
  const difficulties: AiDifficulty[] = ['novice', 'competent', 'expert'];
  for (let i = 0; i < count; i++) {
    const joined = manager.create(`Observer ${i}`);
    if (!joined.ok) throw new Error(joined.error);
    // A connected human spectator keeps the room alive. Only AI playing seats are charged/projected.
    manager.setRole(joined.code, joined.playerId, 'spectator');
    manager.selectHq(joined.code, joined.playerId, graph.data.headquarters[i % graph.hqs.size]!.id);
    manager.addAi(joined.code, joined.playerId, 'monster', difficulties[i % 3]!);
    for (let d = 0; d < (options.defenders ?? 1 + i % 4); d++)
      manager.addAi(joined.code, joined.playerId, 'defender', difficulties[(i + d) % 3]!);
    slots.push({ room: manager.rooms.get(joined.code)!, host: joined.playerId, index: i, round: 0 });
  }
  manager.tick(now);
  now += DEFAULT_CONFIG.match.countdownMs;
  manager.tick(now);
  const initialise = (slot: typeof slots[number]) => {
    // Repeatable public ordering as well as simulation seeds; never used outside this harness.
    slot.room.match!.state.publicIdKey = `perf:${slot.index}:${slot.round}`;
  };
  slots.forEach(initialise);

  let stepMs = 0, projectionMs = 0, roomTicks = 0, playerTicks = 0, bytes = 0, completed = 0;
  const perRole = { monster: { bytes: 0, ticks: 0 }, defender: { bytes: 0, ticks: 0 } };
  const originalStep = manager.stepMatch.bind(manager);
  manager.stepMatch = room => {
    const start = performance.now();
    originalStep(room);
    stepMs += performance.now() - start;
  };
  const digest = createHash('sha256');
  const memory: Array<{ simulatedSeconds: number; heapMiB: number; rssMiB: number }> = [];
  const sampleMemory = (t: number) => {
    const m = process.memoryUsage();
    memory.push({ simulatedSeconds: t / 1000, heapMiB: m.heapUsed / 2 ** 20, rssMiB: m.rss / 2 ** 20 });
  };
  global.gc?.();
  sampleMemory(0);
  const lag = monitorEventLoopDelay({ resolution: 1 });
  lag.enable();
  await setImmediate();
  const cpuStart = process.cpuUsage(), wallStart = performance.now();
  const ticks: number[] = [];
  const steps = Math.ceil(minutes * 60_000 / DEFAULT_CONFIG.tickMs);
  for (let t = 0; t < steps; t++) {
    now += DEFAULT_CONFIG.tickMs;
    const start = performance.now();
    const out = manager.tick(now);
    const projectionStart = performance.now();
    for (const room of out.playing) {
      roomTicks++;
      const project = manager.viewBatch(room, now);
      for (const p of room.players.values()) {
        if (!p.ai || p.role === 'spectator') continue;
        const view = project(p.id)!;
        let encoder = encoders.get(p.id);
        if (!encoder) { encoder = new ViewEncoder(); encoders.set(p.id, encoder); }
        const size = Buffer.byteLength(JSON.stringify(options.fullViews ? view : encoder.next(view).data));
        bytes += size;
        playerTicks++;
        perRole[p.role].bytes += size;
        perRole[p.role].ticks++;
      }
    }
    // Include one-off result/room emissions (including personalised lobby views).
    for (const room of out.changed) for (const p of room.players.values()) if (p.ai) {
      bytes += Buffer.byteLength(JSON.stringify(manager.roomView(room, p.id)));
      if (room.result) bytes += Buffer.byteLength(JSON.stringify(room.result));
    }
    projectionMs += performance.now() - projectionStart;
    ticks.push(performance.now() - start);

    // Sustain load after early finishes through the actual restart/countdown lifecycle.
    for (const slot of slots) {
      if (slot.room.stage === 'results') {
        completed++;
        digest.update(JSON.stringify(slot.room.result!.stats));
        manager.restart(slot.room.code, slot.host);
        slot.round++;
      } else if (slot.room.match?.state.t === 0) initialise(slot);
    }
    if ((t + 1) % 300 === 0) sampleMemory((t + 1) * DEFAULT_CONFIG.tickMs);
    // Let real event-loop timers/GC run; lag is measured in wall time under accelerated load.
    await setImmediate();
  }
  const wallMs = performance.now() - wallStart, cpu = process.cpuUsage(cpuStart);
  lag.disable();
  sampleMemory(steps * DEFAULT_CONFIG.tickMs);
  const heapBeforeCleanupMiB = process.memoryUsage().heapUsed / 2 ** 20;
  for (const slot of slots) manager.leave(slot.room.code, slot.host);
  manager.tick(now);
  encoders.clear();
  slots.length = 0;
  global.gc?.();
  const cleanup = { remainingRooms: manager.rooms.size, heapBeforeCleanupMiB, heapAfterGcMiB: process.memoryUsage().heapUsed / 2 ** 20, gcAvailable: !!global.gc };
  return {
    environment: { node: process.version, cpu: cpus()[0]?.model, arch: process.arch },
    options, simulatedSeconds: steps * DEFAULT_CONFIG.tickMs / 1000, wallMs,
    tickMs: distribution(ticks),
    cpuMs: (cpu.user + cpu.system) / 1000,
    perRoomTickMs: { simulationAndAi: stepMs / roomTicks, projectionAndSerialization: projectionMs / roomTicks,
      total: ticks.reduce((sum, n) => sum + n, 0) / roomTicks },
    eventLoopLagMs: { p50: lag.percentile(50) / 1e6, p95: lag.percentile(95) / 1e6, p99: lag.percentile(99) / 1e6, max: lag.max / 1e6 },
    bytesPerPlayerSecond: bytes / (playerTicks * DEFAULT_CONFIG.tickMs / 1000),
    bytesPerRoleSecond: Object.fromEntries(Object.entries(perRole).map(([role, v]) => [role, v.bytes / (v.ticks * DEFAULT_CONFIG.tickMs / 1000)])),
    roomTicks, playerTicks, completed, outcomeDigest: digest.digest('hex'), memory, cleanup,
  };
}
