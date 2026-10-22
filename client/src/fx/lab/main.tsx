import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../fonts';
import { Lab } from './Lab';
import { RealLab } from './RealLab';

document.body.style.margin = '0';
document.body.style.background = '#050607';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {new URLSearchParams(window.location.search).get('real') === '1' ? <RealLab /> : <Lab />}
  </StrictMode>,
);
