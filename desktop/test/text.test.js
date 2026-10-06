import { test } from "node:test";
import assert from "node:assert/strict";
import { clean, simplify, appleLangOk, collapseRepeats, fmtTs, friendly } from "../src/main/text.js";
import { NoKey, AllModelsBusy, TimeoutError, withTimeout, isAuthError } from "../src/main/llm/errors.js";

test("繁转简只在目标是中文时做", () => {
  assert.equal(simplify("這是一張吞食動物的蟒蛇的照片", "zh"), "这是一张吞食动物的蟒蛇的照片");
  assert.equal(simplify("這是", "en"), "這是");
  assert.equal(simplify("", "zh"), "");
});

test("clean：中文全角标点、去标点前空格、去幻觉、去复读", () => {
  assert.equal(clean("同学们好 ，今天讲第二定律 。", "zh"), "同学们好，今天讲第二定律。");
  assert.equal(clean("你好,对吗?", "zh"), "你好，对吗？");
  assert.equal(clean("Thank you.", "en"), "");
  assert.equal(clean("  Hello, world?  ", "en"), "Hello, world?");
  assert.equal(collapseRepeats("喝酒 喝酒 喝酒 喝酒 喝酒"), "喝酒");
});

test("appleLangOk：只认所选语言", () => {
  assert.equal(appleLangOk("Today we talk about entropy.", "en"), true);
  assert.equal(appleLangOk("同学们好", "en"), false);
  assert.equal(appleLangOk("同学们好", "zh"), true);
  assert.equal(appleLangOk("Today we are going to talk", "zh"), false);
  assert.equal(appleLangOk("ん今日は今は日里学", "zh"), false);
  assert.equal(appleLangOk("今日は", "ja"), true);
  assert.equal(appleLangOk("안녕하세요", "ko"), true);
  assert.equal(appleLangOk("Bonjour à tous", "fr"), true);
});

test("fmtTs 支持超过 1 小时", () => {
  assert.equal(fmtTs(0), "00:00:00");
  assert.equal(fmtTs(65.9), "00:01:05");
  assert.equal(fmtTs(3909.7), "01:05:09");
});

test("friendly：把报错翻成看得懂的中文", () => {
  assert.equal(friendly(new NoKey("还没填写 Gemini 的 API key")), "还没填写 Gemini 的 API key");
  assert.equal(friendly(new AllModelsBusy("x")), "Gemini 今天的免费额度用完了");
  assert.equal(friendly(new Error("429 GenerateRequestsPerDayPerProjectPerModel")), "Gemini 今天的免费额度用完了");
  assert.equal(friendly(new Error("503 UNAVAILABLE")), "服务器繁忙");
  assert.equal(friendly(new TimeoutError("x")), "响应超时");
  assert.equal(friendly(new Error("API key not valid. Please pass a valid API key.")), "API key 无效");
});

test("withTimeout 超时抛 TimeoutError；isAuthError 识别无效 key", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 20), TimeoutError);
  assert.equal(await withTimeout(Promise.resolve(1), 20), 1);
  assert.equal(isAuthError(Object.assign(new Error("x"), { status: 401 })), true);
  assert.equal(isAuthError(new Error("API key not valid")), true);
  assert.equal(isAuthError(new Error("503 UNAVAILABLE")), false);
});
