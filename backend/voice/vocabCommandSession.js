const engine = require('./voiceTriggerService');
const catalog = require('./vocabCommandCatalog');

const MODEL = 'zipformer-zh-en-3M-kws';

class VocabCommandSession {
  constructor({ send, now = Date.now, createSession = () => engine.createSession(catalog) }) {
    this.send = send;
    this.now = now;
    this.createSession = createSession;
    this.generation = 0;
    this.epoch = 0;
    this.stream = null;
    this.requested = false;
    this.disposed = false;
    this.seq = 0;
    this.blockedUntil = 0;
    this.wasBlocked = false;
    this.lastHitAt = 0;
    this.frame = new Float32Array(1600);
    this.used = 0;
    this.quietSamples = 0;
  }

  async start(options) {
    const generation = Number(options.generation);
    if (this.disposed || !Number.isSafeInteger(generation) || generation < 1 || generation < this.generation) {
      throw Object.assign(new Error('口令会话已失效'), { code: 'NO_KWS' });
    }
    this.stop();
    this.generation = generation;
    this.requested = true;
    this.seq = Number(options.seq) || 0;
    this.blockedUntil = Number(options.blockedUntil) || 0;
    this.wasBlocked = false;
    this.lastHitAt = 0;
    this.used = 0;
    this.quietSamples = 0;
    const epoch = this.epoch;
    const stream = await this.createSession();
    if (this.disposed || !this.requested || epoch !== this.epoch) {
      stream.close();
      return { ready: false, mode: 'kws', model: MODEL };
    }
    this.stream = stream;
    return { ready: true, mode: 'kws', model: MODEL };
  }

  update(options) {
    if (options.generation !== this.generation || !this.requested) return;
    const seq = Number(options.seq) || 0;
    if (seq !== this.seq) {
      this.seq = seq;
      this.lastHitAt = 0;
      this.used = 0;
      this.quietSamples = 0;
      this.stream?.reset();
    }
    this.blockedUntil = Number(options.blockedUntil) || 0;
    if (this.blockedUntil > this.now()) this.wasBlocked = true;
  }

  accept(options) {
    if (!this.stream || !this.requested || options.generation !== this.generation || options.seq !== this.seq) return;
    const at = this.now();
    if (at < this.blockedUntil) {
      this.wasBlocked = true;
      return;
    }
    if (this.wasBlocked) {
      this.stream.reset();
      this.used = 0;
      this.quietSamples = 0;
      this.wasBlocked = false;
    }
    // 短 PCM16 帧只在本机 bridge 传输，不生成 WAV，也不调用 ASR/云端。
    if (typeof options.audio !== 'string' || options.audio.length > 22000) return;
    const pcm = Buffer.from(options.audio, 'base64');
    if (!pcm.length || pcm.length % 2 || pcm.length > 16000) return;
    // 与手机版一致，固定每 100 ms 解码，避免设备/Worklet 的分帧差异影响短口令。
    for (let i = 0; i < pcm.length / 2; i++) {
      this.frame[this.used++] = pcm.readInt16LE(i * 2) / 32768;
      if (this.used !== this.frame.length) continue;
      this.used = 0;
      let energy = 0;
      for (const value of this.frame) energy += value * value;
      this.quietSamples = energy / this.frame.length < 0.000001 ? this.quietSamples + this.frame.length : 0;
      // 留足模型约 660 ms 的尾部，再清理长静音下的编码器历史。
      if (this.quietSamples >= 24000) {
        this.stream.reset();
        this.quietSamples = 0;
      }
      const hit = this.stream.accept(this.frame);
      if (!hit) continue;
      this.stream.reset();
      if (at - this.lastHitAt < 350) return;
      this.lastHitAt = at;
      this.send({ event: 'speechCommand', data: {
        generation: this.generation, seq: this.seq, command: hit.id, text: hit.label,
        mode: 'kws', model: MODEL, at,
      } });
      return;
    }
  }

  stop(generation) {
    if (generation != null && generation !== this.generation) return;
    this.requested = false;
    this.epoch++;
    this.used = 0;
    this.quietSamples = 0;
    this.stream?.close();
    this.stream = null;
  }

  dispose() {
    this.disposed = true;
    this.stop();
  }
}

module.exports = { VocabCommandSession, MODEL };
