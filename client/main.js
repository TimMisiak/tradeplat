// Client entry: boot the renderer, assets and network, then run the game loop.
// Online: the server's world (seed from the welcome message), own movement predicted
// and reconciled, other players drawn as ghosts (ARCHITECTURE.md § Netcode).
// Dev overrides play offline: ?seed=N generates locally, ?map=test loads the M1 test level.
// Trading (M4): prices arrive while standing in a post's zone; E opens the trade menu,
// which sends orders to the server and shows the wallet the server reports.
// Hazards (M5): enemies are computed from the world's spawners at the predicted
// tick; deaths are predicted (splat, fade, respawn) and the server's `died` brings
// the emptied wallet.
import { createRenderer, SpriteBatch, WebGPUUnavailableError } from './gpu/renderer.js';
import { hexToRgba, loadIcons, loadManifest, loadSpriteAtlas, loadTileArt } from './assets.js';
import { createCamera } from './camera.js';
import { createInput } from './input.js';
import { INTERP_TICKS, createGhosts, createKillBook, createNet, createPredictor } from './net.js';
import { animFor, createAnimator, drawPlayer } from './player-view.js';
import { drawEnemies } from './enemy-view.js';
import { createFx, fadeAlpha } from './fx.js';
import { createTuningPanel } from './dev/tuning.js';
import { UiBatch, createTextAtlas } from './ui/text.js';
import { drawHud } from './ui/hud.js';
import { closeMenu, createPriceBook, createTradeMenu, drawTradeMenu, menuKey, menuResult, openMenu } from './ui/trade.js';
import { GOODS } from '../shared/goods.js';
import { postAt } from '../shared/trade.js';
import { ANIMS, INPUT, TICK_RATE, TUNING, tuningHash } from '../shared/physics.js';
import { enemyAt } from '../shared/enemies.js';
import { createSim, spawnPlayer } from '../shared/sim.js';
import { FLAG, SLOPE, TILE, TILES, TILE_SIZE } from '../shared/tiles.js';
import { createTestMap } from '../shared/maps/test.js';
import { GEN_VERSION, generateWorld } from '../shared/worldgen.js';

