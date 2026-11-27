// voice-polish.js — the "polish" half of Clean up voice: the same steps as Audition's Essential Sound → Dialogue,
// in the same order. Pure JS, no DOM, so one copy runs both live (voice-polish.worklet.js, for Listen) and on save
// (voice-clean.worker.js), and what you hear while testing is what the saved take gets.
//
//   Rumble   high-pass at 80 Hz (24 dB/oct): desk thumps, traffic, air-con rumble
//   Hum      notches at 50 or 60 Hz and 3 harmonics: mains hum
//   Warmth   bell at 220 Hz, −4…+4 dB: body of the voice (minus = less boomy)
//   Presence bell at 3.5 kHz (0…+5 dB) and a little air at 10 kHz: clarity
//   De-ess   turns down only the 5 kHz+ band while an "s" / "sh" is louder than the rest of the voice
//   Dynamics gentle compressor whose threshold follows your own speaking level (so it works at any mic gain)
//   Leveler  live only: rides the gain towards the loudness target (on save, loudness is set exactly in two passes)
//   Limiter  live only: keeps peaks under −1.5 dBFS (on save a look-ahead limiter in the worker does this)
//
//   const p = new Polish(48000); p.set({ rumble: true, hum: 0|50|60, warmth: -100…100, presence: 0…100,
//                                        deess: 0…100, dynamics: 0…100, live: bool, target: -19 });
//   p.process(float32Array)  // in place

const dbToLin = db => Math.pow(10, db / 20);
const linToDb = v => 20 * Math.log10(v + 1e-12);

export class Biquad {
  constructor() { this.b0 = 1; this.b1 = this.b2 = this.a1 = this.a2 = 0; this.z1 = this.z2 = 0; }
  // RBJ cookbook
  set(type, f, q, gainDb, fs) {
    const A = Math.pow(10, gainDb / 40), w = 2 * Math.PI * f / fs, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'notch') { b0 = 1; b1 = -2 * c; b2 = 1; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'peak') { b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; }
    else if (type === 'hshelf') {
      const sq = 2 * Math.sqrt(A) * al;
      b0 = A * ((A + 1) + (A - 1) * c + sq); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sq);
      a0 = (A + 1) - (A - 1) * c + sq; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sq;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  process(x) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
}

export const POLISH_DEFAULTS = { rumble: true, hum: 0, warmth: 0, presence: 30, deess: 30, dynamics: 30, live: false, target: -19 };

export class Polish {
  constructor(fs = 48000) {
    this.fs = fs;
    const tc = ms => 1 - Math.exp(-1 / (fs * ms / 1000)); // one-pole smoothing coefficient for a time constant
    this.k = { fast: tc(10), deAtt: tc(2), deRel: tc(60), gAtt: tc(5), gRel: tc(150), speech: tc(3000), lev: tc(1500), limRel: tc(80) };
    this.hp1 = new Biquad(); this.hp2 = new Biquad();
    this.hum = [new Biquad(), new Biquad(), new Biquad(), new Biquad()];
    this.warm = new Biquad(); this.pres = new Biquad(); this.air = new Biquad();
    this.deHi = new Biquad(); this.deSide = new Biquad(); this.deBroad = new Biquad();
    this.deSideEnv = 0; this.deBroadEnv = 0; this.deG = 1;
    this.ms = 0; this.speechMs = -1; this.dynG = 1; this.levG = 1; this.limG = 1;
    this.set(POLISH_DEFAULTS);
  }
  set(o = {}) {
    const s = this.s = { ...POLISH_DEFAULTS, ...this.s, ...o }, fs = this.fs;
    this.hp1.set('hp', 80, 0.5412, 0, fs); this.hp2.set('hp', 80, 1.3066, 0, fs); // 4th-order Butterworth
    this.hum.forEach((b, i) => b.set('notch', Math.min((s.hum || 50) * (i + 1), fs / 2 - 100), 30, 0, fs));
    this.warm.set('peak', 220, 0.8, (s.warmth / 100) * 4, fs);
    this.pres.set('peak', 3500, 0.8, (s.presence / 100) * 5, fs);
    this.air.set('hshelf', 10000, 0.7, (s.presence / 100) * 2, fs);
    this.deHi.set('hp', 5000, 0.707, 0, fs); this.deSide.set('bp', 7000, 1.4, 0, fs); this.deBroad.set('bp', 1200, 0.5, 0, fs);
  }
  process(buf) {
    const s = this.s, k = this.k, n = buf.length;
    const deAmt = s.deess / 100, dyn = s.dynamics / 100, ratio = 1 + 3 * dyn, ceil = dbToLin(-1.5);
    const deThr = 1.6 - 1.1 * deAmt; // how much louder the "s" band may be than the voice band before it's turned down
    for (let i = 0; i < n; i++) {
      let x = buf[i];
      if (s.rumble) x = this.hp2.process(this.hp1.process(x));
      if (s.hum) for (let h = 0; h < 4; h++) x = this.hum[h].process(x);
      x = this.air.process(this.pres.process(this.warm.process(x)));
      // de-ess: compare the "s" band with the voice band; turn down only the highs while "s" wins
      if (deAmt > 0) {
        const hi = this.deHi.process(x), sd = Math.abs(this.deSide.process(x)), bd = Math.abs(this.deBroad.process(x));
        this.deSideEnv += (sd - this.deSideEnv) * (sd > this.deSideEnv ? k.deAtt : k.deRel);
        this.deBroadEnv += (bd - this.deBroadEnv) * (bd > this.deBroadEnv ? k.deAtt : k.deRel);
        const r = this.deSideEnv / (this.deBroadEnv + 1e-6);
        const want = r > deThr ? Math.max(0.25, Math.pow(deThr / r, 0.5 + deAmt)) : 1;
        this.deG += (want - this.deG) * (want < this.deG ? k.deAtt : k.deRel);
        x = (x - hi) + hi * this.deG;
      }
      // level: fast loudness, and a slow "your speaking level" that only learns while you talk
      this.ms += (x * x - this.ms) * k.fast;
      const fastDb = 10 * Math.log10(this.ms + 1e-12);
      if (fastDb > -50) this.speechMs = this.speechMs < 0 ? this.ms : this.speechMs + (this.ms - this.speechMs) * k.speech;
      const speechDb = this.speechMs < 0 ? -30 : 10 * Math.log10(this.speechMs + 1e-12);
      // dynamics: threshold a little above your average speaking level, gentle ratio, soft knee
      if (dyn > 0) {
        const thr = speechDb + 6 - 8 * dyn, over = fastDb - thr, knee = 6;
        const grDb = over <= -knee / 2 ? 0 : over >= knee / 2 ? over * (1 - 1 / ratio) : ((over + knee / 2) ** 2 / (2 * knee)) * (1 - 1 / ratio);
        const want = dbToLin(-grDb);
        this.dynG += (want - this.dynG) * (want < this.dynG ? k.gAtt : k.gRel);
        x *= this.dynG;
      }
      if (s.live) { // live: leveler towards the loudness target (speaking level ≈ LUFS), then a safety limiter
        const want = this.speechMs < 0 || s.target == null ? 1 : dbToLin(Math.max(-12, Math.min(18, s.target - speechDb)));
        this.levG += (want - this.levG) * k.lev;
        x *= this.levG;
        const a = Math.abs(x), wantL = a > ceil ? ceil / a : 1;
        this.limG = wantL < this.limG ? wantL : this.limG + (1 - this.limG) * k.limRel;
        x *= this.limG;
      }
      buf[i] = x;
    }
    return buf;
  }
}

