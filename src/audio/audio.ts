// All audio is synthesized at runtime with the Web Audio API: no files, fully original.
// Three layers share one master compressor:
//  - SFX: chunky UI feedback (press, hover, ka-ching, hire, level-up, alerts) and world one-shots.
//  - Ambience: a district-, time- and position-aware city bed (traffic, crowd murmur, crossing chirps,
//    shop chimes, trains, cicadas, rain, and a restaurant interior near owned shops).
//  - Music: a generative lo-fi / city-pop loop with day and night variants, ducked under UI sounds.
import { on } from '../core/bus';
import type { Settings } from '../core/state';

export type Sfx =
  // UI
  | 'click' | 'press' | 'hover' | 'pop' | 'tick' | 'open' | 'close' | 'whoosh' | 'alert' | 'error' | 'buzz'
  // economy and progression
  | 'coin' | 'cash' | 'purchase' | 'hire' | 'upgrade' | 'levelup' | 'success' | 'milestone' | 'fanfare'
  // world
  | 'chop' | 'fail' | 'door' | 'firework' | 'step';

/** What the listener hears around them. Only the first five fields are required. */
export interface AudioScene {
  district: string;
  night: number; // 0 day .. 1 night
  rain?: boolean; // legacy switch; setRain(0..1) is the real control
  inside: boolean; // at an owned restaurant
  busy: number; // open orders at that restaurant
  /** 0..1 closeness to a pedestrian crossing (1 = standing at it). Omit to use a faint district default. */
  crossing?: number;
  /** Pedestrian signal at that crossing is green. Omit to run an internal signal cycle. */
  walk?: boolean;
  /** 0..1 closeness to an owned restaurant (1 = at the counter). Defaults to inside ? 1 : 0. */
  shop?: number;
  /** Cicadas only sing in summer. Defaults to true. */
  summer?: boolean;
}

let ctx: AudioContext | null = null;
let master: GainNode, comp: DynamicsCompressorNode, verb: ConvolverNode;
let sfxBus: GainNode, musicIn: GainNode, musicTape: BiquadFilterNode, duck: GainNode, musicVol: GainNode, ambBus: GainNode;
let outdoor: GainNode, outF: BiquadFilterNode, indoor: GainNode;
let white: AudioBuffer, pink: AudioBuffer, brown: AudioBuffer;
let vol: Settings | null = null;
let scene: AudioScene = { district: 'asakusa', night: 0, inside: false, busy: 0 };
let rainLevel = 0;
let lastStep = 0;

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// ---------------------------------------------------------------- building blocks
function env(g: GainNode, t: number, a: number, peak: number, d: number): void {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(Math.max(0.0002, peak), t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}

function panned(out: AudioNode, pan: number): AudioNode {
  const p = ctx!.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(out);
  return p;
}

function tone(freq: number, t: number, dur: number, type: OscillatorType = 'sine', peak = 0.3, out: AudioNode = sfxBus, freqEnd?: number, attack = 0.005): void {
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + attack + dur);
  env(g, t, attack, peak, dur);
  o.connect(g).connect(out);
  o.start(t); o.stop(t + attack + dur + 0.05);
}

function burst(t: number, dur: number, type: BiquadFilterType, f: number, peak = 0.3, q = 1, out: AudioNode = sfxBus, fEnd?: number, buf: AudioBuffer = white): void {
  if (!ctx) return;
  const src = ctx.createBufferSource(); src.buffer = buf;
  src.playbackRate.value = rnd(0.85, 1.15);
  const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f, t); fl.Q.value = q;
  if (fEnd) fl.frequency.exponentialRampToValueAtTime(fEnd, t + dur);
  const g = ctx.createGain(); env(g, t, 0.003, peak, dur);
  src.connect(fl).connect(g).connect(out);
  src.start(t, Math.random() * 2); src.stop(t + dur + 0.05);
}

/** Struck metal: fundamental plus two inharmonic partials that die faster. */
function bell(f: number, t: number, dur: number, peak: number, out: AudioNode = sfxBus): void {
  tone(f, t, dur, 'sine', peak, out, undefined, 0.002);
  tone(f * 2.756, t, dur * 0.45, 'sine', peak * 0.32, out, undefined, 0.002);
  tone(f * 5.404, t, dur * 0.2, 'sine', peak * 0.12, out, undefined, 0.002);
}

/** Wooden bar: warm body plus a quick bright overtone. */
function marimba(f: number, t: number, peak: number, out: AudioNode = sfxBus): void {
  tone(f, t, 0.38, 'sine', peak, out, undefined, 0.003);
  tone(f * 4, t, 0.06, 'sine', peak * 0.25, out, undefined, 0.002);
}

function loopNoise(buf: AudioBuffer, type: BiquadFilterType, f: number, q: number, out: AudioNode): { g: GainNode; f: BiquadFilterNode } {
  const src = ctx!.createBufferSource(); src.buffer = buf; src.loop = true;
  const fl = ctx!.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
  const g = ctx!.createGain(); g.gain.value = 0;
  src.connect(fl).connect(g).connect(out); src.start(0, Math.random() * 2);
  return { g, f: fl };
}

function makeNoise(kind: 'white' | 'pink' | 'brown'): AudioBuffer {
  const sr = ctx!.sampleRate, b = ctx!.createBuffer(1, sr * 3, sr), d = b.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'white') d[i] = w;
    else if (kind === 'pink') { // Paul Kellet's economy pink filter
      b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
    } else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
  }
  return b;
}

/** Small-room-to-street reverb: decaying stereo noise, darkened over time. */
function makeVerb(): ConvolverNode {
  const sr = ctx!.sampleRate, len = Math.floor(sr * 2.2), b = ctx!.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const k = i / len, a = 0.25 + 0.7 * k; // later reflections get duller
      lp = lp * a + (Math.random() * 2 - 1) * (1 - a);
      d[i] = lp * Math.pow(1 - k, 3.2) * (i < sr * 0.012 ? 0 : 1); // short pre-delay
    }
  }
  const v = ctx!.createConvolver(); v.buffer = b;
  return v;
}

