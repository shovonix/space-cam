# Space Cam

Browser remote for a Sony A7 III over USB: live preview, record start/stop, focus. No app install, runs in Chrome.

**Status:** feasibility test page. Live at https://cam.shovonix.dev once deployed.

## Requirements
- Chrome or Edge on a Mac (WebUSB; Safari and iPad are not supported)
- Camera: MENU → Network → Ctrl w/ Smartphone → Off, Setup → USB Connection → PC Remote
- macOS grabs PTP cameras through `ptpcamerad`; while testing, keep it closed in Terminal:
  `while true; do killall -9 ptpcamerad 2>/dev/null; sleep 0.5; done` (Ctrl+C to stop)

## Credits
- Camera engine: [web-gphoto2](https://github.com/GoogleChromeLabs/web-gphoto2) 0.4.1 by Ingvar Stepanyan / Google (LGPL-2.1), files in `lib/` unmodified except `.mjs` renamed to `.js` for static-host MIME types
- [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT), enables cross-origin isolation on a static host
