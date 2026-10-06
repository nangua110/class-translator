import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApi } from "../src/main/api.js";
import { Records } from "../src/main/store/records.js";
import { Settings } from "../src/main/store/settings.js";

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
