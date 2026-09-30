// Client entry: boot the renderer, assets and network, then run the game loop.
// Online: the server's world (seed from the welcome message), own movement predicted
// and reconciled, other players drawn as ghosts (ARCHITECTURE.md § Netcode).
// Dev overrides play offline: ?seed=N generates locally, ?map=test loads the M1 test level.
import { createRenderer, SpriteBatch, WebGPUUnavailableError } from './gpu/renderer.js';
import { hexToRgba, loadManifest, loadSpriteAtlas, loadTileArt } from './assets.js';
import { createCamera } from './camera.js';
import { createInput } from './input.js';
import { INTERP_TICKS, createGhosts, createNet, createPredictor } from './net.js';
import { animFor, createAnimator, drawPlayer } from './player-view.js';
import { createTuningPanel } from './dev/tuning.js';
import { ANIMS, INPUT, TICK_RATE, TUNING, spawnAt, tuningHash } from '../shared/physics.js';
import { FLAG, SLOPE, TILE, TILES, TILE_SIZE } from '../shared/tiles.js';
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
  styles[TILE.slopeR] = { fill: color('terrain'), edge: color('terrainEdge'), edgeWidth: 2, shape: 3 };
  styles[TILE.slopeL] = { ...styles[TILE.slopeR], mirror: true };
  TILES.forEach((t, id) => {
    if (!styles[id]) return;
    // Ramps count as solid for joins, so the ground under and beside them shows no edge.
    styles[id].solid = (t.flags & (FLAG.SOLID | SLOPE)) !== 0;
    if (art[t.name]) styles[id].art = art[t.name];
  });
  // slopeL without its own art uses slopeR's, mirrored (ART.md).
  if (art.slopeL) styles[TILE.slopeL].mirror = false;
  else if (art.slopeR) styles[TILE.slopeL].art = art.slopeR;
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
  // Ghosts: translucent and cooler, behind the local player (DESIGN.md § Multiplayer experience).
  const ghostColors = { player: color('ghost', 0.6), outline: shade(color('sky', 0.6), 0.5), tint: [0.7, 0.78, 0.95, 0.55] };

  const panel = createTuningPanel();
  const params = new URLSearchParams(location.search);
  // Dev worlds (?seed, ?map) aren't the server's, so nothing is sent or reconciled there.
  const online = params.get('map') !== 'test' && !params.has('seed');
  // Online, we simulate exactly what the server does, so tuning-panel edits can't
  // apply: they would make our player drift from the server (and from how others see
  // us) with nothing to correct it. They apply in the offline dev worlds.
  const tuning = online ? TUNING : panel.tuning;
  const center = (p) => [p.x + tuning.width / 2, p.y + tuning.height / 2];
  const input = createInput();
  const camera = createCamera();
  const animator = createAnimator();
  const batch = new SpriteBatch();
  const styles = tileStyles(color, art);

  // World: loaded from the server's seed, or from a dev override.
  /** @type {{map: import('../shared/tiles.js').TileMap, spawn: {tx: number, ty: number}, seed: number | null, label: string} | null} */
  let world = null;
  /** @type {ReturnType<typeof createPredictor> | null} */
  let pred = null;
  const ghosts = createGhosts();
  /** id → animator, so each ghost's animation plays from its own start. */
  const ghostAnims = new Map();
  const TUNING_HASH = tuningHash(TUNING);
  const panelEdited = () => tuningHash(panel.tuning) !== TUNING_HASH;
  if (online && panelEdited()) console.warn('[dev] saved tuning-panel edits are ignored online. They apply with ?seed=N or ?map=test');

  function useWorld(next) {
    world = next;
    renderer.setMap(world.map, styles);
    pred = createPredictor(world.map, spawnAt(world.spawn.tx, world.spawn.ty, tuning), tuning);
    ghosts.clear();
    camera.snap(...center(pred.cur), world.map);
    console.info(`[world] ${world.label}`);
  }

  /** @returns {boolean} false if the server's world doesn't match ours */
  function useSeed(seed, expected) {
    const t0 = performance.now();
    const gen = generateWorld(seed);
    const ms = performance.now() - t0;
    if (expected && (expected.genVersion !== GEN_VERSION || expected.hash !== gen.hash)) {
      // Different generator code on each side (stale cache or a deploy mid-session).
      console.error(`[world] mismatch: server genVersion ${expected.genVersion} hash ${expected.hash}, client genVersion ${GEN_VERSION} hash ${gen.hash}`);
      showFallback('This page is out of date with the server. Reload to continue.');
      return false;
    }
    const post = gen.posts[gen.spawnPost];
    useWorld({ map: gen, spawn: post.spawn, seed, label: `seed ${seed} (${gen.hash}, ${ms.toFixed(0)} ms), spawn at ${post.name}` });
    return true;
  }

  const net = createNet({ name: params.get('name') ?? 'Trader' });
  if (params.get('map') === 'test') {
    const map = createTestMap();
    useWorld({ map, spawn: map.markers['@'][0], seed: null, label: 'M1 test map' });
  } else if (params.has('seed')) {
    useSeed(Number(params.get('seed')) >>> 0, null);
  } else {
    net.onWelcome.push((msg) => {
      if (msg.tuningHash !== TUNING_HASH) {
        console.error(`[net] tuning mismatch: server ${msg.tuningHash}, client ${TUNING_HASH}`);
        showFallback('This page is out of date with the server. Reload to continue.');
        return;
      }
      // The server restarting means a new world; regenerate when the seed changes.
      if (msg.world.seed !== world?.seed && !useSeed(msg.world.seed, msg.world)) return;
      // Every welcome is a new server-side player: start from its state and input tick.
      pred.reset(msg.you, msg.ack);
      ghosts.clear();
      camera.snap(...center(pred.cur), world.map);
    });
    net.onSnapshot.push((msg) => {
      if (!pred) return;
      const seq = pred.seq;
      if (pred.reconcile(msg.ack, msg.you)) {
        // Rare by design: identical code on both sides. Expected after a stall (background
        // tab), when the server filled in no-input steps for us.
        console.warn(`[net] corrected at ack ${msg.ack} (predicted up to ${seq})`);
      }
      ghosts.add(msg.tick, msg.g);
    });
  }

  let acc = 0;
  let last = performance.now();
  let fps = 0;
  let resetHeld = false;
  let respawnQueued = false;
  const outgoing = [];

  // Handles for poking at the client from the dev console.
  globalThis.game = { renderer, net, tuning, ghosts, get world() { return world; }, get pred() { return pred; }, get player() { return pred?.cur; } };

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

    // R respawns (dev convenience until death/respawn lands in M5). It rides on the
    // next tick's input, so the server respawns us at the same tick.
    const reset = input.isDown('KeyR');
    if (reset && !resetHeld) respawnQueued = true;
    resetHeld = reset;

    // Fixed-step simulation: predict each tick and send its input.
    acc += dt;
    let firstSeq = 0;
    while (acc >= TICK_S) {
      acc -= TICK_S;
      const bits = input.sample() | (respawnQueued ? INPUT.RESPAWN : 0);
      respawnQueued = false;
      const seq = pred.advance(bits);
      if (!firstSeq) firstSeq = seq;
      outgoing.push(bits);
    }
    if (outgoing.length) {
      if (online) net.sendInput(firstSeq, outgoing);
      outgoing.length = 0;
    }
    pred.decay(dt);

    // Render, interpolating between the last two ticks
    const { prev, cur, err } = pred;
    const alpha = acc / TICK_S;
    const pos = { x: prev.x + (cur.x - prev.x) * alpha + err.x, y: prev.y + (cur.y - prev.y) * alpha + err.y };
    camera.update(pos.x + tuning.width / 2, pos.y + tuning.height / 2, cur.vx, dt, map);
    const { cam } = camera;

    batch.clear();
    const shown = online ? ghosts.sample(net.serverTick(now) - INTERP_TICKS) : [];
    for (const g of shown) {
      let a = ghostAnims.get(g.id);
      if (!a) ghostAnims.set(g.id, (a = createAnimator()));
      const name = ANIMS[g.anim] ?? 'idle';
      const pose = { onGround: name === 'idle' || name === 'run', wallDir: g.facing, facing: g.facing };
      drawPlayer(batch, g, pose, a.update(name, now / 1000), ghostColors, sprites.player, map);
    }
    if (ghostAnims.size > shown.length) {
      const ids = new Set(shown.map((g) => g.id));
      for (const id of ghostAnims.keys()) if (!ids.has(id)) ghostAnims.delete(id);
    }
    const anim = animator.update(animFor(cur), now / 1000);
    drawPlayer(batch, pos, cur, anim, playerColors, sprites.player, map, tuning);
    // Connection indicator, top-left of the view (there's no HUD text until M4)
    const netColor = net.status === 'connected' ? [0.3, 0.8, 0.4, 0.9] : net.status === 'connecting' ? [0.9, 0.8, 0.3, 0.9] : [0.9, 0.2, 0.2, 0.9];
    batch.push(Math.round(cam.x) + 4, Math.round(cam.y) + 4, 3, 3, netColor);

    renderer.frame({ cam: [cam.x, cam.y], sprites: batch });

    if (panel.visible) {
      panel.show(
        `fps ${fps.toFixed(0)}  net ${online ? net.status : 'offline (dev world)'}${net.rtt ? ` ${net.rtt.toFixed(0)}ms` : ''}` +
        `  server tick ${net.serverTick(now).toFixed(0)}\n` +
        `seq ${pred.seq}  ack ${pred.lastAck}  pending ${pred.pending.length}  mismatches ${pred.mismatches}` +
        `  ghosts ${shown.length}/${net.names.size}${online && panelEdited() ? '\ntuning edits ignored online (server tuning). They apply with ?seed=N or ?map=test' : ''}\n` +
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
