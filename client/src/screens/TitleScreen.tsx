import { useState } from 'react';
import type { SoloOptions } from '@fnab/shared';
import { createRoom, createSoloRoom, joinRoom, savedName } from '../net/socket';
import { useGame } from '../state/store';
import { Button } from '../ui/kit';
import { AudioUnlockPrompt, ConnectionBadge, SettingsMenu } from '../ui/chrome';
import { useUiAssets } from '../ui/assets';
import { NETWORK } from '../lib/data';
import { TitleSign } from './shell/Brand';
import { HowToPlay } from './shell/HowToPlay';
import { SoloSetup } from './shell/AiSetup';

/** Server errors in the interface's own words: what happened, and what to do. */
function explain(error: string, code: string): string {
  if (/not found/i.test(error)) return `No room uses the code ${code}. Check it with the host and try again.`;
  if (/full/i.test(error)) return `Room ${code} is full. Ask the host for a new room.`;
  if (/did not respond/i.test(error)) return 'The server did not answer. Check your connection and try again.';
  return error;
}

export function TitleScreen() {
  const [name, setName] = useState(savedName());
  const [code, setCode] = useState(() =>
    (new URLSearchParams(location.search).get('room') ?? '')
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .slice(0, 4),
  );
  const [busy, setBusy] = useState<'create' | 'join' | 'solo' | null>(null);
  const [solo, setSolo] = useState(false);
  const [help, setHelp] = useState(false);
  const toast = useGame((s) => s.toast);
  const connection = useGame((s) => s.connection);
  const assets = useUiAssets();
  const invited = code.length === 4 && new URLSearchParams(location.search).has('room');
  const offline = connection !== 'online';

  const go = async (kind: 'create' | 'join') => {
    if (!name.trim()) return toast('Enter a name so the others know who you are', 'warn');
    if (kind === 'join' && code.trim().length < 4) return toast('Room codes are 4 letters', 'warn');
    setBusy(kind);
    const res = kind === 'create' ? await createRoom(name.trim()) : await joinRoom(code.trim(), name.trim());
    setBusy(null);
    if (!res.ok) toast(explain(res.error, code), 'error');
  };
  const goSolo = async (options: SoloOptions) => {
    setBusy('solo');
    const res = await createSoloRoom(name.trim() || 'Nightwatch', options);
    setBusy(null);
    if (!res.ok) toast(explain(res.error, code), 'error');
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden" data-testid="title-screen">
      <picture aria-hidden className="absolute inset-0">
        {assets.keyartSmall && <source media="(max-width: 1280px)" srcSet={assets.keyartSmall} />}
        <img src={assets.keyart} alt="" className="h-full w-full object-cover object-right opacity-90" draggable={false} />
      </picture>
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(90deg, #050607 0%, rgba(5,6,7,0.94) 30%, rgba(5,6,7,0.35) 62%, rgba(5,6,7,0.55) 100%), linear-gradient(0deg, rgba(5,6,7,0.9) 0%, transparent 30%)',
        }}
      />

      <header className="relative z-20 flex items-center justify-between px-6 py-4">
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
          <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-alert align-middle motion-safe:animate-blink" />
          REC · Caltrans D4 night shift
        </div>
        <div className="flex items-center gap-3">
          <ConnectionBadge />
          <Button tone="ghost" size="sm" onClick={() => setHelp(true)} data-testid="how-to-play-open">
            How to play
          </Button>
          <SettingsMenu />
        </div>
      </header>

      <main className="relative z-10 flex min-h-0 flex-1 flex-col justify-center px-6 pb-16 lg:pl-[7vw]">
        <TitleSign className="mb-[min(32px,3.5vh)] motion-safe:animate-rise" />
        <p className="max-w-[440px] text-[15px] leading-relaxed text-text/85">
          {NETWORK.nodes.length} freeway cameras, one thing moving between them. Hold the control room until dawn, or be the thing on the
          shoulder that shouldn't be there.
        </p>

        <section
          className="mt-[min(32px,3.5vh)] w-full max-w-[520px] border border-edge bg-panel/85 p-5 shadow-[0_20px_60px_rgba(0,0,0,0.5)] backdrop-blur"
          aria-label="Start playing"
        >
          <label className="block text-[12px] text-mute" htmlFor="name">
            Your name
          </label>
          <input
            id="name"
            value={name}
            maxLength={20}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void go(code.length === 4 ? 'join' : 'create')}
            className="mt-1.5 w-full border border-edge-hi bg-ink px-3 py-2.5 font-mono text-[15px] text-bright outline-none transition-colors placeholder:text-dim focus:border-cyan"
            placeholder="NIGHTWATCH"
            autoComplete="nickname"
            autoFocus
          />
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-mute">Start a new night</span>
              <Button
                tone={invited ? 'neutral' : 'alert'}
                size="lg"
                disabled={!!busy || offline}
                onClick={() => void go('create')}
              >
                {busy === 'create' ? 'Opening…' : 'Create room'}
              </Button>
            </div>
            <div aria-hidden className="hidden pb-3 font-mono text-[10px] text-dim sm:block">
              or
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-mute">{invited ? `You were invited to ${code}` : 'Join with a code'}</span>
              <div className="flex">
                <input
                  value={code}
                  onChange={(e) =>
                    setCode(
                      e.target.value
                        .toUpperCase()
                        .replace(/[^A-Z]/g, '')
                        .slice(0, 4),
                    )
                  }
                  onKeyDown={(e) => e.key === 'Enter' && void go('join')}
                  className="w-[92px] border border-r-0 border-edge-hi bg-ink px-2 py-2 text-center font-mono text-[17px] tracking-[0.3em] text-bright outline-none placeholder:text-dim focus:border-cyan"
                  placeholder="CODE"
                  aria-label="Room code"
                  autoCapitalize="characters"
                  spellCheck={false}
                />
                <Button tone={invited ? 'alert' : 'cyan'} size="lg" className="flex-1" disabled={!!busy || offline} onClick={() => void go('join')}>
                  {busy === 'join' ? 'Joining…' : 'Join'}
                </Button>
              </div>
            </div>
          </div>
          <Button tone="cyan" size="lg" className="mt-4 w-full" disabled={!!busy || offline} onClick={() => setSolo(true)} data-testid="play-solo">
            Play solo
          </Button>
          {offline && <p className="mt-3 text-[12px] text-warn">Waiting for the game server. Buttons unlock when the link is up.</p>}
        </section>

        <div className="mt-5 flex max-w-[520px] flex-wrap gap-x-6 gap-y-1 text-[12px] text-dim">
          <span>One monster</span>
          <span>Any number of defenders</span>
          <span>5 to 10 minute nights</span>
          <button className="text-mute underline decoration-edge-hi underline-offset-4 hover:text-text" onClick={() => setHelp(true)}>
            Read the briefing
          </button>
        </div>
      </main>

      <div className="pointer-events-none absolute bottom-4 right-6 z-20">
        <AudioUnlockPrompt />
      </div>
      <HowToPlay open={help} onClose={() => setHelp(false)} />
      {solo && <SoloSetup busy={busy === 'solo'} disabled={offline} onStart={options => void goSolo(options)} onClose={() => setSolo(false)} />}
    </div>
  );
}
