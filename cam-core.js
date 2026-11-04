/*
 * cam-core.js — Space Cam engine (no UI).
 * Controls a USB-connected camera from the browser through web-gphoto2 (WebUSB + WebAssembly).
 * Built and tested on Sony A7 III (ILCE-7M3) in PC Remote mode, Chrome on macOS.
 *
 * Any Space app (Space Cam, a future Space Studio) can import this and build its own UI.
 *
 *   const cam = new CamCore();
 *   cam.addEventListener('state',  e => …)   // e.detail: { state, model, recording, recordStartedAt }
 *   cam.addEventListener('frame',  e => …)   // e.detail: { blob, width?, height? }
 *   cam.addEventListener('stats',  e => …)   // e.detail: { fps, frameMs }
 *   cam.addEventListener('info',   e => …)   // e.detail: { iso, shutter, aperture, wb, focusMode, battery, model }
 *   cam.addEventListener('error',  e => …)   // e.detail: { kind, message, action }
 *   cam.addEventListener('log',    e => …)   // e.detail: { message, level }
 *   await cam.connect({ pick: true })
 *   cam.startPreview(); await cam.startRecording(); await cam.afPress(); …
 *
 * States: 'unsupported' | 'idle' | 'connecting' | 'connected' | 'disconnected'
 * Error kinds: 'unsupported' | 'cancelled' | 'nodevice' | 'busy' | 'failed'
 */
import { Camera } from './lib/camera.js';

const RECORD_LIMIT_S = 29 * 60 + 59; // A7 III clip limit