// ---------------------------------------------------------------- SFX
const SFX: Record<Sfx, (t: number, v: number) => void> = {
  // satisfying chunky button press: soft thunk, a crisp tick, and a short woody body
  click: (t, v) => {
    tone(230, t, 0.055, 'sine', 0.24 * v, sfxBus, 105, 0.002);
    burst(t, 0.012, 'bandpass', 3800, 0.1 * v, 2.5);
    tone(920, t + 0.003, 0.045, 'triangle', 0.045 * v, sfxBus, 700, 0.002);
  },
  press: (t, v) => SFX.click(t, v),
  hover: (t, v) => {
    tone(rnd(2500, 2700), t, 0.016, 'sine', 0.03 * v, sfxBus, undefined, 0.001);
    burst(t, 0.006, 'highpass', 6500, 0.018 * v, 1);
  },
  pop: (t, v) => { tone(360, t, 0.08, 'sine', 0.24 * v, sfxBus, 920, 0.003); tone(1850, t + 0.05, 0.03, 'sine', 0.035 * v); },
  // money counter roll-up: climbs in pitch while ticks keep coming (see tickStreak)
  tick: (t, v) => {
    const f = 1800 * Math.pow(2, Math.min(tickStreak, 14) / 28);
    tone(f, t, 0.022, 'triangle', 0.05 * v, sfxBus, undefined, 0.001);
    burst(t, 0.008, 'bandpass', f * 2.2, 0.025 * v, 4);
  },
  open: (t, v) => {
    burst(t, 0.2, 'bandpass', 520, 0.13 * v, 1.3, sfxBus, 2600, pink);
    tone(620, t + 0.15, 0.06, 'sine', 0.08 * v, sfxBus, 940, 0.003);
  },
  close: (t, v) => {
    burst(t, 0.17, 'bandpass', 2300, 0.1 * v, 1.3, sfxBus, 480, pink);
    tone(330, t + 0.11, 0.05, 'sine', 0.1 * v, sfxBus, 220, 0.002);
  },
  whoosh: (t, v) => SFX.open(t, v),
  alert: (t, v) => { bell(1568, t, 0.9, 0.07 * v); bell(2093, t + 0.11, 1.1, 0.055 * v); },
  // soft "bu-bu": rounded square, low-passed so it never stings
  error: (t, v) => {
    if (!ctx) return;
    for (const [at, f] of [[0, 165], [0.13, 147]] as const) {
      const o = ctx.createOscillator(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = 'square'; o.frequency.value = f;
      fl.type = 'lowpass'; fl.frequency.value = 750; fl.Q.value = 0.5;
      env(g, t + at, 0.008, 0.075 * v, 0.1);
      o.connect(fl).connect(g).connect(sfxBus); o.start(t + at); o.stop(t + at + 0.16);
    }
  },
  buzz: (t, v) => SFX.error(t, v),
  coin: (t, v) => {
    tone(988, t, 0.05, 'triangle', 0.15 * v, sfxBus, undefined, 0.002);
    tone(1319, t + 0.055, 0.28, 'triangle', 0.15 * v, sfxBus, undefined, 0.002);
    tone(rnd(5200, 6400), t + 0.09, 0.05, 'sine', 0.025 * v, panned(sfxBus, rnd(-0.5, 0.5)));
  },
  // frequent per-sale register "ching": light enough to repeat
  cash: (t, v) => { bell(2637, t, 0.3, 0.045 * v); bell(3520, t + 0.035, 0.25, 0.03 * v); },
  // big ka-ching: drawer clunk, rattle, register bell, then a spray of coin sparkles
  purchase: (t, v) => {
    burst(t, 0.05, 'lowpass', 900, 0.28 * v, 1, sfxBus, undefined, brown);
    tone(150, t, 0.06, 'sine', 0.22 * v, sfxBus, 70, 0.002);
    burst(t + 0.045, 0.08, 'bandpass', 2600, 0.1 * v, 3);
    bell(2093, t + 0.09, 0.95, 0.1 * v); bell(2637, t + 0.1, 0.85, 0.08 * v); bell(3136, t + 0.11, 0.7, 0.05 * v);
    for (let i = 0; i < 9; i++) {
      const at = t + 0.14 + i * rnd(0.04, 0.07);
      tone(rnd(4800, 8800), at, 0.06, 'sine', (0.045 - i * 0.004) * v, panned(sfxBus, rnd(-0.7, 0.7)), undefined, 0.001);
    }
  },
  // new staff: friendly rising marimba "welcome" and a small bell
  hire: (t, v) => {
    [67, 72, 76].forEach((n, i) => marimba(midi(n), t + i * 0.085, 0.17 * v));
    bell(midi(84), t + 0.27, 0.7, 0.05 * v);
    tone(420, t + 0.26, 0.07, 'sine', 0.08 * v, sfxBus, 900, 0.003);
  },
  upgrade: (t, v) => {
    [72, 76, 79, 84].forEach((n, i) => bell(midi(n), t + i * 0.07, 0.6, 0.075 * v));
    for (let i = 0; i < 5; i++) tone(midi(96 + (i % 3) * 3), t + 0.3 + i * 0.045, 0.1, 'sine', 0.025 * v, panned(sfxBus, rnd(-0.6, 0.6)));
  },
  levelup: (t, v) => {
    [72, 76, 79, 83, 86].forEach((n, i) => marimba(midi(n), t + i * 0.075, 0.14 * v));
    [72, 79, 84, 88].forEach((n) => bell(midi(n), t + 0.4, 1.6, 0.045 * v));
    burst(t + 0.38, 0.9, 'highpass', 7500, 0.03 * v, 0.7);
    for (let i = 0; i < 8; i++) tone(midi(98 + (i % 4) * 2), t + 0.45 + i * 0.06, 0.12, 'sine', 0.02 * v, panned(sfxBus, rnd(-0.7, 0.7)));
  },
  success: (t, v) => { marimba(midi(79), t, 0.16 * v); bell(midi(84), t + 0.1, 0.5, 0.07 * v); },
  milestone: (t, v) => {
    [[72, 76, 79], [74, 77, 81], [76, 79, 84]].forEach((ch, i) => ch.forEach((n) => tone(midi(n), t + i * 0.22, 0.9, 'triangle', 0.08 * v)));
    bell(midi(96), t + 0.66, 1.4, 0.04 * v);
  },
  fanfare: (t, v) => {
    const brass = (n: number, at: number, d: number) => {
      if (!ctx) return;
      const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.value = midi(n);
      f.type = 'lowpass'; f.frequency.setValueAtTime(600, at); f.frequency.linearRampToValueAtTime(2400, at + 0.08);
      env(g, at, 0.03, 0.08 * v, d);
      o.connect(f).connect(g).connect(sfxBus); o.start(at); o.stop(at + d + 0.1);
    };
    [67, 72, 76].forEach((n, i) => brass(n, t + i * 0.13, 0.2));
    [72, 76, 79, 84].forEach((n) => brass(n, t + 0.42, 1.3));
    tone(midi(55), t + 0.42, 0.5, 'sine', 0.26 * v, sfxBus, midi(43));
  },
  chop: (t, v) => { burst(t, 0.03, 'highpass', 2200, 0.22 * v); tone(160, t, 0.05, 'sine', 0.22 * v, sfxBus, 90); },
  fail: (t, v) => tone(300, t, 0.25, 'triangle', 0.05 * v, sfxBus, 150),
  door: (t, v) => { bell(midi(76), t, 1.0, 0.09 * v); bell(midi(72), t + 0.25, 1.3, 0.09 * v); },
  firework: (t, v) => {
    burst(t, 0.6, 'bandpass', 300, 0.22 * v, 0.6, sfxBus, 6000); // whistle-up
    burst(t + 0.6, 1.0, 'lowpass', 1800, 0.36 * v, 0.7, sfxBus, 150, brown); // boom
    for (let i = 0; i < 10; i++) burst(t + 0.8 + Math.random() * 0.9, 0.02, 'highpass', 5000, 0.07 * v);
  },
  step: (t, v) => burst(t, 0.06, 'lowpass', rnd(500, 900), 0.11 * v, 1.5),
};

// minimum gap between repeats (s): keeps rapid UI from machine-gunning
const GAP: Partial<Record<Sfx, number>> = { hover: 0.045, tick: 0.05, cash: 0.09, coin: 0.05, click: 0.03, press: 0.03, pop: 0.03, error: 0.15, buzz: 0.15, alert: 0.3, fail: 0.2 };
// music duck per sound: [gain while ducked, hold seconds]
const DUCK: Partial<Record<Sfx, [number, number]>> = {
  click: [0.75, 0.12], press: [0.75, 0.12], pop: [0.75, 0.12], open: [0.7, 0.25], close: [0.7, 0.2], whoosh: [0.7, 0.25],
  alert: [0.6, 0.6], error: [0.6, 0.3], buzz: [0.6, 0.3], coin: [0.65, 0.3], purchase: [0.35, 1.0], hire: [0.45, 0.7],
  upgrade: [0.45, 0.7], levelup: [0.3, 1.4], success: [0.55, 0.5], milestone: [0.3, 1.5], fanfare: [0.25, 1.8], door: [0.6, 1.0],
};
const lastPlayed = new Map<Sfx, number>();
let tickStreak = 0;

function duckMusic(depth: number, hold: number): void {
  const t = ctx!.currentTime, g = duck.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.setTargetAtTime(Math.min(depth, g.value), t, 0.02);
  g.setTargetAtTime(1, t + hold, 0.35);
}

// ---------------------------------------------------------------- music: generative lo-fi / city pop
// Each chord: bass root + an upper-structure electric-piano voicing. Two 4-bar sections per variant.
type Chord = { bass: number; v: number[] };
const DAY: Chord[][] = [ // D major: Gmaj9 F#m7 Em9 A13 | Bm9 Gmaj9 Em9 A7sus4
  [{ bass: 43, v: [59, 62, 66, 69] }, { bass: 42, v: [57, 61, 64, 66] }, { bass: 40, v: [55, 59, 62, 66] }, { bass: 45, v: [55, 59, 61, 66] }],
  [{ bass: 47, v: [57, 61, 62, 66] }, { bass: 43, v: [59, 62, 66, 69] }, { bass: 40, v: [55, 59, 62, 66] }, { bass: 45, v: [55, 62, 64, 69] }],
];
const NIGHT: Chord[][] = [ // Ab / F minor: Dbmaj9 Cm7 Bbm9 Eb13 | Abmaj7 Fm9 Dbmaj7 C7b9
  [{ bass: 37, v: [60, 63, 65, 68] }, { bass: 36, v: [58, 60, 63, 67] }, { bass: 34, v: [56, 60, 61, 65] }, { bass: 39, v: [55, 60, 61, 65] }],
  [{ bass: 44, v: [56, 60, 63, 67] }, { bass: 41, v: [56, 60, 63, 67] }, { bass: 37, v: [56, 60, 61, 65] }, { bass: 36, v: [58, 61, 64, 67] }],
];
const LEAD_DAY = [66, 69, 71, 74, 76, 78, 81, 83]; // D major pentatonic
const LEAD_NIGHT = [65, 68, 70, 72, 75, 77, 80, 82]; // Ab major / F minor pentatonic
const DRUMS: Record<string, number> = { asakusa: 0.75, shibuya: 1, shinjuku: 0.95, ginza: 0.8 };

let mNext = 0, mStep = 0, mBar = 0, mNight = false, motif: (number | null)[] = [];

const wow = (t: number) => 7 * Math.sin(t * 2.3) + 3 * Math.sin(t * 0.7); // tape flutter, in cents

// Karplus-Strong pluck (koto-like lead), pre-rendered per note
const plucks = new Map<number, AudioBuffer>();
function pluckBuf(n: number): AudioBuffer {
  let b = plucks.get(n);
  if (b) return b;
  const sr = ctx!.sampleRate, len = Math.floor(sr * 1.6);
  b = ctx!.createBuffer(1, len, sr);
  const d = b.getChannelData(0), p = Math.max(2, Math.round(sr / midi(n))), ring = new Float32Array(p);
  for (let i = 0; i < p; i++) ring[i] = Math.random() * 2 - 1;
  for (let i = 0, idx = 0; i < len; i++) {
    const nxt = (idx + 1) % p, v = ring[idx];
    ring[idx] = 0.4985 * (v + ring[nxt]);
    d[i] = v * (i < 40 ? i / 40 : 1);
    idx = nxt;
  }
  plucks.set(n, b);
  return b;
}

function lead(n: number, t: number, peak: number): void {
  const src = ctx!.createBufferSource(); src.buffer = pluckBuf(n); src.detune.value = wow(t);
  const g = ctx!.createGain(); g.gain.value = peak;
  src.connect(g).connect(panned(musicIn, rnd(-0.3, 0.3))); src.start(t);
}

/** FM electric piano: modulation index decays fast for the bell-like tine attack. */
function ep(n: number, t: number, dur: number, vel: number, pan: number): void {
  const f = midi(n), c = ctx!.createOscillator(), m = ctx!.createOscillator(), mg = ctx!.createGain(), g = ctx!.createGain();
  c.frequency.value = f; m.frequency.value = f;
  c.detune.value = m.detune.value = wow(t);
  mg.gain.setValueAtTime(f * 1.4 * vel, t); mg.gain.exponentialRampToValueAtTime(f * 0.06, t + 0.6);
  m.connect(mg).connect(c.frequency);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.05 * vel, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.024 * vel, t + 0.3);
  g.gain.setTargetAtTime(0.0001, t + dur, 0.12);
  c.connect(g).connect(panned(musicIn, pan));
  c.start(t); m.start(t); c.stop(t + dur + 0.7); m.stop(t + dur + 0.7);
}

