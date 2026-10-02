// M5: deterministic trig, enemy motion and phases, spikes, stomps, death and
// respawn in shared/sim.js, the client's kill book, and the server's side of
// deaths and kills. See DESIGN.md § Enemies and hazards and ARCHITECTURE.md § Enemies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosTurns, sinTurns } from '../shared/mathdet.js';
import { ENEMY, HIT, PHASE, buildEnemyIndex, enemiesNear, enemyAt, enemyExtent, enemyHit, enemyPhase } from '../shared/enemies.js';
import { CAUSE, DEATH_TICKS, createSim, spawnPlayer, stepPlayer, touchesSpikes } from '../shared/sim.js';
import { INPUT, TUNING, createPlayer } from '../shared/physics.js';
import { TILE_SIZE, parseAsciiMap } from '../shared/tiles.js';
import { createKillBook, createPredictor } from '../client/net.js';
import { createGame } from '../server/game.js';

const { LEFT, RIGHT, JUMP, RESPAWN } = INPUT;
const T = TILE_SIZE;

test('mathdet: sin and cos in turns match Math within 1e-8', () => {
  for (let i = -2000; i <= 2000; i++) {
    const t = i * 0.0137;
    assert.ok(Math.abs(sinTurns(t) - Math.sin(2 * Math.PI * t)) < 1e-8, `sin ${t}`);
    assert.ok(Math.abs(cosTurns(t) - Math.cos(2 * Math.PI * t)) < 1e-8, `cos ${t}`);
  }
  assert.equal(sinTurns(0), 0);
  assert.ok(Math.abs(sinTurns(0.25) - 1) < 1e-11 && Math.abs(sinTurns(0.75) + 1) < 1e-11);
});

const patroller = { id: 0, kind: 'patroller', x: 5, y: 9, params: { x0: 100, x1: 148, floor: 160, speed: 0.75, phase: 0 } };
const flyer = { id: 1, kind: 'flyer', x: 20, y: 5, params: { rx: 48, ry: 16, period: 200, phase: 17, path: 'eight' } };
const loop = { id: 2, kind: 'flyer', x: 30, y: 5, params: { rx: 32, ry: 32, period: 150, phase: 0, path: 'loop' } };
const saw = { id: 3, kind: 'saw', x: 40, y: 9, params: { x0: 648, y0: 100, x1: 648, y1: 148, period: 120, phase: 30 } };

test('patroller: walks to the end, stands and swings, walks back', () => {
  const P = ENEMY.patroller;
  const walk = (148 - 100) / 0.75; // 64 ticks
  assert.deepEqual([enemyAt(patroller, 0).x, enemyAt(patroller, 0).facing, enemyAt(patroller, 0).anim], [100, 1, 'walk']);
  assert.equal(enemyAt(patroller, 32).x, 124);
  const end = enemyAt(patroller, walk);
  assert.deepEqual([end.x, end.anim, end.attack], [148, 'idle', null]);
  assert.deepEqual([enemyAt(patroller, walk + P.windup[0]).anim, enemyAt(patroller, walk + P.windup[0]).frame], ['swing', 0]);
  const strike = enemyAt(patroller, walk + P.strike[0]);
  assert.equal(strike.frame, 1);
  assert.ok(strike.attack && strike.attack.x === 148 + P.w / 2 && strike.attack.w === P.reach, 'sword out in front');
  assert.equal(enemyAt(patroller, walk + P.strike[1]).attack, null, 'and put away');
  const back = enemyAt(patroller, walk + P.pause + 10);
  assert.deepEqual([back.x, back.facing], [148 - 7.5, -1]);
  const period = 2 * (walk + P.pause);
  assert.deepEqual(enemyAt(patroller, 5 + period * 1000), enemyAt(patroller, 5), 'periodic, exactly');
  assert.equal(enemyAt(patroller, 0).box.y + enemyAt(patroller, 0).box.h, 160, 'feet on the floor');
});

