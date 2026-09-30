"""Native 16x16 cardinal4 ground tiles. Requires Python 3 and Pillow."""
from pathlib import Path
import json
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
PALETTE = json.loads((ROOT / 'client/assets/manifest.json').read_text())['palette']
FILL = PALETTE['terrain']
EDGE = PALETTE['terrainEdge']
SHADOW = PALETTE['sky']


def tile(mask):
    """Bits indicate solid neighbours: N=1, E=2, S=4, W=8."""
    im = Image.new('RGBA', (16, 16), FILL)
    d = ImageDraw.Draw(im)
    n, e, s, w = (bool(mask & bit) for bit in (1, 2, 4, 8))

    # All detail follows exposed faces; connected interiors have no tile grid.
    if not s:
        d.rectangle((0, 14, 15, 15), fill=SHADOW)
        d.line((3, 13, 6, 13), fill=SHADOW)
        d.line((11, 13, 12, 13), fill=SHADOW)
    if not e:
        d.rectangle((14, 0, 15, 15), fill=SHADOW)
        d.line((13, 7, 13, 9), fill=SHADOW)
    if not w:
        d.line((0, 0, 0, 15), fill=EDGE)
        d.line((1, 4, 1, 7), fill=EDGE)
        d.line((1, 12, 1, 13), fill=EDGE)
    if not n:
        # Continuous walkable rim, with a shallow, chipped underside.
        d.rectangle((0, 0, 15, 1), fill=EDGE)
        d.line((2, 2, 6, 2), fill=EDGE)
        d.line((10, 2, 13, 2), fill=EDGE)
        d.point((4, 3), fill=EDGE)
        d.line((8, 5, 10, 5), fill=SHADOW)
        d.point((11, 6), fill=SHADOW)
    return im


TILES = [tile(mask) for mask in range(16)]
strip = Image.new('RGBA', (256, 16))
for mask, im in enumerate(TILES):
    strip.paste(im, (mask * 16, 0))
out = ROOT / 'client/assets/tiles/solid.png'
out.parent.mkdir(parents=True, exist_ok=True)
strip.save(out)


def terrain(rows):
    width = max(map(len, rows))
    im = Image.new('RGBA', (width * 16, len(rows) * 16))
    def occupied(x, y):
        return 0 <= y < len(rows) and 0 <= x < len(rows[y]) and rows[y][x] == '#'
    for y, row in enumerate(rows):
        for x, char in enumerate(row):
            if char != '#':
                continue
            mask = sum(bit for bit, dx, dy in ((1, 0, -1), (2, 1, 0), (4, 0, 1), (8, -1, 0))
                       if occupied(x + dx, y + dy))
            im.paste(TILES[mask], (x * 16, y * 16))
    return im


def enlarged(im, scale):
    return im.resize((im.width * scale, im.height * scale), Image.Resampling.NEAREST)


# A mock level composition for style review, not a game screenshot.
scene = Image.new('RGBA', (320, 176), PALETTE['sky'])
layout = [
    '....................',
    '....................',
    '....................',
    '..............####..',
    '..............####..',
    '..........##...##...',
    '..........##........',
    '..######..####......',
    '..######....##......',
    '########....########',
    '########....########',
]
ground = terrain(layout)
scene.alpha_composite(ground)
player = Image.open(ROOT / 'client/assets/sprites/player/idle.png').convert('RGBA').crop((0, 0, 24, 24))
scene.alpha_composite(player, (68, 7 * 16 - 24))
scene.alpha_composite(player, (244, 3 * 16 - 24))
enlarged(scene, 3).save(HERE / 'solid-scene.png')

review = Image.new('RGB', (960, 832), PALETTE['sky'])
d = ImageDraw.Draw(review)
d.text((24, 16), 'SOLID GROUND / slate rock / native 16 x 16 / cardinal4 autotiles', fill=PALETTE['player'])
review.paste(enlarged(scene, 3), (0, 40))
d.text((24, 592), 'ALL 16 NEIGHBOUR MASKS / N=1 E=2 S=4 W=8 / enlarged 4x', fill=PALETTE['player'])
for mask, im in enumerate(TILES):
    x, y = 24 + (mask % 8) * 116, 616 + (mask // 8) * 104
    review.paste(enlarged(im, 4), (x, y))
    d.text((x, y + 68), f'{mask:02d}', fill=PALETTE['ghost'])
review.save(HERE / 'solid-review.png')

# Irregular joins, holes, isolated blocks, pillars and thin ledges.
blob = terrain([
    '..####........#...',
    '.######.#.....#...',
    '########......#...',
    '##.####...........',
    '.#######..######..',
    '...##.............',
])
blob_bg = Image.new('RGBA', blob.size, PALETTE['sky'])
blob_bg.alpha_composite(blob)
enlarged(blob_bg, 4).save(HERE / 'solid-joins.png')

assert strip.size == (256, 16)
assert set(strip.getchannel('A').getdata()) == {255}
allowed = {tuple(bytes.fromhex(c[1:])) for c in (FILL, EDGE, SHADOW)}
assert all(p[:3] in allowed for p in strip.getdata())
# A filled rectangle must have a calm interior without internal tile borders.
assert set(TILES[15].getdata()) == {tuple(bytes.fromhex(FILL[1:])) + (255,)}
print(out)
