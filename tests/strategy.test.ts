import assert from 'node:assert/strict';
import { MAPS, MAP_W, MAP_H, terrainHeightAt, type BotCount, type Faction } from '../src/maps';
import { createGame, getPlayerVisionCircles, isPointExplored, isPointVisible, updateFog, updateGame } from '../src/game';
import { findPath, getNav } from '../src/nav';

assert.equal(MAP_W, 10240);
assert.equal(MAP_H, 5760);
assert.equal(MAPS.length, 4);

for (const map of MAPS) {
  assert.ok(map.obstacles.filter((o) => o.kind === 'rock').length >= 800, `${map.name}: not enough rocks`);
  assert.ok(map.elevations.length > 20, `${map.name}: missing elevations`);
  assert.equal(terrainHeightAt(map, map.elevations[0].x, map.elevations[0].y), 2);
  assert.ok(terrainHeightAt(map, map.elevations[1].x, map.elevations[1].y) >= 3);
  const nav = getNav(map, ['player', 'enemy', 'enemy2', 'enemy3']);
  for (const faction of ['enemy', 'enemy2', 'enemy3'] as Faction[]) {
    const from = map.rally.player;
    const destination = map.bases[faction];
    const path = findPath(nav, from.x, from.y, destination.x, destination.y);
    assert.ok(path?.length, `${map.name}: no route to ${faction}`);
    let previous = from;
    for (const point of path) {
      assert.ok(!map.obstacles.some((o) => Math.hypot(point.x - o.x, point.y - o.y) < o.r), `${map.name}: path crosses rock`);
      const samples = Math.ceil(Math.hypot(point.x - previous.x, point.y - previous.y) / 12);
      for (let i = 0; i <= samples; i++) {
        const ratio = samples ? i / samples : 0;
        const x = previous.x + (point.x - previous.x) * ratio;
        const y = previous.y + (point.y - previous.y) * ratio;
        assert.ok(!map.obstacles.some((o) => Math.hypot(x - o.x, y - o.y) < o.r + 8), `${map.name}: route segment intersects a rock`);
      }
      previous = point;
    }
  }
}

for (const count of [1, 2, 3] as BotCount[]) {
  const game = createGame('normal', 'ash', count);
  assert.equal(game.bots.length, count);
  assert.equal(game.factions.length, count + 1);
  for (const faction of game.factions) {
    assert.equal(game.units.filter((u) => u.faction === faction).length, 4);
    assert.equal(game.baseHp[faction], 1500);
  }
  for (const faction of (['enemy2', 'enemy3'] as const).slice(count - 1)) {
    assert.equal(game.baseHp[faction], 0);
  }
  game.status = 'playing';
  for (let i = 0; i < 500; i++) updateGame(game, 0.05);
  for (const bot of game.bots) {
    assert.ok(game.units.filter((u) => u.faction === bot).length > 4, `${bot} did not produce units`);
    assert.ok(game.units.some((u) => u.faction === bot && (u.mode !== 'idle' || u.odo > 100)), `${bot} did not issue orders`);
  }
}

{
  const game = createGame('normal', 'ash', 3);
  const scout = game.units.find((u) => u.faction === 'player')!;
  const point = game.points[5];
  assert.equal(isPointExplored(game, point.x, point.y), false);
  assert.equal(game.baseScouted.enemy, false);
  scout.x = point.x; scout.y = point.y;
  updateFog(game);
  assert.equal(isPointVisible(game, point.x, point.y), true);
  assert.equal(point.scouted, true);
  scout.x = game.map.bases.player.x; scout.y = game.map.bases.player.y;
  updateFog(game);
  assert.equal(isPointVisible(game, point.x, point.y), false);
  assert.equal(isPointExplored(game, point.x, point.y), true);

  const hill = game.map.elevations[1];
  scout.x = hill.x; scout.y = hill.y;
  const elevated = getPlayerVisionCircles(game).find((c) => c.x === hill.x && c.y === hill.y)!;
  scout.x = game.map.bases.player.x; scout.y = game.map.bases.player.y;
  const low = getPlayerVisionCircles(game).find((c) => c.x === scout.x && c.r < 500)!;
  assert.ok(elevated.r > low.r, 'high ground should increase vision');
}

{
  const game = createGame('normal', 'ash', 3);
  game.status = 'playing';
  game.units = game.units.filter((u) => u.faction === 'enemy' || u.faction === 'enemy2');
  for (const u of game.units) { u.x = 6000 + u.id * 30; u.y = 1000; u.mode = 'idle'; }
  game.botThink = { enemy: 999, enemy2: 999, enemy3: 999 };
  updateGame(game, 0.05);
  assert.ok(game.units.every((u) => !u.target), 'allied bots must not attack each other');
}

{
  const game = createGame('normal', 'ash', 1);
  game.status = 'playing';
  const invader = game.units.find((u) => u.faction === 'enemy')!;
  const base = game.map.bases.player;
  invader.x = base.x + 150; invader.y = base.y;
  game.units = [invader];
  game.botThink.enemy = 999;
  let fired = false;
  for (let i = 0; i < 60; i++) {
    updateGame(game, 0.05);
    fired ||= game.sounds.some((s) => s.type === 'shot' && s.kind === 'base');
    game.sounds.length = 0;
  }
  assert.ok(fired, 'player base should defend itself');
  assert.ok(invader.hp < invader.maxHp, 'base shot should damage invader');
}

for (const count of [1, 2, 3] as BotCount[]) {
  const game = createGame('normal', 'ash', count);
  game.status = 'playing';
  game.units = [];
  game.botThink = { enemy: 999, enemy2: 999, enemy3: 999 };
  for (let i = 0; i < game.bots.length; i++) {
    const bot = game.bots[i];
    const base = game.map.bases[bot];
    game.baseHp[bot] = 1;
    game.projectiles.push({
      sx: base.x, sy: base.y, x: base.x, y: base.y, tx: base.x, ty: base.y,
      faction: 'player', target: { type: 'base', faction: bot }, damage: 10, splash: 0, speed: 560, kind: 'rifle', dead: false,
    });
    updateGame(game, 0.05);
    assert.equal(game.baseHp[bot], 0);
    assert.equal(game.status, i === game.bots.length - 1 ? 'victory' : 'playing');
  }
}

console.log('Strategy tests passed: maps, elevation, pathfinding, fog, 1-3 bots, allies, base defense and victory.');