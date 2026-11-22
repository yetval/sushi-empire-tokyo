// All audio synthesized at runtime with the Web Audio API — no files, fully original.
// SFX, street/rain/chatter ambience, and generative pentatonic "koto" music.
import { on } from '../core/bus';
import { Settings } from '../core/state';

export type Sfx = 'click' | 'coin' | 'cash' | 'upgrade' | 'chop' | 'success' | 'fail' | 'whoosh' | 'milestone' | 'fanfare' | 'door' | 'pop' | 'error' | 'firework' | 'step' | 'perfect';

let ctx: AudioContext | null = null;
let master: GainNode, sfxBus: GainNode, musicBus: GainNode, ambBus: GainNode;
let noise: AudioBuffer;
let street: GainNode, rainG: GainNode, chatter: GainNode, chatterF: BiquadFilterNode;
let vol: Settings | null = null;
let scene = { district: 'asakusa', night: 0, rain: false, inside: false, busy: 0 };
let applied: typeof scene | null = null; // last ambience values pushed to the graph
let lastStep = 0;

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

function env(g: GainNode, t: number, a: number, peak: number, d: number): void {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}

function tone(freq: number, t: number, dur: number, type: OscillatorType = 'sine', peak = 0.3, out: AudioNode = sfxBus, freqEnd?: number, attack = 0.005): void {
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
  env(g, t, attack, peak, dur);
  o.connect(g).connect(out);
  o.start(t); o.stop(t + attack + dur + 0.05);
}

function burst(t: number, dur: number, type: BiquadFilterType, f: number, peak = 0.3, q = 1, out: AudioNode = sfxBus, fEnd?: number): void {
  if (!ctx) return;
  const src = ctx.createBufferSource(); src.buffer = noise;
  src.playbackRate.value = rnd(0.8, 1.2);
  const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f, t); fl.Q.value = q;
  if (fEnd) fl.frequency.exponentialRampToValueAtTime(fEnd, t + dur);
  const g = ctx.createGain(); env(g, t, 0.004, peak, dur);
  src.connect(fl).connect(g).connect(out);
  src.start(t, Math.random()); src.stop(t + dur + 0.05);
}

function loopNoise(filter: BiquadFilterType, f: number, q = 0.7): { g: GainNode; f: BiquadFilterNode } {
  const src = ctx!.createBufferSource(); src.buffer = noise; src.loop = true;
  const fl = ctx!.createBiquadFilter(); fl.type = filter; fl.frequency.value = f; fl.Q.value = q;
  const g = ctx!.createGain(); g.gain.value = 0;
  src.connect(fl).connect(g).connect(ambBus); src.start();
  return { g, f: fl };
}

