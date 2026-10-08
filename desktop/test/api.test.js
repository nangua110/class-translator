import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApi } from "../src/main/api.js";
import { Records } from "../src/main/store/records.js";
import { Settings } from "../src/main/store/settings.js";
import { AudioRecorder } from "../src/main/store/audio.js";

const fakeCrypto = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from("E" + s), decryptString: (b) => b.toString().slice(1) };
const NAME = "2026-10-07_09-00-00.md";
const KEY = "AIzaGoodKey1234567890";

function setup({ testKey = async () => "ok", report } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-api-"));
  const records = new Records(path.join(dir, "records"));
  const settings = new Settings(path.join(dir, "settings.json"), fakeCrypto);
  let configured = 0;
  const llm = {
    available: () => (settings.getKey("gemini") ? ["gemini"] : []),
    configure: () => { configured += 1; },
    testKey,
    report: report ?? (async () => ({ outline: { title: "熱力學", overview: "概述", chapters: [] }, body: "## AI 精讲\n這是正文" })),
  };
  const calls = [];
  const api = createApi({
    settings, llm, records, version: "0.1.0",
    appleTr: { status: async () => "installed" },
    caps: { appleAsr: true, appleTranslate: true, systemAudio: true },
    openExternal: (u) => calls.push(["open", u]), openPath: (p) => calls.push(["path", p]),
    checkUpdate: async () => "9.9.9",
    askMic: async () => true, savePdf: async (html, name) => ({ ok: true, file: `/tmp/${name}.pdf` }),
  });
  return { api, records, settings, calls, configured: () => configured };
}
const lines3 = [{ t: 0, text: "a", tr: "" }, { t: 5, text: "b", tr: "" }, { t: 3909, text: "c", tr: "" }];

test("路径穿越：读 / 生成课后精讲都拒绝", async () => {
  const { api } = setup();
  assert.deepEqual(await api("/api/report?record=../../.env", "GET"), { ok: false });
  assert.deepEqual(await api("/api/report", "POST", { record: "../../.env" }), { ok: false, msg: "找不到这节课的记录" });
  assert.deepEqual(await api("/api/report", "POST", { record: NAME }), { ok: false, msg: "找不到这节课的记录" });
});

