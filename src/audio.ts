/* ============================================================================
   Адаптивный процедурный саундтрек и звуковые эффекты (Web Audio API).
   Музыка синтезируется в реальном времени: пэды, бас, арпеджио, ударные и
   соло-партия. Слои плавно включаются в зависимости от накала боя.
   ========================================================================== */

export type MusicMode = 'menu' | 'calm' | 'battle';
export type SoundEvent =
  | { type: 'shot'; kind: 'rifle' | 'tank' | 'arty' | 'base'; x: number }
  | { type: 'hit'; x: number }
  | { type: 'explosion'; size: 'small' | 'medium' | 'big' | 'huge'; x: number }
  | { type: 'built' }
  | { type: 'capture'; good: boolean }
  | { type: 'alert' }
  | { type: 'basehit' };

type Layer = 'pad' | 'bass' | 'arp' | 'drums' | 'lead';

const BPM = 126;
const STEP = 60 / BPM / 4; // длительность 16-й ноты в секундах
const LOOP = 128; // 8 тактов по 16 шагов
const MAP_W = 10240;
const STORAGE_KEY = 'frontline-audio-v1';

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

interface Chord { bass: number; pad: number[]; arp: number[] }

/** Прогрессия в ля миноре: Am F C G | Am F Dm E */
const PROG: Chord[] = [
  { bass: 45, pad: [57, 60, 64], arp: [69, 72, 76, 81] }, // Am
  { bass: 41, pad: [53, 57, 60], arp: [65, 69, 72, 77] }, // F
  { bass: 36, pad: [55, 60, 64], arp: [67, 72, 76, 79] }, // C
  { bass: 43, pad: [55, 59, 62], arp: [67, 71, 74, 79] }, // G
  { bass: 45, pad: [57, 60, 64], arp: [69, 72, 76, 81] }, // Am
  { bass: 41, pad: [53, 57, 60], arp: [65, 69, 72, 77] }, // F
  { bass: 38, pad: [57, 62, 65], arp: [69, 74, 77, 81] }, // Dm
  { bass: 40, pad: [56, 59, 64], arp: [68, 71, 76, 80] }, // E
];

/** Героическая соло-партия боевой темы: [шаг, нота MIDI, длительность в шагах] */
const LEAD_NOTES: [number, number, number][] = [
  [0, 69, 6], [6, 72, 2], [8, 76, 8],
  [16, 74, 4], [20, 72, 4], [24, 69, 8],
  [32, 67, 4], [36, 69, 2], [38, 72, 2], [40, 76, 4], [44, 74, 4],
  [48, 71, 8], [56, 74, 4], [60, 67, 4],
  [64, 69, 6], [70, 72, 2], [72, 76, 8],
  [80, 77, 4], [84, 76, 4], [88, 72, 8],
  [96, 74, 4], [100, 77, 4], [104, 81, 8],
  [112, 80, 8], [120, 76, 4], [124, 71, 4],
];
const LEAD = new Map<number, { m: number; d: number }>();
for (const [s, m, d] of LEAD_NOTES) LEAD.set(s, { m, d });

const CALM_ARP: Record<number, number> = { 0: 0, 3: 1, 6: 2, 8: 3, 11: 2, 14: 1 };
const MENU_ARP_SLOTS = [0, 6, 10, 13];
const BATTLE_BASS = [0, 0, 12, 0, 0, 0, 12, 7];

/** Громкость слоёв для каждого режима */
const MIX: Record<MusicMode, Record<Layer, number>> = {
  menu: { pad: 0.62, bass: 0.26, arp: 0.22, drums: 0.22, lead: 0 },
  calm: { pad: 0.46, bass: 0.52, arp: 0.36, drums: 0.52, lead: 0 },
  battle: { pad: 0.4, bass: 0.62, arp: 0.42, drums: 0.95, lead: 0.5 },
};

