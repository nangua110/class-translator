import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilities } from "../src/main/platform.js";

const bins = { asr: "a", translate: "t", syscap: "s" };
const caps = (platform, version, has = () => true) => capabilities({ platform, version, has, bins });

test("新 Mac：全部可用，系统声音走 syscap", () => {
  assert.deepEqual(caps("darwin", "26.0.1"), { platform: "darwin", version: "26.0.1", appleAsr: true, appleTranslate: true, systemAudio: true, cloudAsr: true, loopback: false });
});
test("macOS 15：没有苹果识别，但有云端识别和系统声音", () => {
  const c = caps("darwin", "15.4");
  assert.equal(c.appleAsr, false);
  assert.equal(c.cloudAsr, true);
  assert.equal(c.systemAudio, true);
});
test("macOS 14.1 录不了系统声音；子程序缺失也算不可用", () => {
  assert.equal(caps("darwin", "14.1").systemAudio, false);
  assert.equal(caps("darwin", "26.0", () => false).appleAsr, false);
});
test("Windows：云端识别 + 系统回环录音", () => {
  assert.deepEqual(caps("win32", "10.0.26100"), { platform: "win32", version: "10.0.26100", appleAsr: false, appleTranslate: false, systemAudio: true, cloudAsr: true, loopback: true });
});
