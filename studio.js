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

  // Hard reload (Cmd+Shift+R) = start fully disconnected. A normal reload reconnects camera and mic.
  const hardReload = sessionStorage.getItem('spaceCamHardReload') === '1';
  sessionStorage.removeItem('spaceCamHardReload');
  if (hardReload) { store.set('camAuto', false); store.set('micAuto', false); }
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
    <details class="sc-help" id="scHelp"></details>
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
    <button type="button" class="sc-link" id="scMicOff" hidden>Disable microphone</button>
    <div class="sc-folder">
      <div class="sc-folder-row"><span>Save to</span><b id="scFolderName">Not chosen</b></div>
      <button type="button" class="tbtn sc-wide" id="scFolderBtn"><span>Choose folder</span></button>
    </div>
    <div class="caption">WAV, 24-bit at the mic's rate (usually 48 kHz). Kept safe in the browser while recording, then moved to your folder.</div>
  </div>`);

  const recBtn = h(`<button type="button" class="cap-side sc-rec" id="scRec" aria-label="Record camera and audio — key R"><i></i><span id="scRecLabel">Record</span></button>`);
  const takesSec = h(`
  <div class="sec sc-sec sc-takes" id="scTakesSec">
    <div class="scripts-head"><div class="sec-title sc-takes-title">Takes<span class="sc-cur" id="scShootRail" role="button" tabindex="0" title="Change the take name"><i>·</i><span id="scShootRailName">Not named</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75z"/></svg></span></div><button type="button" class="sc-mini-btn" id="scSaveAll" hidden>Save all</button></div>
    <div id="scTakeList"><div class="sc-none">No takes yet. Press <kbd>R</kbd> to record.</div></div>
  </div>`);
  const shootSec = h(`
  <div class="sc-shoot-wrap">
    <div class="sec-title">Take name</div>
    <input class="sc-shoot-input" id="scShootInput" maxlength="60" spellcheck="false" placeholder="e.g. Studio Tour" aria-label="Take name">
    <div class="sc-shoot-hint">Used for the script, every take and the audio file names (e.g. “Studio Tour - Take 01.wav”).</div>
  </div>`);
  const strip = h(`
  <div class="sc-strip-wrap">
    <div class="sec-title"><span>Connect Devices</span><button type="button" class="sc-mini-btn" id="scSample">Load sample data</button></div>
    <div class="sc-strip">
      <div class="sc-card" id="scCardCam">
        <div class="sc-card-top"><span class="sc-card-title">Camera</span><span class="sc-state" id="scCardCamState">off</span></div>
        <div class="sc-card-sub" id="scCardCamSub">USB · PC Remote · camera on</div>
        <img class="sc-card-preview" id="scCardPreview" alt="Live camera preview" hidden>
        <button type="button" class="tbtn sc-wide" id="scCardCamBtn"><span>Connect camera</span></button>
      </div>
      <div class="sc-card" id="scCardMic">
        <div class="sc-card-top"><span class="sc-card-title">Microphone</span><span class="sc-state" id="scCardMicState">off</span></div>
        <div class="sc-card-sub" id="scCardMicSub">Any mic your Mac sees</div>
        <div class="sc-meter-bar sc-card-meter" id="scCardMeter" hidden><i id="scCardMeterFill"></i></div>
        <button type="button" class="tbtn sc-wide" id="scCardMicBtn"><span>Enable microphone</span></button>
      </div>
      <div class="sc-card" id="scCardFolder">
        <div class="sc-card-top"><span class="sc-card-title">Save folder</span><span class="sc-state" id="scCardFolderState">not set</span></div>
        <div class="sc-card-sub" id="scCardFolderSub">Where audio takes go</div>
        <button type="button" class="tbtn sc-wide" id="scCardFolderBtn"><span>Choose folder</span></button>
      </div>
    </div>
    <div class="sc-problem" id="scProblem2" hidden></div>
    <details class="sc-help" id="scHelp2"></details>
  </div>`);
  const toastEl = h(`<div class="sc-toast" id="scToast" hidden></div>`);

  const rightRail = $('right-rail'), utility = $('utility');
  utility.after(camSec); camSec.after(audioSec);
  const play = $('play');
  play.after(recBtn); play.after(h(`<span class="cap-div"></span>`));
  const scriptsHead = document.querySelector('#left-rail .scripts-head');
  scriptsHead.before(takesSec);
  const shootRail = $('scShootRail');
  document.body.append(toastEl);
  document.querySelector('#setup .brand')?.before(strip);
  strip.before(shootSec);
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
    cCamState: $('scCardCamState'), cCamSub: $('scCardCamSub'), cCamBtn: $('scCardCamBtn'), cPreview: $('scCardPreview'), micOff: $('scMicOff'),
    cMicState: $('scCardMicState'), cMicSub: $('scCardMicSub'), cMicBtn: $('scCardMicBtn'), cMeter: $('scCardMeter'), cMeterFill: $('scCardMeterFill'),
    cFolderState: $('scCardFolderState'), cFolderSub: $('scCardFolderSub'), cFolderBtn: $('scCardFolderBtn'), problem2: $('scProblem2'), help: $('scHelp'), help2: $('scHelp2'),
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
    ui.cCamState.textContent = ui.camState.textContent; ui.cCamState.className = ui.camState.className;
    ui.cCamSub.textContent = on ? 'Connected' : 'USB · PC Remote · camera on';
    ui.cPreview.hidden = !on;
    ui.cCamBtn.querySelector('span').textContent = on ? 'Disconnect' : ui.connect.textContent;
    ui.cCamBtn.disabled = ui.connect.disabled && !on;
    ui.cCamBtn.parentElement.classList.toggle('ready', on);
    ui.help.hidden = ui.help2.hidden = on || cam.state === 'unsupported';
  }
  cam.addEventListener('state', e => {
    if (e.detail.state === 'connected') { store.set('camAuto', true); store.set('camEverConnected', true); ui.help.open = ui.help2.open = false; ui.problem.hidden = true; ui.problem2.hidden = true; delete ui.connect.dataset.retry; cam.startPreview(); }
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
    ui.img.src = url; ui.cPreview.src = url; if (big) big.img.src = url;
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = url;
  });

  const FIX_CMD = `launchctl disable gui/$UID/com.apple.ptpcamerad; (nohup sh -c 'while true; do killall -9 ptpcamerad 2>/dev/null; sleep 1; done' >/dev/null 2>&1 &)`;
  const UNDO_CMD = `launchctl enable gui/$UID/com.apple.ptpcamerad; pkill -f "killall -9 ptpcamerad"`;
  const AGENT_PROMPT = `On my Mac, macOS's camera service (ptpcamerad) grabs my USB camera so Chrome (Space Cam, WebUSB) can't use it. Run this once in Terminal:\n\n${FIX_CMD}\n\nIt disables the service from the next restart and keeps it stopped in the background until then. Confirm the background loop is running with: pgrep -f "killall -9 ptpcamerad". If I ask to undo it later, run: ${UNDO_CMD}`;
  const escA = t => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const SETUP_FIX = `
    <summary>First time on a Mac? One-time setup</summary>
    <ol>
      <li>Camera: <b>USB Connection → PC Remote</b>, Ctrl w/ Smartphone → Off. Use a data cable, not charge-only.</li>
      <li>macOS grabs cameras for Photos and Image Capture, which blocks Space Cam. Paste this in Terminal <b>once</b>, then close Terminal. No restart needed:
        <div class="sc-cmd"><code>${escA(FIX_CMD)}</code><button type="button" data-copy="${escA(FIX_CMD)}">Copy</button></div>
        <button type="button" class="sc-mini-btn sc-agent" data-copy="${escA(AGENT_PROMPT)}" data-done="Prompt copied">Copy fix for your AI agent</button>
        <small>Card-reader imports keep working. Only USB-cable photo import from cameras and iPhones stops. Undo: <code>${escA(UNDO_CMD)}</code></small>
      </li>
      <li>Quit Imaging Edge and close other tabs using the camera, unplug and replug the camera, then <b>Connect camera</b>.</li>
    </ol>`;
  for (const box of [ui.help, ui.help2]) {
    box.innerHTML = SETUP_FIX;
    box.open = !store.get('camEverConnected', false);
    box.querySelectorAll('[data-copy]').forEach(b => b.onclick = async e => {
      e.preventDefault();
      const label = b.textContent; try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = b.dataset.done || 'Copied'; setTimeout(() => (b.textContent = label), 1500); } catch { toast('Could not copy.', 'error'); }
    });
  }
  function showCamProblem(kind, title, detail = '') {
    fillCamProblem(ui.problem, kind, title, detail);
    fillCamProblem(ui.problem2, kind, title, detail);
  }
  function fillCamProblem(box, kind, title, detail = '') {
    box.hidden = false;
    if (kind === 'unsupported') { box.innerHTML = `<b>${title}</b><p>Open Space Cam in Chrome or Edge on a Mac to control the camera.</p>`; return; }
    box.innerHTML = `<b>${title}</b><p>Follow the setup steps below, then try again.</p>${detail ? `<small>Camera said: ${detail.replace(/</g, '&lt;')}</small>` : ''}`;
    ui.help.open = ui.help2.open = true;
  }
  if (cam.state === 'unsupported') showCamProblem('unsupported', "This browser can't control USB cameras.");

  ui.connect.onclick = async () => cam.connect({ pick: !(await cam.hasPermittedDevice()) });
  ui.cCamBtn.onclick = () => (cam.state === 'connected' ? ui.disconnect.onclick() : ui.connect.onclick());
  ui.disconnect.onclick = () => {
    if (cam.recording) return toast('Stop recording first.', 'error');
    store.set('camAuto', false); closeBig(); cam.disconnect(); toast('Camera released.');
  };

  // Reconnect by itself after a reload (or when the camera is plugged back in), unless you pressed Disconnect.
  async function autoConnect() {
    if (!store.get('camAuto', false) || cam.state === 'connected' || cam.state === 'connecting' || cam.state === 'unsupported') return;
    if (!(await cam.hasPermittedDevice())) return;
    // After a reload macOS's camera service often grabs the camera for a moment, so keep trying for ~20 s.
    for (let i = 0; i < 10; i++) {
      if (!store.get('camAuto', false) || cam.state === 'connected') return;
      if (cam.state !== 'connecting') await cam.connect({ pick: false, reset: i === 0 });
      if (cam.state === 'connected' || cam.lastErrorKind !== 'busy') return; // only 'busy' is worth retrying
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (CamCore.supported) {
    autoConnect();
    navigator.usb.addEventListener('connect', () => setTimeout(autoConnect, 1200));
  }

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
    ui.meterFill.style.width = pct + '%'; ui.cMeterFill.style.width = pct + '%';
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
    ui.cMicState.textContent = ui.micState.textContent; ui.cMicState.className = ui.micState.className;
    ui.cMicSub.textContent = on ? audio.deviceLabel : 'Any mic your Mac sees';
    ui.cMeter.hidden = !on; ui.micOff.hidden = !on;
    ui.cMicBtn.querySelector('span').textContent = on ? 'Disable' : 'Enable microphone';
    ui.cMicBtn.disabled = audio.state === 'recording';
    ui.cMicBtn.parentElement.classList.toggle('ready', on);
  }
  async function openMic(id) {
    const ok = await audio.open(id ?? store.get('micId', ''));
    if (ok) { store.set('micId', audio.deviceId); store.set('micAuto', true); await fillMics(); }
    renderRec();
  }
  ui.micOn.onclick = () => openMic();
  async function closeMic() {
    if (take || audio.state === 'recording') return toast('Stop recording first.', 'error');
    store.set('micAuto', false); await audio.close(); renderMic(); renderRec(); toast('Microphone off.');
  }
  ui.cMicBtn.onclick = () => (audio.state !== 'off' ? closeMic() : openMic());
  ui.micOff.onclick = closeMic;
  ui.mic.onchange = () => openMic(ui.mic.value);
  if (!AudioCore.supported) { ui.micOn.disabled = ui.cMicBtn.disabled = true; ui.micOn.querySelector('span').textContent = ui.cMicBtn.querySelector('span').textContent = 'Audio needs Chrome'; }
  // Re-open the mic automatically if permission was already given in an earlier visit.
  if (store.get('micAuto', false) && AudioCore.supported) navigator.permissions?.query({ name: 'microphone' }).then(p => { if (p.state === 'granted') openMic(); }).catch(() => {});

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
    ui.cFolderState.textContent = folder ? (ok ? 'ready' : 'needs access') : 'not set';
    ui.cFolderState.className = 'sc-state' + (folder && ok ? ' on' : '');
    ui.cFolderSub.textContent = folder ? folder.name : 'Where audio takes go';
    ui.cFolderBtn.querySelector('span').textContent = ui.folderBtn.querySelector('span').textContent;
    ui.cFolderBtn.parentElement.classList.toggle('ready', !!(folder && ok));
  }
  ui.folderBtn.onclick = async () => {
    if (!window.showDirectoryPicker) return toast('Choosing a folder needs Chrome or Edge.', 'error');
    if (folder && !(await folderOk(false))) { await folderOk(true); return renderFolder(); }
    try { folder = await showDirectoryPicker({ id: 'spacecam-takes', mode: 'readwrite' }); await idb.set('folder', folder); }
    catch (e) { if (e?.name !== 'AbortError') toast('Could not use that folder: ' + (e?.message || e), 'error'); }
    renderFolder(); flushWaiting();
  };
  ui.cFolderBtn.onclick = () => ui.folderBtn.onclick();
  idb.get('folder').then(f => { folder = f || null; renderFolder(); }).catch(() => renderFolder());

  // ------------------------------------------------------------------ shoot name
  let shoot = store.get('shoot', '');
  const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const shootOrDefault = () => shoot || `Untitled ${todayStr()}`;
  const dirName = x => x.replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 60) || 'Shoot';
  window.spaceCamShoot = () => shoot;
  const shootInput = $('scShootInput'), shootRailName = $('scShootRailName');
  function setShoot(v) {
    shoot = v.trim().slice(0, 60); store.set('shoot', shoot);
    shootInput.value = shoot; shootRailName.textContent = shoot || 'Not named';
    shootRail.classList.toggle('empty', !shoot);
  }
  shootInput.value = shoot; setShoot(shoot);
  shootInput.addEventListener('change', () => setShoot(shootInput.value));
  shootInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); shootInput.blur(); } });
  const editShoot = () => {
    if (!$('setup').classList.contains('hidden')) { shootInput.focus(); shootInput.select(); return; }
    const m = modal(`
      <div class="sc-modal-head"><div class="sc-modal-title">Take name</div><button type="button" class="sc-modal-x" data-close aria-label="Close">✕</button></div>
      <input class="sc-modal-input" value="${esc(shoot)}" maxlength="60" spellcheck="false" placeholder="e.g. Studio Tour">
      <div class="sc-modal-hint">New takes use this name. Takes already recorded keep theirs.</div>
      <div class="sc-modal-row"><button type="button" class="btn ghost" data-close>Cancel</button><button type="button" class="btn primary sc-ok">Save</button></div>`);
    const inp = m.wrap.querySelector('input'); inp.focus(); inp.select();
    const ok = () => { setShoot(inp.value); m.close(); };
    m.wrap.querySelector('.sc-ok').onclick = ok;
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
  };
  shootRail.onclick = editShoot;
  shootRail.onkeydown = e => { if (e.key === 'Enter') editShoot(); };
  async function shootDir(base) { return base; } // all takes go straight into the chosen folder
  // a file name not yet used in that folder: Name.wav, Name-2.wav, ...
  async function freeName(dir, name) {
    const exists = n => dir.getFileHandle(n).then(() => true, () => false);
    if (!(await exists(name))) return name;
    const m = name.match(/^(.*?)(\.[^.]+)?$/);
    for (let k = 2; k < 100; k++) { const n = `${m[1]}-${k}${m[2] || ''}`; if (!(await exists(n))) return n; }
    return name;
  }

  // ------------------------------------------------------------------ takes
  let takes = store.get('takes', []);
  let take = null, timer = null, wake = null, busy = false;
  const saveTakes = () => store.set('takes', takes.slice(-200));

  function takeName(sh, no) { return `${dirName(sh)} - Take ${pad(no)}.wav`; }
  function nextNo(sh) {
    return takes.filter(t => !t.demo && (t.shoot || '') === sh).reduce((m, t) => Math.max(m, t.no || 0), 0) + 1;
  }

  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    rename: '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75z"/></svg>',
    del: '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  };
  const takeLabel = t => t.label || (t.recovered ? 'Recovered take' : (t.shoot ? `${t.shoot} · ` : '') + `Take ${pad(t.no)}`);
  const fullDate = d => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + ` · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const safeFileName = (label, t) => {
    const base = label.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || `Take-${pad(t.no || 0)}`;
    return /\.wav$/i.test(base) ? base : base + '.wav';
  };
  t_ids();
  function t_ids() { takes.forEach(t => { if (!t.id) t.id = 't' + (t.startedAt || Date.now()).toString(36) + Math.random().toString(36).slice(2, 6); }); }

  // Where a take's audio lives right now: { file } or { missing: true }
  async function takeFile(t) {
    if (t.audio === 'browser' || t.audio === 'sample') { try { return { file: await audio.getStoredFile(t.name) }; } catch { return { missing: true }; } }
    if (t.audio === 'folder') {
      const dir = (await idb.get('dir:' + t.id)) || folder;
      if (!dir) return { missing: true };
      let p = await dir.queryPermission({ mode: 'readwrite' });
      if (p === 'prompt') { try { p = await dir.requestPermission({ mode: 'readwrite' }); } catch {} }
      if (p !== 'granted') return { denied: true };
      try { return { file: await (await dir.getFileHandle(t.name)).getFile(), dir }; } catch { return { missing: true }; }
    }
    return { missing: true };
  }

  // small popup used for play / rename / delete
  function modal(inner, { wide = false } = {}) {
    const wrap = h(`<div class="sc-modal"><div class="sc-modal-card${wide ? ' sc-modal-wide' : ''}" role="dialog" aria-modal="true">${inner}</div></div>`);
    const close = () => { wrap.querySelectorAll('audio').forEach(a => { a.pause(); if (a.src) URL.revokeObjectURL(a.src); }); wrap.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
    wrap.querySelectorAll('[data-close]').forEach(b => (b.onclick = close));
    document.addEventListener('keydown', onKey, true);
    document.body.append(wrap);
    return { wrap, close };
  }
  const esc = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ---- inline player inside an opened take card: waveform + play/pause + seek ----
  let openTakeId = null, player = null;
  function stopPlayer() {
    if (!player) return;
    player.audio.pause(); URL.revokeObjectURL(player.url); cancelAnimationFrame(player.raf);
    player = null;
  }
  function toggleTakeOpen(t) {
    if (openTakeId === t.id) { openTakeId = null; stopPlayer(); renderTakes(); return; }
    stopPlayer(); openTakeId = t.id; renderTakes();
  }

  // WAV peaks without loading a whole long file: read sample windows spread across it.
  async function wavPeaks(file, buckets) {
    const head = new DataView(await file.slice(0, Math.min(file.size, 4096)).arrayBuffer());
    let off = 12, fmt = null, dataOff = 44, dataLen = file.size - 44;
    while (off + 8 <= head.byteLength) {
      const id = String.fromCharCode(head.getUint8(off), head.getUint8(off + 1), head.getUint8(off + 2), head.getUint8(off + 3));
      const len = head.getUint32(off + 4, true);
      if (id === 'fmt ') fmt = { format: head.getUint16(off + 8, true), channels: head.getUint16(off + 10, true), rate: head.getUint32(off + 12, true), bits: head.getUint16(off + 22, true) };
      if (id === 'data') { dataOff = off + 8; dataLen = Math.min(len || file.size, file.size - dataOff); break; }
      off += 8 + len + (len & 1);
    }
    if (!fmt) throw new Error('Not a WAV file');
    const bps = fmt.bits / 8, frame = bps * fmt.channels, frames = Math.floor(dataLen / frame);
    const read = (dv, i) => {
      if (fmt.format === 3) return dv.getFloat32(i, true);
      if (bps === 2) return dv.getInt16(i, true) / 32768;
      if (bps === 3) { let v = dv.getUint8(i) | (dv.getUint8(i + 1) << 8) | (dv.getInt8(i + 2) << 16); return v / 8388608; }
      if (bps === 4) return dv.getInt32(i, true) / 2147483648;
      return (dv.getUint8(i) - 128) / 128;
    };
    const per = frames / buckets, win = Math.max(1, Math.min(Math.floor(per), 2048));
    const whole = file.size < 40e6 ? new DataView(await file.slice(dataOff, dataOff + frames * frame).arrayBuffer()) : null;
    const peaks = new Float32Array(buckets);
    for (let b = 0; b < buckets; b++) {
      const f0 = Math.floor(b * per);
      let dv, base;
      if (whole) { dv = whole; base = f0 * frame; }
      else { dv = new DataView(await file.slice(dataOff + f0 * frame, dataOff + (f0 + win) * frame).arrayBuffer()); base = 0; }
      let m = 0;
      const n = whole ? Math.max(1, Math.floor(per)) : win;
      const step = Math.max(1, Math.floor(n / 512));
      for (let k = 0; k < n && base + (k + 1) * frame <= dv.byteLength; k += step) { const a = Math.abs(read(dv, base + k * frame)); if (a > m) m = a; }
      peaks[b] = m;
    }
    return { peaks, seconds: frames / fmt.rate };
  }

  function drawWave(cv, peaks, progress) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, hgt = cv.clientHeight;
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = hgt * dpr; }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hgt);
    const n = peaks.length, bw = w / n, mid = hgt / 2;
    for (let i = 0; i < n; i++) {
      const v = Math.max(1, Math.min(1, peaks[i] * 1.15) * (mid - 1));
      g.fillStyle = i / n <= progress ? '#F0F0EE' : '#4a4a50';
      g.fillRect(i * bw, mid - v, Math.max(1, bw - 0.6), v * 2);
    }
    g.fillStyle = '#E8463A'; g.fillRect(Math.min(w - 1.5, progress * w), 0, 1.5, hgt);
  }

  async function mountPlayer(t, box) {
    box.innerHTML = '<div class="sc-tp-loading">Loading…</div>';
    const r = await takeFile(t);
    if (r.denied) { box.innerHTML = '<div class="sc-tp-msg">Allow access to the save folder (Audio panel → Allow access), then open this take again.</div>'; return; }
    if (r.missing || !r.file) { t.missing = true; saveTakes(); box.innerHTML = `<div class="sc-tp-msg">“${esc(t.name)}” was moved or deleted from the folder.</div>`; return; }
    delete t.missing;
    const url = URL.createObjectURL(r.file);
    const a = new Audio(url); a.preload = 'auto';
    box.innerHTML = `
      <canvas class="sc-tp-wave" aria-label="Waveform — click to jump"></canvas>
      <div class="sc-tp-row">
        <button type="button" class="sc-tp-play" aria-label="Play">${ICON.play}</button>
        <span class="sc-tp-time">0:00 / –:––</span>
        <a class="sc-tp-dl" title="Download a copy" aria-label="Download a copy" download="${esc(t.name)}" href="${url}">${ICON.save}</a>
      </div>
      <div class="sc-tp-file" title="${esc(t.name)}">${esc(t.name)}</div>`;
    const cv = box.querySelector('canvas'), btn = box.querySelector('.sc-tp-play'), time = box.querySelector('.sc-tp-time');
    const p = player = { audio: a, url, raf: 0, peaks: new Float32Array(160) };
    const m = s => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;
    const paint = () => {
      const d = a.duration || p.seconds || 0;
      drawWave(cv, p.peaks, d ? a.currentTime / d : 0);
      time.textContent = `${m(a.currentTime)} / ${d ? m(d) : '–:––'}`;
      btn.innerHTML = a.paused ? ICON.play : ICON.pause; btn.setAttribute('aria-label', a.paused ? 'Play' : 'Pause');
    };
    const loop = () => { paint(); if (!a.paused) p.raf = requestAnimationFrame(loop); };
    btn.onclick = e => { e.stopPropagation(); a.paused ? a.play() : a.pause(); };
    a.onplay = () => { cancelAnimationFrame(p.raf); loop(); };
    a.onpause = a.onended = a.onloadedmetadata = paint;
    cv.onclick = e => { e.stopPropagation(); const d = a.duration || p.seconds; if (!d) return; const rc = cv.getBoundingClientRect(); a.currentTime = Math.max(0, Math.min(d, (e.clientX - rc.left) / rc.width * d)); paint(); };
    box.querySelector('.sc-tp-dl').onclick = e => e.stopPropagation();
    paint();
    try { const wp = await wavPeaks(r.file, Math.max(60, Math.floor((cv.clientWidth || 220) / 2.5))); if (player === p) { p.peaks = wp.peaks; p.seconds = wp.seconds; paint(); } }
    catch { /* not a WAV we can read: player still works without the waveform */ }
  }

  async function renameTake(t) {
    const m = modal(`
      <div class="sc-modal-head"><div class="sc-modal-title">Rename take</div><button type="button" class="sc-modal-x" data-close aria-label="Close">✕</button></div>
      <input class="sc-modal-input" value="${esc(takeLabel(t))}" maxlength="80" spellcheck="false">
      <div class="sc-modal-hint">${t.audio === 'folder' ? 'The WAV file in your folder is renamed too.' : 'The file gets this name when it is saved.'}</div>
      <div class="sc-modal-row"><button type="button" class="btn ghost" data-close>Cancel</button><button type="button" class="btn primary sc-ok">Rename</button></div>`);
    const inp = m.wrap.querySelector('input'); inp.focus(); inp.select();
    const ok = async () => {
      const label = inp.value.trim(); if (!label) return inp.focus();
      if (t.audio === 'folder') {
        const newName = safeFileName(label, t);
        if (newName !== t.name) {
          const r = await takeFile(t);
          if (r.denied) return toast('Allow access to the save folder first.', 'error');
          if (r.missing) return toast('The file was moved or deleted from the folder, so it can’t be renamed.', 'error');
          try {
            if (await r.dir.getFileHandle(newName).then(() => true, () => false)) return toast(`A file called “${newName}” already exists in that folder.`, 'error');
            const fh = await r.dir.getFileHandle(t.name);
            if (fh.move) { try { await fh.move(newName); } catch { await copyRename(r.dir, r.file, t.name, newName); } }
            else await copyRename(r.dir, r.file, t.name, newName);
            t.name = newName;
          } catch (e) { return toast('Could not rename the file: ' + (e?.message || e), 'error'); }
        }
      }
      t.label = label; saveTakes(); renderTakes(); m.close(); toast('Take renamed.', 'ok');
    };
    m.wrap.querySelector('.sc-ok').onclick = ok;
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
  }
  async function copyRename(dir, file, oldName, newName) {
    const w = await (await dir.getFileHandle(newName, { create: true })).createWritable();
    await file.stream().pipeTo(w);
    await dir.removeEntry(oldName);
  }

  function deleteTake(t) {
    const inFolder = t.audio === 'folder' || t.audio === 'saved';
    const unsaved = t.audio === 'browser' || t.audio === 'sample';
    const m = modal(`
      <div class="sc-modal-head"><div class="sc-modal-title">Delete “${esc(takeLabel(t))}”?</div><button type="button" class="sc-modal-x" data-close aria-label="Close">✕</button></div>
      <p class="sc-modal-p">${unsaved ? 'This audio was never saved to a folder. Deleting it removes it for good.' :
        inFolder ? 'This only removes it from the list. The WAV file stays in your folder.' : 'This removes it from the list.'}</p>
      <div class="sc-modal-row"><button type="button" class="btn ghost" data-close>Cancel</button><button type="button" class="btn primary sc-ok${unsaved ? ' danger' : ''}">${unsaved ? 'Delete audio' : 'Remove from list'}</button></div>`);
    m.wrap.querySelector('.sc-ok').onclick = async () => {
      if (unsaved) await audio.deleteStored(t.name).catch(() => {});
      if (openTakeId === t.id) { stopPlayer(); openTakeId = null; }
      takes = takes.filter(x => x !== t); saveTakes(); renderTakes(); m.close();
    };
  }

  function renderTakes() {
    t_ids();
    const list = takes.slice().reverse();
    ui.saveAll.hidden = !takes.some(t => t.audio === 'browser');
    if (player && !takes.some(t => t.id === openTakeId)) { stopPlayer(); openTakeId = null; }
    if (player) stopPlayer();
    if (!list.length) { ui.takeList.innerHTML = '<div class="sc-none">No takes yet. Press <kbd>R</kbd> to record.</div>'; return; }
    ui.takeList.replaceChildren(...list.map(t => {
      const when = new Date(t.startedAt);
      const hasAudio = ['folder', 'browser', 'sample'].includes(t.audio);
      const status = t.missing ? '<em>file moved</em>' : t.audio === 'folder' ? 'audio in ' + esc(t.folderName || 'folder')
        : t.audio === 'saved' ? 'audio saved' : t.audio === 'browser' ? '<em>not saved yet</em>' : t.audio === 'sample' ? 'sample audio' : 'no audio';
      const open = t.id === openTakeId && hasAudio;
      const el = h(`<div class="script-tab sc-take${t.audio === 'browser' ? ' unsaved' : ''}${open ? ' open active' : ''}">
        <div class="sc-take-head" role="button" tabindex="0" aria-expanded="${open}">
          <span class="sc-take-main">
            <span class="script-tab-name">${esc(takeLabel(t))}</span>
            <span class="sc-take-sub">${esc(fullDate(when))}<br>${t.seconds != null ? fmt(t.seconds) + ' · ' : ''}${t.camera ? 'clip on card · ' : ''}${status}</span>
          </span>
          <span class="script-tab-actions"></span>
        </div>
        ${open ? '<div class="sc-tp"></div>' : ''}</div>`);
      const actions = el.querySelector('.script-tab-actions');
      const act = (icon, title, fn) => { const b = h(`<span class="script-tab-act" role="button" title="${title}" aria-label="${title}">${ICON[icon]}</span>`); b.onclick = e => { e.stopPropagation(); fn(); }; actions.append(b); };
      if (t.audio === 'browser') act('save', 'Save audio', () => saveTake(t));
      act('rename', 'Rename', () => renameTake(t));
      act('del', 'Delete', () => deleteTake(t));
      const head = el.querySelector('.sc-take-head');
      if (hasAudio) {
        head.onclick = () => toggleTakeOpen(t);
        head.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTakeOpen(t); } };
        head.title = open ? 'Close' : 'Open player';
      }
      if (open) queueMicrotask(() => mountPlayer(t, el.querySelector('.sc-tp')));
      return el;
    }));
  }

  async function saveTake(t) {
    try {
      const dest = t.label ? safeFileName(t.label, t) : t.name;
      if (await folderOk(true)) {
        const sub = await shootDir(folder, t.shoot || shootOrDefault()), fin = await freeName(sub, dest);
        await audio.moveToFolder(t.name, sub, fin); t.name = fin; t.audio = 'folder'; t.folderName = folder.name; await idb.set('dir:' + t.id, sub);
      }
      else { await audio.saveAs(t.name, dest); t.name = dest; t.audio = 'saved'; }
      delete t.recovered; delete t.missing; saveTakes(); renderTakes(); toast(`${t.name} saved.`, 'ok');
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

  // ------------------------------------------------------------------ sample data (quick check; remove before launch)
  const sampleBtn = $('scSample');
  const SAMPLE_SCRIPTS = [
    { name: 'Sample · Quick hello', text: "Hi, I'm testing Space Cam.\n\nThis is a short script to check the prompter, the camera and the microphone together.\n\nIf you can read this on the glass, everything works." },
    { name: 'Sample · Product intro', text: "Welcome back to the channel.\n\nToday I'm going to show you a tool that changed how I record my videos.\n\nIt runs in the browser. No install, no account.\n\nIt controls my camera, records my voice and scrolls my script, all from one window.\n\nLet me show you how it works, step by step.\n\nIf this helps you, you know what to do. See you in the next one." },
    { name: 'Sample · Long tutorial', text: Array.from({ length: 14 }, (_, i) => `Step ${i + 1}. ` + [
      'Open the app and check the three cards at the top: camera, microphone and save folder.',
      'Connect the camera over USB. Make sure it is set to PC Remote.',
      'Pick your microphone and watch the meter while you speak at your normal level.',
      'Choose the folder where your audio takes should go.',
      'Paste your script, then press Go to Spotlight.',
      'Connect the stage window and drag it to the teleprompter screen.',
      'Adjust the speed and the text size until it reads comfortably.',
      'Hold A to focus on your face, or use the arrows if the camera is on manual focus.',
      'Press R to start recording. The camera and the audio start together.',
      'Press Space to start the prompter. Read at your own pace.',
      'Press R again to stop. The take appears in the Takes list.',
      'Open the take to listen back and check the sound.',
      'Rename the take so you can find it later in Premiere.',
      'In Premiere, sync the camera clip and the audio with Synchronize, then Audio.'][i]).join('\n\n') },
  ];

  // speech-like test audio: bursts of tone + breath noise with pauses (48 kHz, 24-bit mono WAV)
  function makeSampleWav(seconds, seed) {
    const rate = 48000, n = Math.floor(seconds * rate), data = new Uint8Array(44 + n * 3), v = new DataView(data.buffer);
    const str = (o, x) => { for (let i = 0; i < x.length; i++) v.setUint8(o + i, x.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 3, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 3, true); v.setUint16(32, 3, true); v.setUint16(34, 24, true);
    str(36, 'data'); v.setUint32(40, n * 3, true);
    let r = seed * 9301 + 49297; const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
    let o = 44, env = 0, target = 0, nextSwitch = 0, f0 = 140 + seed * 30;
    for (let i = 0; i < n; i++) {
      if (i >= nextSwitch) { const talking = rnd() > 0.3; target = talking ? 0.25 + rnd() * 0.45 : 0; nextSwitch = i + Math.floor(rate * (talking ? 0.12 + rnd() * 0.35 : 0.08 + rnd() * 0.5)); f0 = 110 + rnd() * 120; }
      env += (target - env) * 0.0025;
      const t = i / rate;
      const x = env * (0.55 * Math.sin(2 * Math.PI * f0 * t) + 0.25 * Math.sin(2 * Math.PI * f0 * 2.01 * t) + 0.12 * Math.sin(2 * Math.PI * f0 * 3.02 * t) + 0.08 * (rnd() * 2 - 1));
      const q = Math.round(Math.max(-1, Math.min(1, x)) * 0x7fffff);
      data[o++] = q & 255; data[o++] = (q >> 8) & 255; data[o++] = (q >> 16) & 255;
    }
    return new Blob([data], { type: 'audio/wav' });
  }
  async function writeStored(name, blob) {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('takes', { create: true });
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(blob); await w.close();
  }
  const hasSample = () => takes.some(t => t.demo) || !!window.spaceCamScripts?.hasDemo();
  function renderSampleBtn() { sampleBtn.textContent = hasSample() ? 'Remove sample data' : 'Load sample data'; }
  sampleBtn.onclick = async () => {
    sampleBtn.disabled = true;
    try {
      if (hasSample()) {
        for (const t of takes.filter(t => t.demo)) await audio.deleteStored(t.name).catch(() => {});
        if (takes.some(t => t.demo && t.id === openTakeId)) { stopPlayer(); openTakeId = null; }
        takes = takes.filter(t => !t.demo); saveTakes(); renderTakes();
        window.spaceCamScripts?.removeDemo();
        toast('Sample data removed. Your own takes and scripts are untouched.', 'ok');
      } else {
        window.spaceCamScripts?.addDemo(SAMPLE_SCRIPTS);
        const now = Date.now(), day = 86400000;
        const specs = [{ secs: 9, ago: 2 * day + 3600e3, label: 'Sample · Quick hello' }, { secs: 24, ago: day, label: 'Sample · Product intro' }, { secs: 48, ago: 25 * 60e3, label: 'Sample · Long tutorial' }];
        for (let i = 0; i < specs.length; i++) {
          const sp = specs[i], startedAt = now - sp.ago, name = `Sample-Take-${pad(i + 1)}_${startedAt}.wav`;
          await writeStored(name, makeSampleWav(sp.secs, i + 1));
          takes.push({ id: 'demo' + i + startedAt.toString(36), no: i + 1, label: sp.label, name, startedAt, seconds: sp.secs, camera: true, audio: 'sample', demo: true });
        }
        takes.sort((a, b) => a.startedAt - b.startedAt); saveTakes(); renderTakes();
        toast('Sample data loaded: 3 scripts and 3 takes. Open a take to play it.', 'ok');
      }
    } catch (e) { toast('Sample data failed: ' + (e?.message || e), 'error'); }
    sampleBtn.disabled = false; renderSampleBtn();
  };
  setTimeout(renderSampleBtn, 0);

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
    if (!shoot) setShoot(shootOrDefault());
    const sh = shoot, no = nextNo(sh), started = new Date();
    let name = takeName(sh, no);
    if (takes.some(t => t.name === name)) name = name.replace(/\.wav$/, ` (${pad(started.getHours())}${pad(started.getMinutes())}${pad(started.getSeconds())}).wav`);
    const [a, c] = await Promise.all([micOk ? audio.startRecording(name) : false, camOk ? cam.startRecording() : false]);
    if (!a && !c) return toast('Recording did not start. Check the camera and microphone.', 'error');
    if (camOk && !c) toast('Camera did not start recording. Audio is recording.', 'error');
    if (micOk && !a) toast('Audio did not start. Camera is recording.', 'error');
    take = { id: 't' + started.getTime().toString(36), shoot: sh, no, name: a ? name : null, startedAt: started.getTime(), camera: !!c, audio: a ? 'recording' : 'none' };
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
        try {
          const sub = await shootDir(folder, t.shoot || shootOrDefault()), fin = await freeName(sub, t.name);
          await audio.moveToFolder(t.name, sub, fin); t.name = fin; t.audio = 'folder'; t.folderName = folder.name; await idb.set('dir:' + t.id, sub);
        }
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
  // Cmd/Ctrl+R: close the camera session cleanly first, then reload, so it reconnects without a replug.
  // (Cmd+Shift+R is left alone: hard reload still starts disconnected.)
  window.addEventListener('keydown', async e => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'r') return;
    if (cam.state !== 'connected' || take) return;
    e.preventDefault(); e.stopImmediatePropagation();
    toast('Reloading…');
    await cam.release();
    location.reload();
  }, true);
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
