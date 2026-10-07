import { TARGET_LANGS, TRANSLATORS, SPEAKER_LANGS, SR, SUMMARY_INTERVAL_MS } from "./langs.js";
import { simplify, friendly } from "./text.js";
import { acceptFinal, acceptPartial } from "./apple/filter.js";
import { acceptCloudFinal } from "./cloud/filter.js";
import { AllModelsBusy, NoKey } from "./llm/errors.js";
import { acceptLocalFinal } from "./local/filter.js";

const DEFAULTS = { speaker: "en", target: "zh", asr: "apple", translator: "gemini" };
const MAX_PARALLEL_TRANSLATIONS = 6;

/** 一节课：收音频 → 苹果识别 → 字幕 → 后台翻译 → 定时更新笔记 → 每句存盘 */
export class Session {
  constructor({ send, llm, appleTr, records, caps, makeAsr, sleep, now }) {
    Object.assign(this, { send, llm, appleTr, records, caps, makeAsr });
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = now ?? Date.now;
    this.cfg = { ...DEFAULTS };
    this.name = records.newName();
    this.lines = [];
    this.summary = "";
    this.summarizedUpto = 0;
    this.summarizing = false;
    this.lastSummaryAt = this.now();
    this.translations = new Set();
    this.active = 0;
    this.waiters = [];
    this.samples = 0;         // 已收到的音频样本数，用来算时间
    this.asr = null;
    this.crashes = new Map(); // 每种识别方式出错的次数
    this.failed = new Set();  // 连续出错的「识别方式:说话人语言」，不再重启
    this.paused = false;
    this.fallbackNoted = false;
    this.warned = new Set();
  }

  configure(cfg = {}) {
    const speakerChanged = cfg.speaker && this.asr && cfg.speaker !== this.asr.speaker;
    if (this.asr && (speakerChanged || (cfg.asr && cfg.asr !== this.asr.kind))) {
      const old = this.asr; // 说到一半的那句会先确定下来
      this.asr = null;
      old.close();
    }
    if (cfg.speaker in SPEAKER_LANGS) this.cfg.speaker = cfg.speaker;
    if (cfg.target in TARGET_LANGS) this.cfg.target = cfg.target;
    if (cfg.asr) this.cfg.asr = cfg.asr;
    if (cfg.translator in TRANSLATORS && cfg.translator !== this.cfg.translator) {
      this.cfg.translator = cfg.translator;
      this.fallbackNoted = false;
    }
  }

