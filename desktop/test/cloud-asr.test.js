import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudASR } from "../src/main/cloud/asr.js";
import { acceptCloudFinal } from "../src/main/cloud/filter.js";
import { AllModelsBusy, NoKey } from "../src/main/llm/errors.js";

const SR = 16000;
function pcm(sec, amp) {
  const n = Math.round(sec * SR), buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * 440 * i) / SR)), i * 2);
  return buf;
}
const sentence = () => Buffer.concat([pcm(1.2, 0.3), pcm(1, 0)]); // 一句话 + 1 秒静音
function setup({ recognize, voice = true, now } = {}) {
  const calls = [], msgs = [];
  const asr = new CloudASR({
    llm: { recognize: async (wav, sp) => { calls.push([wav, sp]); return recognize ? recognize(calls.length) : { text: `第${calls.length}句`, lang: "zh" }; } },
    vad: { hasVoice: async () => voice },
    speaker: "en", offset: 5, now,
  });
  asr.on("message", (m) => msgs.push(m));
  asr.start();
  return { asr, calls, msgs };
}
const finals = (msgs) => msgs.filter((m) => m.type === "final");
const errors = (msgs) => msgs.filter((m) => m.type === "error").map((m) => m.msg);

test("有人声的一句：发 WAV 去识别，带上说话人语言，返回转写和开始时间（不带译文）", async () => {
  const { asr, calls, msgs } = setup({ recognize: () => ({ text: "Hello.", lang: "en" }) });
  asr.feed(sentence());
  await asr.close();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].toString("ascii", 0, 4), "RIFF");
  assert.deepEqual(calls[0].slice(1), ["英语"]);
  const [f] = finals(msgs);
  assert.deepEqual({ ...f, start: Math.round(f.start * 10) / 10 }, { type: "final", source: "cloud", text: "Hello.", lang: "en", start: 0 });
  assert.deepEqual(msgs.filter((m) => m.type === "status").map((m) => m.recognizing), [true, false]);
});

test("只有杂音（人声检测不通过）：不发请求", async () => {
  const { asr, calls } = setup({ voice: false });
  asr.feed(sentence());
  await asr.close();
  assert.equal(calls.length, 0);
});

test("老师一直讲没停顿：结束录制时最后半句也送去识别", async () => {
  const { asr, calls } = setup();
  asr.feed(pcm(3, 0.3));
  assert.equal(calls.length, 0);
  await asr.close();
  assert.equal(calls.length, 1);
});

test("额度用完：只提示一次，10 分钟内不再请求，之后自动恢复", async () => {
  let t = 0;
  const { asr, calls, msgs } = setup({ now: () => t, recognize: (n) => { if (n === 1) throw new AllModelsBusy("x"); return { text: "Back.", lang: "en", tr: "" }; } });
  asr.feed(sentence());
  asr.feed(sentence());
  await asr.idle();
  assert.equal(calls.length, 1);
  assert.equal(errors(msgs).length, 1);
  assert.match(errors(msgs)[0], /额度用完.*10 分钟/);
  t = 600_001;
  asr.feed(sentence());
  await asr.close();
  assert.equal(calls.length, 2);
  assert.equal(finals(msgs).length, 1);
});

test("没填 key：只提示一次，填上之后不用重开就能识别", async () => {
  const { asr, calls, msgs } = setup({ recognize: (n) => { if (n <= 2) throw new NoKey("还没填写 Gemini 的 API key"); return { text: "Ok.", lang: "en", tr: "" }; } });
  asr.feed(sentence()); asr.feed(sentence()); asr.feed(sentence());
  await asr.close();
  assert.equal(errors(msgs).length, 1);
  assert.match(errors(msgs)[0], /Gemini 的 API key/);
  assert.equal(finals(msgs).length, 1);
});

test("kill：丢掉还没处理的段，exit -1；close 后 exit 0", async () => {
  const a = setup();
  const code = new Promise((r) => a.asr.on("exit", r));
  a.asr.feed(sentence());
  a.asr.kill();
  assert.equal(await code, -1);
  await a.asr.idle();
  assert.equal(a.calls.length, 0);
  const b = setup();
  const code2 = new Promise((r) => b.asr.on("exit", r));
  await b.asr.close();
  assert.equal(await code2, 0);
});

