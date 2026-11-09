#!/usr/bin/env python3
"""
Generátor vzorových 360° panorám pre Rozhľad.

Vytvorí 4 ekvirektangulárne obrázky (pomer 2:1) jednoduchého bytu, ktoré sa dajú
použiť na okamžité vyskúšanie aplikácie. Obrázky nie sú fotografie, sú to
procedurálne vykreslené miestnosti (jednoduchý ray-casting v numpy), takže nemajú
žiadne autorské práva a môžete ich voľne používať (CC0).

Použitie:
    python3 tools/generate_samples.py              # plná kvalita 4096x2048 -> panoramas/
    python3 tools/generate_samples.py --fast       # rýchly náhľad 1024x512
    python3 tools/generate_samples.py --out dir    # iný výstupný priečinok

Požiadavky: Python 3.9+, numpy, Pillow.
Skript zároveň vypíše súradnice (yaw/pitch v stupňoch) dverí, ktoré sa používajú
pre vzorové body prechodu v app.js.
"""
import argparse
import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

F = np.float32


# ---------------------------------------------------------------- pomocné funkcie
def hexc(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], dtype=F)


def fract(x):
    return x - np.floor(x)


def hash1(a):
    return fract(np.sin(a * 127.1 + 11.7) * 43758.5453)


def hash2(a, b):
    return fract(np.sin(a * 127.1 + b * 311.7) * 43758.5453)


def lerp(a, b, t):
    return a + (b - a) * t


def smooth_noise(x, z, scale):
    """Jednoduchý hodnotový šum 0..1 (pre trávu a podobne)."""
    gx, gz = x / scale, z / scale
    ix, iz = np.floor(gx), np.floor(gz)
    fx, fz = gx - ix, gz - iz
    fx, fz = fx * fx * (3 - 2 * fx), fz * fz * (3 - 2 * fz)
    a, b = hash2(ix, iz), hash2(ix + 1, iz)
    c, d = hash2(ix, iz + 1), hash2(ix + 1, iz + 1)
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fz)


def to_yaw_pitch(p):
    """Smerový vektor -> (yaw, pitch) v stupňoch. yaw 0 = dopredu (+z), rastie doprava."""
    x, y, z = p
    return (math.degrees(math.atan2(x, z)), math.degrees(math.atan2(y, math.hypot(x, z))))


def wall_u(w, x, z):
    """Vodorovná súradnica na stene tak, ako ju vidí pozorovateľ stojaci v miestnosti (rastie doprava)."""
    return {'z1': x, 'z0': -x, 'x1': -z, 'x0': z}[w]


def wall_point(room, w, u, h):
    return {'z1': (u, h, room['z1']), 'z0': (-u, h, room['z0']),
            'x1': (room['x1'], h, -u), 'x0': (room['x0'], h, u)}[w]


