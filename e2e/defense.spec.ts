// §18: the monster sabotages a camera and defenders repair it; defenders arm a trap, contain the monster and win by
// capture; a trap alone never wins; power consumption and cooldowns.
import { expect, test } from '@playwright/test';
import { CFG, cameraIdOfNode, hqById } from './helpers/data';
import {
  asDefender,
  asMonster,
  chooseSpawn,
  clickMapNode,
  disposeAll,
  expectSameResult,
  skipPrep,
  startMatch,
} from './helpers/game';

/** A spawn option that has a camera on its own node (so SABOTAGE has a target with zero movement). */
function spawnWithCamera(options: string[]): string {
  const n = options.find((o) => cameraIdOfNode(o));
  if (!n) throw new Error('no spawn option with a camera');
  return n;
}

test('monster sabotages a camera (feed tampered), defenders repair it: status, power and cooldown', async ({ browser }) => {
  const m = await startMatch(browser, { hq: 'hq-sf', defenders: 1 });
  try {
    const { monster, defenders } = m;
    const def = defenders[0]!;
    const spawn = await chooseSpawn(m, spawnWithCamera(asMonster(await monster.view()).spawnOptions));
    const camId = cameraIdOfNode(spawn)!;
    await skipPrep(m);
    expect(asMonster(await monster.view()).self.nodeId).toBe(spawn);
    await monster.passGap();

    // Drive the sabotage through the monster UI: pick the ability, pick the node, confirm.
    await monster.page.getByTestId('ability-SABOTAGE').click();
    await clickMapNode(monster, spawn);
    await monster.page.getByTestId('target-confirm').click();

    await def.waitView(`v.cameras.find(c => c.cameraId === ${JSON.stringify(camId)}).status === 'sabotaged'`);
    // Both sides observe it: the monster sees the camera is dead, the defender log carries the clue.
    await monster.waitView(`v.cameras.find(c => c.cameraId === ${JSON.stringify(camId)}).status === 'sabotaged'`);
    await expect(def.page.getByTestId('event-log').first()).toContainText('feed tampered');
    const mv = asMonster(await monster.view());
    expect(mv.self.cooldowns.SABOTAGE).toBeGreaterThan(mv.t); // cooldown started
    await expect(monster.page.getByTestId('ability-SABOTAGE')).toHaveAttribute('aria-disabled', 'true');
    const again = await monster.act({ type: 'sabotage', nodeId: spawn, target: 'camera' });
    expect(again.ok).toBe(false); // cooling down (and already sabotaged)

    // Defender repairs through the UI: select the camera on the map, press the in-feed repair button.
    await clickMapNode(def, spawn);
    const before = asDefender(await def.view());
    await def.page.getByTestId('repair-main').click();
    await def.waitView(`v.cameras.find(c => c.cameraId === ${JSON.stringify(camId)}).status === 'repairing'`);
    const during = asDefender(await def.view());
    expect(during.repairs.map((r) => r.cameraId)).toContain(camId);
    // Power was spent (a little regeneration may have happened in between).
    expect(before.power.value - during.power.value).toBeGreaterThan(CFG.power.repairCost - 2);
    expect(before.power.value - during.power.value).toBeLessThan(CFG.power.repairCost + 2);
    // Can't double-book the same camera.
    expect((await def.act({ type: 'repair', cameraId: camId })).ok).toBe(false);

    await def.fastForward(CFG.repair.durationMs + 500);
    await def.waitView(`v.cameras.find(c => c.cameraId === ${JSON.stringify(camId)}).status === 'ok'`);
    expect(asDefender(await def.view()).repairs).toHaveLength(0);
    await monster.waitView(`v.cameras.find(c => c.cameraId === ${JSON.stringify(camId)}).status === 'ok'`);
    // A working camera cannot be "repaired".
    expect((await def.act({ type: 'repair', cameraId: camId })).ok).toBe(false);
    // Monster ability becomes available again after its cooldown.
    await monster.fastForward(CFG.monster.cooldownMs.SABOTAGE);
    await monster.waitView(`v.self.cooldowns.SABOTAGE <= v.t`);
    await expect(monster.page.getByTestId('ability-SABOTAGE')).toHaveAttribute('aria-disabled', 'false');
  } finally {
    await disposeAll(m);
  }
});

