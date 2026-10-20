import { audio, STINGER_KINDS, type AmbienceKind, type SfxName, type StingerKind } from '../index';

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Audio lab element missing: ${id}`);
  return found as T;
};
const unlock = element<HTMLButtonElement>('unlock');
const volume = element<HTMLInputElement>('volume');
const muted = element<HTMLInputElement>('muted');
const tension = element<HTMLInputElement>('tension');
const pan = element<HTMLInputElement>('pan');
const ambience = element<HTMLSelectElement>('ambience');
const status = element<HTMLParagraphElement>('status');
const soundButtons: HTMLButtonElement[] = [];

const GROUPS: { title: string; sounds: [SfxName, string][] }[] = [
  { title: 'Surveillance & systems', sounds: [
    ['cameraSwitch', 'Relay contact and a brief static blip'], ['staticBurst', 'Band-limited signal interference'],
    ['scanPing', 'Descending sonar with a distant reflection'], ['sensorPing', 'Two clear motion-detection tones'],
    ['repairStart', 'Diagnostic startup and contact click'], ['repairDone', 'Clean fifth: signal restored'],
    ['powerLow', 'Three restrained warning beeps'], ['powerOut', 'Electrical rundown and a final thunk'],
    ['alarm', 'Three short klaxon cycles'], ['sabotage', 'Distorted signal tearing apart'],
  ] },
  { title: 'Heavy mechanisms', sounds: [
    ['doorClose', 'Hydraulics, sliding steel, heavy latch'], ['doorOpen', 'Latch release and a rising hydraulic motor'],
    ['doorBlocked', 'A muffled blow against sheet metal'], ['trapArm', 'Spring tension and a status chirp'],
    ['trapTrigger', 'Steel jaws, a sub impact, resonant ringing'],
  ] },
  { title: 'The creature', sounds: [
    ['monsterDistant', 'Reverberant groan and a thin metallic scrape'], ['monsterNear', 'Close breath and a throaty formant growl'],
    ['monsterScreech', 'Unstable pitched shriek, restrained highs'], ['decoy', 'A ghostly, detuned imitation'],
    ['commandIssued', 'Cold descending command acknowledgement'], ['abilityReady', 'An icy rising harmonic'],
  ] },
  { title: 'Interface & match', sounds: [
    ['uiClick', 'Soft tactile switch'], ['uiHover', 'A barely audible electronic tick'],
    ['countdownTick', 'Short, precise clock pulse'], ['matchStart', 'Low cinematic opening signal'],
    ['phaseChange', 'Descending tension marker'],
  ] },
];
const STINGER_NOTES: Record<StingerKind, string> = {
  victory: 'A suspended harmony resolves into a relieved swell', defeat: 'Dissonant cluster, sub boom, long dark decay',
  breach: 'Creature shriek, structural impact, three-second static wash', contained: 'Heavy lock clunk and rising confirmation',
};

function makeButton(name: string, description: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sound';
  button.disabled = true;
  const title = document.createElement('span');
  title.textContent = name;
  const detail = document.createElement('span');
  detail.textContent = description;
  button.append(title, detail);
  button.addEventListener('click', () => {
    if (!audio.isUnlocked()) {
      status.textContent = 'Audio is suspended. Use Resume audio to continue.';
      unlock.textContent = 'Resume audio';
      return;
    }
    action();
    status.textContent = `Playing ${name}${audio.isMuted() ? ' (master muted)' : ''}.`;
  });
  soundButtons.push(button);
  return button;
}

const soundRoot = element<HTMLDivElement>('sounds');
for (const group of GROUPS) {
  const section = document.createElement('section');
  const title = document.createElement('h2');
  title.textContent = group.title;
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const [name, note] of group.sounds) grid.append(makeButton(name, note, () => audio.play(name, { pan: Number(pan.value) })));
  section.append(title, grid);
  soundRoot.append(section);
}
for (const kind of STINGER_KINDS) {
  element('stingers').append(makeButton(kind, STINGER_NOTES[kind], () => audio.playStinger(kind)));
}

const percentage = (value: number): string => `${Math.round(value * 100)}%`;
function syncSettings(): void {
  volume.value = String(audio.getMasterVolume());
  muted.checked = audio.isMuted();
  element<HTMLOutputElement>('volume-value').value = percentage(audio.getMasterVolume());
}
syncSettings();
const unsubscribe = audio.subscribe(syncSettings);
volume.addEventListener('input', () => audio.setMasterVolume(Number(volume.value)));
muted.addEventListener('change', () => audio.setMuted(muted.checked));
tension.addEventListener('input', () => {
  audio.setTension(Number(tension.value));
  element<HTMLOutputElement>('tension-value').value = percentage(Number(tension.value));
});
pan.addEventListener('input', () => {
  const value = Number(pan.value);
  element<HTMLOutputElement>('pan-value').value = value === 0 ? 'Center' : `${Math.round(Math.abs(value) * 100)}% ${value < 0 ? 'L' : 'R'}`;
});
ambience.addEventListener('change', () => audio.setAmbience(ambience.value as AmbienceKind));
unlock.addEventListener('click', async () => {
  await audio.unlock();
  const ready = audio.isUnlocked();
  unlock.dataset.ready = String(ready);
  unlock.textContent = ready ? 'Audio unlocked / resume' : 'Retry unlock';
  status.textContent = ready ? 'Audio running. Select any sound to audition.' : 'Audio unavailable or blocked in this browser.';
  soundButtons.forEach(button => { button.disabled = !ready; });
  if (ready) {
    audio.setAmbience(ambience.value as AmbienceKind);
    audio.setTension(Number(tension.value));
  }
});
window.addEventListener('pagehide', event => {
  if (!event.persisted) { unsubscribe(); audio.dispose(); }
});