def make_sign(text, size=(720, 190)):
    """Tabuľka s názvom miestnosti nad dverami (RGBA)."""
    img = Image.new('RGBA', size, (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([4, 4, size[0] - 5, size[1] - 5], radius=34, fill=(246, 241, 230, 255),
                        outline=(40, 52, 60, 255), width=6)
    font = None
    for path in ('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
                 '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'):
        if os.path.exists(path):
            font = ImageFont.truetype(path, 104)
            break
    if font is None:
        font = ImageFont.load_default()
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((size[0] - tw) / 2 - bbox[0], (size[1] - th) / 2 - bbox[1]), text, font=font, fill=(34, 46, 56, 255))
    return np.asarray(img, dtype=F) / 255.0


# ---------------------------------------------------------------- textúry podláh
def floor_parquet(px, pz, base, var=0.10, plank=0.15, length=1.2, seam=0.70):
    row = np.floor(pz / plank)
    off = hash1(row) * length
    seg = np.floor((px + off) / length)
    h = hash2(row, seg)
    shade = 1 + (h - 0.5) * 2 * var
    fz = pz / plank - row
    fx = (px + off) - seg * length
    grain = 1 + 0.03 * np.sin(pz * 95 + h * 20 + px * 2.5)
    col = base[None, :] * (shade * grain)[:, None]
    s = (fz < 0.05) | (fz > 0.95) | (fx < 0.012) | (fx > length - 0.012)
    col[s] *= seam
    return col


def floor_tiles(px, pz, c1, c2, grout, tile=0.45):
    ix, iz = np.floor(px / tile), np.floor(pz / tile)
    chk = ((ix + iz) % 2).astype(F)[:, None]
    col = c1[None, :] * (1 - chk) + c2[None, :] * chk
    fx, fz = px / tile - ix, pz / tile - iz
    g = (fx < 0.018) | (fx > 0.982) | (fz < 0.018) | (fz > 0.982)
    col[g] = grout
    return col


# ---------------------------------------------------------------- prienik lúča s objektmi
def hit_boxes(d, cy, boxes, st):
    """Prienik lúčov (z bodu 0,cy,0) s kvádrami; aktualizuje stav st (t, col, nrm, ao, emit)."""
    for b in boxes:
        bmin = np.array(b['min'], dtype=F)
        bmax = np.array(b['max'], dtype=F)
        o = np.array([0, cy, 0], dtype=F)
        with np.errstate(divide='ignore', invalid='ignore'):
            inv = 1.0 / np.where(np.abs(d) < 1e-9, 1e-9, d)
            t1 = (bmin - o) * inv
            t2 = (bmax - o) * inv
        tn = np.minimum(t1, t2)
        tf = np.maximum(t1, t2)
        tmin = tn.max(axis=1)
        tmax = tf.min(axis=1)
        hit = (tmax >= tmin) & (tmin > 0.001) & (tmin < st['t'])
        if not hit.any():
            continue
        idx = np.nonzero(hit)[0]
        ax = np.argmax(tn[idx], axis=1)
        nrm = np.zeros((len(idx), 3), dtype=F)
        nrm[np.arange(len(idx)), ax] = -np.sign(d[idx, ax])
        t = tmin[idx]
        p = d[idx] * t[:, None] + o
        col = np.tile(hexc(b['col']) if isinstance(b['col'], str) else np.array(b['col'], dtype=F), (len(idx), 1))
        seams = b.get('seams')
        if seams:
            axis, spacing = seams
            side = ax != 1
            f = fract(p[:, axis] / spacing)
            line = side & ((f < 0.025) | (f > 0.975))
            col[line] *= 0.7
        stripes = b.get('stripes')
        if stripes:  # prúžky (napr. knihy v poličke)
            axis, spacing, c2 = stripes
            side = ax != 1
            f = fract(p[:, axis] / spacing)
            alt = side & (f > 0.5)
            col[alt] = hexc(c2)
        st['t'][idx] = t
        st['col'][idx] = col
        st['nrm'][idx] = nrm
        st['ao'][idx] = 0.72 + 0.28 * np.clip(p[:, 1] / 0.7, 0, 1)
        st['emit'][idx] = False
        st['obj'][idx] = True


def hit_spheres(d, cy, spheres, st):
    for s in spheres:
        c = np.array(s['c'], dtype=F) - np.array([0, cy, 0], dtype=F)
        r = s['r']
        b = d @ c
        disc = b * b - (c @ c - r * r)
        ok = disc > 0
        t = np.where(ok, b - np.sqrt(np.maximum(disc, 0)), np.inf)
        hit = ok & (t > 0.001) & (t < st['t'])
        if not hit.any():
            continue
        idx = np.nonzero(hit)[0]
        p = d[idx] * t[idx][:, None]
        n = (p - c) / r
        col = hexc(s['col']) if isinstance(s['col'], str) else np.array(s['col'], dtype=F)
        st['t'][idx] = t[idx]
        st['col'][idx] = col
        st['nrm'][idx] = n
        st['ao'][idx] = 1.0
        st['emit'][idx] = bool(s.get('emit'))
        if s.get('emit'):
            st['col'][idx] = col * s.get('gain', 1.3)
        st['obj'][idx] = True


# ---------------------------------------------------------------- steny: dvere, okná, obrázky
def paint_wall(room, w, u, h, col, emit):
    """Dokreslí na stenu dvere, okná, tabuľky... Mení col a emit na mieste."""
    col[h < 0.095] = hexc(room.get('baseboard', '#f2efe9'))
    thin = (h >= 0.095) & (h < 0.108)
    col[thin] *= 0.82
    for f in room['features'].get(w, []):
        sel = (u >= f['u0']) & (u <= f['u1']) & (h >= f['h0']) & (h <= f['h1'])
        if not sel.any():
            continue
        ii = np.nonzero(sel)[0]
        uu, hh = u[ii], h[ii]
        kind = f['kind']
        w_, h_ = f['u1'] - f['u0'], f['h1'] - f['h0']
        lu, lh = uu - f['u0'], hh - f['h0']
        if kind == 'door':
            leaf = hexc(f.get('col', '#e9e4da'))
            c = np.tile(leaf, (len(ii), 1))
            fr = (lu < 0.07) | (lu > w_ - 0.07) | (lh > h_ - 0.07)
            c[fr] = hexc(f.get('frame', '#6b5a4a'))
            # vložené panely
            for (a0, a1) in ((0.16, 0.92), (1.12, h_ - 0.16)):
                pan = (lu > 0.17) & (lu < w_ - 0.17) & (lh > a0) & (lh < a1)
                edge = pan & ((lu < 0.20) | (lu > w_ - 0.20) | (lh < a0 + 0.03) | (lh > a1 - 0.03))
                c[pan] *= 0.96
                c[edge] *= 0.84
            # kľučka
            hu = (f['u1'] - 0.12) if f.get('handle', 'right') == 'right' else (f['u0'] + 0.12)
            hd = np.hypot(uu - hu, hh - 1.02) < 0.04
            c[hd] = hexc('#c9ccd0')
            col[ii] = c
        elif kind in ('window', 'glassdoor'):
            fw = f.get('fw', 0.055)
            frame = (lu < fw) | (lu > w_ - fw) | (lh < fw) | (lh > h_ - fw)
            mull = (np.abs(lu - w_ / 2) < 0.018) | (np.abs(lh - h_ * f.get('split', 0.5)) < 0.018)
            t = np.clip(lh / h_, 0, 1)
            sky = lerp(hexc('#e8f1f7'), hexc('#8fbbe3'), np.clip((t - 0.25) * 1.6, 0, 1)[:, None])
            green = hexc(f.get('ground', '#8db27a'))
            gl = np.where((t < 0.22)[:, None], green[None, :], sky)
            gl = gl * 1.18
            gl[frame | mull] = hexc(f.get('frame', '#f4f2ee'))
            col[ii] = gl
            emit[ii] = ~(frame | mull)
        elif kind == 'rect':
            c = np.tile(hexc(f['col']), (len(ii), 1))
            if f.get('bands'):
                n = len(f['bands'])
                bi = np.clip((lh / h_ * n).astype(int), 0, n - 1)
                for k, bc in enumerate(f['bands']):
                    c[bi == k] = hexc(bc)
            border = (lu < 0.04) | (lu > w_ - 0.04) | (lh < 0.04) | (lh > h_ - 0.04)
            if f.get('border'):
                c[border] = hexc(f['border'])
            col[ii] = c
        elif kind == 'decal':
            img = f['img']
            ih, iw = img.shape[:2]
            ix = np.clip((lu / w_ * (iw - 1)).astype(int), 0, iw - 1)
            iy = np.clip(((h_ - lh) / h_ * (ih - 1)).astype(int), 0, ih - 1)
            px = img[iy, ix]
            a = px[:, 3:4]
            col[ii] = col[ii] * (1 - a) + px[:, :3] * a


# ---------------------------------------------------------------- vykreslenie miestnosti
def shade_room(room, d):
    n = d.shape[0]
    cy = room.get('cam_y', 1.5)
    x0, x1, z0, z1, Hh = room['x0'], room['x1'], room['z0'], room['z1'], room['H']
    dx, dy, dz = d[:, 0], d[:, 1], d[:, 2]
    with np.errstate(divide='ignore', invalid='ignore'):
        tx = np.where(dx > 1e-9, x1 / dx, np.where(dx < -1e-9, x0 / dx, np.inf))
        ty = np.where(dy > 1e-9, (Hh - cy) / dy, np.where(dy < -1e-9, -cy / dy, np.inf))
        tz = np.where(dz > 1e-9, z1 / dz, np.where(dz < -1e-9, z0 / dz, np.inf))
    t = np.minimum(np.minimum(tx, ty), tz).astype(F)
    axis = np.where(t == tx, 0, np.where(t == ty, 1, 2))
    p = d * t[:, None]
    p[:, 1] += cy
    px, py, pz = p[:, 0], p[:, 1], p[:, 2]

    col = np.zeros((n, 3), dtype=F)
    nrm = np.zeros((n, 3), dtype=F)
    ao = np.ones(n, dtype=F)
    emit = np.zeros(n, dtype=bool)

    # vzdialenosť k ostatným rovinám -> jednoduchá okluzia v rohoch
    dist = np.stack([px - x0, x1 - px, py, Hh - py, pz - z0, z1 - pz], axis=1)
    own = np.where(axis == 0, np.where(dx > 0, 1, 0), np.where(axis == 1, np.where(dy > 0, 3, 2), np.where(dz > 0, 5, 4)))
    dist[np.arange(n), own] = 99
    dmin = dist.min(axis=1)
    ao = (1 - 0.42 * np.exp(-dmin / 0.42)).astype(F)

    # podlaha
    m = (axis == 1) & (dy < 0)
    if m.any():
        col[m] = room['floor'](px[m], pz[m])
        nrm[m] = (0, 1, 0)
        rug = room.get('rug')
        if rug:
            cx, cz, rx, rz = rug['c'][0], rug['c'][1], rug['r'][0], rug['r'][1]
            q = np.hypot((px[m] - cx) / rx, (pz[m] - cz) / rz)
            c = col[m]
            inside = q < 1.0
            ring = (q > 0.82) & (q < 0.9)
            band = (q > 0.45) & (q < 0.55)
            c[inside] = hexc(rug['c1'])
            c[inside & ring] = hexc(rug['c2'])
            c[inside & band] = hexc(rug['c3'])
            col[m] = c
        # kontaktné tiene pod nábytkom
        sh = np.ones(m.sum(), dtype=F)
        for b in room['boxes']:
            if b['min'][1] > 0.05:
                continue
            ddx = np.maximum(np.maximum(b['min'][0] - px[m], px[m] - b['max'][0]), 0)
            ddz = np.maximum(np.maximum(b['min'][2] - pz[m], pz[m] - b['max'][2]), 0)
            sh *= 1 - 0.5 * np.exp(-np.hypot(ddx, ddz) / 0.20)
        ao[m] *= sh
    # strop
    m = (axis == 1) & (dy > 0)
    if m.any():
        col[m] = hexc(room.get('ceiling', '#f3f2ee'))
        nrm[m] = (0, -1, 0)
        lx, lz = room['light'][0], room['light'][2]
        lamp = np.hypot(px[m] - lx, pz[m] - lz) < 0.24
        c = col[m]
        c[lamp] = hexc('#fff3d6') * 1.35
        col[m] = c
        e = emit[m]
        e[lamp] = True
        emit[m] = e
    # steny
    for k, w in enumerate(('x0', 'x1', 'z0', 'z1')):
        if w == 'x0':
            m = (axis == 0) & (dx < 0)
            nrm[m] = (1, 0, 0)
        elif w == 'x1':
            m = (axis == 0) & (dx > 0)
            nrm[m] = (-1, 0, 0)
        elif w == 'z0':
            m = (axis == 2) & (dz < 0)
            nrm[m] = (0, 0, 1)
        else:
            m = (axis == 2) & (dz > 0)
            nrm[m] = (0, 0, -1)
        if not m.any():
            continue
        u = wall_u(w, px[m], pz[m])
        h = py[m]
        c = np.tile(hexc(room['wall_cols'][w]), (m.sum(), 1))
        e = np.zeros(m.sum(), dtype=bool)
        paint_wall(room, w, u, h, c, e)
        col[m] = c
        emit[m] = e

    st = dict(t=t, col=col, nrm=nrm, ao=ao, emit=emit, obj=np.zeros(n, dtype=bool))
    hit_boxes(d, cy, room['boxes'], st)
    hit_spheres(d, cy, room.get('spheres', []), st)

    # osvetlenie
    pts = d * st['t'][:, None]
    pts[:, 1] += cy
    L = np.array(room['light'], dtype=F)[None, :] - pts
    dist2 = (L * L).sum(axis=1)
    L /= np.sqrt(dist2)[:, None] + 1e-6
    ndl = np.clip((st['nrm'] * L).sum(axis=1), 0, 1)
    inten = room.get('amb', 0.62) + room.get('diff', 0.62) * ndl / (1 + 0.10 * dist2)
    out = st['col'] * (inten * st['ao'])[:, None]
    out = np.where(st['emit'][:, None], st['col'], out)
    return out


# ---------------------------------------------------------------- vykreslenie terasy (exteriér)
SUN = np.array([math.sin(math.radians(-125)) * math.cos(math.radians(38)),
                math.sin(math.radians(38)),
                math.cos(math.radians(-125)) * math.cos(math.radians(38))], dtype=F)


def shade_terrace(room, d):
    n = d.shape[0]
    cy = room.get('cam_y', 1.5)
    dx, dy, dz = d[:, 0], d[:, 1], d[:, 2]
    pitch = np.arcsin(np.clip(dy, -1, 1))
    yaw = np.arctan2(dx, dz)

    # obloha
    k = np.clip(pitch / (math.pi / 2), 0, 1) ** 0.55
    sky = lerp(hexc('#d9e8f3')[None, :], hexc('#4d8ad0')[None, :], k[:, None])
    cosang = np.clip(d @ SUN, -1, 1)
    glow = np.exp((cosang - 1) * 60)[:, None] * 0.55 + np.exp((cosang - 1) * 1800)[:, None] * 3.0
    sky = sky + glow * hexc('#fff0c8')[None, :]

    # kopce na horizonte
    prof = 0.045 + 0.030 * np.sin(3 * yaw + 1.0) + 0.016 * np.sin(7 * yaw + 2.0) + 0.008 * np.sin(17 * yaw)
    hills = (pitch >= 0) & (pitch < prof)
    hcol = lerp(hexc('#7d9fa6')[None, :], hexc('#a9c3cc')[None, :], np.clip(pitch / 0.09, 0, 1)[:, None])
    col = np.where(hills[:, None], hcol, sky).astype(F)
    t = np.full(n, np.inf, dtype=F)
    nrm = np.zeros((n, 3), dtype=F)
    ao = np.ones(n, dtype=F)
    emit = np.ones(n, dtype=bool)  # obloha sa nesvieti

    # zem (paluba + tráva)
    z1 = room['z1']
    g = dy < -1e-6
    tg = np.where(g, -cy / np.where(g, dy, -1), np.inf)
    gi = np.nonzero(g)[0]
    px = d[gi, 0] * tg[gi]
    pz = d[gi, 2] * tg[gi]
    deck = (np.abs(px) < room['deck_x']) & (pz > room['z0']) & (pz < z1)
    gc = np.zeros((len(gi), 3), dtype=F)
    if deck.any():
        base = hexc('#8a7a69')
        gc[deck] = floor_parquet(px[deck], pz[deck], base, var=0.07, plank=0.14, length=1.6, seam=0.55)
    lawn = ~deck
    if lawn.any():
        nz = smooth_noise(px[lawn], pz[lawn], 0.35) * 0.5 + smooth_noise(px[lawn], pz[lawn], 3.0) * 0.5
        gc[lawn] = lerp(hexc('#5f8a46')[None, :], hexc('#9cc066')[None, :], nz[:, None])
        fog = 1 - np.exp(-tg[gi][lawn] / 55)
        gc[lawn] = lerp(gc[lawn], hexc('#b7cfc7')[None, :], fog[:, None])
    col[gi] = gc
    t[gi] = tg[gi]
    nrm[gi] = (0, 1, 0)
    emit[gi] = False
    # kontaktné tiene pod nábytkom a zábradlím
    sh = np.ones(len(gi), dtype=F)
    for b in room['boxes']:
        if b['min'][1] > 0.05:
            continue
        ddx = np.maximum(np.maximum(b['min'][0] - px, px - b['max'][0]), 0)
        ddz = np.maximum(np.maximum(b['min'][2] - pz, pz - b['max'][2]), 0)
        sh *= 1 - 0.45 * np.exp(-np.hypot(ddx, ddz) / 0.16)
    ao[gi] = sh

    # stena domu
    w = dz > 1e-6
    tw = np.where(w, z1 / np.where(w, dz, 1), np.inf)
    yw = cy + dy * tw
    wm = w & (tw < t) & (yw < room['wall_h'])
    if wm.any():
        wi = np.nonzero(wm)[0]
        u = d[wi, 0] * tw[wi]
        h = yw[wi]
        c = np.tile(hexc(room['wall_cols']['z1']), (len(wi), 1))
        # jemná omietka
        c *= (1 + 0.04 * (smooth_noise(u, h, 0.12) - 0.5))[:, None]
        e = np.zeros(len(wi), dtype=bool)
        paint_wall(room, 'z1', u, h, c, e)
        col[wi] = c
        t[wi] = tw[wi]
        nrm[wi] = (0, 0, -1)
        emit[wi] = e
        ao[wi] = (1 - 0.3 * np.exp(-h / 0.4)).astype(F)

    st = dict(t=t, col=col, nrm=nrm, ao=ao, emit=emit, obj=np.zeros(n, dtype=bool))
    hit_boxes(d, cy, room['boxes'], st)
    hit_spheres(d, cy, room.get('spheres', []), st)

    ndl = np.clip((st['nrm'] * SUN[None, :]).sum(axis=1), 0, 1)
    inten = 0.62 + 0.55 * ndl
    out = st['col'] * (inten * st['ao'])[:, None]
    out = np.where(st['emit'][:, None], st['col'], out)
    return out


# ---------------------------------------------------------------- definície miestností
def box(x0, x1, y0, y1, z0, z1, col, **kw):
    return dict(min=(x0, y0, z0), max=(x1, y1, z1), col=col, **kw)


def room_living():
    r = dict(name='obyvacka', x0=-3.2, x1=3.2, z0=-2.6, z1=2.6, H=2.7, light=(0.6, 2.55, -0.5),
             wall_cols=dict(x0='#c8d3c6', x1='#c8d3c6', z0='#d7dccd', z1='#bfcdc2'),
             floor=lambda px, pz: floor_parquet(px, pz, hexc('#b98b57')),
             rug=dict(c=(-1.65, -0.9), r=(1.45, 1.1), c1='#b4573d', c2='#e6c58b', c3='#e6c58b'))
    r['features'] = {
        'z1': [dict(kind='door', u0=-2.075, u1=-1.125, h0=0, h1=2.1, col='#e9e4da', handle='right'),
               dict(kind='decal', u0=-2.28, u1=-0.92, h0=2.2, h1=2.5, img=make_sign('Kuchyňa')),
               dict(kind='window', u0=0.9, u1=2.5, h0=0.95, h1=2.15)],
        'x1': [dict(kind='door', u0=-1.275, u1=-0.325, h0=0, h1=2.1, col='#e9e4da', handle='left'),
               dict(kind='decal', u0=-1.48, u1=-0.12, h0=2.2, h1=2.5, img=make_sign('Spálňa')),
               dict(kind='rect', u0=0.4, u1=1.7, h0=1.3, h1=2.0, col='#e9d6a7', bands=['#d96f4a', '#e9d6a7', '#4f7c82'], border='#2b2f33')],
        'z0': [dict(kind='glassdoor', u0=-1.4, u1=0.4, h0=0, h1=2.2, frame='#2e3438', fw=0.07, split=0.62, ground='#7fa66d'),
               dict(kind='decal', u0=-1.1, u1=0.1, h0=2.28, h1=2.56, img=make_sign('Terasa'))],
        'x0': [dict(kind='window', u0=-1.5, u1=0.45, h0=0.95, h1=2.15)],
    }
    r['boxes'] = [
        # sedačka pri ľavej stene
        box(-3.2, -2.25, 0.0, 0.45, -1.9, 0.1, '#2f5d62'),
        box(-3.2, -2.92, 0.45, 0.98, -1.9, 0.1, '#2a5156'),
        box(-3.2, -2.25, 0.0, 0.62, -1.9, -1.74, '#27494d'),
        box(-3.2, -2.25, 0.0, 0.62, -0.06, 0.1, '#27494d'),
        # konferenčný stolík
        box(-2.05, -1.15, 0.36, 0.41, -1.3, -0.5, '#6e4a2e'),
        box(-2.0, -1.92, 0.0, 0.36, -1.25, -1.17, '#3a2a1c'),
        box(-1.28, -1.20, 0.0, 0.36, -1.25, -1.17, '#3a2a1c'),
        box(-2.0, -1.92, 0.0, 0.36, -0.63, -0.55, '#3a2a1c'),
        box(-1.28, -1.20, 0.0, 0.36, -0.63, -0.55, '#3a2a1c'),
        # TV skrinka a televízor pri pravej stene
        box(2.72, 3.2, 0.0, 0.5, -2.2, -0.2, '#d9d2c3'),
        box(3.12, 3.2, 0.95, 1.65, -1.9, -0.5, '#14171a'),
        # polica pri zadnej stene
        box(-3.0, -1.6, 0.0, 2.05, -2.6, -2.28, '#a8794a', stripes=(0, 0.14, '#7d5532')),
        # fotelka
        box(1.25, 2.15, 0.0, 0.42, -1.2, -0.4, '#d8a84a'),
        box(1.25, 2.15, 0.42, 0.9, -1.2, -1.0, '#c99a3e'),
        # kvetináč
        box(2.35, 2.85, 0.0, 0.4, -2.45, -1.95, '#c9b9a0'),
    ]
    r['spheres'] = [dict(c=(2.6, 0.9, -2.2), r=0.5, col='#4f8a48'),
                    dict(c=(2.45, 1.25, -2.1), r=0.34, col='#5d9a52'),
                    dict(c=(2.75, 1.15, -2.3), r=0.3, col='#478045')]
    r['doors'] = dict(kuchyna=('z1', -1.6, 1.05), spalna=('x1', -0.8, 1.05), terasa=('z0', -0.5, 1.05))
    return r


def room_kitchen():
    r = dict(name='kuchyna', x0=-2.1, x1=2.1, z0=-1.8, z1=1.8, H=2.7, light=(-0.3, 2.55, 0.0),
             wall_cols=dict(x0='#e9ece6', x1='#e9ece6', z0='#dfe6e2', z1='#e9ece6'),
             floor=lambda px, pz: floor_tiles(px, pz, hexc('#e8e6df'), hexc('#c9ccc8'), hexc('#a9aca9')),
             baseboard='#ffffff', amb=0.66, diff=0.6)
    r['features'] = {
        'z0': [dict(kind='door', u0=0.025, u1=0.975, h0=0, h1=2.1, col='#e9e4da', handle='left'),
               dict(kind='decal', u0=-0.18, u1=1.18, h0=2.2, h1=2.5, img=make_sign('Obývačka')),
               dict(kind='rect', u0=-1.7, u1=-0.7, h0=1.2, h1=1.9, col='#f2efe6', bands=['#3d6f8f', '#f2efe6', '#e0a23b'], border='#2b2f33')],
        'z1': [dict(kind='window', u0=0.6, u1=1.8, h0=1.1, h1=2.1)],
        'x1': [dict(kind='window', u0=-1.0, u1=0.2, h0=1.1, h1=2.1)],
    }
    r['boxes'] = [
        # spodné skrinky + pracovná doska (pri prednej stene)
        box(-2.1, 1.4, 0.0, 0.9, 1.15, 1.8, '#24415c', seams=(0, 0.6)),
        box(-2.1, 1.4, 0.9, 0.95, 1.1, 1.8, '#ece9e2'),
        # horné skrinky
        box(-2.1, 0.35, 1.5, 2.25, 1.5, 1.8, '#2b4a68', seams=(0, 0.6)),
        # chladnička
        box(1.45, 2.1, 0.0, 1.85, 1.1, 1.75, '#cfd3d6'),
        box(1.43, 2.1, 1.2, 1.24, 1.08, 1.75, '#9fa4a8'),
        # stôl so stoličkami (vpravo vzadu, ďalej od kamery)
        box(0.8, 1.8, 0.72, 0.77, -1.4, -0.4, '#b88d5a'),
        box(0.86, 0.94, 0.0, 0.72, -1.34, -1.26, '#5b4630'),
        box(1.66, 1.74, 0.0, 0.72, -1.34, -1.26, '#5b4630'),
        box(0.86, 0.94, 0.0, 0.72, -0.54, -0.46, '#5b4630'),
        box(1.66, 1.74, 0.0, 0.72, -0.54, -0.46, '#5b4630'),
        box(0.22, 0.68, 0.0, 0.46, -1.12, -0.68, '#e0a23b'),
        box(0.22, 0.30, 0.46, 0.95, -1.12, -0.68, '#d19a34'),
        box(1.05, 1.5, 0.0, 0.46, -0.32, 0.12, '#3d6f8f'),
        box(1.05, 1.5, 0.46, 0.95, 0.05, 0.12, '#356180'),
        box(1.29, 1.31, 2.05, 2.7, -0.91, -0.89, '#2b2f33'),
    ]
    r['spheres'] = [dict(c=(1.3, 1.88, -0.9), r=0.2, col='#ffe9b8', emit=True, gain=1.35),
                    dict(c=(1.3, 0.9, -0.9), r=0.11, col='#d94f3d')]
    r['doors'] = dict(obyvacka=('z0', 0.5, 1.05))
    return r


def room_bedroom():
    r = dict(name='spalna', x0=-2.1, x1=2.1, z0=-1.8, z1=1.8, H=2.7, light=(0.0, 2.55, 0.0),
             wall_cols=dict(x0='#dcc9c3', x1='#dcc9c3', z0='#e4d6d0', z1='#d3beb7'),
             floor=lambda px, pz: floor_parquet(px, pz, hexc('#d1b184'), var=0.06),
             rug=dict(c=(0.2, 0.0), r=(1.5, 1.2), c1='#e8e1d2', c2='#8f9f9a', c3='#e8e1d2'), amb=0.64)
    r['features'] = {
        'x0': [dict(kind='door', u0=0.225, u1=1.175, h0=0, h1=2.1, col='#e9e4da', handle='right'),
               dict(kind='decal', u0=0.02, u1=1.38, h0=2.2, h1=2.5, img=make_sign('Obývačka'))],
        'z0': [dict(kind='window', u0=-0.8, u1=0.8, h0=0.85, h1=2.15, fw=0.06)],
        'x1': [dict(kind='rect', u0=-0.6, u1=0.6, h0=1.55, h1=2.1, col='#f2efe6', bands=['#8f9f9a', '#e8c9a0', '#c46f55'], border='#2b2f33')],
    }
    r['boxes'] = [
        # posteľ s čelom pri pravej stene
        box(0.5, 2.1, 0.0, 0.42, -1.0, 1.0, '#5a4636'),
        box(0.52, 2.08, 0.42, 0.6, -0.98, 0.98, '#efece4'),
        box(0.9, 2.08, 0.6, 0.66, -0.98, 0.98, '#c0824e'),
        box(1.92, 2.1, 0.0, 1.25, -1.1, 1.1, '#6b543f'),
        box(1.62, 2.0, 0.6, 0.76, -0.85, -0.1, '#f7f5ef'),
        box(1.62, 2.0, 0.6, 0.76, 0.1, 0.85, '#f7f5ef'),
        # nočné stolíky a lampy
        box(1.7, 2.1, 0.0, 0.5, 1.08, 1.55, '#8a6a49'),
        box(1.7, 2.1, 0.0, 0.5, -1.55, -1.08, '#8a6a49'),
        # skriňa pri prednej stene
        box(-1.8, 0.2, 0.0, 2.3, 1.35, 1.8, '#c9a77c', seams=(0, 0.5)),
        # závesy
        box(-1.1, -0.82, 0.3, 2.35, -1.8, -1.66, '#efe6d6'),
        box(0.82, 1.1, 0.3, 2.35, -1.8, -1.66, '#efe6d6'),
    ]
    r['spheres'] = [dict(c=(1.9, 0.68 + 0.5, 1.3), r=0.16, col='#fff0c8', emit=True, gain=1.3),
                    dict(c=(1.9, 0.68 + 0.5, -1.3), r=0.16, col='#fff0c8', emit=True, gain=1.3),
                    dict(c=(-1.7, 0.45, -1.25), r=0.38, col='#5c8e52'),
                    dict(c=(-1.72, 0.85, -1.25), r=0.26, col='#6ca35f')]
    r['boxes'].append(box(-1.95, -1.45, 0.0, 0.18, -1.5, -1.0, '#c9b9a0'))
    r['doors'] = dict(obyvacka=('x0', 0.7, 1.05))
    return r


def room_terrace():
    r = dict(name='terasa', kind='outdoor', z0=-2.0, z1=2.0, deck_x=2.9, wall_h=3.5, light=(0, 3, 0),
             wall_cols=dict(z1='#e7e1d4', x0='#e7e1d4', x1='#e7e1d4', z0='#e7e1d4'), baseboard='#cfc8b8')
    r['features'] = {
        'z1': [dict(kind='glassdoor', u0=-0.9, u1=0.9, h0=0, h1=2.2, frame='#2e3438', fw=0.07, split=0.62, ground='#6a5a4e'),
               dict(kind='decal', u0=-0.62, u1=0.62, h0=2.3, h1=2.58, img=make_sign('Obývačka')),
               dict(kind='window', u0=1.5, u1=2.7, h0=1.0, h1=2.2, ground='#6a5a4e', fw=0.06),
               dict(kind='window', u0=-2.7, u1=-1.5, h0=1.0, h1=2.2, ground='#6a5a4e', fw=0.06)],
    }
    boxes = []
    # zábradlie: ľavá, pravá a predná strana
    for sx in (-2.9, 2.9):
        boxes.append(box(sx - 0.03, sx + 0.03, 0.96, 1.02, -2.0, 2.0, '#d9d5cc'))
        boxes.append(box(sx - 0.015, sx + 0.015, 0.35, 0.38, -2.0, 2.0, '#d9d5cc'))
        for zz in np.arange(-2.0, 2.01, 0.8):
            boxes.append(box(sx - 0.04, sx + 0.04, 0.0, 1.02, zz - 0.04, zz + 0.04, '#cfcac0'))
    boxes.append(box(-2.9, 2.9, 0.96, 1.02, -2.03, -1.97, '#d9d5cc'))
    boxes.append(box(-2.9, 2.9, 0.35, 0.38, -2.015, -1.985, '#d9d5cc'))
    for xx in np.arange(-2.9, 2.91, 0.8):
        boxes.append(box(xx - 0.04, xx + 0.04, 0.0, 1.02, -2.04, -1.96, '#cfcac0'))
    # stôl a stoličky
    boxes += [box(1.35, 2.55, 0.72, 0.76, -1.35, -0.15, '#6f5a45'),
              box(1.42, 1.48, 0.0, 0.72, -1.28, -1.22, '#2e3438'), box(2.42, 2.48, 0.0, 0.72, -1.28, -1.22, '#2e3438'),
              box(1.42, 1.48, 0.0, 0.72, -0.28, -0.22, '#2e3438'), box(2.42, 2.48, 0.0, 0.72, -0.28, -0.22, '#2e3438'),
              box(1.75, 2.2, 0.0, 0.44, 0.12, 0.58, '#e07a3f'), box(1.75, 2.2, 0.44, 0.9, 0.52, 0.58, '#cf6d36'),
              box(1.75, 2.2, 0.0, 0.44, -1.9, -1.45, '#e07a3f'), box(1.75, 2.2, 0.44, 0.9, -1.9, -1.84, '#cf6d36'),
              # odkvap strechy nad stenou
              box(-40, 40, 3.5, 3.85, 1.55, 2.0, '#d8d2c4'),
              # lehátko
              box(-2.55, -1.85, 0.0, 0.34, -1.3, 0.2, '#efe9dc'), box(-2.55, -1.85, 0.34, 0.9, 0.05, 0.2, '#e5dfd2'),
              # kvetináče pri stene
              box(-0.75, -0.25, 0.0, 0.45, 1.35, 1.85, '#b9a98f'), box(0.55, 1.05, 0.0, 0.45, 1.4, 1.9, '#b9a98f')]
    r['boxes'] = boxes
    spheres = [dict(c=(-0.5, 0.95, 1.6), r=0.5, col='#4f8a48'), dict(c=(-0.62, 1.4, 1.55), r=0.32, col='#5d9a52'),
               dict(c=(0.8, 0.95, 1.65), r=0.46, col='#5e9650'), dict(c=(0.9, 1.35, 1.6), r=0.3, col='#4b8244')]
    # stromy vo vzdialenosti
    rng = np.random.RandomState(7)
    for i in range(9):
        a = rng.uniform(-math.pi, math.pi)
        if abs(a) < 0.45:  # za domom nič
            a += 1.0
        dist = rng.uniform(9, 20)
        tx, tz = math.sin(a) * dist, math.cos(a) * dist
        hgt = rng.uniform(2.2, 3.6)
        spheres.append(dict(c=(tx, hgt, tz), r=rng.uniform(1.4, 2.2), col='#4a7a3f' if i % 2 else '#5a8a47'))
        r['boxes'].append(box(tx - 0.12, tx + 0.12, 0.0, hgt, tz - 0.12, tz + 0.12, '#5a4636'))
    r['spheres'] = spheres
    r['doors'] = dict(obyvacka=('z1', 0.0, 1.05))
    return r


ROOMS = dict(obyvacka=room_living, kuchyna=room_kitchen, spalna=room_bedroom, terasa=room_terrace)


# ---------------------------------------------------------------- vykresľovanie
def render(room, W, Hh, ss=2, strip=64):
    img = np.zeros((Hh, W, 3), dtype=np.float32)
    cols = (np.arange(W * ss) + 0.5) / (W * ss)
    yaw = (cols - 0.5) * 2 * np.pi
    shade = shade_terrace if room.get('kind') == 'outdoor' else shade_room
    for r0 in range(0, Hh, strip):
        r1 = min(r0 + strip, Hh)
        rows = (np.arange(r0 * ss, r1 * ss) + 0.5) / (Hh * ss)
        pitch = (0.5 - rows) * np.pi
        cp = np.cos(pitch)[:, None]
        d = np.stack([np.sin(yaw)[None, :] * cp, np.sin(pitch)[:, None] * np.ones_like(yaw)[None, :],
                      np.cos(yaw)[None, :] * cp], axis=-1).reshape(-1, 3).astype(F)
        c = shade(room, d).reshape((r1 - r0) * ss, W * ss, 3)
        c = c.reshape(r1 - r0, ss, W, ss, 3).mean(axis=(1, 3))
        img[r0:r1] = c
        print(f'\r  {room["name"]}: {int(100 * r1 / Hh)} %', end='', flush=True)
    print()
    # jemná tonálna krivka + gamma
    img = 1 - np.exp(-1.25 * np.clip(img, 0, 4))
    img = np.clip(img, 0, 1) ** (1 / 1.05)
    return (img * 255 + 0.5).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'panoramas'))
    ap.add_argument('--fast', action='store_true', help='rýchly náhľad 1024x512 bez supersamplingu')
    ap.add_argument('--only', nargs='*', help='vykresliť len vybrané miestnosti')
    ap.add_argument('--quality', type=int, default=82)
    args = ap.parse_args()
    W, Hh, ss = (1024, 512, 1) if args.fast else (4096, 2048, 2)
    os.makedirs(os.path.join(args.out, 'thumbs'), exist_ok=True)
    info = {}
    for name, maker in ROOMS.items():
        if args.only and name not in args.only:
            continue
        room = maker()
        arr = render(room, W, Hh, ss)
        im = Image.fromarray(arr)
        im.save(os.path.join(args.out, f'{name}.jpg'), quality=args.quality, optimize=True, progressive=True)
        im.resize((320, 160), Image.LANCZOS).save(os.path.join(args.out, 'thumbs', f'{name}.jpg'), quality=80, optimize=True)
        # súradnice dverí (smer z kamery)
        doors = {}
        for target, (w, u, h) in room['doors'].items():
            x, y, z = wall_point(room, w, u, h) if room.get('kind') != 'outdoor' else (u, h, room['z1'])
            yaw, pitch = to_yaw_pitch((x, y - room.get('cam_y', 1.5), z))
            doors[target] = dict(yaw=round(yaw, 1), pitch=round(pitch, 1))
        info[name] = doors
        size = os.path.getsize(os.path.join(args.out, f'{name}.jpg')) / 1024
        print(f'  {name}.jpg {size:.0f} kB  dvere: {doors}')
    print(json.dumps(info, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
