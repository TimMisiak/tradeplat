# Ninja patroller

Simple dark hood and suit, orange headband and sash, gray sword visible only in
the swing poses. Walk frames have empty hands. All colors come
from the manifest. Native pixel source follows the existing Python/Pillow art
workflow; no image downsampling is used.

```sh
python3 art/patroller/ninja.py
npm run test:assets
```

Both strips use 32×24 frames and the same (12,24) foot anchor:

- `client/assets/sprites/patroller/walk.png`: four frames, 8 fps, looping.
- `client/assets/sprites/patroller/swing.png`: two frames, 8 fps, not looping;
  wind-up then full extension. Combat timing is not implemented by this art.

The ninja body remains roughly 16×16. Canvas padding provides room for the sword,
not a larger collision box. All frames face right and use hard alpha.

`ninja-review.png` shows every pose and the courier at equal scale.
`walk-preview.gif` and `swing-preview.gif` loop for review; the swing preview holds
each pose for 400 ms for inspection, independently of the manifest playback rate.

The loader and viewer accept the shared larger frame already. Asset validation
has two expected warnings until the engine's recommended patroller frame/anchor
and recognized animation names are updated: nonstandard frame size and unknown
`swing`. See ART.md's Open questions for the proposed contract and combat follow-up.
Art is awaiting visual approval.
