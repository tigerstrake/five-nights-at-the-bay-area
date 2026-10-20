# Procedural audio

The default palette requires no audio files or dependencies. Import from `client/src/audio/index.ts`.

```ts
import { audio } from './audio';

// Run directly in a click/tap/key handler. Construction and resume happen here.
await audio.unlock();
audio.setAmbience('defender');
audio.setTension(0.35);
audio.play('cameraSwitch', { volume: 0.7, pan: -0.3 });
```

## API

| Method | Behavior |
| --- | --- |
| `unlock(): Promise<void>` | Lazily constructs/resumes Web Audio inside the gesture. Concurrent calls share the pending promise. Unsupported/denied audio resolves safely and can be retried. |
| `isUnlocked(): boolean` | True while initialized and the context is running. Call unlock again after browser suspension. |
| `setMasterVolume(v)` / `getMasterVolume()` | Clamps to 0–1. NaN preserves the previous setting. Default 0.8. |
| `setMuted(bool)` / `isMuted()` | Smooth master mute; changing volume while muted preserves mute. |
| `subscribe(listener)` | Observes actual volume/mute changes; returns an idempotent unsubscribe function. A failed observer does not block others. |
| `play(name, { volume?, pan? })` | One-shot. Volume defaults to 1 and clamps to 0–1; stereo pan defaults to center and clamps to −1–1. |
| `setTension(level)` | Clamps to 0–1; smoothly controls drone, noise and whine levels. Pulse rate/strength and random threat events rise with tension. |
| `setAmbience(kind)` | Crossfades room beds. `none` fades the entire ambience bus, including tension and distant sounds. Repeating the same kind does not restart it. |
| `playStinger(kind)` | Finite cinematic cue, independently rate limited. |
| `dispose()` | Additional lifecycle method on the singleton/factory result: stops/disconnects sources, cancels requests, clears the scheduler, closes the context. Can unlock afresh afterward. |

Before unlock, playback, tension and ambience methods are no-ops: they do not queue or remember sound requests. Volume/mute and subscriptions work before unlock. Set room and tension **after** unlocking. The module can be imported during SSR without Web Audio, storage or a window.

Settings use `fnab.audio.volume` and `fnab.audio.muted` in localStorage. All storage access is guarded, including access to the storage object itself. Subscription notifications are local to the instance; there is no cross-tab synchronization. `createAudioEngine(options?)` creates an independent instance and supports injectable context factory, storage and fetch for testing.

## Sound desk

| SfxName | Design |
| --- | --- |
| `uiClick` | Very short sine pitch drop plus tactile high-pass contact. |
| `uiHover` | Barely audible high electronic tick; at most once per 60 ms. |
| `cameraSwitch` | Dry relay, gated static and a small settling contact. |
| `staticBurst` | Three irregular bursts with moving band-pass coloration. |
| `doorClose` | Descending hydraulic motor, friction, steel impact and low latch. |
| `doorOpen` | Latch release, rising motor and pressure hiss. |
| `doorBlocked` | Dull bass strike against resonant sheet metal. |
| `trapArm` | Spring winding, two ratchet contacts, ready chirp. |
| `trapTrigger` | Snap, descending steel resonance and sub impact. |
| `alarm` | Restrained triangle klaxon, exactly three cycles. |
| `scanPing` | Descending sonar sweep and delayed reflection. |
| `sensorPing` | A short rising pair of detection pings. |
| `repairStart` | Diagnostic sweep with a quiet contact click. |
| `repairDone` | Clean ascending fifth with a faint upper harmonic. |
| `powerLow` | Two short warning beeps and a lower concluding beep. |
| `powerOut` | Filtered electrical rundown, then a low transformer thunk. |
| `sabotage` | Saturated pitch collapse, broken carrier and torn static. |
| `decoy` | Detuned ghost tones and a distant vowel-like noise shape. |
| `monsterDistant` | Low groan, moving noise formants, metallic scrape, long room tail. |
| `monsterNear` | Stronger breath, lower ending pitch and less reverberation. |
| `monsterScreech` | Vibrato-modulated shriek with descending formants and scrape. |
| `commandIssued` | Cold synthetic descending acknowledgement. |
| `abilityReady` | Rising low harmonic and an icy detuned confirmation. |
| `countdownTick` | Precise clock pulse with a tiny contact transient. |
| `matchStart` | Sub foundation and a dark, open harmonic swell. |
| `phaseChange` | Descending dissonant interval and filtered air. |