function bass(n: number, t: number, dur: number, vel: number): void {
  const o = ctx!.createOscillator(), s = ctx!.createOscillator(), f = ctx!.createBiquadFilter(), g = ctx!.createGain();
  o.type = 'triangle'; o.frequency.value = midi(n); s.frequency.value = midi(n);
  f.type = 'lowpass'; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(320, t + 0.15);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.16 * vel, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.09 * vel, t + 0.12);
  g.gain.setTargetAtTime(0.0001, t + dur, 0.05);
  o.connect(f); s.connect(f); f.connect(g).connect(musicIn);
  o.start(t); s.start(t); o.stop(t + dur + 0.4); s.stop(t + dur + 0.4);
}

function newMotif(): void {
  const sc = mNight ? LEAD_NIGHT : LEAD_DAY;
  let i = Math.floor(rnd(2, 5));
  motif = Array.from({ length: 16 }, (_, k) => {
    if (Math.random() < (k % 2 ? 0.75 : 0.45)) return null; // weak 8ths rest more often
    i = Math.max(0, Math.min(sc.length - 1, i + Math.round(rnd(-2.2, 2.2))));
    return i;
  });
}

function musicStep(t: number, s16: number): void {
  const prog = mNight ? NIGHT : DAY;
  const chord = prog[Math.floor(mBar / 4) % 2][mBar % 4];
  const nextChord = prog[Math.floor((mBar + 1) / 4) % 2][(mBar + 1) % 4];
  const d = (DRUMS[scene.district] ?? 0.85) * (mNight ? 0.7 : 1);
  const st = mStep, r = chord.bass;

  // electric piano comping
  const hits: Record<number, [number, number]> = mNight ? { 0: [0.75, 8], 8: [0.4, 8] } : { 0: [0.8, 6], 6: [0.5, 4], 10: [0.6, 6] };
  const h = hits[st];
  if (h && (st === 0 || Math.random() < (mNight ? 0.5 : 0.85))) chord.v.forEach((n, i) => ep(n, t + i * 0.006, h[1] * s16, h[0], (i - 1.5) * 0.18));

  // bass line
  if (mNight) {
    if (st === 0) bass(r, t, 6 * s16, 1);
    else if (st === 10) bass(r + 7, t, 3 * s16, 0.7);
    else if (st === 14 && Math.random() < 0.4) bass(r + 12, t, s16, 0.5);
  } else {
    if (st === 0 || st === 6) bass(r, t, 2.5 * s16, st ? 0.8 : 1);
    else if (st === 3 && Math.random() < 0.5) bass(r + 12, t, s16 * 0.8, 0.55);
    else if (st === 10) bass(r + 7, t, 2 * s16, 0.75);
    else if (st === 13 && Math.random() < 0.4) bass(r + 12, t, s16 * 0.8, 0.5);
    else if (st === 14 && Math.random() < 0.55) bass(nextChord.bass - 1, t, s16 * 1.5, 0.6); // chromatic approach
  }

  // drums
  if (st === 0 || st === 10 || (st === 7 && !mNight && Math.random() < 0.3)) tone(115, t, 0.22, 'sine', 0.3 * d * (st ? 0.75 : 1), musicIn, 42, 0.002);
  if (mNight) {
    if (st === 12) { tone(1700, t, 0.02, 'triangle', 0.035 * d, musicIn); burst(t, 0.015, 'bandpass', 2600, 0.05 * d, 2, musicIn); }
    if (st % 4 === 2) burst(t, 0.05, 'bandpass', 6200, 0.012 * d, 1.5, musicIn);
  } else {
    if (st === 4 || st === 12) { burst(t, 0.13, 'bandpass', 1900, 0.08 * d, 0.8, musicIn); tone(185, t, 0.06, 'triangle', 0.045 * d, musicIn, 150); }
    if (st % 2 === 0 || (st === 15 && Math.random() < 0.5)) burst(t, 0.03, 'highpass', 7500, (st % 4 === 2 ? 0.028 : 0.016) * d, 1, musicIn);
  }

  // koto lead on alternate 8-bar sections; rests in the phrase's last bar
  if (Math.floor(mBar / 8) % 2 === 1 && mBar % 8 !== 7 && st % 2 === 0) {
    const sc = mNight ? LEAD_NIGHT : LEAD_DAY;
    const idx = motif[(mBar % 2) * 8 + st / 2];
    if (idx !== null && idx !== undefined) lead(sc[Math.min(sc.length - 1, idx + (mBar % 4 >= 2 ? 1 : 0))], t, mNight ? 0.13 : 0.16);
  }

  // vinyl crackle
  if (Math.random() < 0.14) burst(t + rnd(0, s16), 0.004, 'highpass', 2500, rnd(0.008, 0.025), 1, musicIn);
}

