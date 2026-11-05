/*
 * audio-core.js — Space audio engine (no UI).
 * Mic selection, live level meter, and 48 kHz / 24-bit WAV recording.
 * While recording, audio is written into the browser's private storage (OPFS) by a worker,
 * so a crash keeps what was recorded. On stop the file can be moved into a folder the user
 * picked (File System Access API) or saved later.
 *
 *   const audio = new AudioCore();
 *   audio.addEventListener('level', e => e.detail.peakDb / rmsDb / clip)
 *   audio.addEventListener('devices', e => e.detail.devices)
 *   audio.addEventListener('state',  e => e.detail.state)   // 'off' | 'ready' | 'recording'
 *   audio.addEventListener('error',  e => e.detail.message)
 *   await audio.open(deviceId);  await audio.startRecording('Take-01.wav');  const take = await audio.stopRecording();
 */

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor(){ super(); this.on = false; this.buf = null; this.n = 0; this.SIZE = 4096; this.out = null;
    this.port.onmessage = e => { if (e.data.port) this.out = e.data.port; if ('on' in e.data) { this.on = e.data.on; if (!this.on) this.flush(); } }; }
  flush(){ if (this.buf && this.n && this.out) { this.out.postMessage(this.buf.map(b => b.slice(0, this.n))); } this.buf = null; this.n = 0; }
  process(inputs){
    const inp = inputs[0];
    if (this.on && inp && inp.length && this.out) {
      if (!this.buf) this.buf = inp.map(() => new Float32Array(this.SIZE));
      const len = inp[0].length;
      for (let c = 0; c < this.buf.length; c++) this.buf[c].set(inp[c] || inp[0], this.n);
      this.n += len;
      if (this.n + len > this.SIZE) { const b = this.buf.map(x => x.slice(0, this.n)); this.out.postMessage(b, b.map(x => x.buffer)); this.buf = null; this.n = 0; }
    }
    return true;
  }
}
registerProcessor('space-tap', Tap);`;

export class AudioCore extends EventTarget {
  state = 'off';
  deviceId = '';
  deviceLabel = '';
  sampleRate = 48000;
  channels = 1;
  recordingName = '';
  recordStartedAt = 0;

  #ctx = null; #stream = null; #src = null; #analyser = null; #tap = null;
  #worker = null; #pending = new Map(); #meterRaf = 0; #clipUntil = 0;

  static get supported() {
    return !!(navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode && navigator.storage?.getDirectory);
  }

  constructor() {
    super();
    navigator.mediaDevices?.addEventListener?.('devicechange', () => this.listDevices());
  }

  // ---------- devices ----------
  async listDevices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    const devices = all.filter(d => d.kind === 'audioinput').map(d => ({ id: d.deviceId, label: d.label || 'Microphone' }));
    this.#emit('devices', { devices });
    return devices;
  }

  /** Opens a mic (asks for permission the first time). Pass '' for the system default. */
  async open(deviceId = '') {
    await this.close();
    try {
      this.#stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 },
        },
      });
    } catch (e) {
      return this.#fail(e?.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the address bar, then try again.' : `Could not open the microphone: ${e?.message || e}`);
    }
    const track = this.#stream.getAudioTracks()[0];
    const s = track.getSettings();
    this.deviceId = s.deviceId || deviceId;
    this.deviceLabel = track.label || 'Microphone';
    this.channels = Math.min(2, s.channelCount || 1);
    this.#ctx = new AudioContext({ sampleRate: s.sampleRate || 48000, latencyHint: 'interactive' });
    this.sampleRate = this.#ctx.sampleRate;
    this.#src = this.#ctx.createMediaStreamSource(this.#stream);
    this.#analyser = this.#ctx.createAnalyser();
    this.#analyser.fftSize = 2048;
    this.#src.connect(this.#analyser);

    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await this.#ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.#tap = new AudioWorkletNode(this.#ctx, 'space-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: this.channels, channelCountMode: 'explicit' });
    this.#src.connect(this.#tap);

    this.#ensureWorker();
    const ch = new MessageChannel();
    this.#worker.postMessage({ port: ch.port1 }, [ch.port1]);
    this.#tap.port.postMessage({ port: ch.port2 }, [ch.port2]);

    track.addEventListener('ended', () => { this.#fail('The microphone was disconnected.'); this.close(); });
    this.#startMeter();
    this.#setState('ready');
    this.listDevices();
    return true;
  }

  async close() {
    cancelAnimationFrame(this.#meterRaf);
    if (this.state === 'recording') await this.stopRecording();
    this.#stream?.getTracks().forEach(t => t.stop());
    try { await this.#ctx?.close(); } catch {}
    this.#stream = this.#ctx = this.#src = this.#analyser = this.#tap = null;
    if (this.state !== 'off') this.#setState('off');
  }

  // ---------- meter ----------
  #startMeter() {
    const buf = new Float32Array(this.#analyser.fftSize);
    const loop = () => {
      if (!this.#analyser) return;
      this.#analyser.getFloatTimeDomainData(buf);
      let peak = 0, sum = 0;
      for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; sum += buf[i] * buf[i]; }
      const rms = Math.sqrt(sum / buf.length);
      if (peak >= 0.98) this.#clipUntil = performance.now() + 1500;
      this.#emit('level', {
        peakDb: peak > 0 ? 20 * Math.log10(peak) : -120,
        rmsDb: rms > 0 ? 20 * Math.log10(rms) : -120,
        clip: performance.now() < this.#clipUntil,
      });
      this.#meterRaf = requestAnimationFrame(loop);
    };
    loop();
  }

  // ---------- recording ----------
  #ensureWorker() {
    if (this.#worker) return;
    this.#worker = new Worker(new URL('./audio-writer.worker.js', import.meta.url));
    this.#worker.onmessage = e => {
      const m = e.data;
      if (m.ev === 'error') this.#fail(`Audio file error (${m.cmd}): ${m.message}`);
      const key = m.ev === 'error' ? m.cmd : ({ opened: 'open', closed: 'close', list: 'list', deleted: 'delete' })[m.ev];
      const p = this.#pending.get(key);
      if (p) { this.#pending.delete(key); m.ev === 'error' ? p.reject(new Error(m.message)) : p.resolve(m); }
    };
  }
  #ask(cmd, payload) {
    this.#ensureWorker();
    return new Promise((resolve, reject) => {
      this.#pending.set(cmd, { resolve, reject });
      this.#worker.postMessage({ cmd, ...payload });
    });
  }

  async startRecording(name) {
    if (this.state !== 'ready') return false;
    try { await this.#ask('open', { name, sampleRate: this.sampleRate, channels: this.channels }); }
    catch { return false; }
    this.recordingName = name;
    this.recordStartedAt = Date.now();
    this.#tap.port.postMessage({ on: true });
    this.#setState('recording');
    return true;
  }

  /** Stops and finalises the WAV. Returns { name, seconds, bytes } (file lives in browser storage until saved). */
  async stopRecording() {
    if (this.state !== 'recording') return null;
    this.#tap?.port.postMessage({ on: false });
    await new Promise(r => setTimeout(r, 200)); // let the last chunk reach the worker
    let res = null;
    try { res = await this.#ask('close', {}); } catch {}
    this.recordingName = ''; this.recordStartedAt = 0;
    this.#setState(this.#stream ? 'ready' : 'off');
    return res;
  }

  get recordSeconds() { return this.state === 'recording' ? Math.floor((Date.now() - this.recordStartedAt) / 1000) : 0; }

  // ---------- stored takes ----------
  async listStored() { const r = await this.#ask('list', {}); return r.files || []; }
  async getStoredFile(name) {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('takes', { create: true });
    return (await d.getFileHandle(name)).getFile();
  }
  async deleteStored(name) { await this.#ask('delete', { name }); }

  /** Copies a stored take into a folder handle (File System Access). Deletes the stored copy on success. */
  async moveToFolder(name, dirHandle) {
    const file = await this.getStoredFile(name);
    const dest = await dirHandle.getFileHandle(name, { create: true });
    const w = await dest.createWritable();
    await file.stream().pipeTo(w);
    await this.deleteStored(name);
    return true;
  }

  /** Asks where to save one take (Save dialog). */
  async saveAs(name) {
    const file = await this.getStoredFile(name);
    if (window.showSaveFilePicker) {
      const h = await showSaveFilePicker({ suggestedName: name, types: [{ description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } }] });
      const w = await h.createWritable();
      await file.stream().pipeTo(w);
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
    await this.deleteStored(name);
    return true;
  }

  // ---------- helpers ----------
  #setState(state) { this.state = state; this.#emit('state', { state, label: this.deviceLabel }); }
  #fail(message) { this.#emit('error', { message }); return false; }
  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
