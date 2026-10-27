/** Solar elevation (degrees) at a lat/lon for an epoch time (NOAA approximation, ±0.5°). Bay Area by default. */
export function sunElevationDeg(epochMs: number, lat = 37.8, lon = -122.3): number {
  const d = new Date(epochMs);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const doy = Math.floor((epochMs - start) / 86400000) + 1;
  const hrs = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const g = ((2 * Math.PI) / 365) * (doy - 1 + (hrs - 12) / 24);
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const tst = hrs * 60 + eqt + 4 * lon; // true solar time, minutes
  const ha = ((tst / 4 - 180) * Math.PI) / 180;
  const la = (lat * Math.PI) / 180;
  const cosZ = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha);
  return 90 - (Math.acos(Math.max(-1, Math.min(1, cosZ))) * 180) / Math.PI;
}

export type TimeOfDay = 'day' | 'dusk' | 'night';
/** Wide twilight band prevents a hard switch at sunset/sunrise. */
export function timeOfDayAt(epochMs: number, lat = 37.8, lon = -122.3): TimeOfDay {
  const elevation = sunElevationDeg(epochMs, lat, lon);
  return elevation > 6 ? 'day' : elevation < -6 ? 'night' : 'dusk';
}
