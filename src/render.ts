/* Отрисовка поля, объектов, юнитов, тумана войны и миникарты (Canvas 2D).
   Статичная часть карты кешируется в офскрин-холст один раз на карту;
   туман войны и неразведанная территория рендерятся через мягкие радиальные маски. */
import { MAP_W, MAP_H, FACTIONS, FACTION_NAMES, terrainHeightAt, type Faction, type MapDef, type Obstacle, type Prop, type Pt, type Theme } from './maps';
import {
  VW, VH, BASE_RANGE, FOG_COLS, FOG_ROWS, UNIT_DEFS, clamp,
  getPlayerVisionCircles, isPointVisible,
  type GameState, type Unit, type Decal,
} from './game';

const TAU = Math.PI * 2;
const COL = {
  player: { main: '#38bdf8', dark: '#0c4a6e', mid: '#0284c7', light: '#e0f2fe', glow: 'rgba(56,189,248,' },
  enemy: { main: '#f87171', dark: '#7f1d1d', mid: '#dc2626', light: '#fee2e2', glow: 'rgba(248,113,113,' },
  enemy2: { main: '#fb923c', dark: '#7c2d12', mid: '#ea580c', light: '#ffedd5', glow: 'rgba(251,146,60,' },
  enemy3: { main: '#c084fc', dark: '#581c87', mid: '#9333ea', light: '#f3e8ff', glow: 'rgba(192,132,252,' },
} as const;

const THEME_FX: Record<Theme, { tint: string; fog: string; light: string; dust: string; contour: string }> = {
  ash: { tint: 'rgba(120,80,40,0.08)', fog: 'rgba(60,50,45,0.10)', light: 'rgba(255,220,160,0.07)', dust: 'rgba(220,200,180,0.4)', contour: 'rgba(255,210,160,0.035)' },
  frost: { tint: 'rgba(120,180,255,0.07)', fog: 'rgba(170,210,255,0.08)', light: 'rgba(200,235,255,0.09)', dust: 'rgba(240,248,255,0.7)', contour: 'rgba(186,230,253,0.045)' },
  desert: { tint: 'rgba(255,170,60,0.09)', fog: 'rgba(255,200,120,0.06)', light: 'rgba(255,230,170,0.10)', dust: 'rgba(240,210,150,0.45)', contour: 'rgba(253,230,138,0.04)' },
  forest: { tint: 'rgba(40,160,80,0.07)', fog: 'rgba(30,80,40,0.12)', light: 'rgba(200,255,200,0.07)', dust: 'rgba(210,255,200,0.4)', contour: 'rgba(134,239,172,0.035)' },
};

/** Детерминированный шум для текстур */
function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/* ============================== СТАТИЧЕСКИЙ ФОН (КЕШ) ============================== */

const TERRAIN_SCALE = 0.25;
const terrainCache = new Map<string, HTMLCanvasElement>();

function buildTerrain(map: MapDef): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = MAP_W * TERRAIN_SCALE; c.height = MAP_H * TERRAIN_SCALE;
  const ctx = c.getContext('2d')!;
  ctx.scale(TERRAIN_SCALE, TERRAIN_SCALE);
  const fx = THEME_FX[map.theme];

  // 1. Базовая заливка + плавные цветовые переходы рельефа
  ctx.fillStyle = map.ground;
  ctx.fillRect(0, 0, MAP_W, MAP_H);
  for (let i = 0; i < 1100; i++) {
    const x = hash(i, 1) * MAP_W, y = hash(i, 2) * MAP_H, r = 90 + hash(i, 3) * 240;
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
    const light = hash(i, 4) > 0.48;
    gr.addColorStop(0, light ? 'rgba(255,255,255,0.055)' : 'rgba(0,0,0,0.15)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }

  // Raised, traversable terraces correspond to the simulation's height tiers.
  for (const hill of map.elevations) {
    ctx.fillStyle = 'rgba(0,0,0,0.23)';
    ctx.beginPath(); ctx.ellipse(hill.x + 20, hill.y + 30, hill.rx + 18, hill.ry + 22, 0, 0, TAU); ctx.fill();
    for (let tier = 0; tier < hill.level; tier++) {
      const scale = 1 - tier / hill.level;
      const rx = hill.rx * scale, ry = hill.ry * scale;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(hill.x, hill.y + 18, rx, ry, 0, 0, TAU); ctx.fill();
      const top = ctx.createLinearGradient(hill.x, hill.y - ry, hill.x, hill.y + ry);
      top.addColorStop(0, map.theme === 'frost' ? 'rgba(208,234,246,0.23)' : map.theme === 'desert' ? 'rgba(246,205,148,0.22)' : map.theme === 'forest' ? 'rgba(161,205,151,0.2)' : 'rgba(221,202,171,0.21)');
      top.addColorStop(1, map.theme === 'frost' ? 'rgba(100,148,171,0.11)' : map.theme === 'desert' ? 'rgba(157,117,69,0.12)' : map.theme === 'forest' ? 'rgba(64,108,69,0.12)' : 'rgba(131,112,90,0.12)');
      ctx.fillStyle = top; ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 8;
      ctx.beginPath(); ctx.ellipse(hill.x, hill.y, rx, ry, 0, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = fx.contour; ctx.lineWidth = 14;
      ctx.beginPath(); ctx.ellipse(hill.x, hill.y - 5, rx, ry, 0, Math.PI, TAU); ctx.stroke();
    }
  }

  // 3. Мелкая текстура грунта и камней
  for (let i = 0; i < 12000; i++) {
    const x = hash(i, 7) * MAP_W, y = hash(i, 8) * MAP_H;
    ctx.fillStyle = hash(i, 9) > 0.5 ? 'rgba(255,255,255,0.055)' : 'rgba(0,0,0,0.16)';
    ctx.fillRect(x, y, 1.5 + hash(i, 10) * 3, 1.5 + hash(i, 11) * 3);
  }

  // 4. Фронтовая магистраль между базами + дорожная разметка
  ctx.save();
  ctx.lineCap = 'round';
  for (const f of FACTIONS) {
    const b = map.bases[f];
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 128;
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(MAP_W / 2, MAP_H / 2); ctx.stroke();
    ctx.strokeStyle = map.ground2; ctx.lineWidth = 104;
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(MAP_W / 2, MAP_H / 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.09)'; ctx.lineWidth = 4; ctx.setLineDash([28, 22]);
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(MAP_W / 2, MAP_H / 2); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.restore();

  // Тематический оттенок и тактическая координатная сетка
  ctx.fillStyle = fx.tint; ctx.fillRect(0, 0, MAP_W, MAP_H);
  ctx.strokeStyle = 'rgba(255,255,255,0.022)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= MAP_W; x += 80) { ctx.moveTo(x, 0); ctx.lineTo(x, MAP_H); }
  for (let y = 0; y <= MAP_H; y += 80) { ctx.moveTo(0, y); ctx.lineTo(MAP_W, y); }
  ctx.stroke();

  // Concrete platforms for capture points.
  for (const p of map.points) {
    const g3 = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r + 34);
    g3.addColorStop(0, 'rgba(30,36,44,0.9)');
    g3.addColorStop(0.8, 'rgba(30,36,44,0.55)');
    g3.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g3; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 34, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 14, 0, TAU); ctx.stroke();
  }

  // Мягкое затемнение по периметру карты
  const vg = ctx.createRadialGradient(MAP_W / 2, MAP_H / 2, MAP_H * 0.5, MAP_W / 2, MAP_H / 2, MAP_W * 0.64);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.48)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, MAP_W, MAP_H);
  return c;
}

function terrain(map: MapDef) {
  let canvas = terrainCache.get(map.id);
  if (!canvas) { canvas = buildTerrain(map); terrainCache.set(map.id, canvas); }
  return canvas;
}

/* ============================== ТУМАН ВОЙНЫ (ОФСКРИН-КОМПОЗИТОР) ============================== */

