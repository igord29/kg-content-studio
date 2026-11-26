# Source: session scratchpad hl/r59/short06.py (generated from build_short05 by r59/make06.py). Run from the folder that holds r59/.
"""Short 06: rally #59 (Quarterfinal B), "Down. Up. Still swinging." 9:16, 30 fps, one camera.
  open    cold open on navy's full-stretch get and fall, Jessica: "Oh no... they're DOWN!"; flash into the serve
  rally   steady wide frame + hard cuts to navy (the far player is too small/edge-of-frame for cut-ins here)
  end     wide finish, Jessica: "Doesn't even matter who won that point." (the result is off camera)
  payoff  slow-mo of the fall with a spotlight on navy and DOWN. / UP. / STILL SWINGING. stamps (Brian says each),
          then a three-panel DOWN / UP / SWING card: RATE THIS HUSTLE 1-10; loops into the cold open
usage: python3 r59/short06.py   (run from scratchpad/hl)"""
import cv2, json, math, os, re, subprocess
import numpy as np

FPS, OW, OH = 30, 1080, 1920
FONTS = '/home/user/kg-content-studio/assets/story/fonts'
US = '/tmp/claude-0/-home-user-kg-content-studio/a80d6f28-a584-5a33-8c8f-b33e0110540d/scratchpad/us'
SRC = 'r59/r59.mp4'; WD = 'r59/build'; os.makedirs(WD, exist_ok=True)
cap = cv2.VideoCapture(SRC); NF = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)); SW, SH = int(cap.get(3)), int(cap.get(4)); SDUR = NF / FPS

_cache, _last = {}, [-9]
def frame(i):
    i = max(0, min(NF - 1, int(i)))
    if i not in _cache:
        if len(_cache) > 200: _cache.clear()
        if i != _last[0] + 1: cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, f = cap.read(); _last[0] = i
        _cache[i] = f if ok else np.zeros((SH, SW, 3), np.uint8)
    return _cache[i]
def at(t):
    x = max(0, t) * FPS; i = int(math.floor(x)); w = x - i
    if w < 0.1: return frame(i)
    if w > 0.9: return frame(i + 1)
    return cv2.addWeighted(frame(i), 1 - w, frame(i + 1), w, 0)

