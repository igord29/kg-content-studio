"""Near + far player paths for rl/r47.mp4 from r10/t_r10.json (people boxes every 5 frames).
near: tallest person low in frame, continuity-weighted. far: small person near the far baseline, continuity from a seed.
writes r10/paths.json {t:[], near:[[x,y,h]], far:[[x,y,h]]}"""
import json, numpy as np
R = json.load(open('r10/t_r10.json'))
T, NEAR, FAR = [], [], []
pn, pf = None, (0.387, 0.055)
for t, P in R:
    nc = [p for p in P if p[2] > 0.3 and p[4] > 0.09]
    if nc:
        nc.sort(key=lambda p: -p[4] + (3 * abs(p[1] - pn[0]) if pn else 0)); pn = (nc[0][1], nc[0][2], nc[0][4])
    fc = [p for p in P if p[2] < 0.3 and 0.03 < p[4] < 0.12 and abs(p[1] - pf[0]) < 0.12 and abs(p[2] - pf[1]) < 0.06]
    if fc:
        fc.sort(key=lambda p: abs(p[1] - pf[0]) + abs(p[2] - pf[1])); pf = (fc[0][1], fc[0][2], fc[0][4]); fok = 1
    else: fok = 0
    T.append(t); NEAR.append(list(pn) if pn else [0.5, 0.6, 0.25]); FAR.append([pf[0], pf[1], pf[2] if len(pf) > 2 else 0.05, fok])
json.dump({'t': T, 'near': NEAR, 'far': FAR}, open('r10/paths.json', 'w'))
miss = sum(1 for f in FAR if not f[3]); print('frames', len(T), 'far misses', miss)
