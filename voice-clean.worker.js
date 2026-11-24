// voice-clean.worker.js — cleans a whole WAV take with DeepFilterNet3 when it is saved (see voice-clean-core.js).
// The take is read in pieces (long takes never sit in memory as one block), mixed to mono, brought to 48 kHz if needed,
// cleaned 10 ms at a time, and written as a 32-bit float WAV, 48 kHz mono. The model's own delay is taken off, so the
// cleaned sound lines up with the original to the sample (same start, same length) and the camera sync stays right.
// Message in:  { file: File|Blob (WAV), atten: dB (100 = no limit), wasmUrl, cache }
// Messages out: { ev:'progress', p: 0..1 } … then { ev:'done', blob } or { ev:'error', message }
import { DeepFilter } from './lib/deepfilternet/index.js';

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
  try {
    const { file, atten = 100, wasmUrl, cache, delay = DELAY } = e.data;
    const r = await (await caches.open(cache)).match(wasmUrl);
    if (!r) throw new Error('Clean up voice is not downloaded yet');
    const url = URL.createObjectURL(await r.blob());
    df = await DeepFilter.create({ wasmUrl: url, attenuationLimit: atten });
    URL.revokeObjectURL(url);
    const N = df.frameLength;

    const w = await readWavInfo(file);
    const bps = w.bits / 8, frameBytes = bps * w.channels, isFloat = w.format === 3;
    const total = Math.floor(w.dataBytes / frameBytes);
    const ratio = w.rate / RATE, outTotal = Math.round(total / ratio);

    // output: collected in ~1 s blocks; the first `delay` cleaned samples are the model warming up and are dropped
    const blocks = []; let blk = new Float32Array(RATE), blkN = 0, skip = delay, written = 0;
    const emit = arr => {
      for (let i = 0; i < arr.length && written < outTotal; i++) {
        if (skip > 0) { skip--; continue; }
        let v = arr[i]; v = v > 1 ? 1 : v < -1 ? -1 : v;
        blk[blkN++] = v; written++;
        if (blkN === blk.length) { blocks.push(blk); blk = new Float32Array(RATE); blkN = 0; }
      }
    };
    // 10 ms frames into the model
    const frame = new Float32Array(N); let fN = 0;
    const feed = arr => { for (let i = 0; i < arr.length; i++) { frame[fN++] = arr[i]; if (fN === N) { emit(df.process(frame)); fN = 0; } } };
    // linear resampling to 48 kHz (most Mac mics already run at 48 kHz: then this is a straight copy)
    let prev = 0, inPos = 0, tOut = 0; // inPos = index of the first sample of the current block
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
      feed(out);
    };

    const STEP = RATE * 2; // input frames per read
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
      self.postMessage({ ev: 'progress', p: total ? done / total : 1 });
    }
    // push silence through so the last real samples come out of the model
    const tail = new Float32Array(N);
    while (written < outTotal) feed(tail);
    if (blkN) blocks.push(blk.subarray(0, blkN));
    self.postMessage({ ev: 'done', blob: new Blob([wavHeader(written), ...blocks], { type: 'audio/wav' }) });
  } catch (err) {
    self.postMessage({ ev: 'error', message: String(err?.message || err) });
  } finally { try { df?.destroy(); } catch {} }
};
