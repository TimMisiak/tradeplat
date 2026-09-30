# Player idle — first style pass

Hooded courier: ivory clothing, blue scarf, brown cargo pack, dark face opening.
Four native 24×24 frames at 6 fps, facing right, with a foot anchor at (12, 24).
The breathing cycle keeps the feet planted. All colors come from the manifest.

Editable source: `idle.py` (each character in the drawing is one art pixel).
Requires Python 3 and Pillow; regenerate from the repository root:

```sh
python3 art/player/idle.py
npm run test:assets
```

Exports `client/assets/sprites/player/idle.png`, plus `idle-review.png` and
`idle-preview.gif` here for style review. Preview enlargement uses nearest-neighbor
scaling; the runtime strip is authored directly at native resolution.

Only idle is supplied pending style review. The asset viewer can preview it;
the game retains its fallback until all required player animations exist.
