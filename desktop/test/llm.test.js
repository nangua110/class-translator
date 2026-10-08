import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiPool, orderModels } from "../src/main/llm/gemini.js";
import { askClaude } from "../src/main/llm/claude.js";
import { LLM, parseJson } from "../src/main/llm/index.js";
import { NoKey, AllModelsBusy, TimeoutError } from "../src/main/llm/errors.js";
import { OpenAICompat, normalizeBase, checkBase, isLocalBase } from "../src/main/llm/openai.js";
import { friendly } from "../src/main/text.js";

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

test("云端识别：音频以 WAV 附件发送，只要求返回转写和语言（翻译另外带上文做）", async () => {
  const g = fakeGemini(() => '{"text":" Hello there. ","lang":"en"}');
  const llm = new LLM(settings({ gemini: "k" }), { gemini: () => g, claude: () => ({}) });
  const wav = Buffer.from("RIFF....WAVEfmt ");
  assert.deepEqual(await llm.recognize(wav, "英语"), { text: "Hello there.", lang: "en" });
  const req = g.calls[0];
  const [audio, prompt] = req.contents[0].parts;
  assert.equal(audio.inlineData.mimeType, "audio/wav");
  assert.equal(Buffer.from(audio.inlineData.data, "base64").toString(), wav.toString());
  assert.equal(prompt.text, "请处理这段录音。");
  assert.equal(req.config.responseMimeType, "application/json");
  assert.deepEqual(req.config.responseJsonSchema.required, ["text", "lang"]);
  assert.doesNotMatch(req.config.systemInstruction, /translation/); // 不再要求模型顺带翻译
  assert.match(req.config.systemInstruction, /说话人主要讲英语/);
  assert.match(req.config.systemInstruction, /绝不要猜或编造句子/);
});

test("云端识别：自动模式不加说话人提示；没 key 抛 NoKey", async () => {
  const g = fakeGemini(() => '{"text":"","lang":"other"}');
  const llm = new LLM(settings({ gemini: "k" }), { gemini: () => g, claude: () => ({}) });
  await llm.recognize(Buffer.from("x"), null);
  assert.doesNotMatch(g.calls[0].config.systemInstruction, /说话人主要讲/);
  const none = new LLM(settings(), { gemini: () => fakeGemini(), claude: () => ({}) });
  await assert.rejects(none.recognize(Buffer.from("x"), null), NoKey);
});

test("模型都因为超时 / 服务器忙在冷却：报的是「网络慢」不是「额度用完」", async () => {
  const pool = new GeminiPool(fakeGemini({ a: "hang", b: err(503, "UNAVAILABLE") }), () => 0);
  await assert.rejects(pool.generate(["a", "b"], {}, 20));
  const e = await pool.generate(["a", "b"], {}, 20).catch((x) => x);
  assert.ok(e instanceof AllModelsBusy);
  assert.equal(e.quota, false);
  const quota = new GeminiPool(fakeGemini({ a: err(429, "PerDay"), b: err(429, "PerDay") }), () => 0);
  await assert.rejects(quota.generate(["a", "b"], {}, 20));
  assert.equal((await quota.generate(["a", "b"], {}, 20).catch((x) => x)).quota, true);
});

// ---------- 其他模型（OpenAI 兼容接口） ----------
function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = typeof reply === "function" ? reply() : reply;
    if (r instanceof Error) throw r;
    return { ok: r.status === undefined || r.status < 400, status: r.status ?? 200, text: async () => JSON.stringify(r.body) };
  };
  return Object.assign(fn, { calls });
}
const said = (content) => ({ body: { choices: [{ message: { content } }] } });

test("接口地址：去掉多余的斜杠和路径；远程地址必须加密，本机可以不加密", () => {
  assert.equal(normalizeBase(" https://api.example.com/v1/ "), "https://api.example.com/v1");
  assert.equal(normalizeBase("https://api.example.com/v1/chat/completions"), "https://api.example.com/v1");
  assert.equal(checkBase("https://api.example.com/v1"), "");
  assert.equal(checkBase("http://localhost:11434/v1"), "");
  assert.equal(checkBase("http://127.0.0.1:1234/v1"), "");
  assert.match(checkBase("http://api.example.com/v1"), /https/);
  assert.match(checkBase("随便写的"), /地址/);
  assert.equal(isLocalBase("http://localhost:11434/v1"), true);
  assert.equal(isLocalBase("https://api.example.com/v1"), false);
});

