// Client entry: boot the renderer, assets and network, then run the game loop.
// M1: local single-player on the hand-written test map (shared/maps/test.js).
import { createRenderer, SpriteBatch, WebGPUUnavailableError } from './gpu/renderer.js';
import { hexToRgba, loadManifest, loadSpriteAtlas } from './assets.js';
import { createCamera } from './camera.js';
import { createInput } from './input.js';
import { createNet } from './net.js';
import { animFor, createAnimator, drawPlayer } from './player-view.js';
import { createTuningPanel } from './dev/tuning.js';
import { TICK_RATE, createPlayer, step } from '../shared/physics.js';
import { TILE, TILE_SIZE } from '../shared/tiles.js';
import { createTestMap } from '../shared/maps/test.js';

const TICK_S = 1 / TICK_RATE;
/** Longest frame gap we simulate. Beyond this (tab in background) time is dropped. */
const MAX_FRAME_S = 0.25;

function showFallback(html) {
  const el = document.getElementById('fallback');
  el.innerHTML = `<span>${html}</span>`;
  el.hidden = false;
  document.getElementById('game').hidden = true;
}

const shade = ([r, g, b, a], k) => [r * k, g * k, b * k, a];

/** Tile style table (indexed by tile id) from the manifest palette. See TILE_WGSL. */
function tileStyles(color) {
  const styles = [];
  styles[TILE.empty] = { fill: color('sky') };
  styles[TILE.solid] = { fill: color('terrain'), edge: color('terrainEdge'), edgeWidth: 2 };
  styles[TILE.spike] = { fill: color('hazard'), shape: 2 };
  styles[TILE.oneWay] = { fill: color('oneWay'), edge: shade(color('oneWay'), 1.35), shape: 1 };
  styles[TILE.postFloor] = { fill: color('postFloor'), edge: shade(color('postFloor'), 1.3), edgeWidth: 1 };
  styles[TILE.postWall] = { fill: color('postWall'), edge: shade(color('postWall'), 1.4), edgeWidth: 1 };
  return styles;
}

async function boot() {
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('game'));
  let renderer;
  try {
    renderer = await createRenderer(canvas);
  } catch (err) {
    if (!(err instanceof WebGPUUnavailableError)) console.error(err);
    showFallback(
      'This game needs WebGPU, and this browser doesn\'t have it available.<br>' +
      'Try a current Chrome, Edge or Safari. ' +
      '<a href="https://caniuse.com/webgpu">Browser support</a>',
    );
    return;
  }
  renderer.lost.then((info) => {
    console.error('[gpu] device lost:', info.reason, info.message);
    if (info.reason !== 'destroyed') showFallback('The graphics device was lost. Reload the page to continue.');
  });

  // Assets. Missing palette keys show up as magenta, so they're easy to spot.
  const manifest = await loadManifest();
  const color = (key, alpha = 1) => hexToRgba(manifest?.palette?.[key] ?? '#ff00ff', alpha);
  const { texture: atlas, sprites } = await loadSpriteAtlas(renderer.device, manifest);
  if (atlas) renderer.setAtlas(atlas);
  const playerColors = { player: color('player'), outline: shade(color('sky'), 0.5) };

  // World
  const map = createTestMap();
  renderer.setMap(map, tileStyles(color));
  const spawnAt = map.markers['@'][0];

  const panel = createTuningPanel();
  const tuning = panel.tuning;
  const center = (p) => [p.x + tuning.width / 2, p.y + tuning.height / 2];
  const spawn = () => createPlayer((spawnAt.tx + 0.5) * TILE_SIZE, (spawnAt.ty + 1) * TILE_SIZE, tuning);
  let prev = spawn();
  let cur = prev;

  const input = createInput();
  const camera = createCamera();
  camera.snap(...center(cur), map);
  const animator = createAnimator();
  const batch = new SpriteBatch();

  const params = new URLSearchParams(location.search);
  const net = createNet({ name: params.get('name') ?? 'Trader' });

  let tick = 0;
  let acc = 0;
  let last = performance.now();
  let fps = 0;
  let resetHeld = false;

  // Handles for poking at the client from the dev console.
  globalThis.game = { renderer, net, map, tuning, get player() { return cur; } };

  function frame(now) {
    const dt = Math.min((now - last) / 1000, MAX_FRAME_S);
    last = now;
    fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;

    // R respawns (dev convenience until death/respawn lands in M5).
    const reset = input.isDown('KeyR');
    if (reset && !resetHeld) {
      prev = cur = spawn();
      camera.snap(...center(cur), map);
    }
    resetHeld = reset;

    // Fixed-step simulation
    acc += dt;
    while (acc >= TICK_S) {
      acc -= TICK_S;
      prev = cur;
      cur = step(cur, input.sample(), map, tuning);
      tick++;
    }

    // Render, interpolating between the last two ticks
    const alpha = acc / TICK_S;
    const pos = { x: prev.x + (cur.x - prev.x) * alpha, y: prev.y + (cur.y - prev.y) * alpha };
    camera.update(pos.x + tuning.width / 2, pos.y + tuning.height / 2, cur.vx, dt, map);
    const { cam } = camera;

    batch.clear();
    const anim = animator.update(animFor(cur), now / 1000);
    drawPlayer(batch, pos, cur, anim, playerColors, sprites.player, tuning);
    // Connection indicator, top-left of the view (there's no HUD text until M4)
    const netColor = net.status === 'connected' ? [0.3, 0.8, 0.4, 0.9] : net.status === 'connecting' ? [0.9, 0.8, 0.3, 0.9] : [0.9, 0.2, 0.2, 0.9];
    batch.push(Math.round(cam.x) + 4, Math.round(cam.y) + 4, 3, 3, netColor);

    renderer.frame({ cam: [cam.x, cam.y], sprites: batch });

    if (panel.visible) {
      panel.show(
        `fps ${fps.toFixed(0)}  tick ${tick}  net ${net.status}${net.rtt ? ` ${net.rtt.toFixed(0)}ms` : ''}\n` +
        `pos ${cur.x.toFixed(1)}, ${cur.y.toFixed(1)}  tile ${Math.floor((cur.x + tuning.width / 2) / TILE_SIZE)}, ${Math.floor((cur.y + tuning.height) / TILE_SIZE)}\n` +
        `vel ${cur.vx.toFixed(2)}, ${cur.vy.toFixed(2)}  anim ${anim.anim}\n` +
        `ground ${cur.onGround ? 'y' : 'n'}  wall ${cur.wallDir}  coyote ${cur.coyote}  buffer ${cur.jumpBuffer}  lock ${cur.wallLock}\n` +
        'R respawns',
      );
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot();
