// §12/§18: both sides can win, and every participant receives the same synchronized result.
// Breach (monster), survival timer (defenders); capture (defenders) is in defense.spec.ts.
import { expect, test } from '@playwright/test';
import { CFG, graph, hqById } from './helpers/data';
import { asDefender, asMonster, chooseSpawn, disposeAll, expectSameResult, runUntilEnd, skipPrep, startMatch } from './helpers/game';

test('monster wins by breaching the headquarters; all participants get the same result', async ({ browser }) => {
  const m = await startMatch(browser, { hq: 'hq-oakland', defenders: 2, spectators: 1 });
  try {
    const { monster } = m;
    const hq = hqById('hq-oakland');
    await chooseSpawn(m);
    await skipPrep(m);
    await monster.passGap();
    const door = hq.approaches[0]!;
    expect((await monster.act({ type: 'command', command: 'ATTACK', approachId: door.id })).ok).toBe(true);

    await runUntilEnd(monster, { chunk: 5_000 });
    const result = await expectSameResult(m);
    expect(result.winner).toBe('monster');
    expect(result.reason).toBe('breach');
    expect(result.hqId).toBe('hq-oakland');
    expect(hq.approaches.map((a) => a.id)).toContain(result.approachId);
    expect(result.endedAtT).toBeLessThan(CFG.match.prepMs + CFG.match.maxDurationMs);
    expect(result.timeline.some((e) => e.kind === 'breachStart')).toBe(true);
    expect(result.timeline.some((e) => e.kind === 'breached')).toBe(true);
    // The route the AI took is a walk on the graph ending at the approach node of the breached door.
    const path = result.monsterPath.map((p) => p.nodeId).filter((n, i, a) => i === 0 || n !== a[i - 1]);
    for (let i = 1; i < path.length; i++) expect(graph.neighbors(path[i - 1]!)).toContain(path[i]);
    expect(path[path.length - 1]).toBe(hq.approaches.find((a) => a.id === result.approachId)!.fromNode);
    // Every participant is shown the verdict.
    for (const p of m.all) await expect(p.page.getByTestId('winner')).toBeVisible();
  } finally {
    await disposeAll(m);
  }
});

test('defenders win by surviving until the timer expires (monster hiding), same result everywhere', async ({ browser }) => {
  const m = await startMatch(browser, { hq: 'hq-stanford', defenders: 1, spectators: 1, durationSec: CFG.match.minDurationMs / 1000 });
  try {
    const { monster, defenders } = m;
    await chooseSpawn(m);
    await skipPrep(m);
    await monster.passGap();
    expect((await monster.act({ type: 'command', command: 'HIDE' })).ok).toBe(true); // HIDE never breaches
    const v0 = asDefender(await defenders[0]!.view());
    expect(v0.matchEndsAt - v0.t).toBeLessThanOrEqual(CFG.match.minDurationMs);
    // Phases advance on the shared clock: infiltration → escalation → final assault → dawn.
    const seen = new Set<string>();
    await runUntilEnd(monster, {
      chunk: 10_000,
      maxMs: CFG.match.minDurationMs + CFG.match.prepMs + 60_000,
      each: async () => void seen.add(asMonster(await monster.view()).phase),
    });
    const result = await expectSameResult(m);
    expect(result.winner).toBe('defenders');
    expect(result.reason).toBe('timer');
    expect(result.endedAtT).toBeGreaterThanOrEqual(v0.matchEndsAt - CFG.tickMs * 2);
    expect(seen.has('escalation') && seen.has('final')).toBe(true);
    expect(result.stats.durationMs).toBeGreaterThan(0);
    for (const p of m.all) await expect(p.page.getByTestId('verdict')).toBeVisible();
  } finally {
    await disposeAll(m);
  }
});