// ---------- loudness (EBU R128 / ITU-R BS.1770, 48 kHz, mono) and look-ahead limiter, for the save step ----------
export class LoudnessMeter {
  constructor() {
    this.k1 = Object.assign(new Biquad(), { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 });
    this.k2 = Object.assign(new Biquad(), { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 });
    this.sub = []; this.acc = 0; this.cnt = 0; // 100 ms sub-blocks
  }
  push(buf) {
    for (let i = 0; i < buf.length; i++) {
      const y = this.k2.process(this.k1.process(buf[i]));
      this.acc += y * y;
      if (++this.cnt === 4800) { this.sub.push(this.acc / 4800); this.acc = 0; this.cnt = 0; }
    }
  }
  /** integrated loudness in LUFS (gated), or null when there's too little sound */
  integrated() {
    const blocks = [];
    for (let i = 0; i + 4 <= this.sub.length; i++) blocks.push((this.sub[i] + this.sub[i + 1] + this.sub[i + 2] + this.sub[i + 3]) / 4);
    const lu = z => -0.691 + 10 * Math.log10(z + 1e-12);
    const abs = blocks.filter(z => lu(z) > -70);
    if (!abs.length) return null;
    const rel = lu(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const gated = abs.filter(z => lu(z) > rel);
    return gated.length ? lu(gated.reduce((a, b) => a + b, 0) / gated.length) : null;
  }
}

/** Peak limiter with 5 ms look-ahead. Output is delayed by `delay` samples (the caller drops them). */
export class Limiter {
  constructor(fs = 48000, ceilDb = -1.5) {
    this.ceil = dbToLin(ceilDb); this.delay = Math.round(fs * 0.005);
    this.buf = new Float32Array(this.delay + 1); this.pos = 0; this.g = 1; this.rel = 1 - Math.exp(-1 / (fs * 0.08));
    this.peakQ = []; this.t = 0; // max of |x| over the look-ahead window (monotonic queue)
  }
  process(arr, out) {
    const D = this.delay;
    for (let i = 0; i < arr.length; i++, this.t++) {
      const x = arr[i], a = Math.abs(x);
      while (this.peakQ.length && this.peakQ[this.peakQ.length - 1][1] <= a) this.peakQ.pop();
      this.peakQ.push([this.t, a]);
      while (this.peakQ[0][0] <= this.t - D - 1) this.peakQ.shift();
      const pk = this.peakQ[0][1], want = pk > this.ceil ? this.ceil / pk : 1;
      this.g = want < this.g ? want : this.g + (want - this.g) * this.rel;
      const old = this.buf[this.pos]; this.buf[this.pos] = x; this.pos = (this.pos + 1) % (D + 1);
      let y = old * this.g; if (y > this.ceil) y = this.ceil; else if (y < -this.ceil) y = -this.ceil;
      out[i] = y;
    }
    return out;
  }
}
export { dbToLin, linToDb };
// The live worklet can't import modules with a ?v= stamp, so it loads this file first and finds the classes here.
if (typeof AudioWorkletGlobalScope !== 'undefined') globalThis.SpacePolish = Polish;

// Clean up voice sliders → engine values (shared by the live chain and the save step)
export const attenFor = pct => (pct >= 100 ? 100 : Math.round(Math.max(0, pct) * 0.35)); // Noise removal % → dB DeepFilterNet may take away
export const bgGainFor = pct => (pct <= 0 ? 0 : dbToLin(-40 + Math.min(100, pct) * 0.4)); // Background % → share of the removed sound mixed back
export const CLEAN_DEFAULTS = { noise: 70, background: 15, rumble: true, hum: 0, warmth: 0, presence: 30, deess: 30, dynamics: 30, loudness: -16 };
