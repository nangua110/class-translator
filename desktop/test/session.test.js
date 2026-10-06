import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session } from "../src/main/session.js";
import { AllModelsBusy } from "../src/main/llm/errors.js";

class FakeAsr extends EventEmitter {
  constructor(speaker, offset) { super(); Object.assign(this, { speaker, offset, fed: 0, closed: false, killed: false }); }
  start() {}
  feed(b) { this.fed += b.length; }
  async close() { this.closed = true; }
  kill() { this.killed = true; }
}

function setup({ llm = {}, appleTr = {}, caps = { appleAsr: true } } = {}) {
  const sent = [], asrs = [], saved = [];
  const s = new Session({
    send: (m) => sent.push(m),
    llm: { available: () => ["gemini"], translate: async (t) => `译:${t}`, summarize: async () => "笔记", ...llm },
    appleTr: { translate: async () => ({ tr: "苹果译", code: "" }), ...appleTr },
    records: { newName: () => "2026-10-07_09-00-00.md", save: (_n, _s, lines) => saved.push(lines.length) },
    caps,
    makeAsr: (sp, off) => { const a = new FakeAsr(sp, off); asrs.push(a); return a; },
    sleep: async () => {},
  });
  s.configure({ speaker: "en", target: "zh", asr: "apple", translator: "gemini" });
  return { s, sent, asrs, saved };
}
const pcm = (sec) => Buffer.alloc(sec * 32000);
const final = (text, conf = 0.95, start = 0) => ({ type: "final", text, conf, start });
const errors = (sent) => sent.filter((m) => m.type === "error").map((m) => m.msg);

test("确定句 → 字幕 + 后台翻译 + 存盘；草稿照发", async () => {
  const { s, sent, asrs, saved } = setup();
  s.audio(pcm(1));
  asrs[0].emit("message", { type: "partial", text: "Today we" });
  asrs[0].emit("message", final("Today we talk about entropy.", 0.95, 0.5));
  await s.idle();
  assert.deepEqual(sent.find((m) => m.type === "partial"), { type: "partial", text: "Today we" });
  const line = sent.find((m) => m.type === "line");
  assert.equal(line.text, "Today we talk about entropy.");
  assert.equal(line.t, 0.5);
  assert.deepEqual(sent.find((m) => m.type === "translation"), { type: "translation", id: 0, tr: "译:Today we talk about entropy." });
  assert.ok(saved.length >= 2);
});

test("其他语言的乱码不出字幕", async () => {
  const { s, sent, asrs } = setup();
  s.audio(pcm(1));
  asrs[0].emit("message", final("Hong Shiemen Hao, Xin Tian woman", 0.24));
  await s.idle();
  assert.equal(sent.filter((m) => m.type === "line").length, 0);
});

test("中途换说话人语言：关掉旧识别，新识别从当前时间算起", () => {
  const { s, asrs } = setup();
  s.audio(pcm(2));
  s.configure({ speaker: "zh" });
  assert.equal(asrs[0].closed, true);
  s.audio(pcm(1));
  assert.equal(asrs[1].speaker, "zh");
  assert.equal(asrs[1].offset, 2);
});

test("Gemini 额度用完：改用苹果翻译，只提示一次", async () => {
  const { s, sent, asrs } = setup({ llm: { translate: async () => { throw new AllModelsBusy("x"); } } });
  s.audio(pcm(1));
  asrs[0].emit("message", final("First sentence here."));
  asrs[0].emit("message", final("Second sentence here."));
  await s.idle();
  assert.deepEqual(sent.filter((m) => m.type === "translation").map((m) => m.tr), ["苹果译", "苹果译"]);
  assert.equal(errors(sent).filter((m) => m.includes("苹果翻译")).length, 1);
});

test("苹果翻译出的繁体转成简体", async () => {
  const { s, sent, asrs } = setup({ appleTr: { translate: async () => ({ tr: "這是一張吞食動物的照片", code: "" }) } });
  s.configure({ translator: "apple" });
  s.audio(pcm(1));
  asrs[0].emit("message", final("It was a picture."));
  await s.idle();
  assert.equal(sent.find((m) => m.type === "translation").tr, "这是一张吞食动物的照片");
});

test("10 秒内一字不差的重复句只留一条", async () => {
  const { s, sent, asrs } = setup();
  s.audio(pcm(1));
  asrs[0].emit("message", final("I can't get more from you.", 0.95, 1));
  asrs[0].emit("message", final("I can't get more from you.", 0.95, 3));
  await s.idle();
  assert.equal(sent.filter((m) => m.type === "line").length, 1);
});

test("识别程序崩溃：自动重启一次；再崩就停止并只提示一次，字幕不丢", async () => {
  const { s, sent, asrs } = setup();
  s.audio(pcm(1));
  asrs[0].emit("message", final("Kept line."));
  asrs[0].emit("exit", 1);
  s.audio(pcm(1));
  assert.equal(asrs.length, 2, "第一次崩溃后应自动重启");
  asrs[1].emit("exit", 1);
  s.audio(pcm(1));
  s.audio(pcm(1));
  assert.equal(asrs.length, 2, "第二次崩溃后不再重启");
  assert.equal(errors(sent).filter((m) => m.includes("连续出错")).length, 1);
  assert.equal(s.lines.length, 1);
});

test("被我们自己关掉（exit -1 / 0）不算崩溃", () => {
  const { s, asrs } = setup();
  s.audio(pcm(1)); asrs[0].emit("exit", -1);
  s.audio(pcm(1)); asrs[1].emit("exit", 0);
  s.audio(pcm(1));
  assert.equal(asrs.length, 3);
});

test("结束录制：关识别、等翻译、生成最终笔记、发 done", async () => {
  const { s, sent, asrs } = setup();
  s.audio(pcm(1));
  asrs[0].emit("message", final("A sentence."));
  await s.stop();
  assert.equal(asrs[0].closed, true);
  assert.ok(sent.some((m) => m.type === "summary" && m.md === "笔记"));
  assert.deepEqual(sent.at(-1), { type: "done", record: "2026-10-07_09-00-00.md" });
});

test("关窗口 / 退出（dispose）：杀掉识别程序并存盘", () => {
  const { s, asrs, saved } = setup();
  s.audio(pcm(1));
  asrs[0].emit("message", final("Save me."));
  const before = saved.length;
  s.dispose();
  assert.equal(asrs[0].killed, true);
  assert.ok(saved.length > before);
});

test("不支持苹果识别的电脑：只提示一次，不崩", () => {
  const { s, sent, asrs } = setup({ caps: { appleAsr: false } });
  s.audio(pcm(1)); s.audio(pcm(1));
  assert.equal(asrs.length, 0);
  assert.equal(errors(sent).length, 1);
  assert.match(errors(sent)[0], /macOS 26/);
});

test("暂停时不送音频", () => {
  const { s, asrs } = setup();
  s.paused = true;
  s.audio(pcm(1));
  assert.equal(asrs.length, 0);
});
