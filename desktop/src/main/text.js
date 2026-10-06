import * as OpenCC from "opencc-js";
import { NoKey, AllModelsBusy, TimeoutError } from "./llm/errors.js";

const t2s = OpenCC.Converter({ from: "t", to: "cn" });
const KANA = /[぀-ヿ]/;
const HANGUL = /[가-힯]/;
const count = (re, s) => (s.match(re) || []).length;
// 识别在静音 / 噪音上常见的胡编
const HALLUCINATIONS = new Set(["thank you.", "thanks for watching!", "thank you for watching.", "you", "bye.",
  "thank you very much.", "please subscribe.", ".", "so", "okay."]);
const REPEAT_RE = /(\S+?)(?:[\s,，、。.]+\1){3,}/giu;

export const toSimplified = (s) => t2s(s);
export const hasCJK = (s) => /[一-鿿]/.test(s);

/** 输出中文时统一转简体：苹果翻译偶尔混进繁体（如"一張吞食動物"），AI 偶尔也会 */
export function simplify(text, target) {
  return target === "zh" && text ? t2s(text) : text;
}

/** 把"喝酒 喝酒 喝酒 ……"这类卡住复读合并成一个 */
export const collapseRepeats = (s) => s.replace(REPEAT_RE, "$1");

/** 识别结果统一清理：去复读、去幻觉、中文转简体 + 全角标点 + 去标点前空格 */
export function clean(text, lang) {
  let t = collapseRepeats(text.trim());
  if (HALLUCINATIONS.has(t.toLowerCase())) return "";
  if (lang === "zh") {
    t = t2s(t).replaceAll(",", "，").replaceAll("?", "？").replaceAll("!", "！");
    t = t.replace(/\s+([，。？！、；：])/g, "$1");
  }
  return t;
}

/** 苹果识别按所选语言硬识别，旁边别的语言会变成乱码：按文字特征挑出来 */
export function appleLangOk(text, speaker) {
  const cjk = count(/[一-鿿]/g, text), latin = count(/[A-Za-z]/g, text);
  if (speaker === "zh") return cjk > 0 && cjk >= latin && !KANA.test(text);
  if (speaker === "ja") return KANA.test(text) || cjk > 0;
  if (speaker === "ko") return HANGUL.test(text);
  return cjk === 0 && !KANA.test(text); // 英、法、德、西、自动（按英语）
}

export function fmtTs(seconds) {
  const s = Math.floor(seconds);
  return [s / 3600, (s % 3600) / 60, s % 60].map((n) => String(Math.floor(n)).padStart(2, "0")).join(":");
}

/** 把 API 报错翻成看得懂的中文 */
export function friendly(err) {
  const msg = String(err?.message ?? err);
  if (err instanceof NoKey) return msg;
  if (err instanceof AllModelsBusy || msg.includes("PerDay")) return "Gemini 今天的免费额度用完了";
  if (err instanceof TimeoutError) return "响应超时";
  if (msg.includes("429")) return "请求太频繁，被限流了";
  if (/503|UNAVAILABLE|overloaded/i.test(msg)) return "服务器繁忙";
  if (/API key|401|403|invalid x-api-key|authentication/i.test(msg)) return "API key 无效";
  return msg.slice(0, 80);
}
