export const MAP_W = 10240;
export const MAP_H = 5760;

export type Faction = 'player' | 'enemy' | 'enemy2' | 'enemy3';
export type BotFaction = Exclude<Faction, 'player'>;
export type BotCount = 1 | 2 | 3;
export const BOT_FACTIONS: BotFaction[] = ['enemy', 'enemy2', 'enemy3'];
export const FACTIONS: Faction[] = ['player', ...BOT_FACTIONS];
export const FACTION_NAMES: Record<Faction, string> = {
  player: 'Альянс', enemy: 'Легион I', enemy2: 'Легион II', enemy3: 'Легион III',
};
export function allied(a: Faction, b: Faction): boolean {
  return (a === 'player') === (b === 'player');
}

export type Pt = { x: number; y: number };
export type Circ = Pt & { r: number };
export type Theme = 'ash' | 'frost' | 'desert' | 'forest';
export type ObstacleKind = 'rock' | 'tree' | 'ruin' | 'ice' | 'mesa';
export type PropKind = 'crater' | 'ash' | 'wreck' | 'snow' | 'crystal' | 'lake' | 'dune' | 'bush' | 'pebble';
export interface Obstacle extends Circ { kind: ObstacleKind }
export interface Prop extends Circ { kind: PropKind }
export interface MapPoint extends Circ { id: string; label: string }
export interface Elevation extends Pt { rx: number; ry: number; level: number }
export interface MapDef {
  id: string;
  name: string;
  subtitle: string;
  desc: string;
  theme: Theme;
  ground: string;
  ground2: string;
  bases: Record<Faction, Pt>;
  rally: Record<Faction, Pt>;
  points: MapPoint[];
  obstacles: Obstacle[];
  props: Prop[];
  elevations: Elevation[];
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ThemeSpec {
  id: Theme; name: string; subtitle: string; desc: string; ground: string; ground2: string;
  seed: number; labels: string[];
  obstacles: [ObstacleKind, number, number, number][];
  props: [PropKind, number, number, number][];
}

const BASES: Record<Faction, Pt> = {
  player: { x: 1250, y: 2880 },
  enemy: { x: 8990, y: 2880 },
  enemy2: { x: 6240, y: 1030 },
  enemy3: { x: 6240, y: 4730 },
};

const POINT_POSITIONS: Pt[] = [
  { x: 2100, y: 2880 }, { x: 3300, y: 1770 }, { x: 3300, y: 3990 },
  { x: 4200, y: 2880 }, { x: 5120, y: 1280 }, { x: 5120, y: 2880 },
  { x: 5120, y: 4480 }, { x: 7200, y: 1700 }, { x: 7200, y: 4060 },
  { x: 7920, y: 2880 }, { x: 3850, y: 720 }, { x: 3850, y: 5040 },
];

/* Spatial buckets keep placement fast even with thousands of rocks. */
function makeMap(spec: ThemeSpec): MapDef {
  const random = rng(spec.seed);
  const angle = { ash: 0, frost: -0.4, desert: 0.34, forest: 0.17 }[spec.id];
  const transform = (p: Pt): Pt => {
    const x = p.x / MAP_W - 0.5, y = p.y / MAP_H - 0.5;
    return {
      x: Math.max(450, Math.min(MAP_W - 450, (0.5 + x * Math.cos(angle) - y * Math.sin(angle)) * MAP_W)),
      y: Math.max(360, Math.min(MAP_H - 360, (0.5 + x * Math.sin(angle) + y * Math.cos(angle)) * MAP_H)),
    };
  };
  const bases = Object.fromEntries(FACTIONS.map((f) => [f, transform(BASES[f])])) as Record<Faction, Pt>;
  const rally = {} as Record<Faction, Pt>;
  for (const f of FACTIONS) {
    const b = bases[f];
    const dx = MAP_W / 2 - b.x, dy = MAP_H / 2 - b.y;
    const len = Math.hypot(dx, dy) || 1;
    rally[f] = { x: b.x + dx / len * 250, y: b.y + dy / len * 250 };
  }
  const points = POINT_POSITIONS.map((p, i) => ({
    ...transform(p), id: String.fromCharCode(65 + i), label: spec.labels[i % spec.labels.length], r: i === 5 ? 82 : 72,
  }));
  const safe = [
    ...FACTIONS.map((f) => ({ ...bases[f], r: 300 })),
    ...points.map((p) => ({ ...p, r: p.r + 95 })),
  ];
  const bins = new Map<string, Circ[]>();
  const binSize = 220;
  const insert = (c: Circ) => {
    const key = `${Math.floor(c.x / binSize)},${Math.floor(c.y / binSize)}`;
    const bin = bins.get(key) ?? [];
    bin.push(c);
    bins.set(key, bin);
  };
  const clear = (c: Circ) => {
    if (safe.some((b) => Math.hypot(c.x - b.x, c.y - b.y) < c.r + b.r)) return false;
    const bx = Math.floor(c.x / binSize), by = Math.floor(c.y / binSize);
    for (let y = by - 1; y <= by + 1; y++) {
      for (let x = bx - 1; x <= bx + 1; x++) {
        for (const b of bins.get(`${x},${y}`) ?? []) {
          if (Math.hypot(c.x - b.x, c.y - b.y) < c.r + b.r + 12) return false;
        }
      }
    }
    return true;
  };
  const obstacles: Obstacle[] = [];
  for (const [kind, count, lo, hi] of spec.obstacles) {
    let placed = 0;
    for (let tries = 0; placed < count && tries < count * 18; tries++) {
      const c = { x: 100 + random() * (MAP_W - 200), y: 100 + random() * (MAP_H - 200), r: lo + random() * (hi - lo) };
      if (!clear(c)) continue;
      obstacles.push({ ...c, kind });
      insert(c);
      placed++;
    }
  }
  const props: Prop[] = [];
  for (const [kind, count, lo, hi] of spec.props) {
    for (let i = 0; i < count; i++) {
      props.push({ x: 50 + random() * (MAP_W - 100), y: 50 + random() * (MAP_H - 100), r: lo + random() * (hi - lo), kind });
    }
  }
  const elevations: Elevation[] = [
    { x: bases.player.x + 620, y: Math.max(300, bases.player.y - 500), rx: 410, ry: 245, level: 2 },
    { x: bases.player.x + 700, y: Math.min(MAP_H - 300, bases.player.y + 510), rx: 480, ry: 260, level: 3 },
  ];
  for (let i = 0; i < 45; i++) {
    const x = 400 + random() * (MAP_W - 800), y = 350 + random() * (MAP_H - 700);
    if (safe.some((p) => Math.hypot(x - p.x, y - p.y) < p.r + 150)) continue;
    elevations.push({ x, y, rx: 210 + random() * 300, ry: 160 + random() * 250, level: random() > 0.45 ? 3 : 2 });
  }
  return { ...spec, theme: spec.id, bases, rally, points, obstacles, props, elevations };
}

/** Returns traversable height tiers; higher ground slows movement and extends vision. */
export function terrainHeightAt(map: MapDef, x: number, y: number): number {
  let height = 0;
  for (const h of map.elevations) {
    const dx = (x - h.x) / h.rx, dy = (y - h.y) / h.ry;
    const d = Math.hypot(dx, dy);
    if (d < 1) height = Math.max(height, Math.min(h.level, Math.ceil((1 - d) * h.level)));
  }
  return height;
}

export const MAPS: MapDef[] = [
  makeMap({
    id: 'ash', name: 'Долина Пепла', subtitle: 'Каньоны и пепельные плато',
    desc: 'Высокие скалы, руины и открытые дороги через долину.', ground: '#24211d', ground2: '#39332c', seed: 11,
    labels: ['Западный рудник', 'Северный реактор', 'Южный реактор', 'Старая дорога', 'Северный рубеж', 'Центральная площадь', 'Южный рубеж', 'Скальный проход', 'Восточные руины', 'Восточный рудник', 'Верхний карьер', 'Нижний карьер'],
    obstacles: [['rock', 1050, 22, 58], ['ruin', 100, 25, 55]],
    props: [['crater', 370, 18, 46], ['ash', 260, 45, 110], ['wreck', 130, 12, 24]],
  }),
  makeMap({
    id: 'frost', name: 'Ледяной перевал', subtitle: 'Замёрзшие вершины',
    desc: 'Ледяные уступы, каменистые перевалы и снежные поля.', ground: '#1c2a33', ground2: '#304451', seed: 23,
    labels: ['Пост разведки', 'Ледник', 'Снежная крепость', 'Мёрзлая дорога', 'Северная пещера', 'Ледяной перевал', 'Южная пещера', 'Зимний форт', 'Ледовый бастион', 'Горный лагерь', 'Верхний пик', 'Нижний пик'],
    obstacles: [['rock', 800, 22, 55], ['ice', 350, 18, 48]],
    props: [['snow', 430, 30, 80], ['crystal', 250, 8, 18], ['lake', 18, 65, 115]],
  }),
  makeMap({
    id: 'desert', name: 'Ржавые дюны', subtitle: 'Песчаные плато',
    desc: 'Дюны, высокие мезы и укрытия среди остовов техники.', ground: '#3a2f1e', ground2: '#544433', seed: 37,
    labels: ['Западный оазис', 'Ржавый мост', 'Старый карьер', 'Пыльная дорога', 'Северные дюны', 'Оазис', 'Южные дюны', 'Дюнный форт', 'Железная станция', 'Восточный лагерь', 'Верхняя меса', 'Нижняя меса'],
    obstacles: [['rock', 900, 20, 52], ['mesa', 160, 35, 75]],
    props: [['dune', 310, 50, 140], ['wreck', 210, 12, 24], ['pebble', 350, 5, 11]],
  }),
  makeMap({
    id: 'forest', name: 'Лесные руины', subtitle: 'Лес и каменные хребты',
    desc: 'Густой лес, скалистые холмы и древние укрепления.', ground: '#152419', ground2: '#263c2a', seed: 53,
    labels: ['Западная поляна', 'Старый мост', 'Болото', 'Лесная дорога', 'Северный форт', 'Древние руины', 'Южный форт', 'Восточная поляна', 'Лесной бастион', 'Заброшенный лагерь', 'Верхний хребет', 'Нижний хребет'],
    obstacles: [['rock', 800, 20, 50], ['tree', 900, 14, 27], ['ruin', 100, 28, 48]],
    props: [['bush', 440, 15, 34], ['pebble', 320, 5, 10]],
  }),
];

export function getMap(id: string): MapDef {
  return MAPS.find((m) => m.id === id) ?? MAPS[0];
}