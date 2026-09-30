"""Native 24x24 pixel source. Run with Python 3 + Pillow from any directory."""
from pathlib import Path
import json
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
PALETTE = json.loads((ROOT / 'client/assets/manifest.json').read_text())['palette']
COLORS = {
    'o': 'uiPanel', 'w': 'player', 's': 'ghost', 'd': 'terrain',
    'b': 'uiAccent', 'p': 'postFloor', 'h': 'oneWay', 'g': 'money',
}
# Each character is exactly one output pixel. Front is on the right.
HEAD = [
    '    ooooooo',
    '   owwwwwwwo',
    '  owwwwwwwwwo',
    '  owwwsssssswo',
    '  owwsdddddddo',
    '  owwsddgwdddo',
    '   owssdddddo',
    '   oosssssso',
]
TORSO = [
    ' oooobbbbbo',
    'ohhhowwwwsbo',
    'ophpowwwwsobo',
    'oppdowwwswobo',
    'oppdoswwswso',
    ' ooososswso',
    '   osggssso',
]
LEGS = [
    '   ossoosso',
    '   ossoosso',
    '   oddoodddo',
    '   oooo oooo',
]


def stamp(image, rows, x, y):
    for dy, row in enumerate(rows):
        for dx, token in enumerate(row):
            if token != ' ':
                color = PALETTE[COLORS[token]]
                image.putpixel((x + dx, y + dy), tuple(bytes.fromhex(color[1:])) + (255,))


def frame(phase):
    im = Image.new('RGBA', (24, 24))
    stamp(im, LEGS, 4, 20)
    # Exhale lowers the shoulders and hood by one pixel, without moving the feet.
    lower = phase == 2
    stamp(im, TORSO, 4, 13 + int(lower))
    stamp(im, HEAD, 4, 5 + int(lower))
    if phase == 1:
        im.putpixel((10, 15), tuple(bytes.fromhex(PALETTE['player'][1:])) + (255,))
    if phase == 3:
        im.putpixel((10, 17), tuple(bytes.fromhex(PALETTE['ghost'][1:])) + (255,))
    return im


if __name__ == '__main__':
    frames = [frame(i) for i in range(4)]
    sheet = Image.new('RGBA', (96, 24))
    for i, im in enumerate(frames):
        sheet.paste(im, (i * 24, 0))
    output = ROOT / 'client/assets/sprites/player/idle.png'
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output)

    # Review images are separate from runtime assets.
    preview = Image.new('RGB', (864, 360), PALETTE['sky'])
    draw = ImageDraw.Draw(preview)
    draw.text((24, 18), 'COURIER / IDLE     24 x 24 px     4 frames / 6 fps', fill=PALETTE['player'])
    for i, im in enumerate(frames):
        x = 24 + i * 208
        draw.rectangle((x, 240, x + 191, 249), fill=PALETTE['terrainEdge'])
        preview.paste(im.resize((192, 192), Image.Resampling.NEAREST), (x, 48), im.resize((192, 192), Image.Resampling.NEAREST))
        draw.text((x, 269), f'FRAME {i + 1}', fill=PALETTE['ghost'])
    draw.text((24, 318), 'Ivory hood / blue scarf / travel pack / planted feet', fill=PALETTE['player'])
    preview.save(Path(__file__).with_name('idle-review.png'))
    animated = []
    for im in frames:
        canvas = Image.new('RGB', (192, 208), PALETTE['sky'])
        zoom = im.resize((192, 192), Image.Resampling.NEAREST)
        canvas.paste(zoom, (0, 0), zoom)
        ImageDraw.Draw(canvas).rectangle((0, 192, 191, 199), fill=PALETTE['terrainEdge'])
        animated.append(canvas)
    animated[0].save(Path(__file__).with_name('idle-preview.gif'), save_all=True,
                     append_images=animated[1:], duration=[170, 160, 170, 170], loop=0)

    assert sheet.size == (96, 24)
    assert set(sheet.getchannel('A').getdata()) == {0, 255}
    allowed = {tuple(bytes.fromhex(PALETTE[key][1:])) for key in COLORS.values()}
    assert all(pixel[:3] in allowed for pixel in sheet.getdata() if pixel[3])
    print(output)
