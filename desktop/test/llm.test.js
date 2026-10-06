import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiPool, orderModels } from "../src/main/llm/gemini.js";
import { askClaude } from "../src/main/llm/claude.js";
import { LLM, parseJson } from "../src/main/llm/index.js";
import { NoKey, AllModelsBusy } from "../src/main/llm/errors.js";

const err = (status, message) => Object.assign(new Error(message), { status });
function fakeGemini(behave = {}) {
  const calls = [];
  return { calls, models: { generateContent: async (req) => {
    calls.push(req);
    const b = typeof behave === "function" ? behave(req) : behave[req.model];
    if (b instanceof Error) throw b;
    if (b === "hang") return new Promise(() => {});
    return { text: b ?? `ok:${req.model}` };
  } } };
}

test("额度用完的模型被记住，之后直接跳过", async () => {
  const c = fakeGemini({ a: err(429, 'GenerateRequestsPerDayPerProjectPerModel "retryDelay": "3600s"') });
  const pool = new GeminiPool(c, () => 0);
  assert.equal((await pool.generate(["a", "b"], {}, 1000)).text, "ok:b");
  assert.equal((await pool.generate(["a", "b"], {}, 1000)).text, "ok:b");
  assert.deepEqual(c.calls.map((r) => r.model), ["a", "b", "b"]);
});

test("超时的模型换下一个", async () => {
  const pool = new GeminiPool(fakeGemini({ a: "hang" }), () => 0);
  assert.equal((await pool.generate(["a", "b"], {}, 30)).text, "ok:b");
});

test("全部用完：第一次抛原错误，之后抛 AllModelsBusy", async () => {
  const quota = err(429, "PerDay");
  const pool = new GeminiPool(fakeGemini({ a: quota, b: quota }), () => 0);
  await assert.rejects(pool.generate(["a", "b"], {}, 1000), /PerDay/);
  await assert.rejects(pool.generate(["a", "b"], {}, 1000), AllModelsBusy);
});

test("其他错误（比如 key 无效）直接抛出，不换模型", async () => {
  const c = fakeGemini({ a: err(400, "API key not valid") });
  await assert.rejects(new GeminiPool(c, () => 0).generate(["a", "b"], {}, 1000), /API key not valid/);
  assert.equal(c.calls.length, 1);
});

test("指定的模型排到最前", () => {
  assert.deepEqual(orderModels(["a", "b", "c"], "c"), ["c", "a", "b"]);
  assert.deepEqual(orderModels(["a", "b"], "auto"), ["a", "b"]);
});

const settings = (keys = {}, prefs = {}) => ({ getKey: (p) => keys[p] ?? "", pref: (k, d) => prefs[k] ?? d });

test("没填 key：available 为空，调用抛 NoKey", async () => {
  const llm = new LLM(settings(), { gemini: () => fakeGemini(), claude: () => ({}) });
  assert.deepEqual(llm.available(), []);
  await assert.rejects(llm.translate("hi", [], "简体中文", "gemini"), NoKey);
});

test("翻译带上文和纠错提示词", async () => {
  const g = fakeGemini(() => " 你好 ");
  const llm = new LLM(settings({ gemini: "k" }), { gemini: () => g, claude: () => ({}) });
  assert.equal(await llm.translate("C", ["A", "B"], "简体中文", "gemini"), "你好");
  const req = g.calls[0];
  assert.equal(req.contents, "【上文】\nA\nB\n\n【当前句】\nC");
  assert.match(req.config.systemInstruction, /语音识别可能有错字/);
  assert.equal(req.model, "gemini-3.5-flash-lite");
});

test("课后精讲两步：先 JSON 大纲（可能带 ```json 包裹）再正文", async () => {
  const g = fakeGemini((req) => req.config.responseMimeType === "application/json"
    ? '```json\n{"title":"T","overview":"O","chapters":[{"start":"00:00:00","end":"00:01:00","title":"c","desc":"d"}]}\n```'
    : "## AI 精讲\nbody");
  const llm = new LLM(settings({ gemini: "k" }), { gemini: () => g, claude: () => ({}) });
  const { outline, body } = await llm.report("[00:00:00] hi", "简体中文", "gemini");
  assert.equal(outline.title, "T");
  assert.equal(body, "## AI 精讲\nbody");
  assert.match(g.calls[1].contents, /章节大纲：\n\[00:00:00 – 00:01:00\] c：d/);
  assert.throws(() => parseJson("没有 JSON"), /格式不对/);
});

test("Claude：取文字、拒绝时给提示、Haiku 不带 effort", async () => {
  const sent = [];
  const client = { beta: { messages: { create: async (p) => { sent.push(p); return p.model === "x"
    ? { stop_reason: "refusal", content: [] } : { stop_reason: "end_turn", content: [{ type: "text", text: " 你好 " }] }; } } } };
  assert.equal(await askClaude(client, "claude-opus-5-5", { system: "s", prompt: "p", effort: "low", maxTokens: 10 }), "你好");
  assert.equal(sent[0].output_config.effort, "low");
  assert.equal(sent[0].fallbacks, "default");
  await askClaude(client, "claude-haiku-4-5", { system: "s", prompt: "p", effort: "low", maxTokens: 10 });
  assert.equal(sent[1].output_config, undefined);
  assert.equal(await askClaude(client, "x", { system: "s", prompt: "p", effort: "low", maxTokens: 10 }), "（模型拒绝处理该段）");
});
