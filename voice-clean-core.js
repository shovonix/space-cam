// voice-clean-core.js — "Clean up voice": removes room noise and some echo from the mic with DeepFilterNet3
// (lib/deepfilternet, MIT/Apache-2.0). No UI here. Two jobs:
//
//  1. Live monitor while the mic is on: mic → DeepFilterNet + Background mix + Polish (voice-polish.js) in its own
//     AudioContext → analyser (the wave), and → headphones when Listen is on. Display and listening only: the recording
//     itself stays the raw mic (crash-safe WAV).
//  2. On save: cleanFile(wav, set) runs the same steps over the whole take in a worker (voice-clean.worker.js), plus
//     exact loudness and a look-ahead limiter, and returns a WAV (48 kHz mono, same length and timing as the original).
//
// The engine (34 MB, the model is inside the .wasm) is downloaded once into Cache Storage, like Voice scroll's model.
// `set` = the sliders: { noise, background, rumble, hum, warmth, presence, deess, dynamics, loudness } (CLEAN_DEFAULTS).
//
//   VoiceClean.ready() → Promise<bool>      VoiceClean.download(p => …)      cleanDefaults() → Promise<set>
//   const vc = new VoiceClean();  await vc.start(mediaStream, { set, listen })  vc.setSettings(set)  vc.setListen(bool)  vc.setBypass(bool)
//   vc.addEventListener('level', e => e.detail.peakDb / rmsDb)     vc.stop()
//   VoiceClean.cleanFile(wavFile, set, p => …) → Promise<{ blob (audio/wav), lufs }>

const V = new URL(import.meta.url).search; // same ?v= as the page, so new code is picked up
const WASM_URL = new URL('lib/deepfilternet/df_bg.wasm', import.meta.url).href.replace(/\?.*$/, '');
const CACHE = 'spacecam-clean-v1';
const WASM_BYTES = 34135648;
// how far the live model's output trails the mic (model delay + one 10 ms frame of buffering), so the original
// lines up with the cleaned sound for the Background mix and Hear original. Measured 24 Nov 2026.
const LIVE_DELAY = 1920;
let polishP = null;
const polishLib = () => (polishP ||= import('./voice-polish.js' + V));
// the slider set → what the Polish step needs (loudness target is for two speakers; a mono voice sits 3 dB lower)
const polishSet = s => ({ rumble: s.rumble, hum: s.hum, warmth: s.warmth, presence: s.presence, deess: s.deess, dynamics: s.dynamics, target: s.loudness == null ? null : s.loudness - 3 });
export const cleanDefaults = async () => (await polishLib()).CLEAN_DEFAULTS;

async function cached() {
  if (!self.caches) return null;
  try { return await (await caches.open(CACHE)).match(WASM_URL); } catch { return null; }
}

export class VoiceClean extends EventTarget {
  static WASM_URL = WASM_URL; static CACHE = CACHE; static MB = Math.round(WASM_BYTES / 1e6);

  static async ready() { return !!(await cached()); }

