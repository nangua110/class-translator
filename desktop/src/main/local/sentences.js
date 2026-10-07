// 把流式识别器「只增不改」的结果切成句子：句末标点后面出现了下一句的词，上一句就定稿；其余是草稿。
// 不依赖任何其他模块：后台线程（worker.cjs）会直接加载它。
const SENTENCE_END = /[.?!]$/;
const HAS_WORD = /[A-Za-z0-9\u00c0-\u024f]/;

export class SentenceSplitter {
  constructor() { this.done = 0; } // 这一段里已经定稿到第几个词片

  /** result：识别器当前这一段的结果；flush 为真表示这一段结束（停顿够久 / 结束录制），剩下的也定稿 */
  update(result, { flush = false } = {}) {
    const tokens = result.tokens ?? [];
    const finals = [];
    let begin = this.done;
    for (let i = this.done; i < tokens.length; i++) {
      const next = tokens[i + 1];
      // 下一个词片以空格开头才算新的一句（"3.14" 里的 "14" 前面没有空格）
      if (SENTENCE_END.test(tokens[i].trim()) && next !== undefined && next.startsWith(" ")) {
        finals.push(this.#make(result, begin, i + 1));
        begin = i + 1;
      }
    }
    if (flush && begin < tokens.length) {
      finals.push(this.#make(result, begin, tokens.length));
      begin = tokens.length;
    }
    this.done = begin;
    return { finals: finals.filter(Boolean), partial: tokens.slice(begin).join("").trim() };
  }

  reset() { this.done = 0; }

  #make(result, a, b) {
    const text = result.tokens.slice(a, b).join("").trim();
    if (!HAS_WORD.test(text)) return null; // 只有标点的空段（识别器重置后偶尔会多出一个 "."）
    const probs = (result.ys_probs ?? []).slice(a, b);
    const conf = probs.length ? Math.exp(probs.reduce((x, y) => x + y, 0) / probs.length) : -1;
    return { text, conf, start: (result.start_time ?? 0) + ((result.timestamps ?? [])[a] ?? 0) };
  }
}
