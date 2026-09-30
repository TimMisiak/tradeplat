# Art

This doc covers art assets: the style, the files the game expects, the manifest format, and how to check your work. The overall visual direction is in [DESIGN.md § Visual direction](DESIGN.md#visual-direction). The renderer is described in [ARCHITECTURE.md § Rendering](ARCHITECTURE.md#rendering).

**Art can be made in parallel with the code.** The game draws flat-colored quads from the palette until an asset exists. Once a sprite or tile is in the manifest, the renderer uses it instead (tiles from M2, sprites from M1/M5 as each entity arrives). Adding art never blocks the code, and missing art never breaks the game.

## Where things go

```
client/assets/            # served to the browser. Exported PNGs + manifest only
  manifest.json           # palette + every asset the game should load
  tiles/<tile>.png        # e.g. tiles/solid.png
  sprites/<sprite>/<anim>.png   # e.g. sprites/player/run.png
  icons/goods/<goodId>.png      # e.g. icons/goods/ore.png
art/                      # (create when needed) source files: .aseprite, .psd,
                          # generator scripts. Not served, and the game never reads it
```

Rules:
- File names are **lowercase** (`[a-z0-9_-]`) and end in `.png`. Names in the manifest keep the game's camelCase ids (`wallSlide`, `postFloor`), but the file names are lowercase (`wallslide.png`, `postfloor.png`).
- Every PNG under `client/assets/` must be listed in the manifest, and every file listed must exist. `npm run test:assets` enforces both.
- Art work only needs to touch `client/assets/` and `art/`. If the spec below doesn't fit what you want to draw (a different frame size, a new animation, a new palette key), write it down under [Open questions](#open-questions) or ask, rather than changing code. The spec lives in `client/assets.js` (`TILE_SPEC`, `SPRITE_SPEC`, `PALETTE_KEYS`).

## Style rules

- **Pixel art at 1:1.** One art pixel is one virtual pixel. The game renders a 640×360 view scaled up by whole numbers with nearest-neighbour filtering. Don't draw at 2× and downscale.
- **Tiles are 16×16.** Characters and enemies are sized to fit that grid (see the table below).
- **Hard alpha.** Pixels are fully opaque or fully transparent. There's no anti-aliased edge fade, because it looks muddy when scaled by nearest-neighbour. Soft alpha is fine *inside* effects such as dust.
- **Straight (not premultiplied) alpha**, 8-bit RGBA or indexed PNG. No embedded color profile is needed; everything is treated as sRGB.
- **Sprites face right.** The renderer mirrors them for left-facing.
- **Light comes from the top-left.** Sprites that move have a **1 px dark outline** so they stay readable against any terrain.
- **Stay in the palette** (below). Hazards are the only strongly saturated red. Enemies are orange-family. The player is the brightest thing on screen.
- **Readability comes before detail.** At 640×360 the player is about 24 px tall. The silhouette and pose matter more than shading.

## Palette

Colors are defined in `manifest.json` → `palette`. The game uses them **now** for the flat-color fallback, so art and fallback look consistent. The palette may be adjusted, and changing it here recolors the fallback everywhere.

| Key | Used for |
|---|---|
| `sky` | background behind the level |
| `terrain`, `terrainEdge` | solid ground fill and its exposed edges |
| `oneWay` | one-way platforms |
| `hazard` | spikes, saws: anything that kills on touch |
| `enemy` | patrollers, flyers |
| `player` | the local player |
| `ghost` | other players (also drawn at reduced alpha) |
| `postFloor`, `postWall` | trade post structures |
| `uiPanel`, `uiText`, `uiAccent`, `money` | HUD and trade menu |
| `posts[]` | one identity color per trade post (at least 12). The post sign and HUD use it |

## Tiles

One PNG per tile type. Tile names come from `shared/tiles.js`.

| Tile | Layout | Notes |
|---|---|---|
| `solid` | `cardinal4` autotile, 256×16 | Main terrain. Most of the screen is this tile, so keep interiors calm and put the interest on the edges |
| `spike` | single, 16×16 | Points **up**. The renderer rotates it 90°/180°/270° for walls and ceilings, so it should work at any rotation |
| `oneWay` | single, 16×16 | A thin ledge. The top 4 px should read clearly as "stand here", and the rest is mostly transparent |
| `postFloor` | `cardinal4` autotile, 256×16 | Trade post floor |
| `postWall` | `cardinal4` autotile, 256×16 | Trade post walls and roof |

### `cardinal4` autotiling

A horizontal strip of **16 frames, each 16×16**. Each frame is drawn for one combination of same-type neighbours:

```
frame index = N·1 + E·2 + S·4 + W·8      (1 = the neighbour in that direction is the same tile type)

 0: isolated block        5: N+S (vertical run)    10: E+W (horizontal run)   15: fully surrounded
 1: N only                6: E+S (top-left corner) 12: S+W (top-right corner)
 4: S only (a top cap)    9: N+W (bottom-right)     3: N+E (bottom-left)
```

A side whose bit is **0** is exposed: draw the edge or grass lip there. A side whose bit is **1** must join seamlessly with the neighbouring tile. The renderer works out the mask from the map at draw time, so nothing has to be baked in. The asset viewer shows a sample blob built from your strip, so seams show up right away.

## Sprites

Each animation is a **horizontal strip** of equal-sized frames: strip width = frame width × frame count. The **anchor** is the pixel in the frame that sits on the entity's position. For things that stand, that's where the feet touch the ground.

| Sprite | Frame | Anchor | Required anims | Optional | Notes |
|---|---|---|---|---|---|
| `player` | 24×24 | 12,24 (feet) | `idle` `run` `jump` `fall` `wallSlide` | `land` `death` | Body about 12×18 px, centred. The hitbox (decided in M1) will be about that size, so keep limbs and hair inside ~16 px. Other players are drawn with the same sprite, desaturated and translucent, so it has to read in greyscale too. `wallSlide` faces the wall with the wall on the **right** |
| `patroller` | 16×16 | 8,16 (feet) | `walk` | `stomped` | Walks back and forth on a platform. The top edge is the "stomp here" surface, so make it read that way |
| `flyer` | 16×16 | 8,8 (centre) | `fly` | | Loops in the air. Needs a clear silhouette against the sky |
| `saw` | 32×32 | 16,16 (centre) | `spin` | | Hazard-red. A 1-frame strip is fine, because the renderer can rotate it |
| `dust` | 8×8 | 4,8 | `puff` | | Landing and run dust. Soft alpha is allowed |
| `splat` | 16×16 | 8,8 | `burst` `stain` | | Death effect. `stain` is a mark left on the level. **Each frame of `stain` is a random variant**, not an animation (set `fps: 1, loop: false`) |
| `postSign` | 32×16 | 16,16 | `idle` | | Hangs over a post door. It gets tinted with the post's `posts[]` color, so draw it in greys and white |

Suggested frame counts and rates (not enforced): idle 4 @ 6 fps · run 6 @ 12 · jump 2 @ 10 (no loop) · fall 2 @ 8 · wallSlide 2 @ 8 · land 3 @ 15 (no loop) · walk 4 @ 8 · fly 4 @ 10 · puff 5 @ 20 (no loop) · burst 5 @ 20 (no loop).

## Goods icons

These are 16×16 icons for the trade menu, one per good in `shared/goods.js`: `water`, `grain`, `ore`, `fuel`, `food` (rations), `metal`, `cloth`, `tools`, `meds` (medicine), `relics`. They're shown on the `uiPanel` color, so they need a 1 px outline or a strong silhouette. Relics are the rare luxury good, so make them look precious.

## Manifest format

`client/assets/manifest.json`:

```json
{
  "version": 1,
  "palette": { "sky": "#141a2b", "...": "...", "posts": ["#5fb3d9", "..."] },
  "tiles": {
    "solid": { "file": "tiles/solid.png", "autotile": "cardinal4" },
    "spike": { "file": "tiles/spike.png" }
  },
  "sprites": {
    "player": {
      "frame": [24, 24],
      "anchor": [12, 24],
      "anims": {
        "idle": { "file": "sprites/player/idle.png", "frames": 4, "fps": 6, "loop": true },
        "wallSlide": { "file": "sprites/player/wallslide.png", "frames": 2, "fps": 8, "loop": true }
      }
    }
  },
  "icons": { "goods": { "ore": "icons/goods/ore.png" } }
}
```

- Leave out `autotile` for a single 16×16 tile.
- A sprite only replaces its flat quad once **all** of its required animations are present. Partial sets are fine to commit, and the validator will warn about them.

## Checking your work

1. **`npm run test:assets`** checks that the manifest matches the files. It reports wrong strip sizes, unknown tile or good names, missing files, PNGs on disk that the manifest doesn't list, and bad palette entries. It also prints warnings (missing required animations, frame sizes that differ from the recommendation). This must pass before you commit.
2. **`npm start`, then open <http://localhost:3000/tools/assets.html>.** The viewer shows:
   - every asset at 1–8× scale, with animations playing;
   - the autotile blob;
   - sprite anchors as a magenta cross;
   - a choice of backgrounds (palette sky, checker, light).
   It runs the same validator and lists any errors at the top. **Reload** picks up edited files without restarting the server.

## Status

| Area | State |
|---|---|
| Palette | placeholder values in the manifest (the flat-color fallback uses them) |
| Tiles | none yet |
| Sprites | none yet |
| Goods icons | none yet |
| Renderer support | **Player sprite: live since M1.** Checked with throwaway test art: the atlas packs it, animations switch with physics state, it's mirrored for facing left, and it's anchored at the feet. Tiles still use flat palette colors with edge shading (tile art is M2). Enemies and fx come in M5, icons in M4 |

## Open questions

- **Backdrop / parallax layers** behind the tiles: are they wanted, and at what size? Not in the spec yet.
- **Biome tile variants** (cave vs. surface vs. sky-island terrain) depend on [WORLDGEN.md](WORLDGEN.md#open-questions) biomes. Until that's decided, there is one `solid` style.
- **Player color variants** so players can tell each other apart: palette swap, or tinting?