function scheduleMusic(): void {
  const now = ctx!.currentTime;
  if (mNext < now - 0.5) mNext = now + 0.05; // tab was hidden: don't burst-catch-up
  while (mNext < now + 0.3) {
    if (mStep === 0 && mBar % 8 === 0) { // day/night switch only on a phrase boundary
      const night = scene.night > 0.5;
      if (night !== mNight || !motif.length) { mNight = night; musicTape.frequency.setTargetAtTime(night ? 2400 : 4800, mNext, 1.5); }
      newMotif();
    }
    const s16 = 60 / (mNight ? 72 : 88) / 4;
    musicStep(mNext + (mStep % 2 ? s16 * (mNight ? 0.22 : 0.16) : 0), s16); // swing
    mNext += s16;
    if (++mStep === 16) { mStep = 0; mBar++; }
  }
}

// ---------------------------------------------------------------- ambience
interface Place { traffic: number; crowd: number; crossing: number; jingle: number; train: number; nightlife: number; nature: number; cicada: number }
const PLACES: Record<string, Place> = {
  asakusa: { traffic: 0.45, crowd: 0.6, crossing: 0.15, jingle: 0.5, train: 0.4, nightlife: 0.2, nature: 1, cicada: 1 },
  shibuya: { traffic: 0.85, crowd: 1, crossing: 0.55, jingle: 0.8, train: 0.6, nightlife: 0.9, nature: 0.15, cicada: 0 },
  shinjuku: { traffic: 1, crowd: 0.85, crossing: 0.35, jingle: 0.6, train: 1, nightlife: 1, nature: 0.1, cicada: 0 },
  ginza: { traffic: 0.7, crowd: 0.55, crossing: 0.4, jingle: 0.35, train: 0.3, nightlife: 0.4, nature: 0.2, cicada: 0 },
};
const JINGLES = [[84, 79, 81, 76], [72, 76, 79, 84, 79], [88, 84, 86, 79, 81], [79, 83, 86, 91]];

