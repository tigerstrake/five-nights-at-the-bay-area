import { useEffect } from 'react';
import { getSocket } from './net/socket';
import { useGame } from './state/store';
import { useGameAudio } from './hooks/useGameAudio';
import { TitleScreen } from './screens/TitleScreen';
import { LobbyScreen } from './screens/LobbyScreen';
import { LoadingScreen } from './screens/LoadingScreen';
import { DefenderScreen } from './screens/DefenderScreen';
import { MonsterScreen } from './screens/MonsterScreen';
import { ResultsScreen } from './screens/ResultsScreen';
import { ScreenGrain, Toasts } from './ui/chrome';

export function App() {
  useEffect(() => {
    getSocket();
  }, []);
  useGameAudio();
  const room = useGame((s) => s.room);
  const view = useGame((s) => s.view);
  const result = useGame((s) => s.result);

  let screen;
  if (!room) screen = <TitleScreen />;
  else if (room.stage === 'lobby') screen = <LobbyScreen room={room} />;
  else if (room.stage === 'countdown') screen = <LoadingScreen room={room} />;
  else if (room.stage === 'results' && result) screen = <ResultsScreen room={room} result={result} />;
  else if (!view) screen = <LoadingScreen room={room} />;
  else if (view.role === 'monster') screen = <MonsterScreen room={room} view={view} />;
  else screen = <DefenderScreen room={room} view={view} />;

  return (
    <div className="h-full w-full overflow-hidden bg-void text-text">
      {screen}
      <Toasts />
      <ScreenGrain />
    </div>
  );
}
