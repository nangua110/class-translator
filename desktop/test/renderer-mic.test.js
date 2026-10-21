import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const code = fs.readFileSync(new URL("../src/renderer/mic.js", import.meta.url), "utf8");
const window = {};
vm.runInNewContext(code, { window });
const { pickMic, MicWatch } = window;

const DEVS = [
  { deviceId: "default", label: "Default - AirPods (Bluetooth)" },
  { deviceId: "pods", label: "AirPods (Bluetooth)" },
  { deviceId: "mac", label: "MacBook Pro麦克风 (Built-in)" },
];

test("麦克风：没选过时优先电脑自带的，不选跟着系统跳的 Default", () => {
  assert.equal(pickMic(DEVS, null), "mac");
  assert.equal(pickMic([{ deviceId: "default", label: "Default - USB Mic" }, { deviceId: "usb", label: "USB Mic" }], null), "default");
  assert.equal(pickMic([], null), "");
});

test("麦克风：选过的一直保持，连上耳机列表刷新也不跳", () => {
  assert.equal(pickMic(DEVS, { id: "mac", label: "MacBook Pro麦克风 (Built-in)" }), "mac");
  assert.equal(pickMic(DEVS, { id: "default", label: "Default - MacBook Pro麦克风 (Built-in)" }), "default"); // 自己选了 Default 就尊重
  assert.equal(pickMic(DEVS, { id: "old-id", label: "AirPods (Bluetooth)" }), "pods"); // id 变了按名字找回来
  assert.equal(pickMic(DEVS, { id: "usb", label: "USB Mic" }), "default"); // 选的拔掉了：先用系统默认顶上
});

test("麦克风监控：全是 0 或收不到声音一段时间才报警，有底噪就算正常", () => {
  const w = new MicWatch({ zeroMs: 2500, stallMs: 2500 });
  w.reset(0);
  w.feed(new Int16Array([0, 3, -2]), 100);
  assert.equal(w.check(2000), null);
  w.feed(new Int16Array(1600), 2100);
  w.feed(new Int16Array(1600), 4000);
  assert.equal(w.check(4500), null);
  w.feed(new Int16Array(1600), 4600);
  assert.equal(w.check(4700), "silent");
  w.feed(new Int16Array([0, 1]), 4800);
  assert.equal(w.check(4900), null);
  assert.equal(w.check(7400), "stalled");
  w.reset(8000);
  assert.equal(w.check(9000), null);
});
