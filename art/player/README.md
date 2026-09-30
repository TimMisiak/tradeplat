# Player — courier animation set

Hooded courier: ivory clothing, blue scarf, brown cargo pack, dark face opening.
Four native 24×24 frames at 6 fps, facing right, with a foot anchor at (12, 24).
The breathing cycle keeps the feet planted. All colors come from the manifest.

Editable sources: `idle.py` (each character in the drawing is one art pixel)
and `movement.py` (shared hood and palette, with pixel-drawn limb poses).
Requires Python 3 and Pillow; regenerate from the repository root:

```sh
python3 art/player/idle.py
python3 -B art/player/movement.py
npm run test:assets
```

Exports `client/assets/sprites/player/idle.png`, plus `idle-review.png` and
`idle-preview.gif` here for style review. Preview enlargement uses nearest-neighbor
scaling; the runtime strip is authored directly at native resolution.

The required player animation set is complete:

| Animation | Frames | FPS | Loop |
|---|---|---|---|
| idle | 4 | 6 | yes |
| run | 6 | 12 | yes |
| jump | 2 | 10 | no |
| fall | 2 | 8 | yes |
| wallSlide | 2 | 8 | yes |

Every frame is 24×24 with anchor (12, 24), hard transparency and manifest colors.
Run alternates contact, recoil and passing poses. Jump tucks the legs; fall opens
the stance. Wall-slide braces a palm and boot against a wall on the right.
The movement generator exports four runtime PNG strips, `movement-review.png`,
and one animated GIF preview per animation. Jump's GIF repeats for review;
its runtime animation plays once and holds its last frame.

Preview all animations in `/tools/assets.html`. Optional land/death animations
are not included. Renderer integration follows the project's implementation roadmap.
