# Space Cam v1.0

A camera, teleprompter and microphone that work together. One Record button syncs every recording device in your room.
Built on the Space Prompter design. Chrome or Edge on a Mac. Built and tested with a Sony A7 III.

- App: https://spacecam.shovonix.dev (cam.shovonix.dev redirects here)
- Camera diagnostics: `/test/` lists every setting and action the camera exposes

## What it does
- **Prompter** (from Space Prompter, Dual Monitor only): scripts, control window on the Mac, Stage window on the prompter screen, speed, text size, paragraph gap, flip, rotate (0°/90°/180°/270°), reading line, fade other lines, Bluetooth pedal. The Stage shows a camera + mic signal (grey off, green connected, red recording) and Shooting assistant tips; both can be dragged anywhere and resized, and remember their spot.
- **Camera** (right panel, Camera tab): one dropdown for a USB camera (Sony over PC Remote) or any Mac camera; picking one connects it. Live preview with grid lines, Camera behind text (in black and white by default; display only, recordings stay in colour), Camera visibility. **Camera settings** puts the camera big in the middle with focus (◀ AF ▶) and, for USB cameras, ISO, shutter, aperture, white balance and exposure from the camera's own lists; Back / Save returns to the prompter.
- **Shooting assistant** (Camera tab, off by default): tips while you set up and record: too dark, blown out, noisy room, mic too quiet / clipping / silent, camera battery. With the optional face detector (download, 10 MB, runs on the Mac): off-centre framing, headroom, focus missing your face, backlight.
- **Mic** (Mic tab): pick any mic, level meter, live wave with room noise. Records WAV 24-bit while recording (written to browser storage, survives a crash), saved as MP3 (320 kbps) when you stop. Sounds: separate switches for record start, record stop and error.
- **Voice scroll** (Mic tab, off by default): the script follows your reading. Engine: Google (online) or On this Mac (offline; download 41 MB once; listens only for your script's words). Learns your pace and brings the next line up before you finish the current one.
- **Record** (bottom bar): one press starts every connected device together; if one can't start, nothing records and a message says why. Camera on with the mic off asks first whether the camera records the sound itself. Everything stops together if one part drops. Timer, warning from 29:00, 29:59 clip limit on bodies that have one. When a take stops, the prompter stops, a marker shows where (click it to continue), and a card opens to name the recording.
- **Recordings** (left panel): newest first, with a thumbnail, date and length; click one for the player, rename and delete. Saved to Downloads or a folder you pick. Unsaved takes are recovered on the next visit.
- **Scripts** (left panel): newest first with date and word count; the script popup's Coverage tab shows which recordings covered each paragraph; star the one to use.
- **Markers**: a dot and the take name where each take stopped; they never grey out text. A new take removes the markers after its start. Clear markers (top right) removes them all.
- **Make it yours**: click the top-left logo to use your own icon (also the browser tab icon).

File names: `Take_1.mp3`, `Take_2.mp3` (plus `Take_N.mp4` from a Mac camera) … one counter that never goes back, so names never repeat. Sync in Premiere with the camera's own audio: Synchronize → Audio.

## Shortcuts
Prompter: `Space` play/pause (double-tap previous paragraph, hold back to top) · `F` full screen (Stage)
Camera: `R` record · hold `A` autofocus · `←` `→` focus near/far (camera on MF) · `G` grid lines · `Esc` leaves Camera settings · `Cmd+R` reload and reconnect (releases the camera cleanly first; not while recording)

## Camera setup
1. MENU → Network → Ctrl w/ Smartphone → Off
2. MENU → Setup → USB Connection → PC Remote
3. Quit Imaging Edge, Photos and Image Capture, plug in USB-C

If connecting fails, the app shows the fixes for macOS's `ptpcamerad`, which can grab the camera first.

## Files
- `index.html` — the prompter page (forked from Space Prompter v3.5, Dual Monitor only), voice scroll
- `studio.js`, `studio.css` — camera, audio, record, takes and assistant panels
- `cam-core.js` — camera engine (no UI)
- `audio-core.js`, `audio-writer.worker.js` — audio engine and WAV writer (no UI)
- `webcam-core.js`, `video-writer.worker.js` — Mac camera engine and MP4 writer (no UI)
- `assist-core.js` — Shooting assistant engine (no UI)
- `mp3-encode.worker.js` — WAV → MP3 on save
- `lib/lamejs/` — [lamejs](https://github.com/zhuker/lamejs) MP3 encoder (LGPL-3.0)
- `lib/` — [web-gphoto2](https://github.com/GoogleChromeLabs/web-gphoto2) 0.4.1 (LGPL-2.1), `.mjs` renamed to `.js` for static hosting
- `lib/vosk/` — [vosk-browser](https://github.com/ccoreilly/vosk-browser) 0.0.8 (Apache-2.0), offline speech
- `lib/mediapipe/` — [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) 0.10.14 (Apache-2.0), face detector
- `models/` — offline voice and face models; the big engine and model files aren't in git, see `models/README.md`
- `coi-serviceworker.js` — [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT), cross-origin isolation on a static host

Only one tab or app can hold the camera at a time.
