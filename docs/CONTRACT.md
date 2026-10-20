# Build Contract (read before touching code)

Several agents build this repo in parallel (Claude subagents + Codex). This file fixes the layout,
ownership, and cross-module interfaces so work composes. The product spec is `docs/SPEC.md`.

## Ground rules

- **Do not `git commit`, `git checkout`, `git stash`, or `git reset`.** The orchestrator commits between waves.
- **Only edit files you own** (table below). If you need a change in someone else's area, make the
  smallest compatible change and list it under "Cross-boundary edits" in your final report.
- **Dependencies:** only the Foundation agent edits `package.json` files and runs `npm install` in wave 1.
  Anyone else needing a dependency: say so in your final report instead of installing it. Wave 2+ agents
  may install with `npm install <pkg> -w <workspace>`, never concurrently with another install.
- **Ports** (avoid collisions between agents running servers at the same time):
  Foundation: server 3001, client 5175 (5173 belongs to another project — never use or kill it) · FX: 5180 · Maps/UI agents: told per task · e2e: 3101/5199.
  Kill every server you start before finishing.
- No magic numbers in game logic: tunables live in `shared/src/config.ts`.
- Never present simulated imagery as live. Never fabricate API responses or claim an integration works
  without having run it.
- TypeScript strict mode everywhere. ESM. Node 24 is installed.

## Layout (npm workspaces)

```
fnab/
  package.json            workspaces: shared, server, client  (Foundation)
  tsconfig.base.json      (Foundation)
  shared/                 @fnab/shared — pure TS, zero runtime deps
    src/types.ts          domain types                       (Foundation)
    src/protocol.ts       socket events + payloads           (Foundation)
    src/config.ts         BalanceConfig defaults + scaling   (Foundation)
    src/graph.ts          graph helpers over network.json    (Foundation)
    src/data/cameras.json curated Caltrans cameras           (Camera-Research)
    src/data/network.json gameplay graph + HQs               (Camera-Research)
  server/                 @fnab/server
    src/engine/           pure deterministic simulation      (Foundation)
    src/ai/               monster AI (pathfinding/behaviour) (Foundation stub → AI agent, wave 2)
    src/visibility/       full state → per-role views        (Foundation)
    src/rooms/ src/net/   lobby, codes, reconnection, socket.io (Foundation)
    src/cameras/          camera adapter                     (Camera-Research writes fetch/curate scripts in
                                                              scripts/cameras/; adapter itself: wave 2)
  client/                 @fnab/client — Vite + React + TS + Tailwind
    src/fx/               canvas/WebGL feed effects, monster compositing, simulated feed (FX agent)
    src/audio/            Web Audio engine                   (Audio agent / Codex)
    fxlab.html            FX dev harness page                (FX agent)
    everything else       (Foundation in wave 1)
  scripts/cameras/        camera discovery/curation scripts  (Camera-Research)
  docs/                   CAMERAS.md (Camera-Research), others as noted
  e2e/                    Playwright (wave 3)
```

## Data schemas (shared/src/data)

### cameras.json — `CameraRecord[]`

```ts
interface CameraRecord {
  id: string;                 // stable lowercase, e.g. "d4-tvd32" (derived from Caltrans index)
  caltransIndex: string;      // the source's own index/identifier
  name: string;               // e.g. "I-80 : Bay Bridge Toll Plaza"
  route: string;              // "I-80"
  direction: string | null;
  county: string;
  nearbyPlace: string;
  lat: number;
  lon: number;
  imageUrl: string | null;    // static JPEG snapshot URL
  streamUrl: string | null;   // HLS .m3u8 if published
  imageUpdateFrequencyMin: number | null;
  inService: boolean;         // per source at curation time
  verified: {
    checkedAt: string;        // ISO timestamp of the curation check
    imageHttp: number | null; // HTTP status seen for imageUrl
    streamHttp: number | null;
    imageCors: boolean | null;  // Access-Control-Allow-Origin permits browser use
    streamCors: boolean | null;
  };
  placement: Array<{ x: number; y: number; w: number; h: number; scale: number }>;
  // normalized 0..1 boxes in the camera image where a figure could plausibly stand (shoulder, lane,
  // distant overpass…). scale = relative figure height vs. frame height at that spot (0.05..0.9).
  tags: string[];             // "bridge" | "tunnel" | "interchange" | "freeway" | "toll" | "downtown" ...
}
```

