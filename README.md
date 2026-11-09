# Space Cam

One page to run a solo recording: **camera control + audio recording + teleprompter** (Dual Monitor).
Built on the Space Prompter design. Chrome or Edge on a Mac. Built and tested with a Sony A7 III.

- App: https://spacecam.shovonix.dev (cam.shovonix.dev redirects here)
- Camera diagnostics: `/test/` lists every setting and action the camera exposes

## What it does
- **Prompter** (from Space Prompter, Dual Monitor only): scripts, control window on the Mac, stage window on the prompter screen, speed, size, flip, rotate, fade, guide line, Bluetooth pedal.
- **Camera** (right rail): one dropdown for a USB camera (Sony over PC Remote) or any Mac camera. USB: live preview (~24 fps, for framing), exposure/battery readout, hold-to-autofocus, manual focus near/far with step size, grid, big floating preview window. Mac camera: records MP4 video with the take. The camera can show behind the script (or in a corner), in black and white by default, and on the Stage window too. That's display only; recordings stay in colour.
- **Audio** (right rail): pick any mic, level meter with clip light, live wave above the progress bar with room noise. Records WAV 24-bit at the mic's rate while recording, saved as MP3 (320 kbps) when you stop. Browser processing (echo cancel, noise suppression, auto gain) is off.
- **Sounds** (right rail): beeps when recording starts and stops, a buzz when something drops (camera, mic, a failed capture). One switch for all.
- **Record** (bottom bar): one press starts the camera clip and the audio file together, and everything stops together if one part drops. Timer, warning from 29:00, 29:59 clip limit only on bodies that have one (A7 III etc.). When a take stops, the prompter stops scrolling, a red line marks where it stopped in the script (click it to continue from there), and a card opens to name the recording.
- **Recordings** (left rail): newest first, with a thumbnail, date and length; click one for the player, rename and delete (delete removes the files). Audio (and Mac-camera video) is written into the browser's private storage while recording (survives a crash), then saved when you stop: to Downloads, or to a folder you pick bottom left. Unsaved takes are recovered on the next visit. Cards whose files were deleted from the folder disappear by themselves.
- **Scripts** (left rail): newest first with date and word count; the script popup lists all scripts on the left. Its Coverage tab shows, per paragraph, which recordings covered it; star the one to use.
- **Markers**: when a take stops, a line marks where it stopped in the script (name and length beside it; click to continue from there), the read part goes grey, and tapping a word turns it white again from there. Clear markers (top right) removes them all. Each recording's popup shows its Script part: which paragraphs it covered and the second each one starts (click to jump).

File names: `Take_1.mp3`, `Take_2.mp3` (plus `Take_N.mp4` from a Mac camera) … one counter that never goes back, so names never repeat. Sync in Premiere with the camera's own audio: Synchronize → Audio.

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
- `webcam-core.js`, `video-writer.worker.js` — Mac camera engine and MP4 writer (no UI)
- `mp3-encode.worker.js` — WAV → MP3 on save
- `lib/lamejs/` — [lamejs](https://github.com/zhuker/lamejs) MP3 encoder (LGPL-3.0)
- `lib/` — [web-gphoto2](https://github.com/GoogleChromeLabs/web-gphoto2) 0.4.1 (LGPL-2.1), `.mjs` renamed to `.js` for static hosting
- `coi-serviceworker.js` — [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT), cross-origin isolation on a static host

Only one tab or app can hold the camera at a time.
