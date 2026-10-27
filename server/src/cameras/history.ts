import type { CameraRecord } from '@fnab/shared';

export const D4_STATUS_URL = 'https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json';

/** Only published URLs belonging to this exact index AND current image. Never guess history filenames. */
export function publishedHistory(data: unknown, camera: CameraRecord): string[] {
  const rows = (data as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(rows)) return [];
  for (const row of rows) {
    const c = (row as { cctv?: { index?: unknown; imageData?: { static?: Record<string, unknown> } } })?.cctv;
    const st = c?.imageData?.static;
    if (String(c?.index) !== camera.caltransIndex || st?.currentImageURL !== camera.imageUrl) continue;
    return Array.from({ length: 12 }, (_, i) => st[`referenceImage${i + 1}`])
      .filter((v): v is string => typeof v === 'string' && /^https?:\/\//.test(v));
  }
  return [];
}

/** A published reference may be on the provider's CDN, but never follow an arbitrary host from metadata. */
export function trustedHistoryUrls(urls: string[], camera: CameraRecord): string[] {
  if (!camera.imageUrl) return [];
  const current = new URL(camera.imageUrl);
  return [...new Set(urls)].filter(url => {
    try {
      const u = new URL(url);
      return u.origin === current.origin && !u.username && !u.password && u.pathname !== current.pathname;
    } catch { return false; }
  }).slice(0, 12);
}
