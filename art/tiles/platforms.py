"""Draw native 16x16 spikes and one-way ledges; requires Pillow."""
from pathlib import Path
import json
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
P = json.loads((ROOT / 'client/assets/manifest.json').read_text())['palette']
# Art-only slate gray, slightly darker than the solid terrain (#3b4252).
SPIKE_FILL = '#323947'


def spike():
    im = Image.new('RGBA', (16, 16))
    d = ImageDraw.Draw(im)
    # Two teeth reach the ground directly, without a connecting base plate.
    for x in (0, 8):
        d.polygon([(x, 15), (x + 3, 0), (x + 4, 0), (x + 7, 15)], fill=P['uiPanel'])
        d.polygon([(x + 1, 15), (x + 3, 3), (x + 4, 3), (x + 6, 15)], fill=SPIKE_FILL)
        d.line((x + 3, 4, x + 2, 11), fill=P['terrainEdge'])
    return im


def oneway():
    im = Image.new('RGBA', (16, 16))
    d = ImageDraw.Draw(im)
    # Continuous top and bottom rows tile horizontally without end-cap seams.
    d.rectangle((0, 0, 15, 2), fill=P['oneWay'])
    d.line((0, 3, 15, 3), fill=P['postWall'])
    d.line((1, 1, 6, 1), fill=P['postFloor'])
    d.line((10, 2, 13, 2), fill=P['postFloor'])
    return im


spikes, ledge = spike(), oneway()
for name, im in [('spike', spikes), ('oneway', ledge)]:
    out = ROOT / f'client/assets/tiles/{name}.png'
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out)
    print(out)

# Review at integer zoom: individual tiles, rotations and a mock level.
review = Image.new('RGB', (768, 640), P['sky'])
d = ImageDraw.Draw(review)
d.text((24, 16), 'SPIKES + ONE-WAY / native 16 x 16 / enlarged with nearest neighbour', fill=P['player'])
for i, (label, im) in enumerate([
    ('UP', spikes), ('RIGHT', spikes.transpose(Image.Transpose.ROTATE_270)),
    ('DOWN', spikes.transpose(Image.Transpose.ROTATE_180)),
    ('LEFT', spikes.transpose(Image.Transpose.ROTATE_90)), ('ONE-WAY', ledge),
]):
    x = 24 + i * 148
    d.text((x, 44), label, fill=P['ghost'])
    review.paste(im.resize((128, 128), Image.Resampling.NEAREST), (x, 64),
                 im.resize((128, 128), Image.Resampling.NEAREST))

scene = Image.new('RGBA', (184, 88), P['sky'])
solid = Image.open(ROOT / 'client/assets/tiles/solid.png').convert('RGBA')
for x in range(12):
    scene.alpha_composite(solid.crop((14 * 16, 0, 15 * 16, 16)), (x * 16, 64))
    scene.alpha_composite(solid.crop((15 * 16, 0, 16 * 16, 16)), (x * 16, 80))
for x in range(4, 8):
    scene.alpha_composite(spikes, (x * 16, 48))
for x in range(3, 9):
    scene.alpha_composite(ledge, (x * 16, 24))
player = Image.open(ROOT / 'client/assets/sprites/player/idle.png').convert('RGBA').crop((0, 0, 24, 24))
scene.alpha_composite(player, (66, 0))
scene.alpha_composite(player, (18, 40))
d.text((24, 226), 'MOCK LEVEL / repeated ledges and spikes alongside approved ground and courier', fill=P['player'])
review.paste(scene.resize((736, 352), Image.Resampling.NEAREST), (16, 252))
review.save(HERE / 'platforms-review.png')
