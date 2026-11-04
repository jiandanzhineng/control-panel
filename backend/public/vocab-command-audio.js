(function (root) {
  'use strict';

  // PCM 短帧持续送本机 KWS；不检测停顿、不攒整句、不生成 WAV。
  class VocabCommandAudio {
    constructor(env) {
      this.env = env;
      this.current = null;
    }

    release(state) {
      if (!state) return;
      state.closed = true;
      if (state.node) {
        state.node.port.onmessage = null;
        try { state.node.disconnect(); } catch (_) {}
      }
      try { state.source?.disconnect(); } catch (_) {}
      try { state.mute?.disconnect(); } catch (_) {}
      state.stream?.getTracks().forEach(track => track.stop());
      try { if (state.context && state.context.state !== 'closed') state.context.close().catch(() => {}); } catch (_) {}
      if (this.current === state) this.current = null;
    }

    stop() { this.release(this.current); }

    async start(onFrame, onError) {
      this.stop();
      const env = this.env;
      const state = { closed: false };
      this.current = state;
      const alive = () => !state.closed && this.current === state;
      try {
        state.stream = await env.navigator.mediaDevices.getUserMedia({ audio: {
          channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        } });
        if (!alive()) { this.release(state); return false; }
        const Audio = env.AudioContext || env.webkitAudioContext;
        state.context = new Audio({ sampleRate: 16000 });
        if (state.context.sampleRate !== 16000) throw new Error('KWS requires 16 kHz audio');
        const source = `class VocabCapture extends AudioWorkletProcessor {
          constructor() { super(); this.frame = new Float32Array(512); this.used = 0; }
          process(inputs) {
            const data = inputs[0] && inputs[0][0];
            if (data) for (let i = 0; i < data.length; i++) {
              this.frame[this.used++] = data[i];
              if (this.used === 512) { this.port.postMessage(this.frame); this.used = 0; }
            }
            return true;
          }
        } registerProcessor('vocab-command-capture', VocabCapture);`;
        const url = env.URL.createObjectURL(new env.Blob([source], { type: 'application/javascript' }));
        try { await state.context.audioWorklet.addModule(url); }
        finally { env.URL.revokeObjectURL(url); }
        if (!alive()) { this.release(state); return false; }
        state.node = new env.AudioWorkletNode(state.context, 'vocab-command-capture');
        state.node.port.onmessage = event => {
          if (!alive()) return;
          const samples = event.data;
          if (!samples || !samples.length) return;
          const bytes = new Uint8Array(samples.length * 2);
          const view = new DataView(bytes.buffer);
          for (let i = 0; i < samples.length; i++) {
            const value = Math.max(-1, Math.min(1, samples[i]));
            view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
          }
          onFrame(env.btoa(String.fromCharCode.apply(null, bytes)));
        };
        state.node.onprocessorerror = () => {
          if (!alive()) return;
          this.release(state);
          onError(new Error('AudioWorklet failed'));
        };
        for (const track of state.stream.getTracks()) track.onended = () => {
          if (!alive()) return;
          this.release(state);
          onError(new Error('Microphone disconnected'));
        };
        state.source = state.context.createMediaStreamSource(state.stream);
        state.mute = state.context.createGain();
        state.mute.gain.value = 0;
        state.source.connect(state.node);
        state.node.connect(state.mute);
        state.mute.connect(state.context.destination);
        await state.context.resume();
        return alive();
      } catch (error) {
        this.release(state);
        throw error;
      }
    }
  }

  root.VocabCommandAudio = VocabCommandAudio;
  if (typeof module !== 'undefined') module.exports = VocabCommandAudio;
})(typeof window !== 'undefined' ? window : globalThis);
