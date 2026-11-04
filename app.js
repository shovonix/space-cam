// Space Cam UI — everything camera-related lives in cam-core.js.
import { CamCore } from './cam-core.js';

const $ = id => document.getElementById(id);
const cam = new CamCore();
const LIMIT = CamCore.RECORD_LIMIT_S;
const WARN_AT = 29 * 60;
let mini = null; // Document Picture-in-Picture window, when open

const store = {
  get(k, d) { try { const v = localStorage.getItem('spaceCam.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('spaceCam.' + k, JSON.stringify(v)); } catch {} },
};

const ui = {
  stage: $('stage'), preview: $('preview'), grid: $('grid'), connectCard: $('connectCard'),
  pill: $('statusPill'), statusText: $('statusText'), info: $('info'),
  btnConnect: $('btnConnect'), btnDisconnect: $('btnDisconnect'), btnHelp: $('btnHelp'),
  btnRec: $('btnRec'), recLabel: $('recLabel'), recBadge: $('recBadge'), recTime: $('recTime'),
  btnAF: $('btnAF'), btnNear: $('btnNear'), btnFar: $('btnFar'), mfStep: $('mfStep'),
  btnGrid: $('btnGrid'), btnMini: $('btnMini'), fps: $('fps'), limitNote: $('limitNote'),
  problem: $('problem'), problemTitle: $('problemTitle'), problemBody: $('problemBody'),
  toast: $('toast'), help: $('help'),
};

// ---------- small helpers ----------
let toastTimer;
function toast(msg, kind = '') {
  ui.toast.textContent = msg; ui.toast.className = 'toast ' + kind; ui.toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (ui.toast.hidden = true), 3500);
}
const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
function wireCopyButtons(root) {
  root.querySelectorAll('button.copy').forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); const t = b.textContent; b.textContent = 'Copied'; setTimeout(() => (b.textContent = t), 1500); }
    catch { toast('Could not copy. Select the text instead.', 'error'); }
  });
}
function setupSteps() { return document.getElementById('setupTpl').content.cloneNode(true); }
$('helpSetup').append(setupSteps()); wireCopyButtons($('helpSetup'));

// ---------- state rendering ----------
function render() {
  const connected = cam.state === 'connected';
  ui.connectCard.hidden = connected;
  ui.preview.hidden = !connected;
  ui.info.hidden = !connected;
  ui.btnDisconnect.hidden = !connected;
  ui.btnConnect.disabled = cam.state === 'connecting' || cam.state === 'unsupported';
  ui.btnConnect.textContent = cam.state === 'connecting' ? 'Connecting…' : ui.btnConnect.dataset.retry ? 'Try again' : ui.btnConnect.dataset.known ? 'Reconnect camera' : 'Connect camera';

  ui.btnRec.disabled = !connected || !cam.has('record');
  ui.btnAF.disabled = !connected || !cam.has('af');
  ui.btnNear.disabled = ui.btnFar.disabled = ui.mfStep.disabled = !connected || !cam.has('mf');
  ui.btnGrid.disabled = !connected;
  ui.btnMini.disabled = !connected || !('documentPictureInPicture' in window);
  if (!('documentPictureInPicture' in window)) ui.btnMini.title = 'Mini window needs Chrome 116 or newer';

  ui.pill.className = 'pill' + (cam.recording ? ' rec' : connected ? ' ok' : cam.state === 'connecting' ? ' busy' : '');
  ui.statusText.textContent =
    cam.recording ? 'Recording' :
    connected ? `Connected${cam.model ? ' · ' + cam.model : ''}` :
    cam.state === 'connecting' ? 'Connecting…' :
    cam.state === 'unsupported' ? 'Needs Chrome' :
    cam.state === 'disconnected' ? 'Camera disconnected' : 'Not connected';

  ui.btnRec.classList.toggle('on', cam.recording);
  ui.recLabel.textContent = cam.recording ? 'Stop' : 'Record';
  ui.recBadge.hidden = !cam.recording;
  ui.stage.classList.toggle('recording', cam.recording);
  renderMini();
}

cam.addEventListener('state', e => {
  if (e.detail.state === 'connected') {
    ui.problem.hidden = true; delete ui.btnConnect.dataset.retry;
    buildStepOptions();
    cam.startPreview();
  }
  if (e.detail.state === 'disconnected') {
    ui.fps.textContent = '';
    showProblem('nodevice', 'The camera was unplugged or switched off', 'Plug it back in and connect again.');
    closeMini();
  }
  if (!e.detail.recording) stopTimer();
  render();
});

cam.addEventListener('error', e => {
  const { kind, message, detail } = e.detail;
  if (kind === 'cancelled') { toast('No camera chosen.'); return; }
  if (cam.state === 'connected') { toast(message, 'error'); return; }
  ui.btnConnect.dataset.retry = '1';
  showProblem(kind, message, detail);
  render();
});

cam.addEventListener('log', e => {
  const { message, level } = e.detail;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)('[Space Cam]', message);
});

