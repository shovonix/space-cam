// voice-clean.worker.js — cleans and polishes a whole WAV take when it is saved (see voice-clean-core.js).
// Pass 1: read the take in pieces, mono, 48 kHz → DeepFilterNet removes the noise (its 30 ms delay is taken off, so
//         every cleaned sample lines up with the original) → Background: some of what was removed is mixed back
//         (like Adobe Podcast's Background slider; keeps the voice natural) → Polish (voice-polish.js: rumble, hum,
//         warmth, presence, de-ess, dynamics) → measure the loudness (EBU R128).
// Pass 2: gain to the loudness target → look-ahead limiter (−1.5 dBFS) → 32-bit float WAV, 48 kHz mono,
//         same length as the original, so the camera sync stays right.
// Message in:  { file: File|Blob (WAV), set: {noise, background, rumble, hum, warmth, presence, deess, dynamics, loudness}, wasmUrl, cache }
// Messages out: { ev:'progress', p: 0..1 } … then { ev:'done', blob, lufs } or { ev:'error', message }
import { DeepFilter } from './lib/deepfilternet/index.js';
const V = new URL(self.location.href).search; // same ?v= stamp as the page, so updates reach every browser
const polishLib = import('./voice-polish.js' + V); // loaded at once, awaited inside the handler (a top-level await would drop the first message)

const RATE = 48000;
export const DELAY = 1440; // samples the model's output lags its input at 48 kHz (30 ms = 3 frames of 480, measured 24 Nov 2026)

