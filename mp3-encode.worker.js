// mp3-encode.worker.js — turns a WAV take (16/24/32-bit PCM or 32-bit float) into an MP3 when it is saved.
// Recording itself stays WAV (crash-safe, see audio-writer.worker.js); this only runs on save.
// Message in:  { file: File|Blob, kbps?: number }
// Messages out: { ev:'progress', p: 0..1 } … then { ev:'done', blob } or { ev:'error', message }
importScripts('lib/lamejs/lame.min.js');

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
  // A take saved after a crash may have a stale size in the header: trust the file length instead.
  return { ...fmt, dataAt, dataBytes: file.size - dataAt };
}

self.onmessage = async e => {
  try {
    const { file, kbps = 320 } = e.data;
    const w = await readWavInfo(file);
    const bps = w.bits / 8, frame = bps * w.channels;
    const isFloat = w.format === 3;
    const ch = Math.min(w.channels, 2); // MP3 is mono or stereo
    const enc = new lamejs.Mp3Encoder(ch, w.rate, kbps);
    const out = [];
    const SAMPLES = 1152 * 200; // samples per channel per read
    const total = Math.floor(w.dataBytes / frame);
    let done = 0;
    while (done < total) {
      const n = Math.min(SAMPLES, total - done);
      const buf = new DataView(await file.slice(w.dataAt + done * frame, w.dataAt + (done + n) * frame).arrayBuffer());
      const L = new Int16Array(n), R = ch === 2 ? new Int16Array(n) : null;
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < ch; c++) {
          const at = i * frame + c * bps;
          let s;
          if (isFloat) s = Math.max(-1, Math.min(1, buf.getFloat32(at, true))) * 32767;
          else if (bps === 3) { let x = buf.getUint8(at) | (buf.getUint8(at + 1) << 8) | (buf.getInt8(at + 2) << 16); s = x / 256; }
          else if (bps === 2) s = buf.getInt16(at, true);
          else if (bps === 4) s = buf.getInt32(at, true) / 65536;
          else s = (buf.getUint8(at) - 128) * 256;
          (c === 0 ? L : R)[i] = Math.max(-32768, Math.min(32767, Math.round(s)));
        }
      }
      for (let i = 0; i < n; i += 1152) {
        const mp3 = ch === 2 ? enc.encodeBuffer(L.subarray(i, i + 1152), R.subarray(i, i + 1152)) : enc.encodeBuffer(L.subarray(i, i + 1152));
        if (mp3.length) out.push(new Uint8Array(mp3));
      }
      done += n;
      self.postMessage({ ev: 'progress', p: done / total });
    }
    const end = enc.flush();
    if (end.length) out.push(new Uint8Array(end));
    self.postMessage({ ev: 'done', blob: new Blob(out, { type: 'audio/mpeg' }) });
  } catch (err) {
    self.postMessage({ ev: 'error', message: String(err?.message || err) });
  }
};