# ---- player paths -----------------------------------------------------------------------------------
P = json.load(open('r59/paths.json')); TT = np.array(P['t'])
NR, FR = np.array(P['near']), np.array(P['far'])
def sm(v, sec):
    k = max(3, int(sec * 6) | 1); return np.convolve(np.pad(v, k // 2, mode='edge'), np.ones(k) / k, 'valid')
NX, NY, NH = sm(NR[:, 0], 0.35), sm(NR[:, 1], 0.35), sm(NR[:, 2], 0.7)
FX, FY, FH = sm(FR[:, 0], 0.5), sm(FR[:, 1], 0.5), sm(FR[:, 2], 0.7)
def near(t): return np.interp(t, TT, NX), np.interp(t, TT, NY), np.interp(t, TT, NH)
def far(t): return np.interp(t, TT, FX), np.interp(t, TT, FY), np.interp(t, TT, FH)
BW = SH * 9 / 16 / SW
bx = []
for i in range(len(TT)):
    nx, fx = NX[i], FX[i]; c = (nx + fx) / 2; m = BW / 2 - 0.035
    bx.append(min(max(c, nx - m), nx + m))
BX = sm(np.array(bx), 1.0); BX = np.clip(BX, NX - (BW / 2 - 0.06), NX + (BW / 2 - 0.06)); BX = sm(BX, 0.4)
def base_cx(t): return float(np.interp(t, TT, BX))

# ---- shot list (source seconds in r59) --------------------------------------------------------------
COLD = (11.2, 12.9)                       # sprint, full-stretch hit (11.86), the fall (12.0-12.8)
SHOTS = [(0.8, 2.6, 'near'),    # navy serves (1.75)
         (2.6, 4.0, 'base'),    # light blue returns (3.13)
         (4.0, 5.1, 'near'),    # big forehand (4.62)
         (5.1, 6.2, 'base'),
         (6.2, 7.4, 'near'),    # navy (6.67)
         (7.4, 10.0, 'base'),   # navy at the bottom edge of the camera here: stay wide
         (10.0, 11.0, 'near'),  # navy (10.41)
         (11.0, 12.9, 'mid'),   # sprint, stretch (11.86), down (12.0-12.8)
         (12.9, 14.0, 'near'),  # back up
         (14.0, 14.9, 'mid'),   # still swinging: forehand (14.31)
         (14.9, 17.6, 'base')]  # wide finish: navy runs it down, the point ends, navy walks in
REP_S0, REP_S1, REP_RATE = 11.6, 14.5, 0.45
T_DOWN, T_UP, T_SWING = 12.25, 12.95, 14.31          # source moments for the stamps and the panels
L = [dict(kind='mid', s0=COLD[0], rate=1.0, dur=COLD[1] - COLD[0], cold=True)]
for s0, s1, k in SHOTS: L.append(dict(kind=k, s0=s0, rate=1.0, dur=s1 - s0))
L.append(dict(kind='mid', s0=REP_S0, rate=REP_RATE, dur=(T_UP - REP_S0) / REP_RATE, replay=True, spot=True))       # stretch + down
L.append(dict(kind='near', s0=T_UP, rate=REP_RATE, dur=(REP_S1 - T_UP) / REP_RATE, spot=True))                    # cut in: up + swing
L.append(dict(kind='tri', s0=T_SWING, rate=0.0, dur=3.2))
t = 0
for s in L: s['t0'] = t; t += s['dur']
TOTAL = t; COLD_D = L[0]['dur']; T_REP = L[-3]['t0']; T_TRI = L[-1]['t0']; END_D = L[-1]['dur']; T_END = T_TRI
def rv(src): return T_REP + (src - REP_S0) / REP_RATE
def v_of(src): return src - SHOTS[0][0] + COLD_D
BALL = []

# ---- crops ------------------------------------------------------------------------------------------
NEAR_Z, MID_Z, FAR_CW, PAD = 1.32, 1.12, 290, 320
def window(kind, st):
    """(x0, y0, cw, ch) in source pixels; y0 may be negative for 'far' (blurred headroom fill above the frame)"""
    if kind == 'base':
        ch = SH; cw = int(round(ch * 9 / 16)); cx = base_cx(st) * SW; cy = SH / 2
    elif kind in ('near', 'mid'):
        z = NEAR_Z if kind == 'near' else MID_Z
        ch = int(SH / z); cw = int(round(ch * 9 / 16)); nx, ny, nh = near(st); cx, cy = nx * SW, (ny - (0.035 if kind == 'near' else 0.06)) * SH
    elif kind == 'spot':
        cx, cy, cw = SPOT[st >= REP_S0 and _in_rep[0]]; ch = int(round(cw * 16 / 9))
        return int(cx - cw / 2), int(cy - ch / 2), cw, ch
    else:
        cw = FAR_CW; ch = int(round(cw * 16 / 9)); fx, fy, fh = far(st); cx, cy = fx * SW, fy * SH + ch * 0.06
        x0 = int(round(min(max(cx - cw / 2, 0), SW - cw))); y0 = int(round(min(max(cy - ch / 2, -PAD), SH - ch)))
        return x0, y0, cw, ch
    x0 = int(round(min(max(cx - cw / 2, 0), SW - cw))); y0 = int(round(min(max(cy - ch / 2, 0), SH - ch)))
    return x0, y0, cw, ch
_in_rep = [False]
SHARP = {'spot': 0.5, 'far': 0.55, 'near': 0.3, 'mid': 0.25, 'base': 0.15}
FEATH = 18
def soften(img, st):
    """blur + darken the banner band above the far player's head (sponsor softening)"""
    fx, fy, fh = far(st); yb = int((fy - fh * 0.6) * SH) - 10
    if yb < 24: return img
    yb = min(yb, 150); top = img[:yb + FEATH]
    b = cv2.GaussianBlur(cv2.resize(top, (SW // 8, max(2, (yb + FEATH) // 8))), (0, 0), 3)
    b = (cv2.resize(b, (SW, yb + FEATH)) * 0.8).astype(np.uint8)
    w = np.ones((yb + FEATH, 1, 1), np.float32); w[yb:, 0, 0] = np.linspace(1, 0, FEATH)
    o = img.copy(); o[:yb + FEATH] = (b * w + top * (1 - w)).astype(np.uint8); return o
def headroom(img):
    """extend the frame upwards with a mirrored, heavily blurred, darkened copy of the back wall"""
    band = img[:PAD][::-1]
    b = cv2.GaussianBlur(cv2.resize(band, (SW // 10, PAD // 10)), (0, 0), 2.5)
    b = (cv2.resize(b, (SW, PAD)) * 0.72).astype(np.uint8)
    ext = np.vstack([b, img])
    seam = cv2.GaussianBlur(ext[PAD - 40:PAD + 2], (0, 0), 6); ext[PAD - 40:PAD] = seam[:40]   # soften the fill edge only, never the real frame
    return ext
def render_src(kind, img, st):
    img = soften(img, st)
    x0, y0, cw, ch = window(kind, st)
    if y0 < 0: img = headroom(img); y0 += PAD
    o = cv2.resize(img[y0:y0 + ch, x0:x0 + cw], (OW, OH), interpolation=cv2.INTER_LANCZOS4)
    a = SHARP[kind]; b = cv2.GaussianBlur(o, (0, 0), 1.6)
    return cv2.addWeighted(o, 1 + a, b, -a, 0)
def render_win(img, st, w):
    cx, cy, cw = w; cw = int(round(cw)); ch = int(round(cw * 16 / 9)); x0 = int(round(cx - cw / 2)); y0 = int(round(cy - ch / 2))
    img = soften(img, st); Y = y0
    if Y < 0: img = headroom(img); Y += PAD
    o = cv2.resize(img[Y:Y + ch, x0:x0 + cw], (OW, OH), interpolation=cv2.INTER_LANCZOS4)
    b = cv2.GaussianBlur(o, (0, 0), 1.6); o = cv2.addWeighted(o, 1.45, b, -0.45, 0)
    return o, (x0, y0, cw, ch)
def ball_at(st):
    if st < BALL[0][0] - 1e-3 or st > BALL[-1][0] + 1e-3: return None
    T = [b[0] for b in BALL]; return float(np.interp(st, T, [b[1] for b in BALL])), float(np.interp(st, T, [b[2] for b in BALL]))
def ring(img, st, win, u, pulse=False):
    p = ball_at(st)
    if p is None: return img
    x0, y0, cw, ch = win; X = (p[0] - x0) * OW / cw; Y = (p[1] - y0) * OH / ch
    r = int(46 * min(2.2, max(0.9, 551 / cw * 0.75)) * (1 + (0.12 * math.sin(u * 14) if pulse else 0)))
    ov = np.zeros_like(img); cv2.circle(ov, (int(X), int(Y)), r, (60, 240, 212), 7, cv2.LINE_AA)
    glow = cv2.GaussianBlur(ov, (0, 0), 9)
    return cv2.add(cv2.add(img, glow), ov)
def spotlight(img, kind, st):
    x0, y0, cw, ch = window(kind, st); nx, ny, nh = near(st)
    X = (nx * SW - x0) * OW / cw; Y = (ny * SH - y0) * OH / ch; r = nh * SH * OW / cw * 0.62
    m = np.zeros((OH // 4, OW // 4), np.float32); cv2.ellipse(m, (int(X / 4), int(Y / 4)), (int(r / 4), int(r * 1.15 / 4)), 0, 0, 360, 1.0, -1)
    m = cv2.resize(cv2.GaussianBlur(m, (0, 0), 14), (OW, OH))[:, :, None]
    return (img * (0.42 + 0.58 * m)).astype(np.uint8)
PANEL_H, PANEL_Y = 380, (470, 860, 1250)
def panel(st, k=1.55):
    f = soften(frame(round(st * FPS)), st); nx, ny, nh = near(st)
    h = int(nh * SH * k); w = int(h * OW / PANEL_H); cx, cy = int(nx * SW), int((ny - 0.01) * SH)
    x0 = min(max(cx - w // 2, 0), SW - w); y0 = min(max(cy - h // 2, 0), SH - h)
    p = cv2.resize(f[y0:y0 + h, x0:x0 + w], (OW, PANEL_H), interpolation=cv2.INTER_LANCZOS4)
    b = cv2.GaussianBlur(p, (0, 0), 1.4); return cv2.addWeighted(p, 1.35, b, -0.35, 0)
def boxes_out(kind, st):
    x0, y0, cw, ch = window(kind, st); s = OW / cw; out = []
    nx, ny, nh = near(st); fx, fy, fh = far(st)
    for (px, py, ph) in ((nx, ny, nh), (fx, fy, fh)):
        bw = ph * 0.5 * SH; bh = ph * SH * 1.1
        X0 = (px * SW - bw / 2 - x0) * s; X1 = (px * SW + bw / 2 - x0) * s
        Y0 = (py * SH - bh / 2 - y0) * s; Y1 = (py * SH + bh / 2 - y0) * s
        if X1 > 0 and X0 < OW and Y1 > 0 and Y0 < OH: out.append((X0, Y0, X1, Y1))
    return out

# ---- graphics ---------------------------------------------------------------------------------------
def load_rgba(p, size):
    im = cv2.imread(p, cv2.IMREAD_UNCHANGED); return cv2.resize(im, (size, int(im.shape[0] * size / im.shape[1])), interpolation=cv2.INTER_AREA)
def paste(dst, rgba, cx, cy, scale=1.0, alpha=1.0):
    if scale <= 0.01 or alpha <= 0: return
    im = cv2.resize(rgba, (max(1, int(rgba.shape[1] * scale)), max(1, int(rgba.shape[0] * scale))))
    hh, ww = im.shape[:2]; x0, y0 = int(cx - ww / 2), int(cy - hh / 2)
    xa, ya, xb, yb = max(0, x0), max(0, y0), min(dst.shape[1], x0 + ww), min(dst.shape[0], y0 + hh)
    if xa >= xb or ya >= yb: return
    sub = im[ya - y0:yb - y0, xa - x0:xb - x0]; a = sub[:, :, 3:4] / 255.0 * alpha
    dst[ya:yb, xa:xb] = (dst[ya:yb, xa:xb] * (1 - a) + sub[:, :, :3] * a).astype(np.uint8)
def pop(u, dur=0.18):
    if u < 0: return 0
    v = u / dur; return 1.25 * v if v < 1 else max(1.0, 1.25 - 0.25 * (v - 1) / 0.6)
logo = load_rgba(f'{US}/logo.png', 300)
PANEL_SRC = [(T_DOWN - 0.25, 1.55), (T_UP - 0.15, 1.55), (T_SWING - 0.35, 1.15)]   # each panel plays its moment at 0.3x
TEAL_BG = np.zeros((OH, OW, 3), np.uint8); TEAL_BG[:] = (98, 74, 1)
TEAL_BG = (TEAL_BG * (0.7 + 0.4 * np.linspace(0, 1, OH)[:, None, None])).clip(0, 255).astype(np.uint8)
def triptych(u):
    img = TEAL_BG.copy()
    for k, ((s0, kz), y) in enumerate(zip(PANEL_SRC, PANEL_Y)):
        a = min(1, max(0, (u - 0.25 * k) / 0.25)); a = a * a * (3 - 2 * a)
        if a <= 0: continue
        p = panel(s0 + 0.3 * max(0.0, u - 0.25 * k), kz)
        z = 1 + 0.08 * u / 3.2; hh, ww = int(PANEL_H / z), int(OW / z)
        q = cv2.resize(p[(PANEL_H - hh) // 2:(PANEL_H - hh) // 2 + hh, (OW - ww) // 2:(OW - ww) // 2 + ww], (OW, PANEL_H))
        x = int((1 - a) * OW)
        if x < OW: img[y:y + PANEL_H, x:] = q[:, :OW - x]
        cv2.rectangle(img, (x, y), (OW, y + PANEL_H), (60, 240, 212), 4)
    return img
bug = load_rgba(f'{US}/logo.png', 120)
SCAN = np.ones((OH, 1, 1), np.float32); SCAN[::4] = 0.86

# ---- voice ------------------------------------------------------------------------------------------
VO = {}
for f in os.listdir('r59/vo'):
    if f.endswith('.wav'): VO[f[:-4]] = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f'r59/vo/{f}'], capture_output=True, text=True).stdout)
WORDS = json.load(open('r59/vo/words.json'))
TXT = {'jc': "Oh no… they're DOWN!", 'b0': "Rewind. Navy to serve.", 'b1': "Big backhand from navy!",
       'j2': "Navy's covering everything.", 'j3': "Light blue is making navy run!", 'b3': "Wide ball… stretching…",
       'b4': "And right back UP!", 'j5': "Still swinging?!", 'j6': "Doesn't even matter who won that point.",
       'bd': "Down…", 'bu': "Up…", 'bw': "Still swinging!", 'j7': "Rate the hustle. One to ten."}
CUE = [('b0', 1.5), ('b1', 4.4), ('j2', 6.5), ('j3', 8.4), ('b3', 10.7), ('b4', 12.85), ('j5', 14.2), ('j6', 15.75)]
VO_AT = [('jc', 0.05)] + [(k, v_of(s)) for k, s in CUE] + [('bd', rv(T_DOWN) - 0.05), ('bu', rv(T_UP) - 0.05), ('bw', rv(T_SWING) - 0.12), ('j7', T_TRI + 0.75)]
NOCAP = {'bd', 'bu', 'bw', 'j7'}                      # the stamps and the card title carry these lines
for (a, ta), (b, tb) in zip(VO_AT, VO_AT[1:]):
    assert ta + VO[a] <= tb + 0.25, f'voice overlap {a}->{b}: ends {ta + VO[a]:.2f}, next {tb:.2f}'
assert VO_AT[-1][1] + VO['j7'] <= TOTAL + 0.02, 'last line runs past the end'

def seg_at(t): return next(s for s in L if s['t0'] <= t < s['t0'] + s['dur'] + 1e-6) if t < TOTAL - 1e-6 else L[-1]
def src_t(s, u): return s['s0'] + u * s['rate']

# ---- render video -----------------------------------------------------------------------------------
VID = f'{WD}/video.mp4'
ff = subprocess.Popen(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{OW}x{OH}', '-r', str(FPS), '-i', '-',
                       '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', VID], stdin=subprocess.PIPE)
for i in range(int(round(TOTAL * FPS))):
    t = i / FPS; S = seg_at(t); u = t - S['t0']
    st = min(max(src_t(S, u), 0), SDUR - 0.05); _in_rep[0] = bool(S.get('replay'))
    src = at(st) if S.get('replay') or S['kind'] == 'win' else frame(round(st * FPS))
    if S['kind'] == 'tri':
        img = triptych(u)
    elif S.get('spot'):
        img = spotlight(render_src(S['kind'], src, st), S['kind'], st)
    elif S['kind'] == 'win':
        img, wv = render_win(src, st, S['win'](u)); img = ring(img, st, wv, u, pulse=S.get('freeze', False))
        if S.get('freeze') and u < 0.1: img = cv2.addWeighted(img, 0.4, np.full_like(img, 255), 0.6, 0)
    else:
        img = render_src(S['kind'], src, st)
    if S.get('replay'):
        if u < 0.35: img = (img * SCAN).astype(np.uint8)
        if u < 0.12: img = cv2.addWeighted(img, 0.25 + u / 0.12 * 0.75, np.full_like(img, 255), 0.75 - u / 0.12 * 0.75, 0)
    if S is L[1] and u < 0.12: img = cv2.addWeighted(img, 0.3 + u / 0.12 * 0.7, np.full_like(img, 255), 0.7 - u / 0.12 * 0.7, 0)
    if S.get('cold') and S['dur'] - u < 0.1: img = cv2.addWeighted(img, 0.5, np.full_like(img, 255), 0.5, 0)
    paste(img, bug, 966, 330, 1.0, 0.9)                                     # small logo bug, top right
    ff.stdin.write(np.ascontiguousarray(img).tobytes())
ff.stdin.close(); ff.wait()

# ---- text: word-by-word captions -------------------------------------------------------------------
def ts(x): x = max(0, x); return f"{int(x // 3600)}:{int(x % 3600 // 60):02d}:{x % 60:05.2f}"
LIME, WHITE, CORAL = '&H3CF0D4&', '&HFFFFFF&', '&H597AFF&'
ev = []
CAP_Y = [1180, 700, 560, 1300, 1430]
def overlap(t0, t1, y, hgt=120):
    n = 0
    for q in np.arange(t0, t1, 0.1):
        S = seg_at(q)
        if S['kind'] in ('win', 'tri'): n += 9 if y < 1400 else 0; continue
        if S.get('spot'): n += 9 if y > 760 else 0
        if q >= T_REP: n += 9 if y < 1400 else 0
        for X0, Y0, X1, Y1 in boxes_out(S['kind'], src_t(S, q - S['t0'])):
            if Y1 > y - hgt / 2 - 10 and Y0 < y + hgt / 2 + 10 and X1 > 120 and X0 < OW - 120: n += 1
    return n
def chunks(words, maxc=16):
    out, cur = [], []
    for w in words:
        txt = ' '.join(x[2] for x in cur + [w])
        if cur and (len(txt) > maxc or cur[-1][2][-1] in '.,!?…'): out.append(cur); cur = [w]
        else: cur.append(w)
    if cur: out.append(cur)
    return out
def line_words(key, t0):
    """script words (with the intended capitals and punctuation) on whisper's timings"""
    W = WORDS[key]; S = TXT[key].replace('…', '… ').split()
    if len(S) == len(W): W = [(a, b, s) for (a, b, _), s in zip(W, S)]
    else:
        a0, a1 = W[0][0], W[-1][1]; step = (a1 - a0) / len(S); W = [(a0 + i * step, a0 + (i + 1) * step, w) for i, w in enumerate(S)]
    return [(t0 + a, t0 + b, w) for a, b, w in W]
WHO = {'b': ('BRIAN', LIME), 'j': ('JESSICA', CORAL)}
cap_log = []
for n, (k, t0) in enumerate(VO_AT):
    nxt = VO_AT[n + 1][1] if n + 1 < len(VO_AT) else TOTAL
    if k in NOCAP: continue
    wl = line_words(k, t0); t_end = min(t0 + VO[k] + 0.25, nxt - 0.02)
    y = min(CAP_Y, key=lambda yy: (overlap(t0, t_end, yy), CAP_Y.index(yy)))
    name, col = WHO[k[0]]
    ev.append(f"Dialogue: 3,{ts(t0)},{ts(t_end)},Who,,0,0,0,,{{\\an5\\pos({OW//2},{y - 92})\\fs40\\1c{col}\\fad(60,60)}}{name}")
    C = chunks(wl)
    for ci, ch in enumerate(C):
        c0 = ch[0][0] if ci else t0; c1 = C[ci + 1][0][0] if ci + 1 < len(C) else t_end
        for wi, (a, b, w) in enumerate(ch):
            w0 = c0 if wi == 0 else a; w1 = ch[wi + 1][0] if wi + 1 < len(ch) else c1
            parts = []
            for xj, (_, _, x) in enumerate(ch):
                x = x.upper()
                parts.append(f"{{\\1c{col}\\fscx112\\fscy112}}{x}{{\\1c{WHITE}\\fscx100\\fscy100}}" if xj == wi else x)
            intro = "\\fscx70\\fscy70\\t(0,90,\\fscx100\\fscy100)" if wi == 0 else ''
            ev.append(f"Dialogue: 2,{ts(w0)},{ts(w1)},Word,,0,0,0,,{{\\an5\\pos({OW//2},{y})\\fs92{intro}}}{' '.join(parts)}")
    cap_log.append((k, round(t0, 2), y))
def slam_ev(t0, t1, txt, y, fs):
    ev.append(f"Dialogue: 1,{ts(t0)},{ts(t1)},Slam,,0,0,0,,{{\\an5\\pos({OW//2},{y})\\fs{fs}\\fscx145\\fscy145\\t(0,120,\\fscx100\\fscy100)\\fad(20,60)}}{txt}")
ev.append(f"Dialogue: 2,{ts(T_REP + 0.05)},{ts(rv(T_DOWN) - 0.1)},Tag,,0,0,0,,{{\\an5\\pos({OW//2},330)\\fs46\\fad(100,100)}} SLOW-MO ")
slam_ev(rv(T_DOWN), rv(T_UP), f"{{\\1c{CORAL}}}DOWN.", 560, 150)
slam_ev(rv(T_UP), rv(T_SWING), f"{{\\1c{LIME}}}UP.", 560, 150)
slam_ev(rv(T_SWING), T_TRI, f"STILL {{\\1c{LIME}}}SWINGING.", 560, 112)
for k, (lab, col) in enumerate((('DOWN.', CORAL), ('UP.', LIME), ('STILL SWINGING.', WHITE))):
    ev.append(f"Dialogue: 2,{ts(T_TRI + 0.25 * k + 0.2)},{ts(TOTAL)},Slam,,0,0,0,,{{\\an5\\pos(260,{PANEL_Y[k] + 52})\\fs60\\1c{col}\\fad(80,0)}}{lab}")
slam_ev(T_TRI + 0.9, TOTAL, f"RATE THIS {{\\1c{LIME}}}HUSTLE", 350, 96)
ev.append(f"Dialogue: 2,{ts(T_TRI + 1.1)},{ts(TOTAL)},Pill,,0,0,0,,{{\\an5\\pos({OW//2},430)\\fs40\\fad(100,0)}} COMMENT 1-10 · @UNITEDSETS ")
ass = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {OW}
PlayResY: {OH}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Word,Montserrat ExtraBold,92,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,8,5,5,60,60,0,1
Style: Who,Montserrat ExtraBold,34,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,4,0,1,5,2,5,60,60,0,1
Style: Slam,Montserrat ExtraBold,100,&H00FFFFFF,&H00FFFFFF,&H00101010,&H90000000,0,0,0,0,100,100,1,0,1,6,8,5,60,60,0,1
Style: Pill,Montserrat ExtraBold,40,&H00624A01,&H00624A01,&H003CF0D4,&H003CF0D4,0,0,0,0,100,100,3,0,3,18,0,5,60,60,0,1
Style: Tag,Montserrat ExtraBold,46,&H00FFFFFF,&H00FFFFFF,&H001E1EE6,&H001E1EE6,0,0,0,0,100,100,6,0,3,16,0,5,60,60,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""" + '\n'.join(ev) + '\n'
open(f'{WD}/text.ass', 'w').write(ass)

# ---- audio ------------------------------------------------------------------------------------------
SFX = f'{US}/sfx'; ins, fc, chunks_a = ['-i', SRC], [], []; k = 1
for j, s in enumerate(L):
    r = s['rate']; a, b = s['s0'], min(SDUR, s['s0'] + s['dur'] * r)
    if r == 0:
        fc.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{s['dur']:.4f}[a{j}]"); chunks_a.append(f'[a{j}]'); continue
    chain = f"[0:a]atrim={a:.4f}:{b:.4f},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo"
    if r < 0.95: chain += f",asetrate={int(48000 * r)},aresample=48000"
    fc.append(chain + f",volume=3.0,apad,atrim=0:{s['dur']:.4f}[a{j}]"); chunks_a.append(f'[a{j}]')
fc.append(f"{''.join(chunks_a)}concat=n={len(chunks_a)}:v=0:a=1,acompressor=threshold=0.2:ratio=3:attack=5:release=120[court]")
vo_l = []
for key, t0 in VO_AT:
    ins += ['-i', f'r59/vo/{key}.wav']; fc.append(f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo,volume=1.7,adelay={int(t0*1000)}|{int(t0*1000)}[v{k}]"); vo_l.append(f'[v{k}]'); k += 1
fc.append(f"{''.join(vo_l)}amix=inputs={len(vo_l)}:normalize=0,apad=whole_dur={TOTAL:.3f},asplit[vo][key]")
RX = 'r59/sfx'
fx = [(f'{RX}/riser.wav', 0.0, 0.18),                                   # cold open: build
      (f'{SFX}/scratch.wav', 0.85, 0.40),                              # the fall
      (f'{RX}/subdrop.wav', 0.9, 0.45),
      (f'{SFX}/whoosh.wav', COLD_D - 0.18, 0.6),                       # flash into the serve
      (f'{RX}/riser.wav', v_of(11.86) - 1.6, 0.28),                    # build into the stretch
      (f'{RX}/subdrop.wav', v_of(12.15), 0.5),                         # the fall, live
      (f'{SFX}/pop.wav', v_of(T_SWING), 0.45),                         # still swinging
      (f'{RX}/applause.wav', v_of(15.6), 0.30),                        # the point ends
      (f'{SFX}/whoosh.wav', T_REP - 0.12, 0.6),                        # into the slow-mo
      (f'{RX}/heartbeat.wav', T_REP + 0.1, 0.45), (f'{RX}/heartbeat.wav', T_REP + 3.05, 0.45),
      (f'{SFX}/boom.wav', rv(T_DOWN), 0.5),                            # DOWN.
      (f'{SFX}/pop.wav', rv(T_UP), 0.7),                               # UP.
      (f'{RX}/subdrop.wav', rv(T_SWING), 0.5), (f'{SFX}/pop.wav', rv(T_SWING) + 0.02, 0.6),   # STILL SWINGING.
      (f'{SFX}/whip.wav', T_TRI, 0.45), (f'{SFX}/whip.wav', T_TRI + 0.25, 0.4), (f'{SFX}/whip.wav', T_TRI + 0.5, 0.4),
      (f'{SFX}/pop.wav', T_TRI + 0.9, 0.7)]
fl = []
for name, t0, g in fx:
    ins += ['-i', name]; fc.append(f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo,volume={g},adelay={int(max(0,t0)*1000)}|{int(max(0,t0)*1000)}[f{k}]"); fl.append(f'[f{k}]'); k += 1
fc.append("[court][key]sidechaincompress=threshold=0.03:ratio=5:attack=20:release=300[duck]")
fc.append(f"[duck][vo]{''.join(fl)}amix=inputs={2 + len(fl)}:normalize=0,atrim=0:{TOTAL:.3f}[mix]")
RAW = f'{WD}/mix_raw.wav'
subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', *ins, '-filter_complex', ';'.join(fc), '-map', '[mix]', '-ar', '48000', '-ac', '2', RAW], check=True)
m = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-i', RAW, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], capture_output=True, text=True).stderr
m = json.loads(m[m.rindex('{'):m.rindex('}') + 1]); MIX = f'{WD}/mix.wav'
subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', RAW, '-af', f"loudnorm=I=-14:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true,alimiter=limit=0.8:level=false", '-ar', '48000', MIX], check=True)
def lufs(p):
    x = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-i', p, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', x)[-1])
for _ in range(2):
    gap = -14.0 - lufs(MIX)
    if abs(gap) < 0.4: break
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', MIX, '-af', f'volume={gap:.2f}dB,alimiter=limit=0.8:level=false:attack=3:release=60', '-ar', '48000', MIX + '.g.wav'], check=True)
    os.replace(MIX + '.g.wav', MIX)
OUT = 'r59/out/UnitedSets-Short-06-down-up-swinging.mp4'; os.makedirs('r59/out', exist_ok=True)
subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', VID, '-i', MIX, '-vf', f"subtitles={WD}/text.ass:fontsdir={FONTS}", '-map', '0:v', '-map', '1:a',
                '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', f'{TOTAL:.3f}', OUT], check=True)
json.dump({'video': OUT, 'aspect': '9:16', 'width': OW, 'height': OH, 'fps': FPS, 'duration': TOTAL, 'target_duration': [12, 60],
           'shots': [{'t0': round(s['t0'], 3), 'd': round(s['dur'], 3), 'kind': 'clip',
                      'trans': 'flash' if s.get('replay') or s is L[1] else 'cut'} for s in L[:-1]] + [{'t0': round(T_END, 3), 'd': END_D, 'kind': 'card', 'trans': 'whip'}],
           'vo': [{'line': j + 1, 'at': round(t0, 3), 'dur': VO[key], 'file': os.path.abspath(f'r59/vo/{key}.wav')} for j, (key, t0) in enumerate(VO_AT)],
           'end_card': [T_END, TOTAL], 'ass': os.path.abspath(f'{WD}/text.ass'),
           'safe_zone': {'top': 280, 'bottom': 1500, 'side': 60}, 'logo_until': TOTAL, 'surface': 'hard'}, open(OUT.replace('.mp4', '.qc.json'), 'w'), indent=1)
print('wrote', OUT, round(TOTAL, 2), 'replay', round(T_REP, 2), 'end overlay', round(T_END, 2))
print('captions', cap_log)
