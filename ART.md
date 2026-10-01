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

Solid-ground art also uses a dedicated shadow shade, `#2c3446`, defined in its
source generator. This art-only color separates shadowed rock from the sky
without adding a runtime palette key or changing other assets. Spike art uses
`#323947`, a slate gray slightly darker than solid terrain, instead of hazard red.

| Key | Used for |
|---|---|
| `sky` | background behind the level |
| `terrain`, `terrainEdge` | solid ground fill and its exposed edges |
| `oneWay` | one-way platforms |
| `hazard` | hazard fallback and saws; spike art uses the gray shade above |
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
| `slopeR` | single, 16×16 | 45° ramp rising to the right ('/'). Solid below the diagonal from bottom-left to top-right, transparent above it. Put the grass or edge lip along the diagonal. The interior should match `solid`'s interior, because ramps sit against solid tiles on their tall side and below. **Also used mirrored for `slopeL`** |
| `slopeL` | single, 16×16, optional | The '\\' ramp. Only needed if the mirrored `slopeR` doesn't work (for example, lighting from the top-left looks wrong when flipped) |

### `cardinal4` autotiling

A horizontal strip of **16 frames, each 16×16**. Each frame is drawn for one combination of same-type neighbours:

```
frame index = N·1 + E·2 + S·4 + W·8      (1 = the neighbour in that direction is the same tile type)

 0: isolated block        5: N+S (vertical run)    10: E+W (horizontal run)   15: fully surrounded
 1: N only                6: E+S (top-left corner) 12: S+W (top-right corner)
 4: S only (a top cap)    9: N+W (bottom-right)     3: N+E (bottom-left)
```

A side whose bit is **0** is exposed: draw the edge or grass lip there. A side whose bit is **1** must join seamlessly with the neighbouring tile. A neighbour counts as joined if it's **the same tile, or if both tiles are solid**. **Ramps count as solid here**, so the ground under a ramp and beside its tall side shows no edge. That means terrain under a post floor, beside a post wall, or under a ramp has no exposed edge on that side. One-way platforms, spikes and air always count as exposed. The renderer works out the mask from the map at draw time, so nothing has to be baked in. The asset viewer shows a sample blob built from your strip, so seams show up right away.

## Sprites

Each animation is a **horizontal strip** of equal-sized frames: strip width = frame width × frame count. The **anchor** is the pixel in the frame that sits on the entity's position. For things that stand, that's where the feet touch the ground.

| Sprite | Frame | Anchor | Required anims | Optional | Notes |
|---|---|---|---|---|---|
| `player` | 24×24 | 12,24 (feet) | `idle` `run` `jump` `fall` `wallSlide` | `land` `death` | Body about 12×18 px, centred. The hitbox (decided in M1) will be about that size, so keep limbs and hair inside ~16 px. Other players are drawn with the same sprite, desaturated and translucent, so it has to read in greyscale too. `wallSlide` faces the wall with the wall on the **right** |
| `patroller` | 32×24 art canvas (runtime recommendation still 16×16) | 12,24 (feet) | `walk` | `swing` (new art), `stomped` | Small ninja body with transparent sword room. `swing` has exactly two frames: wind-up and full extension. Runtime spec follow-up below |
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

Asset progress below reflects the exported files in `client/assets/manifest.json`.
Art completion is separate from renderer/gameplay implementation.

| Area | State |
|---|---|
| Palette | Initial manifest palette in use by the player art and flat-color fallback; broader art direction still open |
| Player — required animations | **Done and reviewed:** `idle`, `run`, `jump`, `fall`, `wallSlide`; exported and registered in the manifest |
| Player — optional animations | Not started: `land`, `death` |
| Solid ground | **Done and visually approved:** `solid`, all 16 cardinal4 frames exported and registered |
| One-way platforms | **Done and visually approved:** `oneWay`; exported and registered |
| Spikes | **Done and visually approved:** gray `spike` teeth without a base plate; exported and registered |
| Trade post tiles | **Done and visually approved:** `postFloor`, `postWall`; all 16 cardinal4 frames exported and registered for each |
| Patroller | **First pass ready for review:** ninja `walk` (4 frames) and `swing` (2 frames); exported and registered. Optional `stomped` not started |
| Other enemies and hazards | Not started: flyer `fly`, saw `spin` |
| Effects | Not started: dust `puff`, splat `burst` and `stain` |
| Post sign | **Done and visually approved:** postSign `idle`; neutral grayscale, exported and registered |
| Goods icons | Not started: `water`, `grain`, `ore`, `fuel`, `food`, `metal`, `cloth`, `tools`, `meds`, `relics` |
| Renderer support | **Player sprite: live since M1.** **Tile art: live since M2**, checked with throwaway test art: cardinal4 masks, single tiles, transparency showing the sky, and spikes rotated onto floors, ceilings and both walls. A tile keeps its flat palette style until its PNG is in the manifest. Enemies and fx come in M5, icons in M4 |

### Solid ground — first style pass

