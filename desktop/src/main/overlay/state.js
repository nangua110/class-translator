/** 悬浮字幕显示什么。
 *  只显示一句时：上面一行是老师正在说的英文（边说边出字），下面一行是最近一句已经翻好的中文。
 *  翻译比识别慢一两秒，所以两行可能差一句；但中文不会因为老师接着说下一句就被冲掉。
 *  把字幕条拉高时：用 lines 按顺序列出前面几句的英文和各自的中文，最下面是正在说的这句 */
export const HISTORY = 30;
export const EMPTY = Object.freeze({ en: "", zh: "", low: false, live: false, zhId: -1, lines: [] });

export function nextState(s, m) {
  if (m.type === "reset") return EMPTY;
  if (m.type === "partial") return m.text ? { ...s, en: m.text, live: true, low: false } : { ...s, live: false };
  if (m.type === "line") {
    const lines = [...s.lines, { id: m.id, en: m.text, zh: m.same ? "" : m.tr || "", low: !!m.low, same: !!m.same }].slice(-HISTORY);
    const next = { ...s, en: m.text, live: false, low: !!m.low, lines };
    if (m.same) return { ...next, zh: "", zhId: m.id };            // 老师说的就是中文：不用再显示翻译
    if (m.tr) return { ...next, zh: m.tr, zhId: m.id };
    return next;                                                    // 还在翻译：先留着上一句的中文
  }
  if (m.type === "translation" && m.tr) {
    const lines = s.lines.map((l) => (l.id === m.id ? { ...l, zh: m.tr } : l));
    if (m.id >= s.zhId) return { ...s, lines, zh: m.tr, zhId: m.id }; // 几句同时翻译时，旧句子晚到不覆盖新句子
    return { ...s, lines };
  }
  return s;
}
