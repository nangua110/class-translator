import { test } from "node:test";
import assert from "node:assert/strict";
import { SentenceSplitter } from "../src/main/local/sentences.js";
import { acceptLocalFinal } from "../src/main/local/filter.js";

// 把一句话拆成识别器那样的词片：单词前带空格，标点单独一片
function result(text, { start_time = 0, prob = -0.2, step = 0.3 } = {}) {
  const tokens = text.match(/ ?[A-Za-z0-9']+|[.,?!]/g) ?? [];
  return { tokens, timestamps: tokens.map((_, i) => +(i * step).toFixed(2)), ys_probs: tokens.map(() => prob), start_time };
}
const grow = (s, text, opts) => s.update(result(text, opts));

test("句号后面出现下一句的词，上一句才定稿；其余是草稿", () => {
  const s = new SentenceSplitter();
  assert.deepEqual(grow(s, " Good morning"), { finals: [], partial: "Good morning" });
  assert.deepEqual(grow(s, " Good morning."), { finals: [], partial: "Good morning." });
  const r = grow(s, " Good morning. Today we");
  assert.deepEqual(r.finals.map((f) => f.text), ["Good morning."]);
  assert.equal(r.partial, "Today we");
});

test("同一句不会定稿两次；开始时间和把握值正确", () => {
  const s = new SentenceSplitter();
  grow(s, " One. Two", { start_time: 10 });
  const r = grow(s, " One. Two. Three", { start_time: 10 });
  assert.deepEqual(r.finals.map((f) => f.text), ["Two."]);
  assert.equal(r.finals[0].start, 10 + 0.6); // 第 3 个词片（" Two"）的时间
  assert.ok(Math.abs(r.finals[0].conf - Math.exp(-0.2)) < 1e-9);
});

test("问号、叹号也分句；小数点不分句", () => {
  const s = new SentenceSplitter();
  const r = grow(s, " Is it 3.14? Yes! Next");
  assert.deepEqual(r.finals.map((f) => f.text), ["Is it 3.14?", "Yes!"]);
});

test("没有标点一直讲：平时不定稿，flush（端点 / 结束）时整段定稿；只有标点的空段丢掉", () => {
  const s = new SentenceSplitter();
  assert.equal(grow(s, " so we keep going and going").finals.length, 0);
  const r = s.update(result(" so we keep going and going"), { flush: true });
  assert.deepEqual(r.finals.map((f) => f.text), ["so we keep going and going"]);
  assert.equal(r.partial, "");
  s.reset();
  assert.deepEqual(s.update(result("."), { flush: true }), { finals: [], partial: "" });
});

test("reset 后从新的一段重新开始", () => {
  const s = new SentenceSplitter();
  s.update(result(" First one. Second"), { flush: true });
  s.reset();
  const r = grow(s, " New segment. Next", { start_time: 30 });
  assert.deepEqual(r.finals.map((f) => [f.text, f.start]), [["New segment.", 30]]);
});

test("acceptLocalFinal：把握低（别的语言）丢掉；英语保留并清理", () => {
  assert.equal(acceptLocalFinal({ text: "Tong Yeminghau, Zing yang womanianli.", conf: 0.3, start: 1 }, "en"), null);
  assert.deepEqual(acceptLocalFinal({ text: " The second law. ", conf: 0.72, start: 4.5 }, "en"), { text: "The second law.", lang: "en", start: 4.5 });
  assert.equal(acceptLocalFinal({ text: "Thank you.", conf: 0.9, start: 0 }, "en"), null, "常见胡编句丢掉");
  assert.equal(acceptLocalFinal({ text: "Open the book.", conf: -1, start: 0 }, "en").text, "Open the book.", "没有把握值时不按把握过滤");
  assert.equal(acceptLocalFinal({ text: "Hello there.", conf: 0.9, start: 0 }, "zh"), null, "本地实时只出英语");
});
