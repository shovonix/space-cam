// voice-clean.worklet-shim.js — loaded into the AudioWorklet before lib/deepfilternet/worklet.js.
// Chrome's AudioWorkletGlobalScope has no TextDecoder, which the DeepFilterNet glue code creates at start
// (it only uses it for error messages). Without this the processor never registers.
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class {
    decode(bytes) {
      if (!bytes) return '';
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); // error text is plain ASCII
      return s;
    }
  };
}
