import sys
from PIL import Image, ImageDraw
out, items = sys.argv[1], sys.argv[2:]
ims = []
for it in items:
    f, label = it.split('|')
    im = Image.open(f).convert('RGBA'); ims.append((im, label))
H = max(i.height for i, _ in ims) + 30
W = sum(i.width for i, _ in ims) + 10 * len(ims)
sheet = Image.new('RGBA', (W, H), (70, 74, 82, 255))
d = ImageDraw.Draw(sheet)
x = 0
for im, label in ims:
    y = H - 30 - im.height
    sheet.alpha_composite(im, (x, y))
    d.line([(x, H - 30), (x + im.width, H - 30)], fill=(200, 200, 200), width=1)
    d.text((x + 4, H - 24), label, fill=(255, 255, 255))
    x += im.width + 10
sheet.save(out)
print(out, sheet.size)