test("生成课后精讲：转简体、保存、可再读回", async () => {
  const { api, records, settings } = setup();
  settings.setKey("gemini", KEY);
  records.save(NAME, "", lines3);
  const r = await api("/api/report", "POST", { record: NAME, target: "zh", translator: "gemini" });
  assert.equal(r.ok, true);
  assert.equal(r.title, "热力学"); // 标题也要转简体
  assert.match(r.md, /^# 热力学/);
  assert.match(r.md, /这是正文/);
  assert.match(r.md, /时长 1h 5m 9s/);
  assert.equal((await api(`/api/report?record=${NAME}`, "GET")).md, r.md);
});

test("没填 key 时生成精讲给出提示", async () => {
  const { api, records } = setup();
  records.save(NAME, "", lines3);
  assert.match((await api("/api/report", "POST", { record: NAME })).msg, /需要先在「AI 模型与 API」里填好/);
});

test("设置：返回的数据里没有完整 key", async () => {
  const { api, settings } = setup();
  settings.setKey("gemini", KEY);
  const st = await api("/api/settings?src=en&tgt=zh", "GET");
  assert.deepEqual(st.gemini, { set: true, tail: "7890" });
  assert.equal(JSON.stringify(st).includes(KEY), false);
  assert.equal(st.apple, "installed");
});

test("保存 key：格式不对拒绝；key 无效则恢复原样；额度用完照样保存", async () => {
  const bad = setup();
  assert.match((await bad.api("/api/settings", "POST", { gemini_key: "有 空格" })).msg, /格式不对/);

  const invalid = setup({ testKey: async () => { throw Object.assign(new Error("API key not valid"), { status: 400 }); } });
  const r1 = await invalid.api("/api/settings", "POST", { gemini_key: KEY });
  assert.equal(r1.ok, false);
  assert.match(r1.msg, /不能用/);
  assert.equal(invalid.settings.getKey("gemini"), "");

  const quota = setup({ testKey: async () => { throw new Error("429 PerDay"); } });
  const r2 = await quota.api("/api/settings", "POST", { gemini_key: KEY });
  assert.equal(r2.ok, true);
  assert.match(r2.msg, /额度/);
  assert.equal(quota.settings.getKey("gemini"), KEY);
});

test("删除 key、保存模型", async () => {
  const { api, settings } = setup();
  settings.setKey("gemini", KEY);
  await api("/api/settings", "POST", { clear_gemini_key: true, gemini_model: "gemini-3.7-flash", claude_model: "不存在的模型" });
  assert.equal(settings.getKey("gemini"), "");
  assert.equal(settings.pref("geminiModel"), "gemini-3.7-flash");
  assert.equal(settings.pref("claudeModel"), undefined);
});

test("其他接口", async () => {
  const { api, settings, calls } = setup();
  assert.deepEqual((await api("/api/app-info", "GET")).privacyAccepted, false);
  await api("/api/privacy-accepted", "POST");
  assert.equal(settings.pref("privacyAccepted"), true);
  assert.deepEqual(await api("/api/mic-access", "POST"), { granted: true });
  await api("/api/open-translation-settings", "POST");
  await api("/api/open-records-folder", "POST");
  assert.equal(calls[0][0], "open");
  assert.equal(calls[1][0], "path");
  assert.deepEqual(await api("/api/pdf", "POST", { html: "<p>x</p>", name: "a/b:c" }), { ok: true, file: "/tmp/a_b_c.pdf" });
  await assert.rejects(api("/api/nope", "GET"), /未知接口/);
});

test("历史记录列表用界面认得的字段名 has_report", async () => {
  const { api, records } = setup();
  records.save(NAME, "", lines3);
  records.writeReport(NAME, "# 标题\n");
  const [item] = await api("/api/records", "GET");
  assert.equal(item.has_report, true);
  assert.equal(item.title, "标题");
});

test("点「我知道了」时先建好记录文件夹，让系统的文稿权限询问提前弹出", async () => {
  const { api, records } = setup();
  assert.equal(fs.existsSync(records.dir), false);
  await api("/api/privacy-accepted", "POST");
  assert.equal(fs.existsSync(records.dir), true);
});

test("录音设置：默认不保存、保留 7 天；能改，乱填的值不收", async () => {
  const { api, settings } = setup();
  const info = await api("/api/app-info", "GET");
  assert.equal(info.saveAudio, false);
  assert.equal(info.audioKeepDays, 7);
  assert.deepEqual(await api("/api/prefs", "POST", { saveAudio: true, audioKeepDays: 30 }), { ok: true, saveAudio: true, audioKeepDays: 30 });
  await api("/api/prefs", "POST", { audioKeepDays: 9999 });
  await api("/api/prefs", "POST", { audioKeepDays: "abc" });
  assert.equal(settings.pref("audioKeepDays"), 30);
  assert.equal((await api("/api/app-info", "GET")).saveAudio, true);
});

test("取录音片段：有录音的课能取，没有的 / 名字不合法的都拒绝；列表标出有没有录音", async () => {
  const { api, records } = setup();
  records.save(NAME, "", lines3);
  assert.equal((await api("/api/records", "GET"))[0].has_audio, false);
  fs.writeFileSync(records.audioFile(NAME), Buffer.concat([Buffer.alloc(44), Buffer.alloc(32000 * 5)]));
  assert.equal((await api("/api/records", "GET"))[0].has_audio, true);
  const r = await api(`/api/audio?record=${NAME}&t=2`, "GET");
  assert.equal(r.ok, true);
  assert.equal(r.total, 5);
  assert.equal(r.wav.length, 44 + 3 * 32000);
  assert.deepEqual(await api("/api/audio?record=../../secret.md&t=0", "GET"), { ok: false });
  assert.deepEqual(await api("/api/audio?record=2026-10-08_09-00-00.md&t=0", "GET"), { ok: false });
});

test("录音列表：时长、大小、还有几天清理；删除只删录音，正在录的不让删", async () => {
  const { api, records, settings } = setup();
  records.save(NAME, "", lines3);
  const wav = records.audioFile(NAME);
  fs.writeFileSync(wav, Buffer.concat([Buffer.alloc(44), Buffer.alloc(32000 * 5)]));
  fs.writeFileSync(path.join(records.dir, "别的歌.wav"), "x"); // 不是课堂同传的录音：不列出
  const old = Date.now() - 2.5 * 86400_000;
  fs.utimesSync(wav, old / 1000, old / 1000);
  let list = await api("/api/audios", "GET");
  assert.equal(list.length, 1);
  assert.deepEqual({ ...list[0], mtime: 0 }, { record: NAME, stem: NAME.replace(/\.md$/, ""), seconds: 5, bytes: 44 + 160000, days_left: 5, title: "", mtime: 0 });
  settings.setPref("audioKeepDays", 0);
  assert.equal((await api("/api/audios", "GET"))[0].days_left, null);

  assert.deepEqual(await api("/api/audio-delete", "POST", { record: "../../secret.md" }), { ok: false, msg: "找不到这段录音" });
  const rec = new AudioRecorder(wav);
  rec.write(Buffer.alloc(320));
  assert.deepEqual(await api("/api/audio-delete", "POST", { record: NAME }), { ok: false, msg: "这节课还在录，结束录制后才能删除录音" });
  rec.close();
  assert.deepEqual(await api("/api/audio-delete", "POST", { record: NAME }), { ok: true });
  assert.equal(fs.existsSync(wav), false);
  assert.equal(records.exists(NAME), true); // 文字记录还在
  assert.equal(fs.existsSync(path.join(records.dir, "别的歌.wav")), true);
  assert.deepEqual(await api("/api/audios", "GET"), []);
});

test("更新：检查有没有新版、打开下载页", async () => {
  const { api, calls } = setup();
  assert.deepEqual(await api("/api/update-check", "POST"), { current: "0.1.0", latest: "9.9.9" });
  await api("/api/update-page", "POST");
  assert.deepEqual(calls, [["open", "https://github.com/nangua110/class-translator/releases/latest"]]);
});

// ---------- 其他模型（OpenAI 兼容接口） ----------
const OKEY = "sk-other-1234567890";
const OTHER = { openai_preset: "custom", openai_base: "https://api.example.com/v1/", openai_model: " m1 ", openai_key: OKEY };
const saved = (s) => [s.pref("openaiPreset"), s.pref("openaiBase"), s.pref("openaiModel"), s.getKey("openai")];

test("其他模型：保存前先测试，地址去掉多余的斜杠；设置里只给 key 的末 4 位", async () => {
  const tested = [];
  const { api, settings } = setup({ testKey: async (p) => { tested.push(p); return "ok"; } });
  assert.deepEqual(await api("/api/settings", "POST", OTHER), { ok: true, msg: "", available: [] });
  assert.deepEqual(tested, ["openai"]);
  assert.deepEqual(saved(settings), ["custom", "https://api.example.com/v1", "m1", OKEY]);
  const st = await api("/api/settings?src=en&tgt=zh", "GET");
  assert.deepEqual(st.openai, { set: true, tail: "7890", preset: "custom", base: "https://api.example.com/v1", model: "m1" });
  assert.equal(st.openai_presets.deepseek.label, "DeepSeek");
  assert.equal(JSON.stringify(st).includes(OKEY), false);
  await api("/api/settings", "POST", { ...OTHER, openai_key: "" }); // 什么都没改：不再测试
  assert.equal(tested.length, 1);
});

test("其他模型：没动过这一栏就不保存也不测试", async () => {
  const tested = [];
  const { api, settings } = setup({ testKey: async (p) => { tested.push(p); } });
  assert.equal((await api("/api/settings", "POST", { gemini_model: "auto" })).ok, true);
  assert.deepEqual([tested, settings.pref("openaiBase")], [[], undefined]);
});

test("其他模型：地址、模型名、key 缺了或不对都说清楚，什么都不保存", async () => {
  const { api, settings } = setup();
  assert.match((await api("/api/settings", "POST", { ...OTHER, openai_base: "" })).msg, /接口地址/);
  assert.match((await api("/api/settings", "POST", { ...OTHER, openai_base: "http://api.example.com/v1" })).msg, /https/);
  assert.match((await api("/api/settings", "POST", { ...OTHER, openai_model: "" })).msg, /模型名/);
  assert.match((await api("/api/settings", "POST", { ...OTHER, openai_key: "" })).msg, /key/);
  assert.match((await api("/api/settings", "POST", { ...OTHER, openai_key: "有 空格" })).msg, /格式不对/);
  assert.deepEqual(saved(settings), [undefined, undefined, undefined, ""]);
});

test("其他模型：测试不通过就恢复原来的；只是限流 / 超时照样保存", async () => {
  let fail = null;
  const { api, settings } = setup({ testKey: async () => { if (fail) throw fail; } });
  await api("/api/settings", "POST", OTHER);
  fail = Object.assign(new Error("404 model not found"), { status: 404 });
  const r = await api("/api/settings", "POST", { openai_preset: "deepseek", openai_base: "https://api.example.com/v2", openai_model: "m2", openai_key: "sk-new-1234567890" });
  assert.equal(r.ok, false);
  assert.match(r.msg, /其他模型不能用：接口地址或模型名不对/);
  assert.deepEqual(saved(settings), ["custom", "https://api.example.com/v1", "m1", OKEY]);
  fail = Object.assign(new Error("429 rate limit"), { status: 429 });
  const r2 = await api("/api/settings", "POST", { openai_preset: "custom", openai_base: "https://api.example.com/v1", openai_model: "m3", openai_key: "" });
  assert.equal(r2.ok, true);
  assert.match(r2.msg, /已保存/);
  assert.equal(settings.pref("openaiModel"), "m3");
});

test("其他模型：本地模型不用 key；删除 key", async () => {
  const { api, settings } = setup();
  assert.equal((await api("/api/settings", "POST", { openai_preset: "ollama", openai_base: "http://localhost:11434/v1", openai_model: "qwen3:8b", openai_key: "" })).ok, true);
  assert.deepEqual(saved(settings), ["ollama", "http://localhost:11434/v1", "qwen3:8b", ""]);
  await api("/api/settings", "POST", OTHER);
  assert.equal((await api("/api/settings", "POST", { clear_openai_key: true })).ok, true);
  assert.equal(settings.getKey("openai"), "");
  assert.equal(settings.pref("openaiBase"), "https://api.example.com/v1");
});
