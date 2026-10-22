// Draws the toolbar icon as a ring filled to the current percentage.

const COLORS = { ok: '#43b06a', warn: '#e0a526', crit: '#e5484d' };
const TRACK = 'rgba(128, 134, 145, 0.45)';

function ring(size, pct, color) {
  const canvas = new OffscreenCanvas(size, size);
  const g = canvas.getContext('2d');
  const line = Math.max(2.5, size * 0.2);
  const r = size / 2 - line / 2 - size * 0.03;
  const c = size / 2;
  g.lineWidth = line;
  g.lineCap = 'round';
  g.strokeStyle = TRACK;
  g.beginPath();
  g.arc(c, c, r, 0, 2 * Math.PI);
  g.stroke();
  if (pct > 0) {
    g.strokeStyle = color;
    g.beginPath();
    g.arc(c, c, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.min(pct, 100) / 100);
    g.stroke();
  }
  return g.getImageData(0, 0, size, size);
}

export function ringIcon(pct, lv) {
  const color = COLORS[lv] || COLORS.ok;
  return { 16: ring(16, pct, color), 32: ring(32, pct, color) };
}
