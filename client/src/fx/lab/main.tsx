import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Lab } from './Lab';

document.body.style.margin = '0';
document.body.style.background = '#050607';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Lab />
  </StrictMode>,
);
