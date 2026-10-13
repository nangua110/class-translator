import fs from "node:fs";
import path from "node:path";
import { fmtTs } from "../text.js";

const NAME_RE = /^[\w-]+\.md$/;
const LINE_RE = /^\*\*\[(\d\d:\d\d:\d\d)\]\*\* (.+)$/;
const REPORT_SUFFIX = "_课后精讲.md";

export const isValidName = (name) => typeof name === "string" && NAME_RE.test(name);

export function newRecordName(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.md`;
}

/** 与网页版 records/*.md 格式一致 */
export function recordMarkdown(stem, summary, lines) {
  const parts = [`# 课堂记录 ${stem}\n`, "## AI 总结\n", summary || "（暂无）", "\n## 转写\n"];
  for (const l of lines) parts.push(`**[${fmtTs(l.t)}]** ${l.text}\n` + (l.tr ? `\n> ${l.tr}\n` : ""));
  return parts.join("\n");
}

export function parseTranscript(md) {
  return md.split("\n").map((l) => l.match(LINE_RE)).filter(Boolean).map((m) => [m[1], m[2]]);
}

/** 读回整节课：课堂笔记（「## AI 总结」那一段）和每句的原文、翻译 */
export function parseRecord(md) {
  const m = md.match(/## AI 总结\n\n([\s\S]*?)\n\n## 转写\n/);
  const summary = m && m[1].trim() !== "（暂无）" ? m[1].trim() : "";
  const lines = [];
  for (const row of md.split("\n")) {
    const l = row.match(LINE_RE);
    if (l) {
      const [h, mi, s] = l[1].split(":").map(Number);
      lines.push({ t: h * 3600 + mi * 60 + s, text: l[2], tr: "" });
    } else if (row.startsWith("> ") && lines.length) lines.at(-1).tr = row.slice(2);
  }
  return { summary, lines };
}

export function reportMarkdown(outline, body, stem, lastTs) {
  const [h, m, s] = lastTs.split(":").map(Number);
  const mt = stem.match(/^(\d{4}-\d\d-\d\d)_(\d\d)-(\d\d)/);
  const started = mt ? `${mt[1]} ${mt[2]}:${mt[3]}` : stem;
  const parts = [`# ${outline.title || "课后精讲"}`, "", `> 上课 ${started} · 时长 ${h}h ${m}m ${s}s`, "",
    outline.overview ?? "", "", "## 章节大纲", ""];
  for (const c of outline.chapters ?? []) {
    parts.push(`- **[${c.start ?? ""} – ${c.end ?? ""}] ${c.title ?? ""}**  `, `  ${c.desc ?? ""}`);
  }
  return parts.join("\n") + "\n\n" + body.trim() + "\n";
}

export class Records {
  constructor(dir) { this.dir = dir; }
  newName() { return newRecordName(); }
  ensureDir() { fs.mkdirSync(this.dir, { recursive: true }); }
  #file(name) {
    if (!isValidName(name)) throw new Error("记录名不合法");
    return path.join(this.dir, name);
  }
  #reportFile(name) { return path.join(this.dir, name.replace(/\.md$/, REPORT_SUFFIX)); }
  /** 这节课的原声录音文件（开了「保存录音」才有） */
  audioFile(name) { return this.#file(name).replace(/\.md$/, ".wav"); }
  hasAudio(name) { return isValidName(name) && fs.existsSync(path.join(this.dir, name.replace(/\.md$/, ".wav"))); }
  exists(name) { return isValidName(name) && fs.existsSync(path.join(this.dir, name)); }
  save(name, summary, lines) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.#file(name), recordMarkdown(name.replace(/\.md$/, ""), summary, lines), "utf8");
  }
  /** 以前的一节课：课堂笔记和转写；没有这节课返回 null */
  read(name) {
    if (!this.exists(name)) return null;
    return parseRecord(fs.readFileSync(this.#file(name), "utf8"));
  }
  transcript(name) {
    const f = this.#file(name);
    return fs.existsSync(f) ? parseTranscript(fs.readFileSync(f, "utf8")) : [];
  }
  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter(isValidName).sort().reverse().flatMap((name) => {
      const lines = this.transcript(name);
      if (!lines.length) return [];
      const [h, m] = lines.at(-1)[0].split(":").map(Number);
      const report = this.readReport(name);
      return [{ name, stem: name.replace(/\.md$/, ""), lines: lines.length, minutes: h * 60 + m,
        hasReport: !!report, title: report?.title ?? "", hasAudio: this.hasAudio(name) }];
    });
  }
  readReport(name) {
    if (!isValidName(name)) return null;
    const f = this.#reportFile(name);
    if (!fs.existsSync(f)) return null;
    const md = fs.readFileSync(f, "utf8");
    return { md, title: md.split("\n", 1)[0].replace(/^#\s*/, "").trim() };
  }
  writeReport(name, md) {
    this.#file(name); // 校验名字
    const f = this.#reportFile(name);
    fs.writeFileSync(f, md, "utf8");
    return path.basename(f);
  }
}
