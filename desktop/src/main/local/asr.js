import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";

export const LAG_WARN_SEC = 15; // 识别落后说话这么多秒、而且还在越落越远，就提醒一次
const LAG_CHECK_SEC = 5;          // 每处理这么多秒音频比较一次落后程度

/** 本地实时识别（英语）：模型在后台线程里跑，边说边出草稿，按句定稿。接口和 AppleASR / CloudASR 一样 */
export class LocalASR extends EventEmitter {
  constructor({ workerPath, modelDir, speaker, offset, makeWorker, loadNoticeMs = 3000 }) {
    super();
    Object.assign(this, { workerPath, modelDir, speaker, offset, loadNoticeMs });
    this.kind = "local";
    this.makeWorker = makeWorker ?? ((file, workerData) => new Worker(file, { workerData }));
    this.worker = null;
    this.carry = null;      // 上一块末尾多出来的半个样本
    this.fedSec = 0;
    this.exited = false;
    this.lagNoted = false;
    this.lagMark = null;    // 上一次比较时处理到哪、落后多少
    this.ready = false;     // 模型加载好了没有（慢电脑上要十几秒）
    this.loadTimer = null;
    this.onDone = null;
    this.touch = null;      // close() 等待期间，线程每来一条消息就重新计时
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
    this.loadTimer = setTimeout(() => {
      if (!this.ready && !this.exited) this.emit("message", { type: "error", msg: "正在加载本地识别模型，稍等几秒；这段时间说的话不会丢，加载好后会补上" });
    }, this.loadNoticeMs);
    this.loadTimer.unref?.();
  }

  #onWorker(m) {
    if (m.type === "ready") { this.ready = true; clearTimeout(this.loadTimer); }
    this.touch?.();
    if (m.type === "partial") this.emit("message", { type: "partial", text: m.text });
    else if (m.type === "final") this.emit("message", { type: "final", source: "local", text: m.text, conf: m.conf, start: m.start });
    else if (m.type === "error") this.emit("message", { type: "error", msg: `本地实时识别出错：${String(m.msg).slice(0, 80)}` });
    else if (m.type === "done") this.onDone?.();
    else if (m.type === "tick" && !this.lagNoted) this.#checkLag(m.processed);
  }

  /** 刚加载完模型时会有一段积压，正在追上就不算；落后很多而且越落越远才提醒 */
  #checkLag(processed) {
    const lag = this.fedSec - processed;
    if (!this.lagMark) { this.lagMark = { processed, lag }; return; }
    if (processed - this.lagMark.processed < LAG_CHECK_SEC) return;
    if (lag > LAG_WARN_SEC && lag > this.lagMark.lag) {
      this.lagNoted = true;
      this.emit("message", { type: "error", msg: "这台电脑的本地识别跟不上说话速度，字幕会越来越晚；建议在「识别方式」里改用「云端（Gemini）」" });
    }
    this.lagMark = { processed, lag };
  }

  #exit(code) {
    if (this.exited) return;
    this.exited = true;
    clearTimeout(this.loadTimer);
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

  /** 不再送音频：让线程把积压的音频识别完、最后半句定稿。线程 timeoutMs 没动静就强制结束；模型还没加载好时多等一会儿（loadTimeoutMs） */
  async close(timeoutMs = 10_000, loadTimeoutMs = 60_000) {
    if (!this.worker || this.exited) return;
    let timer;
    await new Promise((resolve) => {
      this.onDone = resolve;
      this.touch = () => { clearTimeout(timer); timer = setTimeout(resolve, this.ready ? timeoutMs : loadTimeoutMs); };
      this.touch();
      this.worker.postMessage({ type: "finish" });
    });
    clearTimeout(timer);
    this.touch = null;
    this.#exit(0);
    await this.worker.terminate();
  }

  kill() {
    if (this.exited) return;
    this.#exit(-1);
    this.worker?.terminate();
  }
}
