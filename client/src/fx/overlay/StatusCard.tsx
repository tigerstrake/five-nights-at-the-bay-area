// Crisp DOM typography for feed states (canvas handles the picture, DOM handles the words).
import type { CSSProperties } from 'react';
import type { FeedFxParams } from '../index';
import { FX_FONT_MONO } from '../core/fonts';

interface Props {
  params: FeedFxParams;
  lostVisible: boolean;
}

const center: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.6em',
  fontFamily: FX_FONT_MONO,
  textTransform: 'uppercase',
  textAlign: 'center',
  fontSize: 'clamp(8px, 3.4cqw, 20px)',
  letterSpacing: '0.28em',
  lineHeight: 1.2,
};

function Card({ title, sub, color, frame }: { title: string; sub?: string; color: string; frame?: string }) {
  return (
    <div style={center}>
      <div
        style={{
          color,
          fontWeight: 600,
          padding: '0.45em 0.9em 0.45em 1.18em',
          border: frame ? `1px solid ${frame}` : undefined,
          background: 'rgba(0,0,0,0.35)',
          textShadow: `0 0 0.6em ${color}55`,
        }}
      >
        {title}
      </div>
      {sub ? <div style={{ color: '#6f7a82', fontSize: '0.62em', letterSpacing: '0.24em' }}>{sub}</div> : null}
    </div>
  );
}

export function StatusCard({ params, lostVisible }: Props) {
  const main = params.variant === 'main';
  if (params.sourceMode === 'offline') {
    return <Card title="Camera offline" sub={main ? 'Source unavailable · not a game event' : undefined} color="#9aa3aa" frame="#3a4148" />;
  }
  switch (params.gameStatus) {
    case 'blackout':
      return <Card title="No signal" sub={main ? 'Video loss' : undefined} color="#cfd5da" />;
    case 'sabotaged':
      return lostVisible ? <Card title="Signal lost" sub={main ? 'Feed interrupted' : undefined} color="#d0464c" frame="#5a1a1e" /> : null;
    case 'repairing': {
      const q = Math.max(0, Math.min(1, params.repairProgress ?? 0));
      const pct = Math.round(q * 100);
      const cells = main ? 24 : 12;
      const on = Math.round(q * cells);
      return (
        <div style={{ ...center, justifyContent: 'flex-end', paddingBottom: '9%' }}>
          <div
            style={{
              color: '#5fd6c8',
              background: 'rgba(2,8,9,0.6)',
              padding: '0.4em 0.8em',
              letterSpacing: '0.2em',
              fontSize: '0.8em',
              display: 'flex',
              alignItems: 'center',
              gap: '0.8em',
              textShadow: '0 0 0.5em rgba(95,214,200,0.35)',
            }}
          >
            <span>{q >= 0.97 ? 'Sync lock' : 'Re-sync'}</span>
            <span style={{ display: 'flex', gap: '0.12em' }}>
              {Array.from({ length: cells }, (_, i) => (
                <span
                  key={i}
                  style={{
                    width: '0.38em',
                    height: '0.9em',
                    background: i < on ? '#5fd6c8' : 'rgba(95,214,200,0.16)',
                  }}
                />
              ))}
            </span>
            <span style={{ minWidth: '3.2em', textAlign: 'right' }}>{pct}%</span>
          </div>
        </div>
      );
    }
    default:
      return null;
  }
}
