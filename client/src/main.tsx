import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { useGame } from './state/store';

// Dev/e2e hook: expose the store for scripted tests (never relied on by game logic).
if (import.meta.env.DEV || new URLSearchParams(location.search).has('e2e'))
  (window as unknown as { __fnab: typeof useGame }).__fnab = useGame;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
