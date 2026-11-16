/* Навигация: сетка проходимости, A* и проверка прямой видимости.
   Сетка строится один раз на карту и кешируется. */
import { MAP_W, MAP_H, type Faction, type MapDef, type Pt } from './maps';

export interface NavGrid {
  cell: number;
  cols: number;
  rows: number;
  blocked: Uint8Array;
}

const CELL = 32;
const CLEARANCE = 20; // максимальный радиус юнита + запас
const cache = new Map<string, NavGrid>();

function buildNav(map: MapDef, factions: Faction[]): NavGrid {
  const cols = Math.ceil(MAP_W / CELL);
  const rows = Math.ceil(MAP_H / CELL);
  const blocked = new Uint8Array(cols * rows);
  const markCircle = (x: number, y: number, radius: number) => {
    const r = radius + CLEARANCE;
    const x0 = Math.max(0, Math.floor((x - r) / CELL));
    const x1 = Math.min(cols - 1, Math.floor((x + r) / CELL));
    const y0 = Math.max(0, Math.floor((y - r) / CELL));
    const y1 = Math.min(rows - 1, Math.floor((y + r) / CELL));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (((cx + 0.5) * CELL - x) ** 2 + ((cy + 0.5) * CELL - y) ** 2 < r * r) blocked[cy * cols + cx] = 1;
      }
    }
  };
  for (const o of map.obstacles) markCircle(o.x, o.y, o.r);
  for (const f of factions) markCircle(map.bases[f].x, map.bases[f].y, 52);
  return { cell: CELL, cols, rows, blocked };
}

export function getNav(map: MapDef, factions: Faction[] = ['player', 'enemy']): NavGrid {
  const key = `${map.id}:${factions.join(',')}`;
  let g = cache.get(key);
  if (!g) { g = buildNav(map, factions); cache.set(key, g); }
  return g;
}

function toCell(grid: NavGrid, x: number, y: number) {
  return {
    cx: Math.max(0, Math.min(grid.cols - 1, Math.floor(x / grid.cell))),
    cy: Math.max(0, Math.min(grid.rows - 1, Math.floor(y / grid.cell))),
  };
}
function isFree(grid: NavGrid, cx: number, cy: number) {
  if (cx < 0 || cy < 0 || cx >= grid.cols || cy >= grid.rows) return false;
  return grid.blocked[cy * grid.cols + cx] === 0;
}
function cellCenter(grid: NavGrid, cx: number, cy: number): Pt {
  return { x: (cx + 0.5) * grid.cell, y: (cy + 0.5) * grid.cell };
}

/** Ближайшая свободная клетка (кольцами) */
function nearestFree(grid: NavGrid, x: number, y: number): Pt | null {
  const start = toCell(grid, x, y);
  if (isFree(grid, start.cx, start.cy)) return { x, y };
  for (let r = 1; r <= 10; r++) {
    let best: Pt | null = null;
    let bd = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const cx = start.cx + dx, cy = start.cy + dy;
        if (!isFree(grid, cx, cy)) continue;
        const c = cellCenter(grid, cx, cy);
        const d = (c.x - x) ** 2 + (c.y - y) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
    }
    if (best) return best;
  }
  return null;
}

/* ------------------------------ бинарная куча ------------------------------ */

class Heap {
  private nodes: number[] = [];
  private keys: number[] = [];
  get size() { return this.nodes.length; }
  push(node: number, key: number) {
    const n = this.nodes, k = this.keys;
    n.push(node); k.push(key);
    let i = n.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [n[p], n[i]] = [n[i], n[p]];
      [k[p], k[i]] = [k[i], k[p]];
      i = p;
    }
  }
  pop(): number {
    const n = this.nodes, k = this.keys;
    const top = n[0];
    const lastNode = n.pop()!, lastKey = k.pop()!;
    if (n.length) {
      n[0] = lastNode; k[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < n.length && k[l] < k[m]) m = l;
        if (r < n.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [n[m], n[i]] = [n[i], n[m]];
        [k[m], k[i]] = [k[i], k[m]];
        i = m;
      }
    }
    return top;
  }
}

/* ------------------------------ проверка линии ------------------------------ */