test('trap springs on the monster, defenders contain it for the capture period and win', async ({ browser }) => {
  const m = await startMatch(browser, { hq: 'hq-sf', defenders: 1, spectators: 1 });
  try {
    const { monster, defenders } = m;
    const def = defenders[0]!;
    const spawn = await chooseSpawn(m);

    // Defender arms the trap through the UI (trap tool + map node). In preparation traps arm instantly.
    await def.page.getByTestId('tool-trap').click();
    const powerBefore = asDefender(await def.view()).power.value;
    await clickMapNode(def, spawn);
    await def.waitView(`v.traps.length === 1`);
    const dv = asDefender(await def.view());
    expect(dv.traps[0]).toMatchObject({ nodeId: spawn, live: true });
    expect(powerBefore - dv.power.value).toBeGreaterThan(CFG.power.trapArmCost - 2);
    // The monster never learns about the trap (checked more exhaustively in visibility.spec).
    expect(JSON.stringify(await monster.view())).not.toContain(`"${dv.traps[0]!.id}"`);

    // Prep ends, the monster emerges on the trap and is held; its location is revealed to defenders only now.
    await skipPrep(m);
    await def.waitView(`!!v.held`);
    // The trap only holds for CFG.traps.holdMs of real time: engage containment first, verify afterwards.
    const pre = asDefender(await def.view());
    await def.page.getByTestId('contain').click();
    await def.waitView(`!!v.containment && v.containment.active`);
    const p1 = asDefender(await def.view());
    expect(pre.held!.nodeId).toBe(spawn);
    await monster.waitView(`v.self.held !== null`); // (each context receives its own view a moment apart)
    await expect(monster.page.getByTestId('monster-trapped')).toBeVisible();
    await expect(def.page.getByTestId('containment-console')).toBeVisible();
    for (const s of m.spectators) await s.waitView(`!!v.held`);
    // Engaging burns power up front and a continuous drain on top of whatever was draining before.
    expect(pre.power.value - p1.power.value).toBeGreaterThan(CFG.power.containmentStartCost - 2);
    expect(p1.power.drainPerSec - pre.power.drainPerSec).toBeCloseTo(CFG.power.containmentDrainPerSec, 1);
    await expect(def.page.getByTestId('containment-timer')).toBeVisible();

    // Hold well past the trap's own duration: containment keeps the monster held (a trap alone would have expired).
    await def.fastForward(CFG.traps.holdMs + 1_000);
    const mid = asDefender(await def.view());
    expect(mid.held).not.toBeNull();
    expect(mid.containment!.progress).toBeGreaterThan(0);
    expect(mid.containment!.progress).toBeLessThan(1);
    expect(mid.power.value).toBeLessThan(p1.power.value); // continuous drain

    await def.fastForward(CFG.containment.captureMs);
    const result = await expectSameResult(m);
    expect(result).toMatchObject({ winner: 'defenders', reason: 'capture', hqId: 'hq-sf' });
    expect(result.stats.trapsTriggered).toBeGreaterThanOrEqual(1);
    expect(result.stats.containmentAttempts).toBeGreaterThanOrEqual(1);
    // Everyone sees a defenders' win in their own words.
    await expect(monster.page.getByTestId('verdict')).toBeVisible();
    await expect(def.page.getByTestId('winner')).toContainText(/defender/i);
  } finally {
    await disposeAll(m);
  }
});