// ---------------------------------------------------------------- SFX
const SFX: Record<Sfx, (t: number, v: number) => void> = {
  click: (t, v) => tone(1400, t, 0.04, 'sine', 0.15 * v, sfxBus, 700),
  pop: (t, v) => tone(420, t, 0.09, 'sine', 0.3 * v, sfxBus, 980),
  coin: (t, v) => { tone(988, t, 0.06, 'triangle', 0.2 * v); tone(1319, t + 0.06, 0.25, 'triangle', 0.2 * v); },
  cash: (t, v) => {
    burst(t, 0.07, 'bandpass', 3200, 0.35 * v, 2);
    for (const [f, d] of [[2093, 0.7], [2637, 0.55], [3136, 0.45]]) tone(f, t + 0.08, d, 'sine', 0.12 * v);
  },
  upgrade: (t, v) => {
    [72, 76, 79, 84, 88].forEach((n, i) => tone(midi(n), t + i * 0.065, 0.3, 'triangle', 0.18 * v));
    for (let i = 0; i < 6; i++) tone(midi(96 + (i % 3) * 4), t + 0.3 + i * 0.04, 0.12, 'sine', 0.05 * v);
  },
  chop: (t, v) => { burst(t, 0.03, 'highpass', 2200, 0.25 * v); tone(160, t, 0.05, 'sine', 0.25 * v, sfxBus, 90); },
  success: (t, v) => { tone(midi(79), t, 0.12, 'triangle', 0.2 * v); tone(midi(84), t + 0.1, 0.3, 'triangle', 0.22 * v); },
  perfect: (t, v) => {
    [74, 76, 79, 81, 86, 88].forEach((n, i) => tone(midi(n), t + i * 0.05, 0.35, 'triangle', 0.16 * v));
    burst(t + 0.3, 0.4, 'highpass', 7000, 0.06 * v);
  },
  fail: (t, v) => tone(320, t, 0.3, 'sawtooth', 0.06 * v, sfxBus, 120),
  error: (t, v) => { tone(220, t, 0.09, 'square', 0.08 * v); tone(196, t + 0.12, 0.12, 'square', 0.08 * v); },
  whoosh: (t, v) => { burst(t, 0.25, 'bandpass', 400, 0.25 * v, 1.2, sfxBus, 3000); burst(t + 0.22, 0.3, 'bandpass', 3000, 0.15 * v, 1.2, sfxBus, 400); },
  milestone: (t, v) => {
    [[72, 76, 79], [74, 77, 81], [76, 79, 84]].forEach((ch, i) => ch.forEach((n) => tone(midi(n), t + i * 0.22, 0.9, 'triangle', 0.1 * v)));
    tone(midi(96), t + 0.66, 1.2, 'sine', 0.06 * v);
  },
  fanfare: (t, v) => {
    const brass = (n: number, at: number, d: number) => {
      if (!ctx) return;
      const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.value = midi(n);
      f.type = 'lowpass'; f.frequency.setValueAtTime(600, at); f.frequency.linearRampToValueAtTime(2400, at + 0.08);
      env(g, at, 0.03, 0.09 * v, d);
      o.connect(f).connect(g).connect(sfxBus); o.start(at); o.stop(at + d + 0.1);
    };
    [67, 72, 76].forEach((n, i) => brass(n, t + i * 0.13, 0.2));
    [72, 76, 79, 84].forEach((n) => brass(n, t + 0.42, 1.3));
    tone(midi(55), t + 0.42, 0.5, 'sine', 0.3 * v, sfxBus, midi(43));
  },
  door: (t, v) => { tone(midi(76), t, 0.8, 'sine', 0.15 * v); tone(midi(72), t + 0.25, 1.1, 'sine', 0.15 * v); },
  firework: (t, v) => {
    burst(t, 0.6, 'bandpass', 300, 0.25 * v, 0.6, sfxBus, 6000); // whistle-up
    burst(t + 0.6, 1.0, 'lowpass', 1800, 0.4 * v, 0.7, sfxBus, 150); // boom
    for (let i = 0; i < 10; i++) burst(t + 0.8 + Math.random() * 0.9, 0.02, 'highpass', 5000, 0.08 * v);
  },
  step: (t, v) => burst(t, 0.06, 'lowpass', rnd(500, 900), 0.12 * v, 1.5),
};

// ---------------------------------------------------------------- music
// Karplus–Strong plucks pre-rendered into buffers (koto-like). Yo scale by day, In scale by night.
const YO = [62, 64, 67, 69, 71, 74, 76, 79, 81, 83, 86];
const IN = [62, 63, 67, 69, 70, 74, 75, 79, 81, 82, 86];
const plucks = new Map<number, AudioBuffer>();
function pluck(n: number): AudioBuffer {
  let b = plucks.get(n);
  if (b) return b;
  const sr = ctx!.sampleRate, len = Math.floor(sr * 2.2);
  b = ctx!.createBuffer(1, len, sr);
  const d = b.getChannelData(0);
  const p = Math.max(2, Math.round(sr / midi(n)));
  const ring = new Float32Array(p);
  for (let i = 0; i < p; i++) ring[i] = Math.random() * 2 - 1;
  let idx = 0;
  for (let i = 0; i < len; i++) {
    const nxt = (idx + 1) % p;
    const v = ring[idx];
    ring[idx] = 0.4985 * (v + ring[nxt]);
    d[i] = v * (i < 40 ? i / 40 : 1);
    idx = nxt;
  }
  plucks.set(n, b);
  return b;
}