/** Свободна ли прямая между точками (с учётом зазоров сетки) */
export function lineClear(grid: NavGrid, ax: number, ay: number, bx: number, by: number): boolean {
  const d = Math.hypot(bx - ax, by - ay);
  const step = Math.max(8, grid.cell * 0.4);
  const n = Math.ceil(d / step);
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
    const { cx, cy } = toCell(grid, x, y);
    if (!isFree(grid, cx, cy)) return false;
    // проверяем соседние клетки у краёв, чтобы не срезать углы
    const px = x - (cx + 0.5) * grid.cell, py = y - (cy + 0.5) * grid.cell;
    if (Math.abs(px) > grid.cell * 0.28) {
      if (!isFree(grid, cx + Math.sign(px), cy)) return false;
    }
    if (Math.abs(py) > grid.cell * 0.28) {
      if (!isFree(grid, cx, cy + Math.sign(py))) return false;
    }
  }
  return true;
}

/* ------------------------------ A* ------------------------------ */

const DIAG = Math.SQRT2;
const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, DIAG], [1, -1, DIAG], [-1, 1, DIAG], [-1, -1, DIAG],
];

/**
 * Путь от точки до точки по свободным клеткам.
 * Возвращает сглаженные путевые точки (без стартовой) или null, если пути нет.
 */
export function findPath(grid: NavGrid, sx: number, sy: number, gx: number, gy: number): Pt[] | null {
  const startFree = nearestFree(grid, sx, sy);
  const goalFree = nearestFree(grid, gx, gy);
  if (!startFree || !goalFree) return null;
  const s = toCell(grid, startFree.x, startFree.y);
  const goal = toCell(grid, goalFree.x, goalFree.y);
  if (s.cx === goal.cx && s.cy === goal.cy) return [goalFree];

  const N = grid.cols * grid.rows;
  const gScore = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const h = (cx: number, cy: number) => {
    const dx = Math.abs(cx - goal.cx), dy = Math.abs(cy - goal.cy);
    return dx + dy + (DIAG - 2) * Math.min(dx, dy);
  };
  const startIdx = s.cy * grid.cols + s.cx;
  const goalIdx = goal.cy * grid.cols + goal.cx;
  gScore[startIdx] = 0;
  const heap = new Heap();
  heap.push(startIdx, h(s.cx, s.cy));
  let found = false;
  let expansions = 0;
  const maxExpand = grid.cols * grid.rows;

  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goalIdx) { found = true; break; }
    if (++expansions > maxExpand) break;
    const cx = cur % grid.cols, cy = (cur - cx) / grid.cols;
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!isFree(grid, nx, ny)) continue;
      // запрещаем срезать углы по диагонали
      if (dx !== 0 && dy !== 0 && (!isFree(grid, cx + dx, cy) || !isFree(grid, cx, cy + dy))) continue;
      const ni = ny * grid.cols + nx;
      if (closed[ni]) continue;
      const tentative = gScore[cur] + cost;
      if (tentative < gScore[ni]) {
        gScore[ni] = tentative;
        came[ni] = cur;
        heap.push(ni, tentative + h(nx, ny) * 1.02);
      }
    }
  }
  if (!found) return null;

  // восстановление пути
  const raw: Pt[] = [];
  let cur = goalIdx;
  while (cur !== -1 && cur !== startIdx) {
    const cx = cur % grid.cols, cy = (cur - cx) / grid.cols;
    raw.push(cellCenter(grid, cx, cy));
    cur = came[cur];
  }
  raw.reverse();
  if (!raw.length) return [goalFree];
  // конечную точку заменяем на желаемую, если она свободна
  if (lineClear(grid, raw[raw.length - 1].x, raw[raw.length - 1].y, gx, gy)) raw.push({ x: gx, y: gy });

  // сглаживание: выкидываем промежуточные точки, где прямая свободна
  const smooth: Pt[] = [];
  let from = { x: sx, y: sy };
  let i = 0;
  while (i < raw.length) {
    let far = i;
    for (let j = raw.length - 1; j > i; j--) {
      if (lineClear(grid, from.x, from.y, raw[j].x, raw[j].y)) { far = j; break; }
    }
    smooth.push(raw[far]);
    from = raw[far];
    i = far + 1;
  }
  return smooth.length ? smooth : [goalFree];
}
