// voice-polish.worklet.js — runs voice-polish.js live in the audio thread, for Clean up voice's Listen and wave.
// voice-polish.js is added to the worklet first (same ?v= stamp) and leaves its Polish class on globalThis.SpacePolish.
registerProcessor('space-polish', class extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.p = new globalThis.SpacePolish(sampleRate);
    this.p.set({ ...(opts.processorOptions || {}), live: true });
    this.port.onmessage = e => this.p.set({ ...e.data, live: true });
  }
  process(inputs, outputs) {
    const i = inputs[0]?.[0], o = outputs[0]?.[0];
    if (!o) return true;
    if (!i) { o.fill(0); return true; }
    o.set(i); this.p.process(o);
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(o);
    return true;
  }
});
