import { expect, test } from '@playwright/test';
import { CFG, graph } from './helpers/data';
import { asDefender, asMonster, newPlayer, openTitle, pickHq, ready, runUntilEnd, type Player } from './helpers/game';

async function solo(p: Player, role: 'defender' | 'monster', difficulty: 'novice' | 'competent' | 'expert') {
  await openTitle(p);
  await p.page.fill('#name', p.name);
  await p.page.getByTestId('play-solo').click();
  await expect(p.page.getByTestId('solo-setup')).toBeVisible();
  await p.page.getByTestId(`solo-role-${role}`).click();
  await p.page.getByTestId(`solo-difficulty-${difficulty}`).click();
  if (role === 'defender') await p.page.getByTestId('solo-teammates-0').click();
  await p.page.getByTestId('solo-start').click();
  await expect(p.page.getByTestId('lobby-screen')).toBeVisible();
  const room = await p.room();
  expect(room.players.filter(x => !x.ai)).toHaveLength(1);
  expect(room.players.find(x => x.id === room.youId)?.role).toBe(role);
  expect(room.players.filter(x => x.ai).every(x => x.ai?.difficulty === difficulty && x.ready && x.connected)).toBe(true);
  await expect(p.page.getByTestId('ai-tag')).toHaveCount(1);
  await pickHq(p, 'hq-sf');
  return room;
}

test('title → solo defender faces a moving AI monster through legitimate sightings', async ({ browser }) => {
  const p = await newPlayer(browser, 'Solo watch', { blockCaltrans: true });
  try {
    const room = await solo(p, 'defender', 'competent');
    await ready(p);
    await expect(p.page.getByTestId('defender-screen')).toBeVisible({ timeout: 30_000 });
    const seen = new Set<string>();
    let ended = false;
    // Observe only defender projections. Exact hidden movement is checked after the normal result reveal.
    for (let spent = 0; spent < CFG.match.durationMs + CFG.match.prepMs; spent += 10_000) {
      const r = await p.fastForward(10_000);
      const v = asDefender(await p.view());
      expect(v.role).toBe('defender');
      expect(v).not.toHaveProperty('self');
      expect(v.monsterConnection).toMatchObject({ connected: true, reconnectDeadlineEpoch: null });
      for (const sighting of v.sightings) seen.add(sighting.nodeId);
      ended = r.ended;
      if (ended || seen.size >= 2) break;
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
    if (!ended) await runUntilEnd(p);
    await expect(p.page.getByTestId('results-screen')).toBeVisible({ timeout: 30_000 });
    const result = await p.result();
    const path = result.monsterPath.map(x => x.nodeId).filter((n, i, a) => i === 0 || n !== a[i - 1]);
    expect(new Set(path).size).toBeGreaterThan(1);
    for (let i = 1; i < path.length; i++) expect(graph.neighbors(path[i - 1]!)).toContain(path[i]);
    expect(result.reason).not.toBe('forfeit');
    await expect(p.page.getByTestId('result-players')).toContainText(room.players.find(x => x.ai)!.name);
    expect(p.pageErrors).toEqual([]);
  } finally { await p.dispose(); }
});

test('solo monster picks HQ, manages AI defenders and gets a result with their actions', async ({ browser }) => {
  const p = await newPlayer(browser, 'Solo entity', { blockCaltrans: true });
  try {
    await solo(p, 'monster', 'novice');
    const aiId = (await p.room()).players.find(x => x.ai)!.id;
    await p.page.getByTestId(`ai-difficulty-${aiId}-expert`).click();
    await expect.poll(async () => (await p.room()).players.find(x => x.id === aiId)?.ai?.difficulty).toBe('expert');
    await p.page.getByTestId('ai-add-defender').click();
    await expect(p.page.getByTestId('ai-tag')).toHaveCount(2);
    const extra = (await p.room()).players.find(x => x.ai && x.id !== aiId)!;
    await p.page.getByTestId(`ai-remove-${extra.id}`).click();
    await expect(p.page.getByTestId('ai-tag')).toHaveCount(1);
    await ready(p);
    await expect(p.page.getByTestId('monster-screen')).toBeVisible({ timeout: 30_000 });
    const prep = asMonster(await p.view());
    await p.page.getByTestId(`spawn-${prep.spawnOptions[0]}`).click();
    await p.passGap();
    await p.page.getByTestId('cmd-ATTACK').click();
    await p.fastForward(CFG.match.prepMs + CFG.tickMs * 2);
    expect(asMonster(await p.view()).defenderConnection).toMatchObject({ connected: true, connectedPlayers: 1, reconnectDeadlineEpoch: null });
    // Defenses remain secret to the monster until discovered; the post-match timeline supplies action attribution.
    await runUntilEnd(p);
    await expect(p.page.getByTestId('results-screen')).toBeVisible({ timeout: 30_000 });
    const result = await p.result();
    expect(result.reason).not.toBe('forfeit');
    expect(result.timeline.some(e => e.by === aiId)).toBe(true);
    expect(result.stats.trapsArmed).toBeGreaterThan(0);
    expect(result.players?.find(x => x.id === aiId)).toMatchObject({ role: 'defender', ai: { difficulty: 'expert' } });
    await expect(p.page.getByTestId('result-players')).toContainText('(AI)');
    expect(p.pageErrors).toEqual([]);
  } finally { await p.dispose(); }
});
