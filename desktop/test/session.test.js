import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session } from "../src/main/session.js";
import { AllModelsBusy } from "../src/main/llm/errors.js";

class FakeAsr extends EventEmitter {
  constructor(speaker, offset, kind = "apple") { super(); Object.assign(this, { speaker, offset, kind, fed: 0, closed: false, killed: false }); }
  start() {}
  feed(b) { this.fed += b.length; }
  async close() { this.closed = true; }
  kill() { this.killed = true; }
}

function setup({ llm = {}, appleTr = {}, caps = { appleAsr: true, cloudAsr: true, localAsr: true } } = {}) {
  const sent = [], asrs = [], saved = [];
  const s = new Session({
    send: (m) => sent.push(m),
    llm: { available: () => ["gemini"], translate: async (t) => `译:${t}`, summarize: async () => "笔记", ...llm },
    appleTr: { translate: async () => ({ tr: "苹果译", code: "" }), ...appleTr },
    records: { newName: () => "2026-10-07_09-00-00.md", save: (_n, _s, lines) => saved.push(lines.length) },
    caps,
    makeAsr: (kind, sp, off) => { const a = new FakeAsr(sp, off, kind); asrs.push(a); return a; },
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
  const { s, sent, asrs } = setup({ caps: { appleAsr: false, cloudAsr: true } });
  s.audio(pcm(1)); s.audio(pcm(1));
  assert.equal(asrs.length, 0);
  assert.equal(errors(sent).length, 1);
  assert.match(errors(sent)[0], /macOS 26/);
  assert.match(errors(sent)[0], /云端/);
});

test("暂停时不送音频", () => {
  const { s, asrs } = setup();
  s.paused = true;
  s.audio(pcm(1));
  assert.equal(asrs.length, 0);
});

test("文稿文件夹写不进去：只提示一次，不抛错，字幕照常出", async () => {
  const { s, sent, asrs } = setup();
  s.records.save = () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); };
  s.audio(pcm(1));
  asrs[0].emit("message", final("First line."));
  asrs[0].emit("message", final("Second line."));
  await s.idle();
  assert.equal(sent.filter((m) => m.type === "line").length, 2);
  assert.equal(errors(sent).filter((m) => m.includes("文稿")).length, 1);
});

test("云端识别：字幕先出，翻译按所选方式另外做并带上前几句上文；时间加上引擎的起点", async () => {
  const asked = [];
  const { s, sent, asrs } = setup({ llm: { translate: async (t, ctx, target, provider) => { asked.push({ t, ctx, provider }); return `译:${t}`; } } });
  s.configure({ asr: "cloud", translator: "claude" });
  s.audio(pcm(3));
  assert.equal(asrs[0].kind, "cloud");
  asrs[0].offset = 3;
  asrs[0].emit("message", { type: "status", recognizing: true });
  asrs[0].emit("message", { type: "final", source: "cloud", text: "The second law.", lang: "en", start: 1 });
  asrs[0].emit("message", { type: "final", source: "cloud", text: "Entropy never decreases.", lang: "en", start: 5 });
  await s.idle();
  const lines = sent.filter((m) => m.type === "line");
  assert.equal(lines[0].tr, "", "字幕先出，译文随后到");
  assert.equal(lines[0].t, 4);
  assert.deepEqual(sent.filter((m) => m.type === "translation").map((m) => m.tr).sort(), ["译:Entropy never decreases.", "译:The second law."]);
  const second = asked.find((a) => a.t === "Entropy never decreases.");
  assert.deepEqual(second.ctx, ["The second law."], "翻译时带上前面的句子做上文");
  assert.equal(second.provider, "claude", "用的是所选的翻译方式");
  assert.deepEqual(sent.find((m) => m.type === "status"), { type: "status", recognizing: true });
});