cam.addEventListener('info', e => {
  const i = e.detail;
  const set = (id, v) => ($(id).textContent = v ?? '—');
  set('iInfoIso', i.iso); set('iInfoShutter', i.shutter);
  set('iInfoAperture', typeof i.aperture === 'string' ? i.aperture.replace(/^f\//, '') : i.aperture);
  set('iInfoFocus', i.focusMode); set('iInfoBattery', i.battery);
});

cam.addEventListener('stats', e => { ui.fps.textContent = `${e.detail.fps.toFixed(0)} fps`; });

let lastUrl = null;
cam.addEventListener('frame', e => {
  const url = URL.createObjectURL(e.detail.blob);
  ui.preview.src = url;
  if (mini) mini.img.src = url;
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = url;
});

function showProblem(kind, title, detail = '') {
  ui.problem.hidden = false;
  ui.problemTitle.textContent = title;
  ui.problemBody.replaceChildren();
  if (kind === 'unsupported') {
    ui.problemBody.innerHTML = '<p>Space Cam talks to the camera over USB, which only Chrome and Edge support. Open this page in Chrome on your Mac.</p>';
    return;
  }
  if (kind === 'nodevice') {
    const p = document.createElement('p');
    p.innerHTML = 'Check that the camera is <b>on</b>, the cable carries data (not charge-only), and <b>USB Connection</b> is set to <b>PC Remote</b>.';
    ui.problemBody.append(p);
  }
  ui.problemBody.append(setupSteps());
  if (detail) {
    const d = document.createElement('p'); d.className = 'fine'; d.textContent = 'Camera said: ' + detail;
    ui.problemBody.append(d);
  }
  wireCopyButtons(ui.problemBody);
}

// ---------- connect ----------
ui.btnConnect.onclick = async () => cam.connect({ pick: !(await cam.hasPermittedDevice()) });
ui.btnDisconnect.onclick = async () => {
  if (cam.recording && !(await confirmInline('Still recording. Stop recording first?'))) return;
  if (cam.recording) await cam.stopRecording();
  closeMini(); cam.disconnect(); toast('Camera released.');
};
// Inline confirm without blocking dialogs: second click within 3 s confirms.
let confirmArmed = 0;
function confirmInline(msg) {
  if (Date.now() - confirmArmed < 3000) { confirmArmed = 0; return Promise.resolve(true); }
  confirmArmed = Date.now(); toast(msg + ' Click again to confirm.'); return Promise.resolve(false);
}
(async () => {
  if (cam.state === 'unsupported') { showProblem('unsupported', "This browser can't control USB cameras"); render(); return; }
  if (await cam.hasPermittedDevice()) { ui.btnConnect.dataset.known = '1'; render(); }
})();

// ---------- record + timer ----------
let timer = null;
function startTimer() {
  stopTimer();
  const tick = () => {
    const s = cam.recordSeconds;
    ui.recTime.textContent = fmt(s);
    const warn = s >= WARN_AT;
    ui.recBadge.classList.toggle('warn', warn);
    ui.limitNote.hidden = !warn;
    if (warn) ui.limitNote.textContent = `The A7 III stops this clip at 29:59 — ${Math.max(0, LIMIT - s)} s left`;
    if (s >= LIMIT) {
      cam.markStoppedByCamera();
      ui.limitNote.hidden = false;
      ui.limitNote.textContent = 'Clip limit reached. Check the camera, then press R for a new clip.';
      setTimeout(() => (ui.limitNote.hidden = true), 10000);
    }
    renderMini();
  };
  tick(); timer = setInterval(tick, 250);
}
function stopTimer() { clearInterval(timer); timer = null; ui.recBadge.classList.remove('warn'); if (!cam.recording) ui.recTime.textContent = '00:00'; }

let recBusy = false;
async function toggleRec() {
  if (recBusy || ui.btnRec.disabled) return;
  recBusy = true;
  const was = cam.recording;
  const ok = await cam.toggleRecording();
  recBusy = false;
  if (!ok) return;
  if (cam.recording) { ui.limitNote.hidden = true; startTimer(); }
  else { stopTimer(); toast('Recording stopped. The clip is on the camera card.', 'ok'); setTimeout(() => cam.refreshInfo(), 800); }
  render();
}
ui.btnRec.onclick = toggleRec;
window.addEventListener('beforeunload', e => { if (cam.recording) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('pagehide', () => { if (cam.state === 'connected') cam.disconnect(); });

// ---------- focus ----------
let afHeld = false;
async function afDown() { if (afHeld || ui.btnAF.disabled) return; afHeld = true; setHeld(true); await cam.afPress(); }
async function afUp()   { if (!afHeld) return; afHeld = false; setHeld(false); await cam.afRelease(); }
function setHeld(on) { ui.btnAF.classList.toggle('held', on); if (mini) mini.af.classList.toggle('held', on); }
ui.btnAF.addEventListener('pointerdown', afDown);
ui.btnAF.addEventListener('pointerup', afUp);
ui.btnAF.addEventListener('pointerleave', afUp);

function buildStepOptions() {
  const r = cam.focusRange || { min: -7, max: 7 };
  const max = Math.min(7, Math.max(Math.abs(r.min), Math.abs(r.max)) || 1);
  ui.mfStep.replaceChildren(...Array.from({ length: max }, (_, i) => new Option(`Step ${i + 1}`, i + 1)));
  ui.mfStep.value = String(Math.min(max, store.get('mfStep', 1)));
}
ui.mfStep.onchange = () => store.set('mfStep', Number(ui.mfStep.value));
const focusBy = dir => { if (!ui.btnNear.disabled) cam.focusStep(dir * Number(ui.mfStep.value || 1)); };
ui.btnNear.onclick = () => focusBy(-1);
ui.btnFar.onclick = () => focusBy(1);

// ---------- grid ----------
function setGrid(on) {
  ui.grid.hidden = !on; ui.btnGrid.setAttribute('aria-pressed', String(on)); store.set('grid', on);
  if (mini) mini.grid.hidden = !on;
}
ui.btnGrid.onclick = () => setGrid(ui.grid.hidden);
setGrid(store.get('grid', false));

// ---------- mini window (Document Picture-in-Picture) ----------
async function openMini() {
  if (mini) { closeMini(); return; }
  if (!('documentPictureInPicture' in window) || cam.state !== 'connected') return;
  let w;
  try { w = await documentPictureInPicture.requestWindow({ width: 420, height: 300 }); }
  catch (e) { toast('Could not open the mini window: ' + (e?.message || e), 'error'); return; }
  document.querySelectorAll('link[rel="stylesheet"]').forEach(l => w.document.head.append(l.cloneNode()));
  w.document.title = 'Space Cam';
  w.document.body.className = 'mini';
  w.document.body.innerHTML = `
    <div class="mini-stage"><img alt=""><div class="grid" hidden><i></i><i></i><i></i><i></i></div>
      <span class="rec-badge" hidden><i></i><span>00:00</span></span></div>
    <div class="mini-bar">
      <button class="af" title="Hold to focus (F)">Focus</button>
      <button class="near" title="Focus nearer (←)">◀</button>
      <button class="rec" title="Record (R)"><i></i><span>Record</span></button>
      <button class="far" title="Focus farther (→)">▶</button>
    </div>`;
  const q = s => w.document.querySelector(s);
  mini = { w, img: q('.mini-stage img'), grid: q('.grid'), badge: q('.rec-badge'), time: q('.rec-badge span'),
           rec: q('button.rec'), recLabel: q('button.rec span'), af: q('button.af'), near: q('button.near'), far: q('button.far') };
  mini.img.src = ui.preview.src;
  mini.grid.hidden = ui.grid.hidden;
  mini.rec.onclick = toggleRec;
  mini.af.addEventListener('pointerdown', afDown);
  mini.af.addEventListener('pointerup', afUp);
  mini.af.addEventListener('pointerleave', afUp);
  mini.near.onclick = () => focusBy(-1);
  mini.far.onclick = () => focusBy(1);
  mini.near.disabled = mini.far.disabled = !cam.has('mf');
  w.document.addEventListener('keydown', onKeyDown);
  w.document.addEventListener('keyup', onKeyUp);
  w.addEventListener('pagehide', () => { mini = null; ui.btnMini.setAttribute('aria-pressed', 'false'); });
  ui.btnMini.setAttribute('aria-pressed', 'true');
  renderMini();
}
function closeMini() { if (mini) { mini.w.close(); mini = null; } ui.btnMini.setAttribute('aria-pressed', 'false'); }
function renderMini() {
  if (!mini) return;
  mini.rec.classList.toggle('on', cam.recording);
  mini.recLabel.textContent = cam.recording ? 'Stop' : 'Record';
  mini.badge.hidden = !cam.recording;
  mini.badge.classList.toggle('warn', cam.recordSeconds >= WARN_AT);
  mini.time.textContent = fmt(cam.recordSeconds);
}
ui.btnMini.onclick = openMini;

// ---------- help ----------
ui.btnHelp.onclick = () => ui.help.showModal();

// ---------- keyboard ----------
function typing(e) { const t = e.target; return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); }
function onKeyDown(e) {
  if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === '?' ) { e.preventDefault(); ui.help.open ? ui.help.close() : ui.help.showModal(); return; }
  if (cam.state !== 'connected') return;
  if (e.repeat && k.toLowerCase() !== 'arrowleft' && k.toLowerCase() !== 'arrowright') return;
  switch (k.toLowerCase()) {
    case 'r': e.preventDefault(); toggleRec(); break;
    case 'f': e.preventDefault(); afDown(); break;
    case 'arrowleft': e.preventDefault(); focusBy(-1); break;
    case 'arrowright': e.preventDefault(); focusBy(1); break;
    case 'g': e.preventDefault(); setGrid(ui.grid.hidden); break;
    case 'm': e.preventDefault(); openMini(); break;
  }
}
function onKeyUp(e) { if (e.key.toLowerCase() === 'f') afUp(); }
document.addEventListener('keydown', onKeyDown);
document.addEventListener('keyup', onKeyUp);

// Refresh exposure / battery once a minute while idle.
setInterval(() => { if (cam.state === 'connected' && !cam.recording) cam.refreshInfo(); }, 60000);

render();
