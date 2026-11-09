// studio.js — adds camera control, audio recording and takes to the Space Cam prompter page.
// The prompter itself (scripts, stage window, controls) is the page's own code; this file only
// adds panels and talks to the camera / audio engines.
// Cache-busting: index.html loads this file as studio.js?v=…; pass the same ?v= on to every file we load,
// so one bump in index.html refreshes everything after a deploy.
const V = new URL(import.meta.url).search;
const { CamCore } = await import('./cam-core.js' + V);
const { AudioCore } = await import('./audio-core.js' + V);
const { WebcamCore } = await import('./webcam-core.js' + V);

// The stage window (#stage) and its mini preview (#stage-preview) are plain prompter views; the only thing
// studio.js adds there is the optional camera layer behind the text ("Camera on Stage").
if (/^#stage/.test(location.hash)) initStageCam(); else init();

// ---- Stage window: camera behind the script, mirrored/flipped/rotated exactly like the text ----
// The control window sends {type:'cfg'} (on/off, which camera, brightness) and, for a USB camera, preview frames
// on the 'spaceCamCam' channel. The Mac camera is opened here directly (Chrome lets windows share a camera).
function initStageCam() {
  const stage = document.getElementById('stage'), scroller = document.getElementById('scroller');
  if (!stage || !scroller) return;
  const layer = document.createElement('div');
  layer.className = 'sc-stage-cam'; layer.hidden = true; layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = '<img alt=""><video muted playsinline autoplay></video>';
  stage.prepend(layer); // first child: the script, guide line and hint draw on top
  const img = layer.querySelector('img'), vid = layer.querySelector('video');
  // the prompter transforms #scroller for the glass (mirror, flip, rotation); copy the same geometry
  const copy = () => { for (const p of ['inset', 'left', 'top', 'width', 'height', 'transform']) layer.style[p] = scroller.style[p]; };
  new MutationObserver(copy).observe(scroller, { attributes: true, attributeFilter: ['style'] });
  copy();
  let stream = null, devId = null, lastUrl = null;
  const stopStream = () => { stream?.getTracks().forEach(t => t.stop()); stream = null; devId = null; vid.srcObject = null; };
  let ch; try { ch = new BroadcastChannel('spaceCamCam'); } catch { return; }
  ch.onmessage = async ({ data: m }) => {
    if (!m) return;
    if (m.type === 'cfg') {
      layer.style.setProperty('--sc-cam-op', String(m.opacity ?? 0.2));
      layer.classList.toggle('sc-bw', m.bw !== false);
      layer.hidden = !m.on;
      layer.dataset.src = m.on ? m.src : 'off';
      if (!m.on || m.src !== 'mac') stopStream();
      if (!m.on || m.src !== 'usb') img.removeAttribute('src');
      if (m.on && m.src === 'mac' && (!stream || devId !== (m.deviceId || ''))) {
        stopStream();
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: m.deviceId ? { exact: m.deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } } });
          devId = m.deviceId || ''; vid.srcObject = stream; vid.play().catch(() => {});
        } catch { layer.hidden = true; }
      }
    } else if (m.type === 'frame' && m.blob && layer.dataset.src === 'usb') {
      const u = URL.createObjectURL(m.blob); img.src = u;
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = u;
    }
  };
  ch.postMessage({ type: 'hello' });
  addEventListener('pagehide', stopStream);
}

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
  if (hardReload) { store.set('camAuto', false); store.set('micAuto', false); store.set('webOn', false); }
  const cam = new CamCore();
  const audio = new AudioCore();
  const web = new WebcamCore(); // the Mac's own camera, used instead of the Sony when chosen
  // Which camera you picked in the Camera dropdown: 'usb' (a camera over USB in PC Remote mode, controlled with gphoto2:
  // Sony tested, other brands may work) or 'mac:<deviceId>' (FaceTime, iPhone, webcam, OBS…).
  // Internally src 'sony' = the USB camera path, 'mac' = the browser camera path.
  let camPick = String(store.get('camPick', 'usb')).replace(/^sony$/, 'usb');
  let src = camPick.startsWith('mac') ? 'mac' : 'sony';
  document.body.dataset.src = src;
  const webOn = () => web.state === 'connected';
  // "Camera on Stage": tells the Stage window (and the mini preview) what to show behind the script.
  let stageCamCh = null; try { stageCamCh = new BroadcastChannel('spaceCamCam'); } catch {}
  let stageCamLast = '', stageFrameT = 0;
  function sendStageCam(force = false) {
    if (!stageCamCh) return;
    const live = src === 'mac' ? web.state === 'connected' : cam.state === 'connected';
    const on = !!store.get('stageCam', false) && live;
    const op = Number(document.getElementById('scCvOp')?.value || store.get('centerOpacity', 20)) / 100;
    const msg = { type: 'cfg', on, src: src === 'mac' ? 'mac' : 'usb', deviceId: web.deviceId || '', opacity: op, bw: store.get('camBW', true) };
    const key = JSON.stringify(msg);
    if (!force && key === stageCamLast) return; // renderCam runs often; only send changes
    stageCamLast = key; stageCamCh.postMessage(msg);
  }
  if (stageCamCh) stageCamCh.onmessage = ({ data }) => { if (data?.type === 'hello') sendStageCam(true); };
  const liveOn = () => (src === 'mac' ? webOn() : cam.state === 'connected');

  // ------------------------------------------------------------------ markup
  const camSec = h(`
  <div class="sec sc-sec" id="scCamSec">
    <div class="sec-title"><span>Camera</span><span class="sc-state" id="scCamState">Off</span></div>
    <select class="sc-select" id="scCamPick" aria-label="Camera"></select>
    <div class="sc-preview" id="scPreview">
      <img id="scImg" alt="Live camera preview" hidden>
      <video id="scVid" muted playsinline autoplay hidden></video>
      <div class="sc-grid" id="scGrid" hidden><i></i><i></i><i></i><i></i></div>
      <span class="sc-badge" id="scBadge" hidden><i></i><span id="scBadgeTime">00:00</span></span>
      <span class="sc-fps" id="scFps"></span>
      <div class="sc-empty" id="scCamEmpty">
        <button type="button" class="btn primary" id="scConnect">Connect camera</button>
        <small id="scConnectSub">USB · PC Remote · Chrome on Mac</small>
      </div>
    </div>
    <div class="sc-info sc-sony-only" id="scInfo" hidden></div>
    <div class="tpair three sc-focus sc-sony-only">
      <button type="button" class="tbtn" id="scAF" disabled title="Hold to autofocus"><span>Focus</span><kbd>A</kbd></button>
      <button type="button" class="tbtn" id="scNear" disabled title="Manual focus nearer (camera on MF)"><span>Near</span><kbd>←</kbd></button>
      <button type="button" class="tbtn" id="scFar" disabled title="Manual focus farther (camera on MF)"><span>Far</span><kbd>→</kbd></button>
    </div>
    <div class="slider-group sc-sony-only">
      <div class="slider-label"><span>Focus step</span><span id="scStepVal">1</span></div>
      <input type="range" id="scStep" min="1" max="7" step="1" value="1" disabled>
    </div>
    <div class="tpair">
      <button type="button" class="tbtn" id="scGridBtn" aria-pressed="false" disabled><span>Grid</span><kbd>G</kbd></button>
      <button type="button" class="tbtn" id="scBig" disabled title="Large floating preview window"><span>Big preview</span></button>
    </div>
    <div class="slider-label sc-cv-label"><span>Camera in the center</span></div>
    <div class="tpair three sc-cv" role="group" aria-label="How the camera shows in the center panel">
      <button type="button" class="tbtn" data-cv="bg" aria-pressed="false"><span>Behind script</span></button>
      <button type="button" class="tbtn" data-cv="corner" aria-pressed="false"><span>Corner</span></button>
      <button type="button" class="tbtn" data-cv="off" aria-pressed="false"><span>Off</span></button>
    </div>
    <div class="slider-group sc-cv-bgonly">
      <div class="slider-label"><span>Camera visibility through the script</span><span id="scCvOpVal">20%</span></div>
      <input type="range" id="scCvOp" min="10" max="100" step="5" value="20" aria-label="How much of the camera shows through the script">
      <div class="caption">Text contrast is kept readable automatically as the picture changes.</div>
    </div>
    <div class="tpair sc-bwrow">
      <button type="button" class="tbtn" id="scCamBW" aria-pressed="true" title="Show the camera in black and white behind the script and on the Stage, so the text stands out. Recordings stay in colour."><span>Black and white</span></button>
    </div>
    <div class="caption sc-bw-note">Only how the camera looks behind the script and on the Stage. Recordings stay in colour.</div>
    <div class="tpair sc-stagecam">
      <button type="button" class="tbtn" id="scStageCam" aria-pressed="false" title="Show the camera behind the script on the Stage window (prompter glass)"><span>Camera on Stage</span></button>
    </div>
    <div class="caption sc-stagecam-note">Also shows it behind the script on the prompter glass, mirrored like the text.</div>
    <button type="button" class="sc-link" id="scDisconnect" hidden>Disconnect camera</button>
    <div class="sc-problem sc-sony-only" id="scProblem" hidden></div>
    <details class="sc-help sc-sony-only" id="scHelp"></details>
    <div class="caption sc-mac-only">Mac camera video records with the take: <b>Take_N.mp4</b> next to the audio, kept safe in the browser while recording.</div>
  </div>`);

  // Live camera feed fills the center panel behind the script (control window only).
  const centerCam = h(`
  <div class="sc-center-cam" id="scCenterCam" hidden aria-hidden="true">
    <img id="scCenterImg" alt="Live camera preview">
    <video id="scCenterVid" muted playsinline autoplay></video>
    <i class="sc-center-mark"></i>
    <div class="sc-grid" id="scCenterGrid" hidden><i></i><i></i><i></i><i></i></div>
    <span class="sc-badge" id="scCenterBadge" hidden><i></i><span id="scCenterTime">00:00</span></span>
  </div>`);

  const audioSec = h(`
  <div class="sec sc-sec" id="scAudioSec">
    <div class="sec-title"><span>Audio</span><span class="sc-state" id="scMicState">Off</span></div>
    <button type="button" class="tbtn sc-wide" id="scMicOn"><span>Connect mic</span></button>
    <select class="sc-select" id="scMic" hidden aria-label="Microphone"></select>
    <div class="sc-meter" id="scMeterWrap" hidden>
      <div class="sc-meter-bar"><i id="scMeterFill"></i><b id="scMeterPeak"></b></div>
      <div class="sc-meter-label"><span id="scDb">−∞ dB</span><span class="sc-clip" id="scClip">CLIP</span></div>
    </div>
    <div class="sc-wave" id="scWaveRail" hidden><canvas></canvas><span class="sc-wave-tag"><i></i><b>Not recording</b></span></div>
    <button type="button" class="sc-link" id="scMicOff" hidden>Disconnect mic</button>
    <div class="caption">Records 24-bit WAV at the mic's rate (usually 48 kHz), kept safe in the browser while recording. When you stop it's saved as MP3 (320 kbps) to the save location on the left.</div>
  </div>`);

  const soundSec = h(`
  <div class="sec sc-sec" id="scSoundSec">
    <div class="sec-title"><span>Sounds</span></div>
    <div class="tpair"><button type="button" class="tbtn" id="scSounds" aria-pressed="true" title="Beeps for Record and Stop, an alarm when something drops"><span>Alert sounds</span></button></div>
    <div class="caption">A beep when recording starts and stops, and an alarm when something goes wrong: camera or mic disconnected, recording stopped on its own, a capture failed. Use headphones if you don't want the beeps in the recording.</div>
  </div>`);

  const recBtn = h(`<button type="button" class="cap-side sc-rec" id="scRec" aria-label="Record camera and audio — key R"><i></i><span id="scRecLabel">Record</span></button>`);
  const takesSec = h(`
  <div class="sec sc-sec sc-takes" id="scTakesSec">
    <div class="scripts-head"><div class="sec-title sc-takes-title">Recordings</div><button type="button" class="sc-mini-btn" id="scSaveAll" hidden>Save all</button></div>
    <div id="scTakeList"><div class="sc-none">No takes yet. Press <kbd>R</kbd> to record.</div></div>
  </div>`);
  const strip = h(`
  <div class="sc-strip-wrap">
    <div class="sec-title"><span>Get ready</span><button type="button" class="sc-mini-btn" id="scSample">Load sample data</button></div>
    <div class="sc-strip sc-strip-cs">
      <div class="sc-card sc-card-big" id="scCardCam">
        <div class="sc-card-top"><span class="sc-card-title">Camera</span><span class="sc-status" id="scCardCamState">Off</span></div>
        <div class="sc-card-sub" id="scCardCamSub">USB · PC Remote · camera on</div>
        <div class="sc-media" id="scCardPreviewBox"><span id="scCardPreviewMsg">Camera off</span><img id="scCardPreview" alt=""></div>
        <button type="button" class="sc-cbtn primary" id="scCardCamBtn"><span>Connect camera</span></button>
      </div>
      <div class="sc-card sc-card-big sc-card-script" id="scCardScript">
        <div class="sc-card-top"><span class="sc-card-title">Script</span><span class="sc-card-tools" id="scScriptTools"></span></div>
        <div class="sc-card-sub">Paste a script, then save it to the left</div>
        <div class="sc-script-slot" id="scScriptSlot"></div>
        <button type="button" class="sc-cbtn primary" id="scScriptSave"><span>Save script</span></button>
      </div>
      <div class="sc-note"><div class="sc-problem" id="scProblem2" hidden></div><details class="sc-help" id="scHelp2"></details></div>
      <div class="sc-note" id="scScriptNote"><p>Saved scripts appear on the left. Click one to use it; ✎ edits it. <kbd>⌘S</kbd> saves.</p></div>
    </div>
  </div>`);
  const setupRail = h(`
  <aside class="rail sc-setup-rail" id="scSetupRail" aria-label="Setup options">
    <div class="sec sc-sec" id="scCardMic">
      <div class="sec-title"><span>Microphone</span><span class="sc-status" id="scCardMicState">Off</span></div>
      <div class="sc-rail-row"><span class="sc-rail-ico"><svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 003-3V5a3 3 0 00-6 0v6a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 006 6.92V21h2v-3.08A7 7 0 0019 11h-2z"/></svg></span><span id="scCardMicSub">Any mic your Mac sees</span></div>
      <div class="sc-media sc-media-meter sc-rail-meter" id="scCardWaveBox"><div class="sc-bigmeter"><div class="sc-bigmeter-bar"><i id="scCardFill"></i><b id="scCardPeak"></b></div><div class="sc-bigmeter-scale"><span>−50</span><span>−24</span><span>−12</span><span>−6</span><span>0</span></div><div class="sc-bigmeter-read" id="scCardDb">Mic off</div></div><span id="scCardWaveMsg" hidden></span></div>
      <button type="button" class="tbtn sc-wide" id="scCardMicBtn"><span>Connect mic</span></button>
      <div class="caption" id="scMicNote">No mic here? That's fine if your camera or an external recorder records the sound. Make sure one of them is recording.</div>
      <div class="caption" id="scMicTip" hidden>WAV 24-bit, no browser processing. Set the level on your interface; aim for peaks around −12 dB.</div>
    </div>
    <div class="sec sc-sec">
      <div class="sec-title"><span>Save location</span><button type="button" class="sc-icon-mini sc-tip" aria-label="How saving works" data-tip="Takes save here automatically: the MP3 audio, and the video when you record with a Mac camera. A USB camera keeps its video on its own memory card.">${'<svg viewBox="0 0 24 24"><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16z"/></svg>'}</button></div>
      <div class="sc-folder-line">
        <button type="button" class="sc-folder-pill" id="scFolderRow" title="Where takes are saved">${'<svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>'}<b id="scFolderName">Downloads</b></button>
      </div>
    </div>
    <div class="sec sc-sec">
      <div class="sec-title"><span>Bluetooth device</span><span class="sc-status" id="scCardPedalState">Off</span></div>
      <div class="sc-rail-row"><span class="sc-rail-ico">${'<svg viewBox="0 0 24 24"><path d="M17.71 7.71L12 2h-1v7.59L6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 11 14.41V22h1l5.71-5.71-4.3-4.29 4.3-4.29zM13 5.83l1.88 1.88L13 9.59V5.83zm1.88 10.46L13 18.17v-3.76l1.88 1.88z"/></svg>'}</span><span id="scCardPedalSub">Pedal or clicker for the prompter</span></div>
      <button type="button" class="tbtn sc-wide pedal-trigger" id="scCardPedalBtn"><span>Set up</span></button>
      <div class="caption">Pair it in macOS Bluetooth settings first, then press Set up and tap the pedal.</div>
    </div>
  </aside>`);
  const goSec = h(`
  <div class="sc-go">
    <div class="sc-go-text"><b>Ready to shoot?</b><span>Spotlight shows the prompter, the camera and Record. The selected script is used; no script is fine too.</span></div>
  </div>`);
  const toastEl = h(`<div class="sc-toast" id="scToast" hidden></div>`);

  const rightRail = $('right-rail'), utility = $('utility');
  utility.after(camSec); camSec.after(audioSec); audioSec.after(soundSec);
  $('stage').prepend(centerCam); // first child, so the script and guide draw on top
  // Live audio waveform, top left of the center panel (the right rail has a bigger one under Audio)
  const centerWave = h(`<div class="sc-wave sc-wave-center" id="scWaveCenter" hidden aria-hidden="true"><canvas></canvas><span class="sc-wave-tag"><i></i><b>Not recording</b></span></div>`);
  $('stage').append(centerWave);
  // Camera in the center: 'bg' behind the script (default), 'corner' small top right, 'off'
  function setCenterView(v) {
    if (!['bg', 'corner', 'off'].includes(v)) v = 'bg';
    store.set('centerView', v);
    document.body.dataset.cv = v;
    camSec.querySelectorAll('[data-cv]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cv === v)));
  }
  camSec.querySelectorAll('[data-cv]').forEach(b => (b.onclick = () => { setCenterView(b.dataset.cv); measureContrast(true); }));
  setCenterView(store.get('centerView', 'bg'));

  // Camera visibility through the script: how much of the feed shows behind the text, 10–100%.
  const cvOp = camSec.querySelector('#scCvOp'), cvOpVal = camSec.querySelector('#scCvOpVal');
  function setCamOpacity(pct) {
    pct = Math.max(10, Math.min(100, Math.round(pct / 5) * 5 || 20));
    cvOp.value = pct; cvOpVal.textContent = pct + '%'; store.set('centerOpacity', pct);
    centerCam.style.setProperty('--sc-cam-op', String(pct / 100));
  }
  cvOp.addEventListener('input', () => { setCamOpacity(Number(cvOp.value)); measureContrast(true); sendStageCam(); });
  // Black and white (default on): only the camera behind the script and on the Stage, never the recording
  const bwBtn = camSec.querySelector('#scCamBW');
  const camBW = () => store.get('camBW', true);
  const renderBW = () => { bwBtn.setAttribute('aria-pressed', String(camBW())); centerCam.classList.toggle('sc-bw', camBW()); };
  bwBtn.onclick = () => { store.set('camBW', !camBW()); renderBW(); measureContrast(true); sendStageCam(); };
  renderBW();
  // Camera on Stage toggle
  const stageCamBtn = camSec.querySelector('#scStageCam');
  const renderStageCamBtn = () => stageCamBtn.setAttribute('aria-pressed', String(!!store.get('stageCam', false)));
  stageCamBtn.onclick = () => { store.set('stageCam', !store.get('stageCam', false)); renderStageCamBtn(); sendStageCam(); };
  renderStageCamBtn();
  setCamOpacity(store.get('centerOpacity', 20)); // 20% tested best behind the script (9 Nov); your own choice is remembered

  // Auto contrast: measure how bright the picture is where the text sits and darken just enough that
  // white text stays readable. First frame sets it at once; after that it eases so it doesn't flicker.
  const lum = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const probe = document.createElement('canvas'); probe.width = 48; probe.height = 27;
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });
  const TARGET_L = 0.18, MIN_TINT = 0.12, MAX_TINT = 0.88; // white text on ≤0.18 luminance ≈ 4.5:1 contrast (plus the text shadow)
  let tint = null, lastProbe = 0;
  function measureContrast(now = false) {
    const img = src === 'mac' ? centerCam.querySelector('video') : centerCam.querySelector('img');
    if (document.body.dataset.cv !== 'bg' || centerCam.hidden || !(img.naturalWidth || img.videoWidth)) return;
    const t = performance.now();
    if (!now && t - lastProbe < 200) return;
    lastProbe = t;
    let px;
    try { probeCtx.drawImage(img, 0, 0, probe.width, probe.height); px = probeCtx.getImageData(0, 0, probe.width, probe.height).data; } catch { return; }
    // middle 70% wide, 15–85% high (what the panel shows of the cropped feed, where the lines run)
    const vals = [];
    for (let y = Math.floor(probe.height * 0.15); y < Math.ceil(probe.height * 0.85); y++)
      for (let x = Math.floor(probe.width * 0.15); x < Math.ceil(probe.width * 0.85); x++) {
        const i = (y * probe.width + x) * 4;
        vals.push(0.2126 * lum[px[i]] + 0.7152 * lum[px[i + 1]] + 0.0722 * lum[px[i + 2]]);
      }
    vals.sort((a, b) => a - b);
    const bright = vals[Math.floor(vals.length * 0.8)] || 0; // bright patches matter more than the average
    const shown = bright * (Number(cvOp.value) / 100);
    const want = Math.max(MIN_TINT, Math.min(MAX_TINT, shown > 0 ? 1 - TARGET_L / shown : 0));
    tint = (tint === null || now) ? want : tint + (want - tint) * 0.25;
    centerCam.style.setProperty('--sc-tint', tint.toFixed(3));
  }
  centerCam.querySelector('img').addEventListener('load', () => measureContrast());
  setInterval(() => { if (src === 'mac' && webOn()) measureContrast(); }, 250); // Mac camera: no per-frame event, so sample 4×/s
  const play = $('play');
  play.after(recBtn); play.after(h(`<span class="cap-div"></span>`));
  const scriptsHead = document.querySelector('#left-rail .scripts-head');
  scriptsHead.before(takesSec);
  document.body.append(toastEl);
  document.querySelector('#setup .brand')?.before(strip);
  // Script card sits next to Camera and Mic; Go to Spotlight gets its own section; setup options go in a right sidebar
  {
    $('scScriptSlot').append($('script-input'));
    $('scScriptTools').append($('demo-btn'));
    $('scScriptNote').append($('screen-note'));
    $('scScriptSave').onclick = () => {
      const ta = $('script-input');
      if (!ta.value.trim()) { ta.focus(); return toast('Paste a script first.'); }
      $('save-script-btn').click(); toast('Script saved — it’s on the left.', 'ok');
    };
    document.querySelector('#setup .brand')?.classList.add('sc-gone');
    document.querySelector('#setup .sub')?.classList.add('sc-gone');
    document.querySelector('#setup .setup-row')?.classList.add('sc-gone');
    strip.after(goSec);
    goSec.append($('start-btn'), $('cancel-edit'));
    document.body.append(setupRail);
    // Spotlight is the only page: the save location sits at the very bottom of the left rail (above © shovonix).
    { const fs = $('scFolderRow').closest('.sec'), cr = document.querySelector('#left-rail .copyright'); if (cr) cr.before(fs); else takesSec.before(fs); fs.classList.add('sc-save-loc'); }
  }
  const hint = $('shortcuts-hint');
  if (hint) [['R', 'record camera + audio'], ['A', 'hold to autofocus'], ['← →', 'focus near / far (MF)'], ['G', 'grid']]
    .forEach(([k, t]) => hint.append(h(`<span>${k.split(' ').map(x => `<kbd>${x}</kbd>`).join('')} ${t}</span>`)));

  const ui = {
    camState: $('scCamState'), img: $('scImg'), grid: $('scGrid'), badge: $('scBadge'), badgeTime: $('scBadgeTime'),
    fps: $('scFps'), empty: $('scCamEmpty'), connect: $('scConnect'), info: $('scInfo'), af: $('scAF'), near: $('scNear'),
    far: $('scFar'), step: $('scStep'), stepVal: $('scStepVal'), gridBtn: $('scGridBtn'), big: $('scBig'),
    disconnect: $('scDisconnect'), problem: $('scProblem'), preview: $('scPreview'),
    micState: $('scMicState'), micOn: $('scMicOn'), mic: $('scMic'), meterWrap: $('scMeterWrap'), meterFill: $('scMeterFill'),
    meterPeak: $('scMeterPeak'), db: $('scDb'), clip: $('scClip'), folderName: $('scFolderName'),
    rec: recBtn, recLabel: $('scRecLabel'), takeList: $('scTakeList'), saveAll: $('scSaveAll'), 
    cCamState: $('scCardCamState'), cCamSub: $('scCardCamSub'), cCamBtn: $('scCardCamBtn'), cPreview: $('scCardPreview'), cPreviewBox: $('scCardPreviewBox'), micOff: $('scMicOff'),
    cMicState: $('scCardMicState'), cMicSub: $('scCardMicSub'), cMicBtn: $('scCardMicBtn'), cFill: $('scCardFill'), cPeak: $('scCardPeak'), cWaveMsg: $('scCardWaveMsg'), cDb: $('scCardDb'), cPreviewMsg: $('scCardPreviewMsg'), cPedalState: $('scCardPedalState'), cPedalSub: $('scCardPedalSub'), cPedalBtn: $('scCardPedalBtn'),
    problem2: $('scProblem2'), help: $('scHelp'), help2: $('scHelp2'),
    ccImg: $('scCenterImg'), ccGrid: $('scCenterGrid'), ccBadge: $('scCenterBadge'), ccTime: $('scCenterTime'),
    vid: $('scVid'), ccVid: $('scCenterVid'), camPick: $('scCamPick'), connectSub: $('scConnectSub'),
  };

  // ------------------------------------------------------------------ alert sounds
  // Short synthesized beeps (no sound files): start = two rising tones (Rise), stop = two falling (Fall), error = one low buzz (Buzz). Prompter play/pause stays silent.
  // One switch in the right rail turns them all on or off.
  let sfxCtx = null, sfxLastErr = 0;
  const sfxOn = () => store.get('sounds', true);
  const sfxWake = () => { try { sfxCtx ||= new AudioContext(); if (sfxCtx.state === 'suspended') sfxCtx.resume(); } catch {} };
  document.addEventListener('pointerdown', sfxWake, { capture: true });
  document.addEventListener('keydown', sfxWake, { capture: true });
  function sfx(kind) {
    if (!sfxOn()) return;
    if (kind === 'error') { const n = performance.now(); if (n - sfxLastErr < 1500) return; sfxLastErr = n; } // one alarm per problem
    sfxWake(); if (!sfxCtx) return;
    const tones = { start: [[660, 0, .09], [990, .11, .12]], stop: [[880, 0, .09], [520, .11, .14]], error: [[150, 0, .5]] }[kind];
    const t0 = sfxCtx.currentTime + .02;
    for (const [f, at, dur] of tones || []) {
      const o = sfxCtx.createOscillator(), g = sfxCtx.createGain();
      o.type = kind === 'error' ? 'sawtooth' : 'sine'; o.frequency.value = f;
      const v = kind === 'error' ? .08 : .2;
      g.gain.setValueAtTime(0, t0 + at); g.gain.linearRampToValueAtTime(v, t0 + at + .01); g.gain.setValueAtTime(v, t0 + at + dur - .03); g.gain.linearRampToValueAtTime(0, t0 + at + dur);
      o.connect(g).connect(sfxCtx.destination); o.start(t0 + at); o.stop(t0 + at + dur + .02);
    }
  }

  // Alert sounds switch: all beeps on or off together; turning it on plays a sample beep
  const soundBtn = soundSec.querySelector('#scSounds');
  const renderSoundBtn = () => soundBtn.setAttribute('aria-pressed', String(sfxOn()));
  soundBtn.onclick = () => { store.set('sounds', !sfxOn()); renderSoundBtn(); sfx('start'); };
  renderSoundBtn();

  // ------------------------------------------------------------------ toast
  let toastT;
  function toast(msg, kind = '') {
    if (kind === 'error') sfx('error');
    // popup-style card in the middle: icon, bold title, detail line (split at " — "), ✕, and a bar counting down to auto-close
    const i = msg.indexOf(' — '), title = i > 0 ? msg.slice(0, i) : msg, detail = i > 0 ? msg.slice(i + 3) : '';
    const icon = kind === 'error' ? '<svg viewBox="0 0 24 24"><path d="M12 2 1 21h22L12 2zm1 15h-2v-2h2v2zm0-4h-2V9h2v4z"/></svg>'
      : kind === 'ok' ? '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/></svg>';
    toastEl.innerHTML = `<span class="sc-toast-ic">${icon}</span><span class="sc-toast-txt"><b></b><span></span></span><button type="button" class="sc-toast-x" aria-label="Close">✕</button><i class="sc-toast-bar"></i>`;
    toastEl.querySelector('b').textContent = title; toastEl.querySelector('.sc-toast-txt span').textContent = detail;
    toastEl.querySelector('.sc-toast-x').onclick = () => { clearTimeout(toastT); toastEl.hidden = true; };
    toastEl.className = 'sc-toast ' + kind; toastEl.hidden = true; void toastEl.offsetWidth; toastEl.hidden = false; // restart the animations
    const ms = kind === 'error' ? 7000 : 4200; toastEl.style.setProperty('--toast-ms', ms + 'ms');
    clearTimeout(toastT); toastT = setTimeout(() => (toastEl.hidden = true), ms);
  }

  // ------------------------------------------------------------------ camera
  let lastUrl = null, big = null;
  function renderCam() {
    const on = cam.state === 'connected';
    ui.empty.hidden = on; ui.img.hidden = !on; ui.info.hidden = !on; ui.disconnect.hidden = !on;
    centerCam.hidden = !on; if (!on) ui.ccImg.removeAttribute('src');
    document.body.classList.toggle('sc-cam-bg', on);
    ui.connect.disabled = cam.state === 'connecting' || cam.state === 'unsupported';
    ui.connect.textContent = cam.state === 'connecting' ? 'Connecting…' : ui.connect.dataset.retry ? 'Try again' : 'Connect camera';
    ui.af.disabled = !on || !cam.has('af');
    ui.near.disabled = ui.far.disabled = ui.step.disabled = !on || !cam.has('mf');
    ui.gridBtn.disabled = ui.big.disabled = !on;
    if (!('documentPictureInPicture' in window)) { ui.big.disabled = true; ui.big.title = 'Needs Chrome 116 or newer'; }
    ui.camState.textContent = cam.recording ? 'Recording' : on ? (cam.model || 'Connected') : cam.state === 'connecting' ? 'Connecting' : cam.state === 'unsupported' ? 'Needs Chrome' : 'Off';
    ui.camState.className = 'sc-state' + (cam.recording ? ' rec' : on ? ' on' : '');
    if (!on) ui.fps.textContent = '';
    badge(ui.cCamState, cam.recording ? 'rec' : on ? 'on' : cam.state === 'connecting' ? 'wait' : 'off',
      cam.recording ? 'Recording' : on ? 'Ready' : cam.state === 'connecting' ? 'Connecting' : cam.state === 'unsupported' ? 'Needs Chrome' : 'Off');
    ui.cCamSub.textContent = on ? cameraName(cam.model) : 'USB · PC Remote · camera on';
    if (!on) { ui.cPreview.removeAttribute('src'); ui.cPreviewBox.classList.remove('live'); }
    ui.cPreviewMsg.textContent = on ? 'Waiting for preview…' : cam.state === 'connecting' ? 'Connecting…' : 'Camera off';
    ui.cCamBtn.querySelector('span').textContent = on ? 'Disconnect' : ui.connect.textContent;
    ui.cCamBtn.classList.toggle('primary', !on);
    ui.cCamBtn.disabled = ui.connect.disabled && !on;
    ui.help.hidden = ui.help2.hidden = on || cam.state === 'unsupported';
    sendStageCam();
    if (src === 'mac') renderMacCam();
    else {
      ui.vid.hidden = true; ui.connectSub.textContent = 'USB · PC Remote · Chrome on Mac'; ui.disconnect.textContent = 'Disconnect camera';
      if ('documentPictureInPicture' in window) ui.big.title = 'Large floating preview window';
    }
  }
  // Mac camera chosen: the same preview spots show its live video instead of the Sony frames.
  function renderMacCam() {
    const on = webOn(), busyW = web.state === 'connecting';
    ui.empty.hidden = on; ui.img.hidden = true; ui.vid.hidden = !on; ui.info.hidden = true; ui.disconnect.hidden = !on;
    centerCam.hidden = !on; document.body.classList.toggle('sc-cam-bg', on);
    ui.connect.disabled = busyW || !WebcamCore.supported;
    ui.connect.disabled = busyW || !WebcamCore.supported;
    ui.connect.textContent = busyW ? 'Starting…' : 'Connect camera';
    ui.connectSub.textContent = WebcamCore.supported ? (ui.camPick.selectedOptions[0]?.textContent || 'Mac camera') : 'Needs Chrome or Edge';
    ui.gridBtn.disabled = !on; ui.big.disabled = true; ui.big.title = 'Big preview works with the Sony';
    ui.disconnect.textContent = 'Turn off Mac camera';
    ui.camState.textContent = web.recording ? 'Recording' : on ? 'Mac camera' : busyW ? 'Starting' : 'Off';
    ui.camState.className = 'sc-state' + (web.recording ? ' rec' : on ? ' on' : '');
  }
  cam.addEventListener('state', e => {
    if (e.detail.state === 'connected') { store.set('camAuto', true); store.set('camEverConnected', true); ui.help.open = ui.help2.open = false; ui.problem.hidden = true; ui.problem2.hidden = true; delete ui.connect.dataset.retry; cam.startPreview(); }
    if (e.detail.state === 'disconnected') { sfx('error'); showCamProblem('nodevice', 'Camera unplugged or switched off.'); closeBig(); }
    if (['connected', 'disconnected', 'idle'].includes(e.detail.state)) fillCamPick(); // the USB entry shows the real model name
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
  // Right-rail preview takes the live view's real ratio (Sony is often 3:2, not 16:9), so it shows the true frame.
  // The center view stays cropped to fill.
  ui.img.addEventListener('load', () => {
    const w = ui.img.naturalWidth, hgt = ui.img.naturalHeight;
    if (w && hgt && src === 'sony') { const r = `${w} / ${hgt}`; if (ui.preview.style.aspectRatio !== r) ui.preview.style.aspectRatio = r; }
  });
  cam.addEventListener('frame', e => {
    const url = URL.createObjectURL(e.detail.blob);
    ui.img.src = url; ui.cPreview.src = url; ui.ccImg.src = url; ui.cPreviewBox.classList.add('live'); if (big) big.img.src = url;
    // Camera on Stage with a USB camera: pass frames on, at most 15 a second, so the scroll sync never waits
    const tNow = performance.now();
    if (stageCamCh && store.get('stageCam', false) && src === 'sony' && tNow - stageFrameT > 66) { stageFrameT = tNow; stageCamCh.postMessage({ type: 'frame', blob: e.detail.blob }); }
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

  // Connect camera: connects whichever camera is picked in the dropdown.
  const macDeviceId = () => camPick.startsWith('mac:') ? camPick.slice(4) : '';
  ui.connect.onclick = async () => {
    if (src === 'mac') { if (await web.open(macDeviceId())) { store.set('webOn', true); fillCamPick(); } return; }
    cam.connect({ pick: !(await cam.hasPermittedDevice()) });
  };
  ui.cCamBtn.onclick = () => (cam.state === 'connected' ? ui.disconnect.onclick() : ui.connect.onclick());
  ui.disconnect.onclick = () => {
    if (src === 'mac') {
      if (web.recording) return toast('Stop recording first.', 'error');
      store.set('webOn', false); web.close(); toast('Camera off.'); return;
    }
    if (cam.recording) return toast('Stop recording first.', 'error');
    store.set('camAuto', false); closeBig(); cam.disconnect(); toast('Camera released.');
  };

  // ---- Mac camera (instead of the Sony) ----
  web.addEventListener('state', () => {
    const s = web.stream;
    for (const v of [ui.vid, ui.ccVid]) if (v.srcObject !== s) { v.srcObject = s; if (s) v.play().catch(() => {}); }
    renderCam(); renderRec();
  });
  web.addEventListener('error', e => toast(e.detail.message, 'error'));
  // right-rail box takes the Mac camera's real ratio too
  const vidRatio = () => { if (ui.vid.videoWidth && src === 'mac') ui.preview.style.aspectRatio = `${ui.vid.videoWidth} / ${ui.vid.videoHeight}`; };
  ui.vid.addEventListener('loadedmetadata', vidRatio); ui.vid.addEventListener('resize', vidRatio);
  // ---- Camera dropdown: USB cameras that are plugged in (and allowed before) + every camera the Mac sees ----
  const usbName = d => { const n = cameraName(d?.productName || ''); return n === 'Connected' ? (d?.manufacturerName ? `${d.manufacturerName} camera` : 'USB camera') : n; };
  async function fillCamPick() {
    const vids = WebcamCore.supported ? await web.listDevices() : [];
    // Chrome only reports USB cameras you allowed before AND that are plugged in now; a new one needs "Add USB camera…".
    const usb = CamCore.supported ? await navigator.usb.getDevices().catch(() => []) : [];
    const opts = [];
    if (cam.state === 'connected') opts.push(['usb', `${cameraName(cam.model)} (USB)`]);
    else if (usb.length) opts.push(['usb', `${usbName(usb[0])} (USB)`]);
    // Before camera access is allowed, Chrome hides the names, so they show as one "Mac camera" entry.
    if (vids.length && vids.every(d => !d.label)) opts.push(['mac:', 'Mac camera']);
    else vids.forEach((d, i) => opts.push(['mac:' + d.deviceId, d.label || `Camera ${i + 1}`]));
    // the open camera (or the saved pick) must stay in the list
    const cur = src === 'mac' && webOn() ? 'mac:' + web.deviceId : camPick;
    if (cur.startsWith('mac') && !opts.some(o => o[0] === cur)) {
      const generic = opts.find(o => o[0] === 'mac:'); if (generic) generic[0] = cur; else opts.push([cur, web.label || 'Mac camera']);
    }
    if (CamCore.supported) opts.push(['usb:add', 'Add USB camera…']);
    ui.camPick.replaceChildren(...opts.map(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; return o; }));
    ui.camPick.value = cur;
    // the saved camera isn't here (e.g. USB camera unplugged): show the first camera that is, without connecting it
    if (ui.camPick.value !== cur && !take) {
      const first = opts.find(o => o[0] !== 'usb:add');
      if (first && !(src === 'sony' && cam.state === 'connecting')) { camPick = first[0]; src = camPick.startsWith('mac') ? 'mac' : 'sony'; document.body.dataset.src = src; ui.camPick.value = camPick; }
    }
    renderCam();
  }
  ui.camPick.onchange = async () => {
    const next = ui.camPick.value;
    if (take) { ui.camPick.value = camPick; return toast('Stop recording first.', 'error'); }
    if (next === 'usb:add') {
      // Chrome's USB picker; choosing a camera connects it and makes it the picked camera
      ui.camPick.value = camPick;
      const prev = { camPick, src };
      if (webOn()) web.close();
      camPick = 'usb'; src = 'sony'; document.body.dataset.src = src; ui.preview.style.aspectRatio = '';
      await cam.connect({ pick: true });
      if (cam.state === 'connected') store.set('camPick', 'usb');
      else { camPick = prev.camPick; src = prev.src; document.body.dataset.src = src; }
      fillCamPick(); renderCam(); renderRec();
      return;
    }
    const wasOn = src === 'mac' ? webOn() : cam.state === 'connected';
    camPick = next; store.set('camPick', next);
    const nextSrc = next.startsWith('mac') ? 'mac' : 'sony';
    // release the camera you're leaving
    if (src === 'sony' && nextSrc === 'mac' && cam.state === 'connected') { store.set('camAuto', false); closeBig(); cam.disconnect(); }
    if (src === 'mac' && (nextSrc === 'sony' || next !== 'mac:' + web.deviceId)) { web.close(); if (nextSrc === 'sony') store.set('webOn', false); }
    src = nextSrc; document.body.dataset.src = src; ui.preview.style.aspectRatio = '';
    // switching between two Mac cameras while one was on: open the new one straight away
    if (wasOn && src === 'mac') await ui.connect.onclick();
    renderCam(); renderRec();
  };
  navigator.mediaDevices?.addEventListener?.('devicechange', () => fillCamPick());
  if (CamCore.supported) { navigator.usb.addEventListener('connect', () => fillCamPick()); navigator.usb.addEventListener('disconnect', () => fillCamPick()); }
  // After a reload the Mac camera comes back if it was on (camera access is remembered, so no prompt).
  // Turned off, or a hard reload (Cmd+Shift+R): it stays off.
  fillCamPick().then(() => { if (src === 'mac' && store.get('webOn', false) && !webOn() && WebcamCore.supported) ui.connect.onclick(); });

  function badge(el, kind, text) { el.textContent = text; el.className = 'sc-status' + (kind === 'off' ? '' : ' ' + kind); }
  // Sony bodies report a model code (ILCE-7M3); show the name people know next to it.
  const SONY_NAMES = { 'ILCE-7M3': 'α7 III', 'ILCE-7RM3': 'α7R III', 'ILCE-7RM3A': 'α7R IIIA', 'ILCE-7M4': 'α7 IV', 'ILCE-7RM4': 'α7R IV', 'ILCE-7RM4A': 'α7R IVA', 'ILCE-7RM5': 'α7R V', 'ILCE-7SM3': 'α7S III', 'ILCE-7C': 'α7C', 'ILCE-7CM2': 'α7C II', 'ILCE-7CR': 'α7CR', 'ILCE-9': 'α9', 'ILCE-9M2': 'α9 II', 'ILCE-1': 'α1', 'ILCE-6100': 'α6100', 'ILCE-6400': 'α6400', 'ILCE-6600': 'α6600', 'ILCE-6700': 'α6700', 'ZV-E10': 'ZV-E10', 'ZV-E1': 'ZV-E1', 'ILME-FX3': 'FX3', 'ILME-FX30': 'FX30' };
  function cameraName(code) {
    const c = String(code || '').trim(); if (!c) return 'Connected';
    const k = Object.keys(SONY_NAMES).find(k => c.toUpperCase().startsWith(k) && !/[A-Z0-9]/.test(c.toUpperCase()[k.length] || ''));
    return k ? `Sony ${SONY_NAMES[k]} · ${c}` : c;
  }

  // pedal card (keys live in the prompter's state; index.html exposes them)
  function renderPedal() {
    const n = window.spaceCamPedal?.count() || 0;
    badge(ui.cPedalState, n ? 'on' : 'off', n ? 'Ready' : 'Off');
    ui.cPedalSub.textContent = n ? `${n} button${n > 1 ? 's' : ''} set` : 'Pedal or clicker for the prompter';
    ui.cPedalBtn.querySelector('span').textContent = n ? 'Edit buttons' : 'Set up';
  }
  ui.cPedalBtn.onclick = e => window.spaceCamPedal?.open(e.currentTarget);
  window.addEventListener('spacecam-pedal', renderPedal);
  renderPedal();

  // Reconnect by itself after a reload (or when the camera is plugged back in), unless you pressed Disconnect.
  async function autoConnect() {
    if (src !== 'sony' || !store.get('camAuto', false) || cam.state === 'connected' || cam.state === 'connecting' || cam.state === 'unsupported') return;
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
  function setGrid(on) { ui.grid.hidden = !on; ui.ccGrid.hidden = !on; ui.gridBtn.setAttribute('aria-pressed', String(on)); store.set('grid', on); if (big) big.grid.hidden = !on; }
  ui.gridBtn.onclick = () => setGrid(ui.grid.hidden);
  setGrid(store.get('grid', false));

  // big floating preview (Document Picture-in-Picture)
  async function openBig() {
    if (big) return closeBig();
    let w;
    try { w = await documentPictureInPicture.requestWindow({ width: 760, height: 470 }); }
    catch (e) { return toast('Could not open the big preview: ' + (e?.message || e), 'error'); }
    document.querySelectorAll('link[rel="stylesheet"][href^="studio.css"]').forEach(l => w.document.head.append(l.cloneNode()));
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
  const FLOOR = -50; // dB at the left edge; quiet room noise sits near the start instead of filling a third of the bar
  const toPct = db => Math.max(0, Math.min(100, (db - FLOOR) / -FLOOR * 100));
  audio.addEventListener('level', e => {
    const { clip } = e.detail;
    const now0 = performance.now(), dt = Math.min(0.1, (now0 - shownT) / 1000);
    // Calm meter: the bar follows loudness (RMS), rises quickly and falls slowly (~12 dB/s).
    const target = Math.max(e.detail.rmsDb, -120);
    shown = target > shown ? shown + (target - shown) * Math.min(1, dt * 18) : Math.max(target, shown - 12 * dt);
    shownT = now0;
    const peakDb = shown;
    const pct = toPct(peakDb);
    ui.meterFill.style.width = pct + '%'; ui.cFill.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    // The thin marker shows real peaks (held 1.5 s), so you still see how close you get to clipping.
    const now = performance.now(), p = e.detail.peakDb;
    if (p > peakHold || now - peakHoldT > 1500) { peakHold = p; peakHoldT = now; }
    ui.meterPeak.style.left = ui.cPeak.style.left = toPct(peakHold) + '%';
    ui.db.textContent = peakHold <= -119 ? "−∞ dB" : `peak ${peakHold.toFixed(0)} dB`;
    ui.cDb.textContent = ui.db.textContent;
    ui.clip.classList.toggle('on', clip);
    pushWave(e.detail.peakDb, clip, e.detail.rmsDb);
  });

  // ---- live waveform: voice-memo style bars, newest on the right. Shows the mic is alive; the tag says if it's recording.
  // Height follows loudness in dB (not raw amplitude), so a quiet built-in laptop mic still shows clear bars:
  // silence is a row of dots, normal speech stands tall. Display only; the recording itself is untouched.
  const WAVE_N = 300, waveHist = new Float32Array(WAVE_N), waveClip = new Uint8Array(WAVE_N);
  const WAVE_FLOOR = -58, WAVE_TOP = -14; // dB that maps to a dot / to a full-height bar
  const waveVal = db => Math.max(0, Math.min(1, (db - WAVE_FLOOR) / (WAVE_TOP - WAVE_FLOOR)));
  let waveHead = 0, waveLast = 0, waveAcc = -120, waveClipAcc = 0, waveRmsMin = 0, waveNow = 0, waveNowClip = 0, waveWasRec = false;
  // Not recording: the shape stays put and only breathes with the level (a fixed, speech-like profile, tapered at the ends).
  const waveProfile = Float32Array.from({ length: WAVE_N }, (_, i) => {
    const x = i / (WAVE_N - 1), taper = Math.sin(Math.PI * x) ** 0.6;
    const n = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1; // fixed pseudo-random, so it never moves
    return taper * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(i * 0.21) * Math.cos(i * 0.057)) * (0.6 + 0.4 * n));
  });
  // Room noise = the quiet level between words: the 10th percentile of loudness (RMS) over the last ~6 s.
  const NOISE_N = 150, noiseHist = new Float32Array(NOISE_N).fill(-120);
  let noiseHead = 0, noiseFilled = 0, noiseDb = null;
  const NOISY_DB = -50; // above this the room is noisy for voice recording
  const waves = [$('scWaveRail'), centerWave].map(el => {
    const tag = el.querySelector('.sc-wave-tag');
    const nz = document.createElement('span'); nz.className = 'sc-wave-noise'; el.append(nz);
    return { el, cv: el.querySelector('canvas'), tag, nz };
  });
  function pushWave(db, clip, rmsDb = -120) {
    waveAcc = Math.max(waveAcc, db); waveClipAcc |= clip ? 1 : 0;
    waveRmsMin = Math.min(waveRmsMin, rmsDb);
    const now = performance.now();
    if (now - waveLast < 40) return; // ~25 columns a second
    waveLast = now;
    const rec = audio.state === 'recording';
    if (rec && !waveWasRec) { waveHist.fill(0); waveClip.fill(0); } // the timeline starts when you press Record
    waveWasRec = rec;
    waveNow = waveNow * 0.5 + waveVal(waveAcc) * 0.5; waveNowClip = waveClipAcc;
    if (rec) { // recording: scroll, newest on the right
      waveHist[waveHead] = waveVal(waveAcc);
      waveClip[waveHead] = waveClipAcc;
      waveHead = (waveHead + 1) % WAVE_N;
    }
    waveAcc = -120; waveClipAcc = 0;
    noiseHist[noiseHead] = waveRmsMin; noiseHead = (noiseHead + 1) % NOISE_N; noiseFilled = Math.min(NOISE_N, noiseFilled + 1); waveRmsMin = 0;
    if (noiseFilled >= 25) { const s = Array.from(noiseHist.subarray(0, noiseFilled)).sort((a, b) => a - b); noiseDb = s[Math.floor(s.length * 0.1)]; }
    for (const w of waves) if (!w.el.hidden) drawLiveWave(w);
  }
  function drawLiveWave({ cv, nz }) {
    const dpr = window.devicePixelRatio || 1, W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
    if (!W || !H) return;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d'), rec = audio.state === 'recording';
    g.clearRect(0, 0, W, H);
    // rounded bars, 3px wide with 3px gaps; the quietest is a dot
    const bw = 3 * dpr, pitch = 6 * dpr, n = Math.min(WAVE_N, Math.floor((W + pitch - bw) / pitch));
    const x0 = W - ((n - 1) * pitch + bw), mid = H / 2, dot = bw, live = Math.min(1, waveNow * 1.25);
    for (let i = 0; i < n; i++) {
      // recording: the newest n columns of the timeline. Not recording: the still profile scaled by the live level.
      const k = (waveHead - n + i + WAVE_N) % WAVE_N;
      const v = rec ? waveHist[k] : live * waveProfile[Math.round(i * (WAVE_N - 1) / Math.max(1, n - 1))];
      const h = Math.max(dot, v * H), x = x0 + i * pitch;
      g.fillStyle = rec && waveClip[k] ? '#E5484D' : v > 0.02 ? (rec ? 'rgba(255,255,255,.92)' : 'rgba(255,255,255,.6)') : 'rgba(255,255,255,.32)';
      g.beginPath(); g.roundRect(x, mid - h / 2, bw, h, bw / 2); g.fill();
    }
    if (!rec && waveNowClip) { g.fillStyle = '#E5484D'; g.fillRect(0, 0, dpr * 3, H); g.fillRect(W - dpr * 3, 0, dpr * 3, H); } // clipping right now: red edges
    if (noiseDb !== null) {
      const noisy = noiseDb > NOISY_DB;
      nz.textContent = `Room noise ${noiseDb <= -119 ? '−∞' : '−' + Math.abs(Math.round(noiseDb))} dB${noisy ? ' · noisy' : ''}`;
      nz.classList.toggle('noisy', noisy);
    } else nz.textContent = '';
  }
  function renderWave() {
    const on = audio.state !== 'off', rec = audio.state === 'recording';
    for (const w of waves) {
      w.el.hidden = !on;
      w.el.classList.toggle('rec', rec);
      w.tag.querySelector('b').textContent = rec ? 'Recording audio' : 'Mic on · not recording';
      if (on) drawLiveWave(w);
    }
    document.body.classList.toggle('sc-wave-on', on);
    if (!on) { waveHist.fill(0); waveClip.fill(0); noiseHist.fill(-120); noiseFilled = 0; noiseDb = null; }
  }
  function renderMic() {
    const on = audio.state !== 'off';
    ui.micOn.hidden = on; ui.mic.hidden = !on; ui.meterWrap.hidden = !on;
    ui.micState.textContent = audio.state === 'recording' ? 'Recording' : on ? 'Ready' : 'Off';
    ui.micState.className = 'sc-state' + (audio.state === 'recording' ? ' rec' : on ? ' on' : '');
    ui.mic.disabled = audio.state === 'recording';
    badge(ui.cMicState, audio.state === 'recording' ? 'rec' : on ? 'on' : 'off', audio.state === 'recording' ? 'Recording' : on ? 'Ready' : 'Off');
    ui.cMicSub.textContent = on ? audio.deviceLabel : 'Any mic your Mac sees';
    ui.micOff.hidden = !on;
    if (!on) { ui.cFill.style.clipPath = 'inset(0 100% 0 0)'; ui.cPeak.style.left = '0%'; ui.cDb.textContent = 'Mic off'; }
    ui.cPeak.hidden = !on;
    ui.cMicBtn.querySelector('span').textContent = on ? 'Disconnect' : 'Connect mic';
    $('scMicNote').hidden = on; $('scMicTip').hidden = !on;
    ui.cMicBtn.classList.toggle('primary', !on);
    ui.cMicBtn.disabled = audio.state === 'recording';
    renderWave();
  }
  async function openMic(id) {
    const ok = await audio.open(id ?? store.get('micId', ''));
    if (ok) { store.set('micId', audio.deviceId); store.set('micAuto', true); await fillMics(); }
    renderRec();
  }
  ui.micOn.onclick = () => openMic();
  async function closeMic() {
    if (take || audio.state === 'recording') return toast('Stop recording first.', 'error');
    store.set('micAuto', false); await audio.close(); renderMic(); renderRec(); toast('Mic disconnected.');
  }
  ui.cMicBtn.onclick = () => (audio.state !== 'off' ? closeMic() : openMic());
  ui.micOff.onclick = closeMic;
  ui.mic.onchange = () => openMic(ui.mic.value);
  if (!AudioCore.supported) { ui.micOn.disabled = ui.cMicBtn.disabled = true; ui.micOn.querySelector('span').textContent = ui.cMicBtn.querySelector('span').textContent = 'Audio needs Chrome'; }
  renderMic();
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
  // Save location: shows where takes go (Downloads, or the chosen folder's name); the small pencil changes it.
  async function renderFolder() {
    const ok = await folderOk(false), row = $('scFolderRow');
    ui.folderName.textContent = folder ? folder.name : 'Downloads';
    row.classList.toggle('needs-ok', !!folder && !ok);
    row.title = !folder ? 'Takes go to your Downloads folder. Click to choose another folder.' : ok ? 'Takes are saved in this folder. Click to choose another.' : 'Click to allow Space Cam to save here again';
  }
  async function pickFolder() {
    if (!window.showDirectoryPicker) return toast('Choosing a folder needs Chrome or Edge.', 'error');
    try { folder = await showDirectoryPicker({ id: 'spacecam-takes', mode: 'readwrite' }); await idb.set('folder', folder); store.set('folderChoice', 'folder'); }
    catch (e) { if (e?.name !== 'AbortError') toast('Could not use that folder: ' + (e?.message || e), 'error'); }
    renderFolder(); flushWaiting();
  }
  // Left panel can be hidden for more prompter width: « at its top hides it, the » tab on the left edge brings it back.
  // Remembered between visits. The prompter re-fits its text to the new width (it listens for resize).
  {
    const lr = $('left-rail');
    if (lr) {
      const hideBtn = h(`<button type="button" class="sc-rail-hide" title="Hide this panel" aria-label="Hide the left panel"><svg viewBox="0 0 24 24"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg></button>`);
      // while hidden, the brand stays: logo + "Space Cam" + version, with » to bring the panel back
      const showTab = h(`<button type="button" class="sc-rail-show" title="Show takes and scripts" aria-label="Show the left panel"><img class="sc-rs-logo" alt=""><span class="sc-rs-text"><b>Space Cam</b><small class="sc-rs-ver"></small></span><svg viewBox="0 0 24 24"><path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/></svg></button>`);
      const syncBrand = () => { const lg = lr.querySelector('.brand-logo'); if (lg) showTab.querySelector('.sc-rs-logo').src = lg.src; showTab.querySelector('.sc-rs-ver').textContent = ($('build-meta')?.textContent || '').trim(); };
      lr.append(hideBtn); document.body.append(showTab);
      // Hidden panel: touching the LEFT EDGE of the screen peeks it in over the script (no layout change); it goes
      // as soon as the mouse leaves it. Clicking the corner header pins it back (normal layout). The header itself
      // doesn't react to hover, so it's easy to click.
      const edge = h(`<div class="sc-rail-edge" aria-hidden="true"></div>`); document.body.append(edge);
      const peek = on => document.body.classList.toggle('sc-left-peek', on);
      edge.addEventListener('mouseenter', () => { if (document.body.classList.contains('sc-left-hidden')) peek(true); });
      lr.addEventListener('mouseleave', () => { if (document.body.classList.contains('sc-left-peek')) peek(false); });
      const setLeft = hidden => {
        if (hidden) syncBrand();
        peek(false);
        document.body.classList.toggle('sc-left-hidden', hidden);
        store.set('leftHidden', hidden);
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
      };
      hideBtn.onclick = () => setLeft(true);
      // The logo and the "Space Cam" name hide/show the panel. (No link to shovonix.dev: Chrome would bring that tab
      // to the front and pull focus away from Space Cam; a page can't open a tab in the background.)
      $('brand-home-btn')?.addEventListener('click', () => setLeft(true));
      showTab.onclick = () => setLeft(false);
      if (store.get('leftHidden', false)) { setLeft(true); setTimeout(syncBrand, 500); } // version text fills in a moment after load
    }
  }
  // Install app button: hidden while testing on localhost, shown on the live site to anyone who hasn't installed it
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) document.body.classList.add('sc-local');
  // "+" next to Scripts: blank New script popup to paste a script
  { const nb = $('new-script-btn'); if (nb) { nb.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>'; nb.title = 'New script'; nb.setAttribute('aria-label', 'New script'); } }
  // the "Two screens" note left the left panel; the same help shows when you hover Connect stage
  { const db = $('display-btn'); if (db) { db.removeAttribute('title'); db.dataset.tip = 'Opens the Stage window for your prompter screen (second display). It shows the mirrored view the camera reads; this window stays readable.'; } }
  $('scFolderRow').onclick = async () => {
    if (folder && !(await folderOk(false))) { await folderOk(true); renderFolder(); flushWaiting(); return; }
    pickFolder();
  };

  // First Record without a save folder: ask once. With a folder, every take (MP3 + video) is written straight
  // into it, no browser save boxes. Downloads stays possible (Chrome may then ask per file, if set to).
  function askSaveLocation() {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (done) return; done = true; resolve(v); };
      const m = modal(`
        <div class="sc-modal-head"><div class="sc-modal-title">Where should takes be saved?</div><button type="button" class="sc-modal-x" data-close aria-label="Close">✕</button></div>
        <p class="sc-modal-p">Pick a folder once and every take (MP3 audio, and video from a Mac camera) is saved there automatically, with no save boxes. You can change it any time under Save location, top left.</p>
        <p class="sc-modal-p" style="color:var(--fg-dim);font-size:12.5px">Downloads works too, but if Chrome is set to ask where to save each file, you'll get a save box per file.</p>
        <div class="sc-modal-row"><button type="button" class="btn ghost sc-use-dl">Use Downloads</button><button type="button" class="btn primary sc-pick">Choose folder</button></div>`,
        { onClose: () => finish('cancel') });
      m.wrap.querySelector('.sc-use-dl').onclick = () => { store.set('folderChoice', 'downloads'); finish('ok'); m.close(); };
      m.wrap.querySelector('.sc-pick').onclick = async () => {
        if (!window.showDirectoryPicker) { toast('Choosing a folder needs Chrome or Edge.', 'error'); return; }
        try { folder = await showDirectoryPicker({ id: 'spacecam-takes', mode: 'readwrite' }); await idb.set('folder', folder); }
        catch (e) { if (e?.name !== 'AbortError') toast('Could not use that folder: ' + (e?.message || e), 'error'); return; }
        store.set('folderChoice', 'folder'); renderFolder(); finish('ok'); m.close();
      };
      m.wrap.querySelector('.sc-pick').focus();
    });
  }
  idb.get('folder').then(f => { folder = f || null; renderFolder(); syncTakesWithFolder(); }).catch(() => renderFolder());

  // Cards follow the folder: a take whose files are all gone from its folder (deleted or moved in Finder) loses its
  // card. Only checks when Chrome already allows the folder (never prompts). Takes not in a folder are left alone.
  let syncing = false;
  async function syncTakesWithFolder() {
    if (syncing || take) return;
    syncing = true;
    try {
      const gone = [];
      for (const t of takes) {
        const names = [t.audio === 'folder' && t.name, t.video === 'folder' && t.videoName].filter(Boolean);
        if (!names.length || t.saving) continue;
        const dir = (await idb.get('dir:' + t.id).catch(() => null)) || folder;
        if (!dir) continue;
        let p; try { p = await dir.queryPermission({ mode: 'readwrite' }); } catch { continue; }
        if (p !== 'granted') continue;
        let left = 0;
        for (const n of names) { try { await dir.getFileHandle(n); left++; } catch (e) { if (e?.name !== 'NotFoundError') left++; } }
        const browserCopy = t.audio === 'kept' || t.video === 'kept' || t.audio === 'browser' || t.video === 'browser';
        if (!left && !browserCopy) gone.push(t);
      }
      if (gone.length) {
        gone.forEach(t => idb.set('thumb:' + t.id, null).catch(() => {}));
        takes = takes.filter(t => !gone.includes(t)); saveTakes(); renderTakes();
      }
    } finally { syncing = false; }
  }
  window.addEventListener('focus', () => syncTakesWithFolder());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncTakesWithFolder(); });

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

  // Take_1, Take_2 … one counter that never goes back, so names never repeat in Downloads
  function nextNo() {
    const used = takes.filter(t => !t.demo && t.series === 'st').reduce((m, t) => Math.max(m, t.no || 0), 0);
    const n = Math.max(used, store.get('takeCounter', 0)) + 1;
    store.set('takeCounter', n);
    return n;
  }

  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    rename: '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75z"/></svg>',
    del: '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    video: '<svg viewBox="0 0 24 24"><path d="M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
    swap: '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75z"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 00-2 2v14h2V3h12V1zm3 4H8a2 2 0 00-2 2v14a2 2 0 002 2h11a2 2 0 002-2V7a2 2 0 00-2-2zm0 16H8V7h11v14z"/></svg>',
    info: '<svg viewBox="0 0 24 24"><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16z"/></svg>',
  };
  const takeLabel = t => t.label || (t.recovered ? 'Recovered take' : (t.shoot ? `${t.shoot} · ` : '') + `Take ${pad(t.no)}`);
  const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fullDate = d => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + ` · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  // Audio records as WAV (crash-safe) and leaves Space Cam as MP3. A take already saved keeps its own extension.
  const outExt = t => ((t.audio === 'folder' || t.audio === 'saved') && /\.[a-z0-9]+$/i.exec(t.name || '')?.[0]) || '.mp3';
  const safeFileName = (label, t) => {
    const base = label.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().replace(/\.(wav|mp3)$/i, '').slice(0, 80) || `Take-${pad(t.no || 0)}`;
    return base + outExt(t);
  };
  const toMp3Name = n => n.replace(/\.wav$/i, '') + '.mp3';
  const isWav = f => /\.wav$/i.test(f?.name || '') || f?.type === 'audio/wav';
  // WAV → MP3 (320 kbps) in a worker, so the page stays responsive. Long takes take a little while.
  function wavToMp3(file) {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./mp3-encode.worker.js' + V, import.meta.url));
      let shown = -1;
      w.onmessage = e => {
        const m = e.data;
        if (m.ev === 'progress') { const p = Math.floor(m.p * 10) * 10; if (p !== shown && file.size > 20e6) { shown = p; toast(`Making MP3… ${p}%`); } }
        else { w.terminate(); m.ev === 'done' ? resolve(m.blob) : reject(new Error(m.message)); }
      };
      w.onerror = e => { w.terminate(); reject(new Error(e.message || 'MP3 encoder failed')); };
      w.postMessage({ file, kbps: 320 });
    });
  }
  async function writeToFolder(dir, name, blob) {
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(blob); await w.close();
  }
  async function saveBlobAs(blob, name, desc, mime, ext) {
    if (window.showSaveFilePicker) {
      const h = await showSaveFilePicker({ suggestedName: name, types: [{ description: desc, accept: { [mime]: [ext] } }] });
      await writeToFolderHandle(h, blob); return h.name;
    }
    downloadBlob(blob, name); return name;
  }
  async function writeToFolderHandle(h, blob) { const w = await h.createWritable(); await w.write(blob); await w.close(); }
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  t_ids();
  function t_ids() { takes.forEach(t => { if (!t.id) t.id = 't' + (t.startedAt || Date.now()).toString(36) + Math.random().toString(36).slice(2, 6); }); }

  // Where a take's audio lives right now: { file } or { missing: true }
  async function takeFile(t) {
    if (t.audio === 'browser' || t.audio === 'sample' || t.audio === 'kept') { try { return { file: await audio.getStoredFile(t.name) }; } catch { return { missing: true }; } }
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
  function modal(inner, { wide = false, take = false, onClose = null } = {}) {
    const wrap = h(`<div class="sc-modal"><div class="sc-modal-card${wide ? ' sc-modal-wide' : ''}${take ? ' sc-modal-take' : ''}" role="dialog" aria-modal="true">${inner}</div></div>`);
    const close = () => { onClose?.(); wrap.querySelectorAll('audio').forEach(a => { a.pause(); if (a.src) URL.revokeObjectURL(a.src); }); wrap.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
    wrap.querySelectorAll('[data-close]').forEach(b => (b.onclick = close));
    document.addEventListener('keydown', onKey, true);
    document.body.append(wrap);
    return { wrap, close };
  }
  // Shared confirm popup (also used by the prompter's script delete): resolves true on the red button, false otherwise
  window.spaceCamConfirm = (title, text, okLabel = 'Delete') => new Promise(resolve => {
    let done = false; const finish = v => { if (!done) { done = true; resolve(v); } };
    const m = modal(`
      <div class="sc-modal-head"><div class="sc-modal-title">${esc(title)}</div><button type="button" class="sc-modal-x" data-close aria-label="Close">✕</button></div>
      <p class="sc-modal-p">${esc(text)}</p>
      <div class="sc-modal-row"><button type="button" class="btn ghost" data-close>Cancel</button><button type="button" class="btn primary danger sc-ok">${esc(okLabel)}</button></div>`, { onClose: () => finish(false) });
    const ok = m.wrap.querySelector('.sc-ok'); ok.focus();
    ok.onclick = () => { finish(true); m.close(); };
  });
  const esc = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ---- inline player inside an opened take card: waveform + play/pause + seek ----
  let openTakeId = null, player = null;
  function stopPlayer() {
    if (!player) return;
    player.audio.pause(); URL.revokeObjectURL(player.url); cancelAnimationFrame(player.raf);
    player = null;
  }
  function toggleTakeOpen(t) { openTakeModal(t); }

  // Where a take's Mac-camera video lives: { file } or { missing } / { denied }
  async function takeVideoFile(t) {
    if (!t.videoName) return { none: true };
    if (t.video === 'browser' || t.video === 'kept') { try { return { file: await web.getStoredFile(t.videoName) }; } catch { return { missing: true }; } }
    if (t.video === 'folder') {
      const dir = (await idb.get('dir:' + t.id)) || folder;
      if (!dir) return { missing: true };
      let p = await dir.queryPermission({ mode: 'readwrite' });
      if (p === 'prompt') { try { p = await dir.requestPermission({ mode: 'readwrite' }); } catch {} }
      if (p !== 'granted') return { denied: true };
      try { return { file: await (await dir.getFileHandle(t.videoName)).getFile() }; } catch { return { missing: true }; }
    }
    return { missing: true };
  }

  // One click saves the whole take: MP3 (made from the WAV if needed) and the Mac-camera video, together.
  async function downloadAll(t) {
    const got = [];
    if (['folder', 'browser', 'sample', 'kept'].includes(t.audio)) {
      if (await downloadTake(t, true)) { got.push('MP3'); if (t.audio === 'browser') { t.audio = 'kept'; delete t.recovered; } }
    }
    if (t.videoName && t.video && t.video !== 'none') {
      const r = await takeVideoFile(t);
      if (r.file) {
        const ext = /\.[a-z0-9]+$/i.exec(t.videoName)?.[0] || '.mp4';
        downloadBlob(r.file, (t.label ? safeFileName(t.label, { ...t, audio: 'none' }).replace(/\.mp3$/i, '') : t.videoName.replace(/\.[a-z0-9]+$/i, '')) + ext);
        got.push('video'); if (t.video === 'browser') t.video = 'kept';
      }
    }
    saveTakes(); renderTakes();
    if (got.length) toast(`${takeLabel(t)} downloaded: ${got.join(' + ')}.`, 'ok');
    else toast('Nothing to download for this take.', 'error');
    return got.length > 0;
  }

  async function takeDir(t) { return (t && (await idb.get('dir:' + t.id).catch(() => null))) || folder; }

  // ---- Take preview popup: video (or where it is), audio player; Delete (removes the files) and Open folder.
  // ---- Take popup: all takes listed on the left (newest first), the selected take on the right.
  // Click another take to switch in place (no closing/reopening). Rename, play, delete as before.
  async function openTakeModal(t, { edit = false } = {}) {
    if (!t) return;
    stopPlayer();
    let vUrl = null, cur = null;
    const m = modal(`<div class="sc-pop-bar"><span class="sc-pop-label">Recordings</span><span class="sc-pop-right"><span class="sc-modal-hint"><kbd>Esc</kbd> close</span><button type="button" class="sc-modal-x" data-close aria-label="Close">✕</button></span></div><div class="sc-tb"><div class="sc-tb-list" role="listbox" aria-label="Recordings"></div><div class="sc-tb-pane"></div></div>`,
      { take: true, onClose: () => { cur = null; stopPlayer(); if (vUrl) URL.revokeObjectURL(vUrl); vUrl = null; } });
    m.wrap.querySelector('.sc-modal-card').classList.add('sc-modal-takes');
    const list = m.wrap.querySelector('.sc-tb-list'), pane = m.wrap.querySelector('.sc-tb-pane');
    function renderList() {
      list.replaceChildren(...takes.slice().reverse().map(tk => {
        const hasV = !!(tk.videoName && tk.video && tk.video !== 'none');
        const b = h(`<button type="button" class="sc-tb-item${tk === cur ? ' on' : ''}" role="option" aria-selected="${tk === cur}" data-id="${esc(tk.id)}">
          <span class="sc-take-thumb sc-tb-thumb"></span>
          <span class="sc-tb-txt"><span class="sc-tb-name">${esc(takeLabel(tk))}</span><span class="sc-tb-meta">${esc(whenLabel(tk.startedAt))}${tk.seconds != null ? ' · ' + fmt(tk.seconds) : ''}</span></span></button>`);
        fillThumb(b.querySelector('.sc-tb-thumb'), tk, hasV);
        b.onclick = () => { if (tk !== cur) show(tk); };
        return b;
      }));
    }
    async function show(t, { edit = false } = {}) {
      stopPlayer(); if (vUrl) { URL.revokeObjectURL(vUrl); vUrl = null; }
      cur = t;
      list.querySelectorAll('.sc-tb-item').forEach(el => { const on = el.dataset.id === t.id; el.classList.toggle('on', on); el.setAttribute('aria-selected', on); if (on) el.scrollIntoView({ block: 'nearest' }); });
      const hasAudio = ['folder', 'browser', 'sample', 'kept'].includes(t.audio);
      const hasVideo = !!(t.videoName && t.video && t.video !== 'none');
      const inFolder = t.audio === 'folder' || t.video === 'folder';
      const browserOnly = t.audio === 'browser' || t.video === 'browser';
      const sub = [whenLabel(t.startedAt), t.seconds != null ? fmt(t.seconds) : ''].filter(Boolean).join(' · ');
      const right = browserOnly && folder ? `<button type="button" class="btn primary sc-take-save">${ICON.save}<span>Save to folder</span></button>` : '';
      // where the files are, in words: the chosen folder's name, Downloads, or not saved yet
      const tdir = inFolder ? await takeDir(t) : null;
      if (cur !== t) return;
      const savedIn = t.demo ? 'Sample take' : inFolder ? `Saved in “${esc(tdir?.name || t.folderName || 'your folder')}”` : (t.audio === 'kept' || t.video === 'kept' || t.audio === 'saved') ? 'Saved in Downloads' : browserOnly ? 'Not saved to a folder yet' : t.demo ? 'Sample take' : '';
      pane.innerHTML = `
        <div class="sc-modal-head">
          <div class="sc-take-namebox"><div class="sc-take-nameline"><input class="sc-take-name" value="${esc(takeLabel(t))}" maxlength="80" spellcheck="false" aria-label="Take name — click to rename" title="Click to rename"><button type="button" class="sc-take-namepen" title="Rename" aria-label="Rename">${ICON.rename}</button></div><div class="sc-modal-name">${esc(sub)}</div></div>
        </div>
        <div class="sc-take-video"></div>
        <div class="sc-tp sc-take-audio"></div>
        <div class="sc-modal-row">
          <span class="sc-modal-hint sc-saved-in">${savedIn}</span>
          ${right}
          <button type="button" class="btn primary sc-take-rename-save" hidden>Save</button>
          <button type="button" class="sc-take-del" title="Delete take (deletes its files)" aria-label="Delete take">${ICON.del}</button>
        </div>`;
      const vbox = pane.querySelector('.sc-take-video'), abox = pane.querySelector('.sc-take-audio');
      // name at the top is editable: Save shows up only once it's changed (Enter saves, Esc puts it back)
      const nameIn = pane.querySelector('.sc-take-name'); let saveBtn = pane.querySelector('.sc-take-rename-save');
      const changed = () => { const v = nameIn.value.trim(); return !!v && v !== takeLabel(t); };
      // size the name box to the real text width, so the pencil sits right after the name
      const meas = document.createElement('canvas').getContext('2d');
      const fit = () => { const cs = getComputedStyle(nameIn); meas.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; nameIn.style.width = Math.ceil(Math.max(40, meas.measureText(nameIn.value || ' ').width) + 22) + 'px'; };
      fit(); document.fonts?.ready.then(fit); // again once the web font has loaded
      nameIn.oninput = () => { saveBtn.hidden = !changed(); fit(); };
      pane.querySelector('.sc-take-namepen').onclick = () => { nameIn.focus(); nameIn.select(); };
      const doRename = async () => {
        if (!changed()) return;
        saveBtn.disabled = true;
        const ok = await applyRename(t, nameIn.value);
        saveBtn.disabled = false;
        if (ok) { renderList(); nameIn.value = takeLabel(t); fit(); saveBtn.hidden = true; nameIn.blur(); const fl = pane.querySelector('.sc-tp-file'); if (fl) fl.textContent = [t.audio === 'folder' ? t.name : '', t.video === 'folder' ? t.videoName : ''].filter(Boolean).join(' · ') || fl.textContent; }
      };
      saveBtn.onclick = doRename;
      nameIn.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); doRename(); }
        else if (e.key === 'Escape' && changed()) { e.preventDefault(); e.stopPropagation(); nameIn.value = takeLabel(t); fit(); saveBtn.hidden = true; }
      });
      if (edit) { nameIn.focus(); nameIn.select(); }
      // trash: confirm right here in the bottom row (no second popup, no flash)
      const row = pane.querySelector('.sc-modal-row'), rowHtml = row.innerHTML;
      const askDelete = async () => {
        const plan = await deletePlan(t);
        row.classList.add('sc-del-confirm');
        row.innerHTML = `<p class="sc-del-msg">${plan.msg}</p><button type="button" class="btn ghost sc-del-no">Cancel</button><button type="button" class="btn primary danger sc-del-yes">Delete</button>`;
        row.querySelector('.sc-del-yes').focus();
        row.querySelector('.sc-del-no').onclick = () => { row.classList.remove('sc-del-confirm'); row.innerHTML = rowHtml; wireRow(); };
        row.querySelector('.sc-del-yes').onclick = async () => { if (await doDelete(t, plan)) { const next = takes[takes.length - 1]; if (next) { renderList(); show(next); } else m.close(); } };
      };
      const wireRow = () => {
        row.querySelector('.sc-take-del').onclick = askDelete;
        row.querySelector('.sc-take-save')?.addEventListener('click', async () => { m.close(); await saveTake(t); });
        const sb = row.querySelector('.sc-take-rename-save'); if (sb) { saveBtn = sb; sb.hidden = !changed(); sb.onclick = doRename; }
      };
      wireRow();
      // video: the Mac-camera MP4 plays in step with the audio player; a USB camera keeps its clip on its card
      let vid = null;
      if (hasVideo) {
        const r = await takeVideoFile(t);
        if (cur !== t) return;
        if (r.file) {
          vUrl = URL.createObjectURL(r.file);
          vbox.innerHTML = `<video playsinline preload="auto" ${hasAudio ? 'muted' : 'controls'}></video>`;
          vid = vbox.querySelector('video'); vid.src = vUrl;
        } else vbox.innerHTML = `<div class="sc-take-vnote">${r.denied ? 'Allow access to the save folder to show the video.' : 'The video file was moved or deleted.'}</div>`;
      } else if (t.camera) {
        vbox.innerHTML = `<div class="sc-take-vnote sc-take-sd">${ICON.video}<span>The video for this take is on the camera’s memory card.</span></div>`;
      } else vbox.remove();
      if (hasAudio) {
        await mountPlayer(t, abox);
        if (cur !== t) return;
        if (vid && player) { // audio drives the picture: play, pause and seeking move both
          const a = player.audio;
          a.addEventListener('play', () => { vid.currentTime = a.currentTime; vid.play().catch(() => {}); });
          a.addEventListener('pause', () => vid.pause());
          a.addEventListener('seeked', () => { vid.currentTime = a.currentTime; });
          a.addEventListener('timeupdate', () => { if (Math.abs(vid.currentTime - a.currentTime) > 0.25) vid.currentTime = a.currentTime; });
        }
      } else abox.innerHTML = '<div class="sc-take-vnote">No audio was recorded with this take.</div>';
      renderScriptPart(t, pane);

    }
    renderList(); show(t, { edit });
  }

  // Popup Delete: removes the take's files from the folder (and any browser copy), then its card. Permanent.
  // Delete a take: its files in the folder (and any browser copy), then its card. Permanent.
  // deletePlan() = what will happen (text for the confirm); doDelete() = do it. Returns true when done.
  async function deletePlan(t) {
    const dir = await takeDir(t);
    const files = [t.audio === 'folder' && t.name, t.video === 'folder' && t.videoName].filter(Boolean);
    const where = dir ? ` from “${esc(dir.name)}”` : '';
    const inDownloads = t.audio === 'kept' || t.video === 'kept' || t.audio === 'saved';
    const neverSaved = t.audio === 'browser' || t.video === 'browser';
    const msg = [
      files.length && `This deletes ${files.map(f => '<b>' + esc(f) + '</b>').join(' and ')}${where} on your Mac. It can’t be undone (it doesn’t go to the Trash).`,
      inDownloads && 'Its copy in Downloads can’t be deleted from here; delete it in Finder if you don’t need it.',
      neverSaved && 'This take was never saved to a folder, so deleting removes it for good.',
      t.demo && 'This removes the sample take.',
      t.camera && 'The clip on the camera’s memory card isn’t touched.',
    ].filter(Boolean).join(' ') || 'This removes the take from the list.';
    return { dir, files, msg };
  }
  async function doDelete(t, plan) {
    const { dir, files } = plan || await deletePlan(t), failed = [];
    if (files.length && dir) {
      if (!(await folderOkFor(dir, true))) failed.push(...files);
      else for (const f of files) { try { await dir.removeEntry(f); } catch (e) { if (e?.name !== 'NotFoundError') failed.push(f); } }
    }
    if (['browser', 'kept', 'sample'].includes(t.audio)) await audio.deleteStored(t.name).catch(() => {});
    if (['browser', 'kept'].includes(t.video)) await web.deleteStored(t.videoName).catch(() => {});
    if (failed.length) { toast(`Couldn’t delete ${failed.join(', ')} — allow access to the folder and try again.`, 'error'); return false; }
    idb.set('thumb:' + t.id, null).catch(() => {});
    takes = takes.filter(x => x !== t); saveTakes(); renderTakes();
    toast(`${takeLabel(t)} deleted.`, 'ok');
    return true;
  }
  // card trash icon: small confirm popup
  async function deleteTakeFiles(t) {
    const plan = await deletePlan(t);
    const m = modal(`
      <div class="sc-modal-head"><div class="sc-modal-title">Delete “${esc(takeLabel(t))}”?</div><button type="button" class="sc-modal-x" data-close aria-label="Close">✕</button></div>
      <p class="sc-modal-p">${plan.msg}</p>
      <div class="sc-modal-row"><button type="button" class="btn ghost" data-close>Cancel</button><button type="button" class="btn primary danger sc-ok">Delete</button></div>`);
    m.wrap.querySelector('.sc-ok').onclick = async () => { await doDelete(t, plan); m.close(); };
  }
  async function folderOkFor(dir, ask) {
    let p = await dir.queryPermission({ mode: 'readwrite' });
    if (p === 'prompt' && ask) { try { p = await dir.requestPermission({ mode: 'readwrite' }); } catch {} }
    return p === 'granted';
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

  // Waveform helpers for MP3 takes
  function resamplePeaks(src, n) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) { const a = Math.floor(i * src.length / n), b = Math.max(a + 1, Math.floor((i + 1) * src.length / n)); let m = 0; for (let k = a; k < b && k < src.length; k++) m = Math.max(m, src[k]); out[i] = m; }
    return out;
  }
  async function decodedPeaks(file, n) {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const d = buf.getChannelData(0), per = d.length / n, out = new Float32Array(n);
    for (let i = 0; i < n; i++) { let m = 0; const a = Math.floor(i * per), b = Math.floor((i + 1) * per), st = Math.max(1, Math.floor((b - a) / 512)); for (let k = a; k < b; k += st) { const v = Math.abs(d[k]); if (v > m) m = v; } out[i] = m; }
    return out;
  }
  // keep a small waveform with the take (from the WAV, before it becomes an MP3) so the player can draw it later
  async function keepPeaks(t, wav) { try { const wp = await wavPeaks(wav, 300); t.peaks = Array.from(wp.peaks, v => Math.round(v * 1000) / 1000); } catch {} }

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
      </div>
      <div class="sc-tp-file" title="${esc(t.name)}">${esc(/\.wav$/i.test(t.name) ? safeFileName(takeLabel(t), t) : t.name)}${t.videoName && t.video && t.video !== 'none' ? ' · ' + esc(t.videoName) : ''}</div>`;
    const cv = box.querySelector('canvas'), btn = box.querySelector('.sc-tp-play'), time = box.querySelector('.sc-tp-time');
    const p = player = { audio: a, url, raf: 0, peaks: new Float32Array(160) };
    const m = s => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;
    const paint = () => {
      const d = a.duration || p.seconds || 0;
      drawWave(cv, p.peaks, d ? a.currentTime / d : 0);
      time.textContent = `${m(a.currentTime)} / ${d ? m(d) : '–:––'}`;
      btn.innerHTML = a.paused ? ICON.play : ICON.pause; btn.setAttribute('aria-label', a.paused ? 'Play' : 'Pause');
    };
    // Stop cleanly at the end. Chrome can stall a hair before the end of a WAV and never fire 'ended' (the button
    // stayed on pause at 0:10 / 0:11), so a stalled clock in the last 1.5 s also counts as the end.
    let lastT = -1, stuckSince = 0;
    const finish = () => { a.pause(); a.currentTime = 0; lastT = -1; stuckSince = 0; paint(); };
    const loop = () => {
      paint();
      if (a.paused) return;
      const d = a.duration || p.seconds || 0, now = performance.now();
      if (a.currentTime === lastT) { if (!stuckSince) stuckSince = now; else if (now - stuckSince > 600 && d && a.currentTime >= d - 1.5) return finish(); }
      else { lastT = a.currentTime; stuckSince = 0; }
      p.raf = requestAnimationFrame(loop);
    };
    btn.onclick = e => { e.stopPropagation(); a.paused ? a.play() : a.pause(); };
    a.onplay = () => { cancelAnimationFrame(p.raf); lastT = -1; stuckSince = 0; loop(); };
    a.onended = finish;
    a.onpause = a.onloadedmetadata = paint;
    cv.onclick = e => { e.stopPropagation(); const d = a.duration || p.seconds; if (!d) return; const rc = cv.getBoundingClientRect(); a.currentTime = Math.max(0, Math.min(d, (e.clientX - rc.left) / rc.width * d)); paint(); };
    paint();
    const buckets = Math.max(60, Math.floor((cv.clientWidth || 220) / 2.5));
    try { const wp = await wavPeaks(r.file, buckets); if (player === p) { p.peaks = wp.peaks; p.seconds = wp.seconds; paint(); } }
    catch {
      // An MP3 (saved take): use the waveform kept when it was saved, else decode it (only short files: memory).
      let peaks = null;
      if (Array.isArray(t.peaks) && t.peaks.length) peaks = resamplePeaks(Float32Array.from(t.peaks), buckets);
      else if (r.file.size < 30e6) { try { peaks = await decodedPeaks(r.file, buckets); } catch {} }
      if (peaks && player === p) { p.peaks = peaks; paint(); }
    }
  }

  // Download a take's audio as MP3 (converted from the WAV in browser storage, or the file in the folder as it is).
  async function downloadTake(t, quiet = false) {
    const r = await takeFile(t);
    if (r.denied) return toast('Allow access to the save folder first.', 'error'), false;
    if (r.missing) return toast('This take’s audio is no longer available.', 'error'), false;
    let blob = r.file, name = safeFileName(takeLabel(t), t);
    if (isWav(r.file) && /\.mp3$/i.test(name)) {
      try { blob = await wavToMp3(r.file); } catch (e) { return toast('Could not make the MP3: ' + (e?.message || e), 'error'), false; }
    }
    downloadBlob(blob, name);
    if (!quiet) toast(`${name} downloaded.`, 'ok');
    return true;
  }
  // Mac-camera video of a take
  async function downloadVideo(t, quiet = false) {
    let file; try { file = await web.getStoredFile(t.videoName); } catch { return toast('This take’s video is no longer in the browser.', 'error'), false; }
    const ext = /\.[a-z0-9]+$/i.exec(t.videoName)?.[0] || '.mp4';
    const name = (t.label ? safeFileName(t.label, { ...t, audio: 'none' }).replace(/\.mp3$/i, '') : t.videoName.replace(/\.[a-z0-9]+$/i, '')) + ext;
    downloadBlob(file, name);
    if (!quiet) toast(`${name} downloaded.`, 'ok');
    return true;
  }

  // Rename a take: the files in the folder get the new name too (MP3 and the Mac-camera video). Returns true if done.
  async function applyRename(t, label) {
    label = String(label || '').trim();
    if (!label) return false;
      if (t.audio === 'folder') {
        const newName = safeFileName(label, t);
        if (newName !== t.name) {
          const r = await takeFile(t);
          if (r.denied) { toast('Allow access to the save folder first.', 'error'); return false; }
          if (r.missing) { toast('The file was moved or deleted from the folder, so it can’t be renamed.', 'error'); return false; }
          try {
            if (await r.dir.getFileHandle(newName).then(() => true, () => false)) { toast(`A file called “${newName}” already exists in that folder.`, 'error'); return false; }
            const fh = await r.dir.getFileHandle(t.name);
            if (fh.move) { try { await fh.move(newName); } catch { await copyRename(r.dir, r.file, t.name, newName); } }
            else await copyRename(r.dir, r.file, t.name, newName);
            t.name = newName;
          } catch (e) { { toast('Could not rename the file: ' + (e?.message || e), 'error'); return false; } }
        }
      }
      if (t.video === 'folder' && t.videoName) { // the Mac-camera video gets the same new name
        const ext = /\.[a-z0-9]+$/i.exec(t.videoName)?.[0] || '.mp4';
        const newV = safeFileName(label, { ...t, audio: 'none' }).replace(/\.mp3$/i, '') + ext;
        if (newV !== t.videoName) {
          const r = await takeVideoFile(t), dir = await takeDir(t);
          if (r.file && dir) {
            try {
              if (await dir.getFileHandle(newV).then(() => true, () => false)) { toast(`A file called “${newV}” already exists in that folder.`, 'error'); return false; }
              const fh = await dir.getFileHandle(t.videoName);
              if (fh.move) { try { await fh.move(newV); } catch { await copyRename(dir, r.file, t.videoName, newV); } }
              else await copyRename(dir, r.file, t.videoName, newV);
              t.videoName = newV;
            } catch (e) { { toast('Could not rename the video: ' + (e?.message || e), 'error'); return false; } }
          }
        }
      }
      t.label = label; saveTakes(); renderTakes(); toast('Take renamed.', 'ok');
    return true;
  }
  // The card's pencil opens the take popup with the name ready to edit (one popup for preview and rename).
  function renameTake(t) { openTakeModal(t, { edit: true }); }
  async function copyRename(dir, file, oldName, newName) {
    const w = await (await dir.getFileHandle(newName, { create: true })).createWritable();
    await file.stream().pipeTo(w);
    await dir.removeEntry(oldName);
  }

  // ---- "Script part" in the take popup: which part of which script, and when each paragraph starts (click = jump there)
  function renderScriptPart(t, pane) {
    const sc = t.script; if (!sc) return;
    const cur = window.spaceCamMarks?.script(sc.id), paras = window.spaceCamMarks?.paras(sc.id) || [];
    const same = cur && cur.sig === sc.sig, n = Math.max(1, sc.count || paras.length || 1);
    const from = Math.min(sc.from, sc.to), to = Math.max(sc.from, sc.to);
    const pct = Math.round((to - from + 1) / n * 100);
    const box = h(`<div class="sc-sp">
      <div class="sc-sp-head"><span>Script part · <b></b></span><span class="sc-sp-range"></span></div>
      <div class="sc-sp-bar"><i style="left:${from / n * 100}%;width:${(to - from + 1) / n * 100}%"></i></div>
      <div class="sc-sp-rows"></div></div>`);
    box.querySelector('b').textContent = cur?.name || sc.name || 'Script';
    box.querySelector('.sc-sp-range').textContent = (from === to ? `paragraph ${from + 1}` : `paragraphs ${from + 1}–${to + 1}`) + ` · ${pct}%` + (same ? '' : ' · script edited since');
    const rows = box.querySelector('.sc-sp-rows');
    const words = p => same && paras[p] ? paras[p].replace(/\s+/g, ' ').slice(0, 60) + (paras[p].length > 60 ? '…' : '') : `Paragraph ${p + 1}`;
    for (const x of sc.paras || []) {
      const r = h(`<button type="button" class="sc-sp-row"><span class="sc-sp-t">${esc(fmt(Math.floor(x.t)))}</span><span class="sc-sp-w"></span></button>`);
      r.querySelector('.sc-sp-w').textContent = words(x.p);
      r.onclick = () => { if (!player) return; player.audio.currentTime = x.t; player.audio.play().catch(() => {}); };
      rows.append(r);
    }
    const end = h(`<div class="sc-sp-row end"><span class="sc-sp-t">${esc(fmt(t.seconds || 0))}</span><span class="sc-sp-w">stopped</span></div>`);
    rows.append(end);
    pane.querySelector('.sc-modal-row')?.before(box);
  }
  // the prompter asks for names and coverage by take id, so a rename or delete shows there too
  window.spaceCamTakeName = id => { const t = takes.find(x => x.id === id); return t ? takeLabel(t) : null; };
  window.spaceCamCoverage = scriptId => takes.filter(t => t.script && t.script.id === scriptId)
    .map(t => ({ id: t.id, label: takeLabel(t), sig: t.script.sig, from: Math.min(t.script.from, t.script.to), to: Math.max(t.script.from, t.script.to), paras: t.script.paras || [] }));

  // ---- Take card thumbnail (see fillThumb for the rules)
  // Thumbnail rules:
  //  - video saved on this device (Mac camera): its frame; a faint waveform on top when audio was recorded, plain if not
  //  - video on the camera's memory card (USB camera): just a video icon
  //  - audio only: a waveform
  function drawThumbWave(cv, box, t, faint) {
    requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1, w = box.clientWidth || 64, hgt = box.clientHeight || 40;
      cv.width = w * dpr; cv.height = hgt * dpr;
      const g = cv.getContext('2d'); g.scale(dpr, dpr);
      const n = faint ? 40 : 30;
      const src = Array.isArray(t.peaks) && t.peaks.length ? resamplePeaks(Float32Array.from(t.peaks), n) : Float32Array.from({ length: n }, (_, i) => 0.3 + 0.5 * Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.23)));
      // scale to this take's own quiet..loud range, so pauses look short and speech looks tall (not a flat block)
      const sorted = Array.from(src).sort((a, b) => a - b), lo = sorted[Math.floor(n * 0.08)], hi = sorted[Math.floor(n * 0.96)] || 1;
      const lvl = v => 0.1 + 0.9 * Math.pow(Math.max(0, Math.min(1, (v - lo) / ((hi - lo) || 1))), 1.15);
      const step = w / n, bw = Math.max(1.2, step * (faint ? 0.55 : 0.5));
      const mid = faint ? hgt - 7 : hgt / 2, amp = faint ? 5 : hgt / 2 - 7;
      if (faint) g.fillStyle = 'rgba(255,255,255,.85)';
      else { const gr = g.createLinearGradient(0, mid - amp, 0, mid + amp); gr.addColorStop(0, 'rgba(240,240,238,.55)'); gr.addColorStop(0.5, 'rgba(250,250,248,.95)'); gr.addColorStop(1, 'rgba(240,240,238,.55)'); g.fillStyle = gr; }
      if (faint) { // over a picture: one thin, smooth, soft mirrored shape — a hint that audio was recorded
        const sm = Array.from(src, (v, i) => (src[Math.max(0, i - 1)] + v * 2 + src[Math.min(n - 1, i + 1)]) / 4);
        const pts = sm.map((v, i) => [i * step + step / 2, Math.max(0.5, lvl(v) * amp * 0.7)]);
        g.beginPath(); g.moveTo(0, mid);
        pts.forEach(([x, v]) => g.lineTo(x, mid - v)); g.lineTo(w, mid);
        for (let i = pts.length - 1; i >= 0; i--) g.lineTo(pts[i][0], mid + pts[i][1]);
        g.closePath(); g.fillStyle = 'rgba(255,255,255,.62)'; g.fill();
        return;
      }
      for (let i = 0; i < n; i++) {
        const v = Math.max(1, lvl(src[i]) * amp), x = i * step + (step - bw) / 2;
        g.beginPath(); if (g.roundRect) g.roundRect(x, mid - v, bw, v * 2, bw / 2); else g.rect(x, mid - v, bw, v * 2); g.fill();
      }
    });
  }
  function fillThumb(box, t, hasVideo) {
    const hasAudio = ['folder', 'browser', 'sample', 'kept', 'saved'].includes(t.audio);
    if (hasVideo) {
      box.classList.add('vid'); box.title = hasAudio ? 'Video and audio saved with this take' : 'Video saved with this take (no audio)';
      idb.get('thumb:' + t.id).then(src => {
        if (!src) { box.innerHTML = ICON.video; return; }
        const im = new Image(); im.alt = ''; im.src = src; box.replaceChildren(im);
        if (hasAudio) { const cv = document.createElement('canvas'); cv.className = 'sc-thumb-wave'; box.append(cv); drawThumbWave(cv, box, t, true); }
      }).catch(() => { box.innerHTML = ICON.video; });
      return;
    }
    if (t.camera) { // USB camera: the video is on its memory card → video icon (+ faint waveform when audio was recorded)
      box.classList.add('card'); box.title = 'The video is on the camera’s memory card' + (hasAudio ? '; audio saved here' : '');
      box.innerHTML = ICON.video;
      if (hasAudio) { const cv = document.createElement('canvas'); cv.className = 'sc-thumb-wave'; box.append(cv); drawThumbWave(cv, box, t, true); }
      return;
    }
    box.classList.add('wave'); box.title = 'Audio take';
    const cv = document.createElement('canvas'); box.append(cv); drawThumbWave(cv, box, t, false);
  }
  // Mac-camera take: keep one small frame from the live preview for its card (IndexedDB, not localStorage: size)
  function grabThumb(id) {
    setTimeout(() => {
      try {
        const v = ui.vid; if (!v.videoWidth) return;
        const c = document.createElement('canvas'); c.width = 160; c.height = Math.round(160 * v.videoHeight / v.videoWidth);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        idb.set('thumb:' + id, c.toDataURL('image/jpeg', 0.7)).then(() => renderTakes()).catch(() => {});
      } catch {}
    }, 1000);
  }

  function deleteTake(t) {
    const inFolder = t.audio === 'folder' || t.audio === 'saved';
    const unsaved = t.audio === 'browser' || t.audio === 'sample', kept = t.audio === 'kept';
    const m = modal(`
      <div class="sc-modal-head"><div class="sc-modal-title">Delete “${esc(takeLabel(t))}”?</div><button type="button" class="sc-modal-x" data-close aria-label="Close">✕</button></div>
      <p class="sc-modal-p">${t.video === 'browser' ? 'Its Mac-camera video was never saved. Deleting removes it for good. ' : ''}${unsaved ? 'This audio was never saved to a folder. Deleting it removes it for good.' :
        kept ? 'This removes it from Space Cam. The copy in your Downloads folder stays.' :
        inFolder ? 'This only removes it from the list. The WAV file stays in your folder.' : 'This removes it from the list.'}</p>
      <div class="sc-modal-row"><button type="button" class="btn ghost" data-close>Cancel</button><button type="button" class="btn primary sc-ok${unsaved ? ' danger' : ''}">${unsaved ? 'Delete audio' : kept ? 'Delete' : 'Remove from list'}</button></div>`);
    m.wrap.querySelector('.sc-ok').onclick = async () => {
      if (unsaved || kept) await audio.deleteStored(t.name).catch(() => {});
      if (t.videoName && (t.video === 'browser' || t.video === 'kept')) await web.deleteStored(t.videoName).catch(() => {});
      if (openTakeId === t.id) { stopPlayer(); openTakeId = null; }
      takes = takes.filter(x => x !== t); saveTakes(); renderTakes(); m.close();
    };
  }

  function whenLabel(ms) {
    const d = new Date(ms), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
    const same = (a, b) => a.toDateString() === b.toDateString();
    const day = same(d, now) ? 'Today' : same(d, y) ? 'Yesterday' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return `${day} ${hhmm(d)}`;
  }
  function renderTakes() {
    try { window.spaceCamMarks?.refresh(); } catch {}
    t_ids();
    const list = takes.slice().reverse();
    ui.saveAll.hidden = true;
    if (!list.length) { ui.takeList.innerHTML = '<div class="sc-none">No takes yet. Press <kbd>R</kbd> to record.</div>'; return; }
    ui.takeList.replaceChildren(...list.map(t => {
      const hasAudio = ['folder', 'browser', 'sample', 'kept'].includes(t.audio);
      const vNote = t.saving ? '' : t.video === 'browser' ? 'video not saved' : '';
      // notes: red only when something needs attention (not saved / file moved); otherwise plain
      const alarm = !t.saving && (t.missing || t.audio === 'browser' || !!vNote);
      const note = t.saving ? 'saving…' : [t.missing ? 'file moved' : t.audio === 'browser' ? 'not saved' : !hasAudio && t.audio !== 'saved' && !t.videoName ? 'no audio' : '', vNote].filter(Boolean).join(' · ');
      const hasVideo = !!(t.videoName && t.video && t.video !== 'none');
      const el = h(`<div class="script-tab sc-take${t.audio === 'browser' ? ' unsaved' : ''}">
        <div class="sc-take-head" role="button" tabindex="0">
          <span class="sc-take-thumb"></span>
          <span class="sc-take-main">
            <span class="sc-take-title"><span class="script-tab-name">${esc(takeLabel(t))}</span></span>
            <span class="sc-take-sub">${esc(whenLabel(t.startedAt))}${t.seconds != null ? ' · ' + fmt(t.seconds) : ''}${note ? ` · <em${alarm ? ' class="alarm"' : ''}>${note}</em>` : ''}</span>
          </span>
          <span class="script-tab-actions"></span>
        </div></div>`);
      fillThumb(el.querySelector('.sc-take-thumb'), t, hasVideo);
      const actions = el.querySelector('.script-tab-actions');
      const mk = (icon, title, fn) => { const b = h(`<span class="script-tab-act" role="button" title="${title}" aria-label="${title}">${ICON[icon]}</span>`); b.onclick = e => { e.stopPropagation(); fn(); }; return b; };
      actions.append(mk('rename', 'Rename', () => renameTake(t)));
      actions.append(mk('del', 'Delete take (deletes its files)', () => deleteTakeFiles(t)));
      const head = el.querySelector('.sc-take-head');
      // click a take: popup with video (if any), audio player, Download take at the bottom
      head.onclick = () => openTakeModal(t);
      head.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTakeModal(t); } };
      head.title = 'Open';
      return el;
    }));
  }

  // Save a take still in browser storage: audio as MP3 (the WAV stays until the MP3 is written), video as it is.
  async function saveTake(t) {
    try {
      if (t.audio === 'browser') {
        const dest = t.label ? safeFileName(t.label, t) : toMp3Name(t.name);
        const wav = await audio.getStoredFile(t.name);
        await keepPeaks(t, wav);
        const mp3 = await wavToMp3(wav);
        if (await folderOk(true)) {
          const fin = await freeName(folder, dest);
          await writeToFolder(folder, fin, mp3);
          await audio.deleteStored(t.name).catch(() => {});
          t.name = fin; t.audio = 'folder'; t.folderName = folder.name; await idb.set('dir:' + t.id, folder);
        } else {
          const fin = await saveBlobAs(mp3, dest, 'MP3 audio', 'audio/mpeg', '.mp3');
          await audio.deleteStored(t.name).catch(() => {});
          t.name = fin; t.audio = 'saved';
        }
      }
      if (t.video === 'browser') await saveVideo(t);
      delete t.recovered; delete t.missing; saveTakes(); renderTakes(); toast(`${t.label || t.name || 'Take'} saved.`, 'ok');
    } catch (e) { if (e?.name !== 'AbortError') toast('Could not save: ' + (e?.message || e), 'error'); }
  }
  async function saveVideo(t) {
    if (await folderOk(false)) {
      const fin = await freeName(folder, t.videoName);
      await web.moveToFolder(t.videoName, folder, fin); t.videoName = fin; t.video = 'folder'; t.folderName = folder.name; await idb.set('dir:' + t.id, folder);
    } else { if (await downloadVideo(t, true)) t.video = 'kept'; }
  }
  // ---- "Take saved" card: the take's thumbnail, ✓, length and where it went, centered over a dimmed screen
  // (same dim as the popups). Closes by itself, on ✕ / Esc / a click outside, or when the next take starts.
  // ---- "Recording saved" card, with the name box open so it can be renamed straight away.
  // Normal stop: keeps the name by itself after 8 s if nobody touches it; the first click or key in the card stops
  // that timer for good, then it waits for Save / Enter (rename) or Esc / ✕ / a click outside (keep the name).
  // Stopped by an error: one card with the red warning on top, no timer, it waits for OK.
  // While the name box has the cursor, R types into it (the R shortcut ignores text boxes).
  let savedT = null, savedEl = null, savedFor = null;
  function closeSaved() { clearTimeout(savedT); savedEl?.remove(); savedEl = savedFor = null; document.removeEventListener('keydown', savedKey, true); }
  function savedKey(e) { if (e.key === 'Escape' && savedEl) { e.preventDefault(); e.stopPropagation(); closeSaved(); } }
  function savedCard(t, where, { error = '', ms = 8000 } = {}) {
    closeSaved(); clearTimeout(toastT); toastEl.hidden = true;
    const hasVideo = !!(t.videoName && t.video && t.video !== 'none');
    const kinds = [t.audio !== 'none' && t.name && 'MP3', hasVideo && 'MP4', t.camera && 'camera clip'].filter(Boolean).join(' + ');
    savedEl = h(`<div class="sc-saved${error ? ' err' : ''}" role="dialog" aria-modal="true" aria-label="Recording saved">
      <div class="sc-saved-card" style="--saved-ms:${ms}ms">
        ${error ? `<div class="sc-saved-warn"><svg viewBox="0 0 24 24"><path d="M12 2 1 21h22L12 2zm1 15h-2v-2h2v2zm0-4h-2V9h2v4z"/></svg><span><b>Recording stopped</b><span>${esc(error)}</span></span></div>` : ''}
        <div class="sc-saved-row">
          <span class="sc-saved-media"><span class="sc-take-thumb sc-saved-thumb"></span><span class="sc-saved-ok"><svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg></span></span>
          <span class="sc-saved-txt">
            <span class="sc-saved-head">${error ? 'Saved up to here · name it?' : 'Recording saved · name it?'}</span>
            <span class="sc-saved-name"><input class="sc-saved-in" value="${esc(takeLabel(t))}" maxlength="80" spellcheck="false" aria-label="Recording name">${error ? '' : '<button type="button" class="btn primary sc-saved-save">Save</button>'}</span>
            <span class="sc-saved-meta">${esc(fmt(t.seconds || 0))}${kinds ? ' · ' + esc(kinds) : ''}</span>
            <span class="sc-saved-where">${esc(where)}</span>
          </span>
          ${error ? '' : '<button type="button" class="sc-modal-x" aria-label="Close">✕</button>'}
        </div>
        ${error ? '<div class="sc-saved-foot"><span class="sc-saved-hint"><kbd>Enter</kbd> OK</span><button type="button" class="btn primary sc-saved-save">OK</button></div>'
                : '<span class="sc-saved-hint"><kbd>Enter</kbd> save · <kbd>Esc</kbd> keep the name · <span class="sc-saved-left">keeps it in 8 s</span></span><i class="sc-saved-bar"></i>'}
      </div></div>`);
    savedFor = t;
    const card = savedEl.querySelector('.sc-saved-card'), input = savedEl.querySelector('.sc-saved-in');
    fillThumb(savedEl.querySelector('.sc-saved-thumb'), t, hasVideo);
    let held = false;
    const hold = () => { // first touch: the timer stops for good
      if (held || error) return; held = true; clearTimeout(savedT);
      savedEl?.classList.add('held'); const l = savedEl?.querySelector('.sc-saved-left'); if (l) l.textContent = 'waiting for you';
    };
    const commit = async () => {
      const v = input.value.trim(); closeSaved();
      if (!v || v === takeLabel(t)) return;
      if (t.saving) await saveChain.catch(() => {}); // rename once the files are in place
      await applyRename(t, v);
    };
    card.addEventListener('pointerdown', hold);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key !== 'Escape') hold(); });
    input.addEventListener('input', hold);
    savedEl.querySelector('.sc-saved-save').onclick = commit;
    savedEl.querySelector('.sc-modal-x')?.addEventListener('click', closeSaved);
    if (!error) savedEl.addEventListener('mousedown', e => { if (e.target === savedEl) closeSaved(); });
    document.addEventListener('keydown', savedKey, true);
    document.body.append(savedEl);
    input.focus(); input.select();
    if (!error) savedT = setTimeout(closeSaved, ms);
  }
  // the save finished while its card is still open: fill in where the files went
  function updateSaved(t, where) {
    if (!savedEl || savedFor !== t) return false;
    savedEl.querySelector('.sc-saved-where').textContent = where;
    return true;
  }

  // Right after a take stops: audio → MP3 into the folder (or Downloads), video → folder (or Downloads).
  // Runs in the background, one take at a time, so the next take can start straight away.
  let saveChain = Promise.resolve();
  function finishTake(t) {
    t.saving = true; renderTakes();
    saveChain = saveChain.then(async () => {
      if (t.audio === 'browser') {
        try {
          const wavFile = await audio.getStoredFile(t.name);
          await keepPeaks(t, wavFile);
          const mp3 = await wavToMp3(wavFile);
          if (await folderOk(false)) {
            const fin = await freeName(folder, toMp3Name(t.name));
            await writeToFolder(folder, fin, mp3);
            await audio.deleteStored(t.name).catch(() => {});
            t.name = fin; t.audio = 'folder'; t.folderName = folder.name; await idb.set('dir:' + t.id, folder);
          } else {
            // No folder: keep the WAV in the browser (for playback) and download the MP3 to Downloads.
            downloadBlob(mp3, toMp3Name(t.name)); t.audio = 'kept';
          }
        } catch (e) { toast('Could not save the MP3 — the audio is still safe in the browser: ' + (e?.message || e), 'error'); }
      }
      if (t.video === 'browser') {
        try { await saveVideo(t); }
        catch (e) { toast('Could not save the video — it is still safe in the browser: ' + (e?.message || e), 'error'); }
      }
      delete t.saving; saveTakes(); renderTakes();
      const parts = [t.camera && 'clip on the camera card', t.audio === 'folder' && `MP3 in “${t.folderName}”`, t.audio === 'kept' && 'MP3 in Downloads',
        t.video === 'folder' && 'video in the folder', t.video === 'kept' && 'video in Downloads'].filter(Boolean);
      const whereText = parts.length ? parts.join(', ').replace(/^./, c => c.toUpperCase()) : 'Nothing recorded';
      if (updateSaved(t, whereText)) return; // its card (error stop) is open: just fill in the line
      if (take || document.querySelector('.sc-modal')) toast(`${t.label || 'Take'} saved — ${parts.join(', ') || 'nothing recorded'}.`, 'ok'); // a take is rolling or a warning is open: don't cover it
      else savedCard(t, whereText);
    });
    return saveChain;
  }
  ui.saveAll.onclick = async () => { for (const t of takes.filter(t => t.audio === 'browser' || t.video === 'browser')) await saveTake(t); };
  async function flushWaiting() {
    if (!(await folderOk(false))) return;
    for (const t of takes.filter(t => (t.audio === 'browser' || t.video === 'browser') && !t.recovered && !t.saving)) await saveTake(t);
  }

  // Takes left in browser storage by a crash or an unsaved session
  if (AudioCore.supported) audio.listStored().then(files => {
    const known = new Set(takes.map(t => t.name));
    let added = 0;
    for (const f of files) if (!known.has(f.name)) { takes.push({ name: f.name, startedAt: f.modified, audio: 'browser', recovered: true, seconds: null }); added++; }
    takes.forEach(t => { if ((t.audio === 'browser' || t.audio === 'kept') && !files.some(f => f.name === t.name)) t.audio = 'none'; });
    if (added) toast(`${added} unsaved audio take${added > 1 ? 's' : ''} recovered. Download them from the Takes list.`);
    saveTakes(); renderTakes();
  }).catch(() => renderTakes()); else renderTakes();
  // Mac-camera videos left in browser storage by a crash or an unsaved session
  takes.forEach(t => { delete t.saving; });
  if (WebcamCore.supported) web.listStored().then(files => {
    const known = new Set(takes.map(t => t.videoName).filter(Boolean));
    let added = 0;
    for (const f of files) if (!known.has(f.name)) { takes.push({ videoName: f.name, video: 'browser', name: null, startedAt: f.modified, audio: 'none', recovered: true, seconds: null, label: 'Recovered video' }); added++; }
    takes.forEach(t => { if (t.videoName && (t.video === 'browser' || t.video === 'kept') && !files.some(f => f.name === t.videoName)) t.video = 'none'; });
    if (added) toast(`${added} unsaved video${added > 1 ? 's' : ''} recovered. Download from the Takes list.`);
    takes.sort((a, b) => a.startedAt - b.startedAt); saveTakes(); renderTakes();
  }).catch(() => {});

  // ------------------------------------------------------------------ sample data (quick check; remove before launch)
  const sampleBtn = $('scSample');
  $('scSaveAll').before(sampleBtn); // Spotlight is the only page: sample data lives in the Takes header
  const SAMPLE_SCRIPTS = [
    { name: 'Sample · Quick hello', text: "Hi, I'm testing Space Cam.\n\nThis is a short script to check the prompter, the camera and the microphone together.\n\nIf you can read this on the glass, everything works." },
    { name: 'Sample · Product intro', text: "Welcome back to the channel.\n\nToday I'm going to show you a tool that changed how I record my videos.\n\nIt runs in the browser. No install, no account.\n\nIt controls my camera, records my voice and scrolls my script, all from one window.\n\nLet me show you how it works, step by step.\n\nIf this helps you, you know what to do. See you in the next one." },
    { name: 'Sample · Long tutorial', text: Array.from({ length: 14 }, (_, i) => `Step ${i + 1}. ` + [
      'Open the app and check camera, audio and save folder in the right rail.',
      'Connect the camera over USB. Make sure it is set to PC Remote.',
      'Pick your microphone and watch the meter while you speak at your normal level.',
      'Choose the folder where your audio takes should go.',
      'Press + New, paste your script and save it.',
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
  // sample helpers: the Space Cam logo (from the page) as a thumbnail and as a short "camera" clip
  function sampleLogoImg() { return document.querySelector('.brand-logo'); }
  function sampleLogoThumb() {
    try {
      const im = sampleLogoImg(); if (!im?.naturalWidth) return null;
      const c = document.createElement('canvas'); c.width = 160; c.height = 90; const g = c.getContext('2d');
      const gr = g.createLinearGradient(0, 0, 160, 90); gr.addColorStop(0, '#26262b'); gr.addColorStop(1, '#0e0e10'); g.fillStyle = gr; g.fillRect(0, 0, 160, 90);
      g.drawImage(im, 52, 9, 56, 56); g.fillStyle = '#E6E6E4'; g.font = '600 10px Archivo, sans-serif'; g.textAlign = 'center'; g.fillText('Space Cam', 80, 80);
      return c.toDataURL('image/jpeg', 0.8);
    } catch { return null; }
  }
  async function sampleLogoVideo(seconds) {
    const fmt = WebcamCore.format, im = sampleLogoImg();
    if (!fmt || !im?.naturalWidth) return null;
    const c = document.createElement('canvas'); c.width = 640; c.height = 360; const g = c.getContext('2d');
    const draw = t => {
      const gr = g.createLinearGradient(0, 0, 640, 360); gr.addColorStop(0, '#26262b'); gr.addColorStop(1, '#0e0e10'); g.fillStyle = gr; g.fillRect(0, 0, 640, 360);
      const sz = 170 + 14 * Math.sin(t * 2.2); g.drawImage(im, 320 - sz / 2, 150 - sz / 2, sz, sz);
      g.fillStyle = '#F0F0EE'; g.font = '700 34px Archivo, sans-serif'; g.textAlign = 'center'; g.fillText('Space Cam', 320, 300);
      g.fillStyle = '#E8463A'; g.beginPath(); g.arc(40, 40, 9, 0, 7); g.fill(); g.fillStyle = '#F0F0EE'; g.font = '600 16px ui-monospace, monospace'; g.textAlign = 'left'; g.fillText('SAMPLE ' + t.toFixed(1) + 's', 58, 46);
    };
    try {
      const rec = new MediaRecorder(c.captureStream(30), { mimeType: fmt.mime, videoBitsPerSecond: 2_000_000 });
      const parts = []; rec.ondataavailable = e => e.data?.size && parts.push(e.data);
      const t0 = performance.now(); let raf = 0; const loop = () => { draw((performance.now() - t0) / 1000); raf = requestAnimationFrame(loop); };
      loop(); rec.start(500);
      await new Promise(r => setTimeout(r, seconds * 1000));
      await new Promise(r => { rec.onstop = r; rec.stop(); }); cancelAnimationFrame(raf);
      return { blob: new Blob(parts, { type: fmt.mime.split(';')[0] }), ext: fmt.ext };
    } catch { return null; }
  }
  async function writeStoredVideo(name, blob) {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('videos', { create: true });
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(blob); await w.close();
  }
  async function writeStored(name, blob) {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('takes', { create: true });
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(blob); await w.close();
  }
  const hasSample = () => takes.some(t => t.demo) || !!window.spaceCamScripts?.hasDemo();
  // Temporary: a small "Sample data" button in the Takes header. After the first real recording the samples
  // remove themselves and the button goes away for good.
  function renderSampleBtn() {
    const on = hasSample();
    sampleBtn.hidden = false; // testing phase: always available (auto-removal after the first take is off for now)
    sampleBtn.className = 'sc-sample-btn' + (on ? ' on' : '');
    sampleBtn.textContent = on ? 'Remove samples' : 'Sample data';
    sampleBtn.title = on ? 'Remove the sample takes and scripts' : 'Load sample takes and scripts to try Space Cam';
  }
  async function removeSamples(quiet = false) {
    for (const t of takes.filter(t => t.demo)) {
      if (t.name) await audio.deleteStored(t.name).catch(() => {});
      if (t.videoName) await web.deleteStored(t.videoName).catch(() => {});
      idb.set('thumb:' + t.id, null).catch(() => {});
    }
    takes = takes.filter(t => !t.demo); saveTakes(); renderTakes();
    window.spaceCamScripts?.removeDemo();
    if (!quiet) toast('Sample data removed. Your own takes and scripts are untouched.', 'ok');
  }
  // first real take: samples out, button gone
  async function retireSamples() {
    if (store.get('samplesDone', false)) return;
    store.set('samplesDone', true);
    if (hasSample()) await removeSamples(true);
    renderSampleBtn();
  }
  sampleBtn.onclick = async () => {
    sampleBtn.disabled = true;
    try {
      if (hasSample()) await removeSamples();
      else {
        window.spaceCamScripts?.addDemo(SAMPLE_SCRIPTS);
        toast('Making sample takes…');
        const now = Date.now(), min = 60e3;
        const thumb = sampleLogoThumb();
        const clip = await sampleLogoVideo(4); // one short logo clip, used by both Mac-camera samples
        // every kind of take card: Mac camera ± mic, USB camera ± mic, audio only
        const specs = [
          { label: 'Sample · Mac camera + mic', secs: 12, mic: true, mac: true },
          { label: 'Sample · Mac camera, no mic', secs: 8, mic: false, mac: true },
          { label: 'Sample · USB camera + mic', secs: 24, mic: true, usb: true },
          { label: 'Sample · USB camera, no mic', secs: 15, mic: false, usb: true },
          { label: 'Sample · Audio only', secs: 18, mic: true },
        ];
        for (let i = 0; i < specs.length; i++) {
          const sp = specs[i], startedAt = now - (specs.length - i) * 7 * min, id = 'demo' + i + startedAt.toString(36);
          const tk = { id, no: i + 1, label: sp.label, startedAt, seconds: sp.secs, camera: !!sp.usb, audio: 'none', demo: true };
          if (sp.mic) {
            const wav = makeSampleWav(sp.secs, i + 1), name = `Sample-Take-${pad(i + 1)}_${startedAt}.wav`;
            await writeStored(name, wav); tk.name = name; tk.audio = 'sample'; await keepPeaks(tk, wav);
          }
          if (sp.mac && clip) {
            const vname = `Sample-Video-${pad(i + 1)}_${startedAt}.${clip.ext}`;
            await writeStoredVideo(vname, clip.blob); tk.videoName = vname; tk.video = 'kept';
            if (thumb) await idb.set('thumb:' + id, thumb);
          }
          takes.push(tk);
        }
        takes.sort((a, b) => a.startedAt - b.startedAt); saveTakes(); renderTakes();
        toast('Sample data loaded: 3 scripts and 5 takes, one of each kind. Open a take to play it.', 'ok');
      }
    } catch (e) { toast('Sample data failed: ' + (e?.message || e), 'error'); }
    sampleBtn.disabled = false; renderSampleBtn();
  };
  setTimeout(renderSampleBtn, 0);

  // ------------------------------------------------------------------ record (camera + audio together)
  function renderRec() {
    const recording = !!take;
    const armed = (src === 'sony' && cam.state === 'connected') || (src === 'mac' && webOn()) || audio.state !== 'off';
    ui.rec.classList.toggle('on', recording);
    ui.rec.classList.toggle('unarmed', !armed && !recording);
    ui.rec.title = armed ? 'Record camera + audio (R)' : 'Connect the camera or enable a microphone first';
    const s = take ? Math.floor((Date.now() - take.startedAt) / 1000) : 0;
    ui.recLabel.textContent = recording ? fmt(s) : 'Record';
    ui.badge.hidden = !recording; ui.badgeTime.textContent = fmt(s);
    const warn = recording && !!take.limit && s >= take.limit.sec - 60;
    ui.badge.classList.toggle('warn', warn); ui.rec.classList.toggle('warn', warn);
    ui.ccBadge.hidden = !recording; ui.ccTime.textContent = fmt(s); ui.ccBadge.classList.toggle('warn', warn);
    if (big) { big.rec.classList.toggle('on', recording); big.recLabel.textContent = recording ? fmt(s) : 'Record'; big.badge.hidden = !recording; big.time.textContent = fmt(s); big.badge.classList.toggle('warn', warn); }
    renderCam(); renderMic();
  }

  async function startTake() {
    const camOk = src === 'sony' && cam.state === 'connected' && cam.has('record');
    const vidOk = src === 'mac' && webOn();
    const micOk = audio.state === 'ready';
    if (!camOk && !micOk && !vidOk) return toast('Connect the camera or enable a microphone first.', 'error');
    if (player && !player.audio.paused) { player.audio.pause(); } // a take playing back would end up in the new recording
    if ((micOk || vidOk) && !folder && !store.get('folderChoice', '')) { // first take: ask once where takes go
      if ((await askSaveLocation()) === 'cancel') return;
    }
    if ((micOk || vidOk) && folder) await folderOk(true); // ask once while we still have the key press / click
    if (!micOk) toast(vidOk ? 'No mic in Space Cam — the Mac-camera video will have no sound.' : 'No mic in Space Cam — make sure the camera or an external recorder is recording the sound.');
    closeSaved();
    const started = new Date(), no = nextNo(), label = `Take_${no}`;
    let base = label;
    if (takes.some(t => t.name === `${base}.wav` || t.name === `${base}.mp3` || (t.videoName || '').startsWith(base + '.'))) base = `${label} (${pad(started.getHours())}${pad(started.getMinutes())}${pad(started.getSeconds())})`;
    const name = `${base}.wav`;
    const micTrack = micOk ? audio.stream?.getAudioTracks()[0] : null;
    const [a, c, v] = await Promise.all([micOk ? audio.startRecording(name) : false, camOk ? cam.startRecording() : false, vidOk ? web.startRecording(base, micTrack) : null]);
    // Everything starts together or nothing does: a take with the camera rolling but no audio (or the other way round)
    // can't be synced later. Undo whatever did start, and say what failed.
    const failed = [camOk && !c && 'the camera', vidOk && !v && 'the Mac camera', micOk && !a && 'the audio'].filter(Boolean);
    if (failed.length) {
      await Promise.all([a ? audio.stopRecording().then(() => audio.deleteStored(name)).catch(() => {}) : null,
        c ? cam.stopRecording() : null,
        v ? web.stopRecording().then(() => web.deleteStored(v)).catch(() => {}) : null]);
      return stopWarning('Recording didn’t start', `${failed.join(' and ')} didn’t start, so nothing was recorded${c ? ' (a second or two may be on the camera card)' : ''}. Check ${failed.length > 1 ? 'them' : 'it'} and try again.`);
    }
    take = { id: 't' + started.getTime().toString(36), series: 'st', no, label, name: a ? name : null, startedAt: started.getTime(), camera: !!c, audio: a ? 'recording' : 'none', video: v ? 'recording' : undefined, videoName: v || undefined };
    if (v) grabThumb(take.id); // card thumbnail from the Mac camera, ~1 s in
    take.mark = window.spaceCamMarks?.start() || null; // where the take starts in the script
    if (take.mark) { // which script, and when each paragraph comes up (for the Script part and Coverage views)
      const sc = window.spaceCamMarks.script(take.mark.id);
      take.script = { id: take.mark.id, name: sc?.name || '', sig: take.mark.sig, count: window.spaceCamMarks.paras(take.mark.id).length, from: take.mark.from.p, to: take.mark.from.p, paras: [{ p: take.mark.from.p, t: 0 }] };
    }
    take.limit = await takeLimit(take);
    try { wake = await navigator.wakeLock?.request('screen'); } catch {}
    timer = setInterval(tick, 250); tick();
    sfx('start');
  }

  async function stopTake(reason = '') {
    if (!take) return;
    const t = take; take = null; clearInterval(timer); timer = null;
    if (!stopping) sfx('stop');
    try { window.spaceCamPrompter?.pause(); } catch {} // the script stops scrolling the moment recording stops
    try { // marker line in the script where it stopped (linked by id, so renames follow)
      const r = window.spaceCamMarks?.stop(t.mark, t.label || 'Take', Math.round((Date.now() - t.startedAt) / 1000), t.id);
      if (t.script) { if (r) { t.script.from = r.from.p; t.script.to = r.to.p; } else delete t.script; }
    } catch {}
    delete t.mark;
    try { await wake?.release(); } catch {} wake = null;
    const [a, , v] = await Promise.all([t.audio === 'recording' ? audio.stopRecording() : null, cam.recording ? cam.stopRecording() : null, t.video === 'recording' ? web.stopRecording() : null]);
    t.seconds = Math.round((Date.now() - t.startedAt) / 1000);
    if (t.audio === 'recording') {
      // If the mic dropped, the audio engine already closed the WAV itself; it's still in browser storage, so keep it.
      let ok = !!a;
      if (!ok && t.name) ok = await audio.getStoredFile(t.name).then(f => f.size > 44, () => false);
      t.audio = ok ? 'browser' : 'none'; // WAV is safe in browser storage
    }
    if (t.video === 'recording') t.video = v ? 'browser' : 'none';
    takes.push(t); saveTakes(); renderTakes(); renderRec();
    if (reason) { /* stopped by an error or a limit: stopTogether shows one card with the warning */ }
    else if (t.camera && t.audio !== 'browser' && t.video !== 'browser') savedCard(t, 'Clip on the camera card');
    else toast(`${reason || `${t.label || 'Take'} done`}${t.audio === 'browser' || t.video === 'browser' ? ' — saving…' : t.camera ? ' — clip on the camera card.' : ''}`, 'ok');
    if (t.audio === 'browser' || t.video === 'browser') finishTake(t);
    if (src === 'sony') setTimeout(() => cam.refreshInfo(), 800);
  }

  // ---- Start together, stop together ----
  // The take ends at the first limit any part has: the camera's own clip limit (only bodies that have one),
  // the WAV file limit (4 GB), or browser storage running out. One minute's warning first.
  const CLIP_LIMIT_MODELS = /^(ILCE-7M3|ILCE-7RM3A?|ILCE-9|ILCE-6000|ILCE-6100|ILCE-6300|ILCE-6400|ILCE-6500)\b/i;
  async function takeLimit(t) {
    const lim = [];
    if (t.camera && CLIP_LIMIT_MODELS.test(String(cam.model || '').trim())) lim.push({ sec: LIMIT, why: `the ${cameraName(cam.model).replace(/ ·.*/, '')} stops every clip at 29:59` });
    let bps = 0; // bytes per second written to browser storage
    if (t.audio === 'recording') {
      const ab = audio.sampleRate * audio.channels * 3;
      bps += ab;
      lim.push({ sec: Math.floor((2 ** 32 - 1 - 44) / ab), why: 'an audio file can’t grow past 4 GB' });
    }
    if (t.video === 'recording') bps += (12_000_000 + 192_000) / 8;
    if (bps) {
      try {
        const { quota = 0, usage = 0 } = await navigator.storage.estimate();
        const sec = Math.floor(((quota - usage) * 0.9) / bps);
        if (sec < 120) toast(`Browser storage is almost full — only about ${Math.max(0, Math.floor(sec / 60))} min of recording fits.`, 'error');
        lim.push({ sec: Math.max(10, sec), why: 'the browser’s storage was almost full' });
      } catch {}
    }
    return lim.sort((x, y) => x.sec - y.sec)[0] || null;
  }
  let stopping = false;
  async function stopTogether(reason) {
    if (!take || stopping) return;
    stopping = true; sfx('error');
    const t = take;
    const parts = [t.camera && 'camera', t.video === 'recording' && 'Mac camera', t.audio === 'recording' && 'audio'].filter(Boolean);
    try { await stopTake(reason); } finally { stopping = false; }
    // one card: the warning on top, what was saved, and the name box (waits for OK)
    const where = t.saving ? 'Saving…' : t.camera ? 'Clip on the camera card' : 'Nothing was recorded';
    savedCard(t, where, { error: `${reason[0].toUpperCase() + reason.slice(1)}. ${parts.length > 1 ? `The ${parts.join(' and ')} stopped together to stay in sync.` : 'The recording stopped.'} Shoot again to carry on.` });
  }
  function stopWarning(title, text) {
    sfx('error');
    const m = modal(`
      <div class="sc-modal-head"><div class="sc-modal-title">${esc(title)}</div><button type="button" class="sc-modal-x" data-close aria-label="Close">✕</button></div>
      <p class="sc-modal-p">${esc(text)}</p>
      <div class="sc-modal-row"><button type="button" class="btn primary" data-close>OK</button></div>`);
    m.wrap.querySelector('.btn.primary')?.focus();
  }
  // a part that stops on its own (unplugged, blocked, crashed) stops the rest
  audio.addEventListener('state', () => { if (take && take.audio === 'recording' && audio.state !== 'recording' && !stopping) stopTogether('the microphone stopped (unplugged or blocked)'); });
  web.addEventListener('state', () => { if (take && take.video === 'recording' && !web.recording && !stopping) stopTogether('the Mac camera stopped'); });
  cam.addEventListener('state', e => { if (take && take.camera && e.detail.state === 'disconnected' && !stopping) stopTogether('the USB camera disconnected'); });

  function tick() {
    if (!take) return;
    if (take.script && take.mark) { // log the second each new paragraph reaches the reading line
      try {
        const sp = window.spaceCamMarks.spot(take.mark), ps = take.script.paras;
        if (sp && sp.p !== ps[ps.length - 1].p) { ps.push({ p: sp.p, t: Math.round((Date.now() - take.startedAt) / 100) / 10 }); if (ps.length > 400) ps.shift(); }
      } catch {}
    }
    const s = Math.floor((Date.now() - take.startedAt) / 1000), lim = take.limit;
    if (lim && s >= lim.sec) { if (take.camera && /29:59/.test(lim.why)) cam.markStoppedByCamera(); stopTogether(lim.why); return; }
    if (lim && s === lim.sec - 60) toast(`One minute left: ${lim.why}.`, 'error');
    renderRec();
  }

  async function toggleTake() {
    if (busy) return;
    busy = true;
    try { take ? await stopTake() : await startTake(); } finally { busy = false; renderRec(); }
  }
  ui.rec.onclick = () => { ui.rec.blur(); toggleTake(); };
  window.addEventListener('beforeunload', e => { if (take || takes.some(t => t.saving)) { e.preventDefault(); e.returnValue = ''; } });
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
