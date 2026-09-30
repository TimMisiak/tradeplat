"""Native pixel trade-post assets and review sheet. Requires Python/Pillow."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageChops

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
P = json.loads((ROOT / 'client/assets/manifest.json').read_text())['palette']


def tile(kind, mask):
    floor = kind == 'postfloor'
    im = Image.new('RGBA', (16, 16), P['postFloor' if floor else 'postWall'])
    d = ImageDraw.Draw(im)
    n, e, s, w = (bool(mask & b) for b in (1, 2, 4, 8))
    # Broad timber faces: detail is confined to exposed edges so interiors join.
    if not s:
        d.rectangle((0, 14, 15, 15), fill=P['postWall'] if floor else P['uiPanel'])
    if not e:
        d.line((15, 0, 15, 15), fill=P['uiPanel'])
    if not w:
        d.line((0, 0, 0, 15), fill=P['oneWay'] if floor else P['postFloor'])
    if not n:
        d.rectangle((0, 0, 15, 1), fill=P['oneWay'])
        if floor:
            d.line((2, 3, 6, 3), fill=P['postWall'])
            d.line((11, 4, 14, 4), fill=P['postWall'])
        else:
            d.line((0, 2, 15, 2), fill=P['postFloor'])
    # Iron pins on free corners; none within an uninterrupted filled area.
    for x, exposed in ((2, not w), (13, not e)):
        if exposed and not n:
            d.point((x, 4), fill=P['terrainEdge'])
        if exposed and not s:
            d.point((x, 12), fill=P['terrainEdge'])
    return im


def sign():
    im = Image.new('RGBA', (32, 16))
    d = ImageDraw.Draw(im)
    # Neutral values are multiplied by each post's identity color at draw time.
    for x in (6, 25):
        d.line((x, 0, x, 4), fill='#a0a0a0')
    d.rectangle((1, 3, 30, 14), fill='#202020')
    d.rectangle((2, 4, 29, 13), fill='#808080')
    d.line((2, 4, 29, 4), fill='#c0c0c0')
    # Two opposing arrows communicate exchange without tiny lettering.
    d.line((7, 7, 23, 7), fill='#ffffff', width=1)
    d.line((21, 5, 23, 7), fill='#ffffff')
    d.line((23, 7, 21, 9), fill='#ffffff')
    d.line((8, 11, 24, 11), fill='#ffffff', width=1)
    d.line((10, 9, 8, 11), fill='#ffffff')
    d.line((8, 11, 10, 13), fill='#ffffff')
    return im


def save(im, relative):
    out = ROOT / 'client/assets' / relative
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out)
    print(out)


tiles = {}
for kind in ('postfloor', 'postwall'):
    tiles[kind] = [tile(kind, m) for m in range(16)]
    strip = Image.new('RGBA', (256, 16))
    for m, im in enumerate(tiles[kind]):
        strip.paste(im, (m * 16, 0))
    save(strip, f'tiles/{kind}.png')
sign_im = sign()
save(sign_im, 'sprites/postsign/idle.png')


def tinted(color):
    im = ImageChops.multiply(sign_im, Image.new('RGBA', sign_im.size, color))
    im.putalpha(sign_im.getchannel('A'))
    return im


def structure(rows):
    im = Image.new('RGBA', (max(map(len, rows)) * 16, len(rows) * 16))
    for y, row in enumerate(rows):
        for x, c in enumerate(row):
            if c not in 'WF':
                continue
            mask = 0
            for bit, dx, dy in ((1, 0, -1), (2, 1, 0), (4, 0, 1), (8, -1, 0)):
                xx, yy = x + dx, y + dy
                if 0 <= yy < len(rows) and 0 <= xx < len(rows[yy]) and rows[yy][xx] == c:
                    mask |= bit
            im.alpha_composite(tiles['postwall' if c == 'W' else 'postfloor'][mask], (x * 16, y * 16))
    return im


review = Image.new('RGB', (960, 864), P['sky'])
d = ImageDraw.Draw(review)
d.text((24, 16), 'TRADE POSTS / native pixels / timber floor + walls + tintable exchange sign', fill=P['player'])
scene = Image.new('RGBA', (304, 112), P['sky'])
building = structure(['WWWWWWWW', 'W......W', 'W......W', 'W......W', 'FFFFFFFF'])
player = Image.open(ROOT / 'client/assets/sprites/player/idle.png').convert('RGBA').crop((0, 0, 24, 24))
for x, color in ((8, P['posts'][0]), (168, P['posts'][1])):
    scene.alpha_composite(building, (x, 16))
    scene.alpha_composite(tinted(color), (x + 48, 32))
    scene.alpha_composite(player, (x + 52, 56))
review.paste(scene.resize((912, 336), Image.Resampling.NEAREST), (24, 40))
d.text((24, 382), 'MOCK STRUCTURES / color identity preview (not a gameplay screenshot)', fill=P['ghost'])
for row, kind in enumerate(('postfloor', 'postwall')):
    y = 418 + row * 104
    d.text((24, y), kind.upper() + ' / all 16 masks: N=1 E=2 S=4 W=8', fill=P['player'])
    for mask, im in enumerate(tiles[kind]):
        x = 24 + mask * 57
        review.paste(im.resize((48, 48), Image.Resampling.NEAREST), (x, y + 20))
        d.text((x, y + 72), str(mask), fill=P['ghost'])
d.text((24, 634), 'SIGN / neutral source + post color previews / 32 x 16 / anchor 16,16', fill=P['player'])
for i, im in enumerate([sign_im] + [tinted(c) for c in P['posts'][:4]]):
    large = im.resize((160, 80), Image.Resampling.NEAREST)
    review.paste(large, (24 + i * 184, 660), large)
joins = structure(['..WW..W..FFFF..', '.WWWW.W..F..F.', '.W.WW.W..FFFF.', '..WW..........'])
review.paste(joins.resize((448, 128), Image.Resampling.NEAREST), (24, 736), joins.resize((448, 128), Image.Resampling.NEAREST))
d.text((496, 778), 'Join check: corners, holes, pillar, floor ring', fill=P['ghost'])
review.save(HERE / 'posts-review.png')
