"""Draw the courier's required movement animations at native resolution.

Run: python3 art/player/movement.py (requires Pillow).
The approved idle module supplies the shared palette, hood and pixel stamp.
"""
from pathlib import Path
from PIL import Image, ImageDraw
from idle import ROOT, PALETTE, COLORS, HEAD, stamp

OUT = ROOT / 'client/assets/sprites/player'
HERE = Path(__file__).resolve().parent


def color(token):
    return PALETTE[COLORS[token]]


def limb(im, points, token='s', boot=False, width=3):
    draw = ImageDraw.Draw(im)
    draw.line(points, fill=color('o'), width=width + 2)
    draw.line(points, fill=color(token), width=width)
    if boot:
        x, y = points[-1]
        draw.rectangle((x - 1, y, x + 2, y + 1), fill=color('o'))
        draw.line((x, y, x + 1, y), fill=color('d'))


BODY = [
    ' oooobbbbbo',
    'ohhhowwwwso',
    'ophpowwwsso',
    'oppdowwwsso',
    'oppdossssso',
    ' oooosggsso',
    '     ooooo',
]


def body(im, x, y, scarf=0):
    # Loose scarf trails left, away from forward travel.
    stamp(im, ['oooo', 'obbo', ' ooo'], x - 1, y + scarf)
    stamp(im, BODY, x, y)
    stamp(im, HEAD, x, y - 8)


def run_frame(i):
    im = Image.new('RGBA', (24, 24))
    # Contact, recoil, passing; then the opposite foot leads.
    poses = [
        ([(11, 18), (8, 20), (5, 22)], [(13, 18), (15, 20), (18, 22)], 0),
        ([(11, 19), (8, 20), (7, 18)], [(13, 19), (14, 21), (14, 22)], 1),
        ([(11, 17), (14, 19), (16, 18)], [(13, 17), (11, 20), (10, 22)], -1),
        ([(11, 18), (15, 20), (18, 22)], [(13, 18), (9, 20), (5, 22)], 0),
        ([(11, 19), (14, 21), (14, 22)], [(13, 19), (8, 20), (7, 18)], 1),
        ([(11, 17), (11, 20), (10, 22)], [(13, 17), (14, 19), (16, 18)], -1),
    ]
    back, front, bob = poses[i]
    limb(im, back, 'd', True)
    limb(im, front, 's', True)
    body(im, 5, 12 + bob, i % 2)
    arm = [
        [(14, 14), (13, 16), (11, 16)],
        [(14, 15), (13, 17), (12, 17)],
        [(14, 13), (15, 15), (17, 15)],
        [(14, 14), (16, 15), (17, 14)],
        [(14, 15), (15, 17), (16, 17)],
        [(14, 13), (13, 15), (11, 15)],
    ][i]
    limb(im, arm, 'w', width=1)
    return im


def jump_frame(i):
    im = Image.new('RGBA', (24, 24))
    limb(im, [(11, 17), (8, 20), (7, 21 - i)], 'd', True)
    limb(im, [(13, 17), (16, 18), (16, 20 - i)], 's', True)
    body(im, 4, 11, 1)
    limb(im, [(13, 13), (15, 14), (16, 12 - i)], 'w', width=1)
    return im


def fall_frame(i):
    im = Image.new('RGBA', (24, 24))
    limb(im, [(10, 18), (9, 20), (8, 22)], 'd', True)
    limb(im, [(13, 18), (15, 20), (16, 21)], 's', True)
    body(im, 4, 12, -2 - i)
    limb(im, [(13, 14), (15, 15 - i), (16, 14 - i)], 'w', width=1)
    return im


def wall_frame(i):
    im = Image.new('RGBA', (24, 24))
    limb(im, [(11, 18), (10, 20), (9, 22)], 'd', True)
    limb(im, [(14, 18), (18, 18), (18, 20)], 's', True)
    body(im, 5, 12, -2 - i)
    limb(im, [(14, 14), (17, 15), (18, 12)], 'w')
    # Palm and forward boot share a contact line; wall is on the right.
    ImageDraw.Draw(im).rectangle((19, 10, 20, 13), fill=color('o'))
    ImageDraw.Draw(im).line((19, 11, 19, 12), fill=color('w'))
    return im


ANIMS = {
    'run': ([run_frame(i) for i in range(6)], 12),
    'jump': ([jump_frame(i) for i in range(2)], 10),
    'fall': ([fall_frame(i) for i in range(2)], 8),
    'wallslide': ([wall_frame(i) for i in range(2)], 8),
}

review = Image.new('RGB', (960, 736), PALETTE['sky'])
draw = ImageDraw.Draw(review)
allowed = {tuple(bytes.fromhex(PALETTE[key][1:])) for key in COLORS.values()}
for row, (name, (frames, fps)) in enumerate(ANIMS.items()):
    sheet = Image.new('RGBA', (24 * len(frames), 24))
    draw.text((16, row * 184 + 8), f'{name.upper()} / {len(frames)} frames / {fps} fps', fill=PALETTE['player'])
    previews = []
    for i, im in enumerate(frames):
        assert im.size == (24, 24)
        assert set(im.getchannel('A').getdata()) == {0, 255}
        assert all(p[:3] in allowed for p in im.getdata() if p[3])
        sheet.paste(im, (24 * i, 0))
        zoom = im.resize((144, 144), Image.Resampling.NEAREST)
        review.paste(zoom, (16 + i * 156, row * 184 + 30), zoom)
        canvas = Image.new('RGB', (168, 168), PALETTE['sky'])
        canvas.paste(zoom, (12, 12), zoom)
        if name == 'wallslide':
            ImageDraw.Draw(canvas).rectangle((138, 0, 167, 167), fill=PALETTE['terrainEdge'])
        previews.append(canvas)
    sheet.save(OUT / f'{name}.png')
    # Jump holds its terminal pose in-game; repeated GIF is for reviewing both frames.
    previews[0].save(HERE / f'{name}-preview.gif', save_all=True,
                     append_images=previews[1:], duration=round(1000 / fps), loop=0)
review.save(HERE / 'movement-review.png')
print('Exported run, jump, fall, wallslide and review previews.')