export const CamCore = class CamCore extends EventTarget {
  #camera = null;
  #widgets = {};       // name -> leaf widget from the gphoto2 config tree
  #previewOn = false;
  #previewLoopRunning = false;
  #frames = 0;
  #lastStatsT = 0;
  #frameMsAvg = 0;
  #usbDevice = null;

  state = 'idle';
  model = '';
  recording = false;
  recordStartedAt = 0;
  focusRange = null;   // { min, max, step } for manual focus drive

  static get RECORD_LIMIT_S() { return RECORD_LIMIT_S; }
  static get supported() { return typeof navigator !== 'undefined' && 'usb' in navigator; }

  constructor() {
    super();
    if (!CamCore.supported) { this.state = 'unsupported'; return; }
    navigator.usb.addEventListener('disconnect', e => {
      if (this.state === 'connected' && (!this.#usbDevice || e.device === this.#usbDevice)) {
        this.#log('Camera unplugged or switched off', 'warn');
        this.#teardown('disconnected');
      }
    });
  }

  // ---------- connection ----------
  /** True if Chrome already has permission for a camera, so connect() can skip the picker. */
  async hasPermittedDevice() {
    if (!CamCore.supported) return false;
    const devices = await navigator.usb.getDevices();
    return devices.length > 0;
  }

  async connect({ pick = false } = {}) {
    if (!CamCore.supported) return this.#fail('unsupported', 'This browser has no WebUSB. Use Chrome or Edge on a Mac.');
    if (this.state === 'connecting' || this.state === 'connected') return true;
    this.#setState('connecting');
    try {
      if (pick || !(await this.hasPermittedDevice())) {
        try { await Camera.showPicker(); }
        catch (e) { this.#setState('idle'); return this.#fail('cancelled', 'No camera was chosen.'); }
      }
      const devices = await navigator.usb.getDevices();
      this.#usbDevice = devices[0] || null;
      this.#camera = new Camera();
      await this.#camera.connect();
      await this.#readWidgets();
      this.#setState('connected');
      this.#log(`Connected: ${this.model || 'camera'}`, 'ok');
      return true;
    } catch (e) {
      this.#camera = null;
      this.#setState('idle');
      return this.#fail(...this.#classify(e));
    }
  }

  async disconnect() {
    if (this.recording) this.#log('Disconnected while recording — the camera keeps recording until you stop it on the body', 'warn');
    this.#teardown('idle');
  }

  #teardown(nextState) {
    this.#previewOn = false;
    try { this.#camera?.disconnect(); } catch {}
    this.#camera = null;
    this.#widgets = {};
    if (this.recording) { this.recording = false; this.recordStartedAt = 0; }
    this.#setState(nextState);
  }

  #classify(e) {
    const msg = String(e?.message || e || '');
    if (/claim|busy|in use|access denied|Unable to claim/i.test(msg))
      return ['busy', 'Something else is holding the camera.', msg];
    if (/unknown model|could not find|no camera|not found|no device/i.test(msg))
      return ['nodevice', 'No camera answered. Check the cable, power and PC Remote mode.', msg];
    return ['failed', 'The camera did not respond.', msg];
  }

  // ---------- settings tree ----------
  async #readWidgets() {
    const cfg = await this.#camera.getConfig();
    const flat = {};
    const walk = n => {
      if (n.type === 'window' || n.type === 'section') Object.values(n.children || {}).forEach(walk);
      else flat[n.name] = n;
    };
    walk(cfg);
    this.#widgets = flat;
    this.model = flat.cameramodel?.value || flat.model?.value || '';
    const mf = flat.manualfocus;
    this.focusRange = mf && mf.type === 'range' ? { min: mf.min, max: mf.max, step: mf.step || 1 } : null;
    this.#emitInfo();
    return flat;
  }

  has(feature) {
    return !!({ record: this.#widgets.movie, af: this.#widgets.autofocus, mf: this.#widgets.manualfocus }[feature]);
  }

  #emitInfo() {
    const w = this.#widgets;
    const v = name => (w[name] && 'value' in w[name] ? w[name].value : null);
    this.#emit('info', {
      model: this.model,
      iso: v('iso'),
      shutter: v('shutterspeed') ?? v('shutterspeed2'),
      aperture: v('f-number') ?? v('aperture'),
      wb: v('whitebalance'),
      focusMode: v('focusmode'),
      battery: v('batterylevel'),
    });
  }

  /** Re-read exposure, battery and focus mode from the camera. Briefly pauses preview frames. */
  async refreshInfo() {
    if (!this.#camera) return;
    try { await this.#readWidgets(); } catch (e) { this.#log(`Could not refresh settings: ${e?.message || e}`, 'warn'); }
  }

  // ---------- preview ----------
  startPreview() {
    if (!this.#camera) return;
    this.#previewOn = true;
    if (!this.#previewLoopRunning) this.#previewLoop();
  }
  stopPreview() { this.#previewOn = false; }
  get previewing() { return this.#previewOn; }

  async #previewLoop() {
    this.#previewLoopRunning = true;
    this.#lastStatsT = performance.now();
    let failures = 0;
    while (this.#previewOn && this.#camera) {
      const t0 = performance.now();
      try {
        const blob = await this.#camera.capturePreviewAsBlob();
        failures = 0;
        this.#frames++;
        const dt = performance.now() - t0;
        this.#frameMsAvg = this.#frameMsAvg ? this.#frameMsAvg * 0.9 + dt * 0.1 : dt;
        this.#emit('frame', { blob });
      } catch (e) {
        failures++;
        if (failures === 1 || failures % 10 === 0) this.#log(`Preview frame failed: ${e?.message || e}`, 'warn');
        if (failures >= 20) { this.#log('Preview stopped after repeated failures', 'error'); this.#previewOn = false; break; }
        await new Promise(r => setTimeout(r, 300));
      }
      const now = performance.now();
      if (now - this.#lastStatsT >= 1000) {
        this.#emit('stats', { fps: this.#frames * 1000 / (now - this.#lastStatsT), frameMs: this.#frameMsAvg });
        this.#frames = 0; this.#lastStatsT = now;
      }
    }
    this.#previewLoopRunning = false;
  }

  // ---------- record ----------
  async startRecording() {
    if (!this.has('record') || this.recording) return false;
    if (!(await this.#set('movie', true, 'Record start'))) return false;
    this.recording = true;
    this.recordStartedAt = Date.now();
    this.#setState(this.state);
    return true;
  }

  async stopRecording() {
    if (!this.has('record') || !this.recording) return false;
    if (!(await this.#set('movie', false, 'Record stop'))) return false;
    this.recording = false;
    this.recordStartedAt = 0;
    this.#setState(this.state);
    return true;
  }

  toggleRecording() { return this.recording ? this.stopRecording() : this.startRecording(); }

  /** Seconds since recording started (0 when not recording). */
  get recordSeconds() { return this.recording ? Math.floor((Date.now() - this.recordStartedAt) / 1000) : 0; }

  /** Called by the UI when the clip limit is reached: the camera stops on its own, so mirror that. */
  markStoppedByCamera() {
    if (!this.recording) return;
    this.recording = false;
    this.recordStartedAt = 0;
    this.#log('Clip limit reached (29:59). The camera stops by itself — check its screen.', 'warn');
    this.#setState(this.state);
  }

  // ---------- focus ----------
  async afPress()   { return this.has('af') && this.#set('autofocus', true, 'AF press', true); }
  async afRelease() { return this.has('af') && this.#set('autofocus', false, 'AF release', true); }

  /** Manual focus drive. Negative = near, positive = far. Needs the camera's focus mode on MF (or DMF). */
  async focusStep(amount) {
    if (!this.has('mf')) return false;
    const r = this.focusRange || { min: -7, max: 7 };
    const v = Math.max(r.min, Math.min(r.max, Math.round(amount)));
    if (!v) return false;
    return this.#set('manualfocus', v, v < 0 ? 'Focus near' : 'Focus far', true);
  }

  // ---------- helpers ----------
  async #set(name, value, label, quiet = false) {
    if (!this.#camera) return false;
    const t0 = performance.now();
    try {
      await this.#camera.setConfigValue(name, value);
      if (!quiet) this.#log(`${label}: OK (${Math.round(performance.now() - t0)} ms)`, 'ok');
      return true;
    } catch (e) {
      this.#log(`${label} failed: ${e?.message || e}`, 'error');
      this.#emit('error', { kind: 'failed', message: `${label} failed.`, detail: String(e?.message || e) });
      return false;
    }
  }

  #setState(state) {
    this.state = state;
    this.#emit('state', { state, model: this.model, recording: this.recording, recordStartedAt: this.recordStartedAt });
  }
  #fail(kind, message, detail = '') {
    if (kind !== 'cancelled') this.#log(`${message}${detail ? ' — ' + detail : ''}`, 'error');
    this.#emit('error', { kind, message, detail });
    return false;
  }
  #log(message, level = 'info') { this.#emit('log', { message, level, t: Date.now() }); }
  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
};