| StingerKind | Design |
| --- | --- |
| `victory` | A suspended minor color resolves upward into a warm major swell; about 5.8 s plus reverb. |
| `defeat` | Dissonant descending cluster, sub boom and dark decay; about 5.4 s plus reverb. |
| `breach` | Creature screech, heavy impact and static wash; about 3.15 s plus reverb. |
| `contained` | Lock clunk, secondary latch and rising confirmation into an open fifth; about 3.6 s plus reverb. |

Ambience kinds: `lobby` is a sparse, slowly breathing pad; `defender` combines 50/60 Hz mains, a fan and faint randomized relay contacts; `monster` is a deep sub bed with filtered predatory breathing; `none` fades everything on the ambience bus. Each active room also has detuned low drones and a noise floor. Increasing tension adds a double sub heartbeat, electrical whine and random static. Random creature events move closer, grow louder and lose reverb as tension rises. They are atmospheric cues, not authoritative indications of an actual monster location.

## Optional file overrides

Place a manifest at **`client/public/assets/audio/manifest.json`** (served as `/assets/audio/manifest.json`) and your files alongside it. No manifest or directory is required for synthesis. Example:

```json
{
  "sfx": { "cameraSwitch": "camera-relay.ogg", "doorClose": "steel-door.wav" },
  "stingers": { "victory": "relief.ogg" },
  "ambience": { "defender": "control-room-loop.ogg" }
}
```

Any SfxName, StingerKind or non-`none` AmbienceKind can be overridden. Paths resolve relative to `/assets/audio/`; same-origin absolute paths also work. Unknown names and external origins are ignored. Use browser-supported codecs, normalized levels and seamless ambience loops. File playback is dry to preserve authored space; procedural tension still sits under ambience files.

The manifest loads only after successful unlock. Files load/decode once on first use. A first one-shot uses synthesis while loading; later calls use the decoded file. The active ambience crossfades to its file when decoding finishes. Missing/invalid manifests, HTTP errors, unsupported codecs and decode failures silently keep synthesis. Failed files are not retried until dispose/re-unlock. Requests time out after 8 s; files are capped at 20 MiB, one-shots at 30 s and ambience at 120 s. These are client robustness limits, not an asset validation service.

## Mixing and lifetime

Four buses (`ambience`, `sfx`, `ui`, `stinger`) feed master gain, then a gentle dynamics compressor and the destination. Each bus has a convolution return using a generated stereo decaying noise impulse. Sources use scoped envelopes, filtering, stereo placement and optional saturation. Per-name repeat gates prevent chatter; a shared pool caps transient voices at 28, dropping excess requests and releasing the oldest voice. Beds are managed separately, with at most four room beds releasing across rapid switches and one tension bed.

An audio-clock silent sentinel disconnects every owned node when its voice ends, so background timer throttling cannot leave finished voices attached. Ambience uses one 100 ms scheduler, skips suspended contexts and never catches up missed events on resume. Reverb tails remain in the shared convolver, not in lingering source graphs. `dispose()` also covers suspended contexts and unfinished downloads.

Sound design parameters live in `constants.ts`, `SOUND_DESIGNS` / `CREATURE` in `sfx.ts`, `STINGER_DESIGNS` in `stingers.ts`, and `ROOM` in `ambience.ts`. `synthesis.ts` contains DSP primitives; `state.ts` contains browser-independent settings and repeat gating.

## Audition and verify

Run the existing Vite client and visit **`/audiolab.html`**. The standalone desk includes unlock/resume, persisted volume and mute, tension, room selection, stereo pan, all 26 effects and all four stingers. No Vite config changes are needed. Production builds include only configured HTML entry points; this page is intended for the dev server.

From the repository root:

```sh
node_modules/.bin/vitest run client/src/audio/__tests__
npx tsc --noEmit -p client
```

Unit tests use a minimal fake context for graph plumbing and source lifetime, not DSP fidelity. They cover SSR/autoplay gating, persistence failures, clamping, subscriptions, per-name limits, suspension/resume, all sound lifetimes, bounded crossfades and a simulated ten-minute threat schedule.

## Wiring in the game

Call unlock in an explicit join/start/audio-enable gesture, then apply the current room and tension. Map UI/server game events to `play` and authoritative outcomes to `playStinger`; do not infer gameplay from the randomized ambient creature cues. Subscribe settings controls to volume/mute changes and unsubscribe on unmount. Fade ambience to `none` when leaving a match. Keep the singleton across route changes; dispose only when intentionally tearing down audio.