Muted slate rock uses the existing `terrain` and `terrainEdge` colors plus the
art-only shadow shade `#2c3446`, which remains distinct from the sky.
Exposed top edges have a light chipped rim; left faces catch light and right/bottom
faces are shadowed. Interiors remain plain so connected tiles do not form a grid.
The repeating interior crack has been removed; crack detail is deferred until
tile variants can avoid obvious repetition.

The native 16×16 frames are exported as a 256×16 cardinal4 strip in
[client/assets/tiles/solid.png](client/assets/tiles/solid.png). The full strip passes
asset validation and is visually approved. Source and regeneration instructions
are in [art/tiles/](art/tiles/README.md), alongside previews of all masks, an irregular
autotiled blob, and a mock level composition with the approved courier.

### Completed spikes and one-way platforms

Spikes have two upward-facing slate-gray teeth, slightly darker than solid ground,
with a dark outline and a muted top-left highlight. The teeth meet the ground
directly without a base plate. The single 16×16 tile supports all four rotations.
One-way platforms use a continuous brown ledge in the top four pixel rows;
the remaining twelve rows are transparent. Both use hard alpha, drawn directly at
native resolution; spikes add the art-only gray shade documented above.

Runtime files are `client/assets/tiles/spike.png` and `client/assets/tiles/oneway.png`.
The editable generator and a review showing rotations, repeated tiles, and a mock
level are in [art/tiles/](art/tiles/README.md). One-way platforms and gray spikes
without a base plate are visually approved.

### Completed trade-post art

The floor and wall strips use warm timber from the existing palette. Floors have
a clear light top rim; walls and roofs are darker, with small iron pins at exposed
corners. Detail stays on exposed edges so filled interiors join without a grid.
Both strips contain all sixteen native 16×16 cardinal4 frames.

The 32×16 sign hangs from two short supports and shows opposing exchange arrows.
It uses neutral gray and white for post-color tinting, hard alpha, the (16,16)
anchor, and one static `idle` frame. Neutral sign shades are art-only colors.

Runtime files are `tiles/postfloor.png`, `tiles/postwall.png`, and
`sprites/postsign/idle.png` under `client/assets/`. Editable sources and a preview
of structures, all masks, joins, and sign tints are in [art/posts/](art/posts/README.md).
All three assets are visually approved.

### Ninja patroller — first pass

A simple dark ninja uses an orange headband and sash, a level hood top, and a
gray sword. The four-frame walk loops at 8 fps. The two-frame `swing` shows an
overhead wind-up followed by full rightward extension; it does not loop. Its
8 fps is preview metadata, not a decision about combat timing.

Both animations use a 32×24 canvas with anchor (12,24). The body remains roughly
16×16; transparent padding accommodates the raised and extended sword. Frames
face right and use only manifest palette colors with hard alpha. The canvas
does not define the body collision box or the sword attack hitbox.

Sources and static/animated reviews are in [art/patroller/](art/patroller/README.md).
Runtime strips are in `client/assets/sprites/patroller/`. Visual approval is
pending. The loader and viewer support the shared larger canvas already;
the validator currently warns about the old recommended size and unknown `swing`.
The corresponding runtime-spec and gameplay follow-up is under Open questions.

### Completed player art

The approved design is a simple, cartoony courier with an ivory hood, blue scarf,
and brown backpack. Run, jump, and fall use short, slim, undetailed arms. Fall and
wall-slide animate a subtle one-pixel backpack shift instead of a trailing blue
scarf behind the player.

All frames are native 24×24 pixels, face right, and use the (12,24) foot anchor,
manifest palette, and hard transparency.

| Animation | Frames | FPS | Loop |
|---|---|---|---|
| `idle` | 4 | 6 | yes |
| `run` | 6 | 12 | yes |
| `jump` | 2 | 10 | no |
| `fall` | 2 | 8 | yes |
| `wallSlide` | 2 | 8 | yes |

Runtime sheets are in [client/assets/sprites/player/](client/assets/sprites/player/).
Editable Python/Pillow sources and enlarged/animated review previews are in
[art/player/](art/player/); see its [README](art/player/README.md) for regeneration.
The completed set passes `npm run test:assets` without missing-animation warnings.

Update this status section as each asset set is completed. Unspecified art work
such as backdrops and player color variants remains under Open questions below.

## Open questions

- **Ninja patroller runtime spec:** art now supplies a shared 32×24 frame and
  (12,24) foot anchor for `walk` and the requested two-frame `swing`. Update
  `SPRITE_SPEC.patroller` from 16×16 / (8,16) and recognize `swing` when adopting
  this art contract. The atlas loader already accepts this layout. If compact
  walk frames and larger attack-only frames are preferred, the manifest, loader,
  validator, viewer, and entity drawing will need per-animation frame/anchor
  support. Attack trigger, wind-up duration, active frame, recovery, and sword
  hitbox remain gameplay decisions; padding must not enlarge body collision.

- **Backdrop / parallax layers** behind the tiles: are they wanted, and at what size? Not in the spec yet.
- **Biome tile variants** (cave vs. surface vs. sky-island terrain) depend on [WORLDGEN.md](WORLDGEN.md#open-questions) biomes. Until that's decided, there is one `solid` style.
- **Player color variants** so players can tell each other apart: palette swap, or tinting?
