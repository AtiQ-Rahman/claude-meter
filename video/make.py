#!/usr/bin/env python3
"""Explainer video for Usage Meter for Claude: frames with PIL, audio with numpy, muxed with ffmpeg."""
import math, os, subprocess, sys, wave
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

REPO = "/home/atiq/Projects/claude-usage"
OUT = os.path.dirname(os.path.abspath(__file__))
W, H, FPS = 1920, 1080, 30
SR = 44100
FONT = "/usr/share/fonts/truetype/ubuntu/Ubuntu-{}.ttf"

BG = (22, 22, 24)
FG = (240, 238, 234)
MUTED = (160, 158, 152)
ORANGE = (217, 119, 87)
GREEN = (108, 192, 112)
YELLOW = (229, 192, 74)
RED = (224, 90, 79)

# ---------------------------------------------------------------- helpers
def clamp(x, a=0.0, b=1.0): return max(a, min(b, x))
def ease_out(x): x = clamp(x); return 1 - (1 - x) ** 3
def ease_back(x):
    x = clamp(x); c1 = 1.70158; c3 = c1 + 1
    return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2
def prog(t, start, dur=0.5): return clamp((t - start) / dur)

_fonts = {}
def font(size, weight="M"):
    k = (size, weight)
    if k not in _fonts: _fonts[k] = ImageFont.truetype(FONT.format(weight), size)
    return _fonts[k]

_text = {}
def text_img(s, size, color=FG, weight="M"):
    k = (s, size, color, weight)
    if k not in _text:
        f = font(size, weight)
        l, t, r, b = f.getbbox(s)
        im = Image.new("RGBA", (r - l + 8, b - t + 8 + size // 5), (0, 0, 0, 0))
        ImageDraw.Draw(im).text((4 - l, 4 - t), s, font=f, fill=color)
        _text[k] = im
    return _text[k]

def paste(canvas, im, x, y, op=1.0, anchor="c", scale=1.0):
    if op <= 0.003: return
    if scale != 1.0:
        im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))), Image.BILINEAR)
    if anchor == "c": x, y = x - im.width / 2, y - im.height / 2
    elif anchor == "l": y = y - im.height / 2
    x, y = int(round(x)), int(round(y))
    if op < 1.0:
        im = im.copy()
        im.putalpha(im.getchannel("A").point(lambda v: int(v * op)))
    # crop to canvas
    cx0, cy0 = max(0, -x), max(0, -y)
    cx1, cy1 = min(im.width, W - x), min(im.height, H - y)
    if cx1 <= cx0 or cy1 <= cy0: return
    if (cx0, cy0, cx1, cy1) != (0, 0, im.width, im.height):
        im = im.crop((cx0, cy0, cx1, cy1))
    canvas.alpha_composite(im, (x + cx0, y + cy0))