  warnOnce(key, msg) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.send({ type: "error", msg });
  }

  /** 这节课用哪种识别：苹果（新 Mac）、本地实时（英语）或云端（Gemini）；都用不了返回 null */
  asrKind() {
    if (this.cfg.asr === "apple" && this.caps.appleAsr) return "apple";
    if (this.cfg.asr === "local" && this.caps.localAsr) return "local";
    if (this.cfg.asr === "cloud" && this.caps.cloudAsr) return "cloud";
    return null;
  }

  audio(buf) {
    if (this.paused) return;
    const kind = this.asrKind();
    if (!kind) {
      return this.warnOnce("no-asr", "这台电脑用不了苹果自带识别（需要 macOS 26 或更新），请在「识别方式」里选「本地实时」或「云端（Gemini）」。");
    }
    if (kind === "local" && this.cfg.speaker !== "en") {
      return this.warnOnce("local-lang", "本地实时识别目前只支持英语，请把「识别方式」改成「云端（Gemini）」。");
    }
    if (this.failed.has(`${kind}:${this.cfg.speaker}`)) {
      return this.warnOnce(`crash-${kind}`, "识别程序连续出错，已停止识别。请结束录制后重新开始，或者在「识别方式」里换一种。");
    }
    if (!this.asr) this.startAsr(kind);
    this.asr.feed(buf);
    this.samples += buf.length / 2;
  }

  startAsr(kind) {
    const asr = this.makeAsr(kind, this.cfg.speaker, this.samples / SR);
    asr.on("message", (m) => this.onAsr(asr, m));
    asr.on("exit", (code) => {
      if (this.asr === asr) this.asr = null;
      if (code !== 0 && code !== -1) {      // -1 是我们自己关掉的
        this.crashes.set(asr.kind, (this.crashes.get(asr.kind) ?? 0) + 1);
        // 下一段音频时自动重启一次，再出错就停
        if (this.crashes.get(asr.kind) >= 2) this.failed.add(`${asr.kind}:${asr.speaker}`);
      }
    });
    asr.start();
    this.asr = asr;
  }

  onAsr(asr, m) {
    if (m.type === "partial") {
      if (acceptPartial(m.text ?? "", asr.speaker)) this.send({ type: "partial", text: m.text });
    } else if (m.type === "final" && m.source === "local") {
      const r = acceptLocalFinal(m, asr.speaker);
      if (r) this.addLine(r.text, r.lang, "", asr.offset + r.start);
    } else if (m.type === "final" && m.source === "cloud") {
      const r = acceptCloudFinal(m, asr.speaker);
      if (r) this.addLine(r.text, r.lang, "", asr.offset + r.start); // 翻译统一走 translateLine：带上文、按所选方式
    } else if (m.type === "final") {
      this.send({ type: "partial", text: "" });
      const r = acceptFinal(m, asr.speaker);
      if (r) this.addLine(r.text, r.lang, "", asr.offset + r.start);
    } else if (m.type === "status") {
      this.send({ type: "status", recognizing: !!m.recognizing });
    } else if (m.type === "downloading") {
      this.send({ type: "error", msg: "第一次用这种语言，正在下载苹果语音模型，稍等片刻…" });
    } else if (m.type === "error") {
      this.send({ type: "error", msg: asr.kind === "apple" ? `苹果识别出错：${String(m.msg ?? "").slice(0, 60)}` : m.msg });
    }
  }

  /** 新增一句字幕：去重、推给窗口、需要的话后台翻译 */
  addLine(text, lang, tr, t) {
    const target = this.cfg.target;
    const context = this.lines.slice(-3).map((l) => l.text);
    const last = this.lines.at(-1);
    if (last && last.text === text && t - last.t < 10) return null; // 几秒内一字不差的重复，多半是杂音胡编
    const line = { id: this.lines.length, t, text, tr: "", lang, same: lang === target };
    this.lines.push(line);
    if (!line.same) line.tr = simplify(tr, target);
    this.send({ type: "line", ...line });
    if (!(line.same || line.tr)) {
      const p = this.translateLine(line, context, target);
      this.translations.add(p);
      p.finally(() => this.translations.delete(p));
    }
    this.save();
    if (this.now() - this.lastSummaryAt >= SUMMARY_INTERVAL_MS) this.updateSummary();
    return line;
  }

  async withSlot(fn) {
    while (this.active >= MAX_PARALLEL_TRANSLATIONS) await new Promise((r) => this.waiters.push(r));
    this.active += 1;
    try { return await fn(); } finally { this.active -= 1; this.waiters.shift()?.(); }
  }

  async translateLine(line, context, target) {
    const tr = await this.withSlot(() => this.translateText(line.text, line.lang, context, target));
    line.tr = simplify(tr, target);
    this.send({ type: "translation", id: line.id, tr: line.tr });
    this.save();
  }

  /** 按选的翻译方式翻；Gemini / Claude 用不了时改用苹果翻译顶上 */
  async translateText(text, src, context, target) {
    let err = null;
    if (this.cfg.translator !== "apple") {
      for (const wait of [0, 3000, 8000]) { // 失败了等一会儿再试，最多 3 次
        if (wait) await this.sleep(wait);
        try {
          return await this.llm.translate(text, context, TARGET_LANGS[target], this.cfg.translator);
        } catch (e) {
          err = e;
          if (e instanceof AllModelsBusy || e instanceof NoKey || String(e?.message).includes("PerDay")) break;
        }
      }
    }
    const { tr, code } = await this.appleTr.translate(text, src, target);
    if (tr) {
      if (err && !this.fallbackNoted) {
        this.fallbackNoted = true;
        const who = this.cfg.translator === "claude" ? "Claude" : "Gemini";
        this.send({ type: "error", msg: `${who} 用不了（${friendly(err)}），先改用苹果翻译顶上（直译，不会纠正识别错字）` });
      }
      return tr;
    }
    if (err) return `（翻译失败：${friendly(err)}）`;
    if (code === "not_installed") { // 苹果翻译还没下载这对语言：有 key 就先用 AI 翻
      for (const p of this.llm.available()) {
        try { return await this.llm.translate(text, context, TARGET_LANGS[target], p); } catch {}
      }
      return "（苹果翻译还没下载这对语言，请在「AI 模型与 API」里点「打开系统设置下载语言」）";
    }
    return "（翻译失败：苹果翻译不支持这对语言）";
  }

  summaryProvider() {
    const avail = this.llm.available();
    if (avail.includes(this.cfg.translator)) return this.cfg.translator;
    if (avail.length) return avail[0];
    throw new NoKey("要生成课堂笔记，需要先在「AI 模型与 API」里填写 Gemini 或 Claude 的 key");
  }

  async updateSummary(final = false) {
    if (this.summarizing || !this.lines.length) return;
    this.summarizing = true;
    this.lastSummaryAt = this.now();
    this.send({ type: "summary_status", busy: true });
    try {
      const label = TARGET_LANGS[this.cfg.target];
      if (final) {
        this.summary = await this.llm.summarize(this.lines.map((l) => l.text).join("\n"), "", label, this.summaryProvider());
        this.summarizedUpto = this.lines.length;
      } else {
        const fresh = this.lines.slice(this.summarizedUpto);
        if (fresh.length) {
          const upto = this.lines.length;
          this.summary = await this.llm.summarize(fresh.map((l) => l.text).join("\n"), this.summary, label, this.summaryProvider());
          this.summarizedUpto = upto;
        }
      }
      this.summary = simplify(this.summary, this.cfg.target);
      this.send({ type: "summary", md: this.summary });
      this.save();
    } catch (e) {
      this.send({ type: "error", msg: `课堂笔记更新失败：${friendly(e)}` });
    } finally {
      this.summarizing = false;
      this.send({ type: "summary_status", busy: false });
    }
  }

  async idle() { while (this.translations.size) await Promise.allSettled([...this.translations]); }

  /** 结束录制：最后一句确定下来 → 等翻译 → 最终笔记 → 通知窗口 */
  async stop() {
    if (this.asr) { const a = this.asr; this.asr = null; await a.close(); }
    await this.idle();
    await this.updateSummary(true);
    this.save();
    this.send({ type: "done", record: this.name });
  }

  /** 关窗口 / 退出：立刻杀掉子程序并存盘 */
  dispose() {
    if (this.asr) { this.asr.kill(); this.asr = null; }
    this.save();
  }

  save() {
    if (!this.lines.length) return;
    try {
      this.records.save(this.name, this.summary, this.lines);
    } catch (e) { // 比如没允许访问「文稿」或磁盘满：字幕照常出，只提示一次；之后能写了会整份重存
      this.warnOnce("save", `课堂记录保存不了（${e.code ?? e.message}）。请到 系统设置 → 隐私与安全 → 文件与文件夹 里允许「课堂同传」访问「文稿」文件夹`);
    }
  }
}
