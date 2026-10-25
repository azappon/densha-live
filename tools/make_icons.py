"""Render the app icons. Run:  uv run --no-project --with pillow python -I tools/make_icons.py"""
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / 'public' / 'icons'
S = 2048  # drawn at 2x and downsampled for smooth edges


def bezier(p0, p1, p2, p3, n=900):
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        pts.append((u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
                    u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1]))
    return pts


def stroke(d, pts, width, fill):
    r = width / 2
    for x, y in pts:
        d.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def crossing(a, b):
    best = min(((p, q) for p in a[::3] for q in b[::3]), key=lambda pq: math.dist(*pq))
    return ((best[0][0] + best[1][0]) / 2, (best[0][1] + best[1][1]) / 2)


def draw_icon(size, maskable=False):
    img = Image.new('RGBA', (S, S))
    d = ImageDraw.Draw(img)
    for y in range(S):
        t = y / S
        d.line([(0, y), (S, y)], fill=(int(22 + 14 * t), int(25 + 16 * t), int(34 + 22 * t), 255))
    scale = (0.74 if maskable else 1.0) * 2

    def P(x, y):
        return (S / 2 + (x - 512) * scale, S / 2 + (y - 512) * scale)

    ctrl = {
        'red': ('#EF4135', [(-80, 720), (300, 700), (560, 380), (1110, 330)]),
        'green': ('#80C342', [(-80, 400), (330, 410), (540, 650), (1110, 650)]),
        'blue': ('#0A84FF', [(250, -80), (280, 380), (720, 520), (770, 1110)]),
    }
    curves = {k: [P(*p) for p in bezier(*c)] for k, (_, c) in ctrl.items()}
    w = 66 * scale
    for k in curves:
        stroke(d, curves[k], w + 30 * scale, '#0d0f14')
    for k, (color, _) in ctrl.items():
        stroke(d, curves[k], w, color)
    # Station dots at two crossings
    for a, b in (('green', 'blue'), ('red', 'blue')):
        x, y = crossing(curves[a], curves[b])
        r = 34 * scale
        d.ellipse([x - r, y - r, x + r, y + r], fill='#ffffff', outline='#0d0f14', width=int(13 * scale))
    # Train capsule on the red line with a soft shadow
    path = curves['red']
    k = int(len(path) * 0.74)
    (x0, y0), (x1, y1) = path[k - 20], path[k + 20]
    ang = math.degrees(math.atan2(y1 - y0, x1 - x0))
    tx, ty = path[k]
    L, W = 150 * scale, 66 * scale
    cap = Image.new('RGBA', (S, S))
    cd = ImageDraw.Draw(cap)
    c = S / 2
    cd.rounded_rectangle([c - L, c - W, c + L, c + W], radius=W, fill='#ffffff')
    b = 15 * scale
    cd.rounded_rectangle([c - L + b, c - W + b, c + L - b, c + W - b], radius=W - b, fill='#EF4135')
    nr, nx = 25 * scale, c + L - W
    cd.ellipse([nx - nr, c - nr, nx + nr, c + nr], fill='#ffffff')
    cap = cap.rotate(-ang, resample=Image.BICUBIC, center=(c, c))
    shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 150), mask=cap.split()[3])
    shadow = shadow.filter(ImageFilter.GaussianBlur(28))
    ox, oy = int(tx - c), int(ty - c)
    img.alpha_composite(shadow, (ox + 10, oy + 24))
    img.alpha_composite(cap, (ox, oy))
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    draw_icon(180).convert('RGB').save(OUT / 'apple-touch-icon.png')
    draw_icon(192).save(OUT / 'icon-192.png')
    draw_icon(512).save(OUT / 'icon-512.png')
    draw_icon(512, maskable=True).save(OUT / 'icon-maskable-512.png')
    print('icons written to', OUT)


if __name__ == '__main__':
    main()
