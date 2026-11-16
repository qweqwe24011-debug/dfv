import { useEffect, useRef, useState } from 'react';
import {
  Bot, ChevronRight, Coins, Crosshair, Crown, Eye, Flag, Flame, Gauge, Heart, HelpCircle, Info, Map as MapIcon,
  MousePointer2, Music, Octagon, Pause, Play, Radio, Rocket, RotateCcw, Shield, Skull, Snowflake, Sun, Swords,
  Timer, Trees, Trophy, Users, Volume2, VolumeX, X, Zap,
} from 'lucide-react';
import { audio, MODE_LABEL, type MusicMode } from './audio';
import { MAPS, MAP_W, MAP_H, FACTION_NAMES, terrainHeightAt, type BotCount, type BotFaction, type Faction, type MapDef, type Pt } from './maps';
import {
  VW, VH, EDGE, UNIT_DEFS, DIFFS, createGame, updateGame, tryBuild, incomeOf, formationOffset, dist, clamp, fmtTime,
  pushMsg, isPointVisible, isPointExplored, exploredPercent, FOG_CELL, FOG_COLS, FOG_ROWS,
  type BuildItem, type Difficulty, type GameState, type GameStatus, type Msg, type TargetRef, type UnitKind,
} from './game';
import { render, drawMinimap } from './render';

const KIND_ICON: Record<UnitKind, typeof Zap> = { rifle: Zap, tank: Shield, arty: Rocket };
const THEME_ICON = { ash: Flame, frost: Snowflake, desert: Sun, forest: Trees } as const;
const BOT_COLORS: Record<BotFaction, string> = { enemy: '#f87171', enemy2: '#fb923c', enemy3: '#c084fc' };

interface Snapshot {
  status: GameStatus; time: number; credits: number; income: number;
  playerHp: number; baseMax: number; playerCount: number; visibleEnemyCount: number;
  queue: BuildItem[]; selectedCount: number; selectedByKind: Record<UnitKind, number>;
  selectedHp: number; selectedMax: number; selectedBase: boolean;
  points: { id: string; owner: Faction | null; scouted: boolean }[]; messages: Msg[];
  kills: number; losses: number; built: number; difficulty: Difficulty; mapId: string; mapName: string;
  musicMode: MusicMode; audioUnlocked: boolean;
  reconPct: number; botCount: BotCount;
  bots: { id: BotFaction; hp: number | null; eliminated: boolean }[];
}

function snapshotOf(g: GameState): Snapshot {
  const sel = g.units.filter((u) => g.selected.has(u.id) && u.faction === 'player');
  const by: Record<UnitKind, number> = { rifle: 0, tank: 0, arty: 0 };
  sel.forEach((u) => { by[u.kind]++; });
  return {
    status: g.status, time: g.time, credits: Math.floor(g.credits.player), income: incomeOf(g, 'player'),
    playerHp: Math.ceil(g.baseHp.player), baseMax: g.baseMax,
    playerCount: g.units.filter((u) => u.faction === 'player').length,
    visibleEnemyCount: g.units.filter((u) => u.faction !== 'player' && isPointVisible(g, u.x, u.y)).length,
    queue: [...g.queue.player], selectedCount: sel.length, selectedByKind: by,
    selectedHp: Math.round(sel.reduce((s, u) => s + u.hp, 0)), selectedMax: sel.reduce((s, u) => s + u.maxHp, 0),
    selectedBase: g.selectedBase === 'player',
    points: g.points.map((p) => ({ id: p.id, owner: p.knownOwner, scouted: p.scouted })),
    messages: [...g.messages], kills: g.stats.kills, losses: g.stats.losses, built: g.stats.built,
    difficulty: g.difficulty, mapId: g.mapId, mapName: g.map.name,
    musicMode: audio.mode, audioUnlocked: audio.unlocked,
    reconPct: exploredPercent(g), botCount: g.botCount,
    bots: g.bots.map((id) => ({ id, hp: g.baseScouted[id] ? Math.ceil(g.knownBaseHp[id]) : null, eliminated: g.baseHp[id] <= 0 })),
  };
}

/** Анимированные столбики — индикатор, что музыка играет */
function Equalizer({ active, className = '' }: { active: boolean; className?: string }) {
  return (
    <span className={`flex h-3.5 items-end gap-[2px] ${className}`} aria-hidden>
      {[0.55, 0.8, 0.65, 0.9, 0.7].map((d, i) => (
        <span
          key={i}
          className="w-[3px] origin-bottom rounded-sm bg-emerald-400"
          style={{
            height: '100%',
            animation: active ? `eq ${d}s ease-in-out ${i * 0.09}s infinite alternate` : 'none',
            transform: active ? undefined : 'scaleY(0.2)',
          }}
        />
      ))}
    </span>
  );
}