test('every pose stays inside the enemy extent', () => {
  for (const sp of [patroller, flyer, loop, saw]) {
    const e = enemyExtent(sp);
    for (let t = 0; t < 400; t++) {
      const { box, attack } = enemyAt(sp, t);
      for (const b of [box, attack].filter(Boolean)) {
        assert.ok(b.x >= e.x0 - 1e-9 && b.y >= e.y0 - 1e-9 && b.x + b.w <= e.x1 + 1e-9 && b.y + b.h <= e.y1 + 1e-9, `${sp.kind} at ${t}`);
      }
    }
  }
  // Saws ease between their ends.
  const half = enemyAt(saw, 60 - 30);
  assert.ok(Math.abs(enemyAt(saw, -30).y - 100) < 1e-9 && Math.abs(half.y - 148) < 1e-9);
});

test('hits: saws are round, patrollers have a body and a sword', () => {
  const s = enemyAt(saw, -30); // centre (648, 100), r 11
  assert.equal(enemyHit(s, 648 + 8, 100 - 2, 10, 4), HIT.BODY);
  assert.equal(enemyHit(s, 648 + 8, 100 + 8, 10, 4), HIT.NONE, 'the square corner of the bounding box is safe');
  const strike = enemyAt(patroller, 64 + ENEMY.patroller.strike[0]);
  assert.equal(enemyHit(strike, strike.attack.x + 4, strike.attack.y, 4, 4), HIT.ATTACK);
  assert.equal(enemyHit(strike, strike.box.x, strike.box.y, 4, 4), HIT.BODY);
});

test('enemyPhase: alive through the kill tick, dead, blinking, back', () => {
  const kills = { 7: 1000 };
  assert.equal(enemyPhase(kills, 7, 990), PHASE.ALIVE);
  assert.equal(enemyPhase(kills, 7, 1000), PHASE.ALIVE, 'replaying the stomp tick finds it alive');
  assert.equal(enemyPhase(kills, 7, 1001), PHASE.DEAD);
  assert.equal(enemyPhase(kills, 7, 1000 + ENEMY.respawnTicks), PHASE.SPAWNING);
  assert.equal(enemyPhase(kills, 7, 1000 + ENEMY.respawnTicks + ENEMY.graceTicks), PHASE.ALIVE);
  assert.equal(enemyPhase(kills, 8, 1001), PHASE.ALIVE);
});

test('enemy index: finds what can reach a rect, once each, in order', () => {
  const sps = [patroller, flyer, loop, saw];
  const index = buildEnemyIndex(sps, 64, 32);
  assert.deepEqual(enemiesNear(index, 0, 0, 64 * T, 32 * T), [0, 1, 2, 3]);
  assert.deepEqual(enemiesNear(index, 110, 150, 120, 160), [0]);
  for (const [i, sp] of sps.entries()) {
    const e = enemyExtent(sp);
    assert.ok(enemiesNear(index, e.x0, e.y0, e.x0 + 1, e.y0 + 1).includes(i));
  }
});

// A small level: spawn left, a post zone-less runway, spikes, room for enemies.
const LEVEL = parseAsciiMap([
  '##############################',
  '#............................#',
  '#............................#',
  '#............................#',
  '#............................#',
  '#............................#',
  '#............................#',
  '#.@..........^^^.............#',
  '##############################',
]);
const FLOOR = 8 * T;

function level(spawners = []) {
  const map = { ...LEVEL, spawners };
  return createSim(map, map.markers['@'][0]);
}
/** Run inputs from a state; returns every state and the events. */
function run(sim, p, inputs, { tick = 0, kills = {} } = {}) {
  const states = [], events = [];
  inputs.forEach((bits, i) => {
    const out = [];
    p = stepPlayer(p, bits, tick + i, sim, kills, out);
    for (const e of out) events.push({ ...e, at: i });
    states.push(p);
  });
  return { p, states, events };
}
const hold = (bits, n) => Array(n).fill(bits);

