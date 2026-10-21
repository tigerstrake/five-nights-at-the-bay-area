import { describe, expect, it, vi } from 'vitest';
import { AI_PLAYER_CONFIG, DEFAULT_CONFIG, Graph, NETWORK, scaleForDefenders, type JoinResult, type SoloOptions } from '@fnab/shared';
import { RoomManager } from './RoomManager';
import { fastForward } from '../net/testHooks';
import { FIXTURE, testCfg } from '../../test/fixtures';

function joined(res: JoinResult) { if (!res.ok) throw new Error(res.error); return res; }
function setup(options: SoloOptions = { role: 'defender', difficulty: 'competent' }, realGraph = false, maxPlayers = 12) {
  let now = 1_000_000;
  const graph = new Graph(realGraph ? NETWORK : FIXTURE);
  const cfg = realGraph ? structuredClone(DEFAULT_CONFIG) : testCfg();
  cfg.room.maxPlayers = maxPlayers;
  const rm = new RoomManager({ graph, cfg, now: () => now, seed: () => 17, placementCount: () => 2 });
  const human = joined(rm.createSolo('Human', options));
  const room = rm.rooms.get(human.code)!;
  const advance = (ms: number) => rm.tick(now += ms);
  const start = () => { rm.setReady(room.code, human.playerId, true); advance(cfg.tickMs); advance(cfg.match.countdownMs); };
  return { rm, cfg, graph, room, human, advance, start, ais: () => [...room.players.values()].filter(p => p.ai) };
}

