import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";

export const LAG_WARN_SEC = 15; // 识别落后说话这么多秒就提醒一次

/** 本地实时识别（英语）：模型在后台线程里跑，边说边出草稿，按句定稿。接口和 AppleASR / CloudASR 一样 */
export class LocalASR extends EventEmitter {
  constructor({ workerPath, modelDir, speaker, offset, makeWorker }) {
    super();
    Object.assign(this, { workerPath, modelDir, speaker, offset });
    this.kind = "local";
    this.makeWorker = makeWorker ?? ((file, workerData) => new Worker(file, { workerData }));
    this.worker = null;
    this.carry = null;      // 上一块末尾多出来的半个样本
    this.fedSec = 0;
    this.exited = false;
    this.lagNoted = false;
    this.onDone = null;
  }

  start() {
    const w = this.makeWorker(this.workerPath, { modelDir: this.modelDir });
    w.on("message", (m) => this.#onWorker(m));
    w.on("error", (e) => { // 线程自己崩了
      this.emit("message", { type: "error", msg: `本地实时识别出错：${String(e?.message ?? e).slice(0, 80)}` });
      this.#exit(1);
    });
    w.on("exit", () => this.#exit(1)); // 没走正常结束流程就退出了
    this.worker = w;
  }

  #onWorker(m) {
    if (m.type === "partial") this.emit("message", { type: "partial", text: m.text });
    else if (m.type === "final") this.emit("message", { type: "final", source: "local", text: m.text, conf: m.conf, start: m.start });
    else if (m.type === "error") this.emit("message", { type: "error", msg: `本地实时识别出错：${String(m.msg).slice(0, 80)}` });
    else if (m.type === "done") this.onDone?.();
    else if (m.type === "tick" && !this.lagNoted && this.fedSec - m.processed > LAG_WARN_SEC) {
      this.lagNoted = true;
      this.emit("message", { type: "error", msg: "这台电脑的本地识别跟不上说话速度，字幕会越来越晚；建议在「识别方式」里改用「云端（Gemini）」" });
    }
  }

  #exit(code) {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code);
  }

  feed(buf) {
    if (!this.worker || this.exited) return;
    const data = this.carry ? Buffer.concat([this.carry, buf]) : buf;
    const even = data.length - (data.length % 2);
    this.carry = even < data.length ? Buffer.from(data.subarray(even)) : null;
    if (!even) return;
    this.fedSec += even / 2 / 16000;
    this.worker.postMessage({ type: "audio", pcm: new Uint8Array(data.subarray(0, even)) }); // 复制一份交给线程
  }

  /** 不再送音频：让线程把最后半句定稿；线程不回应就超时强制结束 */
  async close(timeoutMs = 10_000) {
    if (!this.worker || this.exited) return;
    let timer;
    await new Promise((resolve) => {
      this.onDone = resolve;
      timer = setTimeout(resolve, timeoutMs);
      this.worker.postMessage({ type: "finish" });
    });
    clearTimeout(timer);
    this.#exit(0);
    await this.worker.terminate();
  }

  kill() {
    if (this.exited) return;
    this.#exit(-1);
    this.worker?.terminate();
  }
}
