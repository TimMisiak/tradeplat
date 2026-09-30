# Solid ground

Muted slate rock with a continuous light top rim, small chips along exposed
edges, a lit left face, and shadowed right/bottom faces. Interiors are plain
so large filled areas do not become a grid of outlined blocks. Fill and highlight
come from the manifest. The art-only shadow shade is `#2c3446`, lighter than the
sky so exposed right/bottom faces remain visible. No runtime palette keys change.
Repeated interior cracks are omitted until tile variants are supported.

`solid.py` draws directly at 16×16 using Python 3 and Pillow. Regenerate with:

```sh
python3 art/tiles/solid.py
npm run test:assets
```

Runtime output: `client/assets/tiles/solid.png`, a 256×16 strip containing
all 16 cardinal4 neighbour masks in N=1, E=2, S=4, W=8 order.
Pixels are fully opaque, including exposed corners, to retain the solid shape.

Review images here use nearest-neighbour enlargement:

- `solid-review.png`: mock level beside the approved player plus all masks.
- `solid-scene.png`: mock level composition (not a gameplay screenshot).
- `solid-joins.png`: irregular blob, hole, isolated block, pillar and thin ledge.

The standard asset viewer also shows the strip and an autotiled blob.
This solid-ground style pass is visually approved.

## Spikes and one-way platforms

`platforms.py` draws both tiles directly at 16×16 using hard alpha and manifest
colors plus the art-only spike gray `#323947`, slightly darker than solid terrain.
Spikes have two gray teeth that meet the ground without a base plate.
One-way ledges occupy only the
top four rows and join continuously across tiles.

```sh
python3 art/tiles/platforms.py
npm run test:assets
```

Runtime outputs: `client/assets/tiles/spike.png` and `client/assets/tiles/oneway.png`.
`platforms-review.png` shows four spike orientations, the ledge, and a mock level
with repeated tiles and the approved courier and ground. One-way ledges and gray
spikes without a base plate are visually approved.
