# Split the painted pendulum needle off the metronome head: head.png without it, needle.png on its own.
import numpy as np
from PIL import Image, ImageDraw
src = Image.open('fighter/art/build/head-orig.png').convert('RGBA')
W, H = src.size
mask = Image.new('L', (W, H), 0)
d = ImageDraw.Draw(mask)
d.line([(195.5, 199), (229, 89)], fill=255, width=8)
d.polygon([(201, 110), (235, 115), (232, 139), (200, 134)], fill=255)
d.ellipse([(221, 80), (237, 96)], fill=255)
m = np.array(mask) > 0
a = np.array(src)
nd = a.copy(); nd[~m, 3] = 0
ys, xs = np.nonzero(nd[:, :, 3] > 10)
x0, x1, y0, y1 = xs.min() - 2, xs.max() + 3, ys.min() - 2, ys.max() + 3
Image.fromarray(nd[y0:y1, x0:x1]).save('fighter/parts/needle.png')
print('needle crop origin', x0, y0, 'size', x1 - x0, y1 - y0, 'pivot', 195.5 - x0, 199 - y0, 'tip', 229 - x0, 89 - y0)
# fill by region: outside / frame outline / red frame / panel / scale strip
from PIL import ImageFilter
mm = np.array(Image.fromarray(m.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(3))) > 0
out = a.copy()
xi = lambda y: 203 + 0.255 * (y - 100)
xo = lambda y: 213 + 0.31 * (y - 100)
xs_ = lambda y: 192 + 0.15 * (y - 100)
rng = np.random.default_rng(7)
patch = a[105:185, 156:170].reshape(-1, 4)
def along(y, x, slope, ok):
    for k in range(1, 120):
        for s in (-1, 1):
            yy = y + s * k
            xx = int(round(x + slope * (yy - y)))
            if 0 <= yy < H and 0 <= xx < W and not mm[yy, xx] and ok(yy, xx):
                return a[yy, xx]
    return a[y, x]
for y, x in zip(*np.nonzero(mm)):
    vo = x - xo(y); vi = x - xi(y)
    if vo > 0.5: out[y, x] = (0, 0, 0, 0)
    elif vo > -2: out[y, x] = (28, 9, 5, 255)
    elif vi > 1.5:
        t = (x - xi(y)) / (xo(y) - xi(y))
        for k in range(1, 120):
            got = None
            for s in (-1, 1):
                yy = y + s * k
                if not (0 <= yy < 197): continue
                xx = int(round(xi(yy) + t * (xo(yy) - xi(yy))))
                if not mm[yy, xx]: got = a[yy, xx]; break
            if got is not None: out[y, x] = got; break
    elif vi > -1.5: out[y, x] = (20, 8, 4, 255)
    elif x < xs_(y) + 1: out[y, x] = along(y, x, 0.15, lambda yy, xx: yy < 197)
    else: out[y, x] = along(y, x, 0.28, lambda yy, xx: yy < 197 and xs_(yy) + 2 < xx < xi(yy) - 2)
Image.fromarray(out).save('fighter/parts/head.png')
bg = Image.new('RGBA', (W, H), (40, 40, 48, 255)); bg.alpha_composite(Image.fromarray(out))
bg.crop((140, 60, 270, 240)).resize((390, 540), Image.LANCZOS).save('out/head-noneedle.png')
