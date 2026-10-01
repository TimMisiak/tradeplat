// Keyboard (+ gamepad) → INPUT bitmask, sampled once per simulation tick.
// See DESIGN.md § Movement feel (controls).
import { INPUT } from '../shared/physics.js';

const KEYS = {
  ArrowLeft: INPUT.LEFT, KeyA: INPUT.LEFT,
  ArrowRight: INPUT.RIGHT, KeyD: INPUT.RIGHT,
  ArrowUp: INPUT.UP, KeyW: INPUT.UP,
  ArrowDown: INPUT.DOWN, KeyS: INPUT.DOWN,
  Space: INPUT.JUMP, KeyZ: INPUT.JUMP, KeyK: INPUT.JUMP,
  KeyE: INPUT.INTERACT, Enter: INPUT.INTERACT,
};

const STICK_DEADZONE = 0.4;

export function createInput(target = window) {
  const down = new Set();
  // Bits pressed since the last sample. A tap shorter than one tick still counts.
  let latched = 0;
  // Key presses (KeyboardEvent.code, with auto-repeat) since the last presses() call, for menus.
  const pressed = [];

  const onKeyDown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLElement && e.target.closest('input, select, textarea, button')) return; // dev panel fields
    if (pressed.length < 32) pressed.push(e.code);
    const bit = KEYS[e.code];
    if (bit === undefined) return;
    e.preventDefault(); // stop arrows/space from scrolling
    if (e.repeat) return;
    down.add(e.code);
    latched |= bit;
  };
  const onKeyUp = (e) => down.delete(e.code);
  const onBlur = () => down.clear();
  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);

  function held() {
    let bits = 0;
    for (const code of down) bits |= KEYS[code];
    return bits;
  }

  function gamepad() {
    let bits = 0;
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad || pad.mapping !== 'standard') continue;
      const b = (i) => pad.buttons[i]?.pressed;
      const [ax = 0, ay = 0] = pad.axes;
      if (b(14) || ax < -STICK_DEADZONE) bits |= INPUT.LEFT;
      if (b(15) || ax > STICK_DEADZONE) bits |= INPUT.RIGHT;
      if (b(12) || ay < -STICK_DEADZONE) bits |= INPUT.UP;
      if (b(13) || ay > STICK_DEADZONE) bits |= INPUT.DOWN;
      if (b(0)) bits |= INPUT.JUMP;
      if (b(2)) bits |= INPUT.INTERACT;
    }
    return bits;
  }

  return {
    /** Input for the next tick: held keys, plus anything tapped since the last sample. */
    sample() {
      const bits = held() | latched | gamepad();
      latched = 0;
      return bits;
    },
    /** Key presses since the last call, oldest first (menus; includes auto-repeat). */
    presses: () => pressed.splice(0),
    /** Whether a key (KeyboardEvent.code) is held. For dev keys outside the INPUT map. */
    isDown: (code) => down.has(code),
    dispose() {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
    },
  };
}
