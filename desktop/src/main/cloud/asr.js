import { EventEmitter } from "node:events";
import { Segmenter } from "./segmenter.js";
import { toWav } from "./wav.js";
import { friendly } from "../text.js";
import { AllModelsBusy, NoKey } from "../llm/errors.js";
import { SPEAKER_LANGS, TARGET_LANGS } from "../langs.js";

export const QUOTA_PAUSE_MS = 600_000; // 额度用完后 10 分钟内不再请求
export const MAX_BACKLOG = 3;          // 识别跟不上时最多积压几句，再多就跳过最旧的
const NET_WARN_MS = 60_000;            // 网络慢的提示最多一分钟一次

/** 云端识别（旧 Mac、Windows 用）：按音量断句 → 人声检测 → Gemini 一次拿回转写和译文。接口和 AppleASR 一样 */
export class CloudASR extends EventEmitter {
  constructor({ llm, vad, speaker, offset, getTarget, now = Date.now }) {
    super();
    Object.assign(this, { llm, vad, speaker, offset, getTarget, now });
    this.kind = "cloud";
    this.segmenter = new Segmenter();
    this.items = [];            // 等待识别的句子（按时间顺序）
    this.running = null;        // 正在处理队列的循环
    this.dead = false;
    this.pausedUntil = 0;
    this.noted = new Set();     // 已经提示过的事（没填 key、跳过句子、人声检测出错）
    this.lastNetWarn = -Infinity;
  }
  start() {}
  feed(buf) {
    for (const seg of this.segmenter.feed(buf)) this.#enqueue(seg);
  }
  idle() { return this.running ?? Promise.resolve(); }
  /** 不再送音频：最后半句也送去识别，等全部处理完 */
  async close() {
    for (const seg of this.segmenter.flush()) this.#enqueue(seg);
    await this.idle();
    this.emit("exit", 0);
  }
  kill() {
    this.dead = true;
    this.items = [];
    this.emit("exit", -1);
  }
  #note(key, msg) {
    if (this.noted.has(key)) return;
    this.noted.add(key);
    this.emit("message", { type: "error", msg });
  }
  #enqueue(seg) {
    if (this.dead) return;
    this.items.push(seg);
    if (this.items.length > MAX_BACKLOG) { // 网络太慢跟不上：丢掉最旧的，让字幕尽量跟上老师
      this.items.shift();
      this.#note("backlog", "网络太慢，云端识别跟不上，跳过了几句；字幕会尽量跟上老师");
    }
    if (!this.running) {
      this.running = this.#drain().finally(() => { this.running = null; });
    }
  }
  async #drain() {
    while (this.items.length && !this.dead) {
      const seg = this.items.shift();
      try { await this.#process(seg); } catch {}
    }
  }
  async #process(seg) {
    if (this.now() < this.pausedUntil) return;
    let voice = true;
    try {
      voice = await this.vad.hasVoice(seg.audio);
    } catch { // 人声检测用不了：照常识别（可能多用一些额度），只提示一次
      this.#note("vad", "人声检测没能启动，改为直接识别，可能会多用一些 Gemini 额度");
    }
    if (!voice || this.dead) return; // 只有杂音 / 静音：不发请求
    this.emit("message", { type: "status", recognizing: true });
    try {
      const speakerLabel = this.speaker === "auto" ? null : SPEAKER_LANGS[this.speaker];
      const r = await this.llm.recognize(toWav(seg.audio), speakerLabel, TARGET_LANGS[this.getTarget()]);
      this.noted.delete("nokey");
      if (!this.dead) this.emit("message", { type: "final", source: "cloud", text: r.text, lang: r.lang, tr: r.tr, start: seg.start });
    } catch (e) {
      if (e instanceof NoKey) {
        this.#note("nokey", `${e.message}：请点右上角「AI 模型与 API」填写，填好后马上生效`);
      } else if ((e instanceof AllModelsBusy && e.quota) || String(e?.message).includes("PerDay")) {
        this.pausedUntil = this.now() + QUOTA_PAUSE_MS;
        this.emit("message", { type: "error", msg: "Gemini 今天的免费额度用完了，接下来 10 分钟暂停识别，之后自动再试" });
      } else if (this.now() - this.lastNetWarn >= NET_WARN_MS) { // 超时、服务器忙：不暂停，提示别太频繁
        this.lastNetWarn = this.now();
        this.emit("message", { type: "error", msg: `这一句没识别出来（${friendly(e)}），会继续识别后面的句子` });
      }
    } finally {
      this.emit("message", { type: "status", recognizing: false });
    }
  }
}