test("acceptCloudFinal：只留所选语言；自动模式中英都留；奇怪的语言代码按文字归类", () => {
  assert.equal(acceptCloudFinal({ text: "同学们好", lang: "zh", tr: "", start: 1 }, "en"), null);
  assert.deepEqual(acceptCloudFinal({ text: "Hi there ", lang: "en", start: 1 }, "en"), { text: "Hi there", lang: "en", start: 1 });
  assert.equal(acceptCloudFinal({ text: "同学们好", lang: "zh", tr: "", start: 0 }, "auto").lang, "zh");
  assert.equal(acceptCloudFinal({ text: "同學們好", lang: "other", tr: "", start: 0 }, "auto").text, "同学们好");
  assert.equal(acceptCloudFinal({ text: "Hello", lang: "other", tr: "", start: 0 }, "auto").lang, "en");
  assert.equal(acceptCloudFinal({ text: "Thank you.", lang: "en", tr: "", start: 0 }, "en"), null, "常见胡编句丢掉");
  assert.equal(acceptCloudFinal({ text: "", lang: "en", tr: "", start: 0 }, "en"), null);
});

test("网络慢 / 服务器忙（不是额度用完）：不暂停 10 分钟，下一句照常请求，提示的是网络问题", async () => {
  const { asr, calls, msgs } = setup({ recognize: (n) => { if (n === 1) throw new AllModelsBusy("x", { quota: false }); return { text: "Ok.", lang: "en", tr: "" }; } });
  asr.feed(sentence()); asr.feed(sentence());
  await asr.close();
  assert.equal(calls.length, 2);
  assert.equal(finals(msgs).length, 1);
  assert.match(errors(msgs)[0], /网络/);
  assert.doesNotMatch(errors(msgs)[0], /额度/);
});

test("识别跟不上时最多积压 3 句：跳过最旧的，只提示一次", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { asr, calls, msgs } = setup({ recognize: async (n) => { if (n === 1) await gate; return { text: `第${n}句`, lang: "zh", tr: "" }; } });
  for (let i = 0; i < 7; i++) asr.feed(sentence());
  await new Promise((r) => setTimeout(r, 20));
  release();
  await asr.close();
  assert.equal(calls.length, 4, "第 1 句 + 最新的 3 句");
  assert.equal(errors(msgs).filter((m) => m.includes("跳过")).length, 1);
});

test("人声检测出错：提示一次，照常识别", async () => {
  const calls = [], msgs = [];
  const asr = new CloudASR({
    llm: { recognize: async () => { calls.push(1); return { text: "Hi.", lang: "en", tr: "" }; } },
    vad: { hasVoice: async () => { throw new Error("wasm 加载失败"); } },
    speaker: "en", offset: 0,
  });
  asr.on("message", (m) => msgs.push(m));
  asr.feed(sentence()); asr.feed(sentence());
  await asr.close();
  assert.equal(calls.length, 2);
  assert.equal(errors(msgs).length, 1);
  assert.match(errors(msgs)[0], /人声检测/);
});

test("自动模式只留中英文：日语、韩语丢掉；other 里有假名或韩文也丢掉", () => {
  assert.equal(acceptCloudFinal({ text: "今日は熱力学です", lang: "ja", tr: "", start: 0 }, "auto"), null);
  assert.equal(acceptCloudFinal({ text: "안녕하세요", lang: "ko", tr: "", start: 0 }, "auto"), null);
  assert.equal(acceptCloudFinal({ text: "Bonjour", lang: "fr", tr: "", start: 0 }, "auto"), null);
  assert.equal(acceptCloudFinal({ text: "こんにちは", lang: "other", tr: "", start: 0 }, "auto"), null);
  assert.equal(acceptCloudFinal({ text: "안녕", lang: "other", tr: "", start: 0 }, "auto"), null);
  assert.equal(acceptCloudFinal({ text: "同学们好", lang: "other", tr: "", start: 0 }, "auto").lang, "zh");
});
