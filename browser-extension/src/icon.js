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

// The plain logo, loaded once as image data. setIcon({ path }) fetches the file
// itself and fails in some browsers (seen in Brave), so we fetch it ourselves.
let staticIcon = null;

async function load(size) {
  const blob = await (await fetch(chrome.runtime.getURL(`icons/${size}.png`))).blob();
  const bitmap = await createImageBitmap(blob);
  const g = new OffscreenCanvas(size, size).getContext('2d');
  g.drawImage(bitmap, 0, 0, size, size);
  return g.getImageData(0, 0, size, size);
}

export async function staticIconData() {
  staticIcon ??= Promise.all([load(16), load(32)])
    .then(([a, b]) => ({ 16: a, 32: b }))
    .catch(e => { staticIcon = null; throw e; });
  return staticIcon;
}