### network.json — `NetworkData`

```ts
interface NetworkData {
  version: 1;
  nodes: Array<{
    id: string;               // "n-<slug>"
    cameraId: string | null;  // CameraRecord.id (prefer every node to have a camera)
    name: string;             // short display name, e.g. "Bay Bridge West"
    lat: number; lon: number;
    region: 'sf' | 'north-bay' | 'east-bay' | 'peninsula' | 'south-bay';
    tags: string[];
    tactical: { x: number; y: number };  // stylized layout, 0..1000 both axes, north up, readable spacing
  }>;
  edges: Array<{
    id: string; a: string; b: string;      // undirected
    kind: 'freeway' | 'bridge' | 'surface' | 'tunnel';
    route: string;                         // "I-280", "US-101", "Golden Gate Bridge"...
    lengthKm: number;
  }>;
  headquarters: Array<{
    id: 'hq-stanford' | 'hq-sf' | 'hq-oakland' | 'hq-sanjose';
    name: string; lat: number; lon: number;
    tactical: { x: number; y: number };
    approaches: Array<{ id: string; label: string; fromNode: string; door: string }>; // 3 per HQ
  }>;
  spawnNodes: string[];       // candidate monster start nodes, far from every HQ
}
```

HQs are **not** graph nodes. A monster standing on an approach's `fromNode` can attack that
approach's door into the HQ.

## Client module interfaces (stubs exist; owners replace the implementation, keep the exports)

- `client/src/fx/index.ts` — `FeedFx` React components + `FeedFxParams` (see file).
- `client/src/audio/index.ts` — `audio: AudioEngine` singleton + `SfxName` (see file).

Foundation consumes these exports exactly as declared. Owners may add exports but must not break
the declared ones.

## Wave 2 ownership (supersedes the table above where they overlap)

| Agent | Owns | Dev ports (server/client) |
|---|---|---|
| AI (Codex) | `server/src/ai/**` | none (sandboxed) |
| Cameras | `server/src/cameras/**`, `client/src/feeds/**`, camera wiring in `server/src/index.ts`, camera vars in `.env.example`, adapter section of `docs/CAMERAS.md` | 3205 / 5205 |
| Maps | `client/src/map/**` | 3201 / 5201 |
| Defender UI | `client/src/screens/DefenderScreen.tsx`, `client/src/screens/defender/**` | 3202 / 5202 |
| Monster UI | `client/src/screens/MonsterScreen.tsx`, `client/src/screens/monster/**` | 3203 / 5203 |
| Shell | `client/src/App.tsx`, `TitleScreen`, `LobbyScreen`, `LoadingScreen`, `ResultsScreen`, `client/src/screens/hud.tsx`, `client/src/screens/shell/**`, `client/src/ui/**`, `client/src/index.css` | 3204 / 5204 |

Shared contracts (`shared/**`), engine, visibility, rooms, net and `client/src/state/**` are shared ground:
only small **additive** changes (new optional fields, new events), made with a fresh read right before
the edit, and listed in your final report. Never rename or remove existing fields.

Running servers in wave 2: do NOT use `tsx watch` (other agents' edits would restart your server).
Run `PORT=<p> CAMERA_MODE=simulation npx tsx server/src/index.ts` from the repo root and
`API_PORT=<p> npx vite --port <c> --strictPort` from `client/`. Restart yourself after server edits.
Keep every existing `data-testid` working (e2e depends on them); add new ones for new controls.
