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
To put them there, run this on the VPS as root (downloads from the sources above, then checks the checksums):

```bash
sudo -u cam bash -c 'cd /home/cam/htdocs/cam.shovonix.dev && mkdir -p models lib/vosk lib/mediapipe/wasm \
&& curl -fsSL -o models/vosk-model-small-en-us-0.15.tar.gz https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz \
&& curl -fsSL -o models/blaze_face_short_range.tflite https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite \
&& curl -fsSL -o lib/vosk/vosk.js https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js \
&& curl -fsSL -o lib/mediapipe/wasm/vision_wasm_internal.js https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.js \
&& curl -fsSL -o lib/mediapipe/wasm/vision_wasm_internal.wasm https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.wasm \
&& printf "%s\n" "f0b24bb92a48ca575b6a96500d6b543f0f079c573dfe85bbe16001fc0404e1d8  models/vosk-model-small-en-us-0.15.tar.gz" "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f  models/blaze_face_short_range.tflite" "29504515526e974f4cb053cf08811c4de5fb2a74007c0a5a957db50eaa8d5d0c  lib/vosk/vosk.js" "9440cf0cc0cea21800e31581ec32aeedcc5fbf9df4509796bbc7d3f99e52ab9c  lib/mediapipe/wasm/vision_wasm_internal.js" "f82a8e6c05e08a44cc9f9e7ec5f845935bcbb1b1500ebe8c2f4812fb4e2917dc  lib/mediapipe/wasm/vision_wasm_internal.wasm" | sha256sum -c'
```
If they're ever missing, the download buttons fail with an error and the rest of Space Cam works as normal.