describe('AI seat lifecycle', () => {
  it.each(['defender', 'monster'] as const)('creates a solo %s with auto-ready opponents and a human host', role => {
    const h = setup({ role, difficulty: 'novice', teammates: role === 'defender' ? 2 : 0 });
    expect(h.ais()).toHaveLength(role === 'defender' ? 3 : 1);
    expect(h.ais().every(p => p.ready && p.connected && p.disconnectedAt === null)).toBe(true);
    expect(h.ais().every(p => p.ai?.difficulty === 'novice')).toBe(true);
    expect(h.room.hostId).toBe(h.human.playerId);
    expect(h.room.players.get(h.human.playerId)).toMatchObject({ role, ready: false });
    expect(h.rm.blocker(h.room)).toContain('Human');
    h.start();
    expect(h.room.stage).toBe('playing');
    const count = role === 'defender' ? 3 : 1;
    expect(h.room.match!.state.defenderCount).toBe(count);
    expect(h.room.match!.state.cfg.monster.baseEdgeMs).toBe(scaleForDefenders(count, h.cfg).monster.baseEdgeMs);
    expect(h.room.match!.aiPlayers.size).toBe(h.ais().length);
  });

  it('host adds/removes AI, changes its skill, and can pick HQ with only AI defenders', () => {
    const h = setup({ role: 'monster', difficulty: 'novice' }, true);
    expect(h.rm.selectHq(h.room.code, h.human.playerId, 'hq-oakland').ok).toBe(true);
    expect(h.room.settings.hqId).toBe('hq-oakland');
    const ai = h.ais()[0];
    expect(h.rm.setAiDifficulty(h.room.code, h.human.playerId, ai.id, 'expert').ok).toBe(true);
    const view = h.rm.roomView(h.room, h.human.playerId);
    expect(view.players.find(p => p.id === ai.id)).toMatchObject({ ai: { difficulty: 'expert' }, ready: true, isHost: false });
    expect(JSON.stringify(view)).not.toContain('token');
    expect(h.rm.addAi(h.room.code, h.human.playerId, 'defender', 'competent').ok).toBe(true);
    expect(h.rm.addAi(h.room.code, h.human.playerId, 'monster', 'competent').ok).toBe(false);
    expect(h.rm.removeAi(h.room.code, h.human.playerId, h.human.playerId).ok).toBe(false);
    expect(h.rm.removeAi(h.room.code, h.human.playerId, ai.id).ok).toBe(true);
    h.start();
    const other = h.ais()[0];
    expect(h.rm.removeAi(h.room.code, h.human.playerId, other.id).ok).toBe(false);
    expect(h.rm.addAi(h.room.code, h.human.playerId, 'defender', 'expert').ok).toBe(false);
    expect(h.rm.setAiDifficulty(h.room.code, h.human.playerId, other.id, 'novice').ok).toBe(false);
  });

  it('joining humans replace AI defenders, even when the room is full', () => {
    const h = setup({ role: 'monster', difficulty: 'competent' }, false, 2);
    const ai = h.ais()[0];
    const newcomer = joined(h.rm.join(h.room.code, 'Replacement'));
    expect(h.room.players.size).toBe(2);
    expect(h.room.players.has(ai.id)).toBe(false);
    expect(h.room.players.get(newcomer.playerId)).toMatchObject({ role: 'defender', ready: false });
    expect(h.rm.join(h.room.code, 'Full').ok).toBe(false);
    expect(h.rm.addAi(h.room.code, h.human.playerId, 'defender', 'expert').ok).toBe(false);
  });

  it('a human can take an AI monster role, and a human monster cannot be replaced', () => {
    const h = setup();
    const ai = h.ais()[0];
    const human2 = joined(h.rm.join(h.room.code, 'Second human'));
    expect(h.rm.setRole(h.room.code, human2.playerId, 'monster').ok).toBe(true);
    expect(h.room.players.has(ai.id)).toBe(false);
    expect(h.rm.setRole(h.room.code, h.human.playerId, 'monster').ok).toBe(false);
    expect(h.rm.addAi(h.room.code, human2.playerId, 'defender', 'novice').ok).toBe(false);
  });

  it('a full lobby can replace its AI monster, while late joins spectate without changing AI roles', () => {
    const full = setup({ role: 'defender', difficulty: 'competent' }, false, 2);
    const old = full.ais()[0];
    const replacement = joined(full.rm.join(full.room.code, 'New monster'));
    expect(full.room.players.get(replacement.playerId)?.role).toBe('monster');
    expect(full.room.players.has(old.id)).toBe(false);
    const playing = setup(); playing.start();
    const observer = joined(playing.rm.join(playing.room.code, 'Observer'));
    expect(playing.room.players.get(observer.playerId)?.role).toBe('spectator');
    expect(playing.ais()).toHaveLength(1);
    expect(playing.rm.setRole(playing.room.code, observer.playerId, 'monster').ok).toBe(false);
  });

  it('changing a human role to defender replaces one AI defender; no-ops preserve the team', () => {
    const h = setup({ role: 'monster', difficulty: 'competent' });
    const ai = h.ais()[0];
    expect(h.rm.setRole(h.room.code, h.human.playerId, 'monster').ok).toBe(true);
    expect(h.room.players.has(ai.id)).toBe(true);
    expect(h.rm.setRole(h.room.code, h.human.playerId, 'defender').ok).toBe(true);
    expect(h.room.players.has(ai.id)).toBe(false);
    expect(h.rm.addAi(h.room.code, h.human.playerId, 'monster', 'expert').ok).toBe(true);
  });

  it('AI changes and human replacements cancel countdown and AI stays ready', () => {
    const h = setup({ role: 'monster', difficulty: 'competent' });
    h.rm.setReady(h.room.code, h.human.playerId, true); h.advance(h.cfg.tickMs);
    expect(h.room.stage).toBe('countdown');
    h.rm.setAiDifficulty(h.room.code, h.human.playerId, h.ais()[0].id, 'expert');
    expect(h.room.stage).toBe('lobby');
    h.advance(h.cfg.tickMs); expect(h.room.stage).toBe('countdown');
    joined(h.rm.join(h.room.code, 'Arrival'));
    expect(h.room.stage).toBe('lobby');
    expect(h.rm.blocker(h.room)).toContain('Arrival');
  });

  it('AI cannot disconnect/resume, consume reconnect allowance or cause a pause/forfeit', () => {
    const h = setup({ role: 'monster', difficulty: 'expert' }); h.start();
    const ai = h.ais()[0], m = h.room.match!;
    h.rm.disconnect(h.room.code, ai.id);
    h.rm.leave(h.room.code, ai.id);
    expect(ai.connected).toBe(true);
    expect(h.room.players.has(ai.id)).toBe(true);
    expect(h.rm.resume(h.room.code, ai.token).ok).toBe(false);
    const t = m.state.t;
    h.advance(h.cfg.room.reconnectGraceMs + 100);
    expect(m.state.t).toBeGreaterThan(t);
    expect(m.connectionLostAt).toEqual({ monster: null, defenders: null });
    expect(m.pauseRemainingMs.defenders).toBe(h.cfg.room.reconnectPauseBudgetMs);
    expect(h.rm.playerView(h.room, h.human.playerId)).toMatchObject({ pausedForReconnect: false,
      defenderConnection: { connected: true, connectedPlayers: 1, totalPlayers: 1, reconnectDeadlineEpoch: null } });
    expect(m.state.events.some(e => e.kind === 'connectionLost' || e.kind === 'forfeit')).toBe(false);
  });

  it('an AI teammate keeps the defender team online when the human disconnects', () => {
    const h = setup({ role: 'defender', difficulty: 'competent', teammates: 1 }); h.start();
    h.rm.disconnect(h.room.code, h.human.playerId);
    h.advance(h.cfg.room.reconnectGraceMs + 100);
    expect(h.room.match!.connectionLostAt).toEqual({ monster: null, defenders: null });
    expect(h.room.match!.state.t).toBeGreaterThan(0);
    expect(h.room.match!.state.result).toBeNull();
  });

  it('AI is never host and cannot keep an abandoned room alive', () => {
    const h = setup({ role: 'defender', difficulty: 'competent', teammates: 1 });
    const next = joined(h.rm.join(h.room.code, 'Next host'));
    h.rm.leave(h.room.code, h.human.playerId);
    expect(h.room.hostId).toBe(next.playerId);
    h.rm.leave(h.room.code, next.playerId);
    expect(h.room.hostId).toBe('');
    h.advance(100);
    expect(h.rm.rooms.has(h.room.code)).toBe(false);
  });

  it('rejects invalid solo options before allocating a room', () => {
    const h = setup(); const count = h.rm.rooms.size;
    expect(h.rm.createSolo('Bad', { role: 'defender', difficulty: 'expert', teammates: AI_PLAYER_CONFIG.soloMaxTeammates + 1 }).ok).toBe(false);
    expect(h.rm.rooms.size).toBe(count);
  });

  it.each(['monster', 'defender'] as const)('completes a headless solo %s match through real validated actions and synchronized results', role => {
    const h = setup({ role, difficulty: 'competent' }, true);
    const action = vi.spyOn(h.rm, 'action');
    h.start();
    if (role === 'monster') {
      const v = h.rm.playerView(h.room, h.human.playerId)!;
      if (v.role !== 'monster') throw new Error();
      expect(h.rm.action(h.room.code, h.human.playerId, { type: 'chooseSpawn', nodeId: v.spawnOptions[0] }).ok).toBe(true);
      fastForward(h.rm, h.human.token, h.cfg.monster.globalCommandGapMs + h.cfg.tickMs);
      expect(h.rm.action(h.room.code, h.human.playerId, { type: 'command', command: 'ATTACK' }).ok).toBe(true);
    }
    expect(fastForward(h.rm, h.human.token, h.cfg.match.durationMs + h.cfg.match.prepMs).ended).toBe(true);
    const out = h.advance(h.cfg.tickMs);
    expect(out.ended).toContain(h.room);
    expect(h.room.stage).toBe('results');
    expect(h.room.result?.reason).not.toBe('forfeit');
    expect(h.room.result).toBe(h.room.match!.state.result);
    const ai = h.ais()[0];
    expect(action.mock.calls.some(([, id]) => id === ai.id)).toBe(true);
    expect(action.mock.results.some((res, i) => action.mock.calls[i][1] === ai.id && res.value.ok)).toBe(true);
    expect(h.room.result!.players).toContainEqual({ id: ai.id, name: ai.name, role: ai.role, ai: ai.ai });
    expect(h.rm.playerView(h.room, h.human.playerId)?.ended).toBe(true);
    if (role === 'monster') expect(h.room.result!.timeline.some(e => e.by === ai.id)).toBe(true);
    else expect(new Set(h.room.result!.monsterPath.map(p => p.nodeId)).size).toBeGreaterThan(1);
    expect(h.rm.restart(h.room.code, h.human.playerId).ok).toBe(true);
    expect(ai.ready).toBe(true);
    expect(h.room.players.get(h.human.playerId)!.ready).toBe(false);
    h.start(); expect(h.room.match!.state.t).toBe(0);
  });
});
