// video-writer.worker.js — writes Mac-camera takes (MediaRecorder chunks) into the browser's private
// file storage (OPFS, folder 'videos') with a synchronous access handle, so every chunk is on disk
// as it arrives and the video survives a tab crash. Same approach as audio-writer.worker.js.
//
// A take is written in pieces of about 1 GiB: 'Take_3.mp4.~001', 'Take_3.mp4.~002', … Chrome gives a site
// only ~10 GiB in total, so finished pieces are moved out to the chosen folder while recording (by
// webcam-core.js, on 'rotated'). Joined in order, the pieces are exactly the one MP4 stream MediaRecorder made.
//
// Messages in:  {cmd:'open', name}, {cmd:'chunk', buf: ArrayBuffer}, {cmd:'close'}, {cmd:'list'}, {cmd:'delete', name}
// Messages out: {ev:'opened'|'rotated'|'closed'|'list'|'deleted'|'error', ...}

const SEG = 1024 ** 3; // start a new piece once this one is about 1 GiB (only between chunks)
let handle = null, offset = 0, total = 0, seg = 0, name = null, dir = null, segSize = SEG;

async function videosDir() {
  if (!dir) dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('videos', { create: true });
  return dir;
}
const segName = (n, i) => `${n}.~${String(i).padStart(3, '0')}`;
async function openSeg() {
  const d = await videosDir();
  const fh = await d.getFileHandle(segName(name, seg), { create: true });
  handle = await fh.createSyncAccessHandle();
  handle.truncate(0);
  offset = 0;
  // how many pieces this take has, for recovery after a crash (written before the first byte of the piece)
  const mh = await (await d.getFileHandle(`${name}.parts.json`, { create: true })).createSyncAccessHandle();
  const j = new TextEncoder().encode(JSON.stringify({ n: seg, seg: segSize }));
  mh.truncate(0); mh.write(j, { at: 0 }); mh.flush(); mh.close();
}

// one message at a time, in order (opening the next piece is async; no chunk may slip past it)
let queue = Promise.resolve();
self.onmessage = e => { queue = queue.then(() => handle_(e.data)); };
async function handle_(m) {
  try {
    if (m.cmd === 'open') {
      name = m.name; seg = 1; total = 0; segSize = m.seg || SEG; // m.seg: smaller pieces for testing
      await openSeg();
      self.postMessage({ ev: 'opened', name });
    } else if (m.cmd === 'chunk') {
      if (!handle) return;
      const bytes = new Uint8Array(m.buf);
      if (offset > 0 && offset + bytes.length > segSize) { // this piece is full: close it, start the next
        handle.flush(); handle.close(); handle = null;
        const done = seg; seg++;
        await openSeg();
        self.postMessage({ ev: 'rotated', name, seg: done });
      }
      handle.write(bytes, { at: offset });
      offset += bytes.length; total += bytes.length;
      handle.flush(); // one flush per chunk (about once a second)
    } else if (m.cmd === 'close') {
      if (!handle) { self.postMessage({ ev: 'closed', name: null }); return; }
      handle.flush(); handle.close(); handle = null;
      self.postMessage({ ev: 'closed', name, bytes: total, segs: seg });
      name = null;
    } else if (m.cmd === 'list') {
      const d = await videosDir(), files = [];
      for await (const [n, h] of d.entries()) if (h.kind === 'file') { const f = await h.getFile(); files.push({ name: n, size: f.size, modified: f.lastModified }); }
      self.postMessage({ ev: 'list', files });
    } else if (m.cmd === 'delete') {
      const d = await videosDir();
      await d.removeEntry(m.name).catch(() => {});
      self.postMessage({ ev: 'deleted', name: m.name });
    }
  } catch (err) {
    self.postMessage({ ev: 'error', cmd: m.cmd, message: String(err?.message || err) });
  }
}
