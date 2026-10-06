import { appleLangOk, clean } from "../text.js";

// 说的不是所选语言时，苹果识别会出拼音一样的乱码，把握通常只有 0.2~0.45
export const APPLE_MIN_CONF = 0.5;

/** 草稿没有把握值，只能按文字特征挡掉一部分（比如中文模式下的英文） */
export const acceptPartial = (text, speaker) => appleLangOk(text, speaker);

/** 确定下来的一句：清理 + 语言特征 + 把握值，不合格返回 null */
export function acceptFinal(m, speaker) {
  const text = clean(m.text ?? "", speaker === "zh" ? "zh" : "en");
  if (!text || !appleLangOk(text, speaker)) return null;
  const conf = m.conf ?? -1;
  if (conf >= 0 && conf < APPLE_MIN_CONF) return null;
  return { text, lang: speaker === "auto" ? "en" : speaker, start: m.start ?? 0 };
}