interface Voice { f1: BiquadFilterNode; f2: BiquadFilterNode; g: GainNode; next: number; out: 0 | 1 }
let voices: Voice[] = [];
let traffic: GainNode, rainHiss: GainNode, rainPatter: GainNode, roof: GainNode, room: GainNode, sizzle: GainNode, cicadaG: GainNode, cicadaPhrase: GainNode;
const mix = { t: 0, crowd: 0, shop: 0, indoorTalk: 0, sizzle: 0, sizzleNext: 0, out: 1 };
const ev = { car: 2, walker: 1.5, jingle: 10, train: 20, bird: 4, clatter: 1, cicada: 0.5, drip: 0, firework: 0, fireworkT: 0 };
let chirpNext = 0, sigT = 0, lastWalk = false, chirpKind = 0, chirpSide = 1;

function buildAmbience(): void {
  outdoor = ctx!.createGain(); outF = ctx!.createBiquadFilter(); outF.type = 'lowpass'; outF.frequency.value = 16000; outF.Q.value = 0.5;
  outdoor.connect(outF).connect(ambBus);
  indoor = ctx!.createGain(); indoor.connect(ambBus);

  traffic = loopNoise(brown, 'lowpass', 240, 0.5, outdoor).g;
  rainHiss = loopNoise(pink, 'highpass', 1100, 0.5, outdoor).g;
  rainPatter = loopNoise(white, 'bandpass', 2900, 0.8, outdoor).g;
  roof = loopNoise(brown, 'lowpass', 700, 0.6, indoor).g;
  room = loopNoise(pink, 'lowpass', 320, 0.5, indoor).g;
  sizzle = loopNoise(white, 'highpass', 4800, 0.7, indoor).g;

  // cicada: narrow noise band, amplitude-modulated at wing rate, shaped into phrases
  const c = loopNoise(white, 'bandpass', 4400, 5, outdoor);
  c.f.disconnect(); c.g.disconnect();
  const am = ctx!.createGain(); am.gain.value = 0.5;
  const lfo = ctx!.createOscillator(), depth = ctx!.createGain();
  lfo.frequency.value = 24; depth.gain.value = 0.5; lfo.connect(depth).connect(am.gain); lfo.start();
  cicadaPhrase = ctx!.createGain(); cicadaPhrase.gain.value = 0;
  cicadaG = c.g;
  c.f.connect(am).connect(cicadaPhrase).connect(cicadaG).connect(outdoor);

  // crowd voices: pink noise through two moving formants each; three outside, two in the shop
  voices = [0, 0, 0, 1, 1].map((out, i) => {
    const src = ctx!.createBufferSource(); src.buffer = pink; src.loop = true;
    const f1 = ctx!.createBiquadFilter(), f2 = ctx!.createBiquadFilter(), g = ctx!.createGain();
    f1.type = f2.type = 'bandpass'; f1.Q.value = 3.5; f2.Q.value = 5; f1.frequency.value = 600; f2.frequency.value = 1700;
    g.gain.value = 0;
    const p = panned(out ? indoor : outdoor, [-0.6, 0.1, 0.65, -0.3, 0.35][i]);
    src.connect(f1).connect(g); src.connect(f2).connect(g); g.connect(p);
    src.start(0, Math.random() * 3);
    return { f1, f2, g, next: 0, out: out as 0 | 1 };
  });
}

