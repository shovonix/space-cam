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
  ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'mp4'],
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
  static get format() {
    const t = TYPES.find(([m]) => window.MediaRecorder?.isTypeSupported(m));
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
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      });
    } catch (e) {
      this.#setState('off');
      return this.#fail(e?.name === 'NotAllowedError' ? 'Camera access was blocked. Allow the camera for this site in Chrome (and in macOS Privacy & Security → Camera).' : 'Could not open the Mac camera: ' + (e?.message || e));
    }
    const track = this.stream.getVideoTracks()[0];
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
    const fmt = WebcamCore.format;
    if (!fmt) { this.#fail('Chrome can’t record video here.'); return null; }
    const name = `${baseName}.${fmt.ext}`;
    try { await this.#ask('open', { name }); } catch { return null; }
    const tracks = [...this.stream.getVideoTracks()];
    this.#extraTracks = [];
    if (audioTrack) { const a = audioTrack.clone(); this.#extraTracks.push(a); tracks.push(a); }
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: fmt.mime, videoBitsPerSecond: 12_000_000, audioBitsPerSecond: 192_000 });
    this.#writes = Promise.resolve();
    rec.ondataavailable = e => {
      if (!e.data?.size) return;
      // keep chunks in order: each write waits for the one before
      this.#writes = this.#writes.then(() => e.data.arrayBuffer()).then(buf => this.#worker.postMessage({ cmd: 'chunk', buf }, [buf]));
    };
    rec.onerror = e => this.#fail('Video recording error: ' + (e?.error?.message || 'unknown'));
    this.#rec = rec;
    rec.start(1000);
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

  // ---------- stored videos (browser storage) ----------
  async listStored() { const r = await this.#ask('list', {}); return r.files || []; }
  async getStoredFile(name) {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('videos', { create: true });
    return (await d.getFileHandle(name)).getFile();
  }
  async deleteStored(name) { await this.#ask('delete', { name }); }
  /** Copies a stored video into a folder handle. Deletes the stored copy on success. */
  async moveToFolder(name, dirHandle, destName = name) {
    const file = await this.getStoredFile(name);
    const w = await (await dirHandle.getFileHandle(destName, { create: true })).createWritable();
    await file.stream().pipeTo(w);
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