async function readWavInfo(file) {
  const head = new DataView(await file.slice(0, Math.min(file.size, 4096)).arrayBuffer());
  const tag = o => String.fromCharCode(head.getUint8(o), head.getUint8(o + 1), head.getUint8(o + 2), head.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let o = 12, fmt = null, dataAt = -1;
  while (o + 8 <= head.byteLength) {
    const id = tag(o), size = head.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { format: head.getUint16(o + 8, true), channels: head.getUint16(o + 10, true), rate: head.getUint32(o + 12, true), bits: head.getUint16(o + 22, true) };
    if (id === 'data') { dataAt = o + 8; break; }
    o += 8 + size + (size & 1);
  }
  if (!fmt || dataAt < 0) throw new Error('WAV header not found');
  return { ...fmt, dataAt, dataBytes: file.size - dataAt }; // trust the file length (a crashed take has a stale header)
}

function wavHeader(samples) {
  const b = new DataView(new ArrayBuffer(44)), s = (o, t) => [...t].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  const bytes = samples * 4;
  s(0, 'RIFF'); b.setUint32(4, 36 + bytes, true); s(8, 'WAVE'); s(12, 'fmt ');
  b.setUint32(16, 16, true); b.setUint16(20, 3, true); b.setUint16(22, 1, true); b.setUint32(24, RATE, true);
  b.setUint32(28, RATE * 4, true); b.setUint16(32, 4, true); b.setUint16(34, 32, true);
  s(36, 'data'); b.setUint32(40, bytes, true);
  return b.buffer;
}

self.onmessage = async e => {
  let df = null;
  const { Polish, LoudnessMeter, Limiter, dbToLin, attenFor, bgGainFor, CLEAN_DEFAULTS } = await polishLib;
  try {
    const { file, wasmUrl, cache, delay = DELAY } = e.data, set = { ...CLEAN_DEFAULTS, ...e.data.set };
    const r = await (await caches.open(cache)).match(wasmUrl);
    if (!r) throw new Error('Clean up voice is not downloaded yet');
    const url = URL.createObjectURL(await r.blob());
    df = await DeepFilter.create({ wasmUrl: url, attenuationLimit: attenFor(set.noise ?? 70) });
    URL.revokeObjectURL(url);
    const N = df.frameLength, bg = bgGainFor(set.background ?? 10);
    const polish = new Polish(RATE); polish.set({ ...set, live: false });
    const meter = new LoudnessMeter();

    const w = await readWavInfo(file);
    const bps = w.bits / 8, frameBytes = bps * w.channels, isFloat = w.format === 3;
    const total = Math.floor(w.dataBytes / frameBytes);
    const ratio = w.rate / RATE, outTotal = Math.round(total / ratio);

    // the original samples, in order, so each cleaned sample meets the original sample it came from (Background mix)
    const inQ = []; let inHead = 0;
    const takeIn = () => { while (inQ.length && inHead >= inQ[0].length) { inQ.shift(); inHead = 0; } return inQ.length ? inQ[0][inHead++] : 0; };

    // pass 1 output: ~1 s blocks, each turned into a Blob right away (long takes don't pile up in memory)
    const pass1 = []; let blk = new Float32Array(RATE), blkN = 0, skip = delay, written = 0;
    const flush = () => { if (!blkN) return; const b = blk.subarray(0, blkN); polish.process(b); meter.push(b); pass1.push(new Blob([b.slice()])); blk = new Float32Array(RATE); blkN = 0; };
    const emit = arr => {
      for (let i = 0; i < arr.length && written < outTotal; i++) {
        if (skip > 0) { skip--; continue; }
        const x = takeIn(), y = arr[i];
        blk[blkN++] = bg ? y + bg * (x - y) : y; written++;
        if (blkN === blk.length) flush();
      }
    };
    const frame = new Float32Array(N); let fN = 0;
    const feed = arr => { inQ.push(arr); for (let i = 0; i < arr.length; i++) { frame[fN++] = arr[i]; if (fN === N) { emit(df.process(frame)); fN = 0; } } };
    let prev = 0, inPos = 0, tOut = 0; // linear resampling to 48 kHz (a straight copy when the mic already runs at 48 kHz)
    const resample = x => {
      if (ratio === 1) return feed(x);
      const out = [];
      for (;;) {
        const pos = tOut * ratio, i = Math.floor(pos) - inPos, f = pos - Math.floor(pos);
        if (i + 1 >= x.length) break;
        const a = i < 0 ? prev : x[i], b = x[i + 1];
        out.push(a + (b - a) * f); tOut++;
      }
      prev = x[x.length - 1]; inPos += x.length;
      feed(Float32Array.from(out));
    };

    const STEP = RATE * 2;
    for (let done = 0; done < total;) {
      const n = Math.min(STEP, total - done);
      const dv = new DataView(await file.slice(w.dataAt + done * frameBytes, w.dataAt + (done + n) * frameBytes).arrayBuffer());
      const mono = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let c = 0; c < w.channels; c++) {
          const at = i * frameBytes + c * bps;
          if (isFloat) sum += dv.getFloat32(at, true);
          else if (bps === 2) sum += dv.getInt16(at, true) / 32768;
          else if (bps === 3) sum += ((dv.getUint8(at) | (dv.getUint8(at + 1) << 8) | (dv.getInt8(at + 2) << 16)) / 8388608);
          else if (bps === 4) sum += dv.getInt32(at, true) / 2147483648;
          else sum += (dv.getUint8(at) - 128) / 128;
        }
        mono[i] = sum / w.channels;
      }
      resample(mono);
      done += n;
      self.postMessage({ ev: 'progress', p: 0.85 * (total ? done / total : 1) });
    }
    while (written < outTotal) feed(new Float32Array(N)); // push silence through so the last real samples come out
    flush();

    // pass 2: loudness gain (the target is for two speakers; a mono voice plays on both, so it sits 3 dB lower) + limiter
    const lufs = meter.integrated();
    const gain = set.loudness != null && lufs != null ? dbToLin(Math.max(-20, Math.min(24, set.loudness - 3 - lufs))) : 1;
    const lim = new Limiter(RATE, -1.5), out = []; let lskip = lim.delay, outN = 0;
    for (let b = 0; b < pass1.length; b++) {
      const a = new Float32Array(await pass1[b].arrayBuffer());
      if (gain !== 1) for (let i = 0; i < a.length; i++) a[i] *= gain;
      const o = lim.process(a, new Float32Array(a.length));
      const keep = lskip > 0 ? o.subarray(Math.min(lskip, o.length)) : o; lskip = Math.max(0, lskip - o.length);
      if (keep.length) { out.push(new Blob([keep.slice()])); outN += keep.length; }
      pass1[b] = null;
      self.postMessage({ ev: 'progress', p: 0.85 + 0.15 * (b + 1) / pass1.length });
    }
    { const tail = lim.process(new Float32Array(lim.delay), new Float32Array(lim.delay)).subarray(0, outTotal - outN); if (tail.length) { out.push(new Blob([tail.slice()])); outN += tail.length; } }
    self.postMessage({ ev: 'done', blob: new Blob([wavHeader(outN), ...out], { type: 'audio/wav' }), lufs: lufs == null ? null : lufs + 20 * Math.log10(gain) + 3 });
  } catch (err) {
    self.postMessage({ ev: 'error', message: String(err?.message || err) });
  } finally { try { df?.destroy(); } catch {} }
};