/** Re-aim every continuous layer at the current scene. Runs a few times a second. */
function mixAmbience(): void {
  const t = ctx!.currentTime, P = PLACES[scene.district] ?? PLACES.asakusa, n = clamp01(scene.night), day = 1 - n;
  const rain = Math.max(rainLevel, scene.rain ? 1 : 0);
  const shop = clamp01(scene.shop ?? (scene.inside ? 1 : 0));
  const busyN = Math.min(1, scene.busy / 6);
  mix.shop = shop;
  mix.out = 1 - 0.5 * shop;
  mix.crowd = P.crowd * (1 - n * (1 - P.nightlife) * 0.7) * (1 - rain * 0.5);
  mix.indoorTalk = shop * (0.45 + 0.55 * busyN);
  mix.sizzle = shop * (0.3 + 0.7 * busyN);
  const T = 0.7;
  outdoor.gain.setTargetAtTime(mix.out, t, T);
  outF.frequency.setTargetAtTime(16000 * Math.pow(0.05, shop), t, T); // 16 kHz outside, ~800 Hz through the shop walls
  indoor.gain.setTargetAtTime(shop, t, T);
  traffic.gain.setTargetAtTime(0.13 * P.traffic * (1 - n * 0.35 * (1 - P.nightlife * 0.6)), t, T);
  rainHiss.gain.setTargetAtTime(0.11 * rain, t, 1.2);
  rainPatter.gain.setTargetAtTime(0.035 * rain * rain, t, 1.2);
  roof.gain.setTargetAtTime(0.09 * rain, t, 1.2);
  room.gain.setTargetAtTime(0.05 * (0.5 + 0.5 * busyN), t, T);
  cicadaG.gain.setTargetAtTime(0.03 * P.cicada * (scene.summer === false ? 0 : 1) * day * day * (1 - rain), t, 2);
}

function updateVoices(now: number): void {
  for (const v of voices) {
    if (now < v.next) continue;
    v.next = now + rnd(0.08, 0.24); // roughly syllable rate
    const level = v.out ? 0.05 * mix.indoorTalk : 0.045 * mix.crowd;
    const talk = Math.random() < 0.18 ? 0.08 : rnd(0.3, 1); // brief pauses between phrases
    v.g.gain.setTargetAtTime(level * talk, now, 0.04);
    v.f1.frequency.setTargetAtTime(rnd(330, 880), now, 0.05);
    v.f2.frequency.setTargetAtTime(rnd(1100, 2500), now, 0.05);
  }
  if (now >= mix.sizzleNext) { // sizzle crackles instead of hissing evenly
    mix.sizzleNext = now + rnd(0.025, 0.07);
    sizzle.gain.setTargetAtTime(0.022 * mix.sizzle * rnd(0.3, 1.5), now, 0.015);
  }
}

function carPass(t: number, level: number, scooter: boolean): void {
  const dur = rnd(2.2, 4), dir = Math.random() < 0.5 ? -1 : 1, mid = t + dur * rnd(0.4, 0.6);
  const p = ctx!.createStereoPanner();
  p.pan.setValueAtTime(-0.85 * dir, t); p.pan.linearRampToValueAtTime(0.85 * dir, t + dur);
  const g = ctx!.createGain();
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(level, mid); g.gain.linearRampToValueAtTime(0, t + dur);
  g.connect(p).connect(outdoor);
  const src = ctx!.createBufferSource(); src.buffer = pink; src.loop = true;
  const f = ctx!.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 0.8;
  f.frequency.setValueAtTime(280, t); f.frequency.linearRampToValueAtTime(950, mid); f.frequency.linearRampToValueAtTime(300, t + dur);
  src.connect(f).connect(g); src.start(t, Math.random() * 2); src.stop(t + dur + 0.1);
  if (scooter) { // small engine buzz with a falling doppler pitch
    const o = ctx!.createOscillator(), of = ctx!.createBiquadFilter(), og = ctx!.createGain();
    o.type = 'sawtooth'; of.type = 'lowpass'; of.frequency.value = 800; og.gain.value = 0.25;
    o.frequency.setValueAtTime(128, t); o.frequency.linearRampToValueAtTime(120, mid); o.frequency.linearRampToValueAtTime(96, t + dur);
    o.connect(of).connect(og).connect(g); o.start(t); o.stop(t + dur + 0.1);
  }
}

function trainPass(t: number, level: number): void {
  const dur = rnd(8, 12);
  const shape = (k: number) => Math.min(1, k / (dur * 0.4), (dur - k) / (dur * 0.35));
  const src = ctx!.createBufferSource(); src.buffer = brown; src.loop = true;
  const f = ctx!.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 170;
  const g = ctx!.createGain();
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(level, t + dur * 0.4);
  g.gain.setValueAtTime(level, t + dur * 0.65); g.gain.linearRampToValueAtTime(0, t + dur);
  src.connect(f).connect(g).connect(outdoor); src.start(t); src.stop(t + dur + 0.1);
  for (let k = 0.6; k < dur - 0.4; k += 0.74) { // ta-tan ... ta-tan over the rail joints
    const e = Math.max(0, shape(k)) * level * 0.7;
    burst(t + k, 0.035, 'lowpass', 520, e, 1.2, outdoor, undefined, brown);
    burst(t + k + 0.14, 0.035, 'lowpass', 480, e * 0.85, 1.2, outdoor, undefined, brown);
  }
}

function sparrows(t: number, g: number): void {
  const p = panned(outdoor, rnd(-0.8, 0.8));
  for (let i = 0, at = t; i < 2 + Math.floor(rnd(0, 4)); i++, at += rnd(0.1, 0.22)) tone(rnd(4200, 5400), at, 0.045, 'sine', g, p, rnd(2900, 3500), 0.004);
}

