# Space Cam

One page for a solo recording: camera control + audio recording + teleprompter. Live at https://spacecam.shovonix.dev (cam.shovonix.dev redirects). Chrome or Edge on a Mac, built and tested with a Sony A7 III.

## What's in this repo
- `index.html` — prompter page, forked from Space Prompter v3.5 (Dual Monitor only).
- `studio.js`, `studio.css` — camera, audio, record and takes panels.
- `cam-core.js` — camera engine, no UI. `audio-core.js`, `audio-writer.worker.js` — audio engine and WAV writer, no UI. Keep engines and UI separate.
- `lib/` — vendored web-gphoto2 0.4.1 (LGPL-2.1). Don't edit it.
- `coi-serviceworker.js` — vendored (MIT). Needed for cross-origin isolation on a static host; don't remove it.
- `test/` — camera diagnostics page.

No build step.

## Testing
- Needs the real camera over USB-C (PC Remote mode), Chrome/Edge, and the Mac. Only one tab or app can hold the camera.
- Preview locally with `python3 -m http.server 8000`. If a change touches camera or audio, say what Shovon must test by hand with the A7 III.
- Recording safety comes first: audio is written to browser storage while recording and must survive a crash. Never change this without asking.
- A7 III clip limit is 29:59; the warning starts at 29:00.

## Keys
- Prompter: Space play/pause (double tap previous paragraph, hold back to top), `F` full screen, `E` edit.
- Cam: `R` record, hold `A` autofocus, `←` `→` focus near/far, `G` grid.

## Space Prompter link
- The prompter part is a fork of `space-teleprompter`. When fixing prompter bugs here, say whether the fix belongs upstream too.

## Rules
- Black and white design, same tokens as the other Space apps. Red for recording/warnings.
- Take file names: `SpaceTake_1`, `SpaceTake_2` … one counter that never goes back, so names never repeat. Saved to Downloads, or the folder chosen bottom left. Don't change this without asking. (README still shows an old `Take-03_…` example; fix the README, not the code.)
- Licence: all rights reserved (vendored libraries keep their own licences).
- Ask before adding a dependency or a build step.

## Workflow
- Work on the Mac in `~/Sites/space/space-cam`. Commit small, push to `main`.
- Live files: `/home/cam/htdocs/cam.shovonix.dev` (CloudPanel site user `cam`). There's no separate spacecam site folder, so spacecam.shovonix.dev is presumably served from this one; check the nginx vhost before changing domains.
- Deploy: push to `main`, then on the VPS run `deploy-space cam` as root. It pulls `main` as user `cam` over SSH with the read-only deploy key `~cam/.ssh/spacecam_deploy`, fast-forward only.
- Git data lives outside the web root at `/home/cam/space-cam.git`. `CLAUDE.md` is excluded from the live folder via sparse-checkout.
- Never edit the live files on the VPS directly.

## Handoff (6 Nov 2026)
Space Cam was built in a separate Claude Code cloud session (commits tagged `session_01EKf9ApNDB7nsQ68ZSJSjQb`). Work now continues here on the Mac. Don't use that cloud session for Space Cam anymore.

**Done (see `git log`):**
- v1 on 4–5 Nov: camera control over USB (web-gphoto2), WAV recording, Dual Monitor prompter. Installable web app, `/test/` diagnostics page.
- Setup: first page is Camera | Mic | Script with a setup sidebar (save folder, Bluetooth pedal). Auto-reconnect after reload (~20s retries, because macOS's camera service grabs the camera). Mac setup steps shown until first connect.
- Takes: left rail with inline waveform player, rename, delete. Names are `SpaceTake_N`, saved to Downloads or a chosen folder.
- Mic: RMS level meter with slow release and peak marker; can be disabled.
- Prompter (6 Nov): tap a word to continue from there, line spacing, paragraph gap, adjustable reading line, pause marks at paragraph breaks.
- **Voice scroll (6 Nov):** toggle in the Controls rail. Uses `webkitSpeechRecognition` (en-US), matches spoken words in a 30-word window ahead of the guide line and calls `seekTo()`. It's live on spacecam.shovonix.dev but **not yet tested with the A7 III on a real shoot**.

**Open / next:**
1. Shovon tests Voice scroll on a real shoot: camera connected, recording running, voice scroll and pedal both moving the prompter, a take saved. Fix anything found before adding features.
2. README is out of date: take names, and the shortcut list (record is `R`, and Cmd+R releases the camera cleanly). Check the Keys section above against `studio.js` and fix whichever is wrong.
3. Prompter changes here (tap-to-continue, voice scroll) aren't in `space-teleprompter`. Ask Shovon whether to port them upstream.

Before changing camera or audio code, say exactly what Shovon must test by hand with the A7 III.