test('spikes kill; you respawn at home DEATH_TICKS later, input ignored meanwhile', () => {
  const sim = level();
  const start = spawnPlayer(sim, -1);
  assert.deepEqual([start.dead, start.home], [0, -1]);
  const { states, events } = run(sim, start, hold(RIGHT, 200));
  const died = events.find((e) => e.type === 'died');
  assert.ok(died, 'walked into the spikes');
  assert.equal(died.cause, CAUSE.SPIKES);
  const d = states[died.at];
  assert.equal(d.dead, DEATH_TICKS);
  assert.ok(d.x + TUNING.width > 13 * T && d.x < 16 * T, 'died at the spikes');
  assert.deepEqual(states[died.at + DEATH_TICKS - 1].x, d.x, 'stays put while dead');
  const back = states[died.at + DEATH_TICKS];
  assert.equal(back.dead, 0);
  assert.deepEqual({ ...back, buttons: 0 }, spawnPlayer(sim, -1), 'respawned fresh at the spawn');
  assert.equal(back.buttons, RIGHT, 'held input counts as already pressed');
});

test('a 3-wide spike run can be jumped clean (worldgen places runs of 1–3)', () => {
  const sim = level();
  const { events, p } = run(sim, spawnPlayer(sim, -1), [...hold(RIGHT, 30), ...hold(RIGHT | JUMP, 20), ...hold(RIGHT, 40)]);
  assert.equal(events.length, 0, JSON.stringify(events));
  assert.ok(p.x > 17 * T);
});

test('spike teeth: only the part near the base hurts', () => {
  const map = parseAsciiMap(['#####', '#...#', '#.^.#', '#####']);
  const x = 2 * T, top = 2 * T;
  assert.equal(touchesSpikes(map, x, top - 10, 16, 10), false, 'standing in the air above');
  assert.equal(touchesSpikes(map, x, top - 10, 16, 15), false, 'feet in the empty top of the tile');
  assert.equal(touchesSpikes(map, x, top - 10, 16, 17), true, 'feet in the teeth');
  assert.equal(touchesSpikes(map, x - 14, top + 8, 15, 4), false, 'beside it, inside the side inset');
  const ceiling = parseAsciiMap(['#####', '#.^.#', '#...#', '#####']);
  assert.equal(touchesSpikes(ceiling, 2 * T, T + 11, 16, 8), false, 'below a ceiling spike');
  assert.equal(touchesSpikes(ceiling, 2 * T, T + 9, 16, 8), true);
});

test('giving up (R) is a death like any other', () => {
  const sim = level();
  const { events, states } = run(sim, spawnPlayer(sim, -1), [RIGHT, RIGHT, RESPAWN, 0]);
  assert.deepEqual(events.map((e) => [e.type, e.cause, e.at]), [['died', CAUSE.GAVE_UP, 2]]);
  assert.equal(states[3].dead, DEATH_TICKS - 1);
});

test('home is the last post zone you stood in', () => {
  const sim = { ...level(), posts: [{ id: 4, zone: { x0: 6, y0: 6, x1: 8, y1: 7 }, spawn: { tx: 7, ty: 7 } }] };
  const { states } = run(sim, spawnPlayer(sim, -1), hold(RIGHT, 30));
  assert.equal(states.at(-1).home, 4);
  assert.equal(states[0].home, -1);
  const respawned = run(sim, states.at(-1), [RESPAWN, ...hold(0, DEATH_TICKS)]).p;
  assert.deepEqual([respawned.x, respawned.y], [spawnPlayer(sim, 4).x, spawnPlayer(sim, 4).y]);
});

/** A patroller standing still: x0 = x1, so it's always paused at x, swinging to each side in turn. */
const standing = (x, phase) => ({ id: 0, kind: 'patroller', x: 0, y: 7, params: { x0: x, x1: x, floor: FLOOR, speed: 1, phase } });

test('stomping a patroller kills it and bounces you; walking into it kills you', () => {
  const sp = standing(120, 0);
  const sim = level([sp]);
  const walkInto = run(sim, spawnPlayer(sim, -1), hold(RIGHT, 60));
  assert.equal(walkInto.events[0]?.type, 'died');
  assert.equal(walkInto.events[0].cause, CAUSE.PATROLLER);

  // Drop onto it from above, then fall again past where it was (it's dead now).
  const pose = enemyAt(sp, 0);
  const above = { ...createPlayer(pose.x, pose.box.y - 30), dead: 0, home: -1 };
  const kills = {};
  const out = [];
  let p = above;
  let tick = 0;
  for (; tick < 30 && !out.length; tick++) p = stepPlayer(p, JUMP, tick, sim, kills, out);
  assert.deepEqual(out, [{ type: 'stomp', id: 0, tick: tick - 1 }]);
  assert.ok(p.vy < 0 && p.jumping, 'bounced');
  assert.ok(p.y + TUNING.height <= pose.box.y + 6);
  // Held jump: a full bounce. Released: cut short.
  const held = run(sim, p, hold(JUMP, 40), { tick, kills: { 0: tick - 1 } }).states;
  const cut = run(sim, p, hold(0, 40), { tick, kills: { 0: tick - 1 } }).states;
  assert.ok(Math.min(...held.map((s) => s.y)) < Math.min(...cut.map((s) => s.y)) - 20);
  assert.ok(!held.some((s) => s.dead), 'landing where a dead patroller was is safe');
});

