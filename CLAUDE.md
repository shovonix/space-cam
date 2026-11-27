# Space Cam

One page for a solo recording: camera control + audio recording + teleprompter. Live at https://spacecam.shovonix.dev. (The old address cam.shovonix.dev was shut down on 11 Nov 2026: site deleted, no longer answers.) Chrome or Edge on a Mac, built and tested with a Sony A7 III.

## What's in this repo
- `index.html` — prompter page, forked from Space Prompter v3.5 (Dual Monitor only).
- `studio.js`, `studio.css` — camera, audio, record and takes panels.
- `cam-core.js` — camera engine, no UI. `audio-core.js`, `audio-writer.worker.js` — audio engine and WAV writer, no UI. `webcam-core.js`, `video-writer.worker.js` — Mac camera engine and MP4 writer, no UI. `mp3-encode.worker.js` + `lib/lamejs/` (LGPL-3.0) — MP3 on save. Keep engines and UI separate.
- `lib/` — vendored web-gphoto2 0.4.1 (LGPL-2.1). Don't edit it.
- `assist-core.js` — Shooting assistant engine, no UI (light, sound, battery; framing/headroom/focus/backlight with the face detector). `lib/mediapipe/` — vendored MediaPipe Tasks Vision 0.10.14 (Apache-2.0) + `models/blaze_face_short_range.tflite`; users download them once (~10 MB) into Cache Storage (`spacecam-assist-v1`). Don't edit.
- `lib/vosk/` — vendored vosk-browser 0.0.8 (Apache-2.0), offline speech for Voice scroll's "On this Mac" engine. `models/vosk-model-small-en-us-0.15.tar.gz` (41 MB, Apache-2.0) is downloaded once by the user from the app into Cache Storage (`spacecam-voice-v1`). Don't edit either.
- `voice-polish.js` (+ `voice-polish.worklet.js` for live) — the Audition-style polish chain shared by Listen and the save step: rumble HPF, de-hum, warmth/presence EQ, de-ess, adaptive compressor, EBU R128 loudness (two-pass on save, mono target = stereo target − 3 dB), look-ahead limiter −1.5 dBFS; also `CLEAN_DEFAULTS` and the slider→engine mappings. Background slider = Adobe-v2-style mix of the removed sound back in (y + bg·(x−y)). Live delay for that mix: `LIVE_DELAY` 1920 samples (measured 1944).
- Microphone settings window (27 Nov 2026, `openMicSet`/`closeMicSet` in studio.js, `.sc-micset`): opens over the script like Camera settings; big live wave, level meter, mic info, and the Polish controls (`.sc-polish`, moved in from the Mic tab). The Mic tab keeps the mic list, the Microphone settings button, Clean up voice (switch, Noise removal, Background, Listen / Hear original), one Notification sounds switch, Voice scroll. Level row and rail wave are hidden (center panel shows them).
- `voice-clean-core.js`, `voice-clean.worker.js`, `voice-clean.worklet-shim.js` — Clean up voice (Mic tab): live cleaned monitor/wave/Listen, and the take cleaned on save (`Take_N.mp3` cleaned + `Take_N_original.mp3`; the recording itself stays raw). `lib/deepfilternet/` — vendored DeepFilterNet3 web build 0.1.0 (MIT/Apache-2.0); `df_bg.wasm` (34 MB) is not in git, users download it once into Cache Storage (`spacecam-clean-v1`). Model delay 1440 samples is taken off on save (sync tested). Mac-camera takes with cleanup on: MP4 keeps the raw sound, the cleaned MP3 sits next to it.
- `mp4-remux.js` — rebuilds Chrome's fragmented MP4 as a normal MP4 (one moov with full sample tables, co64, edit list for the capture-card sound offset), no re-encoding, Blob slices only. Used by `WebcamCore.finalize()` on every MP4 save (falls back to fragmented + `shiftAudio` on error). Why: DaVinci Resolve doesn't import fragmented MP4 (user report, 27 Nov 2026). Honors each fragment's tfdt; tested on a 415 s 4K take: all 9485 video + 19444 audio packet times and sizes identical, stream MD5 identical. Sound timing evened out (27 Nov 2026, `evenSound`): Chrome stamps AAC frames from the clock (mostly 1023 samples, a ~1150 catch-up every ~4 s), which left ~2.6 ms holes — audible bumps in QuickTime/Premiere/Resolve. Every frame now gets 1024; max shift vs Chrome 2.9 ms over 415 s. Also rebuilds older normal-MP4 saves whose sound timing is uneven.
- `coi-serviceworker.js` — vendored (MIT). Needed for cross-origin isolation on a static host; don't remove it.
- `test/` — camera diagnostics page.

