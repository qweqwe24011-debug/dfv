/* Игровая логика: юниты, бой, экономика, бот. Без React. */
import {
  MAP_W, MAP_H, BOT_FACTIONS, FACTION_NAMES, allied, getMap, terrainHeightAt,
  type BotCount, type BotFaction, type Faction, type MapDef, type MapPoint, type Pt,
} from './maps';
import type { SoundEvent } from './audio';
import { getNav, findPath, lineClear, type NavGrid } from './nav';

/** Размер видимой части большой карты. */
export const VW = 1600;
export const VH = 900;
export const EDGE = 30;
/** Радиус обороны базы — «немного стреляет» по подходящим врагам */
export const BASE_RANGE = 240;
/** Радиус разведки базы и захваченных точек */
export const BASE_SIGHT = 500;
export const POINT_SIGHT = 300;
export const FOG_CELL = 32;
export const FOG_COLS = Math.ceil(MAP_W / FOG_CELL);
export const FOG_ROWS = Math.ceil(MAP_H / FOG_CELL);

export type UnitKind = 'rifle' | 'tank' | 'arty';
export type GameStatus = 'menu' | 'playing' | 'paused' | 'victory' | 'defeat';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type TargetRef = { type: 'unit'; id: number } | { type: 'base'; faction: Faction } | null;

export interface UnitDef {
  playerName: string; enemyName: string; cost: number; build: number; hp: number;
  damage: number; range: number; sight: number; speed: number; radius: number;
  cooldown: number; projSpeed: number; splash: number; minRange: number; role: string;
}

export const UNIT_DEFS: Record<UnitKind, UnitDef> = {
  rifle: {
    playerName: 'Штурмовик', enemyName: 'Захватчик', cost: 50, build: 2.1, hp: 115,
    damage: 11, range: 118, sight: 200, speed: 150, radius: 11, cooldown: 0.55,
    projSpeed: 560, splash: 0, minRange: 0, role: 'Быстрая пехота. Дешёвая и мобильная.',
  },
  tank: {
    playerName: 'Танк «Голиаф»', enemyName: 'Разрушитель', cost: 130, build: 4.2, hp: 390,
    damage: 25, range: 134, sight: 215, speed: 95, radius: 16, cooldown: 1.05,
    projSpeed: 480, splash: 14, minRange: 0, role: 'Фронт линии. Много брони, сильный урон.',
  },
  arty: {
    playerName: 'Артиллерия', enemyName: 'Осадный мортир', cost: 110, build: 3.8, hp: 78,
    damage: 44, range: 244, sight: 295, speed: 75, radius: 13, cooldown: 2.35,
    projSpeed: 390, splash: 52, minRange: 72, role: 'Огромная дальность и урон по площади.',
  },
};

export const DIFFS: Record<Difficulty, { label: string; botIncome: number; attackSize: number; desc: string }> = {
  easy: { label: 'Лёгкая', botIncome: 0.72, attackSize: 10, desc: 'Бот атакует редко, доход ниже' },
  normal: { label: 'Нормальная', botIncome: 1, attackSize: 7, desc: 'Честный противник' },
  hard: { label: 'Сложная', botIncome: 1.32, attackSize: 5, desc: 'Бот богат и очень агрессивен' },
};

export interface Unit {
  id: number; faction: Faction; kind: UnitKind; x: number; y: number; hp: number; maxHp: number;
  angle: number; cooldown: number; tx: number; ty: number;
  mode: 'idle' | 'move' | 'attackmove' | 'attack'; target: TargetRef; flash: number; dead: boolean;
  /** пройденный путь — для анимации гусениц/шага */
  odo: number;
  /** отдача орудия (0..1), затухает */
  recoil: number;
  /** направление башни — поворачивается к цели независимо от корпуса */
  turret: number;
  /** найденный путь в обход препятствий (сглаженные точки) */
  path: Pt[];
  pathI: number;
  pathGoal: Pt | null;
  pathAt: number;
  /** сколько секунд юнит почти не двигается — для перерасчёта маршрута */
  stuck: number;
}
export interface Projectile {
  sx: number; sy: number;
  x: number; y: number; tx: number; ty: number; faction: Faction; target: TargetRef;
  damage: number; splash: number; speed: number; kind: UnitKind | 'base'; dead: boolean;
}
export type ParticleKind = 'spark' | 'smoke' | 'flash' | 'shock' | 'debris';
export interface Particle {
  x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number;
  kind: ParticleKind; drag: number;
}
/** Долгоживущие следы на земле: воронки, обломки техники, следы гусениц */
export interface Decal { x: number; y: number; r: number; life: number; kind: 'scorch' | 'wreck' | 'track'; faction: Faction; angle: number }
export interface Marker { x: number; y: number; life: number; color: string; attack: boolean }
export interface BuildItem { kind: UnitKind; remaining: number; total: number }
export interface CapturePoint extends MapPoint {
  capture: number; owner: Faction | null; contested: boolean; scouted: boolean;
  knownOwner: Faction | null; knownCapture: number; knownContested: boolean;
}
export interface Msg { id: number; text: string; tone: 'info' | 'good' | 'bad' }

export interface VisionCircle { x: number; y: number; r: number }

