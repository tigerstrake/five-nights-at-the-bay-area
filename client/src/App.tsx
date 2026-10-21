import { useEffect, useRef, useState } from 'react';
import { DEFAULT_CONFIG } from '@fnab/shared';
import { getSocket } from './net/socket';
import { useGame } from './state/store';
import { useGameAudio } from './hooks/useGameAudio';
import { useConsoleZoom } from './hooks/useConsoleZoom';
import { TitleScreen } from './screens/TitleScreen';
import { LobbyScreen } from './screens/LobbyScreen';
import { LoadingScreen } from './screens/LoadingScreen';
import { DefenderScreen } from './screens/DefenderScreen';
import { MonsterScreen } from './screens/MonsterScreen';
import { ResultsScreen } from './screens/ResultsScreen';
import { ReconnectBanner, ScreenGrain, Toasts, useReduceFlashing } from './ui/chrome';
import { ScreenTransition } from './screens/shell/ScreenTransition';
import { resetUplink, startUplink, useUplink } from './screens/shell/uplink';

/** Longest the game screen may be held back for the uplink checks once the match is running. */
const UPLINK_GATE_MAX_MS = 4000;
/** Uplink budget when resuming straight into a running match (no countdown to hide it behind). */
const UPLINK_RESUME_MS = 2500;

export function App() {
  useEffect(() => {
    getSocket();
  }, []);
  useGameAudio();
  const { zoom, w: vw, h: vh } = useConsoleZoom();
  const reduceFlash = useReduceFlashing();
  const room = useGame((s) => s.room);
  const view = useGame((s) => s.view);
  const result = useGame((s) => s.result);
  const connection = useGame((s) => s.connection);
  const toast = useGame((s) => s.toast);
  const uplinkDone = useUplink((s) => s.done);
  const uplinkKey = useUplink((s) => s.key);
  const [gateExpired, setGateExpired] = useState(false);

  const stage = room?.stage;
  const code = room?.code;
  const hqId = room?.settings.hqId;

  // Uplink checks: run during the countdown; on a resume straight into a match, run briefly before the screen.
  useEffect(() => {
    if (!code || !hqId) return resetUplink();
    if (stage === 'countdown') startUplink(`${code}:match`, hqId, DEFAULT_CONFIG.match.countdownMs + 500);
    else if (stage === 'playing') startUplink(`${code}:match`, hqId, UPLINK_RESUME_MS);
    else resetUplink();
  }, [stage, code, hqId]);
  useEffect(() => {
    setGateExpired(false);
    if (stage !== 'playing') return;
    const id = setTimeout(() => setGateExpired(true), UPLINK_GATE_MAX_MS);
    return () => clearTimeout(id);
  }, [stage]);

  // Keep the invite deep link in the address bar while in a room; clear it after leaving.
  const prevCode = useRef<string | undefined>(code);
  useEffect(() => {
    const url = new URL(location.href);
    const want = code ?? null;
    if (url.searchParams.get('room') === want) return;
    if (want) url.searchParams.set('room', want);
    else if (prevCode.current) url.searchParams.delete('room');
    else return;
    history.replaceState(history.state, '', url);
  }, [code]);
  useEffect(() => {
    prevCode.current = code;
  }, [code]);

  // Tell the player when a dropped link comes back.
  const wasDown = useRef(false);
  useEffect(() => {
    if (connection === 'reconnecting') wasDown.current = true;
    else if (connection === 'online' && wasDown.current) {
      wasDown.current = false;
      if (useGame.getState().room) toast('Signal restored', 'good');
    }
  }, [connection, toast]);

  const holdForUplink = stage === 'playing' && !!view && uplinkKey !== null && !uplinkDone && !gateExpired;

  let screen;
  let key: string;
  if (!room) {
    screen = <TitleScreen />;
    key = 'title';
  } else if (room.stage === 'lobby') {
    screen = <LobbyScreen room={room} />;
    key = 'lobby';
  } else if (room.stage === 'countdown') {
    screen = <LoadingScreen room={room} />;
    key = 'loading';
  } else if (room.stage === 'results' && result) {
    screen = <ResultsScreen room={room} result={result} />;
    key = 'results';
  } else if (!view || holdForUplink) {
    screen = <LoadingScreen room={room} />;
    key = 'loading';
  } else if (view.role === 'monster') {
    screen = <MonsterScreen room={room} view={view} />;
    key = 'monster';
  } else {
    screen = <DefenderScreen room={room} view={view} />;
    key = 'defender';
  }

  const team =
    view?.role === 'monster' || (key !== 'title' && room?.players.find((p) => p.id === room.youId)?.role === 'monster')
      ? 'monster'
      : 'defender';
  // The breach / containment cinematics are their own transition.
  const skipTransition = key === 'results' && (result?.reason === 'breach' || result?.reason === 'capture');

  return (
    <div
      className="h-full w-full overflow-hidden bg-void text-text"
      data-team={team}
      data-zoom={zoom}
      data-reduce-flash={reduceFlash ? '1' : '0'}
      style={zoom !== 1 ? { zoom, width: `${vw / zoom}px`, height: `${vh / zoom}px` } : undefined}
    >
      <ScreenTransition screenKey={key} skip={skipTransition}>
        {screen}
      </ScreenTransition>
      <ReconnectBanner />
      <Toasts />
      <ScreenGrain />
    </div>
  );
}
