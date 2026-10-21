// §18: the monster issues a high-level command; the AI moves it through connected nodes of the graph.
import { expect, test } from '@playwright/test';
import { CFG, graph } from './helpers/data';
import { asMonster, disposeAll, skipPrep, startMatch } from './helpers/game';

test('monster picks a spawn and a stance; the AI walks it along graph edges only', async ({ browser }) => {
  const m = await startMatch(browser, { hq: 'hq-sf', defenders: 1 });
  try {
    const { monster } = m;
    const v0 = asMonster(await monster.view());
    expect(v0.phase).toBe('preparation');
    expect(v0.self.spawned).toBe(false);
    // Spawn options come from the shared graph rules: every option is far from the HQ approaches.
    expect(v0.spawnOptions.length).toBeGreaterThan(0);
    for (const n of v0.spawnOptions) expect(graph.hopsToHq(n, 'hq-sf')).toBeGreaterThanOrEqual(CFG.spawn.minHopsFromHq);

    // UI: pick a spawn point and an opening stance.
    const spawn = v0.spawnOptions[v0.spawnOptions.length - 1]!;
    await monster.page.getByTestId(`spawn-${spawn}`).click();
    await monster.waitView(`v.self.spawnChoice === ${JSON.stringify(spawn)}`);
    await monster.passGap(); // chooseSpawn counts as a monster action for the global command gap
    await monster.page.getByTestId('cmd-FLANK').click();
    await monster.waitView(`v.self.stance === 'FLANK'`);
    await expect(monster.page.getByTestId('stance')).toHaveText('FLANK');

    await skipPrep(m);
    const v1 = asMonster(await monster.view());
    expect(v1.self.nodeId).toBe(spawn);

    // Issue the high-level command through the UI, then let time pass and watch every position change.
    await monster.passGap();
    await monster.page.getByTestId('cmd-HUNT').click();
    await monster.waitView(`v.self.stance === 'HUNT'`);

    const nodes: string[] = [spawn];
    let sawMoving = false;
    for (let i = 0; i < 400 && nodes.length < 4; i++) {
      const r = await monster.fastForward(2_000);
      if (r.ended) break;
      const s = asMonster(await monster.view()).self;
      if (s.moving) {
        sawMoving = true;
        // while travelling, the edge is a real edge of the graph and the endpoints are adjacent
        const e = graph.edgeBetween(s.moving.from, s.moving.to);
        expect(e, `${s.moving.from} -> ${s.moving.to} must be an edge`).not.toBeNull();
        expect(s.moving.edgeId).toBe(e!.id);
        expect(s.moving.progress).toBeGreaterThanOrEqual(0);
        expect(s.moving.progress).toBeLessThanOrEqual(1);
        if (s.moving.from !== nodes[nodes.length - 1]) nodes.push(s.moving.from);
      }
      if (s.nodeId && s.nodeId !== nodes[nodes.length - 1]) nodes.push(s.nodeId);
    }
    expect(sawMoving).toBe(true);
    expect(nodes.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < nodes.length; i++) {
      expect(graph.neighbors(nodes[i - 1]!), `${nodes[i - 1]} -> ${nodes[i]} must be adjacent`).toContain(nodes[i]);
    }
    // Server-side truth (revealed after the match): the recorded route is a walk on graph edges.
    await monster.fastForward(CFG.match.maxDurationMs).catch(() => undefined);
    await expect(monster.page.getByTestId('results-screen')).toBeVisible({ timeout: 30_000 });
    const result = await monster.result();
    // (the spawn point may be logged twice: once on emergence, once on first decision)
    const path = result.monsterPath.map((p) => p.nodeId).filter((n, i, a) => i === 0 || n !== a[i - 1]);
    expect(path[0]).toBe(spawn);
    for (let i = 1; i < path.length; i++) expect(graph.neighbors(path[i - 1]!)).toContain(path[i]);
    expect(result.monsterPath.map((p) => p.t)).toEqual([...result.monsterPath.map((p) => p.t)].sort((a, b) => a - b));
  } finally {
    await disposeAll(m);
  }
});

test('commands respect cooldowns and the global gap; invalid commands are rejected by the server', async ({ browser }) => {
  const m = await startMatch(browser, { defenders: 1 });
  try {
    await skipPrep(m);
    const { monster, defenders } = m;
    const v = asMonster(await monster.view());
    // team gating: a defender cannot send a monster command and vice versa
    expect((await defenders[0]!.act({ type: 'command', command: 'ATTACK' })).ok).toBe(false);
    expect((await monster.act({ type: 'armTrap', nodeId: v.self.nodeId! })).ok).toBe(false);
    // unknown approach id
    expect((await monster.act({ type: 'command', command: 'ATTACK', approachId: 'nope' })).ok).toBe(false);
    // HIDE starts its cooldown; the UI shows it and the server refuses an immediate re-use after a switch away
    expect((await monster.act({ type: 'command', command: 'HIDE' })).ok).toBe(true);
    await monster.fastForward(CFG.monster.globalCommandGapMs + 200);
    expect((await monster.act({ type: 'command', command: 'HUNT' })).ok).toBe(true);
    await monster.fastForward(CFG.monster.globalCommandGapMs + 200);
    const again = await monster.act({ type: 'command', command: 'HIDE' });
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/cooldown/i);
    const after = asMonster(await monster.view());
    expect(after.self.cooldowns.HIDE).toBeGreaterThan(after.t); // visible as a ready-at time in the monster's own view
    await expect(monster.page.getByTestId('cmd-HIDE')).toHaveAttribute('aria-disabled', 'true');
    // the cooldown ends by itself
    await monster.fastForward(CFG.monster.cooldownMs.HIDE);
    await monster.waitView(`v.self.cooldowns.HIDE <= v.t`);
    await expect(monster.page.getByTestId('cmd-HIDE')).toHaveAttribute('aria-disabled', 'false');
    expect((await monster.act({ type: 'command', command: 'HIDE' })).ok).toBe(true);
  } finally {
    await disposeAll(m);
  }
});
