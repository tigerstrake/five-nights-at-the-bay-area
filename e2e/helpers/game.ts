// Multi-player helpers for the e2e suite. Every Player is its own browser context (own sessionStorage, own socket),
// so two Players are two different people. UI is driven where that is reliable; the in-page socket client
// (the app's own module, so the same path the UI uses) is used for precise or time-sensitive actions.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { DefenderView, GameAction, HqId, MatchResult, MonsterView, PlayerView, RoomView } from '@fnab/shared';
import { CFG } from './data';

export type FnabWindow = Window & {
  __fnab: {
    getState: () => {
      room: RoomView | null;
      view: PlayerView | null;
      result: MatchResult | null;
      cameraStatuses: Record<string, { mode: string; reason?: string | null }>;
      connection: string;
    };
  };
};

export interface Frame {
  event: string;
  raw: string;
  data: unknown[];
  at: number;
}

export interface PlayerOpts {
  /** Block every request to *.dot.ca.gov (simulates no external network). */
  blockCaltrans?: boolean;
  baseURL?: string;
}

/** Match-time milliseconds, with a small margin so "has the phase changed" comparisons are not off by a tick. */
export const TICK = CFG.tickMs;

/** E2E_THROTTLE=4 emulates a CPU 4x slower than this machine (CDP) to rehearse a small CI runner. */
export const THROTTLE = Math.max(1, Number(process.env.E2E_THROTTLE ?? 1) || 1);

export class Player {
  readonly frames: Frame[] = [];
  readonly pageErrors: string[] = [];
  code = '';
  constructor(
    readonly name: string,
    readonly context: BrowserContext,
    readonly page: Page,
  ) {
    page.on('pageerror', (e) => this.pageErrors.push(e.message));
    page.on('websocket', (ws) => {
      ws.on('framereceived', (f) => {
        const raw = typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8');
        const m = /^42\d*(\[.*\])$/s.exec(raw);
        if (!m) return;
        try {
          const arr = JSON.parse(m[1]!) as unknown[];
          this.frames.push({ event: String(arr[0]), raw: m[1]!, data: arr.slice(1), at: Date.now() });
        } catch {
          /* partial/binary frame */
        }
      });
    });
  }

  /** Frames of one socket event, in arrival order. */
  eventFrames(event: string): Frame[] {
    return this.frames.filter((f) => f.event === event);
  }

  state<T>(fn: (s: ReturnType<FnabWindow['__fnab']['getState']>) => T): Promise<T> {
    return this.page.evaluate(`(${fn.toString()})(window.__fnab.getState())`) as Promise<T>;
  }
  async view<T extends PlayerView = PlayerView>(): Promise<T> {
    return (await this.state((s) => s.view)) as T;
  }
  async room(): Promise<RoomView> {
    return (await this.state((s) => s.room)) as RoomView;
  }
  async result(): Promise<MatchResult> {
    return (await this.state((s) => s.result)) as MatchResult;
  }

  /** Wait until the in-store view satisfies the predicate (evaluated in the page; source string, no closures). */
  async waitView(predicate: string, timeout = 20_000 * Math.max(1, Math.ceil(THROTTLE / 2))): Promise<void> {
    await this.page.waitForFunction(`(() => { const v = window.__fnab.getState().view; return !!v && (${predicate}); })()`, null, { timeout });
  }

  /** Send a game action through the app's own socket client (same path as the UI), returning the server's ack. */
  async act(action: GameAction): Promise<{ ok: boolean; error?: string }> {
    return this.page.evaluate(async (a) => {
      const m = await (new Function('p', 'return import(p)') as (p: string) => Promise<typeof import('../../client/src/net/socket')>)('/src/net/socket.ts');
      return m.sendAction(a);
    }, action);
  }

  /** Fast-forward the server match by `ms` of match time (test hook), then wait for this client to see it. */
  async fastForward(ms: number): Promise<{ t: number; ended: boolean }> {
    const res = await this.page.evaluate(async (ms) => {
      const m = await (new Function('p', 'return import(p)') as (p: string) => Promise<typeof import('../../client/src/net/socket')>)('/src/net/socket.ts');
      const sess = JSON.parse(sessionStorage.getItem('fnab.session') ?? 'null') as { token: string } | null;
      return new Promise<{ ok: boolean; error?: string; t?: number; ended?: boolean }>((resolve) => {
        const sock = m.getSocket() as unknown as { emit: (e: string, p: unknown, ack: (r: never) => void) => void };
        sock.emit('test:fastForward', { token: sess?.token, ms }, resolve as never);
        setTimeout(() => resolve({ ok: false, error: 'no ack (are FNAB_TEST_HOOKS enabled?)' }), 20_000);
      });
    }, ms);
    if (!res.ok) throw new Error(`fastForward failed: ${res.error}`);
    if (!res.ended) await this.waitView(`v.t >= ${res.t! - 1}`);
    return { t: res.t!, ended: !!res.ended };
  }

