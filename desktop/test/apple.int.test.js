import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { helperPaths } from "../src/main/helpers.js";
import { AppleASR } from "../src/main/apple/asr.js";
import { AppleTranslator } from "../src/main/apple/translate.js";
import { SystemAudio } from "../src/main/apple/syscap.js";

const bins = helperPaths({ isPackaged: false, resourcesPath: "", devDir: path.resolve("build/bin") });
const major = Number(execFileSync("sw_vers", ["-productVersion"]).toString().split(".")[0]);
const skip = (process.platform !== "darwin" || major < 26 || !fs.existsSync(bins.asr)) && "需要 macOS 26 和 npm run helpers";

function speechPcm(text) { // 用系统语音合成一段英文，转成 16kHz 单声道 int16
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-say-"));
  execFileSync("say", ["-v", "Samantha", "-o", path.join(dir, "a.aiff"), text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", path.join(dir, "a.aiff"), path.join(dir, "a.wav")]);
  const wav = fs.readFileSync(path.join(dir, "a.wav"));
  return wav.subarray(wav.indexOf("data") + 8);
}

test("helperPaths：开发版和打包版路径", () => {
  assert.equal(helperPaths({ isPackaged: true, resourcesPath: "/R", devDir: "/D" }).asr, "/R/bin/apple_asr");
  assert.equal(helperPaths({ isPackaged: false, resourcesPath: "/R", devDir: "/D" }).syscap, "/D/syscap");
});

test("苹果识别：喂一段英文，收到草稿和确定句", { skip, timeout: 90_000 }, async () => {
  const asr = new AppleASR(bins.asr, "en", 0);
  const msgs = [];
  asr.on("message", (m) => msgs.push(m));
  asr.start();
  const pcm = speechPcm("Today we are going to talk about the second law of thermodynamics.");
  for (let i = 0; i < pcm.length; i += 3200) asr.feed(pcm.subarray(i, i + 3200));
  asr.feed(Buffer.alloc(32000 * 2));
  await asr.close(60_000);
  assert.ok(msgs.some((m) => m.type === "partial"), "应该有草稿");
  const final = msgs.filter((m) => m.type === "final").map((m) => m.text).join(" ");
  assert.match(final, /thermodynamics/i);
  assert.ok(msgs.find((m) => m.type === "final").conf > 0.5);
});

test("苹果识别：被 kill 时 exit 为 -1", { skip, timeout: 30_000 }, async () => {
  const asr = new AppleASR(bins.asr, "en", 0);
  const exited = new Promise((r) => asr.on("exit", r));
  asr.start();
  asr.kill();
  assert.equal(await exited, -1);
});

test("苹果识别被系统信号意外结束（真崩溃）不能当成我们自己关的", { skip, timeout: 30_000 }, async () => {
  const asr = new AppleASR(bins.asr, "en", 0);
  const exited = new Promise((r) => asr.on("exit", r));
  asr.start();
  await new Promise((r) => setTimeout(r, 300));
  process.kill(asr.p.proc.pid, "SIGSEGV");
  assert.notEqual(await exited, -1);
  assert.notEqual(await exited, 0);
});

test("苹果翻译：状态查询；不支持的语言直接返回 unsupported", { skip, timeout: 30_000 }, async () => {
  const tr = new AppleTranslator(bins.translate);
  assert.ok(["installed", "supported"].includes(await tr.status("en", "zh")));
  assert.deepEqual(await tr.translate("hi", "xx", "zh"), { tr: "", code: "unsupported" });
  const r = await tr.translate("Here is a copy of the drawing.", "en", "zh");
  assert.ok(r.tr || r.code === "not_installed", JSON.stringify(r));
  tr.stop();
});

test("系统声音：能启动并在 stop 后退出", { skip, timeout: 30_000 }, async () => {
  const sys = new SystemAudio(bins.syscap);
  let bytes = 0;
  sys.on("data", (b) => { bytes += b.length; });
  sys.start();
  await new Promise((r) => setTimeout(r, 1500));
  sys.stop();
  assert.ok(bytes > 0, "没在放声音时也应收到补齐的静音");
});