const FW = 640;
const FH = 360;
const F_SCALE_X = FW / MAP_W;
const F_SCALE_Y = FH / MAP_H;

interface FogLayers {
  shroud: HTMLCanvasElement;
  fog: HTMLCanvasElement;
  target: HTMLCanvasElement;
  blend: HTMLCanvasElement;
  image: ImageData;
  lastTime: number;
}

const fogMap = new WeakMap<GameState, FogLayers>();

function getFogLayers(g: GameState): FogLayers {
  let l = fogMap.get(g);
  if (!l) {
    const shroud = document.createElement('canvas');
    shroud.width = FOG_COLS; shroud.height = FOG_ROWS;
    const sctx = shroud.getContext('2d')!;
    const image = sctx.createImageData(FOG_COLS, FOG_ROWS);
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = 3; image.data[i + 1] = 6; image.data[i + 2] = 11;
    }
    const fog = document.createElement('canvas');
    fog.width = FW; fog.height = FH;
    const target = document.createElement('canvas');
    target.width = FW; target.height = FH;
    const blend = document.createElement('canvas');
    blend.width = FW; blend.height = FH;
    l = { shroud, fog, target, blend, image, lastTime: -1 };
    fogMap.set(g, l);
  }
  return l;
}

/** Обновляет текстуры разведки и тумана войны для текущего кадра */
function composeFog(g: GameState): HTMLCanvasElement {
  const layers = getFogLayers(g);
  const { shroud, fog, target, blend, image } = layers;
  if (layers.lastTime >= 0 && g.time >= layers.lastTime && g.time - layers.lastTime < 0.08) return fog;
  const sctx = shroud.getContext('2d')!;
  const fctx = target.getContext('2d')!;
  const circles = getPlayerVisionCircles(g);

  // The persistent mask comes from the same explored cells used by gameplay.
  for (let i = 0; i < g.explored.length; i++) image.data[i * 4 + 3] = g.explored[i] ? 0 : 255;
  sctx.putImageData(image, 0, 0);
  fctx.clearRect(0, 0, FW, FH);
  fctx.fillStyle = 'rgba(5, 10, 18, 0.66)';
  fctx.fillRect(0, 0, FW, FH);
  fctx.save();
  fctx.globalCompositeOperation = 'destination-out';
  for (const c of circles) {
    const cx = c.x * F_SCALE_X, cy = c.y * F_SCALE_Y;
    const r = c.r * F_SCALE_X;
    const gr = fctx.createRadialGradient(cx, cy, r * 0.42, cx, cy, r * 1.08);
    gr.addColorStop(0, 'rgba(0,0,0,1)');
    gr.addColorStop(0.4, 'rgba(0,0,0,0.97)');
    gr.addColorStop(0.7, 'rgba(0,0,0,0.58)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    fctx.fillStyle = gr;
    fctx.beginPath(); fctx.arc(cx, cy, r * 1.08, 0, TAU); fctx.fill();
  }
  fctx.restore();
  fctx.save();
  fctx.imageSmoothingEnabled = true;
  fctx.imageSmoothingQuality = 'high';
  fctx.filter = 'blur(2px)';
  fctx.drawImage(shroud, 0, 0, FW, FH);
  fctx.restore();

  const out = fog.getContext('2d')!;
  if (layers.lastTime < 0 || g.time < layers.lastTime) {
    out.clearRect(0, 0, FW, FH);
    out.drawImage(target, 0, 0);
  } else {
    const mix = 1 - Math.exp(-Math.min(g.time - layers.lastTime, 0.2) * 6);
    const bctx = blend.getContext('2d')!;
    bctx.clearRect(0, 0, FW, FH);
    bctx.globalAlpha = 1 - mix;
    bctx.drawImage(fog, 0, 0);
    bctx.globalCompositeOperation = 'lighter';
    bctx.globalAlpha = mix;
    bctx.drawImage(target, 0, 0);
    bctx.globalAlpha = 1;
    bctx.globalCompositeOperation = 'source-over';
    out.clearRect(0, 0, FW, FH);
    out.drawImage(blend, 0, 0);
  }
  layers.lastTime = g.time;
  return fog;
}

/* ============================== ДЕКОРАЦИИ И ПРЕПЯТСТВИЯ ============================== */

function drawProp(ctx: CanvasRenderingContext2D, p: Prop) {
  const { x, y, r } = p;
  ctx.save();
  switch (p.kind) {
    case 'crater': {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.7, 'rgba(0,0,0,0.28)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.72, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(x, y + 2, r * 0.9, r * 0.62, 0, 0.1, Math.PI - 0.1); ctx.stroke();
      break;
    }
    case 'ash': {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(190,190,190,0.11)'); g.addColorStop(1, 'rgba(190,190,190,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      break;
    }
    case 'wreck':
      ctx.translate(x, y); ctx.rotate(r * 0.37);
      ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(-r + 3, -r * 0.4 + 4, r * 2, r * 0.8);
      ctx.fillStyle = '#3b3b40'; ctx.fillRect(-r, -r * 0.4, r * 2, r * 0.8);
      ctx.fillStyle = '#52525b'; ctx.fillRect(-r * 0.9, -r * 0.3, r * 1.1, r * 0.6);
      ctx.strokeStyle = '#7a4a2a'; ctx.lineWidth = 2; ctx.strokeRect(-r, -r * 0.4, r * 2, r * 0.8);
      ctx.fillStyle = '#7f1d1d'; ctx.fillRect(-r * 0.3, -r * 0.15, r * 0.5, r * 0.3);
      ctx.fillStyle = '#1c1917'; ctx.fillRect(r * 0.4, -r * 0.5, r * 0.3, r);
      break;
    case 'snow': {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(241,245,249,0.38)'); g.addColorStop(1, 'rgba(241,245,249,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.6, 0.3, 0, TAU); ctx.fill();
      break;
    }
    case 'crystal':
      for (let i = 0; i < 3; i++) {
        const ox = x + (i - 1) * r * 0.8, h = r * (1.1 + (i === 1 ? 0.5 : 0));
        const g = ctx.createLinearGradient(ox, y - h, ox, y + r * 0.5);
        g.addColorStop(0, '#f0f9ff'); g.addColorStop(1, '#0284c7');
        ctx.fillStyle = g; ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(ox, y - h); ctx.lineTo(ox + r * 0.45, y); ctx.lineTo(ox, y + r * 0.5); ctx.lineTo(ox - r * 0.45, y);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(125,211,252,0.22)'; ctx.beginPath(); ctx.arc(x, y, r * 2.2, 0, TAU); ctx.fill();
      break;
    case 'lake': {
      ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.beginPath(); ctx.ellipse(x, y + 4, r * 1.42, r * 0.86, 0, 0, TAU); ctx.fill();
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.35);
      g.addColorStop(0, 'rgba(90,175,225,0.75)'); g.addColorStop(1, 'rgba(35,95,145,0.68)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, r * 1.35, r * 0.8, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(224,242,254,0.55)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(x, y, r * 1.35, r * 0.8, 0, 0, TAU); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.32)';
      ctx.beginPath(); ctx.ellipse(x - r * 0.3, y - r * 0.2, r * 0.6, r * 0.18, 0, 0, TAU); ctx.fill();
      break;
    }
    case 'dune': {
      const g = ctx.createLinearGradient(x, y - r * 0.7, x, y + r * 0.7);
      g.addColorStop(0, 'rgba(255,220,150,0.18)'); g.addColorStop(0.5, 'rgba(180,140,80,0.1)'); g.addColorStop(1, 'rgba(60,40,20,0.24)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, r * 1.4, r * 0.7, -0.2, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(253,230,138,0.2)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(x, y, r * 1.1, r * 0.5, -0.2, Math.PI * 1.05, Math.PI * 1.9); ctx.stroke();
      break;
    }
    case 'bush':
      ctx.fillStyle = 'rgba(0,0,0,0.32)'; ctx.beginPath(); ctx.arc(x + 3, y + 4, r, 0, TAU); ctx.fill();
      for (let i = 0; i < 4; i++) {
        const a = i * 1.7, rr = r * 0.6;
        ctx.fillStyle = i % 2 ? '#1f4d2b' : '#275e34';
        ctx.beginPath(); ctx.arc(x + Math.cos(a) * r * 0.35, y + Math.sin(a) * r * 0.35, rr, 0, TAU); ctx.fill();
      }
      ctx.fillStyle = '#3f8a4a'; ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.35, 0, TAU); ctx.fill();
      break;
    case 'pebble':
      ctx.fillStyle = 'rgba(0,0,0,0.32)'; ctx.beginPath(); ctx.ellipse(x + 1, y + 2, r, r * 0.7, 0.4, 0, TAU); ctx.fill();
      ctx.fillStyle = '#6b6b63'; ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.7, 0.4, 0, TAU); ctx.fill();
      ctx.fillStyle = '#8a8a80'; ctx.beginPath(); ctx.ellipse(x - r * 0.25, y - r * 0.25, r * 0.4, r * 0.25, 0.4, 0, TAU); ctx.fill();
      break;
  }
  ctx.restore();
}

function drawObstacle(ctx: CanvasRenderingContext2D, o: Obstacle) {
  const { x, y, r } = o;
  ctx.save();
  // направленная мягкая тень + ambient occlusion у основания
  const sh = ctx.createRadialGradient(x + r * 0.32, y + r * 0.48, r * 0.2, x + r * 0.32, y + r * 0.48, r * 1.45);
  sh.addColorStop(0, 'rgba(0,0,0,0.52)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sh; ctx.beginPath(); ctx.ellipse(x + r * 0.32, y + r * 0.48, r * 1.45, r * 1.1, 0, 0, TAU); ctx.fill();

  switch (o.kind) {
    case 'tree': {
      ctx.fillStyle = '#3b2a1a'; ctx.beginPath(); ctx.arc(x, y, r * 0.32, 0, TAU); ctx.fill();
      const layers = [[1.04, '#112e19'], [0.84, '#1b4727'], [0.62, '#286336'], [0.38, '#3f8a4a'], [0.18, '#65a36e']] as const;
      layers.forEach(([k, c], i) => {
        ctx.fillStyle = c;
        ctx.beginPath();
        const rr = r * k, ox = -i * r * 0.09, oy = -i * r * 0.09;
        for (let j = 0; j < 10; j++) {
          const a = (j / 10) * TAU + i, rad = rr * (0.85 + hash(x + j, y + i) * 0.28);
          const px = x + ox + Math.cos(a) * rad, py = y + oy + Math.sin(a) * rad;
          if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath(); ctx.fill();
      });
      break;
    }
    case 'ruin': {
      ctx.fillStyle = '#3f3a35';
      ctx.beginPath(); ctx.rect(x - r, y - r * 0.8, r * 2, r * 1.6); ctx.fill();
      const g = ctx.createLinearGradient(x - r, y - r * 0.8, x + r, y + r * 0.8);
      g.addColorStop(0, '#857d72'); g.addColorStop(1, '#544e47');
      ctx.fillStyle = g; ctx.fillRect(x - r, y - r * 0.8, r * 2, r * 1.35);
      ctx.strokeStyle = '#2d2a26'; ctx.lineWidth = 1.5;
      for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(x - r, y - r * 0.8 + i * r * 0.35); ctx.lineTo(x + r, y - r * 0.8 + i * r * 0.35); ctx.stroke(); }
      for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.moveTo(x - r + i * r * 0.5 + (i % 2) * r * 0.25, y - r * 0.8); ctx.lineTo(x - r + i * r * 0.5 + (i % 2) * r * 0.25, y + r * 0.5); ctx.stroke(); }
      ctx.fillStyle = '#4a4540'; ctx.beginPath(); ctx.moveTo(x - r * 0.5, y - r * 0.8); ctx.lineTo(x - r * 0.1, y); ctx.lineTo(x + r * 0.3, y - r * 0.8); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#1f4d2b'; ctx.beginPath(); ctx.arc(x + r * 0.7, y + r * 0.6, r * 0.25, 0, TAU); ctx.fill();
      break;
    }
    case 'ice': {
      const g = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
      g.addColorStop(0, '#f8fafc'); g.addColorStop(0.45, '#bae6fd'); g.addColorStop(1, '#0284c7');
      ctx.fillStyle = g; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.9, y - r * 0.2); ctx.lineTo(x + r * 0.5, y + r * 0.9);
      ctx.lineTo(x - r * 0.7, y + r * 0.7); ctx.lineTo(x - r * 0.9, y - r * 0.3);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = 'rgba(14,116,144,0.55)'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x - r * 0.4, y - r * 0.1); ctx.lineTo(x + r * 0.3, y + r * 0.4); ctx.moveTo(x, y - r * 0.8); ctx.lineTo(x + r * 0.1, y + r * 0.2); ctx.stroke();
      break;
    }
    case 'mesa': {
      ctx.fillStyle = '#5c4228'; ctx.beginPath(); ctx.arc(x, y + r * 0.12, r, 0, TAU); ctx.fill();
      const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
      g.addColorStop(0, '#d9b37c'); g.addColorStop(0.6, '#a8845a'); g.addColorStop(1, '#7c5d3a');
      ctx.fillStyle = g; ctx.strokeStyle = '#e6c594'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y - r * 0.1, r * 0.92, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = 'rgba(80,50,20,0.38)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y - r * 0.1, r * 0.65, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y - r * 0.1, r * 0.4, 0, TAU); ctx.stroke();
      break;
    }
    default: {
      const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r * 1.1);
      g.addColorStop(0, '#9aa1ab'); g.addColorStop(0.55, '#5b6370'); g.addColorStop(1, '#2b3038');
      ctx.fillStyle = g; ctx.strokeStyle = 'rgba(220,230,240,0.38)'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + x * 0.01;
        const rr = r * (0.78 + hash(x + i, y) * 0.3);
        const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      // световая грань и трещина
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x - r * 0.3, y - r * 0.5); ctx.lineTo(x + r * 0.1, y + r * 0.1); ctx.lineTo(x + r * 0.5, y + r * 0.05); ctx.stroke();
    }
  }
  ctx.restore();
}

