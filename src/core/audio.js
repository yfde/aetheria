// Aetheria audio engine. Every sound is synthesised with the Web Audio API: no assets, no deps.
//
//   voices ─► category buses (music / sfx / ambience) ─► mix ─► swim low-pass ─┐
//          └► reverb sends (two generated impulse responses) ─► mix            ├► master ─► compressor ─► soft clip ─► out
//   ui voices ─────────────────────────────────────────────────────────────────┘
//
// Tonal instruments (piano, celesta, glass, pluck, bell, wood) are rendered once per pitch region
// by additive synthesis into AudioBuffers and then played like samples, so a note costs 3-4 nodes.
// Music is generative: pad chords and piano phrases are composed on the fly from mood tables.
//
// Public API (every call is a silent no-op until unlock() has succeeded, and none of them throws):
//   const audio = new AudioEngine();
//   audio.unlock();                          // from a user gesture; safe to repeat
//   audio.setVolumes({ master, music, sfx, ambience });           // 0..1 each, any subset
//   audio.setEnvironment({ night, region, altitude, nearWater, inForest, wind, rain, combat, swimming, time });
//   audio.sfx(name, intensity = 1);          // names: keys of SFX below
//   audio.footstep(player);
//   audio.stinger(name);                     // names: keys of STINGERS below
//   audio.update(dt);                        // every frame
//   audio.ready;                             // true while the context is unlocked and running

const TAU = Math.PI * 2;
const MAX_VOICES = 128;
const COMP_TRIM = 0.633;         // cancels the DynamicsCompressor's automatic make-up gain (measured in Chrome)
const STEP = 60 / 108 / 2;       // combat ostinato step (an 8th note at 108 BPM)
const NO = Object.freeze({});
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const rnd = (a, b) => a + Math.random() * (b - a);
const rndi = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const chance = (p) => Math.random() < p;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const vol = (k) => clamp(k, 0.25, 1.4);                      // generic sfx intensity -> gain
const fader = (v) => Math.pow(clamp(v, 0, 1), 1.6);          // volume slider -> gain
const deg = (sc, i) => { const n = sc.length, o = Math.floor(i / n); return 12 * o + sc[i - o * n]; };

// An AudioParam plus the last value it was sent to, so slow control changes only touch the
// param when they are audible.
const slot = (p, v) => { p.value = v; return { p, v }; };
function aim(s, v, t, tc) {
  if (Math.abs(v - s.v) > 0.002 + 0.03 * Math.abs(s.v)) { s.p.setTargetAtTime(v, t, tc); s.v = v; }
}

// ---------------------------------------------------------------------------------------------
// Buffer synthesis (plain JS, runs once per buffer)
// ---------------------------------------------------------------------------------------------

// Adds amp * exp(-t/tau) * sin(2*pi*freq*t + phase) with a two-multiply resonator.
function addPartial(out, sr, freq, amp, tau, phase) {
  const w = TAU * freq / sr, r = Math.exp(-1 / (tau * sr)), c = 2 * r * Math.cos(w), r2 = r * r;
  let y1 = amp * Math.sin(phase - w) / r, y2 = amp * Math.sin(phase - 2 * w) / r2;
  const n = Math.min(out.length, Math.ceil(tau * sr * 9.2));
  for (let i = 0; i < n; i++) { const y = c * y1 - r2 * y2; out[i] += y; y2 = y1; y1 = y; }
}

// Partials are [ratio, amp, tau, mix, beatHz, fastRatio]. With `mix` the partial is a fast
// "prompt" decay plus a slightly detuned slow "aftersound" (the double decay of struck strings).
function renderTone(sr, s) {
  const n = Math.ceil(s.dur * sr), out = new Float32Array(n), top = sr * 0.45;
  for (const p of s.partials) {
    const f = s.f0 * p[0], mix = p[3] || 0;
    if (f >= top) continue;
    addPartial(out, sr, f, p[1] * (1 - mix), mix ? p[2] * p[5] : p[2], Math.random() * TAU);
    if (mix) addPartial(out, sr, f + p[4], p[1] * mix, p[2], Math.random() * TAU);
  }
  if (s.noise) {                                             // hammer / mallet transient
    const [amp, tau, lp] = s.noise, k = 1 - Math.exp(-TAU * lp / sr), dec = Math.exp(-1 / (tau * sr));
    const m = Math.min(n, Math.ceil(tau * sr * 8));
    let y = 0, e = amp * 1.73 / Math.sqrt(k / (2 - k));
    for (let i = 0; i < m; i++) { y += k * (Math.random() * 2 - 1 - y); out[i] += y * e; e *= dec; }
  }
  const na = Math.max(2, Math.floor(s.attack * sr));
  for (let i = 0; i < na; i++) out[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / na);
  const nf = Math.floor(n * 0.25);
  for (let i = 0; i < nf; i++) out[n - 1 - i] *= i / nf;
  let peak = 1e-6;
  for (let i = 0; i < n; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
  const g = 0.85 / peak;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

// Sampled-instrument table: tonal ones are rendered every 4 semitones between lo and hi.
const INST = {
  piano: { lo: 28, hi: 100, level: 1.4, vlp: true },
  celesta: { lo: 60, hi: 108, level: 0.5 },
  glass: { lo: 48, hi: 104, level: 0.5 },
  pluck: { lo: 48, hi: 96, level: 0.34 },
  bell: { fixed: 76, level: 0.5 },
  wood: { fixed: 84, level: 0.5 },
};

function toneSpec(inst, midi) {
  const f0 = mtof(midi), P = [];
  if (inst === 'piano') {
    const k = (midi - 60) / 12, tau = 1.25 * Math.pow(2, -0.62 * k), B = 0.00028 * Math.pow(2, 1.2 * k);
    const p = clamp(1 + 0.22 * k, 0.85, 1.8), nc = clamp(12 - 3.5 * k, 3, 20);
    const nMax = Math.max(1, Math.min(24, Math.floor(16000 / f0)));
    for (let n = 1; n <= nMax; n++) {
      // soft-hammer spectrum with the dips of a strike point near 1/8 of the string
      const amp = (0.55 + 0.45 * Math.abs(Math.sin(Math.PI * n / 7.7))) * Math.pow(n, -p) * Math.exp(-n / nc);
      const ratio = n * Math.sqrt(1 + B * n * n), tn = tau * Math.pow(n, -0.7);
      if (n <= 8) P.push([ratio, amp, tn, 0.24, f0 * n * 0.0007, 0.3]); else P.push([ratio, amp, tn * 0.45]);
    }
    P.push([95 / f0, 0.05, 0.03]);                           // soundboard knock
    return { f0, dur: clamp(3.4 * tau, 0.9, 3.8), attack: clamp(0.0035 - 0.001 * k, 0.0012, 0.006), partials: P, noise: [0.06, 0.012, clamp(f0 * 4, 500, 3500)] };
  }
  if (inst === 'celesta') {
    const tau = 0.85 * Math.pow(2, -0.45 * (midi - 72) / 12);
    return { f0, dur: clamp(4.2 * tau, 0.7, 2.8), attack: 0.0012, noise: [0.04, 0.003, 7000],
      partials: [[1, 1, tau, 0.35, 0.6, 0.45], [2, 0.11, tau * 0.5], [3, 0.03, tau * 0.3], [4.07, 0.13, tau * 0.11], [6.92, 0.07, tau * 0.05], [10.3, 0.035, tau * 0.03]] };
  }
  if (inst === 'glass') {
    const tau = 1.25 * Math.pow(2, -0.4 * (midi - 72) / 12);
    return { f0, dur: clamp(3.6 * tau, 1.2, 3), attack: 0.028,
      partials: [[1, 1, tau, 0.5, 0.9, 0.55], [2, 0.2, tau * 0.6, 0.5, 1.4, 0.55], [3, 0.06, tau * 0.4], [4.24, 0.045, tau * 0.2], [6.3, 0.02, tau * 0.1]] };
  }
  if (inst === 'pluck') {
    const tau = 0.6 * Math.pow(2, -0.45 * (midi - 60) / 12);
    for (let n = 1; n <= 9; n++) P.push([n * (1 + 0.0004 * n * n), (n & 1 ? 1 : 0.6) * Math.pow(n, -1.5), tau * Math.pow(n, -0.8)]);
    P.push([5.87, 0.06, 0.02]);
    return { f0, dur: clamp(5 * tau, 0.45, 2), attack: 0.001, partials: P, noise: [0.06, 0.004, 4500] };
  }
  if (inst === 'bell') {                                     // inharmonic metal: sword on shield
    return { f0, dur: 0.9, attack: 0.0004, noise: [0.3, 0.004, 9000],
      partials: [[1, 0.7, 0.3], [1.52, 0.5, 0.22], [2.74, 1, 0.26], [3.81, 0.6, 0.16], [5.43, 0.8, 0.12], [6.81, 0.4, 0.08], [8.93, 0.5, 0.06], [11.2, 0.25, 0.04]] };
  }
  return { f0, dur: 0.22, attack: 0.0003, noise: [0.3, 0.0025, 5000],        // wood: dry knock
    partials: [[1, 1, 0.028], [2.71, 0.5, 0.014], [5.18, 0.3, 0.007]] };
}

function fillPink(d, n) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = -4000; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    if (i >= 0) d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
}

// Folds the extra tail d[n..n+f) back into the head with an equal-power crossfade: seamless loop.
function foldLoop(d, n, f) {
  for (let i = 0; i < f; i++) { const x = i / f * Math.PI / 2; d[i] = d[i] * Math.sin(x) + d[n + i] * Math.cos(x); }
}

function normalize(buf, peakTo) {
  let peak = 1e-6;
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; } }
  const g = peakTo / peak;
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= g; }
  return buf;
}

function makeNoise(ctx, seconds, channels, pink) {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr), f = Math.floor(0.25 * sr), buf = ctx.createBuffer(channels, n, sr);
  const tmp = new Float32Array(n + f);
  for (let c = 0; c < channels; c++) {
    if (pink) { fillPink(tmp, n + f); foldLoop(tmp, n, f); } else for (let i = 0; i < n; i++) tmp[i] = Math.random() * 2 - 1;
    buf.getChannelData(c).set(tmp.subarray(0, n));
  }
  return pink ? normalize(buf, 0.9) : buf;
}

// Reverb impulse response: early reflections, then a diffuse tail whose highs die first.
function makeImpulse(ctx, seconds, t60, pre, bright) {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr), buf = ctx.createBuffer(2, n, sr), n0 = Math.floor(pre * sr);
  const dEnv = Math.exp(-6.908 / (t60 * sr)), dOn = Math.exp(-1 / (0.012 * sr)), dCut = Math.exp(-1 / (t60 * 0.22 * sr));
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0, hp = 0, prev = 0, env = 1, on = 1, cut = bright - 900, k = 0;
    for (let i = n0; i < n; i++) {
      if (((i - n0) & 31) === 0) k = 1 - Math.exp(-TAU * (900 + cut) / sr);          // low-pass closes over time
      lp += k * (Math.random() * 2 - 1 - lp);
      hp = 0.98 * (hp + lp - prev); prev = lp;               // keep rumble out of the tail
      d[i] = hp * env * (1 - on);
      env *= dEnv; on *= dOn; cut *= dCut;
    }
    for (let r = 0; r < 9; r++) {
      const i = n0 + Math.floor((0.004 + 0.08 * (r + Math.random()) / 9) * sr), a = (chance(0.5) ? 0.5 : -0.5) * (1 - r / 12) * rnd(0.5, 1);
      d[i] += a; d[i + 1] += a * 0.5;
    }
    const nf = Math.floor(n * 0.1);
    for (let i = 0; i < nf; i++) d[n - 1 - i] *= i / nf;
  }
  return buf;
}

