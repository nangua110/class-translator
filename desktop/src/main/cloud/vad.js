import fs from "node:fs";
import { createRequire } from "node:module";

// WebAssembly 版推理：不需要为每种系统编译原生模块，Mac 上就能打 Windows 包
const require = createRequire(import.meta.url);
const ort = require("onnxruntime-web");
ort.env.wasm.numThreads = 1;

export const MIN_VOICE_SEC = 0.3; // 一段里真正的人声不足这么长就不送去识别（省额度）
const SR = 16000, WIN = 512, CTX = 64, THRESHOLD = 0.5;

/** Silero v6 人声检测：分辨老师说话和敲桌子、挪椅子、空调声 */
export class VoiceDetector {
  static async load(modelPath) {
    return new VoiceDetector(await ort.InferenceSession.create(fs.readFileSync(modelPath)));
  }
  constructor(session) {
    this.session = session;
    this.queue = Promise.resolve();
  }
  /** 一段 16kHz 音频里有多少秒是人声；每次从头算，多次调用排队执行 */
  voicedSeconds(f32) {
    const run = this.queue.then(() => this.#run(f32));
    this.queue = run.catch(() => {});
    return run;
  }
  async hasVoice(f32, minSec = MIN_VOICE_SEC) {
    return (await this.voicedSeconds(f32)) >= minSec;
  }
  async #run(f32) {
    let state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
    const sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(SR)]), []);
    let context = new Float32Array(CTX), voiced = 0;
    for (let i = 0; i + WIN <= f32.length; i += WIN) {
      const chunk = f32.subarray(i, i + WIN);
      const input = new Float32Array(CTX + WIN);
      input.set(context);
      input.set(chunk, CTX);
      const out = await this.session.run({ input: new ort.Tensor("float32", input, [1, CTX + WIN]), state, sr });
      state = out.stateN;
      context = chunk.slice(-CTX);
      if (out.output.data[0] > THRESHOLD) voiced += WIN;
    }
    return voiced / SR;
  }
}
