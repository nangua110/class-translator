import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { LocalASR } from "../src/main/local/asr.js";
import { acceptLocalFinal } from "../src/main/local/filter.js";

const modelDir = path.resolve("models/kroko-en");
const workerPath = path.resolve("src/main/local/worker.cjs");
const skip = (process.platform !== "darwin" || !fs.existsSync(path.join(modelDir, "encoder.onnx"))) && "需要 Mac 的 say 命令和 npm run models";

function speech(voice, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-local-"));
  execFileSync("say", ["-v", voice, "-o", path.join(dir, "a.aiff"), text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", path.join(dir, "a.aiff"), path.join(dir, "a.wav")]);
  const wav = fs.readFileSync(path.join(dir, "a.wav"));
  return wav.subarray(wav.indexOf("data") + 8);
}
async function recognize(pcm) {
  const asr = new LocalASR({ workerPath, modelDir, speaker: "en", offset: 0 });
  const msgs = [];
  asr.on("message", (m) => msgs.push(m));
  asr.start();
  for (let i = 0; i < pcm.length; i += 3200) asr.feed(pcm.subarray(i, i + 3200));
  await asr.close(60_000);
  return msgs;
}

test("英文讲课：边出草稿边按句定稿，时间递增，把握够高", { skip, timeout: 120_000 }, async () => {
  const msgs = await recognize(speech("Samantha",
    "Good morning everyone. Today we will continue our discussion of thermodynamics. The second law tells us that entropy never decreases."));
  const finals = msgs.filter((m) => m.type === "final");
  assert.ok(msgs.some((m) => m.type === "partial" && m.text), "应该有草稿");
  assert.ok(finals.length >= 2, `应按句定稿，实际 ${finals.length} 句`);
  assert.match(finals.map((f) => f.text).join(" "), /thermodynamics/i);
  assert.ok(finals.every((f, i) => i === 0 || f.start > finals[i - 1].start), "开始时间应递增");
  assert.ok(finals.every((f) => acceptLocalFinal(f, "en")), "英语句子都应通过过滤");
});

test("旁边有人说中文：定稿的句子把握很低，全部被过滤掉", { skip, timeout: 120_000 }, async () => {
  const msgs = await recognize(speech("Tingting", "同学们好，今天我们讲热力学第二定律，熵总是增加的。下课以后记得交作业。"));
  const finals = msgs.filter((m) => m.type === "final");
  assert.deepEqual(finals.filter((f) => acceptLocalFinal(f, "en")), [], JSON.stringify(finals.map((f) => [f.text, f.conf])));
});

test("模型目录不存在：提示出错并 exit 1，不会卡住", { timeout: 60_000 }, async () => {
  const asr = new LocalASR({ workerPath, modelDir: "/不存在的目录", speaker: "en", offset: 0 });
  const msgs = [];
  asr.on("message", (m) => msgs.push(m));
  const code = new Promise((r) => asr.on("exit", r));
  asr.start();
  assert.equal(await code, 1);
  assert.ok(msgs.some((m) => m.type === "error"));
});
