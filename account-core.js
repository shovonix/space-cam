// Space Cam account engine, no UI: optional email sign-in (6-digit code) and settings that follow you to every Mac.
// Server: space-account (shovonix.dev/account). Recordings and scripts are never sent; only the settings listed below.
const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const API = LOCAL ? 'http://localhost:8789/account/api' : 'https://shovonix.dev/account/api';
const APP = 'Space Cam';
const KEY = 'spaceCam.account';            // { token, email, news } on this device
const PUSHED = 'spaceCam.accountPushed';    // JSON of the settings last sent, so unchanged settings aren't sent again

// Settings that travel. Not here on purpose: device ids (mic, camera, folder), takes, scripts, first-visit flags.
const KEYS = ['grid', 'camBW', 'camDelayMs', 'stageOpacity', 'stageCam', 'centerView', 'centerOpacity',
  'assistOn', 'assistLight', 'assistFrame', 'voiceOn', 'voiceEngine', 'voiceLang', 'customLogo', 'theme', 'hdmiDelayMs', 'mp3WithVideo'];
const PROMPTER = 'spaceCamState';
const PROMPTER_KEYS = ['mirrored', 'flipped', 'rotation', 'align', 'speed', 'fontSize', 'marginPx', 'dimPct', 'dimOn', 'bgOpacity',
  'pedalKeys', 'guideVisible', 'lineSpacing', 'paraSpacing', 'guidePos', 'pauseMarks', 'previewVisible'];

const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export const AccountCore = {
  get session() { return read(KEY); },
  get signedIn() { return !!read(KEY)?.token; },

  async call(path, { method = 'GET', body = null, auth = true } = {}) {
    const s = read(KEY), headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (auth && s?.token) headers.Authorization = 'Bearer ' + s.token;
    let r;
    try { r = await fetch(API + path + (path.includes('?') ? '&' : '?') + 'app=' + encodeURIComponent(APP), { method, headers, body: body ? JSON.stringify(body) : null }); }
    catch { throw new Error("Can't reach the account server. Check the internet and try again."); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && auth) { write(KEY, null); write(PUSHED, null); }
    if (!r.ok) throw Object.assign(new Error(j.error || 'Something went wrong. Try again.'), { status: r.status });
    return j;
  },

  // settings on this device, as one object
  collect() {
    const keys = {};
    for (const k of KEYS) { const v = localStorage.getItem('spaceCam.' + k); if (v !== null) keys[k] = read('spaceCam.' + k); }
    const st = read(PROMPTER) || {}, prompter = {};
    for (const k of PROMPTER_KEYS) if (k in st) prompter[k] = st[k];
    return { keys, prompter };
  },
  // put saved settings into this device; true if anything changed (the page then reloads once to use them)
  apply(prefs) {
    if (!prefs || typeof prefs !== 'object') return false;
    const before = JSON.stringify(this.collect());
    for (const k of KEYS) if (prefs.keys && k in prefs.keys) write('spaceCam.' + k, prefs.keys[k]);
    if (prefs.prompter) { const st = read(PROMPTER) || {}; for (const k of PROMPTER_KEYS) if (k in prefs.prompter) st[k] = prefs.prompter[k]; write(PROMPTER, st); }
    const now = JSON.stringify(this.collect());
    write(PUSHED, now);
    return now !== before;
  },

  requestCode(email) { return this.call('/code', { method: 'POST', body: { email, app: APP }, auth: false }); },
  // returns { changed }: changed = settings from the account were put on this device (reload to use them)
  async verify(email, code, news) {
    const device = /Mac/.test(navigator.userAgent) ? (window.spaceCamApp ? 'Mac app' : 'Mac browser') : 'Browser';
    const j = await this.call('/verify', { method: 'POST', body: { email, code, news, app: APP, device }, auth: false });
    write(KEY, { token: j.token, email: j.email, news: j.news });
    if (j.prefs) return { changed: this.apply(j.prefs) };
    await this.push(true); // first device: its settings become the account's
    return { changed: false };
  },
  // on load: newer settings from another device win; otherwise send ours if they changed
  async refresh() {
    if (!this.signedIn) return { changed: false };
    const j = await this.call('/me');
    write(KEY, { ...read(KEY), email: j.email, news: j.news });
    const pushed = read(PUSHED), mine = JSON.stringify(this.collect());
    if (j.prefs && JSON.stringify(j.prefs) !== pushed && mine === pushed) return { changed: this.apply(j.prefs) }; // changed elsewhere
    if (mine !== pushed) await this.push(true);
    return { changed: false };
  },
  async push(force = false) {
    if (!this.signedIn) return;
    const now = JSON.stringify(this.collect());
    if (!force && now === read(PUSHED)) return;
    await this.call('/prefs', { method: 'PUT', body: { prefs: JSON.parse(now) } });
    write(PUSHED, now);
  },
  async setNews(news) { const j = await this.call('/news', { method: 'POST', body: { news } }); write(KEY, { ...read(KEY), news: j.news }); },
  async signOut() { try { await this.call('/logout', { method: 'POST' }); } catch {} write(KEY, null); write(PUSHED, null); },
  async deleteAccount() { await this.call('/account', { method: 'DELETE' }); write(KEY, null); write(PUSHED, null); },
};
