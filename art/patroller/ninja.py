"""Native pixel ninja, extending the project's Python/Pillow sprite sources."""
from pathlib import Path
import json
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
P = json.loads((ROOT / 'client/assets/manifest.json').read_text())['palette']
SIZE = (32, 24)
ANCHOR = (12, 24)


def limb(d, points, color='terrain'):
    d.line(points, fill=P['uiPanel'], width=4)
    d.line(points, fill=P[color], width=2)


def frame(pose):
    im = Image.new('RGBA', SIZE)
    d = ImageDraw.Draw(im)
    attack = pose in ('windup', 'extended')
    low = pose in (1, 3, 'extended')
    y = int(low)
    # Broad, level hood: readable as a stompable top, dark suit with orange ties.
    d.rectangle((8, 8 + y, 15, 14 + y), fill=P['uiPanel'])
    d.rectangle((7, 9 + y, 16, 13 + y), fill=P['uiPanel'])
    d.rectangle((9, 9 + y, 14, 13 + y), fill=P['terrain'])
    d.line((9, 9 + y, 14, 9 + y), fill=P['terrainEdge'])
    d.line((8, 10 + y, 15, 10 + y), fill=P['enemy'])
    d.line((12, 11 + y, 15, 11 + y), fill=P['uiPanel'])
    d.point((13, 11 + y), fill=P['player'])
    d.point((15, 11 + y), fill=P['player'])
    d.line((6, 11 + y, 7, 11 + y), fill=P['enemy'])
    d.point((5, 12 + y), fill=P['enemy'])
    # Minimal tunic, with a single orange sash.
    d.rectangle((9, 14 + y, 14, 19), fill=P['uiPanel'])
    d.rectangle((10, 14 + y, 13, 18), fill=P['terrain'])
    d.line((9, 18, 14, 18), fill=P['enemy'])
    if attack:
        feet = ((7, 23), (16, 23))
    else:
        feet = [((7, 23), (16, 23)), ((10, 23), (13, 22)),
                ((16, 23), (7, 23)), ((13, 22), (10, 23))][pose]
    for hip, foot in zip(((10, 20), (13, 20)), feet):
        limb(d, [hip, foot])
        d.line((foot[0] - 1, foot[1], foot[0] + 1, foot[1]), fill=P['uiPanel'])
    if pose == 'windup':
        # Sword held over the shoulder. Room above the hood is intentional.
        limb(d, [(14, 16), (17, 12), (14, 7)])
        d.line((5, 3, 14, 6), fill=P['uiPanel'], width=3)
        d.line((5, 3, 13, 6), fill=P['ghost'])
        d.line((5, 2, 12, 5), fill=P['player'])
        d.line((13, 5, 15, 7), fill=P['postFloor'])
        d.line((12, 7, 14, 4), fill=P['money'])
        limb(d, [(9, 15), (8, 17)])
    elif pose == 'extended':
        limb(d, [(14, 16), (19, 16)])
        d.line((19, 16, 22, 16), fill=P['postFloor'])
        d.line((22, 14, 22, 18), fill=P['money'])
        d.polygon([(23, 14), (30, 14), (31, 15), (30, 17), (23, 17)], fill=P['uiPanel'])
        d.line((23, 15, 30, 15), fill=P['player'])
        d.line((23, 16, 29, 16), fill=P['ghost'])
        limb(d, [(9, 16), (7, 18)])
    else:
        # Compact carried blade fits within the walking body's footprint.
        limb(d, [(14, 15 + y), (16, 17 + y)])
        d.line((17, 14 + y, 17, 19 + y), fill=P['uiPanel'], width=3)
        d.line((17, 14 + y, 17, 18 + y), fill=P['ghost'])
        d.line((16, 19 + y, 18, 19 + y), fill=P['postFloor'])
        limb(d, [(9, 15 + y), (7 + (pose % 2), 17 + y)])
    return im


walk = [frame(i) for i in range(4)]
swing = [frame(p) for p in ('windup', 'extended')]
out = ROOT / 'client/assets/sprites/patroller'
out.mkdir(parents=True, exist_ok=True)
for name, frames in [('walk', walk), ('swing', swing)]:
    sheet = Image.new('RGBA', (SIZE[0] * len(frames), SIZE[1]))
    for i, im in enumerate(frames):
        sheet.paste(im, (i * SIZE[0], 0))
    sheet.save(out / f'{name}.png')
    print(out / f'{name}.png')


def zoom(im, scale):
    return im.resize((im.width * scale, im.height * scale), Image.Resampling.NEAREST)


review = Image.new('RGB', (960, 660), P['sky'])
d = ImageDraw.Draw(review)
d.text((24, 18), 'NINJA PATROLLER / native pixels / 32 x 24 canvas / feet anchor 12,24', fill=P['player'])
d.text((24, 44), 'WALK / four frames / 8 fps', fill=P['ghost'])
for i, im in enumerate(walk):
    x = 24 + i * 232
    review.paste(zoom(im, 6), (x, 72), zoom(im, 6))
    d.line((x, 216, x + 191, 216), fill=P['terrainEdge'])
    d.text((x, 228), str(i + 1), fill=P['ghost'])
for i, (label, im) in enumerate(zip(('WIND UP', 'FULL EXTENSION'), swing)):
    x = 24 + i * 280
    d.text((x, 270), label, fill=P['player'])
    review.paste(zoom(im, 8), (x, 294), zoom(im, 8))
    d.line((x, 486, x + 255, 486), fill=P['terrainEdge'])
    # Anchor reference below the ground line, outside the artwork.
    d.line((x + 96, 488, x + 96, 493), fill=P['uiAccent'])
player = Image.open(ROOT / 'client/assets/sprites/player/idle.png').convert('RGBA').crop((0, 0, 24, 24))
d.text((620, 270), 'COURIER / SIZE COMPARISON', fill=P['ghost'])
review.paste(zoom(player, 8), (620, 294), zoom(player, 8))
d.line((620, 486, 812, 486), fill=P['terrainEdge'])
d.text((24, 526), 'Dark hood + suit / orange headband and sash / gray blade / all frames face right', fill=P['player'])
d.text((24, 548), 'Canvas padding is sword room, not a larger body or collision box.', fill=P['ghost'])
d.text((24, 570), 'Attack timing and sword hitbox are gameplay work; these are the two requested poses.', fill=P['ghost'])
review.save(HERE / 'ninja-review.png')

for name, frames, durations in [('walk', walk, [125] * 4), ('swing', swing, [400, 400])]:
    previews = []
    for im in frames:
        canvas = Image.new('RGB', (256, 208), P['sky'])
        canvas.paste(zoom(im, 8), (0, 0), zoom(im, 8))
        ImageDraw.Draw(canvas).line((0, 192, 255, 192), fill=P['terrainEdge'])
        previews.append(canvas)
    previews[0].save(HERE / f'{name}-preview.gif', save_all=True,
                     append_images=previews[1:], duration=durations, loop=0)
