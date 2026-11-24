// webcam-core.js — the Mac's own camera (FaceTime HD, Continuity Camera, any USB webcam), no UI.
// Preview: a MediaStream the page puts in <video> elements.
// Recording: MediaRecorder (MP4 when Chrome supports it, else WebM). Each ~1 s chunk goes straight to the
// browser's private storage (OPFS 'videos') through video-writer.worker.js, so a crash loses at most a second.
//
//   const web = new WebcamCore();
//   await web.open(deviceId)            // state: off → connecting → connected
//   web.stream                          // MediaStream for <video>.srcObject
//   await web.startRecording('Take_3', audioTrack?)  → full file name ('Take_3.mp4') or null
//   await web.stopRecording()           → { name, bytes } (file stays in browser storage until saved)
//   web.addEventListener('state', e => …)   // e.detail: { state, label }
//   web.addEventListener('error', e => …)   // e.detail: { message }
//
// Chrome gives a site only ~10 GiB of private storage, so long takes are written in ~1 GiB pieces
// ('Take_3.mp4.~001', '~002' …). Set web.partsDir to the save folder before recording: every finished piece is
// moved there while recording, as a hidden '.Take_3.mp4.part001' (a crash keeps everything: the pieces in the
// folder plus the one still in browser storage). getStoredFile() joins all pieces into one file; saving writes
// 'Take_3.mp4' and removes the pieces. web.dirResolver (async () => folder handle) finds the pieces after a reload.

const TYPES = [
  ['video/mp4;codecs=avc1.640033,mp4a.40.2', 'mp4', 'big'], // H.264 High 5.1: 4K (e.g. a Sony through a Cam Link 4K)
  ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'mp4'],         // High 4.0: up to 1080p
  ['video/mp4;codecs=avc1,mp4a.40.2', 'mp4'],
  ['video/mp4', 'mp4'],
  ['video/webm;codecs=vp9,opus', 'webm'],
  ['video/webm', 'webm'],
];

export class WebcamCore extends EventTarget {
  state = 'off';
  stream = null;
  label = '';
  deviceId = '';
  recording = false;
  recordingName = '';
  partsDir = null;     // folder for finished pieces while recording (null: everything stays in browser storage)
  dirResolver = null;  // async () => folder handle, to find pieces of an earlier take (after a reload or crash)
  segBytes = 0;        // piece size override (testing); 0 = the worker's 1 GiB
  #rec = null; #worker = null; #pending = new Map(); #writes = Promise.resolve(); #extraTracks = [];
  #recDir = null; #moving = Promise.resolve();
  /** true while finished pieces of the current take are going to the folder */
  get partsActive() { return !!(this.recording && this.#recDir); }

  static get supported() {
    return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && navigator.storage?.getDirectory);
  }
  static get format() { return WebcamCore.formatFor(false); }
  /** Best recording format; big = picture larger than 1080p (needs a higher H.264 level). */
  static formatFor(big) {
    const t = TYPES.find(([m, , only]) => (big || only !== 'big') && window.MediaRecorder?.isTypeSupported(m));
    return t ? { mime: t[0], ext: t[1] } : null;
  }

  async listDevices() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'); } catch { return []; }
  }

