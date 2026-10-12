import { appleLangOk, clean } from "../text.js";

// 把握低于这个值的句子标成「可能听错」，界面上用浅色显示，但不丢掉：
// 老师走动、转身、小声说话时把握也只有 0.2~0.45，以前整句丢掉，一节课会有好几分钟没有字幕。
// （说的不是所选语言时出的拼音乱码把握也在这个范围，分不开，所以一起留着由人判断）
export const APPLE_MIN_CONF = 0.5;

/** 草稿没有把握值，只能按文字特征挡掉一部分（比如中文模式下的英文） */
export const acceptPartial = (text, speaker) => appleLangOk(text, speaker);

/** 确定下来的一句：清理 + 语言特征，不合格返回 null；把握低的带上 low: true */
export function acceptFinal(m, speaker) {
  const text = clean(m.text ?? "", speaker === "zh" ? "zh" : "en");
  if (!text || !appleLangOk(text, speaker)) return null;
  const conf = m.conf ?? -1;
  const r = { text, lang: speaker === "auto" ? "en" : speaker, start: m.start ?? 0 };
  if (conf >= 0 && conf < APPLE_MIN_CONF) r.low = true;
  return r;
}