def rounded(im, radius=18, shadow=True, border=(70, 70, 74)):
    im = im.convert("RGBA")
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, im.width - 1, im.height - 1), radius, fill=255)
    im.putalpha(mask)
    ImageDraw.Draw(im).rounded_rectangle((0, 0, im.width - 1, im.height - 1), radius, outline=border, width=2)
    if not shadow: return im
    pad = 50
    out = Image.new("RGBA", (im.width + pad * 2, im.height + pad * 2), (0, 0, 0, 0))
    sh = Image.new("RGBA", out.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((pad, pad + 14, pad + im.width, pad + im.height + 14), radius, fill=(0, 0, 0, 170))
    out.alpha_composite(sh.filter(ImageFilter.GaussianBlur(22)))
    out.alpha_composite(im, (pad, pad))
    return out

def shot(path, scale):
    im = Image.open(os.path.join(REPO, path)).convert("RGBA")
    im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
    return rounded(im)

def make_bg():
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    d = np.sqrt(((x - W * 0.5) / W) ** 2 + ((y - H * 0.42) / H) ** 2)
    glow = np.exp(-(d / 0.45) ** 2)
    base = np.array(BG, np.float32)
    tint = np.array([60, 34, 26], np.float32)
    arr = base + glow[..., None] * tint
    arr *= (1 - 0.35 * clamp_arr(d - 0.35))[..., None]
    return Image.fromarray(arr.clip(0, 255).astype(np.uint8)).convert("RGBA")

def clamp_arr(a): return np.clip(a, 0, 1)

def ring(pct, size=360, width=40):
    s = 2
    im = Image.new("RGBA", (size * s, size * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    w = width * s; pad = w // 2 + 4
    box = (pad, pad, size * s - pad, size * s - pad)
    d.ellipse((pad - w // 2, pad - w // 2, size * s - pad + w // 2, size * s - pad + w // 2), outline=(58, 58, 62), width=w)
    col = GREEN if pct < 80 else YELLOW if pct < 90 else RED
    if pct > 0.3:
        start, end = -90, -90 + 360 * pct / 100
        d.arc((pad - w // 2, pad - w // 2, size * s - pad + w // 2, size * s - pad + w // 2), start, end, fill=col, width=w)
        r = (size * s - 2 * pad) / 2; c = size * s / 2
        for a in (start, end):
            ax = c + r * math.cos(math.radians(a)); ay = c + r * math.sin(math.radians(a))
            d.ellipse((ax - w / 2, ay - w / 2, ax + w / 2, ay + w / 2), fill=col)
    return im.resize((size, size), Image.LANCZOS), col

def card(title, body, color, w=640):
    h = 128
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, w - 1, h - 1), 18, fill=(40, 40, 44, 255), outline=(72, 72, 78), width=2)
    d.rounded_rectangle((0, 0, 12, h - 1), 6, fill=color)
    icon = Image.open(os.path.join(REPO, "browser-extension/icons/48.png")).convert("RGBA").resize((56, 56), Image.LANCZOS)
    im.alpha_composite(icon, (34, 36))
    d.text((112, 26), title, font=font(32, "M"), fill=FG)
    d.text((112, 72), body, font=font(26, "R"), fill=MUTED)
    return rounded(im, 18, shadow=True, border=(72, 72, 78))

def pill(label, color, size=34):
    t = text_img(label, size, color, "M")
    im = Image.new("RGBA", (t.width + 48, t.height + 24), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle((0, 0, im.width - 1, im.height - 1), im.height // 2, fill=(255, 255, 255, 18), outline=color, width=2)
    im.alpha_composite(t, (24, 12))
    return im

# ---------------------------------------------------------------- assets
BGIMG = make_bg()
ICON = Image.open(os.path.join(REPO, "browser-extension/icons/128.png")).convert("RGBA").resize((220, 220), Image.LANCZOS)
POPUP = shot("browser-extension/screenshots/popup.png", 2.1)
HIST = shot("browser-extension/screenshots/settings-history.png", 1.25)
SETT = shot("browser-extension/screenshots/settings.png", 1.25)
GNOME = shot("screenshot.png", 1.75)
CARDS = [
    card("Session at 80%", "Heads up, you've used most of it", YELLOW),
    card("Session at 90%", "Stays on screen until you dismiss it", RED),
    card("Session at 96%", "An alert on every percent from 95%", RED),
    card("Session limit reset", "You're back to 0%. Keep going!", GREEN),
]

# ---------------------------------------------------------------- scenes
# each scene: (duration, draw(canvas, t))
def caption(c, t, s, start=0.0, y=140, size=64, color=FG, weight="B"):
    p = ease_out(prog(t, start, 0.6))
    paste(c, text_img(s, size, color, weight), W / 2, y + (1 - p) * 30, p)

def s_title(c, t):
    p = ease_back(prog(t, 0.2, 0.7))
    paste(c, ICON, W / 2, 400, clamp(p), scale=0.3 + 0.7 * p)
    p2 = ease_out(prog(t, 0.9, 0.7))
    paste(c, text_img("Usage Meter for Claude", 96, FG, "B"), W / 2, 620 + (1 - p2) * 30, p2)
    p3 = ease_out(prog(t, 1.5, 0.7))
    paste(c, text_img("Know your Claude limits before you hit them.", 44, MUTED, "R"), W / 2, 715 + (1 - p3) * 20, p3)

def s_problem(c, t):
    caption(c, t, "You're deep in a conversation with Claude...", 0.2, 420, 60, FG, "M")
    p = ease_back(prog(t, 2.0, 0.45))
    if t > 2.0:
        b = Image.new("RGBA", (900, 120), (0, 0, 0, 0))
        ImageDraw.Draw(b).rounded_rectangle((0, 0, 899, 119), 22, fill=(70, 30, 28, 255), outline=RED, width=3)
        tx = text_img("You've hit your usage limit", 50, (255, 200, 192), "B")
        b.alpha_composite(tx, ((900 - tx.width) // 2, (120 - tx.height) // 2 + 4))
        shake = math.sin(t * 60) * 10 * max(0, 1 - (t - 2.0) / 0.4)
        paste(c, b, W / 2 + shake, 600, clamp(p), scale=0.6 + 0.4 * p)
    caption(c, t, "...with no warning.", 3.0, 760, 46, MUTED, "R")

RING_T0, RING_DUR = 1.0, 4.6
def ring_pct(t):
    x = prog(t, RING_T0, RING_DUR)
    return 92 * (1 - (1 - x) ** 1.6)

def s_ring(c, t):
    caption(c, t, "A live usage ring in your toolbar", 0.0, 150)
    pct = ring_pct(t)
    im, col = ring(pct, 420, 46)
    p = ease_back(prog(t, 0.3, 0.6))
    paste(c, im, W / 2, 560, clamp(p), scale=0.5 + 0.5 * p)
    num = text_img(f"{int(round(pct))}%", 110, col, "B")
    paste(c, num, W / 2, 545, clamp(p))
    paste(c, text_img("Session", 34, MUTED, "R"), W / 2, 625, clamp(p))
    for i, (lab, cl, at) in enumerate([("Green: plenty left", GREEN, 0), ("Yellow at 80%", YELLOW, 80), ("Red at 90%", RED, 90)]):
        shown = pct >= at and t > 0.8
        if shown:
            # time when crossed
            pp = 1.0 if at == 0 else 1.0
            paste(c, pill(lab, cl), W / 2 + (i - 1) * 400, 900, 1.0 if at == 0 else ease_out(prog(pct, at, 3)))

def s_popup(c, t):
    caption(c, t, "Click it for the full picture", 0.0, 120)
    p = ease_out(prog(t, 0.3, 0.7))
    paste(c, POPUP, 560 - (1 - p) * 200, 590, p)
    items = [
        ("Session (5-hour) and weekly limits", 0.9),
        ("Messages left at your usual size", 1.7),
        ("Pace forecast: when you'll hit 100%", 2.5),
        ("Exact reset times", 3.3),
        ("A small meter right on claude.ai", 4.1),
    ]
    for i, (s, st) in enumerate(items):
        q = ease_out(prog(t, st, 0.5))
        y = 380 + i * 100
        dot = Image.new("RGBA", (26, 26), (0, 0, 0, 0)); ImageDraw.Draw(dot).ellipse((0, 0, 25, 25), fill=ORANGE)
        paste(c, dot, 1010 + (1 - q) * 60, y, q)
        paste(c, text_img(s, 44, FG, "M"), 1050 + (1 - q) * 60, y, q, anchor="l")

ALERT_TIMES = [0.6, 1.6, 2.6, 4.0]
def s_alerts(c, t):
    caption(c, t, "Alerts with sound, before you run out", 0.0, 140)
    for i, st in enumerate(ALERT_TIMES):
        q = ease_back(prog(t, st, 0.45))
        if t < st: continue
        y = 300 + i * 165
        paste(c, CARDS[i], W / 2 + (1 - clamp(q)) * 500, y + 60, clamp(q * 1.5))
    caption(c, t, "Quiet hours keep it silent at night.", 4.8, 990, 36, MUTED, "R")

def s_history(c, t):
    caption(c, t, "7-day history, and settings you control", 0.0, 110)
    p = ease_out(prog(t, 0.3, 0.7))
    paste(c, HIST, 560 - (1 - p) * 300, 600, p)
    q = ease_out(prog(t, 1.0, 0.7))
    paste(c, SETT, 1360 + (1 - q) * 300, 620, q)

def s_gnome(c, t):
    caption(c, t, "On Linux? See it in your GNOME top bar too", 0.0, 160)
    p = ease_out(prog(t, 0.4, 0.7))
    paste(c, GNOME, W / 2, 590 + (1 - p) * 60, p)

def s_private(c, t):
    words = [("No servers.", 0.3), ("No analytics.", 0.9), ("No account.", 1.5)]
    for i, (s, st) in enumerate(words):
        q = ease_back(prog(t, st, 0.45))
        paste(c, text_img(s, 92, FG if i < 2 else ORANGE, "B"), W / 2, 330 + i * 140, clamp(q), scale=0.7 + 0.3 * q)
    caption(c, t, "It only talks to claude.ai, using your existing login.", 2.3, 820, 42, MUTED, "R")

def s_outro(c, t):
    p = ease_back(prog(t, 0.1, 0.6))
    paste(c, ICON, W / 2, 330, clamp(p), scale=0.3 + 0.7 * p)
    caption(c, t, "Usage Meter for Claude", 0.5, 530, 88)
    caption(c, t, "Free and open source  ·  Chrome, Brave, Edge", 1.0, 630, 42, MUTED, "R")
    caption(c, t, "github.com/AtiQ-Rahman/claude-meter", 1.5, 740, 46, ORANGE, "M")
    caption(c, t, "Unofficial community project. Not affiliated with Anthropic.", 2.2, 960, 28, (120, 118, 114), "R")

SCENES = [
    ("title", 4.0, s_title),
    ("problem", 4.6, s_problem),
    ("ring", 6.6, s_ring),
    ("popup", 6.0, s_popup),
    ("alerts", 6.6, s_alerts),
    ("history", 5.0, s_history),
    ("gnome", 4.4, s_gnome),
    ("private", 4.6, s_private),
    ("outro", 5.6, s_outro),
]
STARTS = {}
acc = 0.0
for name, d, _ in SCENES:
    STARTS[name] = acc; acc += d
TOTAL = acc
FADE = 0.35

def render_frame(gt):
    for name, d, fn in SCENES:
        st = STARTS[name]
        if st <= gt < st + d or name == SCENES[-1][0]:
            t = gt - st
            c = BGIMG.copy()
            fn(c, t)
            a = clamp(min(t / FADE, (d - t) / FADE)) if name not in ("title",) else clamp((d - t) / FADE)
            if name == "outro": a = clamp(t / FADE) * clamp((d - t) / 0.8)
            if a < 1: c = Image.blend(BGIMG if name != "outro" else Image.new("RGBA", (W, H), (0, 0, 0, 255)), c, a)
            return c.convert("RGB")

# ---------------------------------------------------------------- audio
def env(n, a=0.005, r=None):
    e = np.ones(n)
    na = max(1, int(a * SR)); e[:na] = np.linspace(0, 1, na)
    return e

def tone(freq, dur, decay=8.0, harm=(1.0,)):
    n = int(dur * SR); tt = np.arange(n) / SR
    f = np.broadcast_to(np.asarray(freq, float), (n,)) if np.ndim(freq) else np.full(n, float(freq))
    ph = 2 * np.pi * np.cumsum(f) / SR
    s = sum(h * np.sin(ph * (i + 1)) for i, h in enumerate(harm))
    return s * np.exp(-tt * decay) * env(n)

def lowpass(x, cutoff):
    cutoff = np.broadcast_to(np.asarray(cutoff, float), x.shape)
    a = 1 - np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x); acc = 0.0
    for i in range(len(x)):
        acc += a[i] * (x[i] - acc); y[i] = acc
    return y

rng = np.random.default_rng(7)
def whoosh(dur=0.55, up=True):
    n = int(dur * SR); tt = np.linspace(0, 1, n)
    noise = rng.standard_normal(n)
    cut = (300 + 5000 * tt ** 2) if up else (5300 - 5000 * tt ** 0.5)
    lp = lowpass(noise, cut)
    hp = lp - lowpass(lp, 200)
    e = np.sin(np.pi * tt) ** 2
    return hp * e * 0.9

def pop():
    n = int(0.12 * SR); tt = np.arange(n) / SR
    f = 500 + 700 * np.exp(-tt * 40)
    return tone(f, 0.12, 30) * 0.6

def tick():
    return tone(2600, 0.03, 160, (1, 0.3)) * 0.25

def chime():
    return sum(tone(f, 2.0, 2.2, (1, 0.25)) * g for f, g in [(880, .4), (1318.5, .3), (1760, .2), (2637, .08)])

def thud():
    n = int(0.6 * SR); tt = np.arange(n) / SR
    f = 110 * np.exp(-tt * 6) + 40
    body = tone(f, 0.6, 7) * 0.9
    nz = lowpass(rng.standard_normal(n), 900) * np.exp(-tt * 30) * 0.8
    return body + nz

def typing(dur=1.4):
    out = np.zeros(int(dur * SR))
    t = 0.0
    while t < dur - 0.05:
        n = int(0.025 * SR); tt = np.arange(n) / SR
        click = lowpass(rng.standard_normal(n), 3500) * np.exp(-tt * 300) * rng.uniform(0.25, 0.45)
        i = int(t * SR); out[i:i + n] += click
        t += rng.uniform(0.06, 0.14)
    return out

def load_wav(p, gain=1.0):
    with wave.open(os.path.join(REPO, p)) as w:
        sr = w.getframerate(); d = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    x = np.linspace(0, len(d) - 1, int(len(d) * SR / sr))
    return np.interp(x, np.arange(len(d)), d) * gain

def midi(m): return 440 * 2 ** ((m - 69) / 12)

def music(total):
    n = int(total * SR); out = np.zeros(n)
    bpm = 96; beat = 60 / bpm; bar = beat * 4
    chords = [[48, 55, 59, 64], [45, 52, 55, 60], [41, 48, 52, 57], [43, 50, 55, 59]]  # Cmaj7 Am7 Fmaj7 G
    tt_all = np.arange(n) / SR
    k = 0; t = 0.0
    while t < total:
        ch = chords[k % 4]
        i0 = int(t * SR); i1 = min(n, int((t + bar) * SR)); m = i1 - i0
        tt = np.arange(m) / SR
        e = np.minimum(1, tt / 0.6) * np.minimum(1, (bar - tt) / 0.5).clip(0)
        pad = sum(np.sin(2 * np.pi * midi(x) * tt) + 0.3 * np.sin(4 * np.pi * midi(x) * tt * 1.003) for x in ch)
        out[i0:i1] += pad * e * 0.05
        # soft arp pluck on 8ths
        arp = [ch[1] + 12, ch[2] + 12, ch[3] + 12, ch[2] + 12]
        for j in range(8):
            ts = t + j * beat / 2
            if ts >= total: break
            p = tone(midi(arp[j % 4]), 0.5, 9, (1, 0.15)) * 0.045
            a = int(ts * SR); b = min(n, a + len(p)); out[a:b] += p[:b - a]
        # light kick on 1 and 3
        for j in (0, 2):
            ts = t + j * beat
            if ts >= total: break
            kk = tone(60 * np.exp(-np.arange(int(.25 * SR)) / SR * 12) + 45, 0.25, 14) * 0.18
            a = int(ts * SR); b = min(n, a + len(kk)); out[a:b] += kk[:b - a]
        t += bar; k += 1
    fade = np.minimum(1, tt_all / 1.5) * np.minimum(1, (total - tt_all) / 2.5)
    return out * fade

def build_audio():
    n = int((TOTAL + 0.5) * SR)
    mix = np.zeros(n)
    def put(sig, at, gain=1.0):
        a = int(at * SR); b = min(n, a + len(sig)); mix[a:b] += sig[:b - a] * gain

    S = STARTS
    warn = load_wav("browser-extension/sounds/warn.wav", 0.7)
    crit = load_wav("browser-extension/sounds/crit.wav", 0.7)
    reset = load_wav("browser-extension/sounds/reset.wav", 0.7)

    # title
    put(whoosh(0.7), S["title"] + 0.0, 0.8)
    put(pop(), S["title"] + 0.35, 0.9)
    put(chime(), S["title"] + 1.0, 0.6)
    # problem
    put(whoosh(0.5, False), S["problem"] - 0.2, 0.5)
    put(typing(1.5), S["problem"] + 0.3, 1.0)
    put(thud(), S["problem"] + 2.0, 1.0)
    # ring: ticks every 10%, warn at 80, crit at 90
    put(whoosh(0.5), S["ring"] - 0.2, 0.5)
    put(pop(), S["ring"] + 0.3, 0.8)
    last = -1
    for i in range(int(6.6 * FPS)):
        t = i / FPS; p = ring_pct(t)
        if int(p // 10) > last:
            last = int(p // 10)
            if last > 0: put(tick(), S["ring"] + t, 1.0)
        if p >= 80 and not getattr(build_audio, "w", False):
            build_audio.w = True; put(warn, S["ring"] + t)
        if p >= 90 and not getattr(build_audio, "c", False):
            build_audio.c = True; put(crit, S["ring"] + t)
    # popup
    put(whoosh(0.6), S["popup"] + 0.2, 0.7)
    for st in (0.9, 1.7, 2.5, 3.3, 4.1): put(pop(), S["popup"] + st, 0.6)
    # alerts
    put(warn, S["alerts"] + ALERT_TIMES[0])
    put(crit, S["alerts"] + ALERT_TIMES[1])
    put(crit, S["alerts"] + ALERT_TIMES[2])
    put(reset, S["alerts"] + ALERT_TIMES[3])
    for st in ALERT_TIMES: put(whoosh(0.35), S["alerts"] + st - 0.1, 0.35)
    # history
    put(whoosh(0.6), S["history"] + 0.2, 0.7)
    put(whoosh(0.6), S["history"] + 0.9, 0.6)
    # gnome
    put(whoosh(0.6), S["gnome"] + 0.3, 0.7)
    put(pop(), S["gnome"] + 0.8, 0.6)
    # private
    for st in (0.3, 0.9, 1.5): put(thud(), S["private"] + st, 0.45)
    # outro
    put(whoosh(0.7), S["outro"] - 0.1, 0.6)
    put(chime(), S["outro"] + 0.4, 0.7)

    mix[:int(TOTAL * SR)] += music(TOTAL)[:int(TOTAL * SR)] * 1.0
    peak = np.abs(mix).max()
    mix = mix / peak * 0.89
    st = np.stack([mix, mix], 1)
    path = os.path.join(OUT, "audio.wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((st * 32767).astype(np.int16).tobytes())
    return path

# ---------------------------------------------------------------- main
if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "preview":
        for name, d, _ in SCENES:
            render_frame(STARTS[name] + d * 0.75).save(os.path.join(OUT, f"prev_{name}.png"))
        sys.exit()
    audio = build_audio()
    print("audio done", TOTAL, flush=True)
    out = os.path.join(OUT, "usage-meter-for-claude.mp4")
    ff = subprocess.Popen([
        "ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
        "-i", "-", "-i", audio, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out], stdin=subprocess.PIPE)
    nframes = int(TOTAL * FPS)
    for i in range(nframes):
        ff.stdin.write(render_frame(i / FPS).tobytes())
        if i % 150 == 0: print(f"frame {i}/{nframes}", flush=True)
    ff.stdin.close(); ff.wait()
    print("done", out)