test('the patroller sword hurts only while it is out', () => {
  // Standing just in front of a paused patroller that faces right.
  const P = ENEMY.patroller;
  const sp = standing(100, 0);
  const sim = level([sp]);
  const walk = 0; // it stands still, facing right for the first pause
  const x = 100 + P.w / 2 + 2; // in sword reach, clear of the body
  const p = { ...createPlayer(x + TUNING.width / 2 - 2, FLOOR), dead: 0, home: -1 };
  const at = (tick) => { const out = []; stepPlayer(p, 0, tick, sim, {}, out); return out[0]?.cause ?? null; };
  assert.equal(at(walk + P.windup[0]), null, 'wind-up is a warning');
  assert.equal(at(walk + P.strike[0]), CAUSE.PATROLLER);
  assert.equal(at(walk + P.strike[1] + 1), null);
});

test('saws and flyers kill on contact, and cannot be stomped', () => {
  const sim = level([{ id: 0, kind: 'saw', x: 0, y: 0, params: { x0: 120, y0: FLOOR - 12, x1: 120, y1: FLOOR - 12, period: 100, phase: 0 } }]);
  const { events } = run(sim, spawnPlayer(sim, -1), hold(RIGHT, 60));
  assert.equal(events[0].cause, CAUSE.SAW);
  const fsim = level([{ id: 0, kind: 'flyer', x: 7, y: 5, params: { rx: 0, ry: 0, period: 100, phase: 0, path: 'loop' } }]);
  const pose = enemyAt(fsim.spawners[0], 0);
  const drop = run(fsim, { ...createPlayer(pose.x, pose.box.y - 20), dead: 0, home: -1 }, hold(0, 20)).events;
  assert.deepEqual(drop.map((e) => [e.type, e.cause]), [['died', CAUSE.FLYER]]);
});

test('a dead or blinking enemy is harmless', () => {
  const sp = standing(120, 0);
  const sim = level([sp]);
  const byIt = (kills) => run(sim, spawnPlayer(sim, -1), hold(RIGHT, 60), { kills }).events.filter((e) => e.cause === CAUSE.PATROLLER);
  assert.equal(byIt({}).length, 1);
  assert.equal(byIt({ 0: -5 }).length, 0, 'dead');
  assert.equal(byIt({ 0: 2 - ENEMY.respawnTicks }).length, 0, 'blinking from tick 2 to past 60');
});

test('kill book: predicted stomps show at once, settle against the server', () => {
  const book = createKillBook();
  const seen = [];
  book.onKill.push((id, tick) => seen.push([id, tick]));
  book.reset({ 1: 50 });
  book.predict(2, 100, 7);
  book.predict(2, 100, 7);
  assert.deepEqual(book.view, { 1: 50, 2: 100 });
  assert.deepEqual(seen, [[2, 100]], 'once, even when a replay repeats it');
  book.confirm(2, 100);
  assert.deepEqual(book.predicted, []);
  assert.deepEqual(seen, [[2, 100]]);
  // A stomp the server never confirmed is taken back once its input is acknowledged.
  book.predict(3, 120, 9);
  book.settle(8);
  assert.equal(book.view[3], 120);
  book.settle(9);
  assert.equal(book.view[3], undefined);
  // Someone else's kill arrives.
  book.confirm(4, 130);
  assert.deepEqual(seen.at(-1), [4, 130]);
});

