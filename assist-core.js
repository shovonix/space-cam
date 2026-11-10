// assist-core.js — Shooting assistant engine, no UI.
// Looks at the camera preview (a few times a second, a small copy) and the mic levels, and says what could be
// better: too dark, blown out, noisy room, mic clipping, camera battery, and — with the optional face detector
// (MediaPipe, downloaded once into Cache Storage) — framing, headroom, focus on the face, backlight.
// It never touches the recording: it only reads the preview picture and the meter values.
//
//   const a = new AssistCore();
//   a.analyze(imgOrVideo, { camera: 'sony'|'mac' })  → call ~1–2×/s
//   a.audio({ rmsDb, peakDb, clip })                  → call on every mic level event
//   a.battery(levelText)                              → Sony battery text, e.g. '15%'
//   a.addEventListener('tip', e => e.detail)          → { id, kind, text } or null (nothing to say)
//   AssistCore.faceReady() / AssistCore.downloadFace(onProgress) / a.loadFace()

const CACHE = 'spacecam-assist-v1';
const FILES = {
  js: 'lib/mediapipe/wasm/vision_wasm_internal.js',
  wasm: 'lib/mediapipe/wasm/vision_wasm_internal.wasm',
  model: 'models/blaze_face_short_range.tflite',
};
const abs = p => new URL(p, location.href).href;
export const FACE_MB = 10;

// what to say; earlier in the list = more important
const TIPS = {
  battery:   { kind: 'warn',  text: v => `Camera battery is low (${v}). Charge or swap it before a long take.` },
  clipping:  { kind: 'warn',  text: () => 'Your mic is clipping (too loud). Turn its gain down or move back a little.' },
  focus:     { kind: 'warn',  text: () => 'Focus may have missed your face: the background looks sharper. Hold A for autofocus.' },
  noface:    { kind: 'info',  text: () => 'I can’t see your face. Check the framing.' },
  dark:      { kind: 'light', text: () => 'It’s quite dark. Turn on a light or face a window.' },
  backlit:   { kind: 'light', text: () => 'Bright light behind you. Turn toward the light or close the curtain.' },
  bright:    { kind: 'light', text: () => 'Parts of the picture are blown out. Lower the light or the exposure.' },
  noisy:     { kind: 'sound', text: () => 'The room is noisy. Close windows, turn off fans, or move the mic closer.' },
  quiet:     { kind: 'sound', text: () => 'Your voice is quiet in the mic. Move it closer or turn its gain up.' },
  nosound:   { kind: 'sound', text: () => 'The mic isn’t picking up any sound. Check that it’s unmuted and the right input is picked.' },
  offleft:   { kind: 'frame', text: () => 'You’re off to the left. Move a little toward the middle.' },
  offright:  { kind: 'frame', text: () => 'You’re off to the right. Move a little toward the middle.' },
  headcut:   { kind: 'frame', text: () => 'The top of your head is cut off. Tilt the camera up a little.' },
  headroom:  { kind: 'frame', text: () => 'A lot of space above your head. Tilt the camera down a little.' },
  far:       { kind: 'frame', text: () => 'You look far away. Move closer or zoom in.' },
};
// while recording only these may show (quietly)
const DURING_TAKE = new Set(['battery', 'clipping', 'focus', 'noface', 'nosound']);
const SHOW_AFTER = 2500, CLEAR_AFTER = 2000; // a problem must last before it's shown; and be gone a while before it clears

export class AssistCore extends EventTarget {
  #cv = null; #cx = null; #face = null; #faceLoading = null;
  #seen = new Map(); #shown = null; #snoozed = new Map(); #batt = null;
  #rms = []; #peaks = []; #clips = [];
  recording = false;
  light = true;  // Lighting assistant: light, sound, battery (no download)
  frame = false; // Framing assistant: framing, headroom, focus, backlight (face detector)

