// Dev-only map harness (served by Vite at /src/map/lab/index.html; not part of the production build).
// ?s=<scenario>&mode=tactical|geo&w=<px>&h=<px> renders one map with canned layers for visual checks.
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import type { CameraGameStatus, HqId } from '@fnab/shared';
import { DEFAULT_CONFIG, spawnCandidates } from '@fnab/shared';
import { graph, NETWORK } from '../../lib/data';
import { useGame } from '../../state/store';
import { MapPanel } from '../MapPanel';
import type { MapProps, MarkKind } from '../layers';

const q = new URLSearchParams(location.search);
const scenario = q.get('s') ?? 'defender';
const W = Number(q.get('w') ?? 0);
const H = Number(q.get('h') ?? 0);

const statuses = (): Record<string, CameraGameStatus> => {
  const out: Record<string, CameraGameStatus> = {};
  NETWORK.nodes.forEach((n, i) => (out[n.id] = i % 11 === 3 ? 'sabotaged' : i % 13 === 5 ? 'static' : i % 17 === 7 ? 'repairing' : 'ok'));
  return out;
};

useGame.getState().setCameraStatuses(
  NETWORK.nodes.map((n, i) => ({
    cameraId: n.cameraId!,
    mode: i % 9 === 4 ? 'offline' : i % 5 === 0 ? 'simulated' : 'snapshot',
    snapshotUrl: null,
    streamUrl: null,
    lastUpdated: Date.now(),
    error: null,
  })),
);

function useTicker(ms: number) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((x) => x + ms), ms);
    return () => clearInterval(id);
  }, [ms]);
  return t;
}

function Scenario() {
  const t = useTicker(100);
  const [sel, setSel] = useState<string | null>(null);
  let props: MapProps = {};
  if (scenario === 'defender' || scenario === 'defender-stanford' || scenario === 'defender-oak') {
    const hqId = (scenario === 'defender' ? 'hq-sf' : scenario === 'defender-oak' ? 'hq-oakland' : 'hq-stanford') as HqId;
    const hq = graph.hqs.get(hqId)!;
    const marks: Record<string, MarkKind[]> = {};
    const add = (n: string, m: MarkKind) => (marks[n] ??= []).push(m);
    add(hq.approaches[0]!.fromNode, 'trap');
    add(hq.approaches[1]!.fromNode, 'trapArming');
    add('n-us101-alemany', 'sensor');
    add('n-maze', 'sensor');
    add('n-gg-north', 'sensorOff');
    add('n-hillsdale', 'lure');
    const age = ((t / 1000) % 60) / 60;
    props = {
      hqId,
      cameraStatus: statuses(),
      marks,
      sightings: [
        { id: 1, nodeId: 'n-bay-bridge-east', age: 0.85, confidence: 0.6, flagged: false, source: 'camera' },
        { id: 2, nodeId: 'n-bay-bridge-west', age: 0.5, confidence: 0.75, flagged: false, source: 'camera' },
        { id: 3, nodeId: 'n-ashby', age: 0.3, confidence: 0.5, flagged: true, source: 'camera' },
        { id: 4, nodeId: 'n-maze', age: 0.2, confidence: 0.5, flagged: false, source: 'sensor' },
        { id: 100 + Math.floor((t / 1000) / 6), nodeId: 'n-bay-bridge-sf', age: (((t / 1000) % 6) / 60), confidence: 0.9, flagged: false, source: 'camera' },
      ],
      lastKnown: 'n-bay-bridge-sf',
      rings: (t / 1000) % 8 < 4 ? [{ nodeId: 'n-maze', hops: 1, tone: 'cyan' }] : [],
      doors: {
        [hq.approaches[0]!.id]: { closed: true, heat: 0.62 },
        [hq.approaches[1]!.id]: { closed: false, heat: 0.1 },
        [hq.approaches[2]!.id]: { closed: false, jammed: true, heat: 0.4 },
      },
      breachApproachId: scenario === 'defender-oak' ? hq.approaches[1]!.id : null,
      breachProgress: 0.45,
      threat: 0.6 + 0 * age,
      selectedNode: sel ?? hq.approaches[0]!.fromNode,
      onNodeClick: setSel,
      held: scenario === 'defender-stanford' ? 'n-willow-101' : null,
      containmentProgress: scenario === 'defender-stanford' ? 0.4 : null,
      theme: 'defender',
    };
  } else if (scenario === 'monster' || scenario === 'monster-sabotage') {
    const hqId = 'hq-sf' as HqId;
    const route = ['n-richmond-580', 'n-rsr-bridge', 'n-san-rafael', 'n-marin-city', 'n-spencer', 'n-gg-north', 'n-octavia'];
    const seg = Math.floor((t / 9000) % (route.length - 1));
    const progress = ((t % 9000) / 9000);
    const from = route[seg]!, to = route[seg + 1]!;
    const marks: Record<string, MarkKind[]> = {};
    const add = (n: string, m: MarkKind) => (marks[n] ??= []).push(m);
    add('n-octavia', 'knownSensor');
    add('n-ashby', 'disturbance');
    add('n-maze', 'scanPulse');
    add('n-san-rafael', 'exposure');
    const st = statuses();
    st['n-spencer'] = 'sabotaged';
    const sab = scenario === 'monster-sabotage';
    props = {
      hqId,
      cameraStatus: st,
      marks,
      monster: { nodeId: null, moving: { from, to, progress } },
      path: [from, to, ...route.slice(seg + 2)],
      highlight: sab ? new Set(graph.within(to, 1)) : new Set(graph.neighbors(to)),
      highlightTone: sab ? 'warn' : 'monster',
      rings: sab ? [{ nodeId: to, hops: 1, tone: 'alert' }] : undefined,
      doorClosed: { 'sf-van-ness': true },
      selectedNode: sel,
      onNodeClick: setSel,
      theme: 'monster',
      attackPaths: true,
    };
  } else if (scenario === 'monster-prep') {
    const hqId = 'hq-stanford' as HqId;
    const spawns = spawnCandidates(graph, hqId, DEFAULT_CONFIG.spawn);
    props = {
      hqId,
      cameraStatus: statuses(),
      marks: Object.fromEntries(spawns.map((n) => [n, ['spawn' as const]])),
      monster: null,
      highlight: new Set(spawns),
      highlightTone: 'warn',
      selectedNode: sel ?? spawns[0],
      onNodeClick: setSel,
      cursorHint: 'Click a red-ringed spawn point',
    };
  } else if (scenario === 'lobby') {
    const [hq, setHq] = [((q.get('hq') ?? 'hq-oakland') as HqId), () => {}];
    props = {
      allHqs: true,
      hqId: hq,
      onHqClick: setHq,
      marks: Object.fromEntries(spawnCandidates(graph, hq, DEFAULT_CONFIG.spawn).map((n) => [n, ['spawn' as const]])),
    };
  } else if (scenario === 'results') {
    const path = ['n-sr37', 'n-san-rafael', 'n-marin-city', 'n-spencer', 'n-gg-north', 'n-octavia'];
    props = { hqId: 'hq-sf', path, breachApproachId: 'sf-van-ness', monster: { nodeId: 'n-octavia', moving: null } };
  } else if (scenario === 'bare') {
    props = {};
  }
  return (
    <div style={{ width: W || '100vw', height: H || '100vh', background: '#050607', padding: W ? 0 : 0 }}>
      <MapPanel {...props} defaultMode={q.get('mode') ?? undefined} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Scenario />
  </StrictMode>,
);