  /**
   * Freeze (true) or release (false) the room's match clock. startMatch freezes it, so preparation, trap holds and
   * cooldowns advance only through fastForward and never depend on how fast the machine runs. Release it only
   * for assertions that need real time to pass.
   */
  async hold(on: boolean): Promise<void> {
    const res = await this.page.evaluate(
      async ([hold]) => {
        const m = await (new Function('p', 'return import(p)') as (p: string) => Promise<typeof import('../../client/src/net/socket')>)('/src/net/socket.ts');
        const sess = JSON.parse(sessionStorage.getItem('fnab.session') ?? 'null') as { token: string } | null;
        return new Promise<{ ok: boolean; error?: string }>((resolve) => {
          const sock = m.getSocket() as unknown as { emit: (e: string, p: unknown, ack: (r: never) => void) => void };
          sock.emit('test:hold', { token: sess?.token, hold }, resolve as never);
          setTimeout(() => resolve({ ok: false, error: 'no ack (are FNAB_TEST_HOOKS enabled?)' }), 20_000);
        });
      },
      [on] as const,
    );
    if (!res.ok) throw new Error(`hold(${on}) failed: ${res.error}`);
  }

  /** Drop this player's socket (like a lost network) or bring it back; the app auto-resumes its session on connect. */
  async socket(action: 'disconnect' | 'connect'): Promise<void> {
    await this.page.evaluate(async (a) => {
      const mod = await (new Function('p', 'return import(p)') as (p: string) => Promise<{ getSocket: () => { disconnect: () => void; connect: () => void } }>)('/src/net/socket.ts');
      mod.getSocket()[a]();
    }, action);
  }

  /** Let the monster's global command gap (any two monster actions need cfg.monster.globalCommandGapMs between them) pass. */
  async passGap(): Promise<void> {
    await this.fastForward(CFG.monster.globalCommandGapMs + TICK * 2);
  }

  async dispose(): Promise<void> {
    await this.context.close().catch(() => undefined);
  }
}