const MOODS: Record<string, { density: number; perc: number; taiko: number; bpm: number }> = {
  asakusa: { density: 0.45, perc: 0.25, taiko: 0.1, bpm: 82 },
  shibuya: { density: 0.6, perc: 0.6, taiko: 0.5, bpm: 92 },
  shinjuku: { density: 0.5, perc: 0.45, taiko: 0.3, bpm: 88 },
  ginza: { density: 0.38, perc: 0.15, taiko: 0.05, bpm: 76 },
};
let nextNote = 0, step = 0, melodyIdx = 4, mood = 'asakusa', padNodes: { o: OscillatorNode[]; g: GainNode } | null = null;

function playPluck(n: number, t: number, peak: number): void {
  const src = ctx!.createBufferSource(); src.buffer = pluck(n);
  const g = ctx!.createGain(); g.gain.value = peak;
  const pan = ctx!.createStereoPanner(); pan.pan.value = rnd(-0.4, 0.4);
  src.connect(g).connect(pan).connect(musicBus); src.start(t);
}

function pad(rootMidi: number, t: number, dur: number): void {
  if (padNodes) { padNodes.g.gain.setTargetAtTime(0, t, 0.6); const old = padNodes; setTimeout(() => old.o.forEach((o) => o.stop()), (dur + 3) * 1000); }
  const g = ctx!.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.05, t + 1.5);
  const f = ctx!.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
  const o = [rootMidi - 12, rootMidi - 5, rootMidi].map((n, i) => {
    const osc = ctx!.createOscillator(); osc.type = 'triangle'; osc.frequency.value = midi(n); osc.detune.value = (i - 1) * 6;
    osc.connect(f); osc.start(t); return osc;
  });
  f.connect(g).connect(musicBus);
  padNodes = { o, g };
}

function scheduleMusic(): void {
  const m = MOODS[mood] ?? MOODS.asakusa;
  const calm = scene.night > 0.5 ? 0.6 : 1;
  const beat = 60 / (m.bpm * (scene.night > 0.5 ? 0.88 : 1)) / 2; // 8th notes
  const scale = scene.night > 0.5 || mood === 'ginza' ? IN : YO;
  if (nextNote < ctx!.currentTime - 0.5) nextNote = ctx!.currentTime + 0.05; // tab was hidden: don't burst-catch-up
  while (nextNote < ctx!.currentTime + 0.25) {
    const t = nextNote, pos = step % 16;
    if (step % 32 === 0) pad(scale[[0, 2, 3, 0][Math.floor(step / 32) % 4]], t, beat * 32);
    if (Math.random() < m.density * calm * (pos % 2 === 0 ? 1.3 : 0.6)) {
      melodyIdx = Math.max(0, Math.min(scale.length - 1, melodyIdx + Math.round(rnd(-2.4, 2.4))));
      playPluck(scale[melodyIdx], t, 0.32);
      if (Math.random() < 0.15) playPluck(scale[Math.max(0, melodyIdx - 2)], t + beat * 0.5, 0.18);
    }
    if (pos === 0 && Math.random() < m.taiko * calm) tone(85, t, 0.4, 'sine', 0.35, musicBus, 48);
    if (pos % 4 === 2 && Math.random() < m.perc * calm) tone(rnd(780, 860), t, 0.05, 'sine', 0.12, musicBus, 600);
    nextNote += beat; step++;
  }
}

// ---------------------------------------------------------------- ambience events
let ambTimer = 3, firework = 0, fireworkT = 0;
function ambientEvents(dt: number): void {
  ambTimer -= dt;
  const t = ctx!.currentTime;
  if (ambTimer <= 0) {
    ambTimer = rnd(4, 11);
    const day = scene.night < 0.5;
    if (scene.inside) return;
    const r = Math.random();
    if (r < 0.45) burst(t, rnd(1.5, 2.5), 'lowpass', 180, 0.12, 1, ambBus, 700); // passing car
    else if (day && !scene.rain) for (let i = 0; i < 3 + Math.floor(rnd(0, 4)); i++) tone(rnd(3000, 4500), t + i * 0.11, 0.07, 'sine', 0.035, ambBus, rnd(4500, 6000)); // bird
    else if (!day) for (let i = 0; i < 12; i++) tone(4600, t + i * 0.05 + (i > 5 ? 0.4 : 0), 0.025, 'sine', 0.025, ambBus); // crickets
  }
  if (firework > 0) {
    firework -= dt; fireworkT -= dt;
    if (fireworkT <= 0) { fireworkT = rnd(0.6, 1.8); SFX.firework(t, 0.7); }
  }
}