/* ============================== ЮНИТЫ ============================== */

/** Гусеничная лента с бегущими траками */
function tracks(ctx: CanvasRenderingContext2D, len: number, w: number, off: number, odo: number) {
  for (const side of [-1, 1]) {
    const y = side * off;
    ctx.fillStyle = '#0f1318';
    ctx.beginPath(); ctx.roundRect(-len / 2, y - w / 2, len, w, 3); ctx.fill();
    ctx.strokeStyle = '#272e38'; ctx.lineWidth = 1;
    ctx.strokeRect(-len / 2 + 0.5, y - w / 2 + 0.5, len - 1, w - 1);
    ctx.fillStyle = '#47505c';
    const phase = (odo * 0.55) % 6;
    for (let x = -len / 2 + 1 + phase; x < len / 2 - 1; x += 6) ctx.fillRect(x, y - w / 2 + 1, 3, w - 2);
  }
}

function unitShadow(ctx: CanvasRenderingContext2D, r: number) {
  const g = ctx.createRadialGradient(3, 5, r * 0.3, 3, 5, r * 1.45);
  g.addColorStop(0, 'rgba(0,0,0,0.52)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(3, 5, r * 1.45, r * 1.08, 0, 0, TAU); ctx.fill();
}

function drawUnit(ctx: CanvasRenderingContext2D, g: GameState, u: Unit, t: number) {
  const d = UNIT_DEFS[u.kind];
  const c = COL[u.faction];
  const selected = g.selected.has(u.id);
  const rec = u.recoil * u.recoil;
  ctx.save();
  ctx.translate(u.x, u.y);
  unitShadow(ctx, d.radius);

  // конус фары / тактического фонаря у юнитов игрока
  if (u.faction === 'player') {
    ctx.save();
    ctx.rotate(u.turret);
    const beamLen = u.kind === 'arty' ? 75 : u.kind === 'tank' ? 68 : 48;
    const beam = ctx.createLinearGradient(6, 0, beamLen, 0);
    beam.addColorStop(0, 'rgba(186,230,253,0.16)');
    beam.addColorStop(1, 'rgba(186,230,253,0)');
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(6, -3); ctx.lineTo(beamLen, -18); ctx.lineTo(beamLen, 18); ctx.lineTo(6, 3);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  if (selected) {
    ctx.strokeStyle = 'rgba(74,222,128,0.95)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, 3, d.radius + 8, (d.radius + 8) * 0.75, 0, 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(74,222,128,0.35)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(0, 3, d.radius + 11, (d.radius + 11) * 0.75, 0, 0, TAU); ctx.stroke();
  }

  // ---- корпус ----
  ctx.save();
  ctx.rotate(u.angle);
  if (u.kind === 'rifle') {
    // экзо-пехота: шагающие ботинки, бронежилет, наплечники, ранец и шлем с визором
    const step = Math.sin(u.odo * 0.25) * 3.5;
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(-3 + step, -7.5, 6, 4); ctx.fillRect(-3 - step, 3.5, 6, 4);
    // тактический ранец
    ctx.fillStyle = '#1e293b'; ctx.strokeStyle = c.main; ctx.lineWidth = 1;
    ctx.fillRect(-9.5, -4, 4, 8); ctx.strokeRect(-9.5, -4, 4, 8);
    // бронекорпус и наплечники
    const bg = ctx.createRadialGradient(-2, -2, 1, 0, 0, d.radius);
    bg.addColorStop(0, c.mid); bg.addColorStop(1, c.dark);
    ctx.fillStyle = bg; ctx.strokeStyle = c.main; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(-6.5, -6.5, 13, 13, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = c.main;
    ctx.fillRect(-4, -8, 7, 2.5); ctx.fillRect(-4, 5.5, 7, 2.5);
    // шлем и светящийся визор
    ctx.fillStyle = '#0f172a'; ctx.beginPath(); ctx.arc(0.5, 0, 4.6, 0, TAU); ctx.fill();
    ctx.fillStyle = c.light; ctx.beginPath(); ctx.ellipse(2.4, 0, 1.6, 2.8, 0, 0, TAU); ctx.fill();
  } else if (u.kind === 'tank') {
    tracks(ctx, 36, 7.5, 12.5, u.odo);
    const bg = ctx.createLinearGradient(-16, -12, 18, 12);
    bg.addColorStop(0, c.mid); bg.addColorStop(0.55, c.dark); bg.addColorStop(1, '#090d16');
    ctx.fillStyle = bg; ctx.strokeStyle = c.main; ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-16, -10.5); ctx.lineTo(13, -10.5); ctx.lineTo(19, -5);
    ctx.lineTo(19, 5); ctx.lineTo(13, 10.5); ctx.lineTo(-16, 10.5);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // динамическая защита (бронеплиты) и кормовой реактор
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(-13, -9, 8, 3.5); ctx.fillRect(-3, -9, 8, 3.5);
    ctx.fillRect(-13, 5.5, 8, 3.5); ctx.fillRect(-3, 5.5, 8, 3.5);
    ctx.fillStyle = '#fb923c';
    ctx.fillRect(-16.5, -5, 2.5, 3.5); ctx.fillRect(-16.5, 1.5, 2.5, 3.5);
    ctx.fillStyle = c.light;
    ctx.fillRect(15, -7, 2.5, 2.5); ctx.fillRect(15, 4.5, 2.5, 2.5);
  } else {
    tracks(ctx, 30, 6.5, 11.5, u.odo);
    const bg = ctx.createLinearGradient(-15, -10, 15, 10);
    bg.addColorStop(0, c.mid); bg.addColorStop(1, c.dark);
    ctx.fillStyle = bg; ctx.strokeStyle = c.main; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(-15, -9.5, 28, 19, 4); ctx.fill(); ctx.stroke();
    // гидравлические опоры и энергоблок
    ctx.fillStyle = '#334155';
    ctx.fillRect(-17, -14.5, 5.5, 5.5); ctx.fillRect(-17, 9, 5.5, 5.5);
    ctx.fillStyle = '#fbbf24';
    ctx.fillRect(-13, -4, 4, 8);
  }
  ctx.restore();

  // ---- башня / оружие (поворачивается к цели) ----
  ctx.save();
  ctx.rotate(u.turret);
  if (u.kind === 'rifle') {
    // лазерный целеуказатель при наведении на врага
    if (u.target) {
      ctx.strokeStyle = u.faction === 'player' ? 'rgba(56,189,248,0.35)' : 'rgba(248,113,113,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(14, 1); ctx.lineTo(42, 1); ctx.stroke();
    }
    ctx.fillStyle = '#334155'; ctx.fillRect(2 - rec * 2, -0.5, 8, 3.2);
    ctx.fillStyle = '#e2e8f0'; ctx.fillRect(6 - rec * 2, 0, 11, 2.2);
    ctx.fillStyle = c.main; ctx.fillRect(8 - rec * 2, 0.3, 4, 1.5);
  } else if (u.kind === 'tank') {
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.arc(1, 2, 9.5, 0, TAU); ctx.fill();
    // ствол с кожухом и дульным тормозом
    ctx.fillStyle = '#64748b'; ctx.fillRect(6 - rec * 5, -3, 14, 6);
    ctx.fillStyle = '#cbd5e1'; ctx.fillRect(14 - rec * 5, -2.2, 11, 4.4);
    ctx.fillStyle = '#e2e8f0'; ctx.fillRect(23 - rec * 5, -3.6, 5, 7.2);
    // гранёная башня + люк командира
    const tg = ctx.createRadialGradient(-2, -2, 1, 0, 0, 10);
    tg.addColorStop(0, c.main); tg.addColorStop(1, c.dark);
    ctx.fillStyle = tg; ctx.strokeStyle = c.light; ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-8, -7); ctx.lineTo(6, -6); ctx.lineTo(9, 0); ctx.lineTo(6, 6); ctx.lineTo(-8, 7);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#0f172a'; ctx.beginPath(); ctx.arc(-2.5, -1.5, 3.2, 0, TAU); ctx.fill();
    ctx.fillStyle = c.light; ctx.beginPath(); ctx.arc(3.5, 2.5, 1.5, 0, TAU); ctx.fill();
  } else {
    // направляющие рельсы осадной мортиры + радар
    ctx.fillStyle = '#475569';
    ctx.fillRect(-4, -6.5, 22, 3); ctx.fillRect(-4, 3.5, 22, 3);
    ctx.fillStyle = '#64748b'; ctx.fillRect(0 - rec * 7, -3.5, 29, 7);
    ctx.fillStyle = '#cbd5e1'; ctx.fillRect(5 - rec * 7, -2.2, 21, 4.4);
    ctx.fillStyle = '#fbbf24'; ctx.fillRect(26 - rec * 7, -4.5, 5, 9);
    ctx.fillStyle = c.main; ctx.beginPath(); ctx.arc(-2, 0, 6.2, 0, TAU); ctx.fill();
    ctx.fillStyle = '#e0f2fe'; ctx.beginPath(); ctx.arc(-2, 0, 2.6, 0, TAU); ctx.fill();
  }
  ctx.restore();

  // вспышка попадания
  if (u.flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${0.35 + u.flash * 4})`;
    ctx.beginPath(); ctx.arc(0, 0, d.radius + 2, 0, TAU); ctx.fill();
  }
  // мягкое свечение фракции
  const pulse = selected ? 0.28 + Math.sin(t * 6) * 0.08 : 0.14;
  const gl = ctx.createRadialGradient(0, 0, d.radius * 0.5, 0, 0, d.radius * 2.3);
  gl.addColorStop(0, c.glow + pulse + ')'); gl.addColorStop(1, c.glow + '0)');
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(0, 0, d.radius * 2.3, 0, TAU); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();

  // полоска здоровья
  if (u.hp < u.maxHp || selected) {
    const w = Math.max(28, d.radius * 2.3), hpk = clamp(u.hp / u.maxHp, 0, 1);
    const y = u.y - d.radius - 15;
    ctx.fillStyle = 'rgba(0,0,0,0.78)'; ctx.beginPath(); ctx.roundRect(u.x - w / 2 - 1, y - 1, w + 2, 6, 2); ctx.fill();
    ctx.fillStyle = hpk > 0.6 ? '#4ade80' : hpk > 0.3 ? '#fbbf24' : '#ef4444';
    if (u.faction !== 'player') ctx.fillStyle = hpk > 0.5 ? c.main : '#dc2626';
    ctx.fillRect(u.x - w / 2, y, w * hpk, 4);
    ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fillRect(u.x - w / 2, y, w * hpk, 1.5);
  }
  // дым у повреждённой техники
  if (g.status === 'playing' && u.kind !== 'rifle' && u.hp < u.maxHp * 0.4 && Math.random() < 0.25) {
    g.particles.push({ kind: 'smoke', x: u.x - Math.cos(u.angle) * 6, y: u.y - Math.sin(u.angle) * 6, vx: (Math.random() - 0.5) * 8, vy: -14, life: 0.9, max: 0.9, color: '#3f3f46', size: 4, drag: 0.97 });
  }
}

/* ============================== БАЗЫ ============================== */

function drawBase(ctx: CanvasRenderingContext2D, g: GameState, f: Faction, t: number) {
  if (f !== 'player' && !g.baseScouted[f]) return;
  const b = g.map.bases[f];
  const c = COL[f];
  const selected = g.selectedBase === f;
  const observedHp = f === 'player' || isPointVisible(g, b.x, b.y) ? g.baseHp[f] : g.knownBaseHp[f];
  const hpk = clamp(observedHp / g.baseMax, 0, 1);
  const alive = observedHp > 0;
  ctx.save();
  ctx.translate(b.x, b.y);

  const pad = ctx.createRadialGradient(0, 0, 30, 0, 0, 185);
  pad.addColorStop(0, 'rgba(15,20,28,0.95)');
  pad.addColorStop(0.68, 'rgba(20,26,34,0.65)');
  pad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = pad; ctx.beginPath(); ctx.arc(0, 0, 185, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, 92, 0, TAU); ctx.stroke();
  ctx.strokeStyle = c.glow + '0.28)'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(0, 0, 128, 0, TAU); ctx.stroke();
  ctx.setLineDash([8, 10]); ctx.strokeStyle = 'rgba(250,204,21,0.18)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(0, 0, 156, 0, TAU); ctx.stroke(); ctx.setLineDash([]);

  const sh = ctx.createRadialGradient(6, 10, 20, 6, 10, 84);
  sh.addColorStop(0, 'rgba(0,0,0,0.58)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sh; ctx.beginPath(); ctx.ellipse(6, 10, 84, 65, 0, 0, TAU); ctx.fill();

  if (selected) {
    ctx.strokeStyle = 'rgba(74,222,128,0.9)'; ctx.lineWidth = 2;
    ctx.setLineDash([10, 8]); ctx.lineDashOffset = -t * 30;
    ctx.beginPath(); ctx.arc(0, 0, 66, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(74,222,128,0.25)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 12]);
    ctx.beginPath(); ctx.arc(0, 0, BASE_RANGE, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(74,222,128,0.9)'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(`ОБОРОНА ${BASE_RANGE}`, 0, -BASE_RANGE + 4);
  }
  // вращающееся силовое кольцо
  if (alive) {
    ctx.save(); ctx.rotate(t * 0.45);
    ctx.strokeStyle = c.glow + '0.55)'; ctx.lineWidth = 3;
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(0, 0, 58, i * (TAU / 3), i * (TAU / 3) + 1.3); ctx.stroke(); }
    ctx.restore();
  }
  // восьмигранный бастион
  const base = ctx.createRadialGradient(-10, -12, 5, 0, 0, 54);
  base.addColorStop(0, '#333d4d'); base.addColorStop(1, '#0d1117');
  ctx.fillStyle = base; ctx.strokeStyle = c.main; ctx.lineWidth = 2.2;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) { const a = i * (TAU / 8) + Math.PI / 8; ctx.lineTo(Math.cos(a) * 52, Math.sin(a) * 52); }
  ctx.closePath(); ctx.fill(); ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  for (let i = 0; i < 8; i += 2) {
    const a = i * (TAU / 8) + Math.PI / 8, a2 = a + TAU / 8;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * 52, Math.sin(a) * 52); ctx.lineTo(Math.cos(a2) * 52, Math.sin(a2) * 52); ctx.closePath(); ctx.fill();
  }
  // командный корпус
  const body = ctx.createLinearGradient(0, -32, 0, 32);
  body.addColorStop(0, c.mid); body.addColorStop(0.5, c.dark); body.addColorStop(1, '#090e1a');
  ctx.fillStyle = body; ctx.strokeStyle = c.main; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(-34, -30, 68, 60, 12); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.beginPath(); ctx.roundRect(-30, -27, 60, 10, 5); ctx.fill();

  // угловые турели
  const aim = g.baseAim[f];
  const firing = !!g.baseTarget[f] && alive && (f === 'player' || isPointVisible(g, b.x, b.y));
  for (const [sx, sy] of [[-30, -34], [30, -34], [-30, 34], [30, 34]] as const) {
    const local = Math.atan2(sy, sx);
    const a = firing ? aim : local;
    ctx.fillStyle = '#1f2937'; ctx.beginPath(); ctx.arc(sx, sy, 7, 0, TAU); ctx.fill();
    ctx.fillStyle = c.main; ctx.beginPath(); ctx.arc(sx, sy, 4, 0, TAU); ctx.fill();
    ctx.fillStyle = '#cbd5e1';
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(a); ctx.fillRect(2, -1.6, 12, 3.2); ctx.restore();
  }
  // центральная спаренная установка
  if (alive) {
    ctx.save();
    ctx.rotate(aim);
    ctx.fillStyle = '#334155'; ctx.beginPath(); ctx.roundRect(-8, -12, 18, 24, 4); ctx.fill();
    ctx.fillStyle = '#94a3b8';
    ctx.fillRect(6, -9, 26, 5); ctx.fillRect(6, 4, 26, 5);
    ctx.fillStyle = '#e2e8f0'; ctx.fillRect(30, -9.5, 4, 6); ctx.fillRect(30, 3.5, 4, 6);
    ctx.fillStyle = c.main; ctx.beginPath(); ctx.arc(0, 0, 5, 0, TAU); ctx.fill();
    if (firing) {
      ctx.globalCompositeOperation = 'lighter';
      const mg = ctx.createRadialGradient(34, -6.5, 0, 34, -6.5, 12);
      mg.addColorStop(0, 'rgba(255,255,255,0.95)'); mg.addColorStop(1, 'rgba(255,180,80,0)');
      ctx.fillStyle = mg; ctx.beginPath(); ctx.arc(34, -6.5, 12, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(34, 6.5, 12, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
  }
  // реактор — пульсирующее ядро
  const pulse = 0.75 + Math.sin(t * 3) * 0.25;
  if (alive) {
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 24);
    core.addColorStop(0, '#ffffff'); core.addColorStop(0.3, c.light); core.addColorStop(0.7, c.main); core.addColorStop(1, c.glow + '0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = core; ctx.globalAlpha = pulse; ctx.beginPath(); ctx.arc(0, 0, 24, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
  ctx.fillStyle = '#0f172a'; ctx.beginPath(); ctx.arc(0, 0, 17, 0, TAU); ctx.fill();
  ctx.fillStyle = alive ? c.main : '#374151'; ctx.beginPath(); ctx.arc(0, 0, 13, 0, TAU); ctx.fill();
  ctx.fillStyle = alive ? '#ffffff' : '#111827'; ctx.globalAlpha = alive ? pulse : 1; ctx.beginPath(); ctx.arc(0, 0, 6, 0, TAU); ctx.fill(); ctx.globalAlpha = 1;

  if (g.status === 'playing' && alive && hpk < 0.5 && Math.random() < 0.5) {
    g.particles.push({ kind: 'smoke', x: b.x + (Math.random() - 0.5) * 50, y: b.y + (Math.random() - 0.5) * 40, vx: (Math.random() - 0.5) * 10, vy: -20, life: 1.2, max: 1.2, color: hpk < 0.25 ? '#1c1917' : '#52525b', size: 6, drag: 0.97 });
    if (hpk < 0.25 && Math.random() < 0.4) g.particles.push({ kind: 'spark', x: b.x + (Math.random() - 0.5) * 40, y: b.y + (Math.random() - 0.5) * 30, vx: 0, vy: -30, life: 0.4, max: 0.4, color: '#fb923c', size: 3, drag: 0.98 });
  }
  // прогресс производства
  const q = g.queue[f];
  if (q.length && (f === 'player' || isPointVisible(g, b.x, b.y))) {
    const p = 1 - q[0].remaining / q[0].total;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(0, 0, 60, 0, TAU); ctx.stroke();
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, 0, 60, -Math.PI / 2, -Math.PI / 2 + p * TAU); ctx.stroke(); ctx.lineCap = 'butt';
  }
  // свечение базы
  const gl = ctx.createRadialGradient(0, 0, 40, 0, 0, 120);
  gl.addColorStop(0, c.glow + '0.16)'); gl.addColorStop(1, c.glow + '0)');
  ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(0, 0, 120, 0, TAU); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();

  // HP и подпись
  const w = 120;
  ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.beginPath(); ctx.roundRect(b.x - w / 2 - 1, b.y - 84, w + 2, 10, 3); ctx.fill();
  ctx.fillStyle = c.main;
  ctx.fillRect(b.x - w / 2, b.y - 83, w * hpk, 8);
  ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillRect(b.x - w / 2, b.y - 83, w * hpk, 2);
  ctx.fillStyle = '#f8fafc'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4;
  ctx.fillText(f === 'player' ? 'БАЗА АЛЬЯНСА' : `БАЗА ${FACTION_NAMES[f].toUpperCase()}`, b.x, b.y - 90);
  ctx.font = '10px system-ui'; ctx.fillStyle = '#cbd5e1';
  ctx.fillText(`${Math.ceil(observedHp)} HP`, b.x, b.y + 74);
  ctx.shadowBlur = 0;
}

/* ============================== ТОЧКИ, ДЕКАЛИ, СНАРЯДЫ, ЭФФЕКТЫ ============================== */

function drawPoint(ctx: CanvasRenderingContext2D, p: GameState['points'][number], t: number) {
  if (!p.scouted) return;
  const owner = p.knownOwner;
  const capture = p.knownCapture;
  const contested = p.knownContested;
  const col = owner ? COL[owner].main : '#94a3b8';
  const glow = owner ? COL[owner].glow : 'rgba(148,163,184,';
  const fill = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
  fill.addColorStop(0, glow + '0.24)'); fill.addColorStop(1, glow + '0.05)');
  ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
  // вращающаяся граница
  ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(t * 0.25 * (owner && owner !== 'player' ? -1 : 1));
  ctx.strokeStyle = contested ? '#fbbf24' : col; ctx.lineWidth = contested ? 3.5 : 2;
  ctx.setLineDash([10, 7]); ctx.beginPath(); ctx.arc(0, 0, p.r, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
  ctx.restore();
  // прогресс захвата
  if (Math.abs(capture) > 0.02 && !contested) {
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 7; ctx.beginPath(); ctx.arc(p.x, p.y, p.r - 8, 0, TAU); ctx.stroke();
    ctx.strokeStyle = capture > 0 ? '#38bdf8' : (owner ? COL[owner].main : '#f87171'); ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r - 8, -Math.PI / 2, -Math.PI / 2 + Math.abs(capture) * TAU); ctx.stroke(); ctx.lineCap = 'butt';
  }
  // энергетический маяк
  const beam = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 36);
  beam.addColorStop(0, glow + (0.38 + Math.sin(t * 4) * 0.12) + ')'); beam.addColorStop(1, glow + '0)');
  ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = beam; ctx.beginPath(); ctx.arc(p.x, p.y, 36, 0, TAU); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#0f172a'; ctx.strokeStyle = col; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(p.x, p.y, 18, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.fillStyle = col; ctx.font = 'bold 17px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(p.id, p.x, p.y + 1); ctx.textBaseline = 'alphabetic';
  ctx.font = 'bold 11px system-ui'; ctx.fillStyle = '#e2e8f0';
  ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4;
  ctx.fillText(p.label.toUpperCase(), p.x, p.y + p.r + 18);
  ctx.shadowBlur = 0;
}

function drawDecal(ctx: CanvasRenderingContext2D, d: Decal) {
  const a = clamp(d.life / 8, 0, 1);
  ctx.save(); ctx.globalAlpha = a; ctx.translate(d.x, d.y);
  if (d.kind === 'scorch') {
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, d.r);
    g.addColorStop(0, 'rgba(0,0,0,0.65)'); g.addColorStop(0.6, 'rgba(10,10,10,0.38)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, d.r, 0, TAU); ctx.fill();
  } else if (d.kind === 'track') {
    ctx.rotate(d.angle);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(-4, -d.r, 8, 3);
    ctx.fillRect(-4, d.r - 3, 8, 3);
  } else {
    ctx.rotate(d.angle);
    const c = COL[d.faction];
    ctx.fillStyle = '#18181b'; ctx.beginPath(); ctx.roundRect(-d.r, -d.r * 0.7, d.r * 2, d.r * 1.4, 3); ctx.fill();
    ctx.fillStyle = c.dark; ctx.globalAlpha = a * 0.6; ctx.beginPath(); ctx.roundRect(-d.r * 0.8, -d.r * 0.5, d.r * 1.4, d.r, 3); ctx.fill();
    ctx.globalAlpha = a; ctx.fillStyle = '#27272a'; ctx.fillRect(-d.r * 0.3, -d.r * 1.1, d.r * 0.6, d.r * 0.5);
  }
  ctx.restore();
}

function drawParticles(ctx: CanvasRenderingContext2D, g: GameState) {
  for (const p of g.particles) {
    if (!isPointVisible(g, p.x, p.y)) continue;
    if (p.kind !== 'smoke' && p.kind !== 'debris') continue;
    const k = clamp(p.life / p.max, 0, 1);
    if (p.kind === 'smoke') {
      ctx.globalAlpha = k * 0.45;
      const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
      gr.addColorStop(0, p.color); gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
    } else {
      ctx.globalAlpha = k; ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
  }
  ctx.globalCompositeOperation = 'lighter';
  for (const p of g.particles) {
    if (!isPointVisible(g, p.x, p.y)) continue;
    const k = clamp(p.life / p.max, 0, 1);
    if (p.kind === 'spark') {
      ctx.globalAlpha = k; ctx.fillStyle = p.color;
      const l = Math.hypot(p.vx, p.vy);
      if (l > 40) {
        ctx.strokeStyle = p.color; ctx.lineWidth = p.size;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - (p.vx / l) * Math.min(10, l * 0.06), p.y - (p.vy / l) * Math.min(10, l * 0.06)); ctx.stroke();
      } else { ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill(); }
    } else if (p.kind === 'flash') {
      const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
      gr.addColorStop(0, 'rgba(255,255,255,' + k + ')'); gr.addColorStop(0.4, p.color); gr.addColorStop(1, 'rgba(255,200,100,0)');
      ctx.globalAlpha = k; ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
    } else if (p.kind === 'shock') {
      const r = p.size * (1 - k);
      ctx.globalAlpha = k * 0.8; ctx.strokeStyle = p.color; ctx.lineWidth = 3 * k + 0.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
}

function drawProjectiles(ctx: CanvasRenderingContext2D, g: GameState) {
  ctx.globalCompositeOperation = 'lighter';
  for (const pr of g.projectiles) {
    if (pr.faction !== 'player' && !isPointVisible(g, pr.x, pr.y)) continue;
    const dx = pr.tx - pr.x, dy = pr.ty - pr.y, l = Math.hypot(dx, dy) || 1;
    const ux = dx / l, uy = dy / l;
    const col = pr.kind === 'arty' ? '#fb923c' : pr.faction === 'player' ? '#7dd3fc' : '#fca5a5';
    const size = pr.kind === 'arty' ? 5 : pr.kind === 'tank' ? 3.8 : 2.3;
    const tail = pr.kind === 'rifle' ? 18 : pr.kind === 'base' ? 15 : 12;

    // параболическая навесная дуга для снарядов артиллерии + целеуказатель точки падения
    let drawY = pr.y;
    if (pr.kind === 'arty') {
      const total = Math.hypot(pr.tx - pr.sx, pr.ty - pr.sy) || 1;
      const prog = clamp(1 - l / total, 0, 1);
      const lift = Math.sin(prog * Math.PI) * 58;
      drawY = pr.y - lift;
      // прицельное кольцо на земле в месте удара
      if (isPointVisible(g, pr.tx, pr.ty)) {
        ctx.strokeStyle = 'rgba(251,146,60,0.42)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(pr.tx, pr.ty, 18 * (1 - prog * 0.5), 0, TAU); ctx.stroke();
      }
      // тень снаряда на земле
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.arc(pr.x, pr.y, 3.5, 0, TAU); ctx.fill();
    }

    const grad = ctx.createLinearGradient(pr.x - ux * tail, drawY - uy * tail, pr.x, drawY);
    grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(1, col);
    ctx.strokeStyle = grad; ctx.lineWidth = size; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(pr.x - ux * tail, drawY - uy * tail); ctx.lineTo(pr.x, drawY); ctx.stroke();

    const gl = ctx.createRadialGradient(pr.x, drawY, 0, pr.x, drawY, size * 3.2);
    gl.addColorStop(0, '#ffffff'); gl.addColorStop(0.32, col); gl.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(pr.x, drawY, size * 3.2, 0, TAU); ctx.fill();
  }
  ctx.lineCap = 'butt';
  ctx.globalCompositeOperation = 'source-over';
}

/* ============================== ГЛАВНЫЙ КАДР ============================== */

const TILE_SIZE = 512;
const terrainTiles = new Map<string, HTMLCanvasElement>();

function terrainTile(map: MapDef, col: number, row: number): HTMLCanvasElement {
  const key = `${map.id}:${col}:${row}`;
  const cached = terrainTiles.get(key);
  if (cached) {
    terrainTiles.delete(key);
    terrainTiles.set(key, cached);
    return cached;
  }
  const x = col * TILE_SIZE, y = row * TILE_SIZE;
  const width = Math.min(TILE_SIZE, MAP_W - x), height = Math.min(TILE_SIZE, MAP_H - y);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(terrain(map), x * TERRAIN_SCALE, y * TERRAIN_SCALE, width * TERRAIN_SCALE, height * TERRAIN_SCALE, 0, 0, width, height);
  ctx.save(); ctx.translate(-x, -y);
  const intersects = (px: number, py: number, r: number) => px + r >= x && px - r <= x + width && py + r >= y && py - r <= y + height;
  for (const p of map.props) if (intersects(p.x, p.y, p.r * 1.6)) drawProp(ctx, p);
  for (const o of map.obstacles) if (intersects(o.x, o.y, o.r * 2)) drawObstacle(ctx, o);
  ctx.restore();
  terrainTiles.set(key, canvas);
  if (terrainTiles.size > 64) terrainTiles.delete(terrainTiles.keys().next().value!);
  return canvas;
}

function drawTerrainView(ctx: CanvasRenderingContext2D, map: MapDef, x: number, y: number) {
  const left = Math.floor(x / TILE_SIZE), right = Math.floor((x + VW - 1) / TILE_SIZE);
  const top = Math.floor(y / TILE_SIZE), bottom = Math.floor((y + VH - 1) / TILE_SIZE);
  for (let row = top; row <= bottom; row++) for (let col = left; col <= right; col++) {
    ctx.drawImage(terrainTile(map, col, row), col * TILE_SIZE, row * TILE_SIZE);
  }
}

export function render(
  ctx: CanvasRenderingContext2D, g: GameState, cam: Pt,
  drag: { x1: number; y1: number; x2: number; y2: number } | null,
  attackMode: boolean, mouse: Pt,
) {
  const t = g.time;
  const fx = THEME_FX[g.map.theme];
  ctx.setTransform(ctx.canvas.width / VW, 0, 0, ctx.canvas.height / VH, 0, 0);
  ctx.fillStyle = '#03060b';
  ctx.fillRect(0, 0, VW, VH);

  // тряска камеры
  const sx = g.shake > 0 ? (Math.random() - 0.5) * g.shake : 0;
  const sy = g.shake > 0 ? (Math.random() - 0.5) * g.shake : 0;
  const cx = clamp(cam.x + sx, 0, MAP_W - VW);
  const cy = clamp(cam.y + sy, 0, MAP_H - VH);

  ctx.save();
  ctx.translate(-cx, -cy);
  const vis = (x: number, y: number, r: number) =>
    x + r > cx - 60 && x - r < cx + VW + 60 && y + r > cy - 60 && y - r < cy + VH + 60;

  // 1. Статичный фон из кеша
  drawTerrainView(ctx, g.map, cx, cy);

  // 2. Следы и воронки, точки захвата, базы
  for (const d of g.decals) if (vis(d.x, d.y, d.r) && (d.kind === 'scorch' || isPointVisible(g, d.x, d.y))) drawDecal(ctx, d);
  for (const p of g.points) if (vis(p.x, p.y, p.r + 40)) drawPoint(ctx, p, t);

  for (const f of g.factions) {
    const b = g.map.bases[f];
    if (vis(b.x, b.y, 250)) drawBase(ctx, g, f, t);
  }

  // 3. Юниты: вражеские рисуются только если находятся в зоне разведки игрока!
  const sorted = g.units
    .filter((u) => vis(u.x, u.y, 30) && (u.faction === 'player' || isPointVisible(g, u.x, u.y)))
    .sort((a, b) => a.y - b.y);
  for (const u of sorted) drawUnit(ctx, g, u, t);

  drawProjectiles(ctx, g);
  drawParticles(ctx, g);

  // 4. ТУМАН ВОЙНЫ И ПЕЛЕНА НЕРАЗВЕДАННОЙ КАРТЫ
  const fogLayer = composeFog(g);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(
    fogLayer,
    cx * F_SCALE_X, cy * F_SCALE_Y, VW * F_SCALE_X, VH * F_SCALE_Y,
    cx, cy, VW, VH,
  );

  // Тонкий тактический контур границы разведки вокруг выбранных юнитов
  for (const u of g.units) {
    if (!g.selected.has(u.id) || !vis(u.x, u.y, 400)) continue;
    const d = UNIT_DEFS[u.kind];
    ctx.strokeStyle = 'rgba(74,222,128,0.22)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(u.x, u.y, d.range, 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(56,189,248,0.16)'; ctx.setLineDash([4, 8]);
    ctx.beginPath(); ctx.arc(u.x, u.y, d.sight * 1.18 * (1 + terrainHeightAt(g.map, u.x, u.y) * 0.1), 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    if (u.pathI < u.path.length) {
      ctx.strokeStyle = 'rgba(74,222,128,0.5)'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 8]);
      ctx.beginPath(); ctx.moveTo(u.x, u.y);
      for (let i = u.pathI; i < u.path.length; i++) ctx.lineTo(u.path[i].x, u.path[i].y);
      ctx.stroke(); ctx.setLineDash([]);
      const last = u.path[u.path.length - 1];
      ctx.fillStyle = 'rgba(74,222,128,0.75)';
      ctx.beginPath(); ctx.arc(last.x, last.y, 4, 0, TAU); ctx.fill();
    }
  }

  // Флаг точки сбора и маркеры приказов — поверх тумана, чтобы командир видел свои приказы
  if (g.selectedBase === 'player') {
    const r = g.rally.player;
    const wave = Math.sin(t * 6) * 2;
    ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(r.x, r.y); ctx.lineTo(r.x, r.y - 28); ctx.stroke();
    ctx.fillStyle = '#4ade80';
    ctx.beginPath(); ctx.moveTo(r.x, r.y - 28); ctx.lineTo(r.x + 16, r.y - 23 + wave); ctx.lineTo(r.x, r.y - 17); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(74,222,128,0.6)'; ctx.beginPath(); ctx.ellipse(r.x, r.y, 8, 5, 0, 0, TAU); ctx.stroke();
  }
  for (const m of g.markers) {
    const p = 1 - m.life / 0.7;
    ctx.strokeStyle = m.attack ? '#ef4444' : '#4ade80'; ctx.lineWidth = 2; ctx.globalAlpha = 1 - p;
    ctx.beginPath(); ctx.ellipse(m.x, m.y, 6 + p * 18, (6 + p * 18) * 0.7, 0, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(m.x, m.y, 3 + p * 8, (3 + p * 8) * 0.7, 0, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Рамка выделения
  if (drag) {
    ctx.fillStyle = 'rgba(74,222,128,0.1)'; ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 1.5;
    const x = Math.min(drag.x1, drag.x2), y = Math.min(drag.y1, drag.y2);
    const w = Math.abs(drag.x2 - drag.x1), h = Math.abs(drag.y2 - drag.y1);
    ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#4ade80';
    for (const [px, py] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) ctx.fillRect(px - 2, py - 2, 4, 4);
  }
  ctx.restore();

  // ---- Экранные атмосферные эффекты ----
  const lg = ctx.createLinearGradient(0, 0, 0, VH);
  lg.addColorStop(0, fx.light); lg.addColorStop(0.5, 'rgba(0,0,0,0)'); lg.addColorStop(1, fx.fog);
  ctx.fillStyle = lg; ctx.fillRect(0, 0, VW, VH);

  ctx.fillStyle = fx.dust;
  for (let i = 0; i < 40; i++) {
    const px = (hash(i, 21) * VW + t * (12 + hash(i, 22) * 30) + Math.sin(t * 0.7 + i) * 15) % VW;
    const py = (hash(i, 23) * VH + t * (6 + hash(i, 24) * 14)) % VH;
    const s = 0.8 + hash(i, 25) * 1.6;
    ctx.beginPath(); ctx.arc(px, py, s, 0, TAU); ctx.fill();
  }

  const vg = ctx.createRadialGradient(VW / 2, VH / 2, VH * 0.45, VW / 2, VH / 2, VW * 0.72);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.52)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, VW, VH);

  ctx.fillStyle = 'rgba(0,0,0,0.05)';
  for (let y = 0; y < VH; y += 4) ctx.fillRect(0, y, VW, 1);

  if (attackMode && mouse.x >= 0) {
    const r = 13 + Math.sin(t * 10) * 2;
    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2; ctx.shadowColor = '#ef4444'; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(mouse.x, mouse.y, r, 0, TAU); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(mouse.x - 22, mouse.y); ctx.lineTo(mouse.x - 6, mouse.y); ctx.moveTo(mouse.x + 6, mouse.y); ctx.lineTo(mouse.x + 22, mouse.y);
    ctx.moveTo(mouse.x, mouse.y - 22); ctx.lineTo(mouse.x, mouse.y - 6); ctx.moveTo(mouse.x, mouse.y + 6); ctx.lineTo(mouse.x, mouse.y + 22);
    ctx.stroke(); ctx.shadowBlur = 0;
  }
}

/* ============================== МИНИКАРТА ============================== */

const minimapTerrain = new Map<string, HTMLCanvasElement>();
function minimapBackground(map: MapDef): HTMLCanvasElement {
  let c = minimapTerrain.get(map.id);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = 640; c.height = 360;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(terrain(map), 0, 0, c.width, c.height);
  for (const o of map.obstacles) {
    ctx.fillStyle = o.kind === 'ice' ? '#a5d7e8' : o.kind === 'tree' ? '#33613b' : o.kind === 'mesa' ? '#a88256' : '#879099';
    const r = Math.max(0.8, o.r * c.width / MAP_W);
    ctx.fillRect(o.x * c.width / MAP_W - r, o.y * c.height / MAP_H - r, r * 2, r * 2);
  }
  minimapTerrain.set(map.id, c);
  return c;
}

export function drawMinimap(ctx: CanvasRenderingContext2D, map: MapDef, g: GameState | null, cam: Pt | null, previewBots = 3) {
  const mw = ctx.canvas.width, mh = ctx.canvas.height;
  const sx = mw / MAP_W, sy = mh / MAP_H;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(minimapBackground(map), 0, 0, mw, mh);
  ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(0, 0, mw, mh);

  // В бою накладываем туман войны и на миникарту: без разведки территория закрыта!
  if (g) {
    const fogLayer = composeFog(g);
    ctx.drawImage(fogLayer, 0, 0, mw, mh);
  }

  const pts: { x: number; y: number; r: number; owner: Faction | null; contested?: boolean; scouted?: boolean }[] = g
    ? g.points.map((p) => ({ ...p, owner: p.knownOwner, contested: p.knownContested }))
    : map.points.map((p) => ({ ...p, owner: null, scouted: true }));
  for (const p of pts) {
    if (g && !p.scouted) continue;
    const col = p.owner ? COL[p.owner].main : '#e2e8f0';
    ctx.fillStyle = p.owner ? COL[p.owner].glow + '0.32)' : 'rgba(226,232,240,0.16)';
    ctx.beginPath(); ctx.arc(p.x * sx, p.y * sy, Math.max(4, p.r * sx), 0, TAU); ctx.fill();
    ctx.strokeStyle = p.contested ? '#fbbf24' : col; ctx.lineWidth = Math.max(1.5, mw / 180);
    ctx.stroke();
  }

  const s = Math.max(6, mw / 50);
  for (const f of g ? g.factions : FACTIONS.slice(0, previewBots + 1)) {
    if (g && f !== 'player' && !g.baseScouted[f]) continue;
    const b = map.bases[f];
    ctx.shadowColor = COL[f].main; ctx.shadowBlur = 6;
    ctx.fillStyle = COL[f].main;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) { const a = i * (TAU / 6); ctx.lineTo(b.x * sx + Math.cos(a) * s, b.y * sy + Math.sin(a) * s); }
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
  }

  if (g) {
    for (const u of g.units) {
      if (u.faction !== 'player' && !isPointVisible(g, u.x, u.y)) continue;
      ctx.fillStyle = COL[u.faction].light;
      const q = u.kind === 'tank' ? 4 : 3;
      ctx.fillRect(u.x * sx - q / 2, u.y * sy - q / 2, q, q);
    }
    ctx.fillStyle = 'rgba(253,224,71,0.9)';
    for (const p of g.particles) {
      if (p.kind === 'flash' && p.size > 12 && isPointVisible(g, p.x, p.y)) {
        ctx.beginPath(); ctx.arc(p.x * sx, p.y * sy, 2.5, 0, TAU); ctx.fill();
      }
    }
  }

  if (cam) {
    ctx.strokeStyle = 'rgba(253,224,71,0.95)'; ctx.lineWidth = 1.5;
    ctx.shadowColor = '#000'; ctx.shadowBlur = 3;
    ctx.strokeRect(cam.x * sx, cam.y * sy, VW * sx, VH * sy);
    ctx.shadowBlur = 0;
  }
}
