# Offline engine files (not in git)

These big files are kept out of the repository and copied to the server once by hand. Users download them from
the app only when they press the download button (Mic tab → Voice scroll, Camera tab → Shooting assistant).

| File | Size | From |
|---|---|---|
| `models/vosk-model-small-en-us-0.15.tar.gz` | 41 MB | https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz (Alpha Cephei, Apache-2.0) |
| `models/blaze_face_short_range.tflite` | 0.2 MB | https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite (Google, Apache-2.0) |
| `lib/vosk/vosk.js` | 5.8 MB | npm `vosk-browser@0.0.8`, `dist/vosk.js` (Apache-2.0) |
| `lib/mediapipe/wasm/vision_wasm_internal.js` + `.wasm` | 9.6 MB | npm `@mediapipe/tasks-vision@0.10.14`, `wasm/` (Apache-2.0) |

On the VPS they live in the same paths under `/home/cam/htdocs/cam.shovonix.dev/` (owned by `cam`). `git pull` leaves them alone (untracked + ignored).
If they're ever missing, the download buttons fail with an error and the rest of Space Cam works as normal.