  static async faceReady() {
    try { const c = await caches.open(CACHE); for (const f of Object.values(FILES)) if (!(await c.match(abs(f)))) return false; return true; } catch { return false; }
  }
  /** download the face detector (~10 MB) into Cache Storage; onProgress(0..1) */
  static async downloadFace(onProgress = () => {}) {
    const c = await caches.open(CACHE);
    const sizes = { js: 210000, wasm: 9424000, model: 230000 }, total = Object.values(sizes).reduce((a, b) => a + b, 0);
    let done = 0;
    for (const [k, f] of Object.entries(FILES)) {
      const res = await fetch(abs(f)); if (!res.ok) throw new Error('HTTP ' + res.status);
      const rd = res.body.getReader(), parts = []; let got = 0;
      for (;;) { const { done: end, value } = await rd.read(); if (end) break; parts.push(value); got += value.length; onProgress(Math.min(1, (done + got) / total)); }
      done += got;
      const type = k === 'js' ? 'text/javascript' : k === 'wasm' ? 'application/wasm' : 'application/octet-stream';
      await c.put(abs(f), new Response(new Blob(parts, { type }), { headers: { 'Content-Type': type } }));
    }
    try { navigator.storage?.persist?.(); } catch {}
    onProgress(1);
  }
  get faceOn() { return !!this.#face; }
  async loadFace() {
    if (this.#face) return true;
    if (this.#faceLoading) return this.#faceLoading;
    this.#faceLoading = (async () => {
      const c = await caches.open(CACHE);
      const get = async f => { const r = await c.match(abs(f)); if (!r) throw new Error('not downloaded'); return r; };
      const [js, wasm, model] = await Promise.all([get(FILES.js), get(FILES.wasm), get(FILES.model)]);
      const jsUrl = URL.createObjectURL(await js.blob()), wasmUrl = URL.createObjectURL(await wasm.blob());
      const { FaceDetector } = await import('./lib/mediapipe/vision_bundle.js' + (new URL(import.meta.url).search));
      this.#face = await FaceDetector.createFromOptions({ wasmLoaderPath: jsUrl, wasmBinaryPath: wasmUrl }, {
        baseOptions: { modelAssetBuffer: new Uint8Array(await model.arrayBuffer()) }, runningMode: 'IMAGE', minDetectionConfidence: 0.5,
      });
      return true;
    })().catch(e => { this.#faceLoading = null; throw e; });
    return this.#faceLoading;
  }

  /** mic meter values (dBFS) */
  audio({ rmsDb = -120, peakDb = -120, clip = false } = {}) {
    const now = performance.now();
    this.#rms.push([now, rmsDb]); this.#peaks.push([now, peakDb]); if (clip) this.#clips.push(now);
    const cut = now - 12000;
    while (this.#rms.length && this.#rms[0][0] < cut) this.#rms.shift();
    while (this.#peaks.length && this.#peaks[0][0] < cut) this.#peaks.shift();
    while (this.#clips.length && this.#clips[0] < now - 4000) this.#clips.shift();
  }
  battery(text) { this.#batt = text; }
  /** forget the audio history (mic switched off) */
  resetAudio() { this.#rms = []; this.#peaks = []; this.#clips = []; }
  /** ✕ on a tip: don't show that one again for a while */
  snooze(id, ms = 5 * 60000) { this.#snoozed.set(id, performance.now() + ms); this.#seen.delete(id); this.#publish(); }

  /** look at one preview frame; returns the problems found right now (ids) */
  analyze(src, { camera = 'mac' } = {}) {
    const now = performance.now(), found = new Set();
    // --- audio (needs ~8 s of history) ---
    if (this.light && this.#rms.length > 40 && now - this.#rms[0][0] > 8000 && now - this.#rms[this.#rms.length - 1][0] < 1500) { // mic on and live
      const r = this.#rms.map(x => x[1]).sort((a, b) => a - b), floor = r[Math.floor(r.length * 0.1)];
      const loudest = r[r.length - 1];
      // speaking = a good part of the last ~12 s clearly above the room (not a cough or a keyboard click)
      const voiced = this.#rms.filter(x => x[1] > floor + 15 && x[1] > -55).length / this.#rms.length;
      const speaking = voiced > 0.25;
      if (loudest < -85) found.add('nosound');                  // nothing at all: muted mic or the wrong input
      else if (!speaking && floor > -38) found.add('noisy');     // judged only while you're quiet, and only when it's really loud
      if (speaking) {
        const v = this.#peaks.filter((x, i) => this.#rms[i] && this.#rms[i][1] > floor + 15).map(x => x[1]).sort((a, b) => a - b);
        const speak = v.length ? v[Math.floor(v.length * 0.9)] : -120;
        if (speak > -70 && speak < -32) found.add('quiet');      // you're talking, but it comes in low
      }
    }
    if (this.light && this.#clips.length >= 2) found.add('clipping');
    // --- battery (Sony) ---
    const b = parseInt(String(this.#batt || '').replace(/[^\d]/g, ''), 10);
    if (this.light && camera === 'sony' && b > 0 && b <= 20) found.add('battery');
    // --- picture ---
    const w = src && (src.videoWidth || src.naturalWidth), hgt = src && (src.videoHeight || src.naturalHeight);
    let face = null;
    if (w && hgt) {
      const W = 192, H = Math.round(W * hgt / w);
      if (!this.#cv) { this.#cv = document.createElement('canvas'); this.#cx = this.#cv.getContext('2d', { willReadFrequently: true }); }
      this.#cv.width = W; this.#cv.height = H;
      try { this.#cx.drawImage(src, 0, 0, W, H); } catch { return this.#update(found, now); }
      const px = this.#cx.getImageData(0, 0, W, H).data, lum = new Float32Array(W * H);
      let sum = 0, white = 0;
      for (let i = 0, j = 0; i < px.length; i += 4, j++) { const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; lum[j] = l; sum += l; if (l >= 250) white++; }
      const mean = sum / lum.length;
      if (this.light && mean < 38) found.add('dark'); // the real camera frame (black and white / visibility only change the view behind the text)
      if (this.light && white / lum.length > 0.12) found.add('bright');
      // --- face (optional) ---
      if (this.frame && this.#face) {
        try {
          const d = this.#face.detect(this.#cv).detections || [];
          const best = d.sort((a, b) => (b.boundingBox.width * b.boundingBox.height) - (a.boundingBox.width * a.boundingBox.height))[0];
          if (best) face = best.boundingBox;
        } catch {}
        if (!face) { if (mean >= 38) found.add('noface'); }
        else {
          const cx = (face.originX + face.width / 2) / W, top = face.originY / H, fw = face.width / W;
          if (cx < 0.3) found.add('offleft'); else if (cx > 0.7) found.add('offright');
          if (top < 0.02) found.add('headcut'); else if (top > 0.33) found.add('headroom');
          if (fw < 0.09) found.add('far');
          // backlight: face much darker than the rest
          const box = { x0: Math.max(0, face.originX | 0), y0: Math.max(0, face.originY | 0), x1: Math.min(W, (face.originX + face.width) | 0), y1: Math.min(H, (face.originY + face.height) | 0) };
          let fs = 0, fn = 0; for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) { fs += lum[y * W + x]; fn++; }
          const faceLum = fn ? fs / fn : mean, bgLum = (sum - fs) / Math.max(1, lum.length - fn);
          if (bgLum - faceLum > 50 && bgLum > 120) found.add('backlit');
          // focus: sharpness (Laplacian energy) on the face vs the background
          const sharp = (x0, y0, x1, y1, inside) => { let s = 0, n = 0; for (let y = Math.max(1, y0); y < Math.min(H - 1, y1); y++) for (let x = Math.max(1, x0); x < Math.min(W - 1, x1); x++) { const k = y * W + x; const isIn = x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1; if (isIn !== inside) continue; const v = 4 * lum[k] - lum[k - 1] - lum[k + 1] - lum[k - W] - lum[k + W]; s += v * v; n++; } return n ? s / n : 0; };
          const fSharp = sharp(box.x0, box.y0, box.x1, box.y1, true), bSharp = sharp(0, 0, W, H, false);
          if (bSharp > 60 && fSharp < bSharp * 0.45) found.add('focus');
        }
      }
    }
    return this.#update(found, now);
  }

  #update(found, now) {
    for (const id of Object.keys(TIPS)) {
      const s = this.#seen.get(id);
      if (found.has(id)) { if (!s) this.#seen.set(id, { since: now, last: now }); else s.last = now; }
      else if (s && now - s.last > CLEAR_AFTER) this.#seen.delete(id);
    }
    this.#publish(now);
    return [...found];
  }
  #publish(now = performance.now()) {
    let pick = null;
    for (const id of Object.keys(TIPS)) {
      const s = this.#seen.get(id); if (!s || now - s.since < SHOW_AFTER) continue;
      if ((this.#snoozed.get(id) || 0) > now) continue;
      if (this.recording && !DURING_TAKE.has(id)) continue;
      pick = id; break;
    }
    const key = pick || '';
    if (key === (this.#shown || '')) return;
    this.#shown = pick;
    const t = pick && TIPS[pick];
    this.dispatchEvent(new CustomEvent('tip', { detail: t ? { id: pick, kind: t.kind, text: t.text(pick === 'battery' ? this.#batt : '') } : null }));
  }
}