export interface GameState {
  status: GameStatus; difficulty: Difficulty; mapId: string; map: MapDef; time: number;
  credits: Record<Faction, number>;
  units: Unit[]; projectiles: Projectile[]; particles: Particle[]; markers: Marker[]; decals: Decal[];
  /** тряска камеры (сила), затухает */
  shake: number;
  baseHp: Record<Faction, number>; baseMax: number; baseCooldown: Record<Faction, number>;
  /** угол наведения оборонных орудий базы */
  baseAim: Record<Faction, number>;
  /** цель, которую сейчас обстреливает база (для анимации) */
  baseTarget: Record<Faction, Pt | null>;
  points: CapturePoint[];
  queue: Record<Faction, BuildItem[]>;
  rally: Record<Faction, Pt>;
  selected: Set<number>; selectedBase: Faction | null;
  nextId: number; msgId: number; messages: Msg[];
  botCount: BotCount; bots: BotFaction[]; factions: Faction[];
  botThink: Record<BotFaction, number>; botWaveTimer: Record<BotFaction, number>;
  stats: { kills: number; losses: number; built: number; enemyBuilt: number };
  sounds: SoundEvent[];
  /** Туман войны: 0 — неразведано, 1 — разведано хотя бы раз */
  explored: Uint8Array;
  /** Текущая видимость клеток (0 — в тумане, 1 — видно сейчас) */
  visible: Uint8Array;
  baseScouted: Record<Faction, boolean>;
  knownBaseHp: Record<Faction, number>;
}

/* ------------------------------ утилиты ------------------------------ */