// Looped ambience beds. Each render is a generator that yields between chunks of work, so the
// warm-up queue can spread it over several frames; finish() runs one to completion. The hot
// loops live in plain functions, which the JIT optimises far sooner than generator bodies.
function finish(it) {
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

// Band-limited noise with a seamless loop: one-pole low-pass `a`, then a high-pass with pole `b`.
function addWash(d, tmp, n, f, a, b, gain) {
  let lp = 0, hp = 0, prev = 0;
  for (let i = 0; i < n + f; i++) { lp += a * (Math.random() * 2 - 1 - lp); hp = b * (hp + lp - prev); prev = lp; tmp[i] = hp; }
  foldLoop(tmp, n, f);
  for (let i = 0; i < n; i++) d[i] += tmp[i] * gain;
}

// One field cricket: groups of 2-4 short pulses, repeated at a rate that divides the loop.
function addCricket(L, R, n, sr, seconds) {
  const fc = rnd(3900, 5100), pulses = rndi(2, 4), gap = rnd(0.016, 0.021), len = Math.floor(gap * 0.72 * sr);
  const amp = Math.pow(rnd(0.3, 1), 1.5), pan = rnd(-0.9, 0.9), gl = amp * Math.sqrt(0.5 - 0.5 * pan), gr = amp * Math.sqrt(0.5 + 0.5 * pan);
  const reps = Math.max(1, Math.round(seconds / rnd(0.38, 0.8))), per = seconds / reps;
  for (let j = 0; j < reps; j++) {
    if (chance(0.07)) continue;
    const t0 = (j + rnd(0, 0.04)) * per, w = TAU * fc * rnd(0.996, 1.004) / sr;
    for (let p = 0; p < pulses; p++) {
      const s0 = Math.floor((t0 + p * gap) * sr);
      for (let i = 0; i < len; i++) {
        const e = Math.sin(Math.PI * i / len), v = e * e * Math.sin(w * i), k = (s0 + i) % n;
        L[k] += v * gl; R[k] += v * gr;
      }
    }
  }
}

// Tree-cricket trill that comes and goes: carrier * pulsing AM * slow swell, all three sines run
// as two-multiply resonators with a whole number of cycles in the loop.
function addTrill(L, R, n, seconds) {
  const w1 = TAU * Math.round(rnd(36, 46) * seconds) / n, w2 = TAU * Math.round(rnd(2900, 3300) * seconds) / n, w3 = TAU / n, ph = rnd(0, TAU);
  const c1 = 2 * Math.cos(w1), c2 = 2 * Math.cos(w2), c3 = 2 * Math.cos(w3);
  let p1 = Math.sin(-w1), q1 = Math.sin(-2 * w1), p2 = Math.sin(-w2), q2 = Math.sin(-2 * w2), p3 = Math.sin(ph - w3), q3 = Math.sin(ph - 2 * w3);
  for (let i = 0; i < n; i++) {
    const s1 = c1 * p1 - q1, s2 = c2 * p2 - q2, s3 = c3 * p3 - q3, am = s1 > 0 ? s1 : 0, v = am * am * s2 * Math.max(0, 0.03 + 0.07 * s3);
    q1 = p1; p1 = s1; q2 = p2; p2 = s2; q3 = p3; p3 = s3;
    L[i] += v * 0.8; R[i] += v;
  }
}

// One water bubble: a decaying sine whose pitch rises as the bubble shrinks.
function addBubble(L, R, n, sr) {
  const f0 = 380 * Math.pow(7, Math.random()), tau = rnd(0.006, 0.02) * Math.sqrt(900 / f0) * sr, rise = rnd(2, 14) / sr;
  const amp = Math.pow(Math.random(), 2) * Math.pow(600 / f0, 0.3), pan = rnd(-0.8, 0.8), gl = amp * Math.sqrt(0.5 - 0.5 * pan), gr = amp * Math.sqrt(0.5 + 0.5 * pan);
  const len = Math.floor(tau * 4.5), w = TAU * f0 / sr, dec = Math.exp(-1 / tau);
  let phase = 0, env = 1;
  for (let i = 0, k = Math.floor(Math.random() * n); i < len; i++, k++) {
    if (k >= n) k -= n;
    phase += w * (1 + rise * i);
    const v = Math.sin(phase) * env * (i < 24 ? i / 24 : 1);
    env *= dec;
    L[k] += v * gl; R[k] += v * gr;
  }
}

// One raindrop: a millisecond of filtered noise; `plop` makes it a low pitched blip instead.
function addDrop(L, R, n, sr, plop) {
  const pan = Math.random(), tau = (plop ? 0.008 : rnd(0.0006, 0.003)) * sr, len = Math.floor(tau * 5), dec = Math.exp(-1 / tau);
  const k = rnd(0.15, 0.9), w = TAU * rnd(500, 1400) / sr;
  let y = 0, env = plop ? Math.pow(Math.random(), 2) * 0.3 : Math.pow(Math.random(), 3) * 0.9;
  for (let i = 0, j = Math.floor(Math.random() * n); i < len; i++, j++) {
    if (j >= n) j -= n;
    if (plop) y = Math.sin(w * i * (1 - 0.00002 * i)) * (i < 16 ? i / 16 : 1); else y += k * (Math.random() * 2 - 1 - y);
    L[j] += y * env * (1 - pan); R[j] += y * env * pan;
    env *= dec;
  }
}

// Night insects: a few field crickets over a quiet trill.
function* renderCrickets(ctx, seconds, count) {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr), buf = ctx.createBuffer(2, n, sr), L = buf.getChannelData(0), R = buf.getChannelData(1);
  for (let c = 0; c < count; c++) addCricket(L, R, n, sr, seconds);
  yield;
  addTrill(L, R, n, seconds);
  yield;
  return normalize(buf, 0.5);
}

// Stream: a few hundred resonant bubbles over a soft wash of flowing water.
function* renderBabble(ctx, seconds) {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr), f = Math.floor(0.3 * sr), buf = ctx.createBuffer(2, n, sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1), tmp = new Float32Array(n + f);
  for (let b = Math.floor(seconds * 42); b > 0; b--) { addBubble(L, R, n, sr); if (b % 50 === 0) yield; }
  addWash(L, tmp, n, f, 0.25, 0.96, 0.22);
  yield;
  addWash(R, tmp, n, f, 0.25, 0.96, 0.22);
  yield;
  return normalize(buf, 0.6);
}

// Rain: steady hiss, over a thousand individual drops and a few low plops.
function* renderRain(ctx, seconds) {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr), f = Math.floor(0.3 * sr), buf = ctx.createBuffer(2, n, sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1), tmp = new Float32Array(n + f);
  addWash(L, tmp, n, f, 0.6, 0.86, 0.16);
  yield;
  addWash(R, tmp, n, f, 0.6, 0.86, 0.16);
  yield;
  for (let b = Math.floor(seconds * 220); b > 0; b--) { addDrop(L, R, n, sr, false); if (b % 250 === 0) yield; }
  for (let b = Math.floor(seconds * 9); b > 0; b--) addDrop(L, R, n, sr, true);
  return normalize(buf, 0.7);
}

// Output safety: exactly linear up to 0.6, then a tanh knee that never exceeds 0.98.
// The shaper is fed at half level, so it has headroom for pre-clip peaks up to 2.0.
function softClipCurve() {
  const N = 2049, curve = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1) * 2 - 1) * 2, a = Math.abs(x), y = a <= 0.6 ? a : 0.6 + 0.38 * Math.tanh((a - 0.6) / 0.38);
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}

// ---------------------------------------------------------------------------------------------
// Music tables
// ---------------------------------------------------------------------------------------------

const KEYS = [0, 2, 5, 7, 9, 10, 3, 4];                      // each region hashes to one of these keys
function keyOf(region) {
  let h = 0;
  for (let i = 0; i < region.length; i++) h = (h * 31 + region.charCodeAt(i)) >>> 0;
  return KEYS[h % KEYS.length];
}
const tonicOf = (key) => (key <= 6 ? 60 : 48) + key;         // tonic between G3 and F#4

// Chords: bass and tones in semitones from the mood tonic. Minor moods sit on the relative
// minor (tonic - 3), so the moods of one key are close relatives and hand over without a jolt.
// `kinds` are cumulative odds of the phrase types: flourish, motif, rolled chord, dyads, then
// echo (or, on Frostcrown, an open-fifth figure).
const C = (b, ...t) => ({ b, t, a: [b, ...t] });
const MOODS = {
  day: {       // lydian / major pentatonic, long silences
    minor: 0, sc: [0, 2, 4, 7, 9], lo: 3, hi: 11, slow: 1, gap: [3.5, 10], cd: [14, 22], pad: 0.024, cut: 950, send: 0.5, kinds: [0.3, 0.62, 0.76, 0.9],
    ch: [C(0, 7, 14, 16), C(0, 4, 11, 14), C(0, 2, 6, 9), C(-3, 4, 7, 12), C(4, 7, 11, 14), C(-5, 2, 7, 11)],
  },
  night: {     // aeolian pentatonic, slower, lower, wetter, celesta on top
    minor: 1, sc: [0, 3, 5, 7, 10], lo: 0, hi: 9, slow: 1.55, gap: [6, 14], cd: [18, 28], pad: 0.022, cut: 620, send: 0.85, kinds: [0.08, 0.42, 0.64, 0.8],
    ch: [C(0, 3, 7, 14), C(-4, 3, 7, 12), C(3, 7, 10, 14), C(-5, 2, 5, 10), C(-7, 0, 5, 8)],
  },
  village: {   // ionian waltz, regular two-bar phrases over a chord cycle
    minor: 0, sc: [0, 2, 4, 5, 7, 9, 11], lo: 2, hi: 9, slow: 1, pad: 0.026, cut: 800, send: 0.4,
    ch: [C(0, 4, 7, 12), C(-3, 4, 7, 12), C(5, 5, 9, 12), C(-5, 2, 7, 11), C(4, 4, 7, 11)],
    cyc: [[0, 1, 2, 3], [0, 2, 0, 3], [0, 4, 2, 3], [1, 2, 0, 3]],
  },
  frost: {     // stacked fifths, wide and cold
    minor: 1, sc: [0, 2, 7, 10], lo: 2, hi: 9, slow: 1.5, gap: [6, 13], cd: [20, 30], pad: 0.018, cut: 1500, send: 0.95, kinds: [0, 0.2, 0.2, 0.4],
    ch: [C(0, 7, 14, 21), C(-2, 5, 12, 19), C(-7, 0, 7, 14), C(3, 10, 17, 24)],
  },
};

// Melodic cells: contour in scale steps and rhythm in beats. The first three are the title theme.
const MOTIFS = [
  { c: [0, 2, 3, 4], r: [1, 1, 1, 2] }, { c: [0, 2], r: [1, 2.5] }, { c: [4, 3, 2, 1], r: [0.75, 0.75, 0.75, 2] },
  { c: [0, 1, 2], r: [1, 1, 2] }, { c: [0, 2, 1], r: [0.5, 0.5, 2] }, { c: [0, -1, 1, 0], r: [1, 0.5, 0.5, 2] },
  { c: [0, 1, 3, 2], r: [0.5, 0.5, 1, 2] }, { c: [2, 0, 1], r: [1.5, 0.5, 2] }, { c: [0, 1, 0, -2], r: [0.5, 0.5, 1, 2] },
  { c: [0, 3, 2], r: [1, 1, 2.5] }, { c: [0, 1, 2, 4, 3], r: [0.5, 0.5, 0.5, 0.5, 2] },
];
const VILLAGE_RHYTHMS = [[0, 1, 2, 3], [0, 1.5, 2, 3], [0, 2, 3, 5], [0, 0.5, 1, 2, 3], [1, 2, 3, 4.5], [0, 1, 2, 3, 4, 5]];

// Combat: 3-3-2 drum accents, a fifth-based ostinato and chord stabs on the relative minor.
const DRUM = [2, 0, 0, 1, 0, 0, 1, 0, 2, 0, 0, 1, 0, 0, 1, 0];
const OST = [0, 0, 7, 0, 12, 0, 7, 0, 0, 0, 7, 0, 12, 7, 12, 7];
const COMBAT = [
  [[0, 3, 7], [0, 3, 7], [3, 7, 10], [-2, 2, 5]],
  [[0, 3, 7], [-2, 2, 5], [3, 7, 10], [-5, -2, 2]],
  [[0, 3, 7], [3, 7, 10], [-2, 2, 5], [0, 3, 7]],
];

