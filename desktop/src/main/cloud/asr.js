import { EventEmitter } from "node:events";
import { Segmenter } from "./segmenter.js";
import { toWav } from "./wav.js";
import { friendly } from "../text.js";
import { AllModelsBusy, NoKey } from "../llm/errors.js";
import { SPEAKER_LANGS, TARGET_LANGS } from "../langs.js";

export const QUOTA_PAUSE_MS = 600_000; // 额度用完后 10 分钟内不再请求

/** 云端识别（旧 Mac、Windows 用）：按音量断句 → 人声检测 → Gemini 一次拿回转写和译文。接口和 AppleASR 一样 */
export class CloudASR extends EventEmitter {
  constructor({ llm, vad, speaker, offset, getTarget, now = Date.now }) {
    super();
    Object.assign(this, { llm, vad, speaker, offset, getTarget, now });
    this.kind = "cloud";
    this.segmenter = new Segmenter();
    this.queue = Promise.resolve();
    this.dead = false;
    this.pausedUntil = 0;
    this.noKeyNoted = false;
  }
  start() {}
  feed(buf) {
    for (const seg of this.segmenter.feed(buf)) this.#enqueue(seg);
  }
  idle() { return this.queue; }
  /** 不再送音频：最后半句也送去识别，等全部处理完 */
  async close() {
    for (const seg of this.segmenter.flush()) this.#enqueue(seg);
    await this.queue;
    this.emit("exit", 0);
  }
  kill() {
    this.dead = true;
    this.emit("exit", -1);
  }
  #enqueue(seg) {
    this.queue = this.queue.then(() => this.#process(seg)).catch(() => {});
  }
  async #process(seg) {
    if (this.dead || this.now() < this.pausedUntil) return;
    if (!(await this.vad.hasVoice(seg.audio))) return; // 只有杂音 / 静音：不发请求
    if (this.dead) return;
    this.emit("message", { type: "status", recognizing: true });
    try {
      const speakerLabel = this.speaker === "auto" ? null : SPEAKER_LANGS[this.speaker];
      const r = await this.llm.recognize(toWav(seg.audio), speakerLabel, TARGET_LANGS[this.getTarget()]);
      this.noKeyNoted = false;
      if (!this.dead) this.emit("message", { type: "final", source: "cloud", text: r.text, lang: r.lang, tr: r.tr, start: seg.start });
    } catch (e) {
      if (e instanceof NoKey) {
        if (!this.noKeyNoted) {
          this.noKeyNoted = true;
          this.emit("message", { type: "error", msg: `${e.message}：请点右上角「AI 模型与 API」填写，填好后马上生效` });
        }
      } else if (e instanceof AllModelsBusy || String(e?.message).includes("PerDay")) {
        this.pausedUntil = this.now() + QUOTA_PAUSE_MS;
        this.emit("message", { type: "error", msg: "Gemini 今天的免费额度用完了，接下来 10 分钟暂停识别，之后自动再试" });
      } else {
        this.emit("message", { type: "error", msg: `这一句云端识别失败：${friendly(e)}` });
      }
    } finally {
      this.emit("message", { type: "status", recognizing: false });
    }
  }
}
