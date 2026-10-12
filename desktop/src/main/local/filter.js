import { appleLangOk, clean } from "../text.js";

// 把握低于这个值的句子标成「可能听错」，用浅色显示，但不丢掉（原因同苹果识别的过滤）。
// 本地模型只会英语：旁边有人说中文、日语时会硬听成不通的英文，这时平均把握只有 0.3~0.4（英语 0.66~0.79）
export const LOCAL_MIN_CONF = 0.5;

/** 本地实时识别定稿的一句：清理、只出英语；把握低的带上 low: true */
export function acceptLocalFinal(m, speaker) {
  if (speaker !== "en") return null;
  const text = clean(m.text ?? "", "en");
  if (!text || !appleLangOk(text, "en")) return null;
  const conf = m.conf ?? -1;
  const r = { text, lang: "en", start: m.start ?? 0 };
  if (conf >= 0 && conf < LOCAL_MIN_CONF) r.low = true;
  return r;
}