export const MODE_LABEL: Record<MusicMode, string> = {
  menu: 'Эмбиент штаба',
  calm: 'Марш патруля',
  battle: 'Тема боя',
};

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private stingerBus!: GainNode;
  private layers!: Record<Layer, GainNode>;
  private noise!: AudioBuffer;

  private timer: number | null = null;
  private step = 0;
  private loop = 0;
  private nextTime = 0;
  private barMode: MusicMode = 'menu';
  private prevBarMode: MusicMode = 'menu';
  private intensity = 0;
  private intensityTarget = 0;
  private lastSfx: Record<string, number> = {};
  private stingerTimer: number | null = null;
  private suppressed = false;
  private ducked = false;

  mode: MusicMode = 'menu';
  unlocked = false;
  playing = false;
  muted = false;
  musicVol = 0.55;
  sfxVol = 0.7;

  constructor() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
      const s = raw ? JSON.parse(raw) : {};
      if (typeof s.muted === 'boolean') this.muted = s.muted;
      if (typeof s.musicVol === 'number') this.musicVol = clamp01(s.musicVol);
      if (typeof s.sfxVol === 'number') this.sfxVol = clamp01(s.sfxVol);
    } catch {
      /* настройки по умолчанию */
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!this.ctx) return;
        if (document.hidden) void this.ctx.suspend();
        else if (this.unlocked) void this.ctx.resume();
      });
    }
  }

  /* ------------------------------ инициализация ------------------------------ */

  /** Нужно вызывать из обработчика жеста пользователя (политика автоплея) */
  unlock() {
    if (!this.ctx) {
      try { this.build(); } catch { return; }
    }
    const ctx = this.ctx!;
    if (ctx.state === 'suspended') void ctx.resume();
    this.unlocked = true;
    if (!this.playing) this.start();
  }

  private build() {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API недоступен');
    const ctx = new Ctor();
    this.ctx = ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 18; comp.ratio.value = 4;
    comp.attack.value = 0.004; comp.release.value = 0.22;
    comp.connect(ctx.destination);

    this.master = ctx.createGain(); this.master.connect(comp);
    this.musicBus = ctx.createGain(); this.musicBus.connect(this.master);
    this.sfxBus = ctx.createGain(); this.sfxBus.connect(this.master);
    this.stingerBus = ctx.createGain(); this.stingerBus.connect(this.master);

    // пунктирное эхо для арпеджио и соло
    const delay = ctx.createDelay(1); delay.delayTime.value = STEP * 3;
    const fb = ctx.createGain(); fb.gain.value = 0.3;
    const dl = ctx.createBiquadFilter(); dl.type = 'lowpass'; dl.frequency.value = 2400;
    const wet = ctx.createGain(); wet.gain.value = 0.32;
    delay.connect(dl); dl.connect(fb); fb.connect(delay); dl.connect(wet); wet.connect(this.musicBus);

    const mk = () => { const g = ctx.createGain(); g.gain.value = 0; g.connect(this.musicBus); return g; };
    this.layers = { pad: mk(), bass: mk(), arp: mk(), drums: mk(), lead: mk() };
    const arpSend = ctx.createGain(); arpSend.gain.value = 0.4; this.layers.arp.connect(arpSend); arpSend.connect(delay);
    const leadSend = ctx.createGain(); leadSend.gain.value = 0.55; this.layers.lead.connect(leadSend); leadSend.connect(delay);

    const len = Math.floor(ctx.sampleRate * 1.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;

    this.applyVolumes(true);
  }

  private save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ muted: this.muted, musicVol: this.musicVol, sfxVol: this.sfxVol }));
    } catch {
      /* приватный режим — игнорируем */
    }
  }

  private applyVolumes(immediate = false) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const tc = immediate ? 0.001 : 0.06;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 1, t, tc);
    const music = this.suppressed ? 0 : this.musicVol * (this.ducked ? 0.3 : 1);
    this.musicBus.gain.setTargetAtTime(music, t, this.suppressed ? 0.2 : tc);
    this.sfxBus.gain.setTargetAtTime(this.sfxVol * (this.ducked ? 0.5 : 1), t, tc);
    this.stingerBus.gain.setTargetAtTime(this.musicVol, t, tc);
  }

  /* ------------------------------ публичные настройки ------------------------------ */

  setMuted(m: boolean) {
    this.muted = m; this.save(); this.applyVolumes();
    if (m) this.stop(); else if (this.unlocked) this.start();
  }
  toggleMuted() { this.setMuted(!this.muted); }
  setMusicVol(v: number) { this.musicVol = clamp01(v); this.save(); this.applyVolumes(); }
  setSfxVol(v: number) { this.sfxVol = clamp01(v); this.save(); this.applyVolumes(); }
  setDucked(d: boolean) { if (this.ducked === d) return; this.ducked = d; this.applyVolumes(); }
  setMode(mode: MusicMode) { this.mode = mode; }
  setIntensity(v: number) { this.intensityTarget = clamp01(v); }

  /** Новый бой: снимаем «тишину» после финальных фанфар и переключаемся на патрульную тему */
  onGameStart() {
    if (this.stingerTimer) { clearTimeout(this.stingerTimer); this.stingerTimer = null; }
    this.suppressed = false;
    this.mode = 'calm';
    this.applyVolumes();
    if (this.unlocked && !this.playing) this.start();
  }

  /* ------------------------------ секвенсор ------------------------------ */

  private start() {
    if (!this.ctx || this.playing || this.muted) return;
    this.playing = true;
    this.step = 0; this.loop = 0;
    this.barMode = this.mode; this.prevBarMode = this.mode;
    this.nextTime = this.ctx.currentTime + 0.06;
    this.timer = window.setInterval(this.tick, 25);
  }

  private stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.playing = false;
  }

  private tick = () => {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (this.nextTime < now - 0.25) this.nextTime = now + 0.05; // ресинхронизация после долгого простоя
    while (this.nextTime < now + 0.16) {
      this.scheduleStep(this.step, this.nextTime);
      this.nextTime += STEP;
      this.step++;
      if (this.step >= LOOP) { this.step = 0; this.loop++; }
    }
    this.intensity += (this.intensityTarget - this.intensity) * 0.04;
  };

  private applyMix(t: number) {
    const mix = MIX[this.barMode];
    (Object.keys(mix) as Layer[]).forEach((l) => {
      let v = mix[l];
      if (l === 'drums' && this.barMode === 'battle') v = 0.7 + 0.3 * this.intensity;
      this.layers[l].gain.setTargetAtTime(v, t, 0.45);
    });
  }

  private scheduleStep(step: number, t: number) {
    const bar = Math.floor(step / 16), s = step % 16;
    if (s === 0) {
      this.prevBarMode = this.barMode;
      this.barMode = this.mode;
      this.applyMix(t);
    }
    const mode = this.barMode;
    const ch = PROG[bar];
    const barDur = STEP * 16;

    // --- пэд: аккорд на весь такт ---
    if (s === 0) this.pad(ch.pad, t, barDur, mode);

    // --- бас ---
    if (mode === 'menu') {
      if (s === 0) this.bass(ch.bass, t, barDur * 0.9, 0.3);
    } else if (mode === 'calm') {
      if (s === 0) this.bass(ch.bass, t, STEP * 7, 0.5);
      else if (s === 8) this.bass(ch.bass, t, STEP * 5, 0.45);
      else if (s === 14) this.bass(ch.bass + 7, t, STEP * 1.8, 0.4);
    } else if (s % 2 === 0) {
      this.bass(ch.bass + BATTLE_BASS[s / 2], t, STEP * 1.8, s % 4 === 0 ? 0.6 : 0.48);
    }

    // --- арпеджио ---
    if (mode === 'menu') {
      const i = MENU_ARP_SLOTS.indexOf(s);
      if (i >= 0 && (bar + i) % 3 !== 2) this.pluck(ch.arp[(bar + i) % 4], t, 0.24, false);
    } else if (mode === 'calm') {
      const idx = CALM_ARP[s];
      if (idx !== undefined) this.pluck(ch.arp[idx], t, 0.3, false);
    } else {
      this.pluck(ch.arp[s % 4] + (s >= 8 ? 12 : 0), t, s % 4 === 0 ? 0.42 : 0.3, true);
    }

    // --- соло (только в бою, с перекличкой через цикл) ---
    const ln = LEAD.get(step);
    if (ln && mode === 'battle' && (this.loop % 2 === 0 || bar >= 4)) this.lead(ln.m, t, ln.d * STEP);

    // --- ударные ---
    this.drums(mode, bar, s, t);
  }

  private drums(mode: MusicMode, bar: number, s: number, t: number) {
    if (mode === 'menu') {
      if (s === 0 && bar % 2 === 0) this.kick(t, 0.5);
      if (s === 8 && bar % 4 === 3) this.tom(t, 0.3);
      if (s === 12 && bar % 4 === 1) this.hat(t, 0.12, true);
      return;
    }
    if (mode === 'calm') {
      if (s === 0 || s === 8) this.kick(t, 0.8);
      if (s === 10 && bar % 2 === 1) this.kick(t, 0.55);
      if (s === 4 || s === 12) this.snare(t, 0.5);
      if (s % 2 === 0) this.hat(t, s % 4 === 2 ? 0.3 : 0.2, false);
      if (bar % 4 === 3 && s >= 12) this.tom(t, 0.3 + (s - 12) * 0.08);
      if (s === 14 && bar % 2 === 1) this.hat(t, 0.25, true);
      return;
    }
    // бой
    if (s === 0 && this.prevBarMode !== 'battle') this.crash(t, 0.6);
    if (s % 4 === 0) this.kick(t, 1);
    if (s === 14 && bar % 2 === 1) this.kick(t, 0.7);
    if (s === 10 && bar % 4 === 2) this.kick(t, 0.6);
    if (s === 4 || s === 12) this.snare(t, 0.85);
    if ((s === 7 && bar % 2 === 1) || (s === 15 && bar % 2 === 0)) this.snare(t, 0.3);
    if (bar === 7 && s >= 12) this.snare(t, 0.35 + (s - 12) * 0.15);
    if (bar === 3 && s >= 13) this.tom(t, 0.4 + (s - 13) * 0.1);
    this.hat(t, s % 2 === 0 ? 0.38 : 0.2, false);
    if (s === 14) this.hat(t, 0.3, true);
  }

  /* ------------------------------ инструменты ------------------------------ */

  private pad(notes: number[], t: number, dur: number, mode: MusicMode) {
    const ctx = this.ctx!;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 0.8;
    f.frequency.setValueAtTime(mode === 'battle' ? 1500 : mode === 'calm' ? 1000 : 700, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.085, t + 0.4);
    g.gain.setValueAtTime(0.085, t + dur - 0.25);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.3);
    f.connect(g); g.connect(this.layers.pad);
    for (const n of notes) {
      for (const det of [-7, 7]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        o.frequency.value = mtof(n); o.detune.value = det;
        o.connect(f); o.start(t); o.stop(t + dur + 0.35);
      }
    }
  }

  private bass(note: number, t: number, dur: number, vel: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(note);
    const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = mtof(note - 12);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 3;
    f.frequency.setValueAtTime(1200, t); f.frequency.exponentialRampToValueAtTime(260, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vel * 0.4, t + 0.012);
    g.gain.setValueAtTime(vel * 0.4, t + dur - 0.04); g.gain.linearRampToValueAtTime(0.0001, t + dur);
    const sg = ctx.createGain(); sg.gain.value = 0.55;
    o.connect(f); sub.connect(sg); sg.connect(f); f.connect(g); g.connect(this.layers.bass);
    o.start(t); sub.start(t); o.stop(t + dur + 0.02); sub.stop(t + dur + 0.02);
  }

  private pluck(note: number, t: number, vel: number, bright: boolean) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.type = bright ? 'square' : 'triangle'; o.frequency.value = mtof(note);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(bright ? 3200 : 1800, t); f.frequency.exponentialRampToValueAtTime(500, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vel * (bright ? 0.16 : 0.22), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (bright ? 0.22 : 0.4));
    o.connect(f); f.connect(g); g.connect(this.layers.arp);
    o.start(t); o.stop(t + 0.45);
  }

  private lead(note: number, t: number, dur: number) {
    const ctx = this.ctx!;
    const peak = 0.14;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + 0.02);
    g.gain.setValueAtTime(peak, t + Math.max(0.03, dur - 0.06)); g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.02);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(3200, t); f.frequency.exponentialRampToValueAtTime(1300, t + 0.3);
    f.connect(g); g.connect(this.layers.lead);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 5.5;
    const lg = ctx.createGain(); lg.gain.value = 7; lfo.connect(lg);
    for (const det of [-8, 8]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(note); o.detune.value = det;
      lg.connect(o.detune); o.connect(f); o.start(t); o.stop(t + dur + 0.05);
    }
    lfo.start(t); lfo.stop(t + dur + 0.05);
  }

  private brass(out: AudioNode, note: number, t: number, dur: number, vol: number) {
    const ctx = this.ctx!;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 1.5;
    f.frequency.setValueAtTime(600, t); f.frequency.linearRampToValueAtTime(2600, t + 0.08);
    f.frequency.exponentialRampToValueAtTime(1100, t + Math.max(0.2, dur));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + 0.04);
    g.gain.setValueAtTime(vol, t + Math.max(0.05, dur - 0.1)); g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.15);
    f.connect(g); g.connect(out);
    for (const det of [-10, 0, 10]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(note); o.detune.value = det;
      o.connect(f); o.start(t); o.stop(t + dur + 0.2);
    }
  }

  /* ------------------------------ ударные ------------------------------ */

  private noiseSrc(t: number, dur: number) {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise; s.loop = true;
    s.start(t); s.stop(t + dur + 0.02);
    return s;
  }

  private kick(t: number, vel: number, out: AudioNode = this.layers.drums) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(170, t); o.frequency.exponentialRampToValueAtTime(44, t + 0.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel * 0.9, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.32);
    const n = this.noiseSrc(t, 0.03);
    const hf = ctx.createBiquadFilter(); hf.type = 'highpass'; hf.frequency.value = 2000;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(vel * 0.25, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    n.connect(hf); hf.connect(ng); ng.connect(out);
  }

  private snare(t: number, vel: number, out: AudioNode = this.layers.drums) {
    const ctx = this.ctx!;
    const n = this.noiseSrc(t, 0.2);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel * 0.55, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    n.connect(bp); bp.connect(g); g.connect(out);
    const o = ctx.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(200, t); o.frequency.exponentialRampToValueAtTime(120, t + 0.06);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vel * 0.4, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(og); og.connect(out); o.start(t); o.stop(t + 0.1);
  }

  private hat(t: number, vel: number, open: boolean, out: AudioNode = this.layers.drums) {
    const ctx = this.ctx!;
    const dur = open ? 0.28 : 0.05;
    const n = this.noiseSrc(t, dur);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel * 0.3, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(hp); hp.connect(g); g.connect(out);
  }

  private tom(t: number, vel: number, out: AudioNode = this.layers.drums) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(80, t + 0.15);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel * 0.6, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.27);
  }

  private crash(t: number, vel: number, out: AudioNode = this.layers.drums) {
    const ctx = this.ctx!;
    const n = this.noiseSrc(t, 1.2);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel * 0.35, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    n.connect(hp); hp.connect(g); g.connect(out);
  }

  /* ------------------------------ финальные фанфары ------------------------------ */

  stinger(kind: 'victory' | 'defeat') {
    if (!this.ctx || !this.unlocked) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.05;
    const out = this.stingerBus;
    this.suppressed = true; this.applyVolumes();
    if (this.stingerTimer) clearTimeout(this.stingerTimer);

    if (kind === 'victory') {
      [69, 73, 76, 81].forEach((m, i) => this.brass(out, m, t + i * 0.15, 0.2, 0.12));
      [57, 64, 69, 73, 76, 81].forEach((m) => this.brass(out, m, t + 0.65, 2.3, 0.07));
      this.kick(t, 0.9, out); this.snare(t + 0.5, 0.5, out); this.snare(t + 0.575, 0.7, out);
      this.kick(t + 0.65, 1, out); this.crash(t + 0.65, 0.8, out);
    } else {
      [64, 62, 60, 59].forEach((m, i) => this.brass(out, m, t + i * 0.45, 0.42, 0.1));
      [45, 52, 57].forEach((m) => this.brass(out, m, t + 1.85, 2.6, 0.06));
      const d = ctx.createOscillator(); d.type = 'sawtooth'; d.frequency.value = mtof(33);
      const df = ctx.createBiquadFilter(); df.type = 'lowpass';
      df.frequency.setValueAtTime(500, t); df.frequency.exponentialRampToValueAtTime(60, t + 4);
      const dg = ctx.createGain();
      dg.gain.setValueAtTime(0.0001, t); dg.gain.linearRampToValueAtTime(0.16, t + 0.3);
      dg.gain.setValueAtTime(0.16, t + 3); dg.gain.linearRampToValueAtTime(0.0001, t + 4.5);
      d.connect(df); df.connect(dg); dg.connect(out); d.start(t); d.stop(t + 4.6);
      this.tone(out, 'sine', 70, 28, 1.6, 0.5, t, 1.2);
    }
    this.stingerTimer = window.setTimeout(() => {
      this.stingerTimer = null;
      this.suppressed = false;
      if (this.ctx) this.musicBus.gain.setTargetAtTime(this.musicVol * (this.ducked ? 0.3 : 1), this.ctx.currentTime, 0.8);
    }, kind === 'victory' ? 4200 : 5200);
  }

  /* ------------------------------ звуковые эффекты ------------------------------ */

  private gate(key: string, ms: number) {
    const now = performance.now();
    if (now - (this.lastSfx[key] ?? 0) < ms) return false;
    this.lastSfx[key] = now;
    return true;
  }

  private pan(x?: number): AudioNode {
    const ctx = this.ctx!;
    if (x === undefined || typeof ctx.createStereoPanner !== 'function') return this.sfxBus;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, (x / MAP_W) * 2 - 1)) * 0.65;
    p.connect(this.sfxBus);
    return p;
  }

  private tone(out: AudioNode, type: OscillatorType, f0: number, f1: number, dur: number, vol: number, t: number, sweep = dur * 0.85, attack = 0.003) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + sweep);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.02);
  }

  private burst(out: AudioNode, kind: BiquadFilterType, f0: number, f1: number, dur: number, vol: number, t: number, q = 0.8) {
    const ctx = this.ctx!;
    const n = this.noiseSrc(t, dur);
    const f = ctx.createBiquadFilter(); f.type = kind; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f); f.connect(g); g.connect(out);
  }

  private ready() {
    return !!this.ctx && this.unlocked && !this.muted && !document.hidden;
  }

  /** Обработка игровых событий из симуляции */
  handle(ev: SoundEvent) {
    if (!this.ready()) return;
    switch (ev.type) {
      case 'shot': this.shot(ev.kind, ev.x); break;
      case 'hit': if (this.gate('hit', 120)) this.hit(ev.x); break;
      case 'explosion': this.explosion(ev.size, ev.x); break;
      case 'built': this.built(); break;
      case 'capture': this.capture(ev.good); break;
      case 'alert': if (this.gate('alert', 3000)) this.alert(false); break;
      case 'basehit': if (this.gate('basehit', 6000)) this.alert(true); break;
    }
  }

  private shot(kind: 'rifle' | 'tank' | 'arty' | 'base', x: number) {
    const t = this.ctx!.currentTime;
    if (kind === 'rifle') {
      if (!this.gate('rifle', 85)) return;
      const out = this.pan(x);
      this.tone(out, 'square', 1400 * (0.9 + Math.random() * 0.25), 240, 0.09, 0.07, t);
      this.burst(out, 'bandpass', 2800, 2800, 0.05, 0.06, t);
    } else if (kind === 'tank') {
      if (!this.gate('tank', 120)) return;
      const out = this.pan(x);
      this.tone(out, 'sine', 150, 48, 0.2, 0.4, t, 0.12);
      this.burst(out, 'lowpass', 1800, 300, 0.14, 0.3, t);
    } else if (kind === 'arty') {
      if (!this.gate('arty', 150)) return;
      const out = this.pan(x);
      this.tone(out, 'sine', 100, 32, 0.4, 0.5, t, 0.25);
      this.burst(out, 'lowpass', 700, 150, 0.35, 0.4, t);
      this.burst(out, 'bandpass', 600, 2200, 0.5, 0.08, t + 0.05, 2);
    } else {
      if (!this.gate('base', 120)) return;
      const out = this.pan(x);
      this.tone(out, 'sawtooth', 1100, 220, 0.12, 0.08, t);
      this.tone(out, 'triangle', 2200, 500, 0.08, 0.06, t);
    }
  }

  private hit(x: number) {
    const t = this.ctx!.currentTime;
    const out = this.pan(x);
    this.burst(out, 'bandpass', 1800, 900, 0.06, 0.06, t, 1.2);
    this.tone(out, 'triangle', 500, 200, 0.05, 0.05, t);
  }

  private explosion(size: 'small' | 'medium' | 'big' | 'huge', x: number) {
    if (size !== 'huge' && !this.gate('expl', size === 'small' ? 80 : 50)) return;
    const t = this.ctx!.currentTime;
    const out = this.pan(x);
    const [dur, vol, f0] = { small: [0.35, 0.3, 2200], medium: [0.55, 0.45, 1800], big: [0.85, 0.6, 1500], huge: [2, 0.9, 1200] }[size];
    this.burst(out, 'lowpass', f0, 100, dur, vol, t, 0.6);
    this.tone(out, 'sine', 120, 30, dur * 0.6, vol * 0.8, t, dur * 0.4);
    if (size !== 'small') this.burst(out, 'bandpass', 400, 150, dur * 0.8, vol * 0.4, t + 0.02, 1.5);
    if (size === 'huge') {
      this.tone(out, 'sine', 55, 25, 1.8, 0.6, t + 0.1, 1.5);
      this.burst(out, 'lowpass', 900, 80, 1.6, 0.5, t + 0.25);
    }
  }

  private built() {
    const t = this.ctx!.currentTime;
    this.tone(this.sfxBus, 'triangle', 660, 660, 0.09, 0.1, t);
    this.tone(this.sfxBus, 'triangle', 990, 990, 0.16, 0.1, t + 0.09);
  }

  private capture(good: boolean) {
    const t = this.ctx!.currentTime;
    const notes = good ? [523, 659, 784] : [440, 349, 262];
    notes.forEach((f, i) => this.tone(this.sfxBus, 'triangle', f, f, 0.22, 0.1, t + i * (good ? 0.1 : 0.14), 0, 0.01));
  }

  private alert(base: boolean) {
    const t = this.ctx!.currentTime;
    const [a, b] = base ? [420, 300] : [720, 540];
    for (let i = 0; i < 4; i++) this.tone(this.sfxBus, 'square', i % 2 ? b : a, i % 2 ? b : a, 0.12, 0.05, t + i * 0.13, 0, 0.01);
  }

  /* ------------------------------ звуки интерфейса ------------------------------ */

  click() {
    if (!this.ready() || !this.gate('click', 40)) return;
    this.tone(this.sfxBus, 'sine', 2000, 1500, 0.03, 0.04, this.ctx!.currentTime);
  }
  select() {
    if (!this.ready() || !this.gate('select', 60)) return;
    this.tone(this.sfxBus, 'sine', 1300, 1700, 0.05, 0.05, this.ctx!.currentTime);
  }
  order(attack: boolean) {
    if (!this.ready() || !this.gate('order', 70)) return;
    const t = this.ctx!.currentTime;
    if (attack) {
      this.tone(this.sfxBus, 'sawtooth', 900, 600, 0.07, 0.05, t);
      this.tone(this.sfxBus, 'square', 1200, 1200, 0.04, 0.03, t + 0.07);
    } else {
      this.tone(this.sfxBus, 'square', 1600, 1100, 0.04, 0.035, t);
      this.tone(this.sfxBus, 'square', 1300, 1300, 0.04, 0.03, t + 0.05);
    }
  }
  error() {
    if (!this.ready() || !this.gate('error', 150)) return;
    const t = this.ctx!.currentTime;
    this.tone(this.sfxBus, 'square', 200, 180, 0.09, 0.05, t);
    this.tone(this.sfxBus, 'square', 200, 170, 0.12, 0.05, t + 0.11);
  }
}

export const audio = new AudioEngine();
