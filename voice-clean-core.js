// voice-clean-core.js — "Clean up voice": removes room noise and some echo from the mic with DeepFilterNet3
// (lib/deepfilternet, MIT/Apache-2.0). No UI here. Two jobs:
//
//  1. Live monitor while the mic is on: mic → DeepFilterNet (AudioWorklet, its own AudioContext) → analyser, and
//     → headphones when Listen is on. Display and listening only: the recording itself stays the raw mic (crash-safe WAV).
//  2. On save: cleanFile(wav) runs the same model over the whole take in a worker (voice-clean.worker.js) and
//     returns a cleaned WAV (48 kHz mono, same length and timing as the original), which then becomes the MP3.
//
// The engine (34 MB, the model is inside the .wasm) is downloaded once into Cache Storage, like Voice scroll's model.
//
//   VoiceClean.ready() → Promise<bool>      VoiceClean.download(p => …)      VoiceClean.dbFor(strengthPct)
//   const vc = new VoiceClean();  await vc.start(mediaStream, { strength, listen })  vc.setStrength(pct)  vc.setListen(bool)  vc.setBypass(bool)
//   vc.addEventListener('level', e => e.detail.peakDb / rmsDb)     vc.stop()
//   VoiceClean.cleanFile(wavFile, strengthPct, p => …) → Promise<Blob>  (audio/wav)

const V = new URL(import.meta.url).search; // same ?v= as the page, so new code is picked up
const WASM_URL = new URL('lib/deepfilternet/df_bg.wasm', import.meta.url).href.replace(/\?.*$/, '');
const CACHE = 'spacecam-clean-v1';
const WASM_BYTES = 34135648;

async function cached() {
  if (!self.caches) return null;
  try { return await (await caches.open(CACHE)).match(WASM_URL); } catch { return null; }
}

export class VoiceClean extends EventTarget {
  static WASM_URL = WASM_URL; static CACHE = CACHE; static MB = Math.round(WASM_BYTES / 1e6);

  static async ready() { return !!(await cached()); }

  /** Strength 0–100 % → how many dB of noise may be taken away (DeepFilterNet's attenuation limit). 100 % = no limit. */
  static dbFor(pct) { pct = Math.max(0, Math.min(100, +pct || 0)); return pct >= 100 ? 100 : Math.round(pct * 0.6); }

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
  #ctx = null; #src = null; #node = null; #an = null; #out = null; #raf = 0; #stream = null;
  get running() { return !!this.#ctx; }
  get stream() { return this.#stream; }
  /** true = pass the original sound through (to compare while listening) */
  setBypass(on) { this.#node?.port.postMessage({ type: 'setEnabled', value: !on }); }

  async start(stream, { strength = 80, listen = false } = {}) {
    await this.stop();
    const mod = await VoiceClean.#wasmModule();
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(new URL('voice-clean.worklet-shim.js' + V, import.meta.url).href); // TextDecoder for the worklet
    await ctx.audioWorklet.addModule(new URL('lib/deepfilternet/worklet.js' + V, import.meta.url).href);
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'deepfilternet-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit',
      processorOptions: { wasmModule: mod, attenuationLimit: VoiceClean.dbFor(strength) },
    });
    const an = ctx.createAnalyser(); an.fftSize = 2048;
    const out = ctx.createGain(); out.gain.value = listen ? 1 : 0;
    src.connect(node); node.connect(an); node.connect(out); out.connect(ctx.destination);
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    this.#ctx = ctx; this.#src = src; this.#node = node; this.#an = an; this.#out = out; this.#stream = stream;
    this.#meter();
  }
  setStrength(pct) { this.#node?.port.postMessage({ type: 'setAttenuationLimit', value: VoiceClean.dbFor(pct) }); }
  setListen(on) {
    if (!this.#out) return;
    this.#out.gain.setTargetAtTime(on ? 1 : 0, this.#ctx.currentTime, 0.02);
    if (on && this.#ctx.state === 'suspended') this.#ctx.resume().catch(() => {});
  }
  async stop() {
    cancelAnimationFrame(this.#raf);
    const ctx = this.#ctx; this.#ctx = this.#src = this.#node = this.#an = this.#out = this.#stream = null;
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
  static cleanFile(file, strength = 80, onProgress = null) {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./voice-clean.worker.js' + V, import.meta.url), { type: 'module' });
      w.onmessage = e => {
        const m = e.data;
        if (m.ev === 'progress') onProgress?.(m.p);
        else { w.terminate(); m.ev === 'done' ? resolve(m.blob) : reject(new Error(m.message)); }
      };
      w.onerror = e => { w.terminate(); reject(new Error(e.message || 'Voice cleanup failed')); };
      w.postMessage({ file, atten: VoiceClean.dbFor(strength), wasmUrl: WASM_URL, cache: CACHE });
    });
  }
}
