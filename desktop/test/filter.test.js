import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptFinal, acceptPartial } from "../src/main/apple/filter.js";

test("说的不是所选语言（把握低的拼音乱码）丢掉", () => {
  assert.equal(acceptFinal({ text: "Hong Shiemen Hao, Xin Tian woman", conf: 0.24, start: 1 }, "en"), null);
});
test("所选语言正常保留，带上开始时间", () => {
  assert.deepEqual(acceptFinal({ text: "Today we talk.", conf: 0.95, start: 1.5 }, "en"),
    { text: "Today we talk.", lang: "en", start: 1.5 });
});
test("中文清理标点；自动模式按英语记", () => {
  assert.deepEqual(acceptFinal({ text: "同学们好 ，今天", conf: 0.98, start: 0 }, "zh"),
    { text: "同学们好，今天", lang: "zh", start: 0 });
  assert.equal(acceptFinal({ text: "Today", conf: -1, start: 0 }, "auto").lang, "en");
});
test("中文模式下的英文（把握 0.76 也要靠文字特征挡掉）", () => {
  assert.equal(acceptFinal({ text: "Today we are going to talk", conf: 0.76, start: 0 }, "zh"), null);
});
test("草稿只能按文字特征过滤", () => {
  assert.equal(acceptPartial("Kong X", "zh"), false);
  assert.equal(acceptPartial("Kong X", "en"), true);
});