// ---------------------------------------------------------------- public API
function applyVolumes(): void {
  if (!ctx || !vol) return;
  const t = ctx.currentTime;
  master.gain.setTargetAtTime(vol.muted ? 0 : vol.master, t, 0.05);
  sfxBus.gain.setTargetAtTime(vol.sfx, t, 0.05);
  musicBus.gain.setTargetAtTime(vol.music * 0.45, t, 0.3);
  ambBus.gain.setTargetAtTime(vol.sfx * 0.8, t, 0.05);
}

let subscribed = false;
function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  on('customerLeft', (e) => { if (e.customerId !== null && e.reason !== 'closed') audio.sfx('fail', 0.6); });
  on('dayEnd', () => audio.sfx('door', 0.6));
  on('event', () => audio.sfx('pop'));
  on('million', () => { firework = 40; fireworkT = 0.5; });
}

export const audio = {
  /** Call on first user gesture (browser autoplay policy). Safe to call repeatedly. */
  unlock(): void {
    applied = null;
    try {
      if (!ctx) {
        const AC = window.AudioContext || (window as any).webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        master = ctx.createGain(); master.connect(ctx.destination);
        const comp = ctx.createDynamicsCompressor(); comp.connect(master);
        sfxBus = ctx.createGain(); musicBus = ctx.createGain(); ambBus = ctx.createGain();
        sfxBus.connect(comp); musicBus.connect(comp); ambBus.connect(comp);
        noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const d = noise.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        street = loopNoise('lowpass', 420).g;
        rainG = loopNoise('highpass', 1200).g;
        const ch = loopNoise('bandpass', 700, 1.4); chatter = ch.g; chatterF = ch.f;
        nextNote = ctx.currentTime + 0.5;
        subscribe();
        applyVolumes();
      }
      if (ctx.state === 'suspended') void ctx.resume();
    } catch { ctx = null; }
  },
  sfx(name: Sfx, v = 1): void {
    if (!ctx || ctx.state !== 'running') return;
    try { SFX[name]?.(ctx.currentTime + 0.005, v); } catch { /* never break gameplay for audio */ }
  },
  step(running: boolean): void {
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - lastStep < 0.12) return;
    lastStep = now;
    audio.sfx('step', running ? 1.3 : 0.9);
  },
  setVolumes(s: Settings): void { vol = s; applyVolumes(); },
  setScene(o: { district: string; night: number; rain: boolean; inside: boolean; busy: number }): void {
    scene = o;
    if (!ctx) return;
    const prev = applied ?? { ...o, night: -1 };
    const t = ctx.currentTime;
    if (o.district !== mood) {
      musicBus.gain.setTargetAtTime(0, t, 0.3);
      mood = o.district;
      setTimeout(applyVolumes, 1200);
    }
    if (prev.inside !== o.inside || prev.rain !== o.rain || Math.abs(prev.night - o.night) > 0.05 || prev.busy !== o.busy) {
      applied = { ...o };
      street.gain.setTargetAtTime((o.inside ? 0.04 : 0.1) * (1 - o.night * 0.4), t, 0.5);
      rainG.gain.setTargetAtTime(o.rain ? (o.inside ? 0.05 : 0.14) : 0, t, 1);
      chatter.gain.setTargetAtTime(o.inside ? Math.min(0.12, 0.03 + o.busy * 0.015) : 0.015, t, 0.8);
    }
  },
  update(dt: number): void {
    if (!ctx || ctx.state !== 'running') return;
    try {
      // murmur: wobble the chatter formant so it sounds like voices, not hiss
      chatterF.frequency.setTargetAtTime(rnd(450, 1100), ctx.currentTime, 0.08);
      scheduleMusic();
      ambientEvents(dt);
    } catch { /* never let audio kill the game loop */ }
  },
};
