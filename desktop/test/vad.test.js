import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { VoiceDetector } from "../src/main/cloud/vad.js";

const MODEL = path.resolve("assets/silero_vad.onnx");
const SR = 16000;
const rnd = (n, a) => Float32Array.from({ length: n }, () => (Math.random() * 2 - 1) * a);

function speech(text) { // 用系统语音合成一段英文（只在 Mac 上有）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-vad-"));
  execFileSync("say", ["-v", "Samantha", "-o", path.join(dir, "a.aiff"), text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", path.join(dir, "a.aiff"), path.join(dir, "a.wav")]);
  const wav = fs.readFileSync(path.join(dir, "a.wav"));
  const pcm = wav.subarray(wav.indexOf("data") + 8);
  return Float32Array.from({ length: pcm.length >> 1 }, (_, i) => pcm.readInt16LE(i * 2) / 32768);
}

test("静音、白噪音、敲桌子都不算人声", async () => {
  const vad = await VoiceDetector.load(MODEL);
  const clicks = new Float32Array(3 * SR);
  for (let i = 0; i < clicks.length; i += SR / 2) clicks.set(rnd(200, 0.8), i);
  assert.equal(await vad.hasVoice(new Float32Array(2 * SR)), false);
  assert.equal(await vad.hasVoice(rnd(4 * SR, 0.05)), false);
  assert.equal(await vad.hasVoice(clicks), false);
});

test("英文讲话算人声，而且状态不跨段（先测杂音再测讲话也对）", { skip: process.platform !== "darwin" && "需要 Mac 的 say 命令" }, async () => {
  const vad = await VoiceDetector.load(MODEL);
  const s = speech("Today we are going to talk about the second law of thermodynamics.");
  await vad.voicedSeconds(rnd(SR, 0.05));
  const sec = await vad.voicedSeconds(s);
  assert.ok(sec > 1.5, `人声秒数 ${sec}`);
  assert.equal(await vad.hasVoice(s), true);
});

test("同时调用会排队，结果互不干扰", async () => {
  const vad = await VoiceDetector.load(MODEL);
  const results = await Promise.all([vad.voicedSeconds(new Float32Array(SR)), vad.voicedSeconds(new Float32Array(SR))]);
  assert.deepEqual(results, [0, 0]);
});
