export function lightPixels(mode: 'day' | 'night' | 'dusk' | 'floodlit' | 'saturated') {
  const width = 320, height = 240;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const top = y < height * 0.35;
    let rgb = mode === 'day' ? (top ? [145, 185, 215] : [95 + y / 4, 100 + y / 4, 100 + y / 4]) :
      mode === 'dusk' ? (top ? [95, 75, 100] : [70, 60, 75]) :
      mode === 'saturated' ? [10, 160, 250] :
      mode === 'floodlit' ? (top ? [20, 22, 25] : [170, 155, 140]) :
      (top ? [18, 21, 25] : [25 + y / 20, 27 + y / 20, 30 + y / 20]);
    if ((mode === 'night' || mode === 'floodlit') && y > 130 && y < 135 && (x > 50 && x < 55 || x > 220 && x < 225)) rgb = [255, 250, 240];
    data.set([...rgb, 255], (y * width + x) * 4);
  }
  return { data, width, height };
}