test("云端识别：别的语言丢掉，所选语言照常后台翻译", async () => {
  const { s, sent, asrs } = setup();
  s.configure({ asr: "cloud" });
  s.audio(pcm(1));
  asrs[0].emit("message", { type: "final", source: "cloud", text: "同学们好", lang: "zh", start: 0 });
  asrs[0].emit("message", { type: "final", source: "cloud", text: "Good morning.", lang: "en", start: 2 });
  await s.idle();
  assert.deepEqual(sent.filter((m) => m.type === "line").map((m) => m.text), ["Good morning."]);
  assert.equal(sent.find((m) => m.type === "translation").tr, "译:Good morning.");
});

test("从苹果识别切到云端：关掉旧引擎，换新引擎", () => {
  const { s, asrs } = setup();
  s.audio(pcm(1));
  s.configure({ asr: "cloud" });
  assert.equal(asrs[0].closed, true);
  s.audio(pcm(1));
  assert.equal(asrs[1].kind, "cloud");
});

test("没有苹果识别的电脑选云端：正常工作，不提示 macOS 26", () => {
  const { s, sent, asrs } = setup({ caps: { appleAsr: false, cloudAsr: true } });
  s.configure({ asr: "cloud" });
  s.audio(pcm(1));
  assert.equal(asrs.length, 1);
  assert.equal(errors(sent).length, 0);
});

test("本地实时：草稿照发，定稿直接出字幕并按所选方式带上文翻译", async () => {
  const asked = [];
  const { s, sent, asrs } = setup({ llm: { translate: async (t, ctx, _target, provider) => { asked.push({ t, ctx, provider }); return `译:${t}`; } } });
  s.configure({ asr: "local" });
  s.audio(pcm(2));
  assert.equal(asrs[0].kind, "local");
  asrs[0].offset = 2;
  asrs[0].emit("message", { type: "partial", text: "The second" });
  asrs[0].emit("message", { type: "final", source: "local", text: "The second law.", conf: 0.75, start: 1 });
  asrs[0].emit("message", { type: "final", source: "local", text: "Entropy never decreases.", conf: 0.7, start: 4 });
  await s.idle();
  assert.deepEqual(sent.find((m) => m.type === "partial"), { type: "partial", text: "The second" });
  assert.deepEqual(sent.filter((m) => m.type === "line").map((m) => [m.text, m.t]), [["The second law.", 3], ["Entropy never decreases.", 6]]);
  assert.deepEqual(asked.find((a) => a.t === "Entropy never decreases.").ctx, ["The second law."]);
});

test("本地实时：把握低的句子（旁边有人说中文）不出字幕", async () => {
  const { s, sent, asrs } = setup();
  s.configure({ asr: "local" });
  s.audio(pcm(1));
  asrs[0].emit("message", { type: "final", source: "local", text: "Tong Yeminghau, Zing yang womanianli.", conf: 0.3, start: 0 });
  await s.idle();
  assert.equal(sent.filter((m) => m.type === "line").length, 0);
});

test("本地实时只支持英语：说话人语言选了别的，只提示一次，不启动识别", () => {
  const { s, sent, asrs } = setup();
  s.configure({ asr: "local", speaker: "zh" });
  s.audio(pcm(1)); s.audio(pcm(1));
  assert.equal(asrs.length, 0);
  assert.equal(errors(sent).length, 1);
  assert.match(errors(sent)[0], /只支持英语/);
});

test("本地实时线程出错：自动重启一次，再出错就停止并提示一次", () => {
  const { s, sent, asrs } = setup();
  s.configure({ asr: "local" });
  s.audio(pcm(1)); asrs[0].emit("exit", 1);
  s.audio(pcm(1));
  assert.equal(asrs.length, 2);
  asrs[1].emit("exit", 1);
  s.audio(pcm(1)); s.audio(pcm(1));
  assert.equal(asrs.length, 2);
  assert.equal(errors(sent).filter((m) => m.includes("连续出错")).length, 1);
});

test("一种识别方式出错停掉后，换另一种还能用", () => {
  const { s, asrs } = setup();
  s.configure({ asr: "local" });
  s.audio(pcm(1)); asrs[0].emit("exit", 1);
  s.audio(pcm(1)); asrs[1].emit("exit", 1);
  s.configure({ asr: "cloud" });
  s.audio(pcm(1));
  assert.equal(asrs[2].kind, "cloud");
});
