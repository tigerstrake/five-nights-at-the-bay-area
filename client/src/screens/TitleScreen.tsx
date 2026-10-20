import { useState } from 'react';
import { createRoom, joinRoom, savedName } from '../net/socket';
import { useGame } from '../state/store';
import { Button } from '../ui/kit';
import { AudioControls, ConnectionBadge } from '../ui/chrome';
import { NETWORK } from '../lib/data';

export function TitleScreen() {
  const [name, setName] = useState(savedName());
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('room')?.toUpperCase() ?? '');
  const [busy, setBusy] = useState(false);
  const toast = useGame((s) => s.toast);
  const connection = useGame((s) => s.connection);

  const go = async (kind: 'create' | 'join') => {
    if (!name.trim()) return toast('Enter an operator name', 'warn');
    if (kind === 'join' && code.trim().length < 4) return toast('Enter a 4-letter room code', 'warn');
    setBusy(true);
    const res = kind === 'create' ? await createRoom(name.trim()) : await joinRoom(code.trim(), name.trim());
    setBusy(false);
    if (!res.ok) toast(res.error, 'error');
  };

  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden">
      <picture aria-hidden className="absolute inset-0">
        <source media="(max-width: 1280px)" srcSet="/assets/ui/keyart-small.jpg" />
        <img src="/assets/ui/keyart.jpg" alt="" className="h-full w-full object-cover object-right opacity-85" draggable={false} />
      </picture>
      <div
        aria-hidden
        className="absolute inset-0"
        style={{ background: 'linear-gradient(90deg, #050607 0%, rgba(5,6,7,0.9) 34%, rgba(5,6,7,0.2) 68%, rgba(5,6,7,0.5) 100%)' }}
      />
      <div className="absolute right-4 top-3 flex items-center gap-4">
        <ConnectionBadge />
        <AudioControls />
      </div>

      <div className="relative z-10 flex w-full max-w-xl flex-col items-center px-6 lg:ml-[6vw] lg:mr-auto lg:items-start">
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.5em] text-alert">Caltrans District 4 · Night Shift</div>
        <h1 className="text-center text-5xl lg:text-left font-bold tracking-tight text-bright md:text-6xl">
          Five Nights at
          <br />
          <span className="text-alert [text-shadow:0_0_24px_rgba(200,50,58,0.45)]">the Bay Area</span>
        </h1>
        <p className="mt-4 max-w-md text-center text-sm lg:text-left leading-relaxed text-mute">
          {NETWORK.nodes.length} traffic cameras. One thing moving between them. Defend headquarters until dawn — or become what walks the
          freeways.
        </p>

        <div className="mt-10 w-full border border-edge bg-panel/90 p-5 backdrop-blur">
          <label className="block font-mono text-[10px] uppercase tracking-[0.2em] text-dim" htmlFor="name">
            Operator name
          </label>
          <input
            id="name"
            value={name}
            maxLength={20}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void go(code ? 'join' : 'create')}
            className="mt-1 w-full border border-edge-hi bg-ink px-3 py-2 font-mono text-sm text-bright outline-none focus:border-cyan"
            placeholder="e.g. NIGHTWATCH"
            autoFocus
          />
          <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-dim">New operation</div>
              <Button tone="alert" size="lg" disabled={busy || connection !== 'online'} onClick={() => void go('create')}>
                Create room
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-dim">Join by code</div>
              <div className="flex gap-2">
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
                  className="w-24 border border-edge-hi bg-ink px-2 py-2 text-center font-mono text-base tracking-[0.3em] text-bright outline-none focus:border-cyan"
                  placeholder="CODE"
                  aria-label="Room code"
                />
                <Button tone="cyan" size="lg" className="flex-1" disabled={busy || connection !== 'online'} onClick={() => void go('join')}>
                  Join
                </Button>
              </div>
            </div>
          </div>
        </div>
        <div className="mt-6 text-center font-mono lg:text-left text-[10px] uppercase tracking-[0.25em] text-dim">
          1 monster · any number of defenders · 5–10 minute nights
        </div>
      </div>
    </div>
  );
}
