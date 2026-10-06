// 把麦克风音频降采样到 16kHz Int16，每 ~100ms 发回主线程
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.acc = [];
    this.pos = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (; this.pos < ch.length; this.pos += this.ratio) {
      const s = Math.max(-1, Math.min(1, ch[Math.floor(this.pos)]));
      this.acc.push(s * 0x7fff);
    }
    this.pos -= ch.length;
    if (this.acc.length >= 1600) {
      this.port.postMessage(Int16Array.from(this.acc).buffer, []);
      this.acc = [];
    }
    return true;
  }
}
registerProcessor("pcm-capture", PCMCapture);
