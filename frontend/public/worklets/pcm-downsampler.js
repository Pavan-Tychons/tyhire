// AudioWorklet processor for the realtime live-transcription feature (useRealtimeTranscribe.ts).
//
// It converts the mic's Float32 audio into the mono 16-bit PCM @ 24 kHz that OpenAI's realtime
// transcription session expects, and posts it to the main thread in ~40 ms frames to be streamed
// over the WebSocket. Downsampling happens here (off the main thread) so the UI never janks.
//
// This runs as a classic AudioWorklet module served statically from /worklets/ — it is NOT bundled
// by Next/Turbopack, so keep it plain ES (no imports, no TS). `sampleRate` is a global provided by
// the AudioWorklet scope (the AudioContext's actual rate). We still downsample from it even when
// the context was created at 24 kHz (ratio 1 = passthrough), so this is correct on browsers that
// ignore a requested sampleRate.

const TARGET_RATE = 24000;
// 24000 * 0.04s = 960 samples per frame — matches the frame size validated against the API.
const FRAME_SAMPLES = 960;

class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ratio = sampleRate / TARGET_RATE; // >= 1 when the context runs above 24 kHz
    this._readPos = 0; // fractional read position carried across process() blocks
    this._pending = []; // downsampled Float32 samples not yet flushed as a frame
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) {
      return true; // keep the processor alive even across brief gaps
    }

    // Nearest-sample decimation. Speech STT does not need an anti-aliasing filter here, and
    // nearest-sample keeps this cheap and allocation-free in the hot path.
    let pos = this._readPos;
    while (pos < channel.length) {
      this._pending.push(channel[Math.floor(pos)]);
      pos += this._ratio;
    }
    this._readPos = pos - channel.length;

    while (this._pending.length >= FRAME_SAMPLES) {
      const frame = this._pending.splice(0, FRAME_SAMPLES);
      const pcm = new Int16Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        const s = Math.max(-1, Math.min(1, frame[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      // Transfer the buffer so no copy is made crossing the worklet boundary.
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-downsampler", PcmDownsampler);
