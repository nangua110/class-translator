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
    updater: { check: async () => ({ state: "available", latest: "9.9.9" }), status: () => ({ state: "downloading", percent: 40 }), downloadAndInstall: () => calls.push(["install"]) },
    quit: () => calls.push(["quit"]),
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
  assert.match((await api("/api/report", "POST", { record: NAME })).msg, /需要先在「AI 模型与 API」里填写/);
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

test("更新：检查、看进度、开始下载、打开下载页、退出", async () => {
  const { api, calls } = setup();
  assert.deepEqual(await api("/api/update-check", "POST"), { state: "available", latest: "9.9.9" });
  assert.deepEqual(await api("/api/update", "GET"), { state: "downloading", percent: 40 });
  await api("/api/update-install", "POST");
  await api("/api/update-page", "POST");
  await api("/api/quit", "POST");
  assert.deepEqual(calls, [["install"], ["open", "https://github.com/nangua110/class-translator/releases/latest"], ["quit"]]);
});
