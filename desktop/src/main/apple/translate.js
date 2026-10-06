import fs from "node:fs";
import { execFile } from "node:child_process";
import { spawnJsonl } from "./jsonl.js";
import { APPLE_TR_LANGS } from "../langs.js";
import { withTimeout } from "../llm/errors.js";

/** 苹果自带翻译的常驻子程序（所有会话共用），一行一个请求 */
export class AppleTranslator {
  constructor(bin) {
    this.bin = bin;
    this.p = null;
    this.pending = new Map();
    this.nextId = 0;
  }
  #supported(src, tgt) { return src in APPLE_TR_LANGS && tgt in APPLE_TR_LANGS && fs.existsSync(this.bin); }
  #ensure() {
    if (this.p && this.p.proc.exitCode === null && this.p.proc.signalCode === null) return;
    const p = spawnJsonl(this.bin, [], (m) => {
      const resolve = this.pending.get(m.id);
      if (resolve) { this.pending.delete(m.id); resolve(m); }
    });
    p.done.then(() => { // 进程意外退出：没回的请求都按失败处理
      if (this.p !== p) return;
      for (const resolve of this.pending.values()) resolve({ error: "苹果翻译程序退出了", code: "failed" });
      this.pending.clear();
    });
    this.p = p;
  }
  /** 返回 {tr, code}：code 为空表示成功，not_installed 表示还没下载这对语言 */
  async translate(text, src, tgt) {
    if (!this.#supported(src, tgt)) return { tr: "", code: "unsupported" };
    this.#ensure();
    const id = ++this.nextId;
    const reply = new Promise((resolve) => this.pending.set(id, resolve));
    this.p.write(JSON.stringify({ id, text, src: APPLE_TR_LANGS[src], tgt: APPLE_TR_LANGS[tgt] }) + "\n");
    try {
      const m = await withTimeout(reply, 15_000);
      return { tr: m.tr ?? "", code: m.code ?? "" };
    } catch {
      this.pending.delete(id);
      return { tr: "", code: "failed" };
    }
  }
  /** installed / supported（能下载但还没下载）/ unsupported */
  status(src, tgt) {
    if (!this.#supported(src, tgt)) return Promise.resolve("unsupported");
    return new Promise((resolve) => execFile(this.bin, ["check", APPLE_TR_LANGS[src], APPLE_TR_LANGS[tgt]],
      (_err, out) => resolve(String(out ?? "").trim() || "unsupported")));
  }
  stop() { this.p?.kill(); this.p = null; }
}
