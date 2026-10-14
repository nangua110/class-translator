/** 悬浮字幕显示什么：上面一行是老师正在说的英文（边说边出字），下面一行是最近一句已经翻好的中文。
 *  翻译比识别慢一两秒，所以两行可能差一句；但中文不会因为老师接着说下一句就被冲掉 */
export const EMPTY = Object.freeze({ en: "", zh: "", low: false, live: false, zhId: -1 });

export function nextState(s, m) {
  if (m.type === "reset") return EMPTY;
  if (m.type === "partial") return m.text ? { ...s, en: m.text, live: true, low: false } : s;
  if (m.type === "line") {
    const next = { ...s, en: m.text, live: false, low: !!m.low };
    if (m.same) return { ...next, zh: "", zhId: m.id };            // 老师说的就是中文：不用再显示翻译
    if (m.tr) return { ...next, zh: m.tr, zhId: m.id };
    return next;                                                    // 还在翻译：先留着上一句的中文
  }
  if (m.type === "translation" && m.tr && m.id >= s.zhId) return { ...s, zh: m.tr, zhId: m.id }; // 几句同时翻译时，旧句子晚到不覆盖新句子
  return s;
}
