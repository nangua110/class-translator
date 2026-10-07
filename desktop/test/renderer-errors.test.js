import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const code = fs.readFileSync(new URL("../src/renderer/errors.js", import.meta.url), "utf8");
const window = {};
vm.runInNewContext(code, { window });
const err = (name, message = "Could not start audio source") => Object.assign(new Error(message), { name });

test("开始录制失败：中文说明，按系统给出设置路径，没有「服务是否在运行」", () => {
  const win = window.startErrorText(err("NotAllowedError"), "win32", "mic");
  assert.match(win, /设置 → 隐私和安全性 → 麦克风/);
  assert.match(window.startErrorText(err("NotAllowedError"), "darwin", "mic"), /系统设置 → 隐私与安全 → 麦克风/);
  assert.match(window.startErrorText(err("NotReadableError"), "win32", "mic"), /被别的程序占用/);
  assert.match(window.startErrorText(err("NotFoundError"), "win32", "mic"), /没有找到麦克风/);
  assert.match(window.startErrorText(err("NotAllowedError"), "win32", "loopback"), /电脑内部声音/);
  for (const t of [win, window.startErrorText(err("Weird", "boom"), "darwin", "mic")]) {
    assert.doesNotMatch(t, /服务是否在运行|Could not start/);
  }
});