function crow(t: number, g: number): void {
  const p = panned(outdoor, rnd(-0.9, 0.9));
  for (let i = 0; i < 2 + Math.floor(rnd(0, 2)); i++) {
    const at = t + i * rnd(0.5, 0.65), o = ctx!.createOscillator(), f = ctx!.createBiquadFilter(), e = ctx!.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(640, at); o.frequency.exponentialRampToValueAtTime(500, at + 0.32);
    f.type = 'bandpass'; f.frequency.value = 1350; f.Q.value = 2.5;
    env(e, at, 0.03, g, 0.3);
    o.connect(f).connect(e).connect(p); o.start(at); o.stop(at + 0.4);
  }
}

function jingle(t: number, g: number): void {
  const p = panned(outdoor, rnd(-0.8, 0.8));
  pick(JINGLES).forEach((n, i) => bell(midi(n), t + i * 0.17, 0.8, g, p));
}

function piyo(t: number, g: number, pan: number): void { // chick-call crossing signal
  const p = panned(outdoor, pan);
  tone(3150, t, 0.035, 'sine', g, p, 2800, 0.003);
  tone(2900, t + 0.05, 0.08, 'sine', g * 0.9, p, 2050, 0.003);
}

function kakko(t: number, g: number, pan: number): void { // cuckoo-call crossing signal
  const p = panned(outdoor, pan);
  tone(1030, t, 0.1, 'triangle', g, p, 1000, 0.01);
  tone(830, t + 0.17, 0.16, 'triangle', g * 0.85, p, 810, 0.01);
}

function cicadaSong(t: number): void { // miiin ... min-min-min ... miii
  const g = cicadaPhrase.gain, swell = rnd(1.2, 2);
  g.cancelScheduledValues(t); g.setValueAtTime(0, t);
  g.linearRampToValueAtTime(1, t + swell);
  let at = t + swell + rnd(0.5, 1.2);
  g.setValueAtTime(1, at);
  for (let i = 0; i < 5 + Math.floor(rnd(0, 5)); i++, at += 0.34) { g.linearRampToValueAtTime(0.25, at + 0.12); g.linearRampToValueAtTime(1, at + 0.3); }
  g.linearRampToValueAtTime(0, at + rnd(1, 2));
}

function clatter(t: number, g: number): void {
  const r = Math.random();
  if (r < 0.55) { // plates and cups
    for (let i = 0; i < 1 + Math.floor(rnd(0, 3)); i++) {
      const at = t + i * rnd(0.05, 0.14), f = rnd(2200, 3600);
      tone(f, at, 0.08, 'sine', g, indoor, undefined, 0.001);
      tone(f * 2.71, at, 0.04, 'sine', g * 0.4, indoor, undefined, 0.001);
    }
  } else if (r < 0.85) { // knife on the board
    for (let i = 0, n = 3 + Math.floor(rnd(0, 4)); i < n; i++) {
      tone(rnd(280, 340), t + i * 0.13, 0.03, 'sine', g * 1.5, indoor, 200, 0.001);
      burst(t + i * 0.13, 0.02, 'bandpass', 1600, g * 0.8, 2, indoor);
    }
  } else burst(t, 0.12, 'bandpass', 900, g * 1.2, 1.5, indoor, 2200); // pot lid / tray slide
}

function crossingSignal(dt: number, P: Place): void {
  const now = ctx!.currentTime;
  const c = clamp01(scene.crossing ?? P.crossing);
  const g = 0.05 * Math.pow(c, 1.4) * (1 - clamp01(scene.night) * 0.85) * (1 - 0.6 * mix.shop); // most signals go quiet late at night
  let walk: boolean;
  if (scene.walk === undefined) { sigT = (sigT + dt) % 30; walk = sigT < 11; } else walk = scene.walk;
  if (walk && !lastWalk) chirpKind ^= 1; // the two directions alternate between piyo and kakko
  lastWalk = walk;
  if (!walk || g < 0.0015) { chirpNext = 0; return; }
  if (chirpNext < now) chirpNext = now + 0.05;
  while (chirpNext < now + 0.2) {
    chirpSide = -chirpSide; // speakers on both kerbs answer each other
    if (chirpKind) piyo(chirpNext, g, chirpSide * 0.5); else kakko(chirpNext, g, chirpSide * 0.5);
    chirpNext += chirpKind ? 0.5 : 0.9;
  }
}