  async open(deviceId = '') {
    if (!WebcamCore.supported) return this.#fail('This browser can’t use the Mac camera here.');
    await this.close();
    this.#setState('connecting');
    try {
      const ask = id => navigator.mediaDevices.getUserMedia({
        audio: false,
        // 1080p first (asking a 1080p camera like the FaceTime HD for 4K makes Chrome pick an odd tall format);
        // a camera that can do 4K (a capture card like the Cam Link 4K) is stepped up to 4K right after.
        video: { deviceId: id ? { exact: id } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, aspectRatio: { ideal: 16 / 9 }, frameRate: { ideal: 30 } },
      });
      // A saved camera that's gone (or got a new id) → OverconstrainedError: use the default camera instead
      try { this.stream = await ask(deviceId); }
      catch (e) { if (!deviceId || !/Overconstrained|NotFound/.test(e?.name)) throw e; this.stream = await ask(''); }
    } catch (e) {
      this.#setState('off');
      return this.#fail(e?.name === 'NotAllowedError' ? 'Camera access was blocked. Allow the camera for this site in Chrome (and in macOS Privacy & Security → Camera).' : 'Could not open the Mac camera: ' + (e?.message || e));
    }
    const track = this.stream.getVideoTracks()[0];
    try { // 4K only for cameras that really offer it (16:9, 3840 wide); everything else stays exactly as opened
      const cap = track?.getCapabilities?.() || {};
      if ((cap.width?.max || 0) >= 3840 && (cap.height?.max || 0) >= 2160) await track.applyConstraints({ width: { ideal: 3840 }, height: { ideal: 2160 }, aspectRatio: { ideal: 16 / 9 }, frameRate: { ideal: 30 } });
    } catch {}
    this.label = track?.label || 'Mac camera';
    this.deviceId = track?.getSettings().deviceId || deviceId;
    track?.addEventListener('ended', () => { if (this.state !== 'off') { this.#fail('The Mac camera stopped.'); this.close(); } });
    this.#setState('connected');
    return true;
  }

  async close() {
    if (this.recording) await this.stopRecording();
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    if (this.state !== 'off') this.#setState('off');
  }

  /** Starts recording. audioTrack (optional) is added so the video file has sound for syncing. */
  async startRecording(baseName, audioTrack = null) {
    if (this.state !== 'connected' || this.recording) return null;
    const vs = this.stream.getVideoTracks()[0]?.getSettings() || {};
    const px = (vs.width || 1920) * (vs.height || 1080), fps = vs.frameRate || 30;
    const fmt = WebcamCore.formatFor(px > 1920 * 1080);
    if (!fmt) { this.#fail('Chrome can’t record video here.'); return null; }
    // bitrate follows the picture: 1080p30 ≈ 12 Mbps (as before), 4K25 ≈ 41 Mbps
    const vbps = Math.round(Math.min(50e6, Math.max(8e6, px * fps * 0.2)));
    this.bytesPerSec = (vbps + (audioTrack ? 192_000 : 0)) / 8; // what this take writes to browser storage each second
    this.full = false;
    const name = `${baseName}.${fmt.ext}`;
    this.#recDir = this.partsDir || null;
    try { await this.#ask('open', { name, seg: this.segBytes || 0 }); } catch { return null; }
    const tracks = [...this.stream.getVideoTracks()];
    this.#extraTracks = [];
    if (audioTrack) { const a = audioTrack.clone(); this.#extraTracks.push(a); tracks.push(a); }
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: fmt.mime, videoBitsPerSecond: vbps, audioBitsPerSecond: 192_000 });
    this.#writes = Promise.resolve();
    rec.ondataavailable = e => {
      if (!e.data?.size || this.full) return;
      // keep chunks in order: each write waits for the one before
      this.#writes = this.#writes.then(() => e.data.arrayBuffer()).then(buf => this.#worker.postMessage({ cmd: 'chunk', buf }, [buf]));
    };
    rec.onerror = e => this.#fail('Video recording error: ' + (e?.error?.message || 'unknown'));
    this.#rec = rec;
    rec.start(1000);
    console.info(`[video] ${name}: ${vs.width}×${vs.height} @ ${Math.round(fps)} fps, ${(vbps / 1e6).toFixed(0)} Mbps, ${fmt.mime}`);
    this.recording = true; this.recordingName = name;
    this.#setState('connected');
    return name;
  }

  async stopRecording() {
    if (!this.recording || !this.#rec) return null;
    const rec = this.#rec;
    await new Promise(r => { rec.onstop = r; try { rec.stop(); } catch { r(); } });
    await this.#writes;
    this.#extraTracks.forEach(t => t.stop()); this.#extraTracks = [];
    let res = null;
    try { res = await this.#ask('close', {}); } catch {}
    await this.#moving; // a piece still on its way to the folder
    this.#rec = null; this.recording = false; this.recordingName = '';
    this.#setState(this.stream ? 'connected' : 'off');
    return res;
  }

  /**
   * Moves the sound of a Chrome MP4 later by `ms`, without re-encoding: Chrome writes fragmented MP4 (a moof box
   * every ~1 s), and each fragment says when its samples start (tfdt). Adding the same amount to every sound
   * fragment's start shifts the whole sound track; the picture is untouched and the file size stays the same.
   * Used for capture cards (Cam Link 4K): the HDMI picture arrives ~60 ms after the mic sound.
   * Returns a Blob made of slices of the original (nothing big is copied); returns the file as it is if the
   * layout isn't what we expect, so saving never fails because of this. Tested 17 Nov 2026 on Take_81.
   */
  static async shiftAudio(file, ms) {
    if (!(ms > 0) || !file || file.size < 16) return file;
    try {
      const u32 = (dv, o) => dv.getUint32(o);
      const name4 = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
      const head = async o => { const dv = new DataView(await file.slice(o, o + 16).arrayBuffer()); let size = u32(dv, 0), hdr = 8; const type = name4(dv, 4); if (size === 1) { size = Number(dv.getBigUint64(8)); hdr = 16; } else if (size === 0) size = file.size - o; return { size, type, hdr }; };
      const kids = (dv, o, end, fn) => { while (o + 8 <= end) { let size = u32(dv, o), hdr = 8; const type = name4(dv, o + 4); if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; } if (size < 8 || o + size > end) return; fn(type, o, size, hdr); o += size; } };
      // 1) top-level boxes; read moov to find the sound track's id and timescale
      const top = []; let o = 0;
      while (o + 8 <= file.size) { const b = await head(o); if (b.size < 8) break; top.push({ ...b, o }); o += b.size; }
      const moov = top.find(b => b.type === 'moov'); if (!moov || !top.some(b => b.type === 'moof')) return file;
      const mv = new DataView(await file.slice(moov.o, moov.o + moov.size).arrayBuffer());
      let soundId = 0, soundScale = 0;
      kids(mv, moov.hdr, moov.size, (t, to, ts, th) => { if (t !== 'trak') return;
        let id = 0, scale = 0, snd = false;
        kids(mv, to + th, to + ts, (t2, o2, s2, h2) => {
          if (t2 === 'tkhd') { const v = mv.getUint8(o2 + h2); id = u32(mv, o2 + h2 + (v === 1 ? 20 : 12)); }
          if (t2 === 'mdia') kids(mv, o2 + h2, o2 + s2, (t3, o3, s3, h3) => {
            if (t3 === 'mdhd') { const v = mv.getUint8(o3 + h3); scale = u32(mv, o3 + h3 + (v === 1 ? 20 : 12)); }
            if (t3 === 'hdlr') snd = name4(mv, o3 + h3 + 8) === 'soun';
          });
        });
        if (snd) { soundId = id; soundScale = scale; }
      });
      if (!soundId || !soundScale) return file;
      const add = BigInt(Math.round(ms * soundScale / 1000));
      // 2) rebuild as slices, patching each moof's sound tfdt
      const parts = [];
      for (const b of top) {
        if (b.type !== 'moof') { parts.push(file.slice(b.o, b.o + b.size)); continue; }
        const buf = await file.slice(b.o, b.o + b.size).arrayBuffer(), dv = new DataView(buf);
        kids(dv, b.hdr, b.size, (t, to, ts, th) => { if (t !== 'traf') return;
          let tid = 0;
          kids(dv, to + th, to + ts, (t2, o2, s2, h2) => {
            if (t2 === 'tfhd') tid = u32(dv, o2 + h2 + 4);
            if (t2 === 'tfdt' && tid === soundId) { const v = dv.getUint8(o2 + h2), at = o2 + h2 + 4;
              if (v === 1) dv.setBigUint64(at, dv.getBigUint64(at) + add); else dv.setUint32(at, Number(BigInt(u32(dv, at)) + add)); }
          });
        });
        parts.push(new Uint8Array(buf));
      }
      return new Blob(parts, { type: file.type || 'video/mp4' });
    } catch { return file; }
  }

  // ---------- stored videos (browser storage + pieces moved to the folder) ----------
  static #seg = (n, i) => `${n}.~${String(i).padStart(3, '0')}`;
  static #part = (n, i) => `.${n}.part${String(i).padStart(3, '0')}`;
  async #opfs() { return (await navigator.storage.getDirectory()).getDirectoryHandle('videos', { create: true }); }
  async #dirFor(name) {
    if (this.recording && name === this.recordingName && this.#recDir) return this.#recDir;
    if (this.partsDir) return this.partsDir;
    try { return (await this.dirResolver?.()) || null; } catch { return null; }
  }
  // A finished piece goes to the folder while the next one records. If that fails (card out, no permission),
  // the rest of the take stays in browser storage and 'partsoff' tells the page (its space check takes over).
  #moveOut(name, i) {
    this.#moving = this.#moving.then(async () => {
      const dir = this.#recDir; if (!dir) return;
      try {
        const d = await this.#opfs(), f = await (await d.getFileHandle(WebcamCore.#seg(name, i))).getFile();
        const w = await (await dir.getFileHandle(WebcamCore.#part(name, i), { create: true })).createWritable();
        await f.stream().pipeTo(w); // closes w: the piece is now a real file in the folder
        await d.removeEntry(WebcamCore.#seg(name, i));
      } catch (e) {
        this.#recDir = null;
        this.#emit('partsoff', { message: String(e?.message || e) });
      }
    });
  }
  /** Stored takes: one entry per take (its pieces counted together). */
  async listStored() {
    const r = await this.#ask('list', {}), by = new Map();
    for (const f of r.files || []) {
      if (f.name.endsWith('.parts.json')) continue;
      const m = f.name.match(/^(.*)\.~\d{3}$/), n = m ? m[1] : f.name;
      const e = by.get(n) || { name: n, size: 0, modified: 0 };
      e.size += f.size; e.modified = Math.max(e.modified, f.modified); by.set(n, e);
    }
    return [...by.values()];
  }
  /** The pieces of a take, in order: [{ file, where: 'browser'|'folder' }]. Missing pieces are skipped. */
  async #pieces(name) {
    const d = await this.#opfs();
    let n = 0;
    try { n = JSON.parse(await (await (await d.getFileHandle(`${name}.parts.json`)).getFile()).text()).n || 0; } catch {}
    if (!n) { // older takes: one plain file
      try { return [{ file: await (await d.getFileHandle(name)).getFile(), where: 'browser' }]; } catch { return []; }
    }
    const out = []; let dir;
    for (let i = 1; i <= n; i++) {
      try { out.push({ file: await (await d.getFileHandle(WebcamCore.#seg(name, i))).getFile(), where: 'browser' }); continue; } catch {}
      if (dir === undefined) dir = await this.#dirFor(name);
      try { if (dir) out.push({ file: await (await dir.getFileHandle(WebcamCore.#part(name, i))).getFile(), where: 'folder' }); } catch {}
    }
    return out;
  }
  /** The whole take as one file (pieces joined; nothing big is copied). */
  async getStoredFile(name) {
    await this.#moving;
    const p = await this.#pieces(name);
    if (!p.length) throw new Error('not stored');
    if (p.length === 1 && !/\.~\d{3}$/.test(p[0].file.name) && p[0].where === 'browser') return p[0].file;
    return new File(p.map(x => x.file), name, { type: name.endsWith('.webm') ? 'video/webm' : 'video/mp4', lastModified: Math.max(...p.map(x => x.file.lastModified)) });
  }
  async deleteStored(name) {
    await this.#moving;
    const d = await this.#opfs();
    let n = 0;
    try { n = JSON.parse(await (await (await d.getFileHandle(`${name}.parts.json`)).getFile()).text()).n || 0; } catch {}
    await this.#ask('delete', { name });
    if (n) {
      const dir = await this.#dirFor(name);
      for (let i = 1; i <= n; i++) {
        await d.removeEntry(WebcamCore.#seg(name, i)).catch(() => {});
        if (dir) await dir.removeEntry(WebcamCore.#part(name, i)).catch(() => {});
      }
      await d.removeEntry(`${name}.parts.json`).catch(() => {});
    }
  }
  /** Copies a stored video into a folder handle. Deletes the stored copy on success.
   *  audioShiftMs > 0 moves the sound that much later in the saved copy (see shiftAudio). */
  async moveToFolder(name, dirHandle, destName = name, audioShiftMs = 0, onProgress = null) {
    const file = await WebcamCore.shiftAudio(await this.getStoredFile(name), audioShiftMs);
    const w = await (await dirHandle.getFileHandle(destName, { create: true })).createWritable();
    let done = 0; // onProgress(0..1) as the bytes are copied (a 30-min 4K take is ~8 GB)
    const count = new TransformStream({ transform(chunk, c) { done += chunk.byteLength; onProgress?.(done / (file.size || 1)); c.enqueue(chunk); } });
    await file.stream().pipeThrough(count).pipeTo(w);
    await this.deleteStored(name);
    return true;
  }

  // ---------- helpers ----------
  #ensureWorker() {
    if (this.#worker) return;
    this.#worker = new Worker(new URL('./video-writer.worker.js' + new URL(import.meta.url).search, import.meta.url)); // same ?v= as this file
    this.#worker.onmessage = e => {
      const m = e.data;
      // No room left on the Mac (or Chrome's share of it): say it once and stop the take; what's written so far is kept.
      if (m.ev === 'rotated') { this.#moveOut(m.name, m.seg); return; }
      if (m.ev === 'error' && m.cmd === 'chunk') {
        if (!this.full && this.recording) { this.full = true; this.#emit('full', { message: m.message }); }
        return;
      }
      if (m.ev === 'error') this.#fail(`Video file error (${m.cmd}): ${m.message}`);
      const key = m.ev === 'error' ? m.cmd : ({ opened: 'open', closed: 'close', list: 'list', deleted: 'delete' })[m.ev];
      const p = this.#pending.get(key);
      if (p) { this.#pending.delete(key); m.ev === 'error' ? p.reject(new Error(m.message)) : p.resolve(m); }
    };
  }
  #ask(cmd, payload) {
    this.#ensureWorker();
    return new Promise((resolve, reject) => { this.#pending.set(cmd, { resolve, reject }); this.#worker.postMessage({ cmd, ...payload }); });
  }
  #setState(state) { this.state = state; this.#emit('state', { state, label: this.label }); }
  #fail(message) { this.#emit('error', { message }); return false; }
  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
