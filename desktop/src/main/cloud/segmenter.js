// 按音量断句（移植自网页版 server.py）：静音超过 0.5 秒或一段超过 8 秒就切，短于 0.6 秒的丢掉
const SR = 16000, FRAME = 480; // 30ms
const SILENCE_SEC = 0.5, MAX_SEG_SEC = 8, MIN_SEG_SEC = 0.6;

export class Segmenter {
  constructor() {
    this.noiseFloor = 0.003;
    this.frames = [];
    this.pending = new Float32Array(0);
    this.carry = null;      // 上一块末尾多出来的半个样本
    this.speech = false;
    this.silenceFrames = 0;
    this.samples = 0;       // 已处理的样本数，用来算开始时间
    this.segStart = 0;
  }

  #toFloat(pcm) {
    let buf = this.carry ? Buffer.concat([this.carry, pcm]) : pcm;
    this.carry = buf.length % 2 ? buf.subarray(buf.length - 1) : null;
    const n = buf.length >> 1;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
    return out;
  }

  #take() {
    const len = this.frames.length * FRAME;
    const seg = len / SR >= MIN_SEG_SEC ? { audio: concat(this.frames, len), start: this.segStart / SR } : null;
    this.frames = [];
    this.speech = false;
    this.silenceFrames = 0;
    return seg;
  }

  feed(pcm) {
    const out = [];
    const chunk = this.#toFloat(pcm);
    const all = new Float32Array(this.pending.length + chunk.length);
    all.set(this.pending);
    all.set(chunk, this.pending.length);
    let i = 0;
    for (; i + FRAME <= all.length; i += FRAME) {
      const frame = all.slice(i, i + FRAME);
      let sum = 0;
      for (const v of frame) sum += v * v;
      const rms = Math.sqrt(sum / FRAME);
      const isVoice = rms > Math.max(this.noiseFloor * 3, 0.006);
      if (!isVoice) this.noiseFloor = 0.995 * this.noiseFloor + 0.005 * rms; // 缓慢跟踪环境噪音
      if (isVoice) {
        if (!this.speech) { this.speech = true; this.segStart = this.samples; }
        this.silenceFrames = 0;
      } else if (this.speech) this.silenceFrames += 1;
      if (this.speech) this.frames.push(frame);
      this.samples += FRAME;
      const segSec = (this.frames.length * FRAME) / SR;
      if (this.speech && ((this.silenceFrames * FRAME) / SR >= SILENCE_SEC || segSec >= MAX_SEG_SEC)) {
        const seg = this.#take();
        if (seg) out.push(seg);
      }
    }
    this.pending = all.slice(i);
    return out;
  }

  flush() {
    if (!this.frames.length) return [];
    const seg = this.#take();
    return seg ? [seg] : [];
  }
}

function concat(frames, len) {
  const out = new Float32Array(len);
  frames.forEach((f, k) => out.set(f, k * FRAME));
  return out;
}
