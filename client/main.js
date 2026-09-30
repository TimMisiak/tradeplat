// Client entry: boot the renderer, assets and network, then run the game loop.
// Single-player movement on the server's generated world (seed from the welcome
// message). Dev overrides: ?seed=N generates locally, ?map=test loads the M1 test level.
import { createRenderer, SpriteBatch, WebGPUUnavailableError } from './gpu/renderer.js';
import { hexToRgba, loadManifest, loadSpriteAtlas, loadTileArt } from './assets.js';
import { createCamera } from './camera.js';
import { createInput } from './input.js';
import { createNet } from './net.js';
import { animFor, createAnimator, drawPlayer } from './player-view.js';
import { createTuningPanel } from './dev/tuning.js';
import { TICK_RATE, createPlayer, step } from '../shared/physics.js';
import { FLAG, TILE, TILES, TILE_SIZE } from '../shared/tiles.js';
import { createTestMap } from '../shared/maps/test.js';
import { GEN_VERSION, generateWorld } from '../shared/worldgen.js';

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

/**
 * Tile style table (indexed by tile id): tile art where the manifest has it, flat
 * palette shapes otherwise. See TILE_WGSL.
 */
function tileStyles(color, art) {
  const styles = [];
  styles[TILE.empty] = { fill: color('sky') };
  styles[TILE.solid] = { fill: color('terrain'), edge: color('terrainEdge'), edgeWidth: 2 };
  styles[TILE.spike] = { fill: color('hazard'), shape: 2 };
  styles[TILE.oneWay] = { fill: color('oneWay'), edge: shade(color('oneWay'), 1.35), shape: 1 };
  styles[TILE.postFloor] = { fill: color('postFloor'), edge: shade(color('postFloor'), 1.3), edgeWidth: 1 };
  styles[TILE.postWall] = { fill: color('postWall'), edge: shade(color('postWall'), 1.4), edgeWidth: 1 };
  TILES.forEach((t, id) => {
    if (!styles[id]) return;
    styles[id].solid = (t.flags & FLAG.SOLID) !== 0;
    if (art[t.name]) styles[id].art = art[t.name];
  });
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
  const { texture: tileArt, art } = await loadTileArt(renderer.device, manifest);
  if (tileArt) renderer.setTileArt(tileArt);
  const playerColors = { player: color('player'), outline: shade(color('sky'), 0.5) };

  const panel = createTuningPanel();
  const tuning = panel.tuning;
  const center = (p) => [p.x + tuning.width / 2, p.y + tuning.height / 2];
  const input = createInput();
  const camera = createCamera();
  const animator = createAnimator();
  const batch = new SpriteBatch();
  const styles = tileStyles(color, art);

  // World: loaded from the server's seed, or from a dev override.
  const params = new URLSearchParams(location.search);
  /** @type {{map: import('../shared/tiles.js').TileMap, spawn: {tx: number, ty: number}, seed: number | null, label: string} | null} */
  let world = null;
  let prev = null;
  let cur = null;
  const spawn = () => createPlayer((world.spawn.tx + 0.5) * TILE_SIZE, (world.spawn.ty + 1) * TILE_SIZE, tuning);
  const respawn = () => {
    prev = cur = spawn();
    camera.snap(...center(cur), world.map);
  };

  function useWorld(next) {
    world = next;
    renderer.setMap(world.map, styles);
    respawn();
    console.info(`[world] ${world.label}`);
  }

  function useSeed(seed, expected) {
    const t0 = performance.now();
    const gen = generateWorld(seed);
    const ms = performance.now() - t0;
    if (expected && (expected.genVersion !== GEN_VERSION || expected.hash !== gen.hash)) {
      // Different generator code on each side (stale cache or a deploy mid-session).
      console.error(`[world] mismatch: server genVersion ${expected.genVersion} hash ${expected.hash}, client genVersion ${GEN_VERSION} hash ${gen.hash}`);
      showFallback('This page is out of date with the server. Reload to continue.');
      return;
    }
    const post = gen.posts[gen.spawnPost];
    useWorld({ map: gen, spawn: post.spawn, seed, label: `seed ${seed} (${gen.hash}, ${ms.toFixed(0)} ms), spawn at ${post.name}` });
  }

  const net = createNet({ name: params.get('name') ?? 'Trader' });
  if (params.get('map') === 'test') {
    const map = createTestMap();
    useWorld({ map, spawn: map.markers['@'][0], seed: null, label: 'M1 test map' });
  } else if (params.has('seed')) {
    useSeed(Number(params.get('seed')) >>> 0, null);
  } else {
    // The server restarting means a new world; regenerate when the seed changes.
    net.onWelcome.push((msg) => {
      if (msg.world && msg.world.seed !== world?.seed) useSeed(msg.world.seed, msg.world);
    });
  }

  let tick = 0;
  let acc = 0;
  let last = performance.now();
  let fps = 0;
  let resetHeld = false;

  // Handles for poking at the client from the dev console.
  globalThis.game = { renderer, net, tuning, get world() { return world; }, get player() { return cur; } };

  function frame(now) {
    const dt = Math.min((now - last) / 1000, MAX_FRAME_S);
    last = now;
    fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;

    if (!world) {
      // Waiting for the server's seed.
      batch.clear();
      renderer.frame({ cam: [0, 0], sprites: batch });
      requestAnimationFrame(frame);
      return;
    }
    const map = world.map;

    // R respawns (dev convenience until death/respawn lands in M5).
    const reset = input.isDown('KeyR');
    if (reset && !resetHeld) respawn();
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
        `world ${world.label}\n` +
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
