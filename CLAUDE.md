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
- Take file names: `Take-03_2026-11-05_110438.wav`. Don't change the format.
- Licence: all rights reserved (vendored libraries keep their own licences).
- Ask before adding a dependency or a build step.

## Workflow
- Work on the Mac in `~/Sites/space/space-cam`. Commit small, push to `main`.
- Live files: `/home/cam/htdocs/cam.shovonix.dev` (CloudPanel site user `cam`). There's no separate spacecam site folder, so spacecam.shovonix.dev is presumably served from this one; check the nginx vhost before changing domains.
- That folder is NOT a git checkout yet, and this repo is private, so the server can't fetch it without a deploy key. Until one is set up (like Space Balance), ask Shovon before deploying. Files must stay owned by user `cam`.
- Never edit the live files on the VPS directly.
