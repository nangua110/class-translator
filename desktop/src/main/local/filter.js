import { appleLangOk, clean } from "../text.js";

// 本地模型只会英语：旁边有人说中文、日语时会硬听成不通的英文，这时平均把握只有 0.3~0.4（英语 0.66~0.79）
export const LOCAL_MIN_CONF = 0.5;

/** 本地实时识别定稿的一句：清理、只出英语、把握太低的丢掉 */
export function acceptLocalFinal(m, speaker) {
  if (speaker !== "en") return null;
  const text = clean(m.text ?? "", "en");
  if (!text || !appleLangOk(text, "en")) return null;
  const conf = m.conf ?? -1;
  if (conf >= 0 && conf < LOCAL_MIN_CONF) return null;
  return { text, lang: "en", start: m.start ?? 0 };
}
