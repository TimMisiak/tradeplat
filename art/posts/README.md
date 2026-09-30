# Trade-post art

`posts.py` draws directly at native resolution using Python 3 and Pillow.

```sh
python3 art/posts/posts.py
npm run test:assets
```

Runtime outputs:

- `client/assets/tiles/postfloor.png`: 256×16 cardinal4 strip.
- `client/assets/tiles/postwall.png`: 256×16 cardinal4 strip.
- `client/assets/sprites/postsign/idle.png`: one 32×16 frame, anchor (16,16).

The timber tiles use manifest palette colors. Only exposed faces have edge
detail; fully surrounded tiles stay plain. The sign uses art-only neutral gray
values (#202020, #808080, #a0a0a0, #c0c0c0) and white to support color tinting.
All assets use hard alpha and are drawn at native resolution.

`posts-review.png` is a nearest-neighbour enlarged mockup, not a gameplay
screenshot. It shows two post structures with the approved courier, all sixteen
masks for each tile, sign tint examples, and irregular joins. All three assets
are visually approved.