export function dist(ax: number, ay: number, bx: number, by: number) { return Math.hypot(ax - bx, ay - by); }
export function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }
export function angleDiff(a: number, b: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
/** Плавный поворот угла a к b с максимальным шагом */
export function turnTo(a: number, b: number, maxStep: number) {
  const d = angleDiff(a, b);
  return Math.abs(d) <= maxStep ? b : a + Math.sign(d) * maxStep;
}
export function fmtTime(s: number) {
  const m = Math.floor(s / 60); const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, '0')}`;
}
export function formationOffset(i: number, total: number) {
  const cols = Math.ceil(Math.sqrt(total));
  const row = Math.floor(i / cols), col = i % cols;
  return { x: (col - (cols - 1) / 2) * 30, y: (row - (Math.ceil(total / cols) - 1) / 2) * 30 };
}
/** Направление от базы к центру карты — нужно, чтобы армия выходила вперёд на любой карте */
function forward(g: GameState, f: Faction) {
  const b = g.map.bases[f];
  const dx = MAP_W / 2 - b.x, dy = MAP_H / 2 - b.y;
  const l = Math.hypot(dx, dy) || 1;
  return { ux: dx / l, uy: dy / l };
}
export function pushMsg(g: GameState, text: string, tone: Msg['tone']) {
  g.messages = [{ id: g.msgId++, text, tone }, ...g.messages].slice(0, 5);
}
export function incomeOf(g: GameState, f: Faction) {
  const pts = g.points.filter((p) => p.owner === f).length;
  const base = 9 + pts * 4;
  return f !== 'player' ? base * DIFFS[g.difficulty].botIncome : base;
}
function addP(g: GameState, p: Omit<Particle, 'max'>) {
  g.particles.push({ ...p, max: p.life });
}

/** Искры разлёта (базовый эффект) */
export function explode(g: GameState, x: number, y: number, color: string, n = 14, power = 90) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = 25 + Math.random() * power;
    addP(g, { kind: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.35 + Math.random() * 0.45, color, size: 1.5 + Math.random() * 2.5, drag: 0.92 });
  }
}

const obstacleBuckets = new WeakMap<MapDef, Map<string, MapDef['obstacles']>>();
function nearbyObstacles(map: MapDef, x: number, y: number): MapDef['obstacles'] {
  let bins = obstacleBuckets.get(map);
  if (!bins) {
    bins = new Map();
    for (const o of map.obstacles) {
      const key = `${Math.floor(o.x / 256)},${Math.floor(o.y / 256)}`;
      const bin = bins.get(key) ?? [];
      bin.push(o);
      bins.set(key, bin);
    }
    obstacleBuckets.set(map, bins);
  }
  const bx = Math.floor(x / 256), by = Math.floor(y / 256);
  const result: MapDef['obstacles'] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const bin = bins.get(`${bx + dx},${by + dy}`);
    if (bin) result.push(...bin);
  }
  return result;
}

/** Полноценный взрыв: вспышка, ударная волна, искры, дым, обломки, воронка, тряска */
export function bigExplosion(g: GameState, x: number, y: number, size: number, color: string) {
  addP(g, { kind: 'flash', x, y, vx: 0, vy: 0, life: 0.12, color: '#fff7ed', size: size * 1.6, drag: 1 });
  addP(g, { kind: 'shock', x, y, vx: 0, vy: 0, life: 0.35, color: '#fde68a', size: size * 2.6, drag: 1 });
  explode(g, x, y, '#fde68a', Math.round(size * 0.5), size * 4);
  explode(g, x, y, color, Math.round(size * 0.4), size * 3);
  for (let i = 0; i < Math.round(size * 0.35); i++) {
    const a = Math.random() * Math.PI * 2, sp = 10 + Math.random() * size * 1.5;
    addP(g, { kind: 'smoke', x: x + (Math.random() - 0.5) * size * 0.5, y: y + (Math.random() - 0.5) * size * 0.5, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 12, life: 0.9 + Math.random() * 1.1, color: '#525252', size: size * 0.35 + Math.random() * size * 0.3, drag: 0.96 });
  }
  for (let i = 0; i < Math.round(size * 0.25); i++) {
    const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * size * 5;
    addP(g, { kind: 'debris', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.5 + Math.random() * 0.5, color: '#27272a', size: 1.5 + Math.random() * 2.5, drag: 0.9 });
  }
  g.decals.push({ x, y, r: size * 0.9, life: 45, kind: 'scorch', faction: 'player', angle: Math.random() * Math.PI });
  if (g.decals.length > 120) g.decals.shift();
  g.shake = Math.min(14, g.shake + size * 0.18);
}

/** Дульная вспышка и дым от выстрела */
export function muzzle(g: GameState, x: number, y: number, angle: number, power: number) {
  addP(g, { kind: 'flash', x, y, vx: 0, vy: 0, life: 0.07, color: '#fef3c7', size: 4 + power * 2.5, drag: 1 });
  for (let i = 0; i < 2 + power; i++) {
    const a = angle + (Math.random() - 0.5) * 0.6, sp = 40 + Math.random() * 90;
    addP(g, { kind: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.12 + Math.random() * 0.12, color: '#fde68a', size: 1 + Math.random() * 1.5, drag: 0.85 });
  }
  if (power >= 2) {
    addP(g, { kind: 'smoke', x, y, vx: Math.cos(angle) * 30, vy: Math.sin(angle) * 30 - 8, life: 0.6 + power * 0.2, color: '#9ca3af', size: 4 + power * 2, drag: 0.94 });
  }
}

/* ------------------------------ создание и постройка ------------------------------ */

function addUnit(g: GameState, f: Faction, kind: UnitKind, x: number, y: number, angle: number): Unit {
  const d = UNIT_DEFS[kind];
  const u: Unit = {
    id: g.nextId++, faction: f, kind, x, y, hp: d.hp, maxHp: d.hp, angle,
    cooldown: 0, tx: x, ty: y, mode: 'idle', target: null, flash: 0, dead: false,
    odo: 0, recoil: 0, turret: angle,
    path: [], pathI: 0, pathGoal: null, pathAt: 0, stuck: 0,
  };
  g.units.push(u);
  return u;
}

/** Все источники обзора игрока: база, живые юниты и захваченные точки */
export function getPlayerVisionCircles(g: GameState): VisionCircle[] {
  const circles: VisionCircle[] = [];
  if (g.baseHp.player > 0) {
    const b = g.map.bases.player;
    circles.push({ x: b.x, y: b.y, r: BASE_SIGHT });
  }
  for (const u of g.units) {
    if (!u.dead && u.faction === 'player') {
      const heightBonus = 1 + terrainHeightAt(g.map, u.x, u.y) * 0.1;
      circles.push({ x: u.x, y: u.y, r: UNIT_DEFS[u.kind].sight * 1.18 * heightBonus });
    }
  }
  for (const p of g.points) {
    if (p.owner === 'player') {
      circles.push({ x: p.x, y: p.y, r: POINT_SIGHT });
    }
  }
  return circles;
}

/** Обновляет сетку разведки и видимости игрока */
export function updateFog(g: GameState) {
  g.visible.fill(0);
  const circles = getPlayerVisionCircles(g);
  for (const c of circles) {
    const x0 = Math.max(0, Math.floor((c.x - c.r) / FOG_CELL));
    const x1 = Math.min(FOG_COLS - 1, Math.floor((c.x + c.r) / FOG_CELL));
    const y0 = Math.max(0, Math.floor((c.y - c.r) / FOG_CELL));
    const y1 = Math.min(FOG_ROWS - 1, Math.floor((c.y + c.r) / FOG_CELL));
    const r2 = c.r * c.r;
    for (let cy = y0; cy <= y1; cy++) {
      const py = (cy + 0.5) * FOG_CELL;
      const dy2 = (py - c.y) * (py - c.y);
      const row = cy * FOG_COLS;
      for (let cx = x0; cx <= x1; cx++) {
        const px = (cx + 0.5) * FOG_CELL;
        if ((px - c.x) * (px - c.x) + dy2 <= r2) {
          g.visible[row + cx] = 1;
          g.explored[row + cx] = 1;
        }
      }
    }
  }
  // Store last observed ownership rather than leaking changes through the fog.
  for (const p of g.points) {
    if (!p.scouted && isPointExplored(g, p.x, p.y)) {
      p.scouted = true;
      if (g.time > 0.5) pushMsg(g, `Разведка обнаружила объект: ${p.label} (${p.id})`, 'info');
    }
    if (isPointVisible(g, p.x, p.y)) {
      p.knownOwner = p.owner;
      p.knownCapture = p.capture;
      p.knownContested = p.contested;
    }
  }
  for (const f of g.bots) {
    const b = g.map.bases[f];
    if (isPointVisible(g, b.x, b.y)) {
      if (!g.baseScouted[f] && g.time > 0.5) pushMsg(g, `Разведка обнаружила базу: ${FACTION_NAMES[f]}.`, 'good');
      g.baseScouted[f] = true;
      g.knownBaseHp[f] = g.baseHp[f];
    }
  }
}

export function isPointVisible(g: GameState, x: number, y: number): boolean {
  const cx = clamp(Math.floor(x / FOG_CELL), 0, FOG_COLS - 1);
  const cy = clamp(Math.floor(y / FOG_CELL), 0, FOG_ROWS - 1);
  return g.visible[cy * FOG_COLS + cx] === 1;
}

export function isPointExplored(g: GameState, x: number, y: number): boolean {
  const cx = clamp(Math.floor(x / FOG_CELL), 0, FOG_COLS - 1);
  const cy = clamp(Math.floor(y / FOG_CELL), 0, FOG_ROWS - 1);
  return g.explored[cy * FOG_COLS + cx] === 1;
}

export function exploredPercent(g: GameState): number {
  let n = 0;
  for (let i = 0; i < g.explored.length; i++) n += g.explored[i];
  return Math.round((n / g.explored.length) * 100);
}

export function createGame(difficulty: Difficulty, mapId: string, botCount: BotCount = 1): GameState {
  const map = getMap(mapId);
  const bots = BOT_FACTIONS.slice(0, botCount);
  const factions: Faction[] = ['player', ...bots];
  const g: GameState = {
    status: 'menu', difficulty, mapId: map.id, map, time: 0,
    credits: { player: 190, enemy: 190, enemy2: 190, enemy3: 190 },
    units: [], projectiles: [], particles: [], markers: [], decals: [], shake: 0,
    baseHp: { player: 1500, enemy: 1500, enemy2: botCount >= 2 ? 1500 : 0, enemy3: botCount >= 3 ? 1500 : 0 },
    baseMax: 1500, baseCooldown: { player: 0, enemy: 0, enemy2: 0, enemy3: 0 },
    baseAim: { player: 0, enemy: Math.PI, enemy2: Math.PI, enemy3: Math.PI },
    baseTarget: { player: null, enemy: null, enemy2: null, enemy3: null },
    points: map.points.map((p) => ({ ...p, capture: 0, owner: null, contested: false, scouted: false, knownOwner: null, knownCapture: 0, knownContested: false })),
    queue: { player: [], enemy: [], enemy2: [], enemy3: [] },
    rally: { player: { ...map.rally.player }, enemy: { ...map.rally.enemy }, enemy2: { ...map.rally.enemy2 }, enemy3: { ...map.rally.enemy3 } },
    selected: new Set(), selectedBase: null, nextId: 1, msgId: 1, messages: [],
    botCount, bots, factions,
    botThink: { enemy: 1, enemy2: 1.5, enemy3: 2 },
    botWaveTimer: { enemy: 35, enemy2: 42, enemy3: 49 },
    stats: { kills: 0, losses: 0, built: 0, enemyBuilt: 0 },
    sounds: [],
    explored: new Uint8Array(FOG_COLS * FOG_ROWS),
    visible: new Uint8Array(FOG_COLS * FOG_ROWS),
    baseScouted: { player: true, enemy: false, enemy2: false, enemy3: false },
    knownBaseHp: { player: 1500, enemy: 1500, enemy2: 1500, enemy3: 1500 },
  };
  for (const f of factions) {
    const fw = forward(g, f);
    const px = -fw.uy, py = fw.ux;
    const cx = map.bases[f].x + fw.ux * 115, cy = map.bases[f].y + fw.uy * 115;
    const ang = Math.atan2(fw.uy, fw.ux);
    const spots: [UnitKind, number, number][] = [['rifle', -62, 0], ['rifle', 0, 0], ['rifle', 62, 0], ['tank', 0, 40]];
    for (const [k, side, fwd] of spots) {
      addUnit(g, f, k, cx + px * side + fw.ux * fwd, cy + py * side + fw.uy * fwd, ang);
    }
  }
  updateFog(g);
  pushMsg(g, `Карта «${map.name}». Отправляйте отряды в разведку — скрытая территория в тумане войны.`, 'info');
  return g;
}

function spawnFromQueue(g: GameState, f: Faction, kind: UnitKind) {
  const b = g.map.bases[f];
  const fw = forward(g, f);
  const j = Math.random() * 70 - 35;
  const u = addUnit(g, f, kind, b.x + fw.ux * 70 - fw.uy * j, b.y + fw.uy * 70 + fw.ux * j, Math.atan2(fw.uy, fw.ux));
  u.mode = 'attackmove'; u.tx = g.rally[f].x; u.ty = g.rally[f].y; u.cooldown = 0.3;
  if (f === 'player') { g.stats.built++; g.sounds.push({ type: 'built' }); } else g.stats.enemyBuilt++;
}

export function tryBuild(g: GameState, f: Faction, kind: UnitKind): boolean {
  const d = UNIT_DEFS[kind];
  if (g.status !== 'playing' || !g.factions.includes(f) || g.baseHp[f] <= 0 || g.queue[f].length >= 5 || g.credits[f] < d.cost) return false;
  g.credits[f] -= d.cost;
  g.queue[f].push({ kind, remaining: d.build, total: d.build });
  return true;
}

function damageUnit(g: GameState, u: Unit, dmg: number, attacker: Faction) {
  if (u.dead) return;
  u.hp -= dmg; u.flash = 0.09;
  if (u.hp <= 0) {
    u.dead = true;
    const col = u.faction === 'player' ? '#38bdf8' : '#f87171';
    bigExplosion(g, u.x, u.y, u.kind === 'tank' ? 34 : u.kind === 'arty' ? 26 : 16, col);
    if (u.kind !== 'rifle') {
      g.decals.push({ x: u.x, y: u.y, r: UNIT_DEFS[u.kind].radius, life: 40, kind: 'wreck', faction: u.faction, angle: u.angle });
    }
    g.sounds.push({ type: 'explosion', size: u.kind === 'tank' ? 'big' : 'small', x: u.x });
    g.selected.delete(u.id);
    if (u.faction !== 'player' && attacker === 'player') { g.stats.kills++; g.credits.player += 9; }
    if (u.faction === 'player' && attacker !== 'player') g.stats.losses++;
  }
}

function damageBase(g: GameState, f: Faction, dmg: number) {
  if (g.baseHp[f] <= 0) return;
  g.baseHp[f] -= dmg;
  const b = g.map.bases[f];
  if (f === 'player') g.sounds.push({ type: 'basehit' });
  if (g.baseHp[f] <= 0) {
    g.baseHp[f] = 0;
    const col = f === 'player' ? '#38bdf8' : '#f87171';
    bigExplosion(g, b.x, b.y, 90, col);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      bigExplosion(g, b.x + Math.cos(a) * 40, b.y + Math.sin(a) * 40, 30, '#fbbf24');
    }
    g.shake = 28;
    g.sounds.push({ type: 'explosion', size: 'huge', x: b.x });
    if (f === 'player') g.status = 'defeat';
    else {
      g.queue[f] = [];
      if (g.baseScouted[f] || isPointVisible(g, b.x, b.y)) pushMsg(g, `База ${FACTION_NAMES[f]} уничтожена.`, 'good');
      if (g.bots.every((bot) => g.baseHp[bot] <= 0)) g.status = 'victory';
    }
  }
}

export function targetPos(g: GameState, t: TargetRef): Pt | null {
  if (!t) return null;
  if (t.type === 'base') return g.baseHp[t.faction] > 0 ? g.map.bases[t.faction] : null;
  const id = t.id;
  const u = g.units.find((x) => x.id === id && !x.dead);
  return u ? { x: u.x, y: u.y } : null;
}
function targetValid(g: GameState, t: TargetRef) { return !!targetPos(g, t); }

/** Один шаг в заданном направлении с плавным разворотом корпуса */
function straightStep(u: Unit, angle: number, speed: number, dt: number) {
  u.angle = turnTo(u.angle, angle, dt * (u.kind === 'rifle' ? 14 : 5));
  const align = Math.cos(angleDiff(angle, u.angle));
  const step = speed * dt * Math.max(0.3, align);
  u.x += Math.cos(u.angle) * step;
  u.y += Math.sin(u.angle) * step;
  u.odo += step;
}

/**
 * Движение к цели: если прямая свободна — идём напрямую, иначе ведём юнита
 * по маршруту A* в обход препятствий. Пересчёт маршрута имеет бюджет на кадр.
 */
function navigate(
  g: GameState, nav: NavGrid, u: Unit, budget: { left: number }, goal: Pt, stopAt: number, dt: number,
) {
  const d = UNIT_DEFS[u.kind];
  const speed = d.speed * (1 - terrainHeightAt(g.map, u.x, u.y) * 0.08);
  if (dist(u.x, u.y, goal.x, goal.y) <= stopAt + 4) {
    u.path = []; u.pathGoal = null;
    return;
  }
  // прямой путь свободен — никакой A* не нужен
  if (lineClear(nav, u.x, u.y, goal.x, goal.y)) {
    u.path = []; u.pathGoal = null;
    straightStep(u, Math.atan2(goal.y - u.y, goal.x - u.x), speed, dt);
    return;
  }
  const goalMoved = !u.pathGoal || dist(u.pathGoal.x, u.pathGoal.y, goal.x, goal.y) > 72;
  const needPath = goalMoved || u.pathI >= u.path.length;
  if (needPath && budget.left > 0 && g.time - u.pathAt > 0.4) {
    budget.left--;
    u.pathAt = g.time;
    u.pathGoal = { x: goal.x, y: goal.y };
    u.path = findPath(nav, u.x, u.y, goal.x, goal.y) ?? [];
    u.pathI = 0;
  }
  while (u.pathI < u.path.length && dist(u.x, u.y, u.path[u.pathI].x, u.path[u.pathI].y) < 16) u.pathI++;
  const wp = u.pathI < u.path.length ? u.path[u.pathI] : goal;
  straightStep(u, Math.atan2(wp.y - u.y, wp.x - u.x), speed, dt);
}

function shoot(g: GameState, u: Unit) {
  const d = UNIT_DEFS[u.kind];
  const tp = targetPos(g, u.target);
  if (!tp) return;
  const sx = u.x + Math.cos(u.turret) * (d.radius + 6);
  const sy = u.y + Math.sin(u.turret) * (d.radius + 6);
  g.projectiles.push({
    sx, sy, x: sx, y: sy,
    tx: tp.x, ty: tp.y, faction: u.faction, target: u.target ? { ...u.target } : null,
    damage: d.damage, splash: d.splash, speed: d.projSpeed, kind: u.kind, dead: false,
  });
  u.cooldown = d.cooldown;
  u.recoil = 1;
  const power = u.kind === 'rifle' ? 0 : u.kind === 'tank' ? 2 : 3;
  muzzle(g, u.x + Math.cos(u.turret) * (d.radius + 12), u.y + Math.sin(u.turret) * (d.radius + 12), u.turret, power);
  if (u.kind === 'arty') g.shake = Math.min(14, g.shake + 1.5);
  g.sounds.push({ type: 'shot', kind: u.kind, x: u.x });
}

/* ------------------------------ бот ------------------------------ */

function botThink(g: GameState, f: BotFaction) {
  const cfg = DIFFS[g.difficulty];
  if (g.baseHp[f] <= 0) return;
  const army = g.units.filter((u) => u.faction === f && !u.dead);
  if (army.length < 24 && g.queue[f].length < (g.difficulty === 'hard' ? 3 : 2)) {
    const kinds: UnitKind[] = ['rifle', 'rifle', 'tank', 'rifle', 'arty', 'tank'];
    const pick = kinds[Math.floor(Math.random() * kinds.length)];
    if (!tryBuild(g, f, pick)) tryBuild(g, f, 'rifle');
  }
  if (!army.length) return;
  const eb = g.map.bases[f], pb = g.map.bases.player;

  // оборона базы
  const threat = g.units.filter((u) => u.faction === 'player' && !u.dead && dist(u.x, u.y, eb.x, eb.y) < 330);
  if (threat.length >= 2) {
    const cx = threat.reduce((s, u) => s + u.x, 0) / threat.length;
    const cy = threat.reduce((s, u) => s + u.y, 0) / threat.length;
    army.forEach((u) => { if (u.mode === 'idle') { u.mode = 'attackmove'; u.tx = cx; u.ty = cy; u.target = null; } });
    return;
  }

  // Each commander sends its own army; other bots remain allied.
  if (army.length >= cfg.attackSize && g.botWaveTimer[f] <= 0) {
    const ang = Math.atan2(eb.y - pb.y, eb.x - pb.x);
    const attackers = army.slice(0, Math.max(4, Math.floor(army.length * 0.78)));
    attackers.forEach((u, i) => {
      const off = formationOffset(i, attackers.length);
      u.mode = 'attackmove';
      u.tx = pb.x + Math.cos(ang) * 120 + off.x * 0.5;
      u.ty = pb.y + Math.sin(ang) * 120 + off.y;
      u.target = null;
      u.pathGoal = null;
    });
    g.botWaveTimer[f] = g.difficulty === 'hard' ? 38 : 48;
    if (attackers.some((u) => isPointVisible(g, u.x, u.y))) {
      pushMsg(g, `${FACTION_NAMES[f]} начинает наступление!`, 'bad');
      g.sounds.push({ type: 'alert' });
    }
    return;
  }

  const points = [...g.points].sort((a, b) => dist(a.x, a.y, eb.x, eb.y) - dist(b.x, b.y, eb.x, eb.y));
  let assigned = 0;
  for (const p of points) {
    if (p.owner && p.owner !== 'player') continue;
    const already = g.units.filter((u) => u.faction !== 'player' && !u.dead && (
      dist(u.x, u.y, p.x, p.y) < p.r + 40 || (u.mode === 'attackmove' && dist(u.tx, u.ty, p.x, p.y) < p.r + 50)
    )).length;
    if (already >= 3) continue;
    const idle = army.filter((u) => u.mode === 'idle' && !u.target).sort((a, b) => dist(a.x, a.y, p.x, p.y) - dist(b.x, b.y, p.x, p.y));
    const squad = idle.slice(0, Math.min(3 - already, 3));
    squad.forEach((u) => {
      u.mode = 'attackmove';
      u.tx = p.x + (Math.random() * 36 - 18);
      u.ty = p.y + (Math.random() * 36 - 18);
      u.pathGoal = null;
    });
    assigned += squad.length;
    if (assigned >= 3) break;
  }
}

/* ------------------------------ шаг симуляции ------------------------------ */

export function updateGame(g: GameState, dt: number) {
  if (g.status !== 'playing') return;
  g.time += dt;
  for (const f of g.factions) {
    if (g.baseHp[f] > 0) g.credits[f] += incomeOf(g, f) * dt;
  }
  for (const bot of g.bots) g.botWaveTimer[bot] -= dt;

  // производство и турели баз
  for (const f of g.factions) {
    const q = g.queue[f];
    if (q.length) {
      q[0].remaining -= dt;
      if (q[0].remaining <= 0) { const it = q.shift()!; spawnFromQueue(g, f, it.kind); }
    }
    g.baseCooldown[f] -= dt;
    const b = g.map.bases[f];
    // ближайший враг в радиусе обороны
    let foe: Unit | undefined;
    let fd = BASE_RANGE;
    if (g.baseHp[f] > 0) {
      for (const u of g.units) {
        if (allied(u.faction, f) || u.dead) continue;
        const d = dist(u.x, u.y, b.x, b.y);
        if (d < fd) { fd = d; foe = u; }
      }
    }
    if (foe) {
      const ba = Math.atan2(foe.y - b.y, foe.x - b.x);
      g.baseAim[f] = turnTo(g.baseAim[f], ba, dt * 4);
      g.baseTarget[f] = { x: foe.x, y: foe.y };
      const aligned = Math.abs(angleDiff(g.baseAim[f], ba)) < 0.3;
      if (g.baseCooldown[f] <= 0 && aligned) {
        // два ствола: залп по цели со снарядом малого радиуса
        for (const side of [-1, 1]) {
          const perp = ba + Math.PI / 2;
          const sx = b.x + Math.cos(g.baseAim[f]) * 40 + Math.cos(perp) * 16 * side;
          const sy = b.y + Math.sin(g.baseAim[f]) * 40 + Math.sin(perp) * 16 * side;
          g.projectiles.push({
            sx, sy, x: sx, y: sy, tx: foe.x + (Math.random() - 0.5) * 20, ty: foe.y + (Math.random() - 0.5) * 20,
            faction: f, target: { type: 'unit', id: foe.id }, damage: 9, splash: 10, speed: 560, kind: 'base', dead: false,
          });
          muzzle(g, sx, sy, g.baseAim[f], 1);
        }
        g.baseCooldown[f] = 0.8;
        g.sounds.push({ type: 'shot', kind: 'base', x: b.x });
      }
    } else {
      g.baseTarget[f] = null;
    }
  }

  // точки захвата
  for (const p of g.points) {
    let inP = 0, inE = 0;
    let capturingBot: BotFaction | null = null;
    for (const u of g.units) {
      if (u.dead || dist(u.x, u.y, p.x, p.y) >= p.r) continue;
      if (u.faction === 'player') inP++;
      else { inE++; if (!capturingBot) capturingBot = u.faction; }
    }
    p.contested = inP > 0 && inE > 0;
    const prev = p.owner;
    if (inP > 0 && inE === 0) p.capture = clamp(p.capture + dt / 4.5, -1, 1);
    else if (inE > 0 && inP === 0) p.capture = clamp(p.capture - dt / 4.5, -1, 1);
    if (p.capture >= 1) p.owner = 'player';
    if (p.capture <= -1 && capturingBot && (!p.owner || p.owner === 'player')) p.owner = capturingBot;
    if (p.owner !== prev && p.owner) {
      if (p.owner === 'player' || isPointVisible(g, p.x, p.y)) {
        p.scouted = true;
        p.knownOwner = p.owner;
        p.knownCapture = p.capture;
        p.knownContested = p.contested;
        pushMsg(g, p.owner === 'player' ? `Точка ${p.id} захвачена! +4 кр/сек` : `${FACTION_NAMES[p.owner]} захватил точку ${p.id}!`, p.owner === 'player' ? 'good' : 'bad');
        g.sounds.push({ type: 'capture', good: p.owner === 'player' });
      }
    }
  }

  for (const bot of g.bots) {
    g.botThink[bot] -= dt;
    if (g.botThink[bot] <= 0) { botThink(g, bot); g.botThink[bot] = 1.5; }
  }

  // юниты: поиск целей, движение по маршруту в обход препятствий, стрельба
  const nav = getNav(g.map, g.factions);
  const budget = { left: 3 };
  for (const u of g.units) {
    if (u.dead) continue;
    const d = UNIT_DEFS[u.kind];
    const px = u.x, py = u.y;
    u.cooldown -= dt;
    u.flash = Math.max(0, u.flash - dt);
    u.recoil = Math.max(0, u.recoil - dt * 4);
    if (u.target && !targetValid(g, u.target)) { u.target = null; if (u.mode === 'attack') u.mode = 'idle'; }

    if (!u.target && u.mode !== 'move') {
      let best: Unit | null = null;
      let bd = Infinity;
      for (const e of g.units) {
        if (allied(e.faction, u.faction) || e.dead) continue;
        const dd = dist(u.x, u.y, e.x, e.y);
        if (dd < bd) { bd = dd; best = e; }
      }
      const enemyBases = g.factions.filter((f) => !allied(f, u.faction) && g.baseHp[f] > 0);
      const foeBase = enemyBases.sort((a, b) => dist(u.x, u.y, g.map.bases[a].x, g.map.bases[a].y) - dist(u.x, u.y, g.map.bases[b].x, g.map.bases[b].y))[0];
      const fb = foeBase ? g.map.bases[foeBase] : null;
      const db = fb ? dist(u.x, u.y, fb.x, fb.y) - 46 : Infinity;
      if (best && bd <= d.sight) u.target = { type: 'unit', id: best.id };
      else if (foeBase && db <= d.sight) u.target = { type: 'base', faction: foeBase };
      if (u.target && u.mode === 'idle') u.mode = 'attack';
    }

    let traveling = false;
    if (u.target) {
      const tp = targetPos(g, u.target);
      if (tp) {
        const t = u.target;
        let tr = 48;
        if (t.type === 'unit') {
          const tid = t.id;
          const tu = g.units.find((x) => x.id === tid);
          tr = tu ? UNIT_DEFS[tu.kind].radius : 0;
        }
        const dd = dist(u.x, u.y, tp.x, tp.y) - tr;
        const aim = Math.atan2(tp.y - u.y, tp.x - u.x);
        u.turret = turnTo(u.turret, aim, dt * 7);
        const aligned = Math.abs(angleDiff(u.turret, aim)) < 0.25;
        if (dd <= d.range && dd >= d.minRange) {
          if (u.cooldown <= 0 && aligned) shoot(g, u);
          if (u.kind === 'rifle') u.angle = turnTo(u.angle, aim, dt * 8);
          u.path = []; u.pathGoal = null;
        } else if (dd < d.minRange) {
          // артиллерии слишком близко — отходим назад и перерасчитываем маршрут позже
          straightStep(u, aim + Math.PI, d.speed * (1 - terrainHeightAt(g.map, u.x, u.y) * 0.08), dt);
          u.path = []; u.pathGoal = null; u.pathAt = 0;
          traveling = true;
        } else {
          // обходим скалы, деревья, руины и базы по найденному маршруту
          navigate(g, nav, u, budget, tp, Math.max(18, d.range - tr - 8), dt);
          traveling = true;
        }
      }
    } else if (u.mode === 'move' || u.mode === 'attackmove') {
      if (dist(u.x, u.y, u.tx, u.ty) > 10) {
        navigate(g, nav, u, budget, { x: u.tx, y: u.ty }, 8, dt);
        traveling = true;
      } else { u.mode = 'idle'; u.path = []; u.pathGoal = null; }
    } else {
      u.path = []; u.pathGoal = null;
    }

    // следы гусениц от тяжёлой техники
    const moved = Math.hypot(u.x - px, u.y - py);
    if (u.kind !== 'rifle' && moved > 0.4 && Math.floor(u.odo / 14) !== Math.floor((u.odo - moved) / 14)) {
      g.decals.push({ x: u.x, y: u.y, r: u.kind === 'tank' ? 12 : 10, life: 14, kind: 'track', faction: u.faction, angle: u.angle });
      if (g.decals.length > 180) g.decals.shift();
    }

    // детектор застревания: срабатывает только если юнит должен был двигаться
    if (traveling && moved < 0.6) {
      u.stuck += dt;
      if (u.stuck > 0.9) {
        u.stuck = 0; u.pathAt = 0; u.pathGoal = null; u.path = [];
        straightStep(u, u.angle + (Math.random() - 0.5) * 1.6, d.speed * 0.6, dt);
      }
    } else {
      u.stuck = Math.max(0, u.stuck - dt * 2);
    }
    // башня без цели медленно возвращается по ходу
    if (!u.target) u.turret = turnTo(u.turret, u.angle, dt * 3);
  }
  g.shake = Math.max(0, g.shake - dt * 22);

  // разделение юнитов, препятствия, базы, границы карты
  for (let i = 0; i < g.units.length; i++) {
    const a = g.units[i];
    if (a.dead) continue;
    for (let j = i + 1; j < g.units.length; j++) {
      const b = g.units[j];
      if (b.dead) continue;
      const dd = dist(a.x, a.y, b.x, b.y);
      const min = UNIT_DEFS[a.kind].radius + UNIT_DEFS[b.kind].radius + 2;
      if (dd > 0.01 && dd < min) {
        const push = (min - dd) / 2, ang = Math.atan2(b.y - a.y, b.x - a.x);
        a.x -= Math.cos(ang) * push; a.y -= Math.sin(ang) * push;
        b.x += Math.cos(ang) * push; b.y += Math.sin(ang) * push;
      }
    }
    const r = UNIT_DEFS[a.kind].radius;
    for (const o of nearbyObstacles(g.map, a.x, a.y)) {
      const dd = dist(a.x, a.y, o.x, o.y);
      if (dd < o.r + r && dd > 0.01) {
        const ang = Math.atan2(a.y - o.y, a.x - o.x);
        a.x = o.x + Math.cos(ang) * (o.r + r); a.y = o.y + Math.sin(ang) * (o.r + r);
      }
    }
    for (const f of g.factions) {
      const b = g.map.bases[f];
      const dd = dist(a.x, a.y, b.x, b.y);
      if (dd < 52 + r && dd > 0.01) {
        const ang = Math.atan2(a.y - b.y, a.x - b.x);
        a.x = b.x + Math.cos(ang) * (52 + r); a.y = b.y + Math.sin(ang) * (52 + r);
      }
    }
    a.x = clamp(a.x, r + 6, MAP_W - r - 6);
    a.y = clamp(a.y, r + 6, MAP_H - r - 6);
  }

  // снаряды
  for (const pr of g.projectiles) {
    const tp = targetPos(g, pr.target);
    if (tp) { pr.tx = tp.x; pr.ty = tp.y; }
    const dd = dist(pr.x, pr.y, pr.tx, pr.ty);
    const step = pr.speed * dt;
    if (dd <= step + 4) {
      pr.dead = true;
      if (pr.splash > 0) {
        bigExplosion(g, pr.tx, pr.ty, pr.kind === 'arty' ? 30 : 14, '#fb923c');
        g.sounds.push({ type: 'explosion', size: 'medium', x: pr.tx });
        for (const u of g.units) {
          if (!u.dead && !allied(u.faction, pr.faction) && dist(u.x, u.y, pr.tx, pr.ty) <= pr.splash + UNIT_DEFS[u.kind].radius) {
            damageUnit(g, u, pr.damage, pr.faction);
          }
        }
        for (const foeBase of g.factions) {
          if (allied(foeBase, pr.faction) || g.baseHp[foeBase] <= 0) continue;
          const fb = g.map.bases[foeBase];
          if (dist(pr.tx, pr.ty, fb.x, fb.y) < pr.splash + 50) damageBase(g, foeBase, pr.damage * 0.7);
        }
      } else if (pr.target && pr.target.type === 'unit') {
        const tid = pr.target.id;
        const u = g.units.find((x) => x.id === tid && !x.dead);
        if (u) {
          damageUnit(g, u, pr.damage, pr.faction);
          explode(g, u.x, u.y, '#fde68a', 4, 60);
          addP(g, { kind: 'flash', x: u.x, y: u.y, vx: 0, vy: 0, life: 0.06, color: '#fff7ed', size: 7, drag: 1 });
          g.sounds.push({ type: 'hit', x: u.x });
        }
      } else if (pr.target && pr.target.type === 'base') {
        damageBase(g, pr.target.faction, pr.damage);
        explode(g, pr.tx, pr.ty, '#fbbf24', 6, 70);
        addP(g, { kind: 'flash', x: pr.tx, y: pr.ty, vx: 0, vy: 0, life: 0.08, color: '#fff7ed', size: 10, drag: 1 });
        addP(g, { kind: 'smoke', x: pr.tx, y: pr.ty, vx: 0, vy: -15, life: 0.8, color: '#6b7280', size: 7, drag: 0.95 });
        g.sounds.push({ type: 'hit', x: pr.tx });
      }
    } else {
      pr.x += ((pr.tx - pr.x) / dd) * step;
      pr.y += ((pr.ty - pr.y) / dd) * step;
      if (pr.kind === 'arty') {
        addP(g, { kind: 'smoke', x: pr.x, y: pr.y, vx: (Math.random() - 0.5) * 10, vy: -6, life: 0.5, color: '#d6d3d1', size: 3.5, drag: 0.97 });
      } else if (pr.kind === 'tank') {
        addP(g, { kind: 'spark', x: pr.x, y: pr.y, vx: 0, vy: 0, life: 0.1, color: '#fdba74', size: 1.8, drag: 1 });
      }
    }
  }
  g.projectiles = g.projectiles.filter((p) => !p.dead);
  g.units = g.units.filter((u) => !u.dead);

  for (const p of g.particles) {
    p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt;
    const k = Math.pow(p.drag, dt * 60);
    p.vx *= k; p.vy *= k;
    if (p.kind === 'smoke') p.size += dt * 9;
  }
  g.particles = g.particles.filter((p) => p.life > 0);
  if (g.particles.length > 900) g.particles.splice(0, g.particles.length - 900);
  for (const m of g.markers) m.life -= dt;
  g.markers = g.markers.filter((m) => m.life > 0);
  for (const d of g.decals) d.life -= dt;
  g.decals = g.decals.filter((d) => d.life > 0);
  updateFog(g);
}