test('a trap alone does not win: it expires, the monster is free and the match goes on', async ({ browser }) => {
  const m = await startMatch(browser, { hq: 'hq-oakland', defenders: 1 });
  try {
    const { monster, defenders } = m;
    const def = defenders[0]!;
    const spawn = await chooseSpawn(m);
    expect((await def.act({ type: 'armTrap', nodeId: spawn })).ok).toBe(true);
    await skipPrep(m);
    await def.waitView(`!!v.held`);
    await monster.waitView(`v.self.held !== null`); // (each context receives its own view a moment apart)
    await def.fastForward(CFG.traps.holdMs + 1_000);
    await def.waitView(`v.held === null`);
    await monster.waitView(`v.self.held === null`);
    expect((await def.act({ type: 'containment', engage: true })).ok).toBe(false); // nothing to contain any more
    await expect(def.page.getByTestId('results-screen')).toHaveCount(0);
    expect((await def.view()).ended).toBe(false);
    // the monster can act again
    expect((await monster.act({ type: 'command', command: 'ATTACK' })).ok).toBe(true);
  } finally {
    await disposeAll(m);
  }
});

test('interrupted containment: disengaging stops the capture clock and the monster is released', async ({ browser }) => {
  const m = await startMatch(browser, { hq: 'hq-sanjose', defenders: 1 });
  try {
    const { monster, defenders } = m;
    const def = defenders[0]!;
    const spawn = await chooseSpawn(m);
    expect((await def.act({ type: 'armTrap', nodeId: spawn })).ok).toBe(true);
    await skipPrep(m);
    await def.waitView(`!!v.held`);
    await def.page.getByTestId('contain').click();
    await def.waitView(`!!v.containment`);
    await def.fastForward(CFG.containment.captureMs / 3);
    const mid = asDefender(await def.view()).containment!;
    expect(mid.progress).toBeGreaterThan(0.1);
    await def.page.getByTestId('contain-release').click();
    await def.waitView(`v.containment === null`);
    await def.waitView(`v.events.some(e => e.kind === 'containmentCancelled')`);
    // Past both the trap hold and the whole capture period: nobody has won, the monster is loose.
    await def.fastForward(CFG.traps.holdMs + CFG.containment.captureMs);
    await def.waitView(`v.held === null && v.containment === null`);
    await monster.waitView(`v.self.held === null`);
    await expect(def.page.getByTestId('results-screen')).toHaveCount(0);
    expect(asDefender(await def.view()).ended).toBe(false);
  } finally {
    await disposeAll(m);
  }
});

test('door power drain and cooldown gating (scan, lure) with server-side validation', async ({ browser }) => {
  const m = await startMatch(browser, { hq: 'hq-stanford', defenders: 1 });
  try {
    const { defenders } = m;
    const def = defenders[0]!;
    const hq = hqById('hq-stanford');
    const approach = hq.approaches[0]!;
    await chooseSpawn(m);

    // Preparation: doors, scans and lures are locked; sensors and traps are allowed.
    expect((await def.act({ type: 'door', approachId: approach.id, closed: true })).ok).toBe(false);
    expect((await def.act({ type: 'scan', nodeId: approach.fromNode })).ok).toBe(false);
    await skipPrep(m);

    // Door: closing starts the drain, opening stops it.
    const idle = asDefender(await def.view());
    expect(idle.power.drainPerSec).toBeLessThan(CFG.power.doorDrainPerSec);
    await def.page.getByTestId(`door-${approach.id}`).click();
    await def.waitView(`v.doors.find(d => d.approachId === ${JSON.stringify(approach.id)}).closed`);
    const sealed = asDefender(await def.view());
    expect(sealed.power.drainPerSec - idle.power.drainPerSec).toBeCloseTo(CFG.power.doorDrainPerSec, 1);
    const p0 = sealed.power.value;
    await def.fastForward(5_000);
    const p1 = asDefender(await def.view()).power.value;
    // Net change over 5 s ≈ (regen − drain) × 5, allowing for regen/upkeep rounding and the pre-ff wait.
    const expected = -sealed.power.drainPerSec * 5; // drainPerSec is already net of regeneration
    expect(p1 - p0).toBeLessThan(expected + 2.5);
    expect(p1 - p0).toBeGreaterThan(expected - 2.5);
    await def.page.getByTestId(`door-${approach.id}`).click();
    await def.waitView(`!v.doors.find(d => d.approachId === ${JSON.stringify(approach.id)}).closed`);
    expect(asDefender(await def.view()).power.drainPerSec).toBeLessThan(CFG.power.doorDrainPerSec);

    // Scan: costs power, then is rejected while recharging, with the cooldown visible in the view and the UI.
    const sBefore = asDefender(await def.view());
    const scan = await def.act({ type: 'scan', nodeId: approach.fromNode });
    expect(scan.ok).toBe(true);
    await def.waitView(`v.cooldowns.scanReadyAt > v.t`);
    const sAfter = asDefender(await def.view());
    expect(sBefore.power.value - sAfter.power.value).toBeGreaterThan(CFG.power.scanCost - 2);
    expect(sAfter.cooldowns.scanReadyAt).toBeGreaterThan(sAfter.t);
    const again = await def.act({ type: 'scan', nodeId: approach.fromNode });
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/recharg|cool/i);
    await clickMapNode(def, approach.fromNode);
    await expect(def.page.getByTestId('scan-node')).toBeDisabled();
    await def.fastForward(CFG.scan.cooldownMs + 200);
    await expect(def.page.getByTestId('scan-node')).toBeEnabled();
    expect((await def.act({ type: 'scan', nodeId: approach.fromNode })).ok).toBe(true);

    // Lure: same pattern, plus its own cooldown.
    expect((await def.act({ type: 'lure', nodeId: approach.fromNode })).ok).toBe(true);
    const lureAgain = await def.act({ type: 'lure', nodeId: approach.fromNode });
    expect(lureAgain.ok).toBe(false);

    // Unknown ids and costs are validated by the server.
    expect((await def.act({ type: 'door', approachId: 'nope', closed: true })).ok).toBe(false);
    expect((await def.act({ type: 'placeSensor', nodeId: 'n-does-not-exist' })).ok).toBe(false);
  } finally {
    await disposeAll(m);
  }
});