/** Превью карты в меню — та же миникарта, нарисованная статично */
function MapPreview({ map, botCount }: { map: MapDef; botCount: BotCount }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (ctx) drawMinimap(ctx, map, null, null, botCount);
  }, [map, botCount]);
  return <canvas ref={ref} width={320} height={180} className="block h-auto w-full" />;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<GameState>(null!);
  if (!gameRef.current) gameRef.current = createGame('normal', 'ash');
  const dragRef = useRef<{ x1: number; y1: number; x2: number; y2: number; active: boolean; additive: boolean } | null>(null);
  const mouseRef = useRef<Pt>({ x: -1, y: -1 });
  const attackRef = useRef(false);
  const camRef = useRef<Pt>({ x: 0, y: 0 });
  const keysRef = useRef(new Set<string>());
  const miniDragRef = useRef(false);
  const battleUntilRef = useRef(0);
  const prevStatusRef = useRef<GameStatus>('menu');

  const [attackMode, setAttackModeState] = useState(false);
  const [chosenDiff, setChosenDiff] = useState<Difficulty>('normal');
  const [chosenMap, setChosenMap] = useState<string>('ash');
  const [chosenBots, setChosenBots] = useState<BotCount>(1);
  const [hoverHeight, setHoverHeight] = useState<number | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [soundPanel, setSoundPanel] = useState(false);
  const [sound, setSound] = useState({ muted: audio.muted, music: audio.musicVol, sfx: audio.sfxVol });
  const [hud, setHud] = useState<Snapshot>(() => snapshotOf(gameRef.current));

  /* ------------------------------ камера ------------------------------ */

  const clampCam = () => {
    const c = camRef.current;
    c.x = clamp(c.x, 0, MAP_W - VW);
    c.y = clamp(c.y, 0, MAP_H - VH);
  };
  const centerCam = (p: Pt) => {
    camRef.current = { x: p.x - VW / 2, y: p.y - VH / 2 };
    clampCam();
  };
  const moveCamera = (dt: number) => {
    let dx = 0, dy = 0;
    const keys = keysRef.current;
    if (keys.has('ArrowLeft')) dx -= 1;
    if (keys.has('ArrowRight')) dx += 1;
    if (keys.has('ArrowUp')) dy -= 1;
    if (keys.has('ArrowDown')) dy += 1;
    const m = mouseRef.current;
    if (m.x >= 0 && m.x <= VW && m.y >= 0 && m.y <= VH) {
      if (m.x < EDGE) dx -= 1; else if (m.x > VW - EDGE) dx += 1;
      if (m.y < EDGE) dy -= 1; else if (m.y > VH - EDGE) dy += 1;
    }
    if (dx || dy) {
      const l = Math.hypot(dx, dy);
      const sp = 1000 * dt;
      camRef.current.x += (dx / l) * sp;
      camRef.current.y += (dy / l) * sp;
      clampCam();
    }
  };

  /* ------------------------------ звук ------------------------------ */

  const toggleMute = () => { audio.unlock(); audio.toggleMuted(); setSound((s) => ({ ...s, muted: audio.muted })); };
  const setMusic = (v: number) => { audio.unlock(); audio.setMusicVol(v); setSound((s) => ({ ...s, music: v })); };
  const setSfx = (v: number) => { audio.unlock(); audio.setSfxVol(v); setSound((s) => ({ ...s, sfx: v })); audio.select(); };

  /** Подстраивает музыку под бой: накал, пауза, финальные фанфары */
  const syncMusic = (g: GameState) => {
    if (g.status !== prevStatusRef.current) {
      if (g.status === 'victory' || g.status === 'defeat') { audio.stinger(g.status); audio.setMode('menu'); }
      prevStatusRef.current = g.status;
    }
    if (g.status === 'playing' || g.status === 'paused') {
      const fighters = g.units.reduce((n, u) => n + (u.target ? 1 : 0), 0);
      const raw = clamp(fighters / 7 + g.projectiles.length / 14, 0, 1);
      audio.setIntensity(raw);
      if (raw > 0.3) battleUntilRef.current = g.time + 8;
      audio.setMode(g.time < battleUntilRef.current ? 'battle' : 'calm');
      audio.setDucked(g.status === 'paused');
    } else {
      audio.setDucked(false);
      if (g.status === 'menu') audio.setMode('menu');
    }
  };

  /* ------------------------------ управление партией ------------------------------ */

  const setAttackMode = (v: boolean) => {
    attackRef.current = v;
    setAttackModeState(v);
    if (v) audio.click();
  };

  const startGame = (diff: Difficulty, mapId: string, botCount: BotCount) => {
    const g = createGame(diff, mapId, botCount);
    g.status = 'playing';
    gameRef.current = g;
    centerCam(g.map.bases.player);
    dragRef.current = null;
    battleUntilRef.current = 0;
    prevStatusRef.current = 'playing';
    audio.unlock();
    audio.onGameStart();
    setAttackMode(false);
    setHud(snapshotOf(g));
  };

  const toMenu = () => {
    const g = createGame(chosenDiff, chosenMap, chosenBots);
    gameRef.current = g;
    prevStatusRef.current = 'menu';
    dragRef.current = null;
    setAttackMode(false);
    setHud(snapshotOf(g));
  };

  const togglePause = () => {
    const g = gameRef.current;
    if (g.status === 'playing') g.status = 'paused';
    else if (g.status === 'paused') g.status = 'playing';
    audio.click();
    setHud(snapshotOf(g));
  };

  const selectedUnits = () => gameRef.current.units.filter((u) => gameRef.current.selected.has(u.id) && u.faction === 'player');

  const issueOrder = (x: number, y: number, mode: 'move' | 'attackmove', target: TargetRef) => {
    const g = gameRef.current;
    const units = selectedUnits();
    units.forEach((u, i) => {
      const off = formationOffset(i, units.length);
      u.tx = clamp(x + off.x, 20, MAP_W - 20);
      u.ty = clamp(y + off.y, 20, MAP_H - 20);
      u.mode = target ? 'attack' : mode;
      u.target = target;
      // новый приказ — сбрасываем старый маршрут, навигация построит актуальный
      u.path = []; u.pathI = 0; u.pathGoal = null; u.pathAt = 0; u.stuck = 0;
    });
    g.markers.push({ x, y, life: 0.7, color: '', attack: !!target || mode === 'attackmove' });
    if (units.length) audio.order(!!target || mode === 'attackmove');
  };

  const stopSelected = () => {
    selectedUnits().forEach((u) => {
      u.mode = 'idle'; u.target = null; u.tx = u.x; u.ty = u.y;
      u.path = []; u.pathI = 0; u.pathGoal = null;
    });
    audio.click();
  };

  const selectAllArmy = () => {
    const g = gameRef.current;
    g.selected = new Set(g.units.filter((u) => u.faction === 'player').map((u) => u.id));
    g.selectedBase = null;
    setHud(snapshotOf(g));
  };

  const build = (kind: UnitKind) => {
    if (tryBuild(gameRef.current, 'player', kind)) { audio.click(); setHud(snapshotOf(gameRef.current)); }
    else audio.error();
  };

  const retreat = () => {
    const b = gameRef.current.map.bases.player;
    issueOrder(b.x + 120, b.y, 'attackmove', null);
  };

  /** Отправляет выбранный отряд (или свободного штурмовика) разведывать ближайшую неисследованную зону */
  const sendToScout = () => {
    const g = gameRef.current;
    let squad = selectedUnits();
    if (!squad.length) {
      const own = g.units.filter((u) => u.faction === 'player');
      const fast = own.find((u) => u.kind === 'rifle' && u.mode === 'idle') ?? own[0];
      if (!fast) return;
      g.selected = new Set([fast.id]);
      g.selectedBase = null;
      squad = [fast];
    }
    const cx = squad.reduce((s, u) => s + u.x, 0) / squad.length;
    const cy = squad.reduce((s, u) => s + u.y, 0) / squad.length;
    // сначала ищем неразведанную контрольную точку, иначе ближайшую неразведанную клетку
    const unscoutedPt = g.points
      .filter((p) => !p.scouted)
      .sort((a, b) => dist(cx, cy, a.x, a.y) - dist(cx, cy, b.x, b.y))[0];
    if (unscoutedPt) {
      issueOrder(unscoutedPt.x, unscoutedPt.y, 'attackmove', null);
      pushMsg(g, 'Отряд отправлен в разведку неисследованного сектора.', 'info');
      setHud(snapshotOf(g));
      return;
    }
    let bestX = g.map.bases.enemy.x, bestY = g.map.bases.enemy.y, bestD = Infinity;
    for (let ry = 2; ry < FOG_ROWS - 2; ry += 3) {
      for (let rx = 2; rx < FOG_COLS - 2; rx += 3) {
        if (g.explored[ry * FOG_COLS + rx] === 0) {
          const px = (rx + 0.5) * FOG_CELL, py = (ry + 0.5) * FOG_CELL;
          const d = dist(cx, cy, px, py);
          if (d < bestD) { bestD = d; bestX = px; bestY = py; }
        }
      }
    }
    issueOrder(bestX, bestY, 'attackmove', null);
    pushMsg(g, 'Отряд отправлен на разведку территории.', 'info');
    setHud(snapshotOf(g));
  };

  /* ------------------------------ координаты и мышь ------------------------------ */

  /** Координаты внутри холста (0..VW, 0..VH) */
  const canvasPos = (e: { clientX: number; clientY: number }): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * VW, y: ((e.clientY - r.top) / r.height) * VH };
  };
  const worldOf = (c: Pt): Pt => ({ x: c.x + camRef.current.x, y: c.y + camRef.current.y });
  const miniToWorld = (e: { clientX: number; clientY: number }): Pt => {
    const r = minimapRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * MAP_W, y: ((e.clientY - r.top) / r.height) * MAP_H };
  };

  const onMiniDown = (e: React.MouseEvent) => {
    const p = miniToWorld(e);
    if (e.button === 0) { miniDragRef.current = true; centerCam(p); }
    else if (e.button === 2 && gameRef.current.status === 'playing') issueOrder(p.x, p.y, 'move', null);
  };
  const onMiniMove = (e: React.MouseEvent) => {
    if (miniDragRef.current) centerCam(miniToWorld(e));
  };

  const onMouseDown = (e: React.MouseEvent) => {
    const g = gameRef.current;
    if (g.status !== 'playing') return;
    const p = worldOf(canvasPos(e));
    if (e.button === 0) {
      if (attackRef.current && g.selected.size) {
        const foe = g.units.find((u) => u.faction !== 'player' && isPointVisible(g, u.x, u.y) && dist(p.x, p.y, u.x, u.y) < UNIT_DEFS[u.kind].radius + 8);
        const foeBase = g.bots.find((f) => g.baseScouted[f] && g.baseHp[f] > 0 && dist(p.x, p.y, g.map.bases[f].x, g.map.bases[f].y) < 56);
        issueOrder(p.x, p.y, 'attackmove', foe ? { type: 'unit', id: foe.id } : foeBase ? { type: 'base', faction: foeBase } : null);
        setAttackMode(false);
        return;
      }
      dragRef.current = { x1: p.x, y1: p.y, x2: p.x, y2: p.y, active: true, additive: e.shiftKey };
    } else if (e.button === 2) {
      if (g.selectedBase === 'player') {
        g.rally.player = { x: p.x, y: p.y };
        g.markers.push({ x: p.x, y: p.y, life: 0.7, color: '', attack: false });
        pushMsg(g, 'Точка сбора установлена. Новые юниты пойдут туда.', 'info');
        audio.order(false);
        return;
      }
      if (!g.selected.size) return;
      const foe = g.units
        .filter((u) => u.faction !== 'player' && isPointVisible(g, u.x, u.y) && dist(p.x, p.y, u.x, u.y) < UNIT_DEFS[u.kind].radius + 10)
        .sort((a, b) => dist(p.x, p.y, a.x, a.y) - dist(p.x, p.y, b.x, b.y))[0];
      const foeBase = g.bots.find((f) => g.baseScouted[f] && g.baseHp[f] > 0 && dist(p.x, p.y, g.map.bases[f].x, g.map.bases[f].y) < 58);
      issueOrder(p.x, p.y, 'move', foe ? { type: 'unit', id: foe.id } : foeBase ? { type: 'base', faction: foeBase } : null);
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const c = canvasPos(e);
    mouseRef.current = c;
    const world = worldOf(c);
    const g = gameRef.current;
    setHoverHeight(isPointExplored(g, world.x, world.y) ? terrainHeightAt(g.map, world.x, world.y) : null);
    const dr = dragRef.current;
    if (dr?.active) {
      const p = worldOf(c);
      dr.x2 = p.x;
      dr.y2 = p.y;
    }
  };

  const onMouseUp = (e: React.MouseEvent) => {
    const g = gameRef.current;
    if (e.button !== 0 || !dragRef.current) return;
    const dr = dragRef.current;
    dragRef.current = null;
    if (g.status !== 'playing') return;
    const moved = Math.hypot(dr.x2 - dr.x1, dr.y2 - dr.y1);
    if (moved > 9) {
      const x1 = Math.min(dr.x1, dr.x2), x2 = Math.max(dr.x1, dr.x2);
      const y1 = Math.min(dr.y1, dr.y2), y2 = Math.max(dr.y1, dr.y2);
      const inside = g.units.filter((u) => u.faction === 'player' && u.x >= x1 && u.x <= x2 && u.y >= y1 && u.y <= y2);
      if (!dr.additive) g.selected.clear();
      inside.forEach((u) => g.selected.add(u.id));
      if (inside.length) { g.selectedBase = null; audio.select(); }
    } else {
      const p = { x: dr.x2, y: dr.y2 };
      const own = g.units
        .filter((u) => u.faction === 'player' && dist(p.x, p.y, u.x, u.y) < UNIT_DEFS[u.kind].radius + 8)
        .sort((a, b) => dist(p.x, p.y, a.x, a.y) - dist(p.x, p.y, b.x, b.y))[0];
      if (!dr.additive) { g.selected.clear(); g.selectedBase = null; }
      const pb = g.map.bases.player;
      if (own) { g.selected.add(own.id); g.selectedBase = null; audio.select(); }
      else if (dist(p.x, p.y, pb.x, pb.y) < 56) { g.selectedBase = 'player'; audio.select(); }
    }
    setHud(snapshotOf(g));
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const g = gameRef.current;
    const p = worldOf(canvasPos(e));
    const own = g.units.find((u) => u.faction === 'player' && dist(p.x, p.y, u.x, u.y) < UNIT_DEFS[u.kind].radius + 8);
    if (own) {
      g.selected = new Set(g.units.filter((u) => u.faction === 'player' && u.kind === own.kind).map((u) => u.id));
      g.selectedBase = null;
      setHud(snapshotOf(g));
    }
  };

  /* ------------------------------ эффекты и циклы ------------------------------ */

  // разблокировка аудио по первому жесту пользователя
  useEffect(() => {
    const unlock = () => {
      audio.unlock();
      setHud((h) => ({ ...h, audioUnlocked: audio.unlocked }));
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, []);

  // отпускание кнопки мыши где угодно — завершает перетаскивание миникарты
  useEffect(() => {
    const up = () => { miniDragRef.current = false; };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  // главный цикл: симуляция, звук, камера, отрисовка
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const g = gameRef.current;
      updateGame(g, dt);
      const listenX = camRef.current.x + VW / 2;
      for (const ev of g.sounds) {
        // звуки панорамируются относительно центра видимой области
        audio.handle('x' in ev ? { ...ev, x: MAP_W / 2 + (ev.x - listenX) * (MAP_W / VW) } : ev);
      }
      g.sounds.length = 0;
      syncMusic(g);
      moveCamera(dt);
      const canvas = canvasRef.current;
      if (canvas && canvas.clientWidth) {
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.25);
        const width = clamp(Math.round(canvas.clientWidth * pixelRatio / 16) * 16, 640, VW);
        const height = Math.round(width * VH / VW);
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      }
      const ctx = canvas?.getContext('2d', { alpha: false });
      if (ctx) {
        const dr = dragRef.current?.active ? dragRef.current : null;
        render(ctx, g, camRef.current, dr ? { x1: dr.x1, y1: dr.y1, x2: dr.x2, y2: dr.y2 } : null, attackRef.current, mouseRef.current);
      }
      const mm = minimapRef.current?.getContext('2d');
      if (mm) drawMinimap(mm, g.map, g, camRef.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const iv = window.setInterval(() => setHud(snapshotOf(gameRef.current)), 130);
    return () => { cancelAnimationFrame(raf); clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // клавиатура
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const g = gameRef.current;
      const k = e.key.toLowerCase();
      if (e.key.startsWith('Arrow')) { keysRef.current.add(e.key); e.preventDefault(); return; }
      if (k === ' ') e.preventDefault();
      if (e.repeat) return;
      if (k === 'm' || k === 'ь') { toggleMute(); return; }
      if (g.status !== 'playing' && g.status !== 'paused') return;
      if (k === '1' || k === '2' || k === '3') {
        const kind: UnitKind = k === '1' ? 'rifle' : k === '2' ? 'tank' : 'arty';
        if (tryBuild(g, 'player', kind)) { audio.click(); setHud(snapshotOf(g)); } else audio.error();
      } else if (k === 'a' && g.selected.size) setAttackMode(true);
      else if (k === 's') stopSelected();
      else if (k === 'r' || k === 'к') sendToScout();
      else if (k === 'h') centerCam(g.map.bases.player);
      else if (k === ' ') togglePause();
      else if (k === 'escape') setAttackMode(false);
    };
    const onUp = (e: KeyboardEvent) => { keysRef.current.delete(e.key); };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inGame = hud.status !== 'menu';

  return (
    <div className="flex h-screen select-none flex-col overflow-hidden bg-[#0a0f0a] text-slate-100" style={{ fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif' }}>
      {/* ===== ШАПКА ===== */}
      <header className="relative z-30 flex h-14 shrink-0 items-center gap-3 border-b border-white/10 bg-[#0d130c] px-3">
        <div className="flex shrink-0 items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-600">
            <Swords className="h-5 w-5 text-white" />
          </div>
          <div className="leading-tight">
            <div className="text-[15px] font-extrabold tracking-wide">FRONTLINE</div>
            <div className="text-[11px] text-slate-400">{inGame ? hud.mapName : 'RTS • 4 карты • бот-командир'}</div>
          </div>
        </div>

        {inGame && (
          <div className="mx-auto hidden min-w-0 max-w-xl flex-1 items-center gap-2 px-2 md:flex">
            <span className="whitespace-nowrap text-xs font-bold text-sky-300">АЛЬЯНС {hud.playerHp}</span>
            <div className="h-3 flex-1 overflow-hidden rounded bg-white/10">
              <div className="h-full bg-sky-400 transition-all" style={{ width: `${(hud.playerHp / hud.baseMax) * 100}%` }} />
            </div>
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] font-bold text-slate-300">{fmtTime(hud.time)}</span>
            <span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-wide text-slate-500">Базы ботов</span>
            <div className="flex items-center gap-1">
              {hud.bots.map((bot, i) => (
                <span key={bot.id} title={`${FACTION_NAMES[bot.id]}: ${bot.hp === null ? 'не разведан' : `${bot.hp} HP`}`} className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] font-bold" style={{ color: BOT_COLORS[bot.id] }}>
                  {i + 1}: {bot.hp === null ? '?' : bot.eliminated ? '0' : bot.hp}
                </span>
              ))}
            </div>
          </div>
        )}
        {!inGame && <div className="flex-1" />}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {inGame && (
            <>
              <div className="flex items-center gap-1.5 rounded-lg bg-amber-400/10 px-2.5 py-1.5 text-amber-300" title="Кредиты и доход">
                <Coins className="h-4 w-4" />
                <span className="text-sm font-extrabold">{hud.credits}</span>
                <span className="hidden text-[11px] text-amber-200/70 sm:inline">+{hud.income.toFixed(0)}/с</span>
              </div>
              <div className="hidden items-center gap-1.5 rounded-lg bg-sky-400/10 px-2.5 py-1.5 text-sky-300 md:flex" title="Разведанная площадь карты">
                <Eye className="h-4 w-4" />
                <span className="text-xs font-extrabold">{hud.reconPct}%</span>
              </div>
              <div className="hidden items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1.5 text-slate-300 md:flex" title="Ваши юниты / замеченные разведкой враги">
                <Users className="h-4 w-4" />
                <span className="text-sm font-bold">{hud.playerCount}</span>
                <span className="text-slate-500">:</span>
                <span className="text-sm font-bold text-red-300">{hud.visibleEnemyCount}</span>
              </div>
              <div className="hidden items-center gap-1 rounded-lg bg-white/5 px-2 py-1.5 text-[11px] text-slate-300 2xl:flex">
                {hud.points.map((p) => (
                  <span
                    key={p.id}
                    title={p.scouted ? `Точка ${p.id}` : `Точка ${p.id} (не разведана)`}
                    className={`rounded px-1.5 py-0.5 font-bold ${
                      !p.scouted ? 'bg-white/5 text-slate-600' : p.owner === 'player' ? 'bg-sky-500/20 text-sky-300' : p.owner ? 'bg-red-500/20 text-red-300' : 'bg-white/10 text-slate-300'
                    }`}
                  >
                    {p.scouted ? p.id : '?'}
                  </span>
                ))}
              </div>
            </>
          )}

          {/* музыка и звук */}
          <div className="relative">
            <button
              onClick={() => { audio.unlock(); setSoundPanel((v) => !v); }}
              className={`flex h-8 items-center gap-1.5 rounded-lg px-2 transition hover:bg-white/10 ${soundPanel ? 'bg-white/15 text-white' : 'bg-white/5 text-slate-300'}`}
              title="Музыка и звук (M — выключить звук)"
            >
              {sound.muted ? <VolumeX className="h-4 w-4 text-red-300" /> : <Volume2 className="h-4 w-4" />}
              <Equalizer active={!sound.muted && hud.audioUnlocked} className="hidden sm:flex" />
              <span className="hidden text-[11px] font-semibold xl:inline">{sound.muted ? 'Без звука' : MODE_LABEL[hud.musicMode]}</span>
            </button>
            {soundPanel && (
              <div className="absolute right-0 top-10 z-50 w-[290px] rounded-xl border border-white/15 bg-slate-950/97 p-4 shadow-2xl">
                <div className="mb-3 flex items-center justify-between">
                  <b className="flex items-center gap-1.5 text-sm"><Music className="h-4 w-4 text-emerald-400" /> Музыка и звук</b>
                  <button onClick={() => setSoundPanel(false)} title="Закрыть"><X className="h-4 w-4 text-slate-400 hover:text-white" /></button>
                </div>
                <label className="mb-3 block">
                  <div className="mb-1 flex justify-between text-[11px] font-semibold text-slate-300">
                    <span className="flex items-center gap-1"><Music className="h-3.5 w-3.5 text-slate-400" /> Музыка</span>
                    <span>{Math.round(sound.music * 100)}%</span>
                  </div>
                  <input type="range" min={0} max={100} value={Math.round(sound.music * 100)} onChange={(e) => setMusic(Number(e.target.value) / 100)} className="w-full accent-emerald-500" />
                </label>
                <label className="mb-3 block">
                  <div className="mb-1 flex justify-between text-[11px] font-semibold text-slate-300">
                    <span className="flex items-center gap-1"><Volume2 className="h-3.5 w-3.5 text-slate-400" /> Эффекты боя</span>
                    <span>{Math.round(sound.sfx * 100)}%</span>
                  </div>
                  <input type="range" min={0} max={100} value={Math.round(sound.sfx * 100)} onChange={(e) => setSfx(Number(e.target.value) / 100)} className="w-full accent-emerald-500" />
                </label>
                <button
                  onClick={toggleMute}
                  className={`mb-3 flex w-full items-center justify-center gap-2 rounded-lg py-2 text-[13px] font-bold transition ${sound.muted ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-white/10 text-slate-200 hover:bg-white/15'}`}
                >
                  {sound.muted ? <><Volume2 className="h-4 w-4" /> Включить звук</> : <><VolumeX className="h-4 w-4" /> Выключить звук (M)</>}
                </button>
                <div className="flex items-center gap-2 rounded-lg bg-white/5 px-2.5 py-2 text-[11px] text-slate-300">
                  <Equalizer active={!sound.muted && hud.audioUnlocked} />
                  <span>Сейчас играет: <b className="text-white">{sound.muted ? 'тишина' : !hud.audioUnlocked ? 'ожидание клика' : MODE_LABEL[hud.musicMode]}</b></span>
                </div>
              </div>
            )}
          </div>

          <button onClick={() => setShowHelp((v) => !v)} className="hidden h-8 w-8 items-center justify-center rounded-lg bg-white/5 text-slate-300 hover:bg-white/10 sm:flex" title="Справка">
            <HelpCircle className="h-4 w-4" />
          </button>
          {inGame && (
            <>
              <button onClick={togglePause} className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/5 text-slate-200 hover:bg-white/10" title="Пауза (Пробел)">
                {hud.status === 'paused' ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              </button>
              <button onClick={() => startGame(hud.difficulty, hud.mapId, hud.botCount)} className="hidden h-8 w-8 items-center justify-center rounded-lg bg-white/5 text-slate-200 hover:bg-white/10 md:flex" title="Начать заново">
                <RotateCcw className="h-4 w-4" />
              </button>
              <button onClick={toMenu} className="flex h-8 items-center gap-1 rounded-lg bg-white/5 px-2.5 text-[12px] font-bold text-slate-200 hover:bg-white/10" title="Главное меню">
                <MapIcon className="h-4 w-4" /> <span className="hidden sm:inline">Меню</span>
              </button>
            </>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-3 p-3 max-md:flex-col max-md:overflow-y-auto">
        {/* ===== ПАНЕЛЬ УПРАВЛЕНИЯ (СЛЕВА) ===== */}
        <aside className="flex min-h-0 w-[300px] shrink-0 flex-col gap-3 overflow-y-auto pr-0.5 thin-scroll max-md:order-2 max-md:w-full max-md:overflow-visible">
          <section className="rounded-xl border border-white/10 hud-panel p-2.5">
            <div className="mb-1.5 flex items-center justify-between px-0.5">
              <span className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-slate-400"><Radio className="h-3.5 w-3.5 text-emerald-400" /> Радар • {hud.reconPct}%</span>
              <span className="truncate pl-2 text-[10px] text-slate-500">{hud.mapName}</span>
            </div>
            <canvas
              ref={minimapRef} width={240} height={135}
              className="block w-full cursor-pointer rounded-lg border border-white/10"
              onMouseDown={onMiniDown} onMouseMove={onMiniMove}
              onContextMenu={(e) => e.preventDefault()}
            />
            <div className="mt-1.5 flex justify-between px-0.5 text-[10px] text-slate-500">
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-sky-400" /> Альянс</span>
              <span>Туман войны без разведки</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-red-500" /> Боты: {hud.botCount}</span>
            </div>
          </section>

          <section className="rounded-xl border border-white/10 hud-panel p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Производство</span>
              <span className="flex items-center gap-1">
                {Array.from({ length: 5 }).map((_, i) => {
                  const q = hud.queue[i];
                  const Icon = q ? KIND_ICON[q.kind] : null;
                  return (
                    <span key={i} className={`flex h-5 w-5 items-center justify-center rounded ${q ? 'bg-amber-400/20 text-amber-300' : 'bg-white/5 text-slate-600'}`}>
                      {Icon ? <Icon className="h-3 w-3" /> : '·'}
                    </span>
                  );
                })}
                {hud.queue.length > 0 && <span className="ml-1 text-[11px] font-bold text-amber-300">{Math.ceil(hud.queue[0].remaining)}с</span>}
              </span>
            </div>
            <div className="space-y-2">
              {(Object.keys(UNIT_DEFS) as UnitKind[]).map((kind, idx) => {
                const d = UNIT_DEFS[kind];
                const Icon = KIND_ICON[kind];
                const afford = hud.credits >= d.cost;
                const queueFull = hud.queue.length >= 5;
                const disabled = hud.status !== 'playing' || !afford || queueFull;
                return (
                  <button
                    key={kind} onClick={() => build(kind)} disabled={disabled}
                    className={`flex w-full items-center gap-2.5 rounded-lg border p-2 text-left transition ${
                      disabled ? 'cursor-not-allowed border-white/8 bg-white/[0.03] opacity-55' : 'border-white/12 bg-white/5 hover:border-emerald-400/50 hover:bg-emerald-500/10'}`}
                  >
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${kind === 'rifle' ? 'bg-sky-500/15 text-sky-300' : kind === 'tank' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-orange-500/15 text-orange-300'}`}>
                      <Icon className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <b className="truncate text-[13px]">{d.playerName}</b>
                        <kbd className="rounded bg-black/40 px-1.5 text-[10px] font-bold text-slate-300">{idx + 1}</kbd>
                      </span>
                      <span className="line-clamp-2 block text-[10.5px] leading-tight text-slate-400">{d.role}</span>
                      <span className="mt-1 flex items-center gap-2 text-[10px] text-slate-400">
                        <span className="flex items-center gap-0.5"><Heart className="h-3 w-3 text-red-400" />{d.hp}</span>
                        <span className="flex items-center gap-0.5"><Swords className="h-3 w-3 text-amber-400" />{d.damage}{d.splash ? ' АоЕ' : ''}</span>
                        <span className="flex items-center gap-0.5"><Gauge className="h-3 w-3 text-sky-400" />{d.range}</span>
                      </span>
                    </span>
                    <span className={`flex shrink-0 flex-col items-end text-sm font-black ${afford ? 'text-amber-300' : 'text-red-400'}`}>
                      <span className="flex items-center gap-1"><Coins className="h-3.5 w-3.5" />{d.cost}</span>
                      <span className="text-[9.5px] font-semibold text-slate-500">{queueFull ? 'очередь полна' : !afford ? 'нет кредитов' : `${d.build} сек`}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="rounded-xl border border-white/10 hud-panel p-3">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              {hud.selectedBase ? 'Выбрана база' : hud.selectedCount ? `Выбрано юнитов: ${hud.selectedCount}` : 'Приказы'}
            </div>
            {hud.selectedBase ? (
              <div className="space-y-2 text-[13px] text-slate-300">
                <div className="flex items-center gap-2"><Heart className="h-4 w-4 text-sky-400" /> Прочность базы: <b className="text-white">{hud.playerHp} / {hud.baseMax}</b></div>
                <p className="rounded-lg bg-white/5 p-2.5 text-xs leading-relaxed text-slate-400">
                  <b className="text-slate-200">ПКМ</b> по карте — зелёный флаг: точка сбора новых юнитов. Они пойдут туда и будут атаковать врагов по пути.
                </p>
                <div className="space-y-1 rounded-lg bg-emerald-500/10 p-2.5 text-xs leading-snug text-slate-300">
                  <div className="flex items-center gap-2 font-bold text-emerald-300"><Crosshair className="h-4 w-4" /> Оборона базы</div>
                  <div className="text-slate-400">Спаренная установка сама наводится и обстреливает врагов в радиусе 240: 2 снаряда × 9 урона с небольшим радиусом поражения. Радиус показан на карте.</div>
                </div>
              </div>
            ) : hud.selectedCount ? (
              <div>
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {(Object.keys(UNIT_DEFS) as UnitKind[]).filter((k) => hud.selectedByKind[k] > 0).map((k) => {
                    const Icon = KIND_ICON[k];
                    return (
                      <span key={k} className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-xs font-bold">
                        <Icon className="h-3.5 w-3.5 text-sky-300" />{UNIT_DEFS[k].playerName} × {hud.selectedByKind[k]}
                      </span>
                    );
                  })}
                </div>
                <div className="mb-3 flex items-center gap-2 text-xs text-slate-400">
                  <Heart className="h-3.5 w-3.5 text-emerald-400" /> HP: <b className="text-slate-200">{hud.selectedHp} / {hud.selectedMax}</b>
                  <div className="h-2 flex-1 rounded bg-white/10">
                    <div className="h-full rounded bg-emerald-400" style={{ width: `${hud.selectedMax ? (hud.selectedHp / hud.selectedMax) * 100 : 0}%` }} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setAttackMode(true)} className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-[13px] font-bold transition ${attackMode ? 'bg-red-600 text-white' : 'bg-red-500/15 text-red-300 hover:bg-red-500/25'}`}>
                    <Crosshair className="h-4 w-4" /> Атака (A)
                  </button>
                  <button onClick={stopSelected} className="flex items-center justify-center gap-1.5 rounded-lg bg-white/10 py-2 text-[13px] font-bold text-slate-200 hover:bg-white/15">
                    <Octagon className="h-4 w-4" /> Стоп (S)
                  </button>
                  <button onClick={sendToScout} className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-500/15 py-2 text-[13px] font-bold text-emerald-300 hover:bg-emerald-500/25">
                    <Eye className="h-4 w-4" /> Разведка (R)
                  </button>
                  <button onClick={retreat} className="flex items-center justify-center gap-1.5 rounded-lg bg-sky-500/15 py-2 text-[13px] font-bold text-sky-300 hover:bg-sky-500/25">
                    <Flag className="h-4 w-4" /> К базе
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={selectAllArmy} disabled={!inGame || hud.playerCount === 0} className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600/90 py-2 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
                    <Users className="h-4 w-4" /> Вся армия ({hud.playerCount})
                  </button>
                  <button onClick={sendToScout} disabled={!inGame || hud.playerCount === 0} className="flex items-center justify-center gap-1.5 rounded-lg bg-sky-500/20 py-2 text-xs font-bold text-sky-300 hover:bg-sky-500/30 disabled:opacity-40">
                    <Eye className="h-4 w-4" /> Разведка (R)
                  </button>
                </div>
                <div className="space-y-1 rounded-lg bg-white/5 p-2.5 text-[11.5px] leading-relaxed text-slate-400">
                  <div><Eye className="mr-1 inline h-3.5 w-3.5 text-sky-400" />Без разведки карта скрыта туманом войны</div>
                  <div><MousePointer2 className="mr-1 inline h-3.5 w-3.5 text-emerald-400" />ЛКМ / рамка — выбор, ПКМ — приказ</div>
                  <div><Crown className="mr-1 inline h-3.5 w-3.5 text-amber-400" />Захватите точки и разрушьте все базы ботов</div>
                </div>
                <div className="flex justify-between text-[11px] text-slate-500">
                  <span className="flex items-center gap-1"><Swords className="h-3.5 w-3.5" /> Убийств: {hud.kills}</span>
                  <span className="flex items-center gap-1"><Skull className="h-3.5 w-3.5" /> Потерь: {hud.losses}</span>
                  <span className="flex items-center gap-1"><Bot className="h-3.5 w-3.5" /> {DIFFS[hud.difficulty].label}</span>
                </div>
              </div>
            )}
          </section>
        </aside>

        {/* ===== ИГРОВОЕ ПОЛЕ ===== */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto max-md:order-1 max-md:flex-none max-md:overflow-visible">
          <div className="relative w-full shrink-0 overflow-hidden rounded-xl border border-white/10 bg-black field-frame">
            <canvas
              ref={canvasRef} width={1280} height={720}
              className={`block h-auto w-full ${attackMode ? 'cursor-none' : 'cursor-crosshair'}`}
              onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}
              onMouseLeave={() => { mouseRef.current = { x: -1, y: -1 }; setHoverHeight(null); }}
              onDoubleClick={onDoubleClick}
              onContextMenu={(e) => e.preventDefault()}
            />

            {inGame && hoverHeight !== null && (
              <div className="pointer-events-none absolute bottom-3 right-3 border border-white/10 bg-black/65 px-2.5 py-1 text-[11px] text-slate-300 backdrop-blur-sm">
                Высота: <b className="text-emerald-300">{hoverHeight} / 3</b>
              </div>
            )}

            {/* журнал событий */}
            {inGame && hud.messages.length > 0 && (
              <div className="pointer-events-none absolute left-3 top-3 space-y-1.5">
                {hud.messages.map((m) => (
                  <div key={m.id} className={`max-w-[360px] rounded-lg border px-2.5 py-1.5 text-xs font-medium backdrop-blur-sm ${
                    m.tone === 'good' ? 'border-emerald-400/30 bg-emerald-950/70 text-emerald-200'
                    : m.tone === 'bad' ? 'border-red-400/30 bg-red-950/70 text-red-200'
                    : 'border-white/15 bg-slate-950/70 text-slate-200'}`}>
                    {m.text}
                  </div>
                ))}
              </div>
            )}

            {attackMode && (
              <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-950/80 px-3 py-1.5 text-xs font-bold text-red-200">
                <Crosshair className="h-4 w-4" /> РЕЖИМ АТАКИ: кликните по цели или местности
              </div>
            )}

            {/* справка */}
            {showHelp && (
              <div className="absolute right-3 top-3 z-20 w-[340px] rounded-xl border border-white/15 bg-slate-950/95 p-4 text-sm shadow-2xl">
                <div className="mb-2 flex items-center justify-between">
                  <b className="flex items-center gap-1.5"><Info className="h-4 w-4 text-emerald-400" /> Как играть</b>
                  <button onClick={() => setShowHelp(false)}><X className="h-4 w-4 text-slate-400" /></button>
                </div>
                <ul className="space-y-1.5 text-[13px] leading-snug text-slate-300">
                  <li><b className="text-white">Цель:</b> уничтожить все базы ботов и не потерять свою. Боты действуют независимо, но играют в одной команде.</li>
                  <li><b className="text-white">Камера:</b> стрелки, курсор у края экрана, миникарта (ЛКМ — перейти, ПКМ — приказ). <b className="text-white">H</b> — к базе.</li>
                  <li><b className="text-white">ЛКМ</b> — выбор, рамка — группа, <b className="text-white">двойной клик</b> — все юниты типа.</li>
                  <li><b className="text-white">ПКМ</b> — движение; по врагу — атака. <b className="text-white">A + ЛКМ</b> — атака с движением.</li>
                  <li><b className="text-white">1 / 2 / 3</b> — построить юнита, <b className="text-white">S</b> — стоп, <b className="text-white">Пробел</b> — пауза, <b className="text-white">M</b> — звук.</li>
                  <li><b className="text-white">Точки</b> дают +4 кредита/сек. Держите их отрядом, чтобы захватить.</li>
                  <li><b className="text-white">Камень-ножницы:</b> артиллерия бьёт издалека, танки держат фронт, штурмовики быстры.</li>
                  <li><b className="text-white">Обход препятствий:</b> юниты сами прокладывают маршрут вокруг скал, деревьев и руин; у выбранных отрядом путь показан пунктиром.</li>
                  <li><b className="text-white">Высоты:</b> на уступах войска передвигаются медленнее, но видят дальше. Наведите курсор на разведанную местность, чтобы узнать высоту.</li>
                  <li><b className="text-white">Разведка и туман войны:</b> без разведки карта скрыта непроглядной пеленой, а враги вне обзора ваших войск невидимы. Захваченные точки работают как радары. Клавиша <b className="text-white">R</b> — отправить отряд в разведку.</li>
                  <li><b className="text-white">Оборона базы:</b> спаренная установка сама наводится на врагов в радиусе 240. Кликните по базе, чтобы увидеть радиус.</li>
                </ul>
              </div>
            )}

            {/* пауза */}
            {hud.status === 'paused' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/55">
                <div className="rounded-2xl border border-white/12 bg-slate-950/95 px-8 py-6 text-center">
                  <Pause className="mx-auto mb-2 h-8 w-8 text-slate-300" />
                  <div className="mb-4 text-xl font-black">ПАУЗА</div>
                  <button onClick={togglePause} className="flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 font-bold hover:bg-emerald-500"><Play className="h-4 w-4" /> Продолжить</button>
                </div>
              </div>
            )}

            {/* финал */}
            {(hud.status === 'victory' || hud.status === 'defeat') && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/62 p-4">
                <div className="w-full max-w-md rounded-2xl border border-white/12 bg-[#0d130d]/97 p-6 text-center shadow-2xl">
                  {hud.status === 'victory' ? <Trophy className="mx-auto mb-2 h-12 w-12 text-amber-400" /> : <Skull className="mx-auto mb-2 h-12 w-12 text-red-400" />}
                  <div className={`mb-1 text-3xl font-black ${hud.status === 'victory' ? 'text-amber-300' : 'text-red-300'}`}>
                    {hud.status === 'victory' ? 'ПОБЕДА!' : 'БАЗА УНИЧТОЖЕНА'}
                  </div>
                  <p className="mb-4 text-sm text-slate-400">
                    {hud.status === 'victory' ? `Все базы ботов на карте «${hud.mapName}» разрушены!` : 'Легион разрушил вашу базу.'}
                  </p>
                  <div className="mb-5 grid grid-cols-4 gap-2 text-center">
                    {[
                      { icon: Timer, v: fmtTime(hud.time), l: 'Время' },
                      { icon: Swords, v: hud.kills, l: 'Убийств' },
                      { icon: Skull, v: hud.losses, l: 'Потерь' },
                      { icon: Users, v: hud.built + 4, l: 'Построено' },
                    ].map((s) => (
                      <div key={s.l} className="rounded-lg bg-white/5 p-2.5">
                        <s.icon className="mx-auto mb-1 h-4 w-4 text-slate-400" />
                        <div className="text-sm font-extrabold">{s.v}</div>
                        <div className="text-[10px] text-slate-500">{s.l}</div>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => startGame(hud.difficulty, hud.mapId, hud.botCount)} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 font-black hover:bg-emerald-500">
                      <RotateCcw className="h-4 w-4" /> ЕЩЁ РАЗ
                    </button>
                    <button onClick={toMenu} className="rounded-xl border border-white/15 bg-white/5 px-4 font-bold hover:bg-white/10">Меню</button>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="mt-2 flex justify-between text-[11px] text-slate-500 max-sm:flex-col max-sm:gap-1">
            <span>Стрелки или край экрана — камера • H — к базе • Пробел — пауза</span>
            <span>{hud.mapName} • {MAP_W}×{MAP_H}</span>
          </div>
        </main>
      </div>

      {/* ===== ГЛАВНОЕ МЕНЮ: ВЫБОР КАРТЫ И СЛОЖНОСТИ ===== */}
      {hud.status === 'menu' && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/85 p-4 backdrop-blur-sm">
          <div className="mx-auto my-2 w-full max-w-6xl rounded-2xl border border-white/12 bg-[#0d130d] p-6 shadow-2xl">
            <div className="mb-1 flex items-center justify-center gap-2">
              <Bot className="h-6 w-6 text-red-400" />
              <h1 className="text-2xl font-black tracking-wide sm:text-3xl">FRONTLINE</h1>
            </div>
            <p className="mb-5 text-center text-sm text-slate-400">
              Две фракции, четыре большие карты и до трёх командиров Легиона.
            </p>

            <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <MapIcon className="h-4 w-4" /> Выберите карту
            </div>
            <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {MAPS.map((m) => {
                const Icon = THEME_ICON[m.theme];
                const active = chosenMap === m.id;
                return (
                  <button
                    key={m.id} onClick={() => setChosenMap(m.id)}
                    className={`overflow-hidden rounded-xl border text-left transition ${active ? 'border-emerald-400 bg-emerald-500/10 shadow-lg shadow-emerald-900/40' : 'border-white/10 bg-white/[0.03] hover:border-white/25'}`}
                  >
                    <MapPreview map={m} botCount={chosenBots} />
                    <div className="p-3">
                      <div className="mb-0.5 flex items-center justify-between gap-2">
                        <b className="text-sm">{m.name}</b>
                        <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-emerald-300' : 'text-slate-500'}`} />
                      </div>
                      <div className="text-[11px] text-slate-400">{m.subtitle}</div>
                      <p className="mt-1.5 text-[11.5px] leading-snug text-slate-300">{m.desc}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-semibold text-slate-400">
                        <span className="rounded bg-white/10 px-1.5 py-0.5">точек: {m.points.length}</span>
                        <span className="rounded bg-white/10 px-1.5 py-0.5">препятствий: {m.obstacles.length}</span>
                        <span className="rounded bg-white/10 px-1.5 py-0.5">декораций: {m.props.length}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="mb-2 flex items-center justify-between text-xs font-bold uppercase tracking-wider text-slate-400">
              <span>Количество ботов</span>
              <span className="normal-case tracking-normal text-slate-500">Боты в одной команде, у каждого своя база</span>
            </div>
            <div className="mb-5 grid grid-cols-3 gap-2" role="group" aria-label="Количество ботов">
              {([1, 2, 3] as BotCount[]).map((count) => (
                <button key={count} type="button" aria-pressed={chosenBots === count} onClick={() => setChosenBots(count)}
                  className={`flex items-center justify-center gap-2 rounded-xl border py-3 text-sm font-bold transition ${chosenBots === count ? 'border-emerald-400 bg-emerald-500/15 text-emerald-200' : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'}`}>
                  <Bot className="h-4 w-4" /> {count} {count === 1 ? 'бот' : 'бота'}
                </button>
              ))}
            </div>

            <div className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">Сложность ботов</div>
            <div className="mb-5 grid grid-cols-3 gap-2">
              {(Object.keys(DIFFS) as Difficulty[]).map((d) => (
                <button
                  key={d} onClick={() => setChosenDiff(d)}
                  className={`rounded-xl border p-3 text-left transition ${chosenDiff === d ? 'border-emerald-400 bg-emerald-500/15' : 'border-white/10 bg-white/5 hover:bg-white/10'}`}
                >
                  <div className="text-sm font-extrabold">{DIFFS[d].label}</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-slate-400">{DIFFS[d].desc}</div>
                </button>
              ))}
            </div>

            <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
              <div className="flex items-center gap-2 text-xs text-slate-300">
                <Equalizer active={!sound.muted && hud.audioUnlocked} />
                <span>
                  <b className="text-white">Адаптивный саундтрек.</b> Тема штаба переходит в боевую, когда начинается сражение.
                  {!hud.audioUnlocked && <span className="text-slate-500"> Звук включится после первого клика.</span>}
                </span>
              </div>
              <button
                onClick={toggleMute}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition ${sound.muted ? 'bg-red-500/15 text-red-300 hover:bg-red-500/25' : 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'}`}
              >
                {sound.muted ? <><VolumeX className="h-3.5 w-3.5" /> Звук выкл</> : <><Volume2 className="h-3.5 w-3.5" /> Звук вкл</>}
              </button>
            </div>

            <button
              onClick={() => startGame(chosenDiff, chosenMap, chosenBots)}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3.5 text-base font-black tracking-wide text-white transition hover:bg-emerald-500"
            >
              <Play className="h-5 w-5" /> В БОЙ НА «{MAPS.find((m) => m.id === chosenMap)?.name.toUpperCase()}» <ChevronRight className="h-5 w-5" />
            </button>
            <div className="mt-3 flex items-center justify-center gap-4 text-[11px] text-slate-500">
              <span className="flex items-center gap-1"><MousePointer2 className="h-3.5 w-3.5" /> ЛКМ — выбор, ПКМ — приказ</span>
              <span>Клавиши 1–3 — постройка • стрелки — камера</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
