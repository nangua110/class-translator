import { EventEmitter } from "node:events";
import { spawnJsonl } from "./jsonl.js";
import { APPLE_LOCALES } from "../langs.js";

/** 苹果自带语音识别：持续喂 16kHz int16 音频，边说边吐出草稿（partial）和确定句（final） */
export class AppleASR extends EventEmitter {
  constructor(bin, speaker, offset) {
    super();
    this.bin = bin;
    this.speaker = speaker;
    this.offset = offset; // 这个识别进程开始时，这节课已经录了多少秒
    this.p = null;
  }
  start() {
    this.byUs = false; // 是我们自己 close / kill 的；被系统信号意外结束（真崩溃）不算
    this.p = spawnJsonl(this.bin, [APPLE_LOCALES[this.speaker] ?? "en-US"], (m) => this.emit("message", m));
    this.p.done.then((code) => this.emit("exit", this.byUs ? -1 : (code === -1 ? 128 : code)));
  }
  feed(buf) { this.p?.write(buf); }
  /** 不再送音频，等最后一句确定下来；超时就强制结束 */
  async close(timeoutMs = 10_000) {
    if (!this.p) return;
    this.byUs = true;
    this.p.end();
    const timer = setTimeout(() => this.p.kill(), timeoutMs);
    await this.p.done;
    clearTimeout(timer);
  }
  kill() { this.byUs = true; this.p?.kill(); }
}
