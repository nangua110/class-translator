import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Settings } from "../src/main/store/settings.js";

const fakeCrypto = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from("ENC:" + [...s].reverse().join("")),
  decryptString: (b) => [...b.toString().slice(4)].reverse().join(""),
});
const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ct-set-")), "settings.json");
const KEY = "AIzaTestKey1234567890";

test("粘贴时带的空格换行会去掉；文件里没有明文 key；权限 600", () => {
  const f = file();
  const s = new Settings(f, fakeCrypto());
  s.setKey("gemini", `  ${KEY}\n`);
  assert.equal(s.getKey("gemini"), KEY);
  assert.deepEqual(s.keyState("gemini"), { set: true, tail: "7890" });
  assert.equal(fs.readFileSync(f, "utf8").includes(KEY), false);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(new Settings(f, fakeCrypto()).getKey("gemini"), KEY, "重新打开还能读出来");
});

test("中间有空格或中文的 key 拒绝", () => {
  const s = new Settings(file(), fakeCrypto());
  assert.throws(() => s.setKey("gemini", "有 空格 的key"), /格式不对/);
  assert.throws(() => s.setKey("claude", "sk-ant-中文abcdefghij"), /格式不对/);
  assert.deepEqual(s.keyState("gemini"), { set: false, tail: "" });
});

test("系统加密不可用时拒绝保存，绝不存明文", () => {
  const f = file();
  const s = new Settings(f, fakeCrypto(false));
  assert.throws(() => s.setKey("gemini", KEY), /加密不可用/);
  assert.equal(fs.existsSync(f) && fs.readFileSync(f, "utf8").includes(KEY), false);
});

test("删除 key", () => {
  const s = new Settings(file(), fakeCrypto());
  s.setKey("claude", "sk-ant-abcdefghijklmnop");
  s.clearKey("claude");
  assert.equal(s.getKey("claude"), "");
});

test("偏好设置能保存读回", () => {
  const f = file();
  new Settings(f, fakeCrypto()).setPref("geminiModel", "gemini-3.7-flash");
  assert.equal(new Settings(f, fakeCrypto()).pref("geminiModel", "auto"), "gemini-3.7-flash");
  assert.equal(new Settings(f, fakeCrypto()).pref("claudeModel", "claude-opus-5-5"), "claude-opus-5-5");
});