export async function newPlayer(browser: Browser, name: string, opts: PlayerOpts = {}): Promise<Player> {
  const baseURL = opts.baseURL ?? test.info().project.use.baseURL;
  // reducedMotion: the app's FX follow the OS preference; it keeps 3-4 canvases per tab from saturating the CPU.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL, reducedMotion: 'reduce' });
  if (opts.blockCaltrans) await context.route(/(^|\.)dot\.ca\.gov/, (r) => r.abort('blockedbyclient'));
  const page = await context.newPage();
  if (THROTTLE > 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  return new Player(name, context, page);
}

/** Open the title page (the `e2e` flag guarantees window.__fnab even in a production build). */
export async function openTitle(p: Player, query = ''): Promise<void> {
  await p.page.goto(`/?e2e${query ? '&' + query : ''}`);
  await expect(p.page.getByTestId('title-screen')).toBeVisible();
  await expect(p.page.locator('#name')).toBeEnabled();
}

export async function createRoom(p: Player): Promise<string> {
  await openTitle(p);
  await p.page.fill('#name', p.name);
  await p.page.getByRole('button', { name: 'Create room' }).click();
  const code = ((await p.page.getByTestId('room-code').textContent()) ?? '').trim();
  expect(code).toMatch(/^[A-Z]{4}$/);
  p.code = code;
  return code;
}

export async function joinByCode(p: Player, code: string): Promise<void> {
  await openTitle(p);
  await p.page.fill('#name', p.name);
  await p.page.fill('input[aria-label="Room code"]', code);
  await p.page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(p.page.getByTestId('room-code')).toHaveText(code);
  p.code = code;
}

export async function joinByInvite(p: Player, code: string, opts: { midMatch?: boolean } = {}): Promise<void> {
  await p.page.goto(`/?e2e&room=${code}`);
  await expect(p.page.getByTestId('title-screen')).toBeVisible();
  await p.page.fill('#name', p.name);
  await p.page.getByRole('button', { name: 'Join', exact: true }).click();
  // Joining a running match skips the lobby (you spectate it).
  if (!opts.midMatch) await expect(p.page.getByTestId('room-code')).toHaveText(code);
  p.code = code;
}

export async function setRole(p: Player, role: 'monster' | 'defender' | 'spectator'): Promise<void> {
  await p.page.getByTestId(`role-${role}`).click();
  await expect(p.page.getByTestId(`role-${role}`)).toHaveAttribute('aria-checked', 'true');
}

export async function pickHq(p: Player, hq: HqId): Promise<void> {
  await p.page.getByTestId(`hq-${hq}`).click();
  await expect(p.page.getByTestId(`hq-${hq}`)).toHaveAttribute('aria-pressed', 'true');
}

export async function ready(p: Player): Promise<void> {
  await p.page.getByTestId('ready').click();
  // The last player to ready starts the countdown, which unmounts the lobby: assert on state, not on the button.
  await expect
    .poll(async () => {
      const r = await p.room();
      return r.stage !== 'lobby' || r.players.find((x) => x.id === r.youId)?.ready === true;
    })
    .toBe(true);
}

export interface Match {
  code: string;
  hq: HqId;
  monster: Player;
  defenders: Player[];
  spectators: Player[];
  all: Player[];
}

export interface StartOpts {
  hq?: HqId;
  defenders?: number;
  spectators?: number;
  /** Night length in seconds (host picks it in the lobby). Default: the longest allowed. */
  durationSec?: number;
  playerOpts?: PlayerOpts;
  /** Stop once the match screens are up (default) vs. leave the room in the lobby with everyone joined. */
  stopAt?: 'lobby' | 'match';
}

/**
 * Monster (host) creates, defenders join by code, spectators by invite link, a defender picks the HQ,
 * everyone readies, and we wait for the match screens.
 */
export async function startMatch(browser: Browser, o: StartOpts = {}): Promise<Match> {
  const hq = o.hq ?? 'hq-sf';
  const nDef = o.defenders ?? 1;
  const monster = await newPlayer(browser, 'Monster', o.playerOpts);
  const defenders = await Promise.all(Array.from({ length: nDef }, (_, i) => newPlayer(browser, `Def${i + 1}`, o.playerOpts)));
  const spectators = await Promise.all(Array.from({ length: o.spectators ?? 0 }, (_, i) => newPlayer(browser, `Spec${i + 1}`, o.playerOpts)));
  const code = await createRoom(monster);
  for (const d of defenders) await joinByCode(d, code);
  for (const s of spectators) {
    await joinByInvite(s, code);
    await setRole(s, 'spectator');
  }
  await pickHq(defenders[0]!, hq);
  await monster.hold(true); // match time moves only via fastForward from here on (see Player.hold)
  const dur = o.durationSec ?? CFG.match.maxDurationMs / 1000;
  await monster.page.getByTestId(`duration-${dur}`).click();
  const m: Match = { code, hq, monster, defenders, spectators, all: [monster, ...defenders, ...spectators] };
  if (o.stopAt === 'lobby') return m;
  await ready(monster);
  for (const d of defenders) await ready(d);
  await expect(monster.page.getByTestId('monster-screen')).toBeVisible({ timeout: 30_000 });
  for (const d of defenders) await expect(d.page.getByTestId('defender-screen')).toBeVisible({ timeout: 30_000 });
  for (const s of spectators) await expect(s.page.getByTestId('defender-screen')).toBeVisible({ timeout: 30_000 });
  return m;
}

export async function disposeAll(m: Pick<Match, 'all'>): Promise<void> {
  await Promise.all(m.all.map((p) => p.dispose()));
}

/** Skip the preparation phase (the monster spawns when it ends). */
export async function skipPrep(m: Match): Promise<void> {
  await m.monster.fastForward(CFG.match.prepMs + TICK * 2);
  await m.monster.waitView(`v.phase !== 'preparation' && v.self.spawned`);
}

/** The match's final result as seen by every participant: waits for the result screen on all of them. */
export async function expectSameResult(m: Match): Promise<MatchResult> {
  for (const p of m.all) await expect(p.page.getByTestId('results-screen')).toBeVisible({ timeout: 30_000 });
  const results = await Promise.all(m.all.map((p) => p.result()));
  const ref = results[0]!;
  for (const r of results) {
    expect(r.winner).toBe(ref.winner);
    expect(r.reason).toBe(ref.reason);
    expect(r.endedAtT).toBe(ref.endedAtT);
    expect(r.hqId).toBe(ref.hqId);
    expect(r.timeline.length).toBe(ref.timeline.length);
    expect(r.monsterPath).toEqual(ref.monsterPath);
  }
  return ref;
}

/** Fast-forward in `chunk`-ms steps until the match ends or `maxMs` of match time has passed. */
export async function runUntilEnd(p: Player, opts: { chunk?: number; maxMs?: number; each?: (t: number) => Promise<void> } = {}): Promise<void> {
  const chunk = opts.chunk ?? 15_000;
  const max = opts.maxMs ?? CFG.match.maxDurationMs + CFG.match.prepMs;
  for (let spent = 0; spent < max; spent += chunk) {
    const r = await p.fastForward(chunk);
    if (r.ended) return;
    await opts.each?.(r.t);
  }
}

export const asMonster = (v: PlayerView) => v as MonsterView;
export const asDefender = (v: PlayerView) => v as DefenderView;

/** Monster picks its emergence node during preparation (via the socket; the UI path is covered in monster-ai.spec). */
export async function chooseSpawn(m: Match, nodeId?: string): Promise<string> {
  const v = asMonster(await m.monster.view());
  const node = nodeId ?? v.spawnOptions[0]!;
  const res = await m.monster.act({ type: 'chooseSpawn', nodeId: node });
  expect(res, `chooseSpawn ${node}`).toMatchObject({ ok: true });
  await m.monster.passGap();
  return node;
}

/** Click a node on a defender's tactical map (inspect tool selects it and its camera). */
export async function clickMapNode(p: Player, nodeId: string): Promise<void> {
  await p.page.locator(`[data-node="${nodeId}"]`).first().click({ force: true });
}

/** Current monster node/edge as the monster itself sees it. */
export async function monsterNode(m: Match): Promise<string> {
  const s = asMonster(await m.monster.view()).self;
  return (s.nodeId ?? s.moving?.from)!;
}
