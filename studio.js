// studio.js — adds camera control, audio recording and takes to the Space Cam prompter page.
// The prompter itself (scripts, stage window, controls) is the page's own code; this file only
// adds panels and talks to the camera / audio engines.
import { CamCore } from './cam-core.js';
import { AudioCore } from './audio-core.js';

// The stage window (#stage) and its mini preview (#stage-preview) are plain prompter views.
if (!/^#stage/.test(location.hash)) init();

function init() {
  const $ = id => document.getElementById(id);
  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('spaceCam.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('spaceCam.' + k, JSON.stringify(v)); } catch {} },
  };
  const pad = n => String(n).padStart(2, '0');
  const fmt = s => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  const LIMIT = CamCore.RECORD_LIMIT_S, WARN_AT = 29 * 60;

  const cam = new CamCore();
  const audio = new AudioCore();

  // ------------------------------------------------------------------ markup
  const camSec = h(`
  <div class="sec sc-sec" id="scCamSec">
    <div class="sec-title"><span>Camera</span><span class="sc-state" id="scCamState">off</span></div>
    <div class="sc-preview" id="scPreview">
      <img id="scImg" alt="Live camera preview" hidden>
      <div class="sc-grid" id="scGrid" hidden><i></i><i></i><i></i><i></i></div>
      <span class="sc-badge" id="scBadge" hidden><i></i><span id="scBadgeTime">00:00</span></span>
      <span class="sc-fps" id="scFps"></span>
      <div class="sc-empty" id="scCamEmpty">
        <button type="button" class="btn primary" id="scConnect">Connect camera</button>
        <small>USB · PC Remote · Chrome on Mac</small>
      </div>
    </div>
    <div class="sc-info" id="scInfo" hidden></div>
    <div class="tpair three sc-focus">
      <button type="button" class="tbtn" id="scAF" disabled title="Hold to autofocus"><span>Focus</span><kbd>A</kbd></button>
      <button type="button" class="tbtn" id="scNear" disabled title="Manual focus nearer (camera on MF)"><span>Near</span><kbd>←</kbd></button>
      <button type="button" class="tbtn" id="scFar" disabled title="Manual focus farther (camera on MF)"><span>Far</span><kbd>→</kbd></button>
    </div>
    <div class="slider-group">
      <div class="slider-label"><span>Focus step</span><span id="scStepVal">1</span></div>
      <input type="range" id="scStep" min="1" max="7" step="1" value="1" disabled>
    </div>
    <div class="tpair">
      <button type="button" class="tbtn" id="scGridBtn" aria-pressed="false" disabled><span>Grid</span><kbd>G</kbd></button>
      <button type="button" class="tbtn" id="scBig" disabled title="Large floating preview window"><span>Big preview</span></button>
    </div>
    <button type="button" class="sc-link" id="scDisconnect" hidden>Disconnect camera</button>
    <div class="sc-problem" id="scProblem" hidden></div>
  </div>`);

  const audioSec = h(`
  <div class="sec sc-sec" id="scAudioSec">
    <div class="sec-title"><span>Audio</span><span class="sc-state" id="scMicState">off</span></div>
    <button type="button" class="tbtn sc-wide" id="scMicOn"><span>Enable microphone</span></button>
    <select class="sc-select" id="scMic" hidden aria-label="Microphone"></select>
    <div class="sc-meter" id="scMeterWrap" hidden>
      <div class="sc-meter-bar"><i id="scMeterFill"></i><b id="scMeterPeak"></b></div>
      <div class="sc-meter-label"><span id="scDb">−∞ dB</span><span class="sc-clip" id="scClip">CLIP</span></div>
    </div>
    <div class="sc-folder">
      <div class="sc-folder-row"><span>Save to</span><b id="scFolderName">Not chosen</b></div>
      <button type="button" class="tbtn sc-wide" id="scFolderBtn"><span>Choose folder</span></button>
    </div>
    <div class="caption">WAV, 24-bit at the mic's rate (usually 48 kHz). Kept safe in the browser while recording, then moved to your folder.</div>
  </div>`);

  const recBtn = h(`<button type="button" class="cap-side sc-rec" id="scRec" aria-label="Record camera and audio — key R"><i></i><span id="scRecLabel">Record</span></button>`);
  const takesSec = h(`
  <div class="sec sc-sec sc-takes" id="scTakesSec">
    <div class="scripts-head"><div class="sec-title">Takes</div><button type="button" class="sc-mini-btn" id="scSaveAll" hidden>Save all</button></div>
    <div id="scTakeList"><div class="sc-none">No takes yet. Press <kbd>R</kbd> to record.</div></div>
  </div>`);
  const toastEl = h(`<div class="sc-toast" id="scToast" hidden></div>`);

  const rightRail = $('right-rail'), utility = $('utility');
  utility.after(camSec); camSec.after(audioSec);
  const play = $('play');
  play.after(recBtn); play.after(h(`<span class="cap-div"></span>`));
  const leftSpacer = document.querySelector('#left-rail .rail-spacer');
  leftSpacer.before(takesSec);
  document.body.append(toastEl);
  const hint = $('shortcuts-hint');
  if (hint) [['R', 'record camera + audio'], ['A', 'hold to autofocus'], ['← →', 'focus near / far (MF)'], ['G', 'grid']]
    .forEach(([k, t]) => hint.append(h(`<span>${k.split(' ').map(x => `<kbd>${x}</kbd>`).join('')} ${t}</span>`)));

  const ui = {
    camState: $('scCamState'), img: $('scImg'), grid: $('scGrid'), badge: $('scBadge'), badgeTime: $('scBadgeTime'),
    fps: $('scFps'), empty: $('scCamEmpty'), connect: $('scConnect'), info: $('scInfo'), af: $('scAF'), near: $('scNear'),
    far: $('scFar'), step: $('scStep'), stepVal: $('scStepVal'), gridBtn: $('scGridBtn'), big: $('scBig'),
    disconnect: $('scDisconnect'), problem: $('scProblem'), preview: $('scPreview'),
    micState: $('scMicState'), micOn: $('scMicOn'), mic: $('scMic'), meterWrap: $('scMeterWrap'), meterFill: $('scMeterFill'),
    meterPeak: $('scMeterPeak'), db: $('scDb'), clip: $('scClip'), folderName: $('scFolderName'), folderBtn: $('scFolderBtn'),
    rec: recBtn, recLabel: $('scRecLabel'), takeList: $('scTakeList'), saveAll: $('scSaveAll'),
  };

  // ------------------------------------------------------------------ toast
  let toastT;
  function toast(msg, kind = '') {
    toastEl.textContent = msg; toastEl.className = 'sc-toast ' + kind; toastEl.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (toastEl.hidden = true), 4200);
  }

  // ------------------------------------------------------------------ camera
  let lastUrl = null, big = null;
  function renderCam() {
    const on = cam.state === 'connected';
    ui.empty.hidden = on; ui.img.hidden = !on; ui.info.hidden = !on; ui.disconnect.hidden = !on;
    ui.connect.disabled = cam.state === 'connecting' || cam.state === 'unsupported';
    ui.connect.textContent = cam.state === 'connecting' ? 'Connecting…' : ui.connect.dataset.retry ? 'Try again' : 'Connect camera';
    ui.af.disabled = !on || !cam.has('af');
    ui.near.disabled = ui.far.disabled = ui.step.disabled = !on || !cam.has('mf');
    ui.gridBtn.disabled = ui.big.disabled = !on;
    if (!('documentPictureInPicture' in window)) { ui.big.disabled = true; ui.big.title = 'Needs Chrome 116 or newer'; }
    ui.camState.textContent = cam.recording ? 'recording' : on ? (cam.model || 'connected') : cam.state === 'connecting' ? 'connecting' : cam.state === 'unsupported' ? 'needs Chrome' : 'off';
    ui.camState.className = 'sc-state' + (cam.recording ? ' rec' : on ? ' on' : '');
    if (!on) ui.fps.textContent = '';
  }
  cam.addEventListener('state', e => {
    if (e.detail.state === 'connected') { ui.problem.hidden = true; delete ui.connect.dataset.retry; cam.startPreview(); }
    if (e.detail.state === 'disconnected') { showCamProblem('nodevice', 'Camera unplugged or switched off.'); closeBig(); if (take) toast('Camera disconnected during the take.', 'error'); }
    renderCam(); renderRec();
  });
  cam.addEventListener('error', e => {
    const { kind, message, detail } = e.detail;
    if (kind === 'cancelled') return toast('No camera chosen.');
    if (cam.state === 'connected') return toast(message, 'error');
    ui.connect.dataset.retry = '1'; showCamProblem(kind, message, detail); renderCam();
  });
  cam.addEventListener('log', e => { const { message, level } = e.detail; (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)('[Space Cam]', message); });
  cam.addEventListener('stats', e => (ui.fps.textContent = `${e.detail.fps.toFixed(0)} fps`));
  cam.addEventListener('info', e => {
    const i = e.detail, ap = typeof i.aperture === 'string' ? i.aperture.replace(/^f\//, 'f/') : i.aperture;
    ui.info.innerHTML = [i.iso && `ISO <b>${i.iso}</b>`, i.shutter && `<b>${i.shutter}</b>`, ap && `<b>${ap}</b>`, i.focusMode && `<b>${i.focusMode}</b>`, i.battery && `🔋 <b>${i.battery}</b>`].filter(Boolean).join('<i>·</i>');
  });
  cam.addEventListener('frame', e => {
    const url = URL.createObjectURL(e.detail.blob);
    ui.img.src = url; if (big) big.img.src = url;
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = url;
  });

  const SETUP_FIX = `
    <ol>
      <li>Close other tabs that use the camera. Quit Imaging Edge, Photos and Image Capture.</li>
      <li>Unplug the camera, turn it off and on, plug it back in, then <b>Try again</b>.</li>
      <li>Still stuck? macOS's camera service grabs it first. Paste in Terminal, keep it open while connecting, stop with <kbd>Ctrl</kbd>+<kbd>C</kbd> once connected:
        <div class="sc-cmd"><code>while true; do killall -9 ptpcamerad 2&gt;/dev/null; sleep 0.5; done</code><button type="button" data-copy="while true; do killall -9 ptpcamerad 2>/dev/null; sleep 0.5; done">Copy</button></div>
        Permanent (try once, then restart the Mac; Photos/Image Capture can't import from cameras while off):
        <div class="sc-cmd"><code>launchctl disable gui/$UID/com.apple.ptpcamerad</code><button type="button" data-copy="launchctl disable gui/$UID/com.apple.ptpcamerad">Copy</button></div>
        <small>Undo: <code>launchctl enable gui/$UID/com.apple.ptpcamerad</code></small>
      </li>
    </ol>`;
  function showCamProblem(kind, title, detail = '') {
    ui.problem.hidden = false;
    if (kind === 'unsupported') { ui.problem.innerHTML = `<b>${title}</b><p>Open Space Cam in Chrome or Edge on a Mac to control the camera.</p>`; return; }
    ui.problem.innerHTML = `<b>${title}</b>${kind === 'nodevice' ? '<p>Camera on, data cable (not charge-only), USB Connection → <b>PC Remote</b>, Ctrl w/ Smartphone → Off.</p>' : ''}${SETUP_FIX}${detail ? `<small>Camera said: ${detail.replace(/</g, '&lt;')}</small>` : ''}`;
    ui.problem.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1500); } catch { toast('Could not copy.', 'error'); }
    });
  }
  if (cam.state === 'unsupported') showCamProblem('unsupported', "This browser can't control USB cameras.");

  ui.connect.onclick = async () => cam.connect({ pick: !(await cam.hasPermittedDevice()) });
  ui.disconnect.onclick = () => {
    if (cam.recording) return toast('Stop recording first.', 'error');
    closeBig(); cam.disconnect(); toast('Camera released.');
  };

  // focus
  let afHeld = false;
  async function afDown() { if (afHeld || ui.af.disabled) return; afHeld = true; ui.af.classList.add('held'); big?.af.classList.add('held'); await cam.afPress(); }
  async function afUp() { if (!afHeld) return; afHeld = false; ui.af.classList.remove('held'); big?.af.classList.remove('held'); await cam.afRelease(); }
  ui.af.addEventListener('pointerdown', afDown); ui.af.addEventListener('pointerup', afUp); ui.af.addEventListener('pointerleave', afUp);
  ui.step.value = store.get('mfStep', 1); ui.stepVal.textContent = ui.step.value;
  ui.step.oninput = () => { ui.stepVal.textContent = ui.step.value; store.set('mfStep', Number(ui.step.value)); };
  const focusBy = dir => { if (!ui.near.disabled) cam.focusStep(dir * Number(ui.step.value || 1)); };
  ui.near.onclick = () => focusBy(-1); ui.far.onclick = () => focusBy(1);

  // grid
  function setGrid(on) { ui.grid.hidden = !on; ui.gridBtn.setAttribute('aria-pressed', String(on)); store.set('grid', on); if (big) big.grid.hidden = !on; }
  ui.gridBtn.onclick = () => setGrid(ui.grid.hidden);
  setGrid(store.get('grid', false));

  // big floating preview (Document Picture-in-Picture)
  async function openBig() {
    if (big) return closeBig();
    let w;
    try { w = await documentPictureInPicture.requestWindow({ width: 760, height: 470 }); }
    catch (e) { return toast('Could not open the big preview: ' + (e?.message || e), 'error'); }
    document.querySelectorAll('link[rel="stylesheet"][href="studio.css"]').forEach(l => w.document.head.append(l.cloneNode()));
    w.document.title = 'Space Cam · preview';
    w.document.body.className = 'sc-big';
    w.document.body.innerHTML = `
      <div class="sc-big-stage"><img alt=""><div class="sc-grid" hidden><i></i><i></i><i></i><i></i></div>
        <span class="sc-badge" hidden><i></i><span>00:00</span></span></div>
      <div class="sc-big-bar"><button class="af">Focus (A)</button><button class="near">◀ Near</button>
        <button class="rec"><i></i><span>Record</span></button><button class="far">Far ▶</button></div>`;
    const q = s => w.document.querySelector(s);
    big = { w, img: q('img'), grid: q('.sc-grid'), badge: q('.sc-badge'), time: q('.sc-badge span'), rec: q('.rec'), recLabel: q('.rec span'), af: q('.af'), near: q('.near'), far: q('.far') };
    big.img.src = ui.img.src; big.grid.hidden = ui.grid.hidden;
    big.rec.onclick = toggleTake;
    big.af.addEventListener('pointerdown', afDown); big.af.addEventListener('pointerup', afUp); big.af.addEventListener('pointerleave', afUp);
    big.near.onclick = () => focusBy(-1); big.far.onclick = () => focusBy(1);
    big.near.disabled = big.far.disabled = !cam.has('mf');
    w.document.addEventListener('keydown', onKeyDown); w.document.addEventListener('keyup', onKeyUp);
    w.addEventListener('pagehide', () => { big = null; ui.big.setAttribute('aria-pressed', 'false'); });
    ui.big.setAttribute('aria-pressed', 'true');
    renderRec();
  }
  function closeBig() { if (big) { big.w.close(); big = null; } ui.big.setAttribute('aria-pressed', 'false'); }
  ui.big.onclick = openBig;

  // ------------------------------------------------------------------ audio
  async function fillMics() {
    const devs = await audio.listDevices();
    ui.mic.replaceChildren(...devs.map(d => new Option(d.label, d.id)));
    if (audio.deviceId) ui.mic.value = audio.deviceId;
  }
  audio.addEventListener('devices', fillMics);
  audio.addEventListener('state', e => renderMic());
  audio.addEventListener('error', e => toast(e.detail.message, 'error'));
  let peakHold = -120, peakHoldT = 0, shown = -120, shownT = performance.now();
  audio.addEventListener('level', e => {
    const { clip } = e.detail;
    const now0 = performance.now();
    // meter ballistics: instant attack, ~24 dB/s release, so short peaks stay readable
    const fall = shown - 24 * (now0 - shownT) / 1000;
    shown = Math.max(e.detail.peakDb, fall, -120); shownT = now0;
    const peakDb = shown;
    const pct = Math.max(0, Math.min(100, (peakDb + 60) / 60 * 100));
    ui.meterFill.style.width = pct + '%';
    const now = performance.now();
    if (peakDb > peakHold || now - peakHoldT > 1500) { peakHold = peakDb; peakHoldT = now; }
    ui.meterPeak.style.left = Math.max(0, Math.min(100, (peakHold + 60) / 60 * 100)) + '%';
    ui.db.textContent = peakDb <= -119 ? '−∞ dB' : `${peakDb.toFixed(0)} dB`;
    ui.clip.classList.toggle('on', clip);
  });
  function renderMic() {
    const on = audio.state !== 'off';
    ui.micOn.hidden = on; ui.mic.hidden = !on; ui.meterWrap.hidden = !on;
    ui.micState.textContent = audio.state === 'recording' ? 'recording' : on ? 'ready' : 'off';
    ui.micState.className = 'sc-state' + (audio.state === 'recording' ? ' rec' : on ? ' on' : '');
    ui.mic.disabled = audio.state === 'recording';
  }
  async function openMic(id) {
    const ok = await audio.open(id ?? store.get('micId', ''));
    if (ok) { store.set('micId', audio.deviceId); await fillMics(); }
    renderRec();
  }
  ui.micOn.onclick = () => openMic();
  ui.mic.onchange = () => openMic(ui.mic.value);
  if (!AudioCore.supported) { ui.micOn.disabled = true; ui.micOn.querySelector('span').textContent = 'Audio needs Chrome'; }
  // Re-open the mic automatically if permission was already given in an earlier visit.
  navigator.permissions?.query({ name: 'microphone' }).then(p => { if (p.state === 'granted' && AudioCore.supported) openMic(); }).catch(() => {});

  // save folder (File System Access), remembered in IndexedDB
  const idb = {
    db: null,
    async open() { if (this.db) return this.db; this.db = await new Promise((res, rej) => { const r = indexedDB.open('spaceCam', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); return this.db; },
    async get(k) { const db = await this.open(); return new Promise(res => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); },
    async set(k, v) { const db = await this.open(); return new Promise(res => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; }); },
  };
  let folder = null;
  async function folderOk(ask) {
    if (!folder) return false;
    let p = await folder.queryPermission({ mode: 'readwrite' });
    if (p === 'prompt' && ask) { try { p = await folder.requestPermission({ mode: 'readwrite' }); } catch {} }
    return p === 'granted';
  }
  async function renderFolder() {
    const ok = await folderOk(false);
    ui.folderName.textContent = folder ? folder.name + (ok ? '' : ' (click to allow)') : 'Not chosen — save after the shoot';
    ui.folderBtn.querySelector('span').textContent = folder ? (ok ? 'Change folder' : 'Allow access') : 'Choose folder';
  }
  ui.folderBtn.onclick = async () => {
    if (!window.showDirectoryPicker) return toast('Choosing a folder needs Chrome or Edge.', 'error');
    if (folder && !(await folderOk(false))) { await folderOk(true); return renderFolder(); }
    try { folder = await showDirectoryPicker({ id: 'spacecam-takes', mode: 'readwrite' }); await idb.set('folder', folder); }
    catch (e) { if (e?.name !== 'AbortError') toast('Could not use that folder: ' + (e?.message || e), 'error'); }
    renderFolder(); flushWaiting();
  };
  idb.get('folder').then(f => { folder = f || null; renderFolder(); }).catch(() => renderFolder());

  // ------------------------------------------------------------------ takes
  let takes = store.get('takes', []);
  let take = null, timer = null, wake = null, busy = false;
  const saveTakes = () => store.set('takes', takes.slice(-200));

  function takeName(no, d = new Date()) {
    return `Take-${pad(no)}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.wav`;
  }
  function nextNo() {
    const today = new Date().toDateString();
    return takes.filter(t => new Date(t.startedAt).toDateString() === today).reduce((m, t) => Math.max(m, t.no || 0), 0) + 1;
  }

  function renderTakes() {
    const list = takes.slice().reverse();
    ui.saveAll.hidden = !takes.some(t => t.audio === 'browser');
    if (!list.length) { ui.takeList.innerHTML = '<div class="sc-none">No takes yet. Press <kbd>R</kbd> to record.</div>'; return; }
    ui.takeList.replaceChildren(...list.map(t => {
      const when = new Date(t.startedAt);
      const el = h(`<div class="sc-take${t.recovered ? ' recovered' : ''}">
        <div class="sc-take-top"><b>${t.recovered ? 'Recovered' : 'Take ' + pad(t.no)}</b><span>${t.seconds != null ? fmt(t.seconds) : '—'}</span></div>
        <div class="sc-take-sub">${pad(when.getHours())}:${pad(when.getMinutes())} · ${t.camera ? 'clip on camera card' : 'no camera'} · ${
          t.audio === 'folder' ? 'audio in ' + (t.folderName || 'folder') : t.audio === 'saved' ? 'audio saved' : t.audio === 'browser' ? '<em>audio not saved yet</em>' : 'no audio'}</div>
        <div class="sc-take-actions"></div></div>`);
      const actions = el.querySelector('.sc-take-actions');
      if (t.audio === 'browser') {
        const save = h(`<button type="button">Save audio</button>`); save.onclick = () => saveTake(t); actions.append(save);
        const del = h(`<button type="button" class="danger">Delete</button>`);
        del.onclick = async () => {
          if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Sure?'; setTimeout(() => { del.dataset.armed = ''; del.textContent = 'Delete'; }, 3000); return; }
          await audio.deleteStored(t.name).catch(() => {}); takes = takes.filter(x => x !== t); saveTakes(); renderTakes();
        };
        actions.append(del);
      }
      el.title = t.name || '';
      return el;
    }));
  }

  async function saveTake(t) {
    try {
      if (await folderOk(true)) { await audio.moveToFolder(t.name, folder); t.audio = 'folder'; t.folderName = folder.name; }
      else { await audio.saveAs(t.name); t.audio = 'saved'; }
      delete t.recovered; saveTakes(); renderTakes(); toast(`${t.name} saved.`, 'ok');
    } catch (e) { if (e?.name !== 'AbortError') toast('Could not save: ' + (e?.message || e), 'error'); }
  }
  ui.saveAll.onclick = async () => { for (const t of takes.filter(t => t.audio === 'browser')) await saveTake(t); };
  async function flushWaiting() {
    if (!(await folderOk(false))) return;
    for (const t of takes.filter(t => t.audio === 'browser' && !t.recovered)) await saveTake(t);
  }

  // Takes left in browser storage by a crash or an unsaved session
  if (AudioCore.supported) audio.listStored().then(files => {
    const known = new Set(takes.map(t => t.name));
    let added = 0;
    for (const f of files) if (!known.has(f.name)) { takes.push({ name: f.name, startedAt: f.modified, audio: 'browser', recovered: true, seconds: null }); added++; }
    takes.forEach(t => { if (t.audio === 'browser' && !files.some(f => f.name === t.name)) t.audio = 'none'; });
    if (added) toast(`${added} unsaved audio take${added > 1 ? 's' : ''} recovered. Save from the Takes list.`);
    saveTakes(); renderTakes();
  }).catch(() => renderTakes()); else renderTakes();

  // ------------------------------------------------------------------ record (camera + audio together)
  function renderRec() {
    const recording = !!take;
    const armed = cam.state === 'connected' || audio.state !== 'off';
    ui.rec.classList.toggle('on', recording);
    ui.rec.classList.toggle('unarmed', !armed && !recording);
    ui.rec.title = armed ? 'Record camera + audio (R)' : 'Connect the camera or enable a microphone first';
    const s = take ? Math.floor((Date.now() - take.startedAt) / 1000) : 0;
    ui.recLabel.textContent = recording ? fmt(s) : 'Record';
    ui.badge.hidden = !recording; ui.badgeTime.textContent = fmt(s);
    const warn = recording && s >= WARN_AT && take.camera;
    ui.badge.classList.toggle('warn', warn); ui.rec.classList.toggle('warn', warn);
    if (big) { big.rec.classList.toggle('on', recording); big.recLabel.textContent = recording ? fmt(s) : 'Record'; big.badge.hidden = !recording; big.time.textContent = fmt(s); big.badge.classList.toggle('warn', warn); }
    renderCam(); renderMic();
  }

  async function startTake() {
    const camOk = cam.state === 'connected' && cam.has('record');
    const micOk = audio.state === 'ready';
    if (!camOk && !micOk) return toast('Connect the camera or enable a microphone first.', 'error');
    if (micOk && folder) await folderOk(true); // ask once while we still have the key press / click
    const no = nextNo(), started = new Date(), name = takeName(no, started);
    const [a, c] = await Promise.all([micOk ? audio.startRecording(name) : false, camOk ? cam.startRecording() : false]);
    if (!a && !c) return toast('Recording did not start. Check the camera and microphone.', 'error');
    if (camOk && !c) toast('Camera did not start recording. Audio is recording.', 'error');
    if (micOk && !a) toast('Audio did not start. Camera is recording.', 'error');
    take = { no, name: a ? name : null, startedAt: started.getTime(), camera: !!c, audio: a ? 'recording' : 'none' };
    try { wake = await navigator.wakeLock?.request('screen'); } catch {}
    timer = setInterval(tick, 250); tick();
  }

  async function stopTake(reason = '') {
    if (!take) return;
    const t = take; take = null; clearInterval(timer); timer = null;
    try { await wake?.release(); } catch {} wake = null;
    const [a] = await Promise.all([t.audio === 'recording' ? audio.stopRecording() : null, cam.recording ? cam.stopRecording() : null]);
    t.seconds = Math.round((Date.now() - t.startedAt) / 1000);
    if (t.audio === 'recording') {
      t.audio = a ? 'browser' : 'none';
      if (a && await folderOk(false)) {
        try { await audio.moveToFolder(t.name, folder); t.audio = 'folder'; t.folderName = folder.name; }
        catch (e) { toast('Audio kept in the browser — could not write to the folder: ' + (e?.message || e), 'error'); }
      }
    }
    takes.push(t); saveTakes(); renderTakes(); renderRec();
    const parts = [t.camera && 'clip on the camera card', t.audio === 'folder' && `audio in “${t.folderName}”`, t.audio === 'browser' && 'audio waiting in Takes (choose a folder or Save)'].filter(Boolean);
    toast(`${reason || `Take ${pad(t.no)} done`} — ${parts.join(', ') || 'nothing recorded'}.`, t.audio === 'browser' ? '' : 'ok');
    setTimeout(() => cam.refreshInfo(), 800);
  }

  function tick() {
    if (!take) return;
    const s = Math.floor((Date.now() - take.startedAt) / 1000);
    if (take.camera && s >= LIMIT) { cam.markStoppedByCamera(); stopTake('Clip limit 29:59 reached'); return; }
    if (take.camera && s === WARN_AT) toast('The A7 III stops the clip at 29:59 — one minute left.');
    renderRec();
  }

  async function toggleTake() {
    if (busy) return;
    busy = true;
    try { take ? await stopTake() : await startTake(); } finally { busy = false; renderRec(); }
  }
  ui.rec.onclick = () => { ui.rec.blur(); toggleTake(); };
  window.addEventListener('beforeunload', e => { if (take) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('pagehide', () => { if (cam.state === 'connected') cam.disconnect(); });

  // ------------------------------------------------------------------ keys (prompter keys stay as they are)
  const typing = e => { const t = e.target; return t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type !== 'range')); };
  function onKeyDown(e) {
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'r') { e.preventDefault(); if (!e.repeat) toggleTake(); }
    else if (k === 'a') { e.preventDefault(); if (!e.repeat) afDown(); }
    else if (k === 'arrowleft' || k === 'arrowright') { if (cam.state === 'connected' && cam.has('mf')) { e.preventDefault(); focusBy(k === 'arrowleft' ? -1 : 1); } }
    else if (k === 'g') { if (cam.state === 'connected') { e.preventDefault(); setGrid(ui.grid.hidden); } }
  }
  function onKeyUp(e) { if (e.key.toLowerCase() === 'a') afUp(); }
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  setInterval(() => { if (cam.state === 'connected' && !take) cam.refreshInfo(); }, 60000);
  renderCam(); renderMic(); renderRec();
}
