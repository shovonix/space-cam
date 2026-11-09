# Space Cam

One page to run a solo recording: **camera control + audio recording + teleprompter** (Dual Monitor).
Built on the Space Prompter design. Chrome or Edge on a Mac. Built and tested with a Sony A7 III.

- App: https://spacecam.shovonix.dev (cam.shovonix.dev redirects here)
- Camera diagnostics: `/test/` lists every setting and action the camera exposes

## What it does
- **Prompter** (from Space Prompter, Dual Monitor only): scripts, control window on the Mac, stage window on the prompter screen, speed, size, flip, rotate, fade, guide line, Bluetooth pedal.
- **Camera** (right rail): live preview (~24 fps, for framing), exposure/battery readout, hold-to-autofocus, manual focus near/far with step size, grid, big floating preview window.
- **Audio** (right rail): pick any mic, level meter with clip light, WAV 24-bit at the mic's rate. Browser processing (echo cancel, noise suppression, auto gain) is off.
- **Record** (bottom bar): one press starts the camera clip and the audio file together. Timer, warning from 29:00, A7 III clip limit 29:59.
- **Takes** (left rail): each take with its time, an inline waveform player, Rename and Delete. Audio is written into the browser's private storage while recording (survives a crash), then saved when you stop: to Downloads, or to a folder you pick bottom left (with a folder, Rename renames the file too). Unsaved takes are recovered on the next visit.

File names: `SpaceTake_1.wav`, `SpaceTake_2.wav` … one counter that never goes back, so names never repeat. Sync in Premiere with the camera's own audio: Synchronize → Audio.

## Shortcuts
Prompter: `Space` play/pause (double-tap previous paragraph, hold back to top) · `F` full screen · `E` edit
Space Cam: `R` record camera + audio · hold `A` autofocus · `←` `→` focus near/far (camera on MF) · `G` grid · `Cmd+R` reload and reconnect (releases the camera cleanly first; not while recording)

## Camera setup
1. MENU → Network → Ctrl w/ Smartphone → Off
2. MENU → Setup → USB Connection → PC Remote
3. Quit Imaging Edge, Photos and Image Capture, plug in USB-C

If connecting fails, the app shows the fixes for macOS's `ptpcamerad`, which can grab the camera first.

## Files
- `index.html` — the prompter page (forked from Space Prompter v3.5, Dual Monitor only)
- `studio.js`, `studio.css` — camera, audio, record and takes panels
- `cam-core.js` — camera engine (no UI)
- `audio-core.js`, `audio-writer.worker.js` — audio engine and WAV writer (no UI)
- `lib/` — [web-gphoto2](https://github.com/GoogleChromeLabs/web-gphoto2) 0.4.1 (LGPL-2.1), `.mjs` renamed to `.js` for static hosting
- `coi-serviceworker.js` — [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT), cross-origin isolation on a static host

Only one tab or app can hold the camera at a time.
