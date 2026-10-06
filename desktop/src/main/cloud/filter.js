import { clean, hasCJK } from "../text.js";

const KANA_OR_HANGUL = /[\u3040-\u30ff\uac00-\ud7af]/;

/** 云端识别结果：清理、只留所选说话人语言；自动模式只认中英文 */
export function acceptCloudFinal(m, speaker) {
  let lang = m.lang;
  if (speaker === "auto" && !["en", "zh"].includes(lang)) {
    // 自动模式只要中英文：模型明确说是日语、韩语等就丢掉；说不清（other）的按文字判断
    if (lang !== "other" && lang) return null;
    if (KANA_OR_HANGUL.test(m.text ?? "")) return null;
    lang = hasCJK(m.text ?? "") ? "zh" : "en";
  }
  const text = clean(m.text ?? "", lang);
  if (!text) return null;
  if (speaker !== "auto" && lang !== speaker) return null;
  return { text, lang, start: m.start ?? 0 };
}