  static async download(onProgress) {
    const res = await fetch(WASM_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = +res.headers.get('content-length') || WASM_BYTES, rd = res.body.getReader(), parts = [];
    let got = 0;
    for (;;) { const r = await rd.read(); if (r.done) break; parts.push(r.value); got += r.value.length; onProgress?.(Math.min(1, got / total)); }
    const blob = new Blob(parts, { type: 'application/wasm' });
    try { navigator.storage?.persist?.(); } catch {}
    await (await caches.open(CACHE)).put(WASM_URL, new Response(blob, { headers: { 'Content-Type': 'application/wasm', 'Content-Length': String(blob.size) } }));
  }

  static #module = null;
  static async #wasmModule() {
    if (this.#module) return this.#module;
    const r = await cached();
    if (!r) throw new Error('Clean up voice is not downloaded yet');
    this.#module = await WebAssembly.compile(await r.arrayBuffer());
    return this.#module;
  }

  // ---------- live monitor ----------
  // mic ─┬─ DeepFilterNet ─(cleaned y)──┬──────────────► mix = y + bg·(x − y) ─► Polish ─┬─► analyser (wave)
  //      └─ delay (same as the model) ─(x)┴─ x − y ─ bg ─┘                              └─► Listen ─► headphones
  //                                       └────────────────────── Hear original ─────────────┘
  #ctx = null; #src = null; #node = null; #pol = null; #bg = null; #an = null; #out = null; #wet = null; #dry = null; #raf = 0; #stream = null;
  get running() { return !!this.#ctx; }
  get stream() { return this.#stream; }

  async start(stream, { set = {}, listen = false } = {}) {
    await this.stop();
    const mod = await VoiceClean.#wasmModule(), P = await polishLib();
    const s = { ...P.CLEAN_DEFAULTS, ...set };
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    const add = f => ctx.audioWorklet.addModule(new URL(f + V, import.meta.url).href);
    await add('voice-clean.worklet-shim.js'); await add('lib/deepfilternet/worklet.js'); // TextDecoder first, then the model
    await add('voice-polish.js'); await add('voice-polish.worklet.js');
    const src = ctx.createMediaStreamSource(stream);
    const mono = { channelCount: 1, channelCountMode: 'explicit' };
    const node = new AudioWorkletNode(ctx, 'deepfilternet-processor', { numberOfInputs: 1, numberOfOutputs: 1, ...mono,
      processorOptions: { wasmModule: mod, attenuationLimit: P.attenFor(s.noise) } });
    const delay = ctx.createDelay(1); delay.delayTime.value = LIVE_DELAY / 48000;
    const toMono = ctx.createGain(); Object.assign(toMono, mono); // the model hears mono; the original must be mono too
    const inv = ctx.createGain(); inv.gain.value = -1;
    const resid = ctx.createGain(); const bg = ctx.createGain(); bg.gain.value = P.bgGainFor(s.background);
    const mix = ctx.createGain();
    const pol = new AudioWorkletNode(ctx, 'space-polish', { numberOfInputs: 1, numberOfOutputs: 1, ...mono, processorOptions: polishSet(s) });
    const an = ctx.createAnalyser(); an.fftSize = 2048;
    const wet = ctx.createGain(), dry = ctx.createGain(); dry.gain.value = 0;
    const out = ctx.createGain(); out.gain.value = listen ? 1 : 0;
    src.connect(node); src.connect(toMono); toMono.connect(delay);
    node.connect(mix); node.connect(inv); inv.connect(resid); delay.connect(resid); resid.connect(bg); bg.connect(mix);
    mix.connect(pol); pol.connect(an); pol.connect(wet); delay.connect(dry);
    wet.connect(out); dry.connect(out); out.connect(ctx.destination);
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    this.#ctx = ctx; this.#src = src; this.#node = node; this.#pol = pol; this.#bg = bg; this.#an = an; this.#out = out;
    this.#wet = wet; this.#dry = dry; this.#stream = stream; this.#P = P;
    this.#meter();
  }
  #P = null;
  /** new slider values while it runs */
  setSettings(set = {}) {
    if (!this.#ctx) return;
    const P = this.#P, s = { ...P.CLEAN_DEFAULTS, ...set };
    this.#node.port.postMessage({ type: 'setAttenuationLimit', value: P.attenFor(s.noise) });
    this.#bg.gain.setTargetAtTime(P.bgGainFor(s.background), this.#ctx.currentTime, 0.02);
    this.#pol.port.postMessage(polishSet(s));
  }
  /** true = hear the original mic (to compare while listening) */
  setBypass(on) {
    if (!this.#ctx) return;
    const t = this.#ctx.currentTime;
    this.#wet.gain.setTargetAtTime(on ? 0 : 1, t, 0.015); this.#dry.gain.setTargetAtTime(on ? 1 : 0, t, 0.015);
  }
  setListen(on) {
    if (!this.#out) return;
    this.#out.gain.setTargetAtTime(on ? 1 : 0, this.#ctx.currentTime, 0.02);
    if (on && this.#ctx.state === 'suspended') this.#ctx.resume().catch(() => {});
  }
  async stop() {
    cancelAnimationFrame(this.#raf);
    const ctx = this.#ctx;
    this.#ctx = this.#src = this.#node = this.#pol = this.#bg = this.#an = this.#out = this.#wet = this.#dry = this.#stream = null;
    if (ctx) try { await ctx.close(); } catch {}
  }
  #meter() {
    const an = this.#an, buf = new Float32Array(an.fftSize);
    const loop = () => {
      if (this.#an !== an) return;
      an.getFloatTimeDomainData(buf);
      let peak = 0, sum = 0;
      for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; sum += buf[i] * buf[i]; }
      const rms = Math.sqrt(sum / buf.length);
      this.dispatchEvent(new CustomEvent('level', { detail: { peakDb: peak > 0 ? 20 * Math.log10(peak) : -120, rmsDb: rms > 0 ? 20 * Math.log10(rms) : -120 } }));
      this.#raf = requestAnimationFrame(loop);
    };
    loop();
  }

  // ---------- whole take, on save ----------
  /** set = the Clean up voice sliders (see CLEAN_DEFAULTS in voice-polish.js). Resolves to { blob (WAV), lufs }. */
  static cleanFile(file, set = {}, onProgress = null) {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./voice-clean.worker.js' + V, import.meta.url), { type: 'module' });
      w.onmessage = e => {
        const m = e.data;
        if (m.ev === 'progress') onProgress?.(m.p);
        else { w.terminate(); m.ev === 'done' ? resolve({ blob: m.blob, lufs: m.lufs }) : reject(new Error(m.message)); }
      };
      w.onerror = e => { w.terminate(); reject(new Error(e.message || 'Voice cleanup failed')); };
      w.postMessage({ file, set, wasmUrl: WASM_URL, cache: CACHE });
    });
  }
}
