// Technical-access probes for Caltrans snapshot + HLS URLs. Zero dependencies.
// Polite by design: GET only, one request at a time per caller, segment body read is capped at 64 KiB.
export const ORIGIN = 'http://localhost:5173';
const UA = 'fnab-camera-research/1.0 (hackathon game; polite, low-rate)';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, { maxBytes = 0, timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, origin: ORIGIN, accept: '*/*' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    let body = new Uint8Array(0);
    if (maxBytes > 0 && res.body) {
      const reader = res.body.getReader();
      const chunks = [];
      let n = 0;
      while (n < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        n += value.length;
      }
      try { await reader.cancel(); } catch {}
      body = Buffer.concat(chunks);
    } else {
      body = new Uint8Array(await res.arrayBuffer());
    }
    return { ok: res.ok, status: res.status, headers: res.headers, body };
  } finally {
    clearTimeout(timer);
  }
}

/** CORS usable by an <img crossOrigin>/canvas read or XHR from ORIGIN? */
export function corsAllows(headers) {
  const v = headers.get('access-control-allow-origin');
  return v === '*' || v === ORIGIN;
}

const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Parse width/height from a JPEG's SOF marker. */
export function jpegDims(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    }
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}

/**
 * Caltrans serves a "Temporarily Unavailable" JPEG (white card, 320x260, ~13.4 KB, with a fresh
 * timestamp bar) with HTTP 200 and a fresh Last-Modified when a camera feed is down. Detect it by size band.
 */
export const PLACEHOLDER_MIN_BYTES = 13300;
export const PLACEHOLDER_MAX_BYTES = 13700;
export function looksLikePlaceholder(bytes) {
  return bytes >= PLACEHOLDER_MIN_BYTES && bytes <= PLACEHOLDER_MAX_BYTES;
}

export async function probeImage(url) {
  if (!url) return { http: null, cors: null, error: 'no url' };
  try {
    const r = await get(url, { maxBytes: 2_000_000 });
    const lm = r.headers.get('last-modified');
    const ageMin = lm ? Math.round((Date.now() - new Date(lm).getTime()) / 60000) : null;
    return {
      http: r.status,
      contentType: r.headers.get('content-type'),
      bytes: r.body.length,
      jpeg: isJpeg(r.body),
      dims: isJpeg(r.body) ? jpegDims(r.body) : null,
      placeholder: r.ok && looksLikePlaceholder(r.body.length),
      lastModified: lm,
      ageMin,
      cors: corsAllows(r.headers),
      acao: r.headers.get('access-control-allow-origin'),
      body: r.body,
    };
  } catch (e) {
    return { http: null, cors: null, error: String(e.message || e) };
  }
}

export async function probeStream(url) {
  if (!url) return { http: null, cors: null, error: 'no url' };
  const out = { http: null, cors: null, playlist: null, segmentHttp: null, segmentCors: null };
  try {
    const m = await get(url, { maxBytes: 100_000 });
    out.http = m.status;
    out.cors = corsAllows(m.headers);
    out.acao = m.headers.get('access-control-allow-origin');
    out.contentType = m.headers.get('content-type');
    if (!m.ok) return out;
    const text = Buffer.from(m.body).toString('utf8');
    if (!text.startsWith('#EXTM3U')) { out.error = 'not an m3u8'; return out; }
    out.playlist = 'master';
    let mediaUrl = url, mediaText = text;
    if (/#EXT-X-STREAM-INF/.test(text)) {
      const rel = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      mediaUrl = new URL(rel, url).toString();
      await sleep(250);
      const c = await get(mediaUrl, { maxBytes: 100_000 });
      out.chunklistHttp = c.status;
      out.chunklistCors = corsAllows(c.headers);
      mediaText = Buffer.from(c.body).toString('utf8');
    } else out.playlist = 'media';
    const seg = mediaText.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (!seg) { out.error = 'no segment in playlist'; return out; }
    const segUrl = new URL(seg, mediaUrl).toString();
    await sleep(250);
    const s = await get(segUrl, { maxBytes: 65536 });
    out.segmentHttp = s.status;
    out.segmentCors = corsAllows(s.headers);
    out.segmentType = s.headers.get('content-type');
    out.segmentBytesRead = s.body.length;
    out.segmentMpegTs = s.body.length > 0 && s.body[0] === 0x47;
    out.live = !/#EXT-X-ENDLIST/.test(mediaText);
    return out;
  } catch (e) {
    out.error = String(e.message || e);
    return out;
  }
}

/** Run async fn over items with limited concurrency and a small delay per worker. */
export async function pool(items, fn, { concurrency = 3, delayMs = 150 } = {}) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        results[idx] = await fn(items[idx], idx);
        await sleep(delayMs);
      }
    }),
  );
  return results;
}