const TICK_S = 1 / TICK_RATE;
/** Longest frame gap we simulate. Beyond this (tab in background) time is dropped. */
const MAX_FRAME_S = 0.25;
/** Online, the predicted enemy tick is re-anchored to the server clock when it drifts this far. */
const TICK_RESYNC = 4;
/** How long the "you died" message stays up, ms. */
const TOAST_MS = 3500;
const CAUSE_TEXT = { spikes: 'the spikes', patroller: 'a patroller', flyer: 'a flyer', saw: 'a saw' };

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
  const postColors = (manifest?.palette?.posts ?? []).map((h) => hexToRgba(h));
  const postColor = (post) => postColors[post.colorIndex % Math.max(1, postColors.length)] ?? color('uiAccent');
  // Goods without icon art get a swatch in a post color (distinct, and in the palette).
  const iconColor = (id) => postColors[GOODS.findIndex((g) => g.id === id) % Math.max(1, postColors.length)] ?? color('uiText');
  const uiColors = {
    panel: color('uiPanel', 0.94),
    panelSoft: color('uiPanel', 0.7),
    text: color('uiText'),
    dim: shade(color('uiText'), 0.6),
    accent: color('uiAccent'),
    selRow: color('uiAccent', 0.22),
    money: color('money'),
    good: [0.55, 0.85, 0.55, 1],
    bad: color('hazard'),
    shadow: [0, 0, 0, 0.6],
  };
  const enemyColors = { enemy: color('enemy'), hazard: color('hazard'), dark: shade(color('sky'), 0.5), steel: [0.82, 0.84, 0.86, 1] };
  const splatColor = shade(color('hazard'), 0.8);
  const puffColor = color('uiText');
  const fx = createFx();
  const icons = await loadIcons(manifest);
  const ui = new UiBatch();
  let uiScale = 0;

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
  /** @type {{map: import('../shared/tiles.js').TileMap, posts: import('../shared/worldgen.js').Post[], spawn: {tx: number, ty: number},
   *   home: number, seed: number | null, label: string, sim: ReturnType<typeof createSim>} | null} */
  let world = null;
  /** @type {ReturnType<typeof createPredictor> | null} */
  let pred = null;
  const kills = createKillBook();
  // A stomp (ours, predicted, or anyone's, from the server): a puff where it was.
  kills.onKill.push((id, tick) => {
    const sp = world?.sim.spawners[id];
    if (!sp) return;
    const e = enemyAt(sp, tick);
    fx.puff(e.box.x + e.box.w / 2, e.box.y + e.box.h / 2);
  });
  /** Whether the local player was dead last frame, and when it last respawned (ms). */
  let wasDead = false;
  let respawnedAt = -1e9;
  /** The last death message from the server, shown for a few seconds. */
  let toast = null;
  /** Ghost id → whether it was dead in the last frame (to splat once). */
  const ghostDead = new Map();
  const ghosts = createGhosts();
  const book = createPriceBook();
  const menu = createTradeMenu();
  /** The post we're standing in (by our predicted position), and when we walked in. */
  let here = null;
  let enteredAt = 0;
  /** id → animator, so each ghost's animation plays from its own start. */
  const ghostAnims = new Map();
  const TUNING_HASH = tuningHash(TUNING);
  const panelEdited = () => tuningHash(panel.tuning) !== TUNING_HASH;
  if (online && panelEdited()) console.warn('[dev] saved tuning-panel edits are ignored online. They apply with ?seed=N or ?map=test');

  function useWorld(next) {
    world = { ...next, sim: createSim(next.map, next.spawn) };
    renderer.setMap(world.map, styles);
    kills.reset();
    pred = createPredictor(world.sim, spawnPlayer(world.sim, world.home, tuning), tuning, kills);
    ghosts.clear();
    book.clear();
    fx.clear();
    closeMenu(menu);
    here = null;
    wasDead = false;
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
    const n = (k) => gen.spawners.filter((sp) => sp.kind === k).length;
    useWorld({
      map: gen, posts: gen.posts, spawn: post.spawn, home: gen.spawnPost, seed,
      label: `seed ${seed} (${gen.hash}, ${ms.toFixed(0)} ms), spawn at ${post.name}, ` +
        `${gen.stats.spikes} spikes, ${n('patroller')} patrollers, ${n('flyer')} flyers, ${n('saw')} saws`,
    });
    return true;
  }

  const net = createNet({ name: params.get('name') ?? 'Trader' });
  if (params.get('map') === 'test') {
    const map = createTestMap();
    useWorld({ map, posts: [], spawn: map.markers['@'][0], home: -1, seed: null, label: 'M1 test map' });
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
      kills.reset(msg.kills);
      pred.reset(msg.you, msg.ack, Math.round(net.serverTick() + net.lead()));
      wasDead = msg.you.dead > 0;
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
    net.onPrices.push((msg) => book.add(msg, performance.now()));
    net.onTradeResult.push((msg) => menuResult(menu, msg));
    net.onKilled.push((msg) => kills.confirm(msg.id, msg.tick));
    net.onDied.push((msg) => {
      const lost = Object.values(msg.lost).reduce((a, b) => a + b, 0);
      const by = msg.cause === 'gave up' ? 'You gave up' : `Killed by ${CAUSE_TEXT[msg.cause] ?? msg.cause}`;
      toast = { text: lost ? `${by}. Lost ${lost} cargo` : by, at: performance.now() };
    });
  }

  let acc = 0;
  let last = performance.now();
  let fps = 0;
  let respawnQueued = false;
  const outgoing = [];

  // Handles for poking at the client from the dev console.
  globalThis.game = { renderer, net, tuning, ghosts, kills, get world() { return world; }, get pred() { return pred; }, get player() { return pred?.cur; } };

  function frame(now) {
    const dt = Math.min((now - last) / 1000, MAX_FRAME_S);
    last = now;
    fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;

    if (!world) {
      // Waiting for the server's seed.
      batch.clear();
      ui.clear();
      renderer.frame({ cam: [0, 0], sprites: batch, ui });
      requestAnimationFrame(frame);
      return;
    }
    const map = world.map;

    // Trade menu keys. While it's open it takes the keyboard, so the player stands
    // still (the world keeps running).
    const nowMs = performance.now();
    for (const code of input.presses()) {
      if (menu.open) menuKey(menu, code, { goods: book.get(menu.postId)?.goods ?? null, wallet: net.wallet, send: (o) => (online ? net.sendTrade(o) : 0), now: nowMs });
      else if ((code === 'KeyE' || code === 'Enter') && here) openMenu(menu, here.id);
      // R gives up: you die (losing your cargo) and respawn at your last post. It rides
      // on the next tick's input, so the server does the same at the same tick. Taken
      // in order with the menu keys, and once per press (not on auto-repeat).
      else if (code === 'KeyR' && input.tapped('KeyR')) respawnQueued = true;
    }

    // Fixed-step simulation: predict each tick and send its input. Online, enemy
    // ticks run as far ahead of the server clock as our input will arrive (lead), and
    // are consecutive within a frame, so one message's ticks are tick, tick+1, ….
    acc += dt;
    let firstSeq = 0, firstTick = 0;
    let nextTick = pred.tick + 1;
    if (online && net.status === 'connected') {
      const want = Math.round(net.serverTick(now) + net.lead());
      if (Math.abs(nextTick - want) > TICK_RESYNC) nextTick = want;
    }
    while (acc >= TICK_S) {
      acc -= TICK_S;
      const sampled = input.sample();
      const bits = (menu.open ? 0 : sampled) | (respawnQueued ? INPUT.RESPAWN : 0);
      respawnQueued = false;
      const seq = pred.advance(bits, nextTick++);
      if (!firstSeq) { firstSeq = seq; firstTick = pred.tick; }
      outgoing.push(bits);
    }
    if (outgoing.length) {
      if (online) net.sendInput(firstSeq, firstTick, outgoing);
      outgoing.length = 0;
    }
    pred.decay(dt);
    fx.update(dt);

    const at = postAt(world.posts, pred.cur, tuning);
    if (at !== here) { here = at; enteredAt = nowMs; }
    if (menu.open && menu.postId !== here?.id) closeMenu(menu);

    // Render, interpolating between the last two ticks (not across a respawn).
    const { prev, cur, err } = pred;
    const alpha = acc / TICK_S;
    const from = prev.dead > 0 && !cur.dead ? cur : prev;
    const pos = { x: from.x + (cur.x - from.x) * alpha + err.x, y: from.y + (cur.y - from.y) * alpha + err.y };
    if (cur.dead > 0 && !wasDead) fx.splat(...center(cur), nowMs, true);
    if (!cur.dead && wasDead) {
      respawnedAt = nowMs;
      camera.snap(...center(cur), map);
    }
    wasDead = cur.dead > 0;
    camera.update(pos.x + tuning.width / 2, pos.y + tuning.height / 2, cur.vx, dt, map);
    const [shakeX, shakeY] = fx.shakeOffset();
    const cam = { x: camera.cam.x + shakeX, y: camera.cam.y + shakeY };
    const renderTick = pred.prevTick + (pred.tick - pred.prevTick) * alpha;

    batch.clear();
    ui.clear();
    const scale = Math.max(1, Math.round(renderer.viewport.scale));
    if (scale !== uiScale) {
      uiScale = scale;
      ui.setAtlas(createTextAtlas(scale, icons));
    }
    const cx = Math.round(cam.x), cy = Math.round(cam.y);
    drawPosts(world.posts, cx, cy);
    fx.drawStains(batch, splatColor, nowMs);
    drawEnemies(batch, world.sim, kills.view, renderTick, { x: cx - 64, y: cy - 64, w: 640 + 128, h: 360 + 128 }, sprites, enemyColors);
    const shown = online ? ghosts.sample(net.serverTick(now) - INTERP_TICKS) : [];
    for (const g of shown) {
      let a = ghostAnims.get(g.id);
      if (!a) ghostAnims.set(g.id, (a = createAnimator()));
      const name = ANIMS[g.anim] ?? 'idle';
      const dead = name === 'death';
      if (dead && ghostDead.get(g.id) === false) fx.splat(g.x + tuning.width / 2, g.y + tuning.height / 2, nowMs);
      ghostDead.set(g.id, dead);
      if (dead) continue;
      const pose = { onGround: name === 'idle' || name === 'run', wallDir: g.facing, facing: g.facing };
      drawPlayer(batch, g, pose, a.update(name, now / 1000), ghostColors, sprites.player, map);
      const tag = net.names.get(g.id);
      if (tag) ui.textCenter(Math.round(g.x + tuning.width / 2 - cx), Math.round(g.y - cy) - 20, tag, uiColors.dim, uiColors.shadow);
    }
    if (ghostAnims.size > shown.length) {
      const ids = new Set(shown.map((g) => g.id));
      for (const id of ghostAnims.keys()) if (!ids.has(id)) { ghostAnims.delete(id); ghostDead.delete(id); }
    }
    const anim = animator.update(animFor(cur), now / 1000);
    if (!cur.dead) drawPlayer(batch, pos, cur, anim, playerColors, sprites.player, map, tuning);
    fx.drawParticles(batch, splatColor, puffColor);
    const fade = fadeAlpha(cur.dead, (nowMs - respawnedAt) / 1000 * TICK_RATE);
    if (fade > 0) ui.rect(0, 0, 640, 360, [0, 0, 0, fade]);
    if (toast && nowMs - toast.at > TOAST_MS) toast = null;
    const netColor = !online ? [0.5, 0.5, 0.5, 0.9] : net.status === 'connected' ? [0.3, 0.8, 0.4, 0.9] : net.status === 'connecting' ? [0.9, 0.8, 0.3, 0.9] : [0.9, 0.2, 0.2, 0.9];
    drawHud(ui, {
      wallet: online ? net.wallet : null,
      post: here,
      postColor: here && postColor(here),
      netColor,
      board: online ? net.board : [],
      playerId: net.playerId,
      menuOpen: menu.open,
      toast: toast?.text ?? null,
      colors: uiColors,
    });
    if (menu.open && here) {
      const prices = book.get(here.id);
      drawTradeMenu(ui, menu, {
        post: here,
        postColor: postColor(here),
        prices,
        live: !!prices && prices.at >= enteredAt,
        offline: !online,
        wallet: online ? net.wallet : null,
        book,
        postName: (id) => world.posts[id]?.name ?? `post ${id}`,
        now: nowMs,
        colors: uiColors,
        iconColor,
      });
    }

    renderer.frame({ cam: [cam.x, cam.y], sprites: batch, ui });

    if (panel.visible) {
      panel.show(
        `fps ${fps.toFixed(0)}  net ${online ? net.status : 'offline (dev world)'}${net.rtt ? ` ${net.rtt.toFixed(0)}ms` : ''}` +
        `  server tick ${net.serverTick(now).toFixed(0)}\n` +
        `seq ${pred.seq}  ack ${pred.lastAck}  pending ${pred.pending.length}  mismatches ${pred.mismatches}  enemy tick ${pred.tick}` +
        `  ghosts ${shown.length}/${net.names.size}${online && panelEdited() ? '\ntuning edits ignored online (server tuning). They apply with ?seed=N or ?map=test' : ''}\n` +
        `world ${world.label}\n` +
        `pos ${cur.x.toFixed(1)}, ${cur.y.toFixed(1)}  tile ${Math.floor((cur.x + tuning.width / 2) / TILE_SIZE)}, ${Math.floor((cur.y + tuning.height) / TILE_SIZE)}\n` +
        `vel ${cur.vx.toFixed(2)}, ${cur.vy.toFixed(2)}  anim ${anim.anim}\n` +
        `ground ${cur.onGround ? 'y' : 'n'}  wall ${cur.wallDir}  coyote ${cur.coyote}  buffer ${cur.jumpBuffer}  lock ${cur.wallLock}\n` +
        `home ${world.posts[cur.home]?.name ?? cur.home}  dead ${cur.dead}  kills ${Object.keys(kills.view).length} (${kills.predicted.length} predicted)\n` +
        'R gives up (respawn at your last post, cargo lost)',
      );
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /**
   * Post signs (tinted with the post's color) hanging in both doorways, and the
   * post's name over its roof. Only posts near the view are drawn.
   */
  function drawPosts(posts, cx, cy) {
    const sign = sprites.postSign;
    const frame0 = sign?.anims.idle?.frames[0];
    for (const post of posts) {
      const px0 = post.x * TILE_SIZE, px1 = (post.x + post.w) * TILE_SIZE, top = post.y * TILE_SIZE;
      if (px1 < cx - 64 || px0 > cx + 640 + 64 || top > cy + 360 + 64 || top + post.h * TILE_SIZE < cy - 64) continue;
      const tint = postColor(post);
      // The doorway starts under the 3-row wall stub (WORLDGEN.md § Pipeline).
      const hang = (post.y + 4) * TILE_SIZE + 12;
      for (const tx of [post.x, post.x + post.w - 1]) {
        const x = tx * TILE_SIZE + TILE_SIZE / 2;
        if (frame0) batch.push(x - sign.anchor[0], hang - sign.anchor[1], sign.frame[0], sign.frame[1], tint, frame0);
        else batch.push(x - 10, hang - 8, 20, 6, tint);
      }
      ui.textCenter(Math.round((px0 + px1) / 2 - cx), top - 14 - cy, post.name, tint, uiColors.shadow);
    }
  }
}

boot();
