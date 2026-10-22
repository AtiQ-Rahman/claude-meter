// Last-7-days chart of session and weekly usage, drawn as inline SVG from the stored timeline.

const W = 600;
const H = 200;
const PAD = { top: 10, right: 12, bottom: 24, left: 34 };
const DAY = 24 * 60 * 60 * 1000;
const GAP = 60 * 60 * 1000; // break the line where readings are missing for over an hour
const SERIES = [['s', 's1', 'Session'], ['w', 's2', 'Week']];
const NS = 'http://www.w3.org/2000/svg';

const svg = document.getElementById('chart-svg');
const tip = document.getElementById('chart-tip');

function node(tag, attrs, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

function pathFor(points, key, x, y) {
  let d = '';
  let prev = null;
  for (const p of points) {
    if (p[key] == null) { prev = null; continue; }
    const cmd = prev && p.t - prev.t <= GAP ? 'L' : 'M';
    d += `${cmd}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`;
    prev = p;
  }
  return d;
}

function renderTable(points) {
  const days = new Map();
  for (const p of points) {
    const day = new Date(p.t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const cur = days.get(day) || { s: null, w: null };
    if (p.s != null) cur.s = Math.max(cur.s ?? 0, p.s);
    if (p.w != null) cur.w = p.w;
    days.set(day, cur);
  }
  const body = document.querySelector('#chart-table tbody');
  body.replaceChildren();
  for (const [day, v] of days) {
    const tr = document.createElement('tr');
    for (const text of [day, v.s == null ? '-' : `${v.s}%`, v.w == null ? '-' : `${v.w}%`]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    body.append(tr);
  }
}

async function render() {
  const { timeline = [] } = await chrome.storage.local.get('timeline');
  const now = Date.now();
  const points = timeline.filter(p => now - p.t <= 7 * DAY);
  document.getElementById('chart-empty').hidden = points.length >= 2;
  svg.replaceChildren();
  renderTable(points);

  const x0 = now - 7 * DAY;
  const x = t => PAD.left + ((t - x0) / (7 * DAY)) * (W - PAD.left - PAD.right);
  const y = v => PAD.top + (1 - v / 100) * (H - PAD.top - PAD.bottom);

  for (const v of [0, 50, 100]) {
    svg.append(node('line', { class: 'grid', x1: PAD.left, x2: W - PAD.right, y1: y(v), y2: y(v) }));
    svg.append(node('text', { class: 'axis', x: PAD.left - 6, y: y(v) + 3, 'text-anchor': 'end' }, `${v}%`));
  }
  for (let i = 6; i >= 0; i--) {
    const t = now - i * DAY;
    const label = new Date(t).toLocaleDateString(undefined, { weekday: 'short' });
    svg.append(node('text', { class: 'axis', x: x(t), y: H - 6, 'text-anchor': i === 0 ? 'end' : 'middle' }, label));
  }
  for (const [key, cls] of SERIES) {
    svg.append(node('path', { class: `line ${cls}`, d: pathFor(points, key, x, y) }));
  }

  // Hover: crosshair and tooltip at the nearest reading.
  const cross = node('line', { class: 'cross', y1: PAD.top, y2: H - PAD.bottom, visibility: 'hidden' });
  const dots = SERIES.map(([, cls]) => node('circle', { class: `dot ${cls}`, r: 4, visibility: 'hidden' }));
  svg.append(cross, ...dots);
  const hit = node('rect', { x: PAD.left, y: 0, width: W - PAD.left - PAD.right, height: H, fill: 'transparent' });
  svg.append(hit);

  hit.addEventListener('pointermove', e => {
    if (points.length === 0) return;
    const box = svg.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * W;
    const p = points.reduce((a, b) => (Math.abs(x(b.t) - sx) < Math.abs(x(a.t) - sx) ? b : a));
    cross.setAttribute('x1', x(p.t));
    cross.setAttribute('x2', x(p.t));
    cross.setAttribute('visibility', 'visible');
    SERIES.forEach(([key], i) => {
      const show = p[key] != null;
      dots[i].setAttribute('visibility', show ? 'visible' : 'hidden');
      if (show) {
        dots[i].setAttribute('cx', x(p.t));
        dots[i].setAttribute('cy', y(p[key]));
      }
    });
    const when = new Date(p.t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    tip.textContent = `${when}\nSession ${p.s ?? '-'}%  ·  Week ${p.w ?? '-'}%`;
    tip.style.whiteSpace = 'pre';
    tip.hidden = false;
    const px = (x(p.t) / W) * box.width;
    tip.style.left = `${Math.min(px + 12, box.width - tip.offsetWidth)}px`;
    tip.style.top = '28px';
  });
  hit.addEventListener('pointerleave', () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    dots.forEach(d => d.setAttribute('visibility', 'hidden'));
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.timeline) render();
});
render();