function ambientEvents(dt: number): void {
  const t = ctx!.currentTime + 0.02, P = PLACES[scene.district] ?? PLACES.asakusa, n = clamp01(scene.night), day = 1 - n;
  const rain = Math.max(rainLevel, scene.rain ? 1 : 0), summer = scene.summer !== false;
  crossingSignal(dt, P);

  if ((ev.car -= dt) <= 0) {
    ev.car = rnd(2, 7) / (P.traffic * (1 - n * 0.4) + 0.1);
    carPass(t, rnd(0.04, 0.08) * (0.6 + 0.4 * P.traffic), Math.random() < (P.nature > 0.5 ? 0.3 : 0.12));
  }
  if ((ev.walker -= dt) <= 0) { // passers-by footsteps
    ev.walker = rnd(1, 4) / (mix.crowd + 0.15);
    if (mix.shop < 0.8) {
      const p = panned(outdoor, rnd(-0.9, 0.9)), heel = Math.random() < 0.3, gap = rnd(0.45, 0.6);
      for (let i = 0, k = 4 + Math.floor(rnd(0, 5)); i < k; i++) {
        const e = rnd(0.012, 0.022) * Math.sin(Math.PI * (i + 0.5) / k);
        burst(t + i * gap, heel ? 0.02 : 0.035, 'bandpass', heel ? 3100 : rnd(1100, 1800), e, heel ? 4 : 1.2, p);
      }
    }
  }
  if ((ev.jingle -= dt) <= 0) {
    ev.jingle = rnd(14, 34) / (P.jingle * (day + 0.5 * n) + 0.05);
    jingle(t, 0.025);
  }
  if ((ev.train -= dt) <= 0) {
    ev.train = rnd(25, 65) / (P.train + 0.2);
    trainPass(t, 0.07 * (0.5 + 0.5 * P.train));
  }
  if ((ev.bird -= dt) <= 0) {
    ev.bird = rnd(5, 13);
    if (rain < 0.3) {
      if (day > 0.6) { if (Math.random() < 0.8) sparrows(t, 0.012 * (0.3 + P.nature)); else crow(t, 0.02); }
      else if (n > 0.6 && P.nature > 0.5 && summer) for (let i = 0; i < 12; i++) tone(4600, t + i * 0.05 + (i > 5 ? 0.4 : 0), 0.025, 'sine', 0.012, outdoor); // crickets
    }
  }
  if (P.cicada && summer && day > 0.5 && rain < 0.3 && (ev.cicada -= dt) <= 0) {
    ev.cicada = rnd(7, 15);
    cicadaSong(t);
  }
  if (rain > 0.05 && (ev.drip -= dt) <= 0) { // individual drops on awnings and puddles
    ev.drip = rnd(0.03, 0.2) / rain;
    tone(rnd(1600, 4200), t, 0.025, 'sine', 0.014 * rain, panned(outdoor, rnd(-1, 1)), rnd(900, 1500), 0.001);
  }
  if (mix.shop > 0.1 && (ev.clatter -= dt) <= 0) {
    ev.clatter = rnd(0.7, 2.6) / (0.4 + Math.min(1, scene.busy / 6));
    clatter(t, 0.018);
  }
  if (ev.firework > 0) {
    ev.firework -= dt; ev.fireworkT -= dt;
    if (ev.fireworkT <= 0) { ev.fireworkT = rnd(0.6, 1.8); SFX.firework(t, 0.7); }
  }
}

// ---------------------------------------------------------------- public API
function applyVolumes(): void {
  if (!ctx || !vol) return;
  const t = ctx.currentTime;
  master.gain.setTargetAtTime(vol.muted ? 0 : vol.master, t, 0.05);
  sfxBus.gain.setTargetAtTime(vol.sfx, t, 0.05);
  musicVol.gain.setTargetAtTime(vol.music * 0.5, t, 0.3);
  ambBus.gain.setTargetAtTime(vol.sfx * 0.8, t, 0.05);
}

let subscribed = false;
function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  on('customerLeft', (e) => { if (e.customerId !== null && e.reason !== 'closed') audio.sfx('fail', 0.6); });
  on('dayEnd', () => audio.sfx('door', 0.6));
  on('million', () => { ev.firework = 40; ev.fireworkT = 0.5; });
  document.addEventListener('visibilitychange', () => { // silence in background tabs
    if (!ctx) return;
    if (document.hidden) void ctx.suspend(); else void ctx.resume();
  });
}

export const audio = {
  /** Call on first user gesture (browser autoplay policy). Safe to call repeatedly. */
  unlock(): void {
    try {
      if (!ctx) {
        const AC = window.AudioContext || (window as any).webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        master = ctx.createGain(); master.connect(ctx.destination);
        comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -20; comp.knee.value = 16; comp.ratio.value = 3.5; comp.attack.value = 0.006; comp.release.value = 0.24;
        comp.connect(master);
        verb = makeVerb(); verb.connect(comp);
        const send = (from: AudioNode, amt: number) => { const g = ctx!.createGain(); g.gain.value = amt; from.connect(g).connect(verb); };

        sfxBus = ctx.createGain(); sfxBus.connect(comp); send(sfxBus, 0.12);
        ambBus = ctx.createGain(); ambBus.connect(comp); send(ambBus, 0.18);
        musicIn = ctx.createGain();
        musicTape = ctx.createBiquadFilter(); musicTape.type = 'lowpass'; musicTape.frequency.value = 4800; musicTape.Q.value = 0.4;
        duck = ctx.createGain(); musicVol = ctx.createGain(); musicVol.gain.value = 0;
        musicIn.connect(musicTape).connect(duck).connect(musicVol).connect(comp); send(musicVol, 0.3);

        white = makeNoise('white'); pink = makeNoise('pink'); brown = makeNoise('brown');
        buildAmbience();
        mNext = ctx.currentTime + 0.5;
        subscribe();
        applyVolumes();
      }
      if (ctx.state === 'suspended' && !document.hidden) void ctx.resume();
    } catch { ctx = null; }
  },
  sfx(name: Sfx, v = 1): void {
    if (!ctx || ctx.state !== 'running') return;
    try {
      const now = ctx.currentTime, last = lastPlayed.get(name) ?? -1;
      if (now - last < (GAP[name] ?? 0.02)) return;
      if (name === 'tick') tickStreak = now - last < 0.3 ? tickStreak + 1 : 0;
      lastPlayed.set(name, now);
      const d = DUCK[name];
      if (d) duckMusic(d[0], d[1]);
      SFX[name]?.(now + 0.005, v);
    } catch { /* never break gameplay for audio */ }
  },
  step(running: boolean): void {
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - lastStep < 0.12) return;
    lastStep = now;
    audio.sfx('step', running ? 1.3 : 0.9);
  },
  setVolumes(s: Settings): void { vol = s; applyVolumes(); },
  /** Where the listener is: district, time of day, and closeness to crossings and owned shops. Call every frame. */
  setScene(o: AudioScene): void { scene = o; },
  /** Rain intensity 0..1 (weather system). */
  setRain(v: number): void { rainLevel = clamp01(v); },
  update(dt: number): void {
    if (!ctx || ctx.state !== 'running') return;
    try {
      const now = ctx.currentTime;
      if ((mix.t -= dt) <= 0) { mix.t = 0.2; mixAmbience(); }
      updateVoices(now);
      scheduleMusic();
      ambientEvents(Math.min(dt, 0.25));
    } catch { /* never let audio kill the game loop */ }
  },
};