test("其他模型：按 OpenAI 格式发请求，key 只放在请求头里", async () => {
  const f = fakeFetch(said(" 你好 "));
  const c = new OpenAICompat({ base: "https://api.example.com/v1", apiKey: "sk-test-1234567890", fetch: f });
  assert.equal(await c.chat({ model: "m1", system: "系统", prompt: "hello", timeoutMs: 1000 }), "你好");
  assert.equal(f.calls[0].url, "https://api.example.com/v1/chat/completions");
  assert.equal(f.calls[0].headers.Authorization, "Bearer sk-test-1234567890");
  assert.deepEqual(f.calls[0].body, { model: "m1", messages: [{ role: "system", content: "系统" }, { role: "user", content: "hello" }], stream: false });
});

test("其他模型：本地模型不带 key；去掉模型输出里的思考过程", async () => {
  const f = fakeFetch(said("<think>先想一想</think>\n译文"));
  const c = new OpenAICompat({ base: "http://localhost:11434/v1", apiKey: "", fetch: f });
  assert.equal(await c.chat({ model: "m", system: "s", prompt: "p", timeoutMs: 1000 }), "译文");
  assert.equal("Authorization" in f.calls[0].headers, false);
});

test("其他模型：报错带上状态码和服务商的说明，不带 key；连不上、超时、空回复都说清楚", async () => {
  const mk = (reply) => new OpenAICompat({ base: "https://api.example.com/v1", apiKey: "sk-secret-1234567890", fetch: fakeFetch(reply) });
  const ask = (c, timeoutMs = 1000) => c.chat({ model: "m", system: "s", prompt: "p", timeoutMs });
  const e = await ask(mk({ status: 401, body: { error: { message: "Incorrect API key" } } })).catch((x) => x);
  assert.equal(e.status, 401);
  assert.match(e.message, /401 Incorrect API key/);
  assert.equal(e.message.includes("sk-secret"), false);
  assert.equal(friendly(e), "API key 无效");
  assert.match(friendly(await ask(mk({ status: 404, body: { error: "model not found" } })).catch((x) => x)), /接口地址或模型名不对/);
  assert.match(friendly(await ask(mk({ status: 402, body: { error: { message: "Insufficient Balance" } } })).catch((x) => x)), /余额不足/);
  assert.match(friendly(await ask(mk(new TypeError("fetch failed"))).catch((x) => x)), /连不上/);
  await assert.rejects(ask(mk(said(""))), /没有返回内容/);
  const hang = new OpenAICompat({ base: "https://api.example.com/v1", apiKey: "k", fetch: () => new Promise(() => {}) });
  await assert.rejects(ask(hang, 30), TimeoutError);
});

function fakeSettings(prefs = {}, keys = {}) {
  return { getKey: (p) => keys[p] ?? "", pref: (k, d) => prefs[k] ?? d };
}
test("LLM：填了接口地址、模型名和 key 才算可用；本地模型不用 key；翻译照样带上文", async () => {
  const made = [];
  const factories = { gemini: () => ({}), claude: () => ({}), openai: (o) => { made.push(o); return { chat: async (r) => { made.push(r); return "译文"; } }; } };
  assert.deepEqual(new LLM(fakeSettings({ openaiBase: "https://api.example.com/v1", openaiModel: "m" }), factories).available(), []);
  assert.deepEqual(new LLM(fakeSettings({ openaiBase: "http://localhost:11434/v1", openaiModel: "m" }), factories).available(), ["openai"]);
  await assert.rejects(new LLM(fakeSettings(), factories).translate("hi", [], "简体中文", "openai"), NoKey);
  made.length = 0;
  const llm = new LLM(fakeSettings({ openaiBase: "https://api.example.com/v1", openaiModel: "m9" }, { openai: "sk-test-1234567890" }), factories);
  assert.deepEqual(llm.available(), ["openai"]);
  assert.equal(await llm.translate("当前", ["一", "二", "三", "四"], "简体中文", "openai"), "译文");
  assert.deepEqual(made[0], { base: "https://api.example.com/v1", apiKey: "sk-test-1234567890" });
  assert.equal(made[1].model, "m9");
  assert.match(made[1].system, /同声传译/);
  assert.equal(made[1].prompt, "【上文】\n二\n三\n四\n\n【当前句】\n当前");
});
