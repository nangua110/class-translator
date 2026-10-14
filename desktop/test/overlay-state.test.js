import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY, nextState } from "../src/main/overlay/state.js";

const run = (...ms) => ms.reduce(nextState, EMPTY);

test("草稿边说边显示，定稿后换成正式句子", () => {
  let s = run({ type: "partial", text: "Today we" });
  assert.deepEqual([s.en, s.live], ["Today we", true]);
  s = nextState(s, { type: "partial", text: "" });
  assert.equal(s.en, "Today we", "清空草稿时不闪空白，等正式句子来");
  s = nextState(s, { type: "line", id: 0, text: "Today we talk about entropy.", tr: "" });
  assert.deepEqual([s.en, s.live], ["Today we talk about entropy.", false]);
});

test("翻译到了才显示中文；老师接着说下一句时，上一句的中文留着", () => {
  const s = run(
    { type: "line", id: 0, text: "First sentence.", tr: "" },
    { type: "translation", id: 0, tr: "第一句。" },
    { type: "partial", text: "Second" },
    { type: "line", id: 1, text: "Second sentence.", tr: "" },
  );
  assert.deepEqual([s.en, s.zh], ["Second sentence.", "第一句。"]);
  assert.equal(nextState(s, { type: "translation", id: 1, tr: "第二句。" }).zh, "第二句。");
});

test("几句同时翻译：旧句子的翻译晚到，不盖掉新句子的", () => {
  const s = run(
    { type: "line", id: 0, text: "A.", tr: "" },
    { type: "line", id: 1, text: "B.", tr: "" },
    { type: "translation", id: 1, tr: "乙。" },
    { type: "translation", id: 0, tr: "甲。" },
  );
  assert.equal(s.zh, "乙。");
});

test("自带翻译的句子、中文原话、低把握句子、新课清空", () => {
  assert.equal(run({ type: "line", id: 0, text: "Hi.", tr: "你好。" }).zh, "你好。");
  const same = run({ type: "line", id: 0, text: "A.", tr: "甲。" }, { type: "line", id: 1, text: "大家好", same: true });
  assert.deepEqual([same.en, same.zh], ["大家好", ""]);
  assert.equal(run({ type: "line", id: 0, text: "uh", low: true }).low, true);
  assert.equal(run({ type: "line", id: 0, text: "uh", low: true }, { type: "partial", text: "Next" }).low, false);
  assert.deepEqual(run({ type: "line", id: 0, text: "A.", tr: "甲。" }, { type: "reset" }), EMPTY);
  assert.equal(run({ type: "error", msg: "x" }), EMPTY);
});
