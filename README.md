# Space Cam

Control your camera from the browser over USB: live preview, record start/stop, autofocus and manual focus. Nothing to install.

**Built and tested on Sony A7 III (ILCE-7M3), Chrome on macOS.** Other cameras may work through gPhoto2, untested.

- App: https://cam.shovonix.dev (staging: https://shovonix.dev/cam/)
- Diagnostics page: `/test/` lists every setting and action the camera exposes

## Features (v1)
- Live preview (~24 fps, 1024×576, for framing)
- Record start/stop with timer, warning from 29:00, A7 III clip limit at 29:59
- Hold-to-autofocus, manual focus near/far with step size (camera on MF)
- Rule-of-thirds grid
- Floating mini window (Chrome Document Picture-in-Picture) to sit next to other apps such as Space Prompter
- Exposure / battery readout (ISO, shutter, aperture, focus mode, battery)
- Setup help when connecting fails, with copyable fixes

## Shortcuts
`R` record · hold `F` autofocus · `←` `→` focus near/far · `G` grid · `M` mini window · `?` help

## Camera setup
1. MENU → Network → Ctrl w/ Smartphone → Off
2. MENU → Setup → USB Connection → PC Remote
3. Quit Imaging Edge, Photos and Image Capture, plug in USB-C

macOS's `ptpcamerad` service can grab the camera first. If connecting fails, the app shows two fixes:
- Quick: `while true; do killall -9 ptpcamerad 2>/dev/null; sleep 0.5; done` in Terminal while connecting
- Permanent (try once, then restart): `launchctl disable gui/$UID/com.apple.ptpcamerad` · undo with `enable`

## Architecture
- `cam-core.js` — the engine. No UI. Emits `state`, `frame`, `stats`, `info`, `error`, `log` events. Meant to be reused by future Space apps (e.g. Space Studio).
- `app.js`, `index.html`, `app.css` — the Space Cam interface.
- `lib/` — [web-gphoto2](https://github.com/GoogleChromeLabs/web-gphoto2) 0.4.1 (LGPL-2.1), unmodified except `.mjs` renamed to `.js` so static hosts serve the right MIME type.
- `coi-serviceworker.js` — [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT); enables cross-origin isolation (needed by the engine) on a plain static host. Reloads the page once on first visit.

Only one tab or app can hold the camera at a time.
