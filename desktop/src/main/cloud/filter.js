import { clean, hasCJK } from "../text.js";

/** 云端识别结果：清理、只留所选说话人语言；自动模式只认中英文 */
export function acceptCloudFinal(m, speaker) {
  let lang = m.lang;
  if (speaker === "auto" && !["en", "zh"].includes(lang)) lang = hasCJK(m.text ?? "") ? "zh" : "en";
  const text = clean(m.text ?? "", lang);
  if (!text) return null;
  if (speaker !== "auto" && lang !== speaker) return null;
  return { text, lang, tr: m.tr ?? "", start: m.start ?? 0 };
}