No build step.

## Testing
- Needs the real camera over USB-C (PC Remote mode), Chrome/Edge, and the Mac. Only one tab or app can hold the camera.
- Preview locally with `python3 -m http.server 8000`. If a change touches camera or audio, say what Shovon must test by hand with the A7 III.
- Recording safety comes first: audio is written to browser storage while recording and must survive a crash. Never change this without asking.
- A7 III clip limit is 29:59; the warning starts at 29:00.
- Sync (17 Nov 2026, clap tests): Sony over USB starts filming ~0.57 s after the Mac audio; the MP3 start is trimmed on save by the measured USB "Record start" time minus 110 ms (`CAM_DELAY_DEFAULT`, Camera start delay slider). The A7 III turns HDMI off while USB-C (PC Remote) is plugged in. Cam Link 4K: picture ~120 ms behind the mic; camera + mic takes save as ONE MP4 with the sound track moved 120 ms later (`WebcamCore.shiftAudio`, `hdmiDelayMs`), no MP3 unless `mp3WithVideo`. Capture cards record up to 4K (≈35–41 Mbps). Frame rate (27 Nov 2026): two FluentPlayer takes (A7 III 24p → Cam Link 4K) came out ~23 fps with uneven 40–45 ms frame steps; the 4K step now uses `resizeMode: 'none'` and no `frameRate` so Chrome takes the card's native mode. `WebcamCore.frameHealth()` (Chrome's track.stats) is checked every 5 s while recording (warning toast if frames go missing) and saved on the take as `t.frames`. Not yet confirmed with the hardware.

## Keys
- Prompter: Space play/pause (double tap previous paragraph, hold back to top), `F` full screen (Stage).
- Cam: `R` record, hold `A` autofocus, `←` `→` focus near/far, `G` grid lines, `Esc` leaves Camera settings.

## Space Prompter link
- The prompter part is a fork of `space-teleprompter`. When fixing prompter bugs here, say whether the fix belongs upstream too.

## Rules
- Black and white design, same tokens as the other Space apps. Red for recording/warnings.
- Take file names: `Take_1`, `Take_2` … (was `SpaceTake_N` until 9 Nov 2026; the left panel title is "Recordings", the names stay "Take") one counter that never goes back, so names never repeat. Saved to Downloads, or the folder chosen bottom left. Don't change this without asking. (README still shows an old `Take-03_…` example; fix the README, not the code.)
- Licence: all rights reserved (vendored libraries keep their own licences).
- Ask before adding a dependency or a build step.

