# MediaPipe Tasks Vision 0.10.14 (vendored)

Face detector for the Shooting assistant (framing, headroom, focus on face, backlight). Runs offline in the browser.

- Source: npm `@mediapipe/tasks-vision@0.10.14` (https://github.com/google-ai-edge/mediapipe), files unchanged:
  `vision_bundle.js` (renamed from `.mjs`: the server only sends `.js` as JavaScript), `wasm/vision_wasm_internal.js`, `wasm/vision_wasm_internal.wasm` (SIMD build only)
- Licence: Apache-2.0
- Model: `models/blaze_face_short_range.tflite` (BlazeFace short range, float16, Google, Apache-2.0)
- Users download the wasm + model once from the app (Camera tab → Shooting assistant); they're kept in Cache Storage (`spacecam-assist-v1`).

Don't edit these files.
