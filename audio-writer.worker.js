// audio-writer.worker.js — writes WAV takes into the browser's private file storage (OPFS)
// with a synchronous access handle, so data is on disk as it arrives and survives a tab crash.
// Messages in:  {cmd:'open', name, sampleRate, channels}  then Float32 chunks on the port,
//               {cmd:'close'}, {cmd:'list'}, {cmd:'delete', name}
// Messages out: {ev:'opened'|'closed'|'list'|'deleted'|'error', ...}

const BITS = 24;
let handle = null, offset = 44, meta = null, dir = null;

async function takesDir() {
  if (!dir) dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('takes', { create: true });
  return dir;
}

function header(dataBytes, sampleRate, channels) {
  const b = new ArrayBuffer(44), v = new DataView(b), blockAlign = channels * BITS / 8;
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true); v.setUint16(34, BITS, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);
  return new Uint8Array(b);
}

// planar Float32 channels -> interleaved 24-bit little-endian PCM
function toPcm24(chs) {
  const n = chs[0].length, c = chs.length, out = new Uint8Array(n * c * 3);
  let o = 0;
  for (let i = 0; i < n; i++) for (let ch = 0; ch < c; ch++) {
    let s = Math.max(-1, Math.min(1, chs[ch][i]));
    let x = s < 0 ? Math.round(s * 0x800000) : Math.round(s * 0x7fffff);
    out[o++] = x & 255; out[o++] = (x >> 8) & 255; out[o++] = (x >> 16) & 255;
  }
  return out;
}

let flushCounter = 0;
function onChunk(chs) {
  if (!handle) return;
  const pcm = toPcm24(chs);
  handle.write(pcm, { at: offset });
  offset += pcm.length;
  // keep the header roughly current so a crashed take is still a playable WAV
  if (++flushCounter % 50 === 0) {
    handle.write(header(offset - 44, meta.sampleRate, meta.channels), { at: 0 });
    handle.flush();
  }
}

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.port) { m.port.onmessage = ev => onChunk(ev.data); return; }
    if (m.cmd === 'open') {
      const d = await takesDir();
      const fh = await d.getFileHandle(m.name, { create: true });
      handle = await fh.createSyncAccessHandle();
      handle.truncate(0);
      meta = { name: m.name, sampleRate: m.sampleRate, channels: m.channels };
      offset = 44;
      handle.write(header(0, m.sampleRate, m.channels), { at: 0 });
      handle.flush();
      self.postMessage({ ev: 'opened', name: m.name });
    } else if (m.cmd === 'close') {
      if (!handle) { self.postMessage({ ev: 'closed', name: null }); return; }
      const bytes = offset - 44;
      handle.write(header(bytes, meta.sampleRate, meta.channels), { at: 0 });
      handle.flush(); handle.close(); handle = null;
      self.postMessage({ ev: 'closed', name: meta.name, bytes, seconds: bytes / (meta.sampleRate * meta.channels * BITS / 8) });
      meta = null;
    } else if (m.cmd === 'list') {
      const d = await takesDir(), files = [];
      for await (const [name, h] of d.entries()) if (h.kind === 'file') { const f = await h.getFile(); files.push({ name, size: f.size, modified: f.lastModified }); }
      self.postMessage({ ev: 'list', files });
    } else if (m.cmd === 'delete') {
      const d = await takesDir();
      await d.removeEntry(m.name).catch(() => {});
      self.postMessage({ ev: 'deleted', name: m.name });
    }
  } catch (err) {
    self.postMessage({ ev: 'error', cmd: m.cmd, message: String(err?.message || err) });
  }
};
