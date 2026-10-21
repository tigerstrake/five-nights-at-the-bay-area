import { DEFAULT_CONFIG, type BalanceConfig } from '@fnab/shared';

/** Wall-time token bucket: simulation acceleration never grants additional network budget. */
export class TokenBucket {
  private tokens: number;
  private at: number;
  constructor(readonly burst: number, readonly perSecond: number, now: number) {
    this.tokens = burst;
    this.at = now;
  }
  available(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + Math.max(0, now - this.at) * this.perSecond / 1000);
    this.at = Math.max(this.at, now);
    return this.tokens >= 1;
  }
  take(now: number): boolean {
    if (!this.available(now)) return false;
    this.tokens--;
    return true;
  }
}

export function networkLimits(cfg: BalanceConfig, env: NodeJS.ProcessEnv = process.env): NonNullable<BalanceConfig['net']> {
  const defaults = DEFAULT_CONFIG.net!;
  const out = { ...defaults, ...cfg.net };
  // Opt-in test hooks only. Production cannot disable its budgets with this environment variable.
  const requested = Number(env.FNAB_RATE_LIMIT_MULTIPLIER ?? 1);
  const multiplier = env.FNAB_TEST_HOOKS === '1' && Number.isFinite(requested) ? Math.max(1, Math.min(1000, requested)) : 1;
  for (const key of Object.keys(out) as Array<keyof typeof out>) {
    if (!Number.isFinite(out[key]) || out[key] <= 0) out[key] = defaults[key];
    if (key.endsWith('Burst') || key.endsWith('PerSecond')) out[key] *= multiplier;
  }
  return out;
}