test('prediction matches the server through stomps, deaths and respawns', () => {
  const game = createGame({ seed: 7 });
  for (let i = 0; i < 10; i++) game.advance();
  const p = game.addPlayer('stomper');
  const t0 = game.tick + 2;
  // Find a spot above a patroller from which falling with jump held stomps it.
  const script = (i) => (i < 60 ? JUMP : ((i >> 6) & 1 ? LEFT : RIGHT) | (i % 50 < 20 ? JUMP : 0)) | (i === 400 ? RESPAWN : 0);
  let start = null, target = null;
  for (const sp of game.world.spawners.filter((s) => s.kind === 'patroller')) {
    for (let dx = -48; dx <= 48 && !start; dx += 4) {
      const s0 = { ...p.state, x: (sp.params.x0 + sp.params.x1) / 2 + dx - TUNING.width / 2, y: sp.params.floor - 70, onGround: false };
      const out = [];
      let s = s0;
      for (let i = 1; i <= 60 && !out.length; i++) s = stepPlayer(s, script(i), t0 + i - 1, game.sim, {}, out);
      if (out[0]?.type === 'stomp') { start = s0; target = sp.id; }
    }
    if (start) break;
  }
  assert.ok(start, 'found a stomp');
  p.state = start;
  const kills = createKillBook();
  kills.reset(game.enemies.kills);
  const events = [];
  game.onEvent.push((who, e) => {
    if (e.type === 'killed') kills.confirm(e.id, e.tick);
    if (who === p) events.push(e.type);
  });
  const pred = createPredictor(game.sim, p.state, TUNING, kills);
  pred.reset(p.state, 0, t0 - 1);
  for (let i = 1; i <= 600; i++) {
    const seq = pred.advance(script(i));
    game.receiveInput(p, seq, [script(i)], pred.tick);
    game.advance();
    if (i % 3 === 0) pred.reconcile(p.seq, p.state);
  }
  assert.equal(pred.mismatches, 0);
  assert.ok(events.includes('killed') && events.includes('died'), events.join());
  assert.equal(kills.view[target], game.enemies.kills[target], 'the client agrees which enemy died, and when');
  assert.deepEqual(kills.predicted, [], 'every predicted stomp confirmed');
  assert.equal(pred.cur.dead, 0, 'respawned');
});

test('server: a death clears cargo (not money), and nobody trades while dead', () => {
  const game = createGame({ seed: 3 });
  const p = game.addPlayer('unlucky');
  p.wallet = { ...p.wallet, money: 123, cargo: { ore: 4 }, paid: { ore: 20 } };
  const events = [];
  game.onEvent.push((who, e) => events.push([who.id, e]));
  game.receiveInput(p, 1, [RESPAWN], game.tick);
  assert.equal(events.length, 1);
  const [id, e] = events[0];
  assert.equal(id, p.id);
  assert.deepEqual([e.type, e.cause, e.lost], ['died', CAUSE.GAVE_UP, { ore: 4 }]);
  assert.deepEqual(p.wallet, { ...p.wallet, money: 123, cargo: {}, paid: {} });
  assert.equal(p.deaths, 1);
  assert.equal(game.trade(p, { postId: game.world.spawnPost, goodId: 'ore', qty: 1, side: 'buy' }).reason, 'dead');
});

test('server: an input tick far from server time is clamped to the lag window', () => {
  const game = createGame({ seed: 3 });
  const sp = game.world.spawners.find((s) => s.kind === 'saw');
  const p = game.addPlayer('timer');
  for (let i = 0; i < 100; i++) game.advance();
  // Park the player on the saw's track, and find a tick when it's there and one when it isn't.
  const e0 = enemyAt(sp, 0);
  p.state = { ...p.state, x: e0.x - TUNING.width / 2, y: e0.y - TUNING.height / 2, vx: 0, vy: 0, onGround: false };
  const hit = (tick) => {
    const out = [];
    stepPlayer(p.state, 0, tick, game.sim, {}, out);
    return out.length > 0;
  };
  let far = 100000;
  while (!hit(far)) far++;
  // A tick far in the future where the saw would hit is not believed.
  const near = [...Array(31)].map((_, k) => game.tick - 15 + k).filter(hit);
  game.receiveInput(p, 1, [0], far);
  assert.equal(p.state.dead > 0, near.includes(game.tick + 15));
});
