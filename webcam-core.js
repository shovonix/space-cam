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
  #rec = null; #worker = null; #pending = new Map(); #writes = Promise.resolve(); #extraTracks = [];

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
    const name = `${baseName}.${fmt.ext}`;
    try { await this.#ask('open', { name }); } catch { return null; }
    const tracks = [...this.stream.getVideoTracks()];
    this.#extraTracks = [];
    if (audioTrack) { const a = audioTrack.clone(); this.#extraTracks.push(a); tracks.push(a); }
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: fmt.mime, videoBitsPerSecond: vbps, audioBitsPerSecond: 192_000 });
    this.#writes = Promise.resolve();
    rec.ondataavailable = e => {
      if (!e.data?.size) return;
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

  // ---------- stored videos (browser storage) ----------
  async listStored() { const r = await this.#ask('list', {}); return r.files || []; }
  async getStoredFile(name) {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('videos', { create: true });
    return (await d.getFileHandle(name)).getFile();
  }
  async deleteStored(name) { await this.#ask('delete', { name }); }
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