## Workflow
- Work on the Mac in `~/Sites/space/space-cam`. Commit small, push to `main`.
- Live files: `/home/spacecam/htdocs/spacecam.shovonix.dev` (CloudPanel site `spacecam.shovonix.dev`, site user `spacecam`, its own Let's Encrypt certificate renewed by CloudPanel). Moved there from the old cam.shovonix.dev site on 11 Nov 2026; a backup of the old site is at `/root/cam-site-backup-20261111.tgz` on the VPS.
- Deploy: push to `main`, then on the VPS run `deploy-space cam` as root. It pulls `main` as user `spacecam` over SSH with the read-only deploy key `~spacecam/.ssh/spacecam_deploy`, fast-forward only. (The target is still called `cam` in `/usr/local/bin/deploy-space`.)
- Git data lives outside the web root at `/home/spacecam/space-cam.git` (its work tree is set in `config.worktree`). `CLAUDE.md` and `.claude/` are excluded from the live folder via sparse-checkout (`/home/spacecam/space-cam.git/info/sparse-checkout`: `/*`, `!/CLAUDE.md`, `!/.claude/`). `deploy-space` doesn't touch that file. To exclude another path, append `!/<path>` as user `spacecam`, then run `git read-tree -mu HEAD` with the same `--git-dir`/`--work-tree`.
- Never edit the live files on the VPS directly.

## Versions
- **Beta until the public launch.** Since 17 Nov 2026 the live app is labelled **v1.0 beta** (before: v0.1.8.4 beta on 12 Nov, v0.1.8.5 beta). Later deploys: v1.0.1 beta, v1.0.2 beta … (ask Shovon if he wants another scheme), set in `APP_VERSION` in `index.html`.
- **Public launch = v1.0.** When the website, the video and the blog are live, Shovon says "deploy 1.0": then `APP_VERSION` becomes `v1.0`, and the mass audience sees 1.0 as the first version. Don't relabel to 1.0 before he says so.
- Fixes and small changes until then stay betas; **no major features until v2.0** (planned: live streaming, video calls, conferences, like StreamYard).
- Big offline-engine files (`models/*`, `lib/vosk/vosk.js`, `lib/mediapipe/wasm/`) are not in git (`.gitignore`); they're copied to the VPS by hand once (see `models/README.md`). `git pull` leaves them alone.
- Localhost only: `http://localhost:8000/?fresh` resets Voice scroll and the Shooting assistant to a first visit (off, glowing names).

## Before deploy
- Start the local server from `.claude/launch.json` (`space-cam`: `python3 -m http.server 8000`).
- Test at http://localhost:8000 in Chrome, not the Browser pane (WebUSB camera control and voice scroll need Chrome).
- Close any spacecam.shovonix.dev tab first: only one tab can hold the camera.
- Checklist, all must pass:
  1. Camera connects and the preview shows.
  2. Mic meter moves.
  3. `R` records ~10s, stop, `Take_N.mp3` appears in Downloads (or the chosen folder).
  4. Prompter scrolls with Space, the pedal and Voice scroll.
  5. Whatever this change touched.
- Bump the `?v=` date on `studio.css` (in the `<head>` of `index.html`) and `studio.js` (at the bottom) — keep both the same (e.g. `2026-11-09` → `2026-11-12`; add `b` for a second deploy the same day). studio.js passes it on to every file it loads, so browsers pick up the new code without a hard reload.
- Bump `APP_VERSION` in `index.html` to the next beta (v1.0.1 beta, v1.0.2 beta …; plain v1.0 only at the public launch): it shows on the bottom line of the left panel, and open copies get the "new version" notice.
- Replace the lines in `<script id="sc-changes">` in `index.html` with this deploy's changes ("added" / "fixed", plain words, one line each, written for users). They show in the update notice and in the What's new card after the reload; clicking the version under the logo opens the card again.
- Only after that: commit, push, then Shovon runs `deploy-space cam` on the VPS.
- Before every push, remind Shovon of this checklist and ask whether it passed.

## Handoff (6 Nov 2026)
Space Cam was built in a separate Claude Code cloud session (commits tagged `session_01EKf9ApNDB7nsQ68ZSJSjQb`). Work now continues here on the Mac. Don't use that cloud session for Space Cam anymore.

**Done (see `git log`):**
- v1 on 4–5 Nov: camera control over USB (web-gphoto2), WAV recording, Dual Monitor prompter. Installable web app, `/test/` diagnostics page.
- Setup: first page is Camera | Mic | Script with a setup sidebar (save folder, Bluetooth pedal). Auto-reconnect after reload (~20s retries, because macOS's camera service grabs the camera). Mac setup steps shown until first connect.
- Takes: left rail with inline waveform player, rename, delete. Names are `Take_N`, saved to Downloads or a chosen folder.
- Mic: RMS level meter with slow release and peak marker; can be disabled.
- Prompter (6 Nov): tap a word to continue from there, line spacing, paragraph gap, adjustable reading line, pause marks at paragraph breaks.
- **Voice scroll (6 Nov):** toggle in the Controls rail. Uses `webkitSpeechRecognition` (en-US), matches spoken words in a 30-word window ahead of the guide line and calls `seekTo()`. It's live on spacecam.shovonix.dev but **not yet tested with the A7 III on a real shoot**.

**Open / next:**
1. Shovon tests Voice scroll on a real shoot: camera connected, recording running, voice scroll and pedal both moving the prompter, a take saved. Fix anything found before adding features.
2. README is out of date: take names, and the shortcut list (record is `R`, and Cmd+R releases the camera cleanly). Check the Keys section above against `studio.js` and fix whichever is wrong.
3. Prompter changes here (tap-to-continue, voice scroll) aren't in `space-teleprompter`. Ask Shovon whether to port them upstream.

Before changing camera or audio code, say exactly what Shovon must test by hand with the A7 III.