function nearestTone(m, base, tones) {
  let best = m, bd = 99;
  for (let i = 0; i < tones.length; i++) {
    const pc = base + tones[i], c = pc + 12 * Math.round((m - pc) / 12), d = Math.abs(c - m);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Sound effects. Each entry is (engine, time, intensity, tonic); tuned ones follow the music key.
// ---------------------------------------------------------------------------------------------

const PENTA = [0, 2, 4, 7, 9];

const SFX = {
  swing(e, t, k) {
    const i = clamp(Math.round(k), 0, 2), p = [1, 1.16, 0.8][i] * rnd(0.93, 1.07), d = [0.24, 0.22, 0.36][i], pan = rnd(-0.25, 0.25), S = e._to;
    e._nz(t, d, 'bandpass', 420 * p, 0.42, { f1: 2500 * p, ft: d * 0.42, f2: 650 * p, q: 1.5, a: d * 0.36, pan, to: S.sfxA });
    e._nz(t, d * 0.8, 'highpass', 4800, 0.07, { a: d * 0.34, pan });
    if (i === 2) {                                           // finisher: heavier air and a faint ring
      e._nz(t, 0.4, 'lowpass', 260, 0.3, { f1: 800, ft: 0.16, f2: 180, a: 0.14, pan });
      e._note('bell', 96 + rnd(-1, 1), t + 0.07, 0.3, { g: 0.12, pan, to: S.sfxB });
    }
  },
  hit(e, t, k) {
    const v = vol(k), p = rnd(0.9, 1.1), S = e._to;
    e._os(t, 0.2, 'sine', 170 * p, 0.5 * v, { f1: 55, ft: 0.09 });
    e._nz(t, 0.12, 'bandpass', 1100 * p, 0.4 * v, { f1: 380, q: 0.9, a: 0.002, to: S.sfxA });
    e._nz(t, 0.04, 'highpass', 3800, 0.18 * v, { a: 0.001 });
    e._note('bell', 88 + rnd(-3, 3), t, 0.4, { g: 0.1 * v, dur: 0.1, to: S.sfxA });
  },
  hitHeavy(e, t, k) {
    const v = vol(k), p = rnd(0.9, 1.08), S = e._to;
    e._os(t, 0.42, 'sine', 120 * p, 0.68 * v, { f1: 38, ft: 0.2 });
    e._os(t, 0.14, 'triangle', 200 * p, 0.3 * v, { f1: 60 });
    e._nz(t, 0.28, 'lowpass', 2200, 0.42 * v, { f1: 220, a: 0.002, to: S.sfxB });
    e._nz(t, 0.045, 'highpass', 3200, 0.2 * v, { a: 0.001 });
    e._note('bell', 80 + rnd(-3, 3), t, 0.5, { g: 0.12 * v, dur: 0.16, to: S.sfxB });
  },
  block(e, t, k) {
    const v = vol(k), m = 76 + rnd(-2, 2), S = e._to;
    e._note('bell', m, t, 0.8, { g: 0.9 * v, to: S.sfxB });
    e._note('bell', m + 7.3, t, 0.6, { g: 0.33 * v, to: S.sfxB });
    e._nz(t, 0.05, 'highpass', 2500, 0.28 * v, { a: 0.001 });
    e._os(t, 0.1, 'sine', 220, 0.35 * v, { f1: 110 });
  },
  hurt(e, t, k) {
    const v = vol(k), p = rnd(0.94, 1.06);
    e._os(t, 0.28, 'sine', 150 * p, 0.6 * v, { f1: 52, ft: 0.14 });
    e._nz(t, 0.16, 'bandpass', 700, 0.4 * v, { f1: 300, q: 0.8 });
    e._os(t, 0.22, 'triangle', 392 * p, 0.09 * v, { f1: 262 * p, a: 0.01, lp: 1200 });
  },
  jump(e, t, k) {
    const v = vol(k), p = rnd(0.92, 1.1);
    e._nz(t, 0.17, 'bandpass', 380 * p, 0.16 * v, { f1: 1500 * p, q: 1.2, a: 0.05 });
    e._os(t, 0.12, 'sine', 210 * p, 0.05 * v, { f1: 380 * p, a: 0.02 });
  },
  land(e, t, k) {
    const i = clamp(k, 0, 1), v = 0.3 + 0.7 * i, p = rnd(0.92, 1.08);
    e._os(t, 0.16 + 0.1 * i, 'sine', 115 * p, 0.45 * v, { f1: 48, ft: 0.08 });
    e._nz(t, 0.12 + 0.06 * i, 'bandpass', 1300 * p, 0.2 * v, { f1: 450, q: 0.7 });
    e._nz(t, 0.08, 'lowpass', 300, 0.3 * v);
  },
  roll(e, t, k) {
    const v = vol(k), p = rnd(0.93, 1.07);
    e._nz(t, 0.36, 'bandpass', 300 * p, 0.22 * v, { f1: 900 * p, ft: 0.14, f2: 260, q: 1, a: 0.1 });
    e._nz(t + 0.05, 0.12, 'lowpass', 400, 0.25 * v);
    e._nz(t + 0.2, 0.11, 'lowpass', 350, 0.18 * v);
    e._os(t + 0.06, 0.14, 'sine', 95, 0.25 * v, { f1: 55 });
  },
  glider(e, t, k) {
    const v = vol(k), S = e._to;
    e._nz(t, 0.6, 'bandpass', 250, 0.34 * v, { f1: 1300, ft: 0.2, f2: 420, q: 0.9, a: 0.14, to: S.sfxA });
    for (let i = 0; i < 4; i++) e._nz(t + 0.1 + i * 0.045, 0.06, 'bandpass', 1800 - 200 * i, 0.12 * v * (1 - i / 5), { q: 0.8 });   // cloth flutter
    e._os(t + 0.1, 0.2, 'sine', 130, 0.3 * v, { f1: 70 });
  },
  grab(e, t, k) {
    const v = vol(k), p = rnd(0.88, 1.12);
    e._nz(t, 0.06, 'bandpass', 900 * p, 0.12 * v, { q: 1, a: 0.002 });
    e._os(t, 0.08, 'sine', 210 * p, 0.12 * v, { f1: 110 });
    e._nz(t, 0.09, 'highpass', 3000, 0.03 * v, { a: 0.02 });
  },
  splash(e, t, k) {
    const i = clamp(k, 0, 1), v = 0.3 + 0.7 * i, S = e._to, pan = rnd(-0.2, 0.2);
    e._nz(t, 0.22, 'lowpass', 700, 0.5 * v, { f1: 200, pan });
    e._nz(t, 0.6 + 0.5 * i, 'bandpass', 2600, 0.3 * v, { f1: 1200, q: 0.5, a: 0.03, pan, to: S.sfxA });
    e._nz(t, 0.4, 'highpass', 5000, 0.1 * v, { a: 0.05, pan });
    for (let b = 3 + Math.round(5 * i); b > 0; b--) { const f = rnd(400, 1200); e._os(t + rnd(0.05, 0.5), 0.07, 'sine', f, 0.06 * v, { f1: f * 1.6, a: 0.004, pan: rnd(-0.5, 0.5) }); }
  },
  pickup(e, t, k, T) {
    const i = rndi(0, 4), S = e._to;
    e._note('pluck', T + 12 + PENTA[i], t, 0.6, { g: 1.3 * vol(k), to: S.sfxA });
    e._note('pluck', T + 12 + deg(PENTA, i + 1), t + 0.07, 0.7, { g: 1.3 * vol(k), to: S.sfxA });
  },
  coin(e, t, k, T) {
    const up = chance(0.25) ? 2 : 0, S = e._to;
    e._note('celesta', T + 19 + up, t, 0.65, { g: vol(k), to: S.sfxA });
    e._note('celesta', T + 24 + up, t + 0.065, 0.75, { g: vol(k), to: S.sfxA });
    e._note('bell', 100, t, 0.3, { g: 0.05, dur: 0.05 });
  },
  chestOpen(e, t, k, T) {
    const v = vol(k), S = e._to;
    e._note('wood', 70, t, 0.8, { g: 0.6 * v });             // latch
    e._os(t, 0.12, 'sine', 140, 0.3 * v, { f1: 80 });
    e._creak(t + 0.08, 0.55, v);
    e._nz(t + 0.6, 0.1, 'lowpass', 250, 0.25 * v);           // lid comes to rest
    for (let i = 0; i < 6; i++) e._note(i & 1 ? 'celesta' : 'glass', T + 24 + deg(PENTA, i + rndi(0, 1)), t + 0.5 + i * 0.06, 0.35 + 0.04 * i, { to: S.sfxC, pan: rnd(-0.4, 0.4) });
    e._nz(t + 0.45, 0.7, 'highpass', 6000, 0.02 * v, { a: 0.25, to: S.sfxB });
  },
  orb(e, t, k, T) {
    const v = vol(k), S = e._to, ch = [12, 19, 24, 26];
    for (let i = 0; i < 4; i++) e._note('glass', T + ch[i], t + i * 0.045, 0.55, { g: v, to: S.sfxH, pan: (i - 1.5) * 0.25 });
    e._note('celesta', T + 36, t + 0.2, 0.3, { g: v, to: S.sfxH });
    e._note('celesta', T + 43, t + 0.32, 0.25, { g: v, to: S.sfxH });
    e._os(t, 1.6, 'sine', mtof(T - 12), 0.08 * v, { a: 0.3, to: S.sfxH });
  },
  uiHover(e, t, k, T) {
    e._note('pluck', T + 24 + pick([0, 7]), t, 0.35, { g: 1.3, dur: 0.07, to: e._to.ui });
  },
  uiClick(e, t, k, T) {
    const S = e._to;
    e._note('wood', 84 + rnd(-1, 1), t, 0.6, { g: 0.4, to: S.ui });
    e._note('pluck', T + 19, t, 0.45, { g: 0.9, dur: 0.12, to: S.ui });
  },
  uiOpen(e, t, k, T) {
    const S = e._to;
    e._nz(t, 0.22, 'bandpass', 600, 0.09, { f1: 2400, q: 0.8, a: 0.08, to: S.ui });
    e._note('pluck', T + 12, t, 0.45, { g: 0.95, to: S.ui });
    e._note('pluck', T + 19, t + 0.07, 0.5, { g: 0.95, to: S.ui });
  },
  uiClose(e, t, k, T) {
    const S = e._to;
    e._nz(t, 0.2, 'bandpass', 2200, 0.08, { f1: 500, q: 0.8, a: 0.03, to: S.ui });
    e._note('pluck', T + 19, t, 0.45, { g: 0.95, to: S.ui });
    e._note('pluck', T + 12, t + 0.07, 0.4, { g: 0.95, to: S.ui });
  },
  dialog(e, t, k, T) {
    const m = T + 12 + pick(PENTA), S = e._to;
    e._note('pluck', m, t, 0.4, { g: 1.2, dur: 0.1, to: S.ui });
    e._os(t, 0.09, 'sine', mtof(m), 0.08, { a: 0.008, to: S.ui });
  },
  error(e, t) {
    const S = e._to;
    e._os(t, 0.16, 'triangle', 196, 0.17, { a: 0.008, lp: 900, to: S.ui });
    e._os(t + 0.13, 0.26, 'triangle', 139, 0.17, { a: 0.008, lp: 800, to: S.ui });
  },
  heal(e, t, k, T) {
    const v = vol(k), S = e._to, ch = [12, 16, 19, 24, 28];
    for (let i = 0; i < 5; i++) e._note('glass', T + ch[i], t + i * 0.075, 0.4 + 0.05 * i, { g: v, to: S.sfxC });
    e._os(t, 1.3, 'sine', mtof(T), 0.06 * v, { a: 0.25, to: S.sfxB });
    e._os(t, 1.3, 'sine', mtof(T + 7), 0.04 * v, { a: 0.3, to: S.sfxB });
    e._nz(t, 1.0, 'highpass', 5000, 0.025 * v, { a: 0.35, to: S.sfxB });
  },
  skill(e, t, k, T) {
    const v = vol(k), S = e._to;
    e._nz(t, 0.55, 'bandpass', 280, 0.5 * v, { f1: 3200, ft: 0.28, f2: 900, q: 0.9, a: 0.16, to: S.sfxB });
    e._nz(t, 0.4, 'highpass', 3500, 0.1 * v, { a: 0.2 });
    e._os(t + 0.02, 0.4, 'sine', 95, 0.4 * v, { f1: 42, ft: 0.2 });
    for (let i = 0; i < 7; i++) e._note('celesta', T + 12 + deg(PENTA, i), t + 0.08 + i * 0.04, 0.25 + 0.045 * i, { g: v, to: S.sfxC, pan: rnd(-0.5, 0.5) });
    e._os(t + 0.05, 0.5, 'sine', 900, 0.03 * v, { f1: 3600, a: 0.22, to: S.sfxC });
  },
  enemyDie(e, t, k, T) {
    const v = vol(k), S = e._to;
    e._nz(t, 0.42, 'lowpass', 1800, 0.2 * v, { f1: 250, a: 0.01, to: S.sfxA });
    e._os(t, 0.3, 'sine', 520, 0.1 * v, { f1: 140, a: 0.005 });
    for (let i = 0; i < 3; i++) e._note('celesta', T + 24 + pick(PENTA), t + 0.08 + i * 0.07, 0.28, { g: v, to: S.sfxC, pan: rnd(-0.5, 0.5) });
  },
  slimeHop(e, t, k) {
    const v = vol(k), p = rnd(0.85, 1.2);
    e._os(t, 0.26, 'sine', 170 * p, 0.12 * v, { f1: 340 * p, ft: 0.07, f2: 130 * p, a: 0.01, lp: 900 });
    e._nz(t, 0.11, 'bandpass', 500, 0.05 * v, { f1: 1100, q: 3, a: 0.01 });
  },
  slimeHit(e, t, k) {
    const v = vol(k), p = rnd(0.9, 1.15);
    e._nz(t, 0.15, 'bandpass', 900 * p, 0.32 * v, { f1: 350, q: 2.5, a: 0.002 });
    e._os(t, 0.17, 'sine', 260 * p, 0.32 * v, { f1: 90 });
    e._os(t + 0.03, 0.07, 'sine', 600 * p, 0.06 * v, { f1: 1400 * p, a: 0.004 });
  },
  boneRattle(e, t, k) {
    const v = vol(k), S = e._to;
    let tt = t;
    for (let i = rndi(4, 7); i > 0; i--) { e._note('wood', 80 + rnd(-4, 9), tt, rnd(0.4, 0.9), { g: v, pan: rnd(-0.35, 0.35), to: S.sfxA }); tt += rnd(0.035, 0.07); }
  },
  bossRoar(e, t, k) {
    e._roar(t, 1.7, vol(k));
  },
  bossSlam(e, t, k) {
    const v = vol(k), S = e._to;
    e._os(t, 0.9, 'sine', 90, 0.72 * v, { f1: 28, ft: 0.5 });
    e._nz(t, 0.7, 'lowpass', 1400, 0.5 * v, { f1: 120, a: 0.003, to: S.sfxH });
    e._nz(t, 0.06, 'highpass', 2000, 0.2 * v, { a: 0.001 });
    e._nz(t + 0.1, 1.5, 'lowpass', 160, 0.26 * v, { a: 0.1, to: S.sfxH });
    for (let i = 0; i < 6; i++) e._nz(t + rnd(0.15, 0.9), 0.08, 'bandpass', rnd(400, 1500), 0.06 * v, { q: 1.2, pan: rnd(-0.6, 0.6) });   // debris
  },
  explosion(e, t, k) {
    const v = vol(k), S = e._to;
    e._nz(t, 0.04, 'highpass', 1500, 0.3 * v, { a: 0.001 });
    e._nz(t, 1.3, 'lowpass', 3500, 0.62 * v, { f1: 110, ft: 0.7, a: 0.004, to: S.sfxH });
    e._os(t, 1.1, 'sine', 85, 0.72 * v, { f1: 26, ft: 0.6, a: 0.004 });
    e._nz(t + 0.05, 1.8, 'lowpass', 250, 0.3 * v, { a: 0.2, to: S.sfxH });
    for (let i = 0; i < 5; i++) e._nz(t + rnd(0.2, 1), 0.02, 'bandpass', rnd(1200, 4000), rnd(0.03, 0.08) * v, { q: 2, a: 0.001, pan: rnd(-0.6, 0.6) });
  },
  fire(e, t, k) {
    const v = vol(k), S = e._to;
    e._nz(t, 0.5, 'bandpass', 220, 0.4 * v, { f1: 1900, ft: 0.25, f2: 700, q: 0.7, a: 0.14, to: S.sfxA });
    e._os(t + 0.03, 0.3, 'sine', 110, 0.3 * v, { f1: 58 });
    for (let i = 0; i < 8; i++) e._nz(t + 0.15 + rnd(0, 0.6), 0.016, 'bandpass', rnd(1500, 5000), rnd(0.05, 0.14) * v, { q: 2, a: 0.001, pan: rnd(-0.5, 0.5) });   // crackle
  },
  teleport(e, t, k, T) {
    const v = vol(k), S = e._to;
    for (let i = 0; i < 3; i++) e._os(t, 0.86, 'sine', 260 * [1, 1.5, 2.01][i], 0.045 * v, { f1: 2080 * [1, 1.5, 2.01][i], ft: 0.78, a: 0.55, to: S.sfxH });
    e._nz(t, 0.86, 'bandpass', 400, 0.12 * v, { f1: 5000, ft: 0.78, q: 2, a: 0.6, to: S.sfxB });
    let tt = t + 0.02, dt = 0.13;
    for (let i = 0; i < 8; i++) { e._note('glass', T + 7 + deg(PENTA, i + 1), tt, 0.3 + 0.035 * i, { g: 0.7 * v, to: S.sfxH, pan: rnd(-0.5, 0.5) }); tt += dt; dt *= 0.86; }
    e._nz(t + 0.8, 0.8, 'bandpass', 5000, 0.32 * v, { f1: 300, q: 0.8, a: 0.02, to: S.sfxH });   // airy drop
    e._os(t + 0.8, 0.4, 'sine', 140, 0.35 * v, { f1: 50, ft: 0.25 });
    e._note('celesta', T + 36, t + 0.82, 0.4, { g: v, to: S.sfxH });
  },
  eat(e, t, k) {
    const v = vol(k);
    for (let i = 0; i < 3; i++) {
      const tt = t + i * 0.16;
      e._nz(tt, 0.09, 'bandpass', rnd(900, 1500), 0.2 * v, { f1: 500, q: 1.5 });
      e._nz(tt + 0.02, 0.04, 'highpass', 2500, 0.06 * v, { a: 0.002 });
    }
    e._os(t + 0.52, 0.16, 'sine', 240, 0.12 * v, { f1: 130, ft: 0.06, f2: 190, a: 0.01, lp: 700 });   // gulp
  },
  levelup(e, t, k, T) {
    const v = vol(k), S = e._to;
    e._nz(t, 1.1, 'bandpass', 800, 0.08 * v, { f1: 6000, ft: 0.9, q: 1.5, a: 0.6, to: S.sfxB });
    for (let i = 0; i < 8; i++) e._note('celesta', T + 12 + deg(PENTA, i), t + i * 0.05, 0.3 + 0.045 * i, { g: v, to: S.sfxC, pan: -0.4 + 0.1 * i });
    for (const s of [24, 28, 31]) e._note('celesta', T + s, t + 0.45, 0.6, { g: v, to: S.sfxC });
    e._note('glass', T + 36, t + 0.55, 0.5, { g: v, to: S.sfxH });
  },
  waypoint(e, t, k, T) {
    const v = vol(k), S = e._to, ar = [0, 7, 12, 14, 19, 24];
    for (let i = 0; i < 6; i++) e._note('glass', T + ar[i], t + i * 0.09, 0.4 + 0.04 * i, { g: v, to: S.sfxH, pan: -0.4 + 0.16 * i });
    e._note('celesta', T + 36, t + 0.6, 0.4, { g: v, to: S.sfxH });
    e._os(t, 1.4, 'sine', mtof(T - 12), 0.08 * v, { a: 0.3, to: S.sfxB });
    e._nz(t + 0.2, 0.9, 'highpass', 6000, 0.02 * v, { a: 0.3, to: S.sfxB });
  },
  thunder(e, t, k) {
    e._thunder(t, vol(k));
  },
};

// ---------------------------------------------------------------------------------------------
// Stingers. Notes are [time, semitones from tonic, velocity, instrument (p/c/g/k)]; each entry
// returns its length in seconds so the field music can make room for it.
// ---------------------------------------------------------------------------------------------

const STINGERS = {
  discover(e, t, T) {          // rising flourish that settles on a lydian colour
    e._pad(t, [T - 12, T + 7, T + 14, T + 16], 2.6, 0.05, 1100, e._to.sting, 0.9, 2.2);
    e._score(t, T, [[0, -12, 0.42], [0, 7, 0.46], [0.14, 12, 0.5], [0.28, 14, 0.55], [0.42, 19, 0.62], [0.6, 23, 0.56], [1.05, 21, 0.6],
      [1.08, 0, 0.36], [1.12, 7, 0.34], [1.16, 16, 0.36], [1.5, 26, 0.4, 'g'], [1.9, 30, 0.34, 'g'], [2.3, 33, 0.3, 'c']]);
    return 4.2;
  },
  chest(e, t, T) {             // quick climb, bright chord, sparkle
    e._pad(t + 0.5, [T - 12, T, T + 7, T + 16], 1.2, 0.045, 1400, e._to.sting, 0.25, 1.6);
    e._score(t, T, [[0, 7, 0.4], [0.1, 9, 0.42], [0.2, 11, 0.46], [0.3, 12, 0.5], [0, 19, 0.45, 'c'], [0.1, 21, 0.5, 'c'], [0.2, 23, 0.55, 'c'], [0.3, 24, 0.6, 'c'],
      [0.52, -12, 0.5], [0.52, 0, 0.55], [0.54, 4, 0.55], [0.56, 7, 0.58], [0.58, 12, 0.66], [0.6, 16, 0.7],
      [0.6, 24, 0.55, 'c'], [0.74, 28, 0.5, 'c'], [0.88, 31, 0.5, 'c'], [1.04, 36, 0.45, 'c']]);
    return 2.6;
  },
  orb(e, t, T) {               // slow glass fifths rising into an add9 shimmer
    e._pad(t, [T - 12, T + 7, T + 14], 2.4, 0.045, 900, e._to.sting, 0.8, 2.4);
    e._score(t, T, [[0, -12, 0.34], [0, -5, 0.3], [0, 12, 0.5, 'g'], [0.34, 19, 0.52, 'g'], [0.68, 24, 0.55, 'g'], [1.02, 26, 0.58, 'g'], [1.5, 31, 0.6, 'g'],
      [1.72, 38, 0.3, 'c'], [1.88, 36, 0.28, 'c'], [2.1, 43, 0.24, 'c']]);
    return 4;
  },
  quest(e, t, T) {             // parallel fourths stepping up to the tonic
    e._pad(t + 1.1, [T - 12, T + 7, T + 12, T + 16], 1, 0.045, 1200, e._to.sting, 0.3, 1.6);
    e._score(t, T, [[0, 7, 0.5], [0.01, 12, 0.54], [0.3, 9, 0.5], [0.31, 14, 0.54], [0.78, 11, 0.54], [0.79, 16, 0.58],
      [1.14, -12, 0.46], [1.14, 0, 0.44], [1.16, 7, 0.5], [1.18, 12, 0.58], [1.2, 19, 0.66],
      [0, 19, 0.3, 'k'], [0.3, 21, 0.3, 'k'], [0.78, 23, 0.32, 'k'], [1.2, 24, 0.4, 'k'], [1.5, 31, 0.3, 'c']]);
    return 2.8;
  },
  victory(e, t, T) {           // IV - V - I with a climbing melody
    const S = e._to.sting;
    e._pad(t, [T - 7, T + 5, T + 9, T + 12], 0.8, 0.05, 1300, S, 0.15, 1.2);
    e._pad(t + 0.9, [T - 5, T + 7, T + 11, T + 14], 0.8, 0.05, 1400, S, 0.15, 1.2);
    e._pad(t + 1.8, [T - 12, T, T + 7, T + 12, T + 16], 2.4, 0.055, 1500, S, 0.15, 2.4);
    e._score(t, T, [[0, -19, 0.5], [0, 12, 0.56], [0.22, 12, 0.5], [0.45, 17, 0.62], [0.45, 9, 0.44],
      [0.9, -17, 0.5], [0.9, 14, 0.58], [1.12, 14, 0.52], [1.35, 19, 0.66], [1.35, 11, 0.46],
      [1.8, -24, 0.56], [1.8, -12, 0.5], [1.82, 12, 0.6], [1.84, 16, 0.62], [1.86, 19, 0.64], [1.88, 24, 0.74],
      [2.1, 28, 0.5, 'c'], [2.24, 31, 0.5, 'c'], [2.38, 36, 0.5, 'c'], [2.56, 40, 0.42, 'c'], [2.9, 43, 0.34, 'c']]);
    return 5;
  },
  gameover(e, t, T) {          // slow descent in the relative minor
    e._pad(t, [T - 15, T + 4, T + 9, T + 12], 3.6, 0.05, 600, e._to.sting, 1.2, 3);
    e._score(t, T, [[0, 16, 0.5], [0.75, 14, 0.46], [1.5, 12, 0.44], [2.5, 9, 0.5], [2.5, -15, 0.4], [2.54, -8, 0.36], [3.9, -27, 0.34], [3.9, 4, 0.3]]);
    return 6;
  },
  sigil(e, t, T) {             // deep fifth, glass climbing through the sharp fourth
    e._pad(t, [T - 12, T + 7, T + 11, T + 18], 3.2, 0.05, 1000, e._to.sting, 0.8, 2.5);
    e._score(t, T, [[0, -24, 0.56], [0, -12, 0.5], [0.02, -5, 0.46],
      [0.12, 12, 0.46, 'g'], [0.47, 18, 0.48, 'g'], [0.82, 19, 0.5, 'g'], [1.17, 23, 0.52, 'g'], [1.52, 26, 0.56, 'g'],
      [1.95, 0, 0.44], [2, 7, 0.44], [2.05, 11, 0.46], [2.1, 14, 0.48], [2.15, 18, 0.52], [2.45, 35, 0.3, 'c'], [2.6, 38, 0.28, 'c'], [2.8, 42, 0.24, 'c']]);
    return 5;
  },
  levelup(e, t, T) {           // pentatonic run into a full chord
    const run = [7, 9, 12, 14, 16, 19, 21, 24], list = [];
    for (let i = 0; i < 8; i++) list.push([i * 0.06, run[i], 0.4 + 0.04 * i], [i * 0.06, run[i] + 12, 0.3 + 0.03 * i, 'c']);
    list.push([0.56, -12, 0.44], [0.56, 0, 0.46], [0.57, 7, 0.48], [0.58, 12, 0.52], [0.59, 16, 0.54], [0.6, 19, 0.56], [0.61, 24, 0.62],
      [0.72, 28, 0.5, 'c'], [0.84, 31, 0.48, 'c'], [0.96, 36, 0.46, 'c'], [1.12, 40, 0.4, 'c']);
    e._pad(t + 0.5, [T - 12, T, T + 7, T + 16], 1.3, 0.05, 1500, e._to.sting, 0.2, 1.5);
    e._score(t, T, list);
    return 2.8;
  },
  waypoint(e, t, T) {          // two glass fifths answered by a sus2 chord
    e._pad(t, [T - 12, T + 7, T + 14], 1.8, 0.04, 1000, e._to.sting, 0.5, 2);
    e._score(t, T, [[0.05, -12, 0.36], [0.05, -5, 0.34], [0, 7, 0.5, 'g'], [0.26, 14, 0.52, 'g'], [0.62, 12, 0.5, 'g'], [0.88, 19, 0.55, 'g'],
      [1.3, 0, 0.4], [1.35, 7, 0.42], [1.4, 14, 0.46], [1.7, 26, 0.36, 'c'], [1.95, 31, 0.3, 'c']]);
    return 3.4;
  },
  title(e, t, T) {             // the main theme, in full
    const b = 0.62, S = e._to.sting, pad = (b0, b1, notes) => e._pad(t + b0 * b, notes, (b1 - b0) * b, 0.05, 1000, S, 1, 2.4);
    pad(0, 5, [T - 12, T + 7, T + 14, T + 16]);
    pad(5, 8.5, [T - 15, T + 4, T + 7, T + 12]);
    pad(8.5, 13, [T - 19, T - 3, T, T + 4, T + 9]);
    pad(13, 14.2, [T - 17, T + 2, T + 7, T + 11]);
    pad(14.2, 18, [T - 12, T + 4, T + 7, T + 12]);
    e._score(t, T, [[0, 7, 0.46], [1, 12, 0.52], [2, 14, 0.55], [3, 16, 0.64], [5, 14, 0.5], [6, 19, 0.68],
      [8.5, 16, 0.56], [9.25, 14, 0.5], [10, 12, 0.52], [11, 9, 0.58], [13, 11, 0.48], [14.2, 12, 0.6],
      [0, -12, 0.4], [0.5, -5, 0.32], [1.5, 4, 0.3], [3, -5, 0.3], [5, -15, 0.4], [5.5, -8, 0.32], [6.5, 0, 0.3],
      [8.5, -19, 0.42], [9, -7, 0.32], [10, -3, 0.3], [11, 0, 0.3], [13, -17, 0.4], [13.5, -5, 0.32],
      [14.2, -24, 0.46], [14.2, -12, 0.4], [14.26, -5, 0.36], [14.32, 0, 0.36], [14.38, 4, 0.38],
      [14.25, 24, 0.3, 'g'], [15.2, 28, 0.34, 'c'], [15.7, 31, 0.3, 'c'], [16.4, 36, 0.26, 'c']], b);
    return 12;
  },
};
const SCORE_INST = { c: 'celesta', g: 'glass', k: 'pluck' };

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------

export class AudioEngine {
  constructor() {
    this._ctx = null;            // created in unlock(): browsers refuse audio before a user gesture
    this._ready = false;
    this._offline = false;       // an OfflineAudioContext (tests) never reports 'running' before it renders
    this._vol = { master: 0.8, music: 0.7, sfx: 0.8, ambience: 0.7 };
    this._env = { night: 0, region: '', altitude: 0, nearWater: 0, inForest: 0, wind: 0.3, rain: 0, combat: false, swimming: false, time: 12 };
    this._live = 0;              // one-shot voices currently alive
    this._last = Object.create(null);
    this._stepT = -1;
    this._stepSide = 1;
    this._stingT = -1;
    this._ctlT = 0;
    this._jobs = [];             // deferred buffer synthesis, one job per frame
    this._samples = new Map();   // instrument + root pitch -> AudioBuffer
    this._ev = [];               // scratch: notes of the phrase being composed
    this._pn = [];               // scratch: notes of the pad chord being voiced
    this._errors = 0;
    this._lastError = null;
  }

  get ready() {
    const c = this._ctx;
    return !!c && this._ready && (this._offline || c.state === 'running');
  }

  unlock() {
    try {
      if (!this._ctx) this._build();
      const ctx = this._ctx;
      if (this._offline || ctx.state === 'running') this._start();
      else if (ctx.resume) ctx.resume().then(() => { if (this._ctx === ctx && ctx.state === 'running') this._start(); }, () => {});
    } catch (e) { this._fail(e); }
  }

  setVolumes(v) {
    try {
      if (!v) return;
      const V = this._vol;
      for (const k in V) if (typeof v[k] === 'number' && isFinite(v[k])) V[k] = clamp(v[k], 0, 1);
      if (this._ctx) this._applyVolumes(0.04);
    } catch (e) { this._fail(e); }
  }

  setEnvironment(env) {
    try {
      if (!env) return;
      const e = this._env;
      e.night = clamp(num(env.night, e.night), 0, 1);
      e.altitude = num(env.altitude, e.altitude);
      e.nearWater = clamp(num(env.nearWater, e.nearWater), 0, 1);
      e.inForest = clamp(num(env.inForest, e.inForest), 0, 1);
      e.wind = clamp(num(env.wind, e.wind), 0, 1);
      e.rain = clamp(num(env.rain, e.rain), 0, 1);
      e.time = num(env.time, e.time);
      if (typeof env.region === 'string') e.region = env.region;
      if (env.combat !== undefined) e.combat = !!env.combat;
      if (env.swimming !== undefined) {
        const s = !!env.swimming;
        if (s !== e.swimming) { e.swimming = s; this._ctlT = 0; }          // muffle on the very next frame
      }
    } catch (err) { this._fail(err); }
  }

  sfx(name, intensity = 1) {
    if (!this.ready) return;
    try {
      if (!has(SFX, name)) return;
      const now = this._ctx.currentTime, last = this._last[name];
      if (last !== undefined && now >= last && now - last < 0.03) return;  // same effect twice in a frame
      this._last[name] = now;
      SFX[name](this, now + 0.006, num(intensity, 1), this._tonic());
    } catch (e) { this._fail(e); }
  }

  footstep(player) {
    if (!this.ready) return;
    try {
      const now = this._ctx.currentTime;
      if (now >= this._stepT && now - this._stepT < 0.09) return;
      this._stepT = now;
      const e = this._env, t = now + 0.004, y = player && player.pos ? num(player.pos.y, e.altitude) : e.altitude;
      const snow = y > 300 || (e.region === 'Frostcrown' && y > 250), wet = e.nearWater > 0.9 && !snow;
      const p = rnd(0.85, 1.2), v = rnd(0.85, 1.1) * (player && player.sprinting ? 1.25 : 1), pan = (this._stepSide = -this._stepSide) * 0.12;
      if (snow) {                                              // slower, lower crunch
        this._nz(t, 0.2, 'bandpass', 620 * p, 0.13 * v, { f1: 380 * p, q: 1.1, a: 0.012, pan });
        this._nz(t + 0.035, 0.12, 'bandpass', 1700 * p, 0.05 * v, { q: 1.4, a: 0.01, pan });
        this._nz(t, 0.1, 'lowpass', 160, 0.14 * v, { pan });
      } else {                                                 // soft grass: scuff, thump, blade swish
        this._nz(t, 0.13, 'bandpass', 1000 * p, 0.1 * v, { f1: 600 * p, q: 0.8, a: 0.006, pan });
        this._nz(t, 0.09, 'lowpass', 170 * p, 0.12 * v, { pan });
        this._nz(t + 0.01, 0.11, 'highpass', 3800, 0.022 * v, { a: 0.02, pan });
      }
      if (wet) {
        this._nz(t, 0.2, 'bandpass', 2200, 0.05 * v, { f1: 1200, q: 0.6, a: 0.01, pan });
        const f = rnd(500, 900);
        this._os(t + 0.02, 0.07, 'sine', f, 0.03 * v, { f1: f * 1.5, pan });
      }
    } catch (e) { this._fail(e); }
  }

  stinger(name) {
    if (!this.ready) return;
    try {
      if (!has(STINGERS, name)) return;
      const now = this._ctx.currentTime;
      if (now >= this._stingT && now - this._stingT < 0.25) return;
      this._stingT = now;
      const len = STINGERS[name](this, now + 0.08, this._tonic());
      // make room: duck the field music and hold back its next phrase
      const M = this._m, g = this._duck.gain;
      M.hold = Math.max(M.hold, now + len * 0.85);
      M.nextPhraseT = Math.max(M.nextPhraseT, now + len + rnd(1.5, 4));
      g.cancelScheduledValues(now); g.setTargetAtTime(0.2, now, 0.15); g.setTargetAtTime(1, now + len * 0.8, 1);
    } catch (e) { this._fail(e); }
  }

  update(dt) {
    if (!this.ready) return;
    try {
      const now = this._ctx.currentTime;
      if (this._jobs.length) this._jobs.pop()();
      if (now >= this._ctlT) { this._ctlT = now + 0.2; this._control(now); }
      this._musicTick(now);
    } catch (e) { this._fail(e); }
  }

  // ---- setup ------------------------------------------------------------------------------

  _fail(e) {
    this._lastError = e;
    if (this._errors++ < 3) console.warn('[audio]', e);
  }

  _build() {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) throw new Error('Web Audio API unavailable');
    const ctx = new AC({ latencyHint: 'interactive' });
    try {
      this._ctx = ctx;
      this._offline = typeof ctx.startRendering === 'function';
      this._graph(ctx);
    } catch (e) {
      this._ctx = null;
      try { if (ctx.close) ctx.close(); } catch (_) { /* already closed */ }
      throw e;
    }
  }

  _graph(ctx) {
    const G = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const chain = (...nodes) => { for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i]); return nodes[0]; };
    const filter = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    const V = this._vol;
    this._nyq = ctx.sampleRate / 2;
    this._open = Math.min(20000, this._nyq * 0.9);

    // master: mix -> swim low-pass -> master fader -> compressor -> soft clip
    const mix = G(1), swim = filter('lowpass', this._open, 0.4), master = this._master = G(0);
    const comp = ctx.createDynamicsCompressor(), post = G(COMP_TRIM * 0.5), clip = this._clip = ctx.createWaveShaper();
    comp.threshold.value = -20; comp.knee.value = 18; comp.ratio.value = 3; comp.attack.value = 0.008; comp.release.value = 0.25;
    clip.curve = softClipCurve();
    chain(mix, swim, master, comp, post, clip, ctx.destination);
    this._sSwim = slot(swim.frequency, this._open);

    // two shared reverbs; their inputs carry the category faders so tails follow the sliders
    const revL = ctx.createConvolver(), revS = ctx.createConvolver();
    revL.buffer = makeImpulse(ctx, 3.6, 3.2, 0.018, 7500);
    revS.buffer = makeImpulse(ctx, 1.5, 1.2, 0.008, 9000);
    chain(revL, G(1), mix); chain(revS, G(0.9), mix);
    const musicWet = this._musicWet = chain(G(fader(V.music)), revL), sfxWetS = this._sfxWetS = chain(G(fader(V.sfx)), revS);
    const sfxWetL = this._sfxWetL = chain(G(fader(V.sfx)), revL), ambWet = this._ambWet = chain(G(fader(V.ambience)), revS);

    // category buses
    const musicBus = this._musicBus = chain(G(fader(V.music)), mix), sfxBus = this._sfxBus = chain(G(fader(V.sfx)), mix);
    const ambBus = this._ambBus = chain(G(fader(V.ambience)), G(1.5), mix), uiBus = this._uiBus = G(fader(V.sfx));
    uiBus.connect(master);                                     // menus stay clear under water

    // music sub-buses: field (ducked by combat) -> duck (ducked by stingers); combat; stingers
    const field = this._field = G(1), duck = this._duck = G(1), fieldSend = G(0.5), combat = this._combatBus = G(0), sting = G(1), extra = G(0.45);
    chain(field, duck, musicBus); chain(duck, fieldSend, musicWet);
    combat.connect(musicBus); chain(combat, G(0.12), musicWet);
    sting.connect(musicBus); chain(sting, G(0.55), musicWet);
    extra.connect(musicWet);
    this._sFieldSend = slot(fieldSend.gain, 0.5);

    // destinations a voice can be sent to (dry bus plus an optional reverb send)
    const sA = chain(G(0.12), sfxWetS), sB = chain(G(0.3), sfxWetS), sC = chain(G(0.6), sfxWetS), sH = chain(G(0.5), sfxWetL), aS = chain(G(0.4), ambWet);
    this._to = {
      sfx: [sfxBus], sfxA: [sfxBus, sA], sfxB: [sfxBus, sB], sfxC: [sfxBus, sC], sfxH: [sfxBus, sH], ui: [uiBus], amb: [ambBus, aS],
      field: [field], fieldX: [field, extra], sting: [sting], stingX: [sting, extra], combat: [combat], combatX: [combat, extra],
    };
    this._oField = { to: this._to.field };
    this._oFieldX = { to: this._to.fieldX };

    // shared sources and waves
    this._white = makeNoise(ctx, 2, 1, false);
    this._pink = makeNoise(ctx, 6, 2, true);
    const im = new Float32Array(15), re = new Float32Array(15);
    for (let n = 1; n < 15; n++) im[n] = (n & 1 ? 1 : 0.6) * Math.pow(n, -1.7);
    this._padWave = ctx.createPeriodicWave(re, im);

    // ambience: one pink-noise loop feeds the wind bands, leaf rustle and water swells
    const A = this._amb = { gust: 0.4, gustTo: 0.5, birdT: 0, owlT: 0, waveT: 0 };
    const wind = ctx.createBufferSource();
    wind.buffer = this._pink; wind.loop = true;
    const air = filter('highpass', 110, 0.5);                  // no sub rumble: wind should read as air
    const wLP = filter('lowpass', 300, 0.3), wLow = G(0), wBP = filter('bandpass', 900, 0.8), wHi = G(0), lBP = filter('bandpass', 5200, 0.6), leaf = G(0);
    const vLP = filter('lowpass', 500, 0.4), vEnv = A.waveEnv = G(0.12), vLvl = G(0);
    wind.connect(air);
    chain(air, wLP, wLow, ambBus); chain(air, wBP, wHi, ambBus); chain(air, lBP, leaf, ambBus); chain(air, vLP, vEnv, vLvl, ambBus);
    wind.start();
    A.waveLP = vLP;
    A.sWindLow = slot(wLow.gain, 0); A.sWindLPf = slot(wLP.frequency, 300); A.sWindHi = slot(wHi.gain, 0); A.sWindBPf = slot(wBP.frequency, 900);
    A.sLeaf = slot(leaf.gain, 0); A.sWave = slot(vLvl.gain, 0);
    // looped beds: `make` returns a render generator; started only when first audible
    const loop = (make, ...post) => { const g = G(0); chain(g, ...post, ambBus); return { make, buf: null, src: null, in: g, s: slot(g.gain, 0), idle: 0 }; };
    const rainLP = filter('lowpass', 4000, 0.3);
    A.crkA = loop(() => renderCrickets(ctx, 6.7, 3));
    A.crkB = loop(() => renderCrickets(ctx, 9.1, 4));
    A.babble = loop(() => renderBabble(ctx, 7.3));
    A.rain = loop(() => renderRain(ctx, 5.9), rainLP);
    A.sRainF = slot(rainLP.frequency, 4000);

    // music state
    this._m = {
      mood: 'day', region: '', key: 0, keyNext: 0, T: 60, isNight: false, chord: null, cyc: null, ci: 0, pad: null, motif: null,
      nextChordT: 0, nextPhraseT: 0, hold: 0, kind: -1, vMel: null, vPos: 5, vCount: 0,
      combatOn: false, cActive: false, cOff: 0, cStep: 0, cNext: 0, cProg: 0,
    };
    this._P = { T: 60, sc: PENTA, ch: null, slow: 1, lo: 0, hi: 0 };
  }

  _start() {
    if (this._ready) return;
    this._ready = true;
    const now = this._ctx.currentTime, M = this._m, A = this._amb;
    this._applyVolumes(0.4);                                   // fade in
    M.region = this._env.region; M.key = M.keyNext = keyOf(M.region); M.T = tonicOf(M.key);
    M.nextChordT = now + 0.8; M.nextPhraseT = now + rnd(3, 5);
    A.birdT = now + rnd(1, 3); A.owlT = now + rnd(8, 20);
    // pre-render what will be needed soon, one buffer per frame; the piano comes off the queue first
    const J = this._jobs, warm = (inst, a, b) => { for (let r = a; r <= b; r += 4) J.push(() => this._sample(inst, r)); };
    for (const L of [A.rain, A.babble, A.crkB, A.crkA]) {
      const it = L.make(), step = () => { if (L.buf) return; const r = it.next(); if (r.done) L.buf = r.value; else J.push(step); };
      J.push(step);
    }
    J.push(() => this._sample('wood', 84), () => this._sample('bell', 76));
    warm('glass', 72, 84); warm('celesta', 72, 92); warm('pluck', 72, 84); warm('piano', 44, 88);
    this._ctlT = now + 0.2;
    this._control(now);
  }

  _applyVolumes(tc) {
    const t = this._ctx.currentTime, V = this._vol, mu = fader(V.music), sf = fader(V.sfx), am = fader(V.ambience);
    const set = (node, v) => node.gain.setTargetAtTime(v, t, tc);
    set(this._master, fader(V.master));
    set(this._musicBus, mu); set(this._musicWet, mu);
    set(this._sfxBus, sf); set(this._sfxWetS, sf); set(this._sfxWetL, sf); set(this._uiBus, sf);
    set(this._ambBus, am); set(this._ambWet, am);
  }

  _tonic() { return tonicOf(this._m.keyNext); }

  _sample(inst, root) {
    const key = inst + root;
    let buf = this._samples.get(key);
    if (!buf) {
      const ctx = this._ctx, data = renderTone(ctx.sampleRate, toneSpec(inst, root));
      buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.getChannelData(0).set(data);
      this._samples.set(key, buf);
    }
    return buf;
  }

  // ---- one-shot voices ------------------------------------------------------------------------

  // Connects a finished voice to its destinations and frees every node when its source ends.
  _out(node, pan, to, src, nodes) {
    let last = node;
    if (pan) { const p = this._ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); last.connect(p); last = p; nodes.push(p); }
    for (let i = 0; i < to.length; i++) last.connect(to[i]);
    this._live++;
    src.onended = () => { this._live--; for (let i = 0; i < nodes.length; i++) nodes[i].disconnect(); };
  }

  // Filtered noise burst. `g` is roughly the peak level whatever the filter bandwidth.
  // Options: f1/ft/f2 filter sweep, q, a attack, pan, to.
  _nz(t, d, type, f, g, o = NO) {
    if (this._live >= MAX_VOICES || !(g > 0)) return;
    const ctx = this._ctx, src = ctx.createBufferSource(), flt = ctx.createBiquadFilter(), amp = ctx.createGain();
    const top = this._nyq * 0.9, q = o.q || 0.7, fm = o.f1 ? Math.sqrt(f * o.f1) : f;
    const bw = type === 'lowpass' ? fm : type === 'highpass' ? Math.max(2000, this._nyq - fm) : 1.2 * fm / q;
    const peak = g * Math.min(7, 0.6 * Math.sqrt(this._nyq / bw)), a = Math.min(o.a || 0.004, d * 0.8);
    src.buffer = this._white; src.loop = true;
    flt.type = type; flt.Q.value = q;
    flt.frequency.setValueAtTime(Math.min(f, top), t);
    if (o.f1) {
      const ft = o.f2 ? Math.min(o.ft || d * 0.5, d * 0.9) : o.ft || d;
      flt.frequency.exponentialRampToValueAtTime(Math.min(o.f1, top), t + ft);
      if (o.f2) flt.frequency.exponentialRampToValueAtTime(Math.min(o.f2, top), t + d);
    }
    amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(peak, t + a); amp.gain.setTargetAtTime(0, t + a, (d - a) / 6);
    src.connect(flt); flt.connect(amp);
    this._out(amp, o.pan, o.to || this._to.sfx, src, [src, flt, amp]);
    src.start(t, Math.random() * 1.5); src.stop(t + d + 0.02);
  }

  // Oscillator blip with a pitch sweep. Options: f1/ft/f2 sweep, a attack, lp low-pass, pan, to.
  _os(t, d, type, f, g, o = NO) {
    if (this._live >= MAX_VOICES || !(g > 0)) return;
    const ctx = this._ctx, osc = ctx.createOscillator(), amp = ctx.createGain(), nodes = [osc, amp], a = Math.min(o.a || 0.003, d * 0.8);
    osc.type = type;
    osc.frequency.setValueAtTime(f, t);
    if (o.f1) {
      const ft = o.f2 ? Math.min(o.ft || d * 0.5, d * 0.9) : o.ft || d;
      osc.frequency.exponentialRampToValueAtTime(o.f1, t + ft);
      if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + d);
    }
    amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(g, t + a); amp.gain.setTargetAtTime(0, t + a, (d - a) / 6);
    let last = osc;
    if (o.lp) { const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = o.lp; lp.Q.value = 0.5; osc.connect(lp); last = lp; nodes.push(lp); }
    last.connect(amp);
    this._out(amp, o.pan, o.to || this._to.sfx, osc, nodes);
    osc.start(t); osc.stop(t + d + 0.02);
  }

  // Sampled-instrument note. Velocity sets level and, for the piano, brightness.
  // Options: g gain, dur (damp after this long), pan, to.
  _note(inst, midi, t, vel, o = NO) {
    if (this._live >= MAX_VOICES) return;
    const I = INST[inst], ctx = this._ctx;
    let root = I.fixed;
    if (!root) { midi = clamp(midi, I.lo, I.hi); root = I.lo + Math.round((midi - I.lo) / 4) * 4; }
    const src = ctx.createBufferSource(), amp = ctx.createGain(), nodes = [src, amp];
    const g = I.level * (o.g === undefined ? 1 : o.g) * (0.1 + 0.9 * vel * vel);
    src.buffer = this._sample(inst, root);
    src.playbackRate.value = Math.pow(2, (midi - root) / 12);
    amp.gain.value = g;
    let last = src;
    if (I.vlp) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.Q.value = 0.3; lp.frequency.value = clamp(mtof(midi) * (2.2 + 22 * vel * vel), 700, 16000);
      src.connect(lp); last = lp; nodes.push(lp);
    }
    last.connect(amp);
    const pan = o.pan !== undefined ? o.pan : I.fixed ? 0 : clamp((midi - 66) / 60, -0.4, 0.4);
    this._out(amp, pan, o.to || this._to.sfx, src, nodes);
    src.start(t);
    if (o.dur) { amp.gain.setValueAtTime(g, t + o.dur); amp.gain.setTargetAtTime(0, t + o.dur, 0.05); src.stop(t + o.dur + 0.35); }
  }

  // Short detuned-saw note or chord through a closing low-pass: staccato strings.
  _saw(t, d, g, cut, to, m0, m1, m2) {
    if (this._live >= MAX_VOICES) return;
    const ctx = this._ctx, lp = ctx.createBiquadFilter(), amp = ctx.createGain(), nodes = [lp, amp], a = 0.01;
    lp.type = 'lowpass'; lp.Q.value = 0.9;
    lp.frequency.setValueAtTime(cut, t); lp.frequency.setTargetAtTime(cut * 0.3, t + a, d * 0.3);
    amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(g, t + a); amp.gain.setTargetAtTime(0, t + a, d / 5.5);
    let first = null;
    for (let i = 0; i < 3; i++) {
      const m = i === 0 ? m0 : i === 1 ? m1 : m2;
      if (m === undefined) break;
      for (let k = 0; k < 2; k++) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = (k ? 7 : -7) + rnd(-2, 2);
        o.connect(lp); o.start(t); o.stop(t + d + 0.03);
        nodes.push(o);
        if (!first) first = o;
      }
    }
    lp.connect(amp);
    this._out(amp, 0, to, first, nodes);
  }

  // Sustained pad chord: two slowly beating oscillators per note, spread left/right, slow swell.
  // Returns a handle so the music can release it early.
  _pad(t, notes, dur, level, cut, to, atk, rel) {
    const ctx = this._ctx, g = ctx.createGain(), lp = ctx.createBiquadFilter(), pl = ctx.createStereoPanner(), pr = ctx.createStereoPanner();
    const end = t + dur + rel * 1.9, oscs = [], nodes = [g, lp, pl, pr];
    pl.pan.value = -0.45; pr.pan.value = 0.45;
    lp.type = 'lowpass'; lp.Q.value = 0.4;
    lp.frequency.setValueAtTime(cut * 0.75, t); lp.frequency.linearRampToValueAtTime(cut * 1.2, t + dur * 0.55); lp.frequency.linearRampToValueAtTime(cut * 0.7, end);
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t); g.gain.setTargetAtTime(level / Math.sqrt(notes.length), t, atk / 3); g.gain.setTargetAtTime(0, t + dur, rel / 3.2);
    for (let i = 0; i < notes.length; i++) {
      const f = mtof(notes[i]), d = rnd(0.2, 0.55);              // pair beats at 0.4-1.1 Hz whatever the pitch
      for (let k = 0; k < 2; k++) {
        const o = ctx.createOscillator();
        o.setPeriodicWave(this._padWave); o.frequency.value = k ? f + d : f - d;
        o.connect(k ? pr : pl); o.start(t); o.stop(end);
        oscs.push(o); nodes.push(o);
      }
    }
    pl.connect(lp); pr.connect(lp); lp.connect(g);
    for (let i = 0; i < to.length; i++) g.connect(to[i]);
    this._live++;
    oscs[0].onended = () => { this._live--; for (let i = 0; i < nodes.length; i++) nodes[i].disconnect(); };
    return { g, oscs, end };
  }

  _score(t, T, list, beat = 1) {
    const S = this._to;
    for (let i = 0; i < list.length; i++) {
      const n = list[i], inst = SCORE_INST[n[3]] || 'piano';
      this._note(inst, T + n[1], t + n[0] * beat, n[2], { to: inst === 'piano' ? S.sting : S.stingX });
    }
  }

  // Wooden creak: a slow sawtooth (stick-slip pulses) through two wandering resonances.
  _creak(t, d, v) {
    if (this._live >= MAX_VOICES) return;
    const ctx = this._ctx, osc = ctx.createOscillator(), b1 = ctx.createBiquadFilter(), b2 = ctx.createBiquadFilter(), amp = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(48, t);
    for (let i = 1; i <= 8; i++) osc.frequency.linearRampToValueAtTime(48 + 60 * (i / 8) + rnd(-14, 14), t + d * i / 8);
    b1.type = b2.type = 'bandpass'; b1.Q.value = 5; b2.Q.value = 7;
    b1.frequency.setValueAtTime(820, t); b1.frequency.linearRampToValueAtTime(1500, t + d);
    b2.frequency.setValueAtTime(2100, t); b2.frequency.linearRampToValueAtTime(2700, t + d);
    amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(0.34 * v, t + d * 0.3); amp.gain.setTargetAtTime(0, t + d * 0.6, d * 0.09);
    osc.connect(b1); osc.connect(b2); b1.connect(amp); b2.connect(amp);
    this._out(amp, 0, this._to.sfxA, osc, [osc, b1, b2, amp]);
    osc.start(t); osc.stop(t + d + 0.05);
  }

  // Boss roar: two rough sawtooths, amplitude-modulated into a growl, through moving formants.
  _roar(t, d, v) {
    if (this._live >= MAX_VOICES) return;
    const ctx = this._ctx, p = rnd(0.92, 1.08), S = this._to;
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), lfo = ctx.createOscillator(), depth = ctx.createGain(), am = ctx.createGain();
    const f1 = ctx.createBiquadFilter(), f2 = ctx.createBiquadFilter(), f2g = ctx.createGain(), amp = ctx.createGain();
    o1.type = o2.type = 'sawtooth';
    for (const [o, m] of [[o1, 1], [o2, 1.507]]) {
      o.frequency.setValueAtTime(52 * p * m, t); o.frequency.linearRampToValueAtTime(74 * p * m, t + d * 0.35); o.frequency.linearRampToValueAtTime(42 * p * m, t + d);
      o.connect(am); o.start(t); o.stop(t + d + 0.1);
    }
    lfo.frequency.value = rnd(22, 28); depth.gain.value = 0.45; am.gain.value = 0.55;
    lfo.connect(depth); depth.connect(am.gain); lfo.start(t); lfo.stop(t + d + 0.1);
    f1.type = f2.type = 'bandpass'; f1.Q.value = 2.2; f2.Q.value = 3; f2g.gain.value = 0.4;
    f1.frequency.setValueAtTime(320, t); f1.frequency.linearRampToValueAtTime(620, t + d * 0.4); f1.frequency.linearRampToValueAtTime(260, t + d);
    f2.frequency.setValueAtTime(1150, t); f2.frequency.linearRampToValueAtTime(880, t + d);
    amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(1.05 * v, t + 0.22); amp.gain.setTargetAtTime(0, t + d * 0.55, d * 0.1);
    am.connect(f1); am.connect(f2); f1.connect(amp); f2.connect(f2g); f2g.connect(amp);
    this._out(amp, 0, S.sfxH, o1, [o1, o2, lfo, depth, am, f1, f2, f2g, amp]);
    this._nz(t, d, 'bandpass', 600, 0.2 * v, { f1: 300, q: 0.7, a: 0.25, to: S.sfxH });       // breath
    this._nz(t, d * 1.15, 'lowpass', 110, 0.4 * v, { a: 0.3 });                               // rumble
  }

  // Thunder: low noise under a random rolling envelope, with a crack when it is close.
  _thunder(t, v) {
    if (this._live >= MAX_VOICES) return;
    const ctx = this._ctx, S = this._to, d = rnd(3.2, 5.2), N = 48, curve = new Float32Array(N);
    const src = ctx.createBufferSource(), lp = ctx.createBiquadFilter(), amp = ctx.createGain();
    src.buffer = this._white; src.loop = true; src.playbackRate.value = 0.5;
    lp.type = 'lowpass'; lp.Q.value = 0.3;
    lp.frequency.setValueAtTime(rnd(500, 800), t); lp.frequency.exponentialRampToValueAtTime(90, t + d);
    let lv = 1;
    for (let i = 1; i < N - 1; i++) {
      lv = chance(0.22) ? rnd(0.5, 1) : lv * 0.86;
      curve[i] = 2.6 * v * lv * Math.pow(1 - i / (N - 1), 1.4) * Math.min(1, i / 2);
    }
    amp.gain.setValueCurveAtTime(curve, t, d);
    src.connect(lp); lp.connect(amp);
    this._out(amp, rnd(-0.3, 0.3), S.sfxH, src, [src, lp, amp]);
    src.start(t, Math.random() * 1.5); src.stop(t + d + 0.05);
    if (v > 0.6) {
      this._nz(t, 0.35, 'bandpass', 2400, 0.2 * v, { f1: 500, q: 0.6, a: 0.003, to: S.sfxH });
      this._nz(t + 0.03, 0.6, 'lowpass', 900, 0.35 * v, { f1: 200, to: S.sfxH });
    }
  }

  // Bird call on one sine oscillator. Kinds: 0 chirps, 1 trill, 2 two-tone whistle, 3 warble,
  // 4 rising "whit", 5 dove coo, 6 owl.
  _bird(t, kind, g, pan) {
    if (this._live >= MAX_VOICES) return;
    const ctx = this._ctx, osc = ctx.createOscillator(), amp = ctx.createGain(), F = osc.frequency, A = amp.gain;
    let end = t;
    const note = (t0, d, f0, f1, lv, hold) => {
      const a = Math.min(hold ? 0.03 : 0.012, d * 0.3);
      F.setValueAtTime(f0, t0); F.exponentialRampToValueAtTime(f1, t0 + d);
      A.setValueAtTime(0, t0); A.linearRampToValueAtTime(lv * g, t0 + a);
      if (hold) A.setValueAtTime(lv * g, t0 + d * 0.7);
      A.linearRampToValueAtTime(0, t0 + d);
      end = t0 + d;
    };
    A.value = 0;
    if (kind === 0) {
      const f = rnd(3600, 5200);
      for (let i = rndi(2, 5), tt = t; i > 0; i--, tt += rnd(0.11, 0.17)) note(tt, 0.07, f * 1.25, f * 0.8, 1);
    } else if (kind === 1) {
      const f = rnd(4200, 6000), sp = rnd(0.045, 0.07), n = rndi(8, 16);
      for (let i = 0; i < n; i++) note(t + i * sp, sp * 0.7, f * (i & 1 ? 1.1 : 1), f * (i & 1 ? 1.02 : 0.93), 0.8);
    } else if (kind === 2) {
      const f = rnd(3300, 4200);
      note(t, 0.34, f, f * 0.97, 0.9, true); note(t + 0.44, 0.4, f * 0.84, f * 0.82, 0.8, true);
    } else if (kind === 3) {
      let f = rnd(2200, 3600), tt = t;
      for (let i = rndi(5, 9); i > 0; i--) {
        const d = rnd(0.07, 0.16), f1 = clamp(f * rnd(0.8, 1.3), 1800, 4800);
        note(tt, d, f, f1, rnd(0.6, 1));
        f = clamp(f1 * rnd(0.9, 1.15), 1800, 4800); tt += d + rnd(0.01, 0.05);
      }
    } else if (kind === 4) {
      const f = rnd(2400, 3000);
      for (let i = rndi(1, 3), tt = t; i > 0; i--, tt += 0.26) note(tt, 0.11, f, f * 1.75, 0.9);
    } else if (kind === 5) {
      const f = rnd(430, 520);
      g *= 1.6;
      note(t, 0.22, f * 1.04, f, 0.9, true); note(t + 0.3, 0.45, f * 1.1, f * 0.98, 1, true); note(t + 0.85, 0.3, f * 1.02, f * 0.95, 0.8, true);
    } else {
      const f = rnd(330, 400);
      g *= 1.8;
      note(t, 0.35, f, f * 0.96, 1, true); note(t + 0.7, 0.18, f, f * 0.98, 0.8, true); note(t + 0.95, 0.42, f * 1.01, f * 0.94, 1, true);
    }
    osc.connect(amp);
    this._out(amp, pan, this._to.amb, osc, [osc, amp]);
    osc.start(t); osc.stop(end + 0.05);
  }

  // ---- ambience -------------------------------------------------------------------------------

  // Looped bed: rendered and started the first time it is audible, stopped after 5 s of silence.
  _loop(L, level, now) {
    if (level > 0.003) {
      if (!L.src) {
        if (!L.buf) L.buf = finish(L.make());
        const src = L.src = this._ctx.createBufferSource();
        src.buffer = L.buf; src.loop = true; src.connect(L.in); src.start(now, Math.random() * L.buf.duration);
      }
      L.idle = 0;
    } else if (L.src && ++L.idle > 25) {
      L.src.stop(); L.src.disconnect(); L.src = null;
    }
    aim(L.s, level > 0.003 ? level : 0, now, 0.7);
  }

  // Runs every 0.2 s: follows the environment with slow parameter glides and schedules wildlife.
  _control(now) {
    const e = this._env, A = this._amb, w = e.wind, day = 1 - e.night, alt = smooth(140, 480, e.altitude);
    const coast = e.region.indexOf('Coast') >= 0, frost = e.region === 'Frostcrown';

    // wind: a low body and a higher whistle, both breathing with random gusts
    if (chance(0.06)) A.gustTo = Math.random();
    A.gust += (A.gustTo - A.gust) * 0.12;
    const gu = A.gust;
    aim(A.sWindLow, (0.09 + 0.22 * w + 0.1 * alt) * (0.7 + 0.6 * gu), now, 0.6);
    aim(A.sWindLPf, 240 + 420 * w + 260 * gu, now, 0.8);
    aim(A.sWindHi, (0.02 + 0.12 * w * w + 0.1 * alt) * (0.35 + 1.1 * gu), now, 0.6);
    aim(A.sWindBPf, 520 + 700 * w + 600 * alt + 500 * gu, now, 0.9);
    aim(A.sLeaf, e.inForest * (0.012 + 0.07 * w) * (0.3 + 1.2 * gu), now, 0.5);

    // beds
    const insects = smooth(0.4, 0.85, e.night) * (1 - 0.8 * e.rain) * (1 - alt) * (frost ? 0 : 1);
    this._loop(A.crkA, insects * 0.16, now);
    this._loop(A.crkB, insects * 0.1 * (0.5 + 0.5 * e.inForest), now);
    this._loop(A.babble, e.nearWater * (coast ? 0.06 : 0.2) + (e.swimming ? 0.06 : 0), now);
    this._loop(A.rain, Math.pow(e.rain, 0.8) * 0.45, now);
    aim(A.sRainF, 2600 + 6500 * e.rain, now, 0.8);

    // water swells: slow surf on the coast, quicker lapping on lakes and rivers
    const wl = e.nearWater * (coast ? 0.22 : 0.08);
    aim(A.sWave, wl, now, 0.8);
    if (wl > 0.01 && now >= A.waveT) {
      const per = coast ? rnd(6, 9) : rnd(3.2, 5.5), rise = per * 0.3, t = now + 0.05, g = A.waveEnv.gain, f = A.waveLP.frequency;
      g.setTargetAtTime(rnd(0.6, 1), t, rise / 3); g.setTargetAtTime(0.12, t + rise, per * 0.22);
      f.setTargetAtTime(coast ? 1900 : 1100, t, rise / 2.5); f.setTargetAtTime(380, t + rise, per * 0.25);
      A.waveT = now + per;
    }

    aim(this._sSwim, e.swimming ? 850 : this._open, now, e.swimming ? 0.08 : 0.2);

    // birds by day (more in forest, a dawn chorus, fewer in rain, wind and thin air)
    if (now >= A.birdT) {
      const dawn = 1 + 0.8 * Math.max(0, 1 - Math.abs(e.time - 6.5) / 1.8);
      const d = day * day * (0.3 + 0.7 * e.inForest) * (1 - 0.85 * e.rain) * (1 - alt) * (1 - 0.5 * w) * dawn;
      if (d > 0.04 && !e.swimming) {
        const kind = chance(0.1 * e.inForest) ? 5 : rndi(0, 4), g = rnd(0.25, 1) * 0.05, pan = rnd(-0.9, 0.9), t = now + rnd(0.02, 0.3);
        this._bird(t, kind, g, pan);
        if (chance(0.3)) this._bird(t + rnd(1.2, 2.4), kind, g * rnd(0.4, 0.8), -pan * rnd(0.5, 1));   // a neighbour answers
        A.birdT = now + clamp(-Math.log(1 - Math.random()) * 2.6 / d, 0.5, 18);
      } else A.birdT = now + 2;
    }
    if (e.night > 0.8 && e.inForest > 0.3 && now >= A.owlT) {
      this._bird(now + 0.1, 6, 0.045, rnd(-0.8, 0.8));
      A.owlT = now + rnd(18, 45);
    }
  }

  // ---- generative music -----------------------------------------------------------------------

  _musicTick(now) {
    const M = this._m, e = this._env;
    if (e.night > 0.62) M.isNight = true; else if (e.night < 0.42) M.isNight = false;
    const mood = e.region === 'Frostcrown' ? 'frost' : e.region === 'Hearthvale' ? 'village' : M.isNight ? 'night' : 'day';
    let retune = mood !== M.mood;
    if (e.region !== M.region) {
      M.region = e.region;
      const k = keyOf(e.region);
      if (k !== M.keyNext) { M.keyNext = k; retune = true; }
    }
    if (retune) {                                              // let the old harmony clear before the new one enters
      M.mood = mood; M.cyc = null;
      this._padOff(now, 0.9);
      M.nextChordT = Math.max(now + 2.2, M.hold);
      M.nextPhraseT = M.nextChordT + rnd(1.5, 3.5);
    }

    if (e.combat !== M.combatOn) {
      M.combatOn = e.combat;
      if (e.combat) {
        this._combatBus.gain.setTargetAtTime(1, now, 0.3); this._field.gain.setTargetAtTime(0.1, now, 0.5);
        if (!M.cActive) { M.cActive = true; M.cStep = 0; M.cNext = now + 0.12; M.cProg = rndi(0, COMBAT.length - 1); }
        M.cOff = Infinity;
      } else {
        this._combatBus.gain.setTargetAtTime(0, now, 1.2); this._field.gain.setTargetAtTime(1, now, 2);
        M.cOff = now + 5;
        M.nextPhraseT = Math.max(M.nextPhraseT, now + rnd(5, 8));
      }
    }
    if (this._vol.music < 0.004) return;                       // muted: compose nothing
    if (M.cActive) {
      if (now > M.cOff) M.cActive = false;
      else {
        if (M.cNext < now + 0.02) M.cNext = now + 0.06;        // resync after a stall
        while (M.cNext < now + 0.22) { this._combatStep(M.cStep, M.cNext); M.cStep = (M.cStep + 1) & 63; M.cNext += STEP; }
      }
    }
    if (M.combatOn) return;
    if (M.mood !== 'village' && now + 0.25 >= M.nextChordT) this._chord(Math.max(now + 0.1, M.nextChordT));
    if (now + 0.2 >= M.nextPhraseT && now >= M.hold) this._phrase(Math.max(now + 0.12, M.nextPhraseT));
  }

  // Next pad chord for the current mood; also where a pending key change takes effect.
  _chord(t, dur) {
    const M = this._m, md = MOODS[M.mood], notes = this._pn;
    M.key = M.keyNext; M.T = tonicOf(M.key);
    let ch;
    if (md.cyc) {
      if (!M.cyc || M.ci >= M.cyc.length) { M.cyc = pick(md.cyc); M.ci = 0; }
      ch = md.ch[M.cyc[M.ci++]];
    } else do { ch = chance(0.4) ? md.ch[rndi(0, 1)] : pick(md.ch); } while (ch === M.chord);
    M.chord = ch;
    if (dur === undefined) dur = rnd(md.cd[0], md.cd[1]);
    const base = M.T - (md.minor ? 3 : 0), bass = base - 12 + ch.b;
    notes.length = 0;
    notes.push(bass < 38 ? bass + 12 : bass);
    for (let i = 0; i < ch.t.length; i++) notes.push(base + ch.t[i]);
    M.pad = this._pad(t, notes, dur, md.pad, md.cut, this._to.field, md.cyc ? 1.2 : 3.5, md.cyc ? 2.2 : 5);
    M.nextChordT = t + dur;
    aim(this._sFieldSend, md.send * (M.isNight ? 1.2 : 1), t, 1.5);        // wetter at night
  }

  _padOff(now, tc) {
    const p = this._m.pad;
    this._m.pad = null;
    if (!p || p.end <= now) return;
    p.g.gain.cancelScheduledValues(now); p.g.gain.setTargetAtTime(0, now, tc);
    const end = now + tc * 7;
    if (end < p.end) { p.end = end; for (let i = 0; i < p.oscs.length; i++) p.oscs[i].stop(end); }
  }

  // Composes and schedules one piano phrase, then leaves a silence before the next.
  _phrase(t) {
    const M = this._m;
    if (M.mood === 'village') { this._village(t); return; }
    if (!M.chord || M.key !== M.keyNext) { M.nextPhraseT = t + 1; return; }
    const md = MOODS[M.mood], ev = this._ev, P = this._P, soft = M.isNight || M.mood === 'frost';
    ev.length = 0;
    P.T = M.T - (md.minor ? 3 : 0); P.sc = md.sc; P.ch = M.chord; P.lo = md.lo; P.hi = md.hi;
    P.slow = md.slow * (M.isNight && M.mood === 'frost' ? 1.2 : 1);
    // phrase type by the mood's odds; only a motif may follow itself (that is how themes return)
    let k = -1;
    for (let tries = 0; tries < 2 && (k < 0 || (k === M.kind && k !== 1)); tries++) {
      const r = Math.random();
      for (k = 0; k < 4 && r >= md.kinds[k]; k++);
    }
    M.kind = k;
    const len = k === 0 ? this._phFlourish(P, ev) : k === 1 ? this._phMotif(P, ev) : k === 2 ? this._phChord(P, ev) : k === 3 ? this._phDyads(P, ev)
      : M.mood === 'frost' ? this._phFrost(P, ev) : this._phEcho(P, ev);
    for (let i = 0; i < ev.length; i++) {
      const n = ev[i], inst = n[3] || (soft && n[1] >= 69 && chance(0.8) ? (chance(0.8) ? 'celesta' : 'glass') : 'piano');
      this._note(inst, n[1], t + n[0] + rnd(-0.006, 0.006), clamp(n[2] * rnd(0.9, 1.08), 0.1, 0.9), inst === 'piano' ? this._oField : this._oFieldX);
    }
    M.nextPhraseT = t + len + rnd(md.gap[0], md.gap[1]);
  }

  // Quick arpeggiated run that speeds up or eases off, then settles on a chord tone.
  _phFlourish(P, ev) {
    const n = rndi(4, 7), up = chance(0.68), acc = chance(0.5) ? rnd(0.86, 0.95) : rnd(1.04, 1.14);
    let i = up ? rndi(P.lo, P.lo + 3) : rndi(P.hi - 2, P.hi), t = 0, dt = rnd(0.13, 0.2) * P.slow, m = 0;
    if (chance(0.55)) ev.push([0, P.T - 12 + P.ch.b, rnd(0.3, 0.4)]);
    for (let k = 0; k < n; k++) {
      m = P.T + deg(P.sc, i);
      ev.push([t, m, (0.36 + 0.28 * (up ? k : n - k) / n)]);
      i = clamp(i + (up ? 1 : -1) * (chance(0.3) ? 2 : 1), P.lo - 2, P.hi + 1);
      t += dt; dt *= acc;
    }
    if (chance(0.6)) { t += dt * 1.5; ev.push([t, nearestTone(m + (up ? -3 : 3), P.T, P.ch.a), 0.4]); }
    return t;
  }

  // A short melodic cell; half the time the previous cell returns, moved or with a new ending.
  _phMotif(P, ev) {
    const M = this._m, recall = !!M.motif && chance(0.5), mo = recall ? M.motif : (M.motif = { cell: chance(0.3) ? MOTIFS[rndi(0, 2)] : pick(MOTIFS), base: 0 });
    const c = mo.cell.c, r = mo.cell.r, beat = rnd(0.4, 0.56) * P.slow;
    const base = mo.base = clamp(recall ? mo.base + pick([-2, -1, 0, 1, 2]) : rndi(P.lo, P.hi - 3), P.lo - 1, P.hi - 3);
    let t = 0;
    if (chance(0.4)) ev.push([0, P.T - 12 + P.ch.b, 0.32]);
    for (let k = 0; k < c.length; k++) {
      const last = k === c.length - 1, i = base + c[k] + (last && recall && chance(0.35) ? pick([-1, 1]) : 0);
      ev.push([t, P.T + deg(P.sc, i), last ? 0.5 : 0.42 + 0.03 * k]);
      if (last && chance(0.3)) ev.push([t + 0.02, nearestTone(P.T + deg(P.sc, i) - 8, P.T, P.ch.a), 0.3]);
      t += r[k] * beat;
    }
    return t;
  }

  // Softly rolled chord, sometimes answered by a high note or two.
  _phChord(P, ev) {
    const tones = P.ch.t;
    let t = 0.05;
    ev.push([0, P.T - 12 + P.ch.b, 0.34]);
    for (let k = 0; k < tones.length; k++) { ev.push([t, P.T + tones[k], 0.34 + 0.03 * k]); t += rnd(0.05, 0.09) * P.slow; }
    if (chance(0.6)) {
      const i = rndi(P.hi - 4, P.hi);
      t = rnd(1.1, 1.9) * P.slow;
      ev.push([t, P.T + deg(P.sc, i), 0.42]);
      if (chance(0.5)) { t += 0.5 * P.slow; ev.push([t, P.T + deg(P.sc, i - 1), 0.36]); }
    }
    return t;
  }

  // An open interval struck twice, the second time softer.
  _phDyads(P, ev) {
    const i = rndi(P.lo, P.hi - 4), a = P.T + deg(P.sc, i), b = P.T + deg(P.sc, i + pick([2, 3, 4])), gap = rnd(0.5, 0.75) * P.slow;
    ev.push([0, a, 0.44], [0.015, b, 0.47], [gap, a, 0.34], [gap + 0.015, b, 0.37]);
    if (chance(0.4)) { ev.push([gap * 2.2, P.T + deg(P.sc, i + 1), 0.4]); return gap * 2.2; }
    return gap;
  }

  // Two notes and their echo an octave higher.
  _phEcho(P, ev) {
    const i = rndi(P.lo, P.hi - 4), a = P.T + deg(P.sc, i), b = P.T + deg(P.sc, i + 2), s = P.slow;
    ev.push([0, a, 0.5], [0.28 * s, b, 0.46], [0.95 * s, a + 12, 0.3], [1.23 * s, b + 12, 0.26]);
    return 1.23 * s;
  }

  // Frostcrown figures: bare fifths and fourths built on the chord root, glass on top.
  _phFrost(P, ev) {
    let R = P.T + P.ch.b;
    if (R < P.T - 7) R += 12;
    const s = P.slow, k = rndi(0, 2);
    if (k === 0) {                                             // rising stack of fifths
      ev.push([0, R - 12, 0.4, 'piano'], [0.02, R - 5, 0.36, 'piano'], [0.6 * s, R + 2, 0.38, 'piano'], [1.1 * s, R + 7, 0.42, 'piano'], [1.6 * s, R + 14, 0.46, 'piano'], [1.63 * s, R + 26, 0.3, 'glass']);
      return 1.6 * s;
    }
    if (k === 1) {                                             // falling fourths, high and thin
      ev.push([0, R + 24, 0.4, 'celesta'], [0.5 * s, R + 19, 0.38, 'celesta'], [1 * s, R + 14, 0.38, 'celesta'], [1.6 * s, R + 12, 0.42, 'glass'], [1.6 * s, R - 12, 0.34, 'piano']);
      return 1.6 * s;
    }
    ev.push([0, R + 19, 0.42, 'glass'], [0.85 * s, R + 26, 0.38, 'glass'], [1.8 * s, R + 7, 0.36, 'piano'], [1.82 * s, R + 14, 0.38, 'piano']);   // lone bells
    return 1.8 * s;
  }

  // Hearthvale: a gentle waltz. Each phrase is two bars over the next chord of a cycle:
  // bass and soft dyads in the left hand, a stepwise melody in the right.
  _village(t) {
    const M = this._m, md = MOODS.village, night = M.isNight, beat = night ? 0.66 : 0.54, bar = beat * 3, rest = chance(0.3) ? 1 : 0;
    this._chord(t, bar * (2 + rest));
    const T = M.T, ch = M.chord, F = this._oField, FX = this._oFieldX;
    for (let b = 0; b < 2; b++) {
      const t0 = t + b * bar + rnd(-0.005, 0.005);
      this._note('piano', T - 12 + ch.b + (b && chance(0.4) ? 7 : 0), t0, 0.4, F);
      this._note('piano', T + ch.t[0], t0 + beat, 0.24, F); this._note('piano', T + ch.t[1], t0 + beat + 0.01, 0.24, F);
      this._note('piano', T + ch.t[1], t0 + 2 * beat, 0.22, F); this._note('piano', T + ch.t[2], t0 + 2 * beat + 0.01, 0.22, F);
    }
    // melody: every other phrase repeats the previous rhythm and contour from a new starting note
    let mel = M.vMel;
    if (!mel || (M.vCount++ & 1) === 0) {
      const r = pick(VILLAGE_RHYTHMS), steps = [];
      for (let k = 1; k < r.length; k++) steps.push(pick([-1, 1, 1, -1, 2, -2, 1]));
      mel = M.vMel = { r, steps };
    }
    let i = M.vPos = clamp(M.vPos + pick([-1, 0, 1]), md.lo + 1, md.hi - 2);
    for (let k = 0; k < mel.r.length; k++) {
      const last = k === mel.r.length - 1;
      let m = T + deg(md.sc, i);
      if (last || mel.r[k] === 0) m = nearestTone(m, T, ch.a);
      const cel = night && m >= 69;
      this._note(cel ? 'celesta' : 'piano', m, t + mel.r[k] * beat + rnd(-0.006, 0.006), (mel.r[k] % 3 === 0 ? 0.52 : 0.44) * rnd(0.94, 1.06), cel ? FX : F);
      if (!last) i = clamp(i + mel.steps[k], md.lo, md.hi);
    }
    M.nextPhraseT = t + bar * (2 + rest);
  }

  // One 8th-note step of the combat layer (64 steps = four two-bar chords).
  _combatStep(s, t) {
    const M = this._m, S = this._to, m = M.T - 3, i = s & 15, ch = COMBAT[M.cProg][(s >> 4) & 3], acc = DRUM[i];
    if (acc === 2) this._drum(t, 1, true); else if (acc === 1) this._drum(t, 0.7, false); else if (chance(0.18)) this._drum(t, 0.3, false);
    if ((s >> 4) === 3 && i >= 12) this._drum(t + STEP / 2, 0.45, false);                    // fill into the turnaround
    if (!(i & 1) || chance(0.85)) this._saw(t, 0.24, i % 4 === 0 ? 0.2 : 0.13, 1500, S.combat, m - 12 + ch[0] + OST[i]);
    if (i === 0 || (i === 11 && chance(0.5)) || (i === 6 && chance(0.25))) this._saw(t, 0.7, 0.075, 2600, S.combatX, m + ch[0], m + ch[1], m + ch[2]);
    if (s === 63) M.cProg = rndi(0, COMBAT.length - 1);
  }

  _drum(t, v, big) {
    const f = big ? 92 : 128, S = this._to.combat;
    this._os(t, big ? 0.5 : 0.3, 'sine', f * 1.9, 0.5 * v, { f1: f * 0.62, ft: 0.11, a: 0.002, to: S });
    this._nz(t, 0.08, 'lowpass', big ? 700 : 1100, 0.16 * v, { a: 0.001, to: S });
  }
}