test('draining all power causes an outage: cameras black out, doors open, actions refused, then recovery', async ({ browser }) => {
  const m = await startMatch(browser, { hq: 'hq-stanford', defenders: 1 });
  try {
    const def = m.defenders[0]!;
    const approaches = hqById('hq-stanford').approaches;
    await chooseSpawn(m);
    await skipPrep(m);
    // Spend everything the rules allow until the grid collapses: seal doors (re-seal after jams), scan, lure.
    let outage = false;
    for (let i = 0; i < 400 && !outage; i++) {
      const v = asDefender(await def.view());
      if (v.power.outageUntil !== null && v.power.outageUntil > v.t) {
        outage = true;
        break;
      }
      for (const a of approaches) {
        const d = v.doors.find((x) => x.approachId === a.id)!;
        if (!d.closed && !(d.jammedUntil !== null && d.jammedUntil > v.t)) await def.act({ type: 'door', approachId: a.id, closed: true });
      }
      if (v.cooldowns.scanReadyAt <= v.t) await def.act({ type: 'scan', nodeId: approaches[0]!.fromNode });
      if (v.cooldowns.lureReadyAt <= v.t) await def.act({ type: 'lure', nodeId: approaches[1]!.fromNode });
      const r = await def.fastForward(1_000);
      if (r.ended) break;
    }
    expect(outage, 'power should run out when everything is spent').toBe(true);
    const v = asDefender(await def.view());
    expect(v.cameras.every((c) => c.status === 'blackout')).toBe(true);
    expect(v.doors.every((d) => !d.closed)).toBe(true); // forced open
    const refused = await def.act({ type: 'scan', nodeId: approaches[0]!.fromNode });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/power/i);
    await expect(def.page.getByTestId('blackout')).toBeVisible();
    // After the outage window power is restored to the configured level and cameras come back.
    await def.fastForward(CFG.power.outageMs + 500);
    await def.waitView(`v.power.outageUntil === null || v.power.outageUntil <= v.t`);
    const after = asDefender(await def.view());
    expect(after.power.value).toBeGreaterThan(0);
    expect(after.cameras.some((c) => c.status === 'ok')).toBe(true);
  } finally {
    await disposeAll(m);
  }
});
