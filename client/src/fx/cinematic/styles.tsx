// Keyframes for cinematic typography. Injected inline so the FX module has no CSS dependency.
const CSS = `
@keyframes fx-cine-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes fx-cine-title {
  0% { opacity: 0; letter-spacing: 0.46em; filter: blur(6px); }
  12% { opacity: 0.6; }
  14% { opacity: 0.15; }
  30% { opacity: 1; filter: blur(0.6px); }
  100% { opacity: 1; letter-spacing: 0.3em; filter: blur(0); }
}
@keyframes fx-cine-rule { from { transform: scaleX(0); opacity: 0; } to { transform: scaleX(1); opacity: 1; } }
@keyframes fx-cine-type { 0% { opacity: 0; transform: translateY(0.3em); } 30% { opacity: 0.9; } 38% { opacity: 0.35; } 100% { opacity: 1; transform: none; } }
.fx-cine .fx-cine-fade { opacity: 0; animation: fx-cine-fade 700ms ease-out both; }
.fx-cine .fx-cine-title { opacity: 0; white-space: nowrap; letter-spacing: 0.3em; padding-left: 0.3em; animation: fx-cine-title 2200ms cubic-bezier(.2,.7,.2,1) both; }
.fx-cine .fx-cine-rule { opacity: 0; animation: fx-cine-rule 900ms cubic-bezier(.2,.7,.2,1) both; }
.fx-cine .fx-cine-type { opacity: 0; white-space: nowrap; animation: fx-cine-type 520ms ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .fx-cine .fx-cine-title { animation-name: fx-cine-fade; animation-duration: 900ms; }
  .fx-cine .fx-cine-type { animation-name: fx-cine-fade; animation-timing-function: ease-out; }
}
`;

export function CinematicStyles() {
  return <style>{CSS}</style>;
}
