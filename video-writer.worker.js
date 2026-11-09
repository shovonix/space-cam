// video-writer.worker.js — writes Mac-camera takes (MediaRecorder chunks) into the browser's private
// file storage (OPFS, folder 'videos') with a synchronous access handle, so every chunk is on disk
// as it arrives and the video survives a tab crash. Same approach as audio-writer.worker.js.
// Messages in:  {cmd:'open', name}, {cmd:'chunk', buf: ArrayBuffer}, {cmd:'close'}, {cmd:'list'}, {cmd:'delete', name}
// Messages out: {ev:'opened'|'closed'|'list'|'deleted'|'error', ...}

let handle = null, offset = 0, name = null, dir = null;

async function videosDir() {
  if (!dir) dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('videos', { create: true });
  return dir;
}

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.cmd === 'open') {
      const d = await videosDir();
      const fh = await d.getFileHandle(m.name, { create: true });
      handle = await fh.createSyncAccessHandle();
      handle.truncate(0);
      offset = 0; name = m.name;
      self.postMessage({ ev: 'opened', name });
    } else if (m.cmd === 'chunk') {
      if (!handle) return;
      const bytes = new Uint8Array(m.buf);
      handle.write(bytes, { at: offset });
      offset += bytes.length;
      handle.flush(); // one flush per chunk (about once a second)
    } else if (m.cmd === 'close') {
      if (!handle) { self.postMessage({ ev: 'closed', name: null }); return; }
      handle.flush(); handle.close(); handle = null;
      self.postMessage({ ev: 'closed', name, bytes: offset });
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
};
