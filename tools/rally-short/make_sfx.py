"""Synthesised sound effects for rally Shorts (no SFX model is connected): riser, subdrop, heartbeat, applause.
usage: python3 make_sfx.py <out_dir>"""
import sys, wave, numpy as np
SR = 48000; rng = np.random.default_rng(7); OUT = sys.argv[1] if len(sys.argv) > 1 else '.'
def save(name, x):
    x = np.asarray(x, np.float64)
    if x.ndim == 1: x = np.stack([x, x], 1)
    x = x / max(1e-9, np.abs(x).max()) * 0.9
    with wave.open(f'{OUT}/{name}.wav', 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((x * 32767).astype(np.int16).tobytes())
def lp(x, a):
    y = np.zeros_like(x); s = 0.0; a = np.broadcast_to(a, x.shape)
    for i in range(len(x)): s += a[i] * (x[i] - s); y[i] = s
    return y
n = int(1.6 * SR); t = np.arange(n) / SR; e = (t / 1.6) ** 2.2                       # riser: opening noise + rising tone
save('riser', lp(rng.standard_normal(n), 0.01 + 0.5 * e) * e * 0.8 + np.sin(2 * np.pi * np.cumsum(180 + 900 * e ** 1.5) / SR) * 0.25 * e)
n = int(1.2 * SR); t = np.arange(n) / SR                                              # subdrop: 60 -> 32 Hz, saturated
x = np.tanh(2.2 * np.sin(2 * np.pi * np.cumsum(32 + 28 * np.exp(-t * 4)) / SR)) * np.exp(-t * 2.6); x[:240] += np.linspace(1, 0, 240) * rng.standard_normal(240) * 0.6
save('subdrop', x)
n = int(3.0 * SR); x = np.zeros(n)                                                     # heartbeat: lub-dub at 80 bpm
def thump(at, g, f0=55):
    k = int(0.18 * SR); tt = np.arange(k) / SR; s = np.sin(2 * np.pi * f0 * tt) * np.exp(-tt * 28) * g; i = int(at * SR); x[i:i + k] += s[:max(0, min(k, n - i))]
for b in np.arange(0.05, 3.0, 0.75): thump(b, 1.0); thump(b + 0.2, 0.7, 48)
save('heartbeat', np.tanh(1.5 * x))
n = int(3.0 * SR); Lc = np.zeros(n); Rc = np.zeros(n)                                 # applause: many short claps, swell and fade
env = lambda q: np.clip(q / 0.35, 0, 1) * np.clip((3.0 - q) / 1.6, 0, 1)
for _ in range(900):
    at = rng.uniform(0, 2.95)
    if rng.uniform() > env(at): continue
    k = int(rng.uniform(0.006, 0.016) * SR); c = np.convolve(rng.standard_normal(k) * np.exp(-np.arange(k) / (k / 4)), [1, -0.6], 'same') * rng.uniform(0.3, 1.0)
    pan = rng.uniform(0.15, 0.85); i = int(at * SR); Lc[i:i + k] += c * (1 - pan); Rc[i:i + k] += c * pan
for d, g in ((0.021, 0.35), (0.037, 0.25), (0.061, 0.15)):
    j = int(d * SR); Lc[j:] += Lc[:-j] * g; Rc[j:] += Rc[:-j] * g
save('applause', np.stack([lp(Lc, 0.55), lp(Rc, 0.55)], 1))
