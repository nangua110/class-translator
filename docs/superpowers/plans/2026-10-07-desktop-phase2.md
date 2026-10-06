# 课堂同传桌面版 第 2 期 开发计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让旧 Mac（低于 macOS 26）和 Windows 也能用课堂同传：加入「云端（Gemini）」识别，Windows 能录电脑内部声音，打出 Windows 安装包，并在 Parallels 的 Windows 11 虚拟机里验证。

**Architecture:** 新增 `src/main/cloud/` 一组纯模块：断句（按音量切句，移植网页版）→ 人声检测（Silero v6 模型，用 WebAssembly 版 onnxruntime 推理，不需要原生模块，Mac 上就能打 Windows 包）→ Gemini 音频识别（一次拿回转写、语言、译文）。它们组合成 `CloudASR`，对外和 `AppleASR` 是同一套事件接口，`Session` 只按「识别方式」选用哪一个。Windows 的电脑内部声音走 Electron 的系统回环录音（`getDisplayMedia` + `audio: "loopback"`），音频和麦克风走同一条路送到后台。

**Tech Stack:** 沿用第 1 期（Node 22、Electron、electron-builder、`@google/genai`、`@anthropic-ai/sdk`、`opencc-js`、`marked`、`node:test`），新增 `onnxruntime-web`（WebAssembly 推理）和 Silero VAD v6 模型（MIT）。

**Spec:** `docs/superpowers/specs/2026-10-07-desktop-app-design.md`（第 2 期：第 2、3.2、4、7、9 节）

## Global Constraints

- 第 1 期的全部约束继续有效（见 `docs/superpowers/plans/2026-10-07-desktop-phase1.md` 的 Global Constraints）。
- 提交信息里**不加任何 Claude 署名**（不写 Co-Authored-By）。
- README、发布说明、界面文字里**不用表情符号**（菜单路径里的「→」可以用）。
- 云端识别**只在有人声时才发请求**：每段先过人声检测，人声不足 0.3 秒的不发。
- 云端识别的断句参数与网页版一致：静音 0.5 秒切句、最长 8 秒一段、短于 0.6 秒丢弃。
- 云端识别结果同样**只保留所选说话人语言**；「自动」模式只认中文和英文。
- Gemini 额度用完时：提示一次原因，10 分钟内不再发识别请求，之后自动重试；已识别的字幕不能丢。
- 没填 Gemini key 时选云端识别：只提示一次「需要填写 Gemini key」，不崩、不反复报错。
- Windows 安装包文件名必须是英文：`ClassTranslator-<版本>-win-<x64|arm64>-setup.exe`。
- 安装包里只带 onnxruntime-web 实际用到的 4 个文件（`ort.node.min.js`、`ort.node.min.mjs`、`ort-wasm-simd-threaded.mjs`、`ort-wasm-simd-threaded.wasm`），其余约 120 MB 不打包。
- 版本号改为 `0.2.0`。
- 虚拟机（Parallels「Windows 11」）属于南瓜：启动、恢复、改设置前先问；Rosetta 安装前先问。
- 发布到 GitHub（推送、Release）前必须列出内容并得到南瓜明确同意。

## Review Focus

1. **没填 Gemini key 就选了云端识别**（Windows / 旧 Mac 第一次用最常见）：只提示一次「需要填写 Gemini key」，之后不再刷屏，也不因此崩溃；填上 key 后不用重开 App 就能识别。→ Task 4 有测试。
2. **上课中途 Gemini 额度用完**：提示一次并说明会自动重试，10 分钟内不再发请求浪费时间，已有字幕保留；10 分钟后自动恢复。→ Task 4 有测试。
3. **老师连续讲很久不停顿**：每 8 秒强制切一段，内容不能丢；点「结束录制」时最后半句也要送去识别。→ Task 2、Task 4 有测试。
4. **云端模式下旁边有人说别的语言**：选了英语就丢掉中文；「自动」模式中英文都留；模型返回奇怪的语言代码时按文字特征归到中文或英语。→ Task 4 有测试。
5. **Windows 上没有麦克风 / 没给权限**：麦克风下拉框不能是空的没提示，要显示「没有找到麦克风」并告诉怎么去设置里打开。→ Task 7 冒烟检查覆盖。

---

## 文件结构（新增 / 修改）

```
desktop/
├─ assets/
│  ├─ silero_vad.onnx            新增：人声检测模型（Silero v6，MIT）
│  └─ SILERO_LICENSE.txt         新增：模型许可证
├─ src/main/cloud/               新增目录
│  ├─ vad.js                     人声检测：VoiceDetector
│  ├─ segmenter.js               按音量断句：Segmenter
│  ├─ wav.js                     Float32 → WAV
│  ├─ filter.js                  云端识别结果过滤：acceptCloudFinal
│  └─ asr.js                     云端识别引擎：CloudASR（接口同 AppleASR）
├─ src/main/llm/prompts.js       修改：加 RECOGNIZE_SYSTEM、RECOGNIZE_SCHEMA
├─ src/main/llm/index.js         修改：加 LLM.recognize()
├─ src/main/apple/asr.js         修改：加 kind = "apple"
├─ src/main/session.js           修改：按识别方式选引擎，处理云端结果
├─ src/main/platform.js          修改：加 cloudAsr、loopback，Windows 支持系统声音
├─ src/main/main.js              修改：加载人声检测、创建云端识别、Windows 回环录音、冒烟参数
├─ src/renderer/app.js           修改：识别方式选项、自动语言、Windows 录系统声音、没麦克风提示
├─ src/renderer/index.html       修改：隐私说明按系统显示
├─ electron-builder.yml          修改：Windows 安装包、精简 onnxruntime-web、模型文件
├─ scripts/check-package.mjs     修改：同时检查 Mac 和 Windows 包，并确认必需文件在包里
└─ test/                         新增 vad / segmenter / wav / cloud-asr 测试，修改 session / platform / llm 测试
```

---

### Task 1: 人声检测（Silero + WebAssembly）

**Files:**
- Create: `desktop/assets/silero_vad.onnx`、`desktop/assets/SILERO_LICENSE.txt`、`desktop/src/main/cloud/vad.js`
- Modify: `desktop/package.json`（依赖）
- Test: `desktop/test/vad.test.js`

**Interfaces:**
- Produces: `MIN_VOICE_SEC = 0.3`；`class VoiceDetector`：`static async load(modelPath)`、`voicedSeconds(f32: Float32Array): Promise<number>`（16kHz，每次调用从头算，不跨段保留状态；多次调用自动排队）、`hasVoice(f32, minSec = MIN_VOICE_SEC): Promise<boolean>`

- [ ] **Step 1: 装依赖、放模型**

Run（在 `desktop/` 下）：
```bash
npm install onnxruntime-web
cp ../.venv/lib/python3.13/site-packages/silero_vad/data/silero_vad.onnx assets/silero_vad.onnx
cp ../.venv/lib/python3.13/site-packages/silero_vad-*.dist-info/licenses/* assets/SILERO_LICENSE.txt
head -1 assets/SILERO_LICENSE.txt && ls -la assets/silero_vad.onnx
```
Expected: 许可证第一行是 `MIT License`，模型约 2.2 MB。

- [ ] **Step 2: 写失败的测试**

`desktop/test/vad.test.js`：

```js
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
```

- [ ] **Step 3: 运行测试确认失败**

Run：`npm test`
Expected: FAIL，找不到 `src/main/cloud/vad.js`。

- [ ] **Step 4: 实现**

`desktop/src/main/cloud/vad.js`：

```js
import fs from "node:fs";
import { createRequire } from "node:module";

// WebAssembly 版推理：不需要为每种系统编译原生模块，Mac 上就能打 Windows 包
const require = createRequire(import.meta.url);
const ort = require("onnxruntime-web");
ort.env.wasm.numThreads = 1;

export const MIN_VOICE_SEC = 0.3; // 一段里真正的人声不足这么长就不送去识别（省额度）
const SR = 16000, WIN = 512, CTX = 64, THRESHOLD = 0.5;

/** Silero v6 人声检测：分辨老师说话和敲桌子、挪椅子、空调声 */
export class VoiceDetector {
  static async load(modelPath) {
    return new VoiceDetector(await ort.InferenceSession.create(fs.readFileSync(modelPath)));
  }
  constructor(session) {
    this.session = session;
    this.queue = Promise.resolve();
  }
  /** 一段 16kHz 音频里有多少秒是人声；每次从头算，多次调用排队执行 */
  voicedSeconds(f32) {
    const run = this.queue.then(() => this.#run(f32));
    this.queue = run.catch(() => {});
    return run;
  }
  async hasVoice(f32, minSec = MIN_VOICE_SEC) {
    return (await this.voicedSeconds(f32)) >= minSec;
  }
  async #run(f32) {
    let state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
    const sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(SR)]), []);
    let context = new Float32Array(CTX), voiced = 0;
    for (let i = 0; i + WIN <= f32.length; i += WIN) {
      const chunk = f32.subarray(i, i + WIN);
      const input = new Float32Array(CTX + WIN);
      input.set(context);
      input.set(chunk, CTX);
      const out = await this.session.run({ input: new ort.Tensor("float32", input, [1, CTX + WIN]), state, sr });
      state = out.stateN;
      context = chunk.slice(-CTX);
      if (out.output.data[0] > THRESHOLD) voiced += WIN;
    }
    return voiced / SR;
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run：`npm test`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add desktop/package.json desktop/package-lock.json desktop/assets/silero_vad.onnx desktop/assets/SILERO_LICENSE.txt desktop/src/main/cloud/vad.js desktop/test/vad.test.js
git commit -m "桌面版：人声检测（Silero v6，WebAssembly 推理）"
```

---

### Task 2: 断句与 WAV

**Files:**
- Create: `desktop/src/main/cloud/segmenter.js`、`desktop/src/main/cloud/wav.js`
- Test: `desktop/test/segmenter.test.js`

**Interfaces:**
- Produces:
  - `class Segmenter`：`feed(pcm: Buffer /* 16kHz int16，可能在半个样本处断开 */): {audio: Float32Array, start: number /* 秒，从第一次 feed 算起 */}[]`、`flush(): 同上`
  - `toWav(f32: Float32Array): Buffer`（16kHz 单声道 16 位）

- [ ] **Step 1: 写失败的测试**

`desktop/test/segmenter.test.js`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { Segmenter } from "../src/main/cloud/segmenter.js";
import { toWav } from "../src/main/cloud/wav.js";

const SR = 16000;
const tone = (sec) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR));
const quiet = (sec) => new Float32Array(Math.round(sec * SR));
function pcm(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = Buffer.alloc(total * 2);
  let o = 0;
  for (const p of parts) for (const v of p) { buf.writeInt16LE(Math.round(v * 32767), o); o += 2; }
  return buf;
}
const near = (a, b, tol = 0.1) => assert.ok(Math.abs(a - b) <= tol, `${a} 应接近 ${b}`);

test("两句话中间停顿 1 秒：切成两段，开始时间正确", () => {
  const s = new Segmenter();
  const segs = s.feed(pcm(tone(1), quiet(1), tone(2), quiet(1)));
  assert.equal(segs.length, 2);
  near(segs[0].start, 0);
  near(segs[1].start, 2);
  near(segs[1].audio.length / SR, 2.5, 0.15); // 2 秒话 + 0.5 秒判定静音
});

test("连续讲 20 秒不停：每段最长 8 秒，内容不丢", () => {
  const s = new Segmenter();
  const segs = [...s.feed(pcm(tone(20))), ...s.flush()];
  assert.ok(segs.every((g) => g.audio.length / SR <= 8.01));
  near(segs.reduce((n, g) => n + g.audio.length, 0) / SR, 20, 0.1);
});

test("很短的声音（0.05 秒，比如敲一下）丢掉：连同句尾静音也不到 0.6 秒", () => {
  assert.deepEqual(new Segmenter().feed(pcm(tone(0.05), quiet(1))), []);
});

test("结束时把没说完的半句交出来", () => {
  const s = new Segmenter();
  assert.deepEqual(s.feed(pcm(tone(1.5))), []);
  const [last] = s.flush();
  near(last.audio.length / SR, 1.5, 0.05);
  assert.deepEqual(s.flush(), []);
});

test("数据在半个样本处断开也能正确拼接", () => {
  const whole = pcm(tone(1), quiet(1));
  const a = new Segmenter().feed(whole);
  const s = new Segmenter();
  const b = [...s.feed(whole.subarray(0, 12345)), ...s.feed(whole.subarray(12345))];
  assert.equal(b.length, a.length);
  assert.equal(b[0].audio.length, a[0].audio.length);
});

test("toWav：44 字节文件头 + 16 位数据", () => {
  const wav = toWav(Float32Array.from([0, 0.5, -1]));
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.length, 44 + 6);
  assert.deepEqual([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)], [0, 16384, -32767]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run：`npm test`
Expected: FAIL，找不到 `segmenter.js`。

- [ ] **Step 3: 实现**

`desktop/src/main/cloud/segmenter.js`：

```js
// 按音量断句（移植自网页版 server.py）：静音超过 0.5 秒或一段超过 8 秒就切，短于 0.6 秒的丢掉
const SR = 16000, FRAME = 480; // 30ms
const SILENCE_SEC = 0.5, MAX_SEG_SEC = 8, MIN_SEG_SEC = 0.6;

export class Segmenter {
  constructor() {
    this.noiseFloor = 0.003;
    this.frames = [];
    this.pending = new Float32Array(0);
    this.carry = null;      // 上一块末尾多出来的半个样本
    this.speech = false;
    this.silenceFrames = 0;
    this.samples = 0;       // 已处理的样本数，用来算开始时间
    this.segStart = 0;
  }

  #toFloat(pcm) {
    let buf = this.carry ? Buffer.concat([this.carry, pcm]) : pcm;
    this.carry = buf.length % 2 ? buf.subarray(buf.length - 1) : null;
    const n = buf.length >> 1;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
    return out;
  }

  #take() {
    const len = this.frames.length * FRAME;
    const seg = len / SR >= MIN_SEG_SEC ? { audio: concat(this.frames, len), start: this.segStart / SR } : null;
    this.frames = [];
    this.speech = false;
    this.silenceFrames = 0;
    return seg;
  }

  feed(pcm) {
    const out = [];
    const chunk = this.#toFloat(pcm);
    const all = new Float32Array(this.pending.length + chunk.length);
    all.set(this.pending);
    all.set(chunk, this.pending.length);
    let i = 0;
    for (; i + FRAME <= all.length; i += FRAME) {
      const frame = all.slice(i, i + FRAME);
      let sum = 0;
      for (const v of frame) sum += v * v;
      const rms = Math.sqrt(sum / FRAME);
      const isVoice = rms > Math.max(this.noiseFloor * 3, 0.006);
      if (!isVoice) this.noiseFloor = 0.995 * this.noiseFloor + 0.005 * rms; // 缓慢跟踪环境噪音
      if (isVoice) {
        if (!this.speech) { this.speech = true; this.segStart = this.samples; }
        this.silenceFrames = 0;
      } else if (this.speech) this.silenceFrames += 1;
      if (this.speech) this.frames.push(frame);
      this.samples += FRAME;
      const segSec = (this.frames.length * FRAME) / SR;
      if (this.speech && ((this.silenceFrames * FRAME) / SR >= SILENCE_SEC || segSec >= MAX_SEG_SEC)) {
        const seg = this.#take();
        if (seg) out.push(seg);
      }
    }
    this.pending = all.slice(i);
    return out;
  }

  flush() {
    if (!this.frames.length) return [];
    const seg = this.#take();
    return seg ? [seg] : [];
  }
}

function concat(frames, len) {
  const out = new Float32Array(len);
  frames.forEach((f, k) => out.set(f, k * FRAME));
  return out;
}
```

`desktop/src/main/cloud/wav.js`：

```js
/** 16kHz 单声道 Float32 → WAV（发给 Gemini 用） */
export function toWav(f32, sr = 16000) {
  const buf = Buffer.alloc(44 + f32.length * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + f32.length * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);      // fmt 块长度
  buf.writeUInt16LE(1, 20);       // PCM
  buf.writeUInt16LE(1, 22);       // 单声道
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);  // 每秒字节数
  buf.writeUInt16LE(2, 32);       // 每帧字节数
  buf.writeUInt16LE(16, 34);      // 位深
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(f32.length * 2, 40);
  f32.forEach((v, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return buf;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run：`npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/cloud/segmenter.js desktop/src/main/cloud/wav.js desktop/test/segmenter.test.js
git commit -m "桌面版：云端识别用的断句与 WAV 编码"
```

---

### Task 3: Gemini 音频识别接口

**Files:**
- Modify: `desktop/src/main/llm/prompts.js`、`desktop/src/main/llm/index.js`
- Test: `desktop/test/llm.test.js`（追加）

**Interfaces:**
- Consumes: `GeminiPool.generate`、`orderModels`、`parseJson`、`NoKey`（第 1 期 Task 5）
- Produces: `RECOGNIZE_SYSTEM(speakerHint, target)`、`RECOGNIZE_SCHEMA`；`LLM.recognize(wav: Buffer, speakerLabel: string | null, targetLabel: string): Promise<{text, lang, tr}>`（6 秒超时，用 FAST_MODELS 轮换）

- [ ] **Step 1: 写失败的测试**

在 `desktop/test/llm.test.js` 末尾追加：

```js
test("云端识别：音频以 WAV 附件发送，要求按 JSON 返回转写、语言、译文", async () => {
  const g = fakeGemini(() => '{"text":" Hello there. ","lang":"en","translation":" 你好。 "}');
  const llm = new LLM(settings({ gemini: "k" }), { gemini: () => g, claude: () => ({}) });
  const wav = Buffer.from("RIFF....WAVEfmt ");
  assert.deepEqual(await llm.recognize(wav, "英语", "简体中文"), { text: "Hello there.", lang: "en", tr: "你好。" });
  const req = g.calls[0];
  const [audio, prompt] = req.contents[0].parts;
  assert.equal(audio.inlineData.mimeType, "audio/wav");
  assert.equal(Buffer.from(audio.inlineData.data, "base64").toString(), wav.toString());
  assert.equal(prompt.text, "请处理这段录音。");
  assert.equal(req.config.responseMimeType, "application/json");
  assert.deepEqual(req.config.responseJsonSchema.required, ["text", "lang", "translation"]);
  assert.match(req.config.systemInstruction, /说话人主要讲英语/);
  assert.match(req.config.systemInstruction, /绝不要猜或编造句子/);
});

test("云端识别：自动模式不加说话人提示；没 key 抛 NoKey", async () => {
  const g = fakeGemini(() => '{"text":"","lang":"other","translation":""}');
  const llm = new LLM(settings({ gemini: "k" }), { gemini: () => g, claude: () => ({}) });
  await llm.recognize(Buffer.from("x"), null, "简体中文");
  assert.doesNotMatch(g.calls[0].config.systemInstruction, /说话人主要讲/);
  const none = new LLM(settings(), { gemini: () => fakeGemini(), claude: () => ({}) });
  await assert.rejects(none.recognize(Buffer.from("x"), null, "简体中文"), NoKey);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run：`npm test`
Expected: FAIL，`llm.recognize is not a function`。

- [ ] **Step 3: 实现**

在 `desktop/src/main/llm/prompts.js` 末尾追加（原样移植自网页版 `llm.py` 的 `RECOGNIZE_SYSTEM`）：

```js
export const RECOGNIZE_SYSTEM = (speakerHint, target) =>
  "你是课堂同声传译。听这段课堂录音：\n" +
  "1. text：逐字转写原话，保持原语言（中文用简体），不要翻译、不要总结；" +
  `如果没有清晰的人声（只有噪音、静音、音乐、听不清的嘀咕），text 返回空字符串；听不清时宁可留空，绝不要猜或编造句子。${speakerHint}\n` +
  "2. lang：原话的语言。\n" +
  `3. translation：把 text 翻译成自然、准确的${target}；如果原话本来就是${target}或 text 为空，返回空字符串。` +
  "专业术语可在译文后括号保留原词。";

export const RECOGNIZE_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    lang: { type: "string", enum: ["en", "zh", "ja", "ko", "fr", "de", "es", "other"] },
    translation: { type: "string" },
  },
  required: ["text", "lang", "translation"],
};
```

在 `desktop/src/main/llm/index.js`：把 import 行
`import { TRANSLATE_SYSTEM, SUMMARY_SYSTEM, REPORT_OUTLINE_SYSTEM, REPORT_BODY_SYSTEM } from "./prompts.js";`
改为
`import { TRANSLATE_SYSTEM, SUMMARY_SYSTEM, REPORT_OUTLINE_SYSTEM, REPORT_BODY_SYSTEM, RECOGNIZE_SYSTEM, RECOGNIZE_SCHEMA } from "./prompts.js";`
并在 `translate(` 方法之前插入：

```js
  /** 云端识别（只有 Gemini 能听音频）：一次拿回转写、语言、译文。speakerLabel 为 null 表示自动 */
  async recognize(wav, speakerLabel, targetLabel) {
    if (!this.gemini) throw new NoKey("还没填写 Gemini 的 API key（云端识别要用它）");
    const hint = speakerLabel
      ? `说话人主要讲${speakerLabel}，但旁边也可能有人说别的语言：一律按实际听到的语言逐字转写，绝不能把它翻译成${speakerLabel}；lang 填实际听到的语言。`
      : "";
    // 不附带上文：附带的话模型偶尔会把上文照抄进转写结果
    const contents = [{ role: "user", parts: [
      { inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } },
      { text: "请处理这段录音。" },
    ] }];
    const config = { systemInstruction: RECOGNIZE_SYSTEM(hint, targetLabel), responseMimeType: "application/json", responseJsonSchema: RECOGNIZE_SCHEMA };
    const models = orderModels(FAST_MODELS, this.settings.pref("geminiModel", "auto"));
    const resp = await this.gemini.generate(models, { contents, config }, 6_000); // 正常 1~2 秒就回
    const r = parseJson(resp.text ?? "");
    return { text: String(r.text ?? "").trim(), lang: String(r.lang ?? ""), tr: String(r.translation ?? "").trim() };
  }

```

- [ ] **Step 4: 运行测试确认通过**

Run：`npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/llm/prompts.js desktop/src/main/llm/index.js desktop/test/llm.test.js
git commit -m "桌面版：Gemini 音频识别接口（转写 + 语言 + 译文一次返回）"
```

---

### Task 4: 云端识别引擎 CloudASR

**Files:**
- Create: `desktop/src/main/cloud/filter.js`、`desktop/src/main/cloud/asr.js`
- Modify: `desktop/src/main/apple/asr.js`（加 `kind`）
- Test: `desktop/test/cloud-asr.test.js`

**Interfaces:**
- Consumes: `Segmenter`、`toWav`（Task 2）；`VoiceDetector.hasVoice` 形状的对象（Task 1）；`LLM.recognize`（Task 3）；`clean`、`hasCJK`、`friendly`（第 1 期）；`AllModelsBusy`、`NoKey`；`SPEAKER_LANGS`、`TARGET_LANGS`
- Produces:
  - `acceptCloudFinal({text, lang, tr, start}, speaker): {text, lang, tr, start} | null`
  - `class CloudASR({llm, vad, speaker, offset, getTarget, now?})`（EventEmitter）：属性 `kind = "cloud"`、`speaker`、`offset`；方法 `start()`、`feed(buf)`、`close(): Promise`（交出最后半句并等处理完，然后 `exit` 0）、`kill()`（丢弃未处理的段，`exit` -1）；事件 `"message"`：`{type:"status", recognizing}`、`{type:"final", source:"cloud", text, lang, tr, start}`（start 为相对本引擎开始的秒数）、`{type:"error", msg}`；`"exit"`
  - `AppleASR` 新增属性 `kind = "apple"`
  - 常量：`QUOTA_PAUSE_MS = 600_000`

- [ ] **Step 1: 写失败的测试**

`desktop/test/cloud-asr.test.js`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudASR } from "../src/main/cloud/asr.js";
import { acceptCloudFinal } from "../src/main/cloud/filter.js";
import { AllModelsBusy, NoKey } from "../src/main/llm/errors.js";

const SR = 16000;
function pcm(sec, amp) {
  const n = Math.round(sec * SR), buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * 440 * i) / SR)), i * 2);
  return buf;
}
const sentence = () => Buffer.concat([pcm(1.2, 0.3), pcm(1, 0)]); // 一句话 + 1 秒静音
function setup({ recognize, voice = true, now } = {}) {
  const calls = [], msgs = [];
  const asr = new CloudASR({
    llm: { recognize: async (wav, sp, tg) => { calls.push([wav, sp, tg]); return recognize ? recognize(calls.length) : { text: `第${calls.length}句`, lang: "zh", tr: "" }; } },
    vad: { hasVoice: async () => voice },
    speaker: "en", offset: 5, getTarget: () => "zh", now,
  });
  asr.on("message", (m) => msgs.push(m));
  asr.start();
  return { asr, calls, msgs };
}
const finals = (msgs) => msgs.filter((m) => m.type === "final");
const errors = (msgs) => msgs.filter((m) => m.type === "error").map((m) => m.msg);

test("有人声的一句：发 WAV 去识别，带上说话人和目标语言，返回结果和开始时间", async () => {
  const { asr, calls, msgs } = setup({ recognize: () => ({ text: "Hello.", lang: "en", tr: "你好。" }) });
  asr.feed(sentence());
  await asr.close();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].toString("ascii", 0, 4), "RIFF");
  assert.deepEqual(calls[0].slice(1), ["英语", "简体中文"]);
  const [f] = finals(msgs);
  assert.deepEqual({ ...f, start: Math.round(f.start * 10) / 10 }, { type: "final", source: "cloud", text: "Hello.", lang: "en", tr: "你好。", start: 0 });
  assert.deepEqual(msgs.filter((m) => m.type === "status").map((m) => m.recognizing), [true, false]);
});

test("只有杂音（人声检测不通过）：不发请求", async () => {
  const { asr, calls } = setup({ voice: false });
  asr.feed(sentence());
  await asr.close();
  assert.equal(calls.length, 0);
});

test("老师一直讲没停顿：结束录制时最后半句也送去识别", async () => {
  const { asr, calls } = setup();
  asr.feed(pcm(3, 0.3));
  assert.equal(calls.length, 0);
  await asr.close();
  assert.equal(calls.length, 1);
});

test("额度用完：只提示一次，10 分钟内不再请求，之后自动恢复", async () => {
  let t = 0;
  const { asr, calls, msgs } = setup({ now: () => t, recognize: (n) => { if (n === 1) throw new AllModelsBusy("x"); return { text: "Back.", lang: "en", tr: "" }; } });
  asr.feed(sentence());
  asr.feed(sentence());
  await asr.idle();
  assert.equal(calls.length, 1);
  assert.equal(errors(msgs).length, 1);
  assert.match(errors(msgs)[0], /额度用完.*10 分钟/);
  t = 600_001;
  asr.feed(sentence());
  await asr.close();
  assert.equal(calls.length, 2);
  assert.equal(finals(msgs).length, 1);
});

test("没填 key：只提示一次，填上之后不用重开就能识别", async () => {
  const { asr, calls, msgs } = setup({ recognize: (n) => { if (n <= 2) throw new NoKey("还没填写 Gemini 的 API key"); return { text: "Ok.", lang: "en", tr: "" }; } });
  asr.feed(sentence()); asr.feed(sentence()); asr.feed(sentence());
  await asr.close();
  assert.equal(errors(msgs).length, 1);
  assert.match(errors(msgs)[0], /Gemini 的 API key/);
  assert.equal(finals(msgs).length, 1);
});

test("kill：丢掉还没处理的段，exit -1；close 后 exit 0", async () => {
  const a = setup();
  const code = new Promise((r) => a.asr.on("exit", r));
  a.asr.feed(sentence());
  a.asr.kill();
  assert.equal(await code, -1);
  await a.asr.idle();
  assert.equal(a.calls.length, 0);
  const b = setup();
  const code2 = new Promise((r) => b.asr.on("exit", r));
  await b.asr.close();
  assert.equal(await code2, 0);
});

test("acceptCloudFinal：只留所选语言；自动模式中英都留；奇怪的语言代码按文字归类", () => {
  assert.equal(acceptCloudFinal({ text: "同学们好", lang: "zh", tr: "", start: 1 }, "en"), null);
  assert.deepEqual(acceptCloudFinal({ text: "Hi there ", lang: "en", tr: "你好", start: 1 }, "en"), { text: "Hi there", lang: "en", tr: "你好", start: 1 });
  assert.equal(acceptCloudFinal({ text: "同学们好", lang: "zh", tr: "", start: 0 }, "auto").lang, "zh");
  assert.equal(acceptCloudFinal({ text: "同學們好", lang: "other", tr: "", start: 0 }, "auto").text, "同学们好");
  assert.equal(acceptCloudFinal({ text: "Hello", lang: "other", tr: "", start: 0 }, "auto").lang, "en");
  assert.equal(acceptCloudFinal({ text: "Thank you.", lang: "en", tr: "", start: 0 }, "en"), null, "常见胡编句丢掉");
  assert.equal(acceptCloudFinal({ text: "", lang: "en", tr: "", start: 0 }, "en"), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run：`npm test`
Expected: FAIL，找不到 `cloud/asr.js`。

- [ ] **Step 3: 实现**

`desktop/src/main/cloud/filter.js`：

```js
import { clean, hasCJK } from "../text.js";

/** 云端识别结果：清理、只留所选说话人语言；自动模式只认中英文 */
export function acceptCloudFinal(m, speaker) {
  let lang = m.lang;
  if (speaker === "auto" && !["en", "zh"].includes(lang)) lang = hasCJK(m.text ?? "") ? "zh" : "en";
  const text = clean(m.text ?? "", lang);
  if (!text) return null;
  if (speaker !== "auto" && lang !== speaker) return null;
  return { text, lang, tr: m.tr ?? "", start: m.start ?? 0 };
}
```

`desktop/src/main/cloud/asr.js`：

```js
import { EventEmitter } from "node:events";
import { Segmenter } from "./segmenter.js";
import { toWav } from "./wav.js";
import { friendly } from "../text.js";
import { AllModelsBusy, NoKey } from "../llm/errors.js";
import { SPEAKER_LANGS, TARGET_LANGS } from "../langs.js";

export const QUOTA_PAUSE_MS = 600_000; // 额度用完后 10 分钟内不再请求

/** 云端识别（旧 Mac、Windows 用）：按音量断句 → 人声检测 → Gemini 一次拿回转写和译文。接口和 AppleASR 一样 */
export class CloudASR extends EventEmitter {
  constructor({ llm, vad, speaker, offset, getTarget, now = Date.now }) {
    super();
    Object.assign(this, { llm, vad, speaker, offset, getTarget, now });
    this.kind = "cloud";
    this.segmenter = new Segmenter();
    this.queue = Promise.resolve();
    this.dead = false;
    this.pausedUntil = 0;
    this.noKeyNoted = false;
  }
  start() {}
  feed(buf) {
    for (const seg of this.segmenter.feed(buf)) this.#enqueue(seg);
  }
  idle() { return this.queue; }
  /** 不再送音频：最后半句也送去识别，等全部处理完 */
  async close() {
    for (const seg of this.segmenter.flush()) this.#enqueue(seg);
    await this.queue;
    this.emit("exit", 0);
  }
  kill() {
    this.dead = true;
    this.emit("exit", -1);
  }
  #enqueue(seg) {
    this.queue = this.queue.then(() => this.#process(seg)).catch(() => {});
  }
  async #process(seg) {
    if (this.dead || this.now() < this.pausedUntil) return;
    if (!(await this.vad.hasVoice(seg.audio))) return; // 只有杂音 / 静音：不发请求
    if (this.dead) return;
    this.emit("message", { type: "status", recognizing: true });
    try {
      const speakerLabel = this.speaker === "auto" ? null : SPEAKER_LANGS[this.speaker];
      const r = await this.llm.recognize(toWav(seg.audio), speakerLabel, TARGET_LANGS[this.getTarget()]);
      this.noKeyNoted = false;
      if (!this.dead) this.emit("message", { type: "final", source: "cloud", text: r.text, lang: r.lang, tr: r.tr, start: seg.start });
    } catch (e) {
      if (e instanceof NoKey) {
        if (!this.noKeyNoted) {
          this.noKeyNoted = true;
          this.emit("message", { type: "error", msg: `${e.message}：请点右上角「AI 模型与 API」填写，填好后马上生效` });
        }
      } else if (e instanceof AllModelsBusy || String(e?.message).includes("PerDay")) {
        this.pausedUntil = this.now() + QUOTA_PAUSE_MS;
        this.emit("message", { type: "error", msg: "Gemini 今天的免费额度用完了，接下来 10 分钟暂停识别，之后自动再试" });
      } else {
        this.emit("message", { type: "error", msg: `这一句云端识别失败：${friendly(e)}` });
      }
    } finally {
      this.emit("message", { type: "status", recognizing: false });
    }
  }
}
```

在 `desktop/src/main/apple/asr.js` 的构造函数里，`this.p = null;` 这一行之后加一行：

```js
    this.kind = "apple";
```

- [ ] **Step 4: 运行测试确认通过**

Run：`npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/cloud/filter.js desktop/src/main/cloud/asr.js desktop/src/main/apple/asr.js desktop/test/cloud-asr.test.js
git commit -m "桌面版：云端识别引擎（断句、人声检测、额度用完暂停、没 key 只提示一次）"
```

---

### Task 5: Session 接入两种识别方式

**Files:**
- Modify: `desktop/src/main/session.js`、`desktop/test/session.test.js`

**Interfaces:**
- Consumes: `CloudASR` 的事件（Task 4）、`acceptCloudFinal`（Task 4）、`AppleASR.kind`（Task 4）
- Produces: `makeAsr(kind: "apple" | "cloud", speaker, offset, getTarget)`（由 main 提供）；`Session` 收到 `{type:"status"}` 原样转发给窗口；`caps.cloudAsr` 为真时可用云端识别

- [ ] **Step 1: 改测试（先让测试表达新行为）**

在 `desktop/test/session.test.js`：

1. 把 `constructor(speaker, offset) { super(); Object.assign(this, { speaker, offset, fed: 0, closed: false, killed: false }); }`
   改为 `constructor(speaker, offset, kind = "apple") { super(); Object.assign(this, { speaker, offset, kind, fed: 0, closed: false, killed: false }); }`
2. 把 `makeAsr: (sp, off) => { const a = new FakeAsr(sp, off); asrs.push(a); return a; },`
   改为 `makeAsr: (kind, sp, off) => { const a = new FakeAsr(sp, off, kind); asrs.push(a); return a; },`
3. 把 `function setup({ llm = {}, appleTr = {}, caps = { appleAsr: true } } = {}) {` 改为 `function setup({ llm = {}, appleTr = {}, caps = { appleAsr: true, cloudAsr: true } } = {}) {`
4. 在文件末尾追加：

```js
test("云端识别：带译文的确定句直接出字幕，不再另外翻译；时间加上引擎的起点", async () => {
  const { s, sent, asrs } = setup();
  s.configure({ asr: "cloud" });
  s.audio(pcm(3));
  assert.equal(asrs[0].kind, "cloud");
  assert.equal(asrs[0].offset, 0);
  asrs[0].offset = 3;
  asrs[0].emit("message", { type: "status", recognizing: true });
  asrs[0].emit("message", { type: "final", source: "cloud", text: "Hello.", lang: "en", tr: "你好。", start: 1 });
  await s.idle();
  const line = sent.find((m) => m.type === "line");
  assert.equal(line.tr, "你好。");
  assert.equal(line.t, 4);
  assert.equal(sent.filter((m) => m.type === "translation").length, 0);
  assert.deepEqual(sent.find((m) => m.type === "status"), { type: "status", recognizing: true });
});

test("云端识别：别的语言丢掉；没带译文时照常后台翻译", async () => {
  const { s, sent, asrs } = setup();
  s.configure({ asr: "cloud" });
  s.audio(pcm(1));
  asrs[0].emit("message", { type: "final", source: "cloud", text: "同学们好", lang: "zh", tr: "", start: 0 });
  asrs[0].emit("message", { type: "final", source: "cloud", text: "Good morning.", lang: "en", tr: "", start: 2 });
  await s.idle();
  assert.deepEqual(sent.filter((m) => m.type === "line").map((m) => m.text), ["Good morning."]);
  assert.equal(sent.find((m) => m.type === "translation").tr, "译:Good morning.");
});

test("从苹果识别切到云端：关掉旧引擎，换新引擎", () => {
  const { s, asrs } = setup();
  s.audio(pcm(1));
  s.configure({ asr: "cloud" });
  assert.equal(asrs[0].closed, true);
  s.audio(pcm(1));
  assert.equal(asrs[1].kind, "cloud");
});

test("没有苹果识别的电脑选云端：正常工作，不提示 macOS 26", () => {
  const { s, sent, asrs } = setup({ caps: { appleAsr: false, cloudAsr: true } });
  s.configure({ asr: "cloud" });
  s.audio(pcm(1));
  assert.equal(asrs.length, 1);
  assert.equal(errors(sent).length, 0);
});
```

并把已有测试 `不支持苹果识别的电脑：只提示一次，不崩` 里的 `setup({ caps: { appleAsr: false } })` 改为 `setup({ caps: { appleAsr: false, cloudAsr: true } })`，断言 `assert.match(errors(sent)[0], /macOS 26/);` 后追加一行 `assert.match(errors(sent)[0], /云端/);`。

- [ ] **Step 2: 运行测试确认失败**

Run：`npm test`
Expected: FAIL（新测试失败：引擎种类不对、`status` 没转发等）。

- [ ] **Step 3: 实现**

在 `desktop/src/main/session.js`：

1. import 区追加：`import { acceptCloudFinal } from "./cloud/filter.js";`
2. 把 `configure` 里的
```js
    if (this.asr && (speakerChanged || (cfg.asr && cfg.asr !== "apple"))) {
```
   改为
```js
    if (this.asr && (speakerChanged || (cfg.asr && cfg.asr !== this.asr.kind))) {
```
3. 把 `audio(buf)` 整个方法替换为：

```js
  /** 这节课用哪种识别：苹果（新 Mac）或云端（Gemini）；都用不了返回 null */
  asrKind() {
    if (this.cfg.asr === "apple" && this.caps.appleAsr) return "apple";
    if (this.cfg.asr === "cloud" && this.caps.cloudAsr) return "cloud";
    return null;
  }

  audio(buf) {
    if (this.paused) return;
    const kind = this.asrKind();
    if (!kind) {
      return this.warnOnce("no-asr", "这台电脑用不了苹果自带识别（需要 macOS 26 或更新），请在「识别方式」里选「云端（Gemini）」。");
    }
    if (kind === "apple" && this.appleFailed === this.cfg.speaker) {
      return this.warnOnce("crash", "苹果识别连续出错，已停止识别。请结束录制后重新开始，或者在「识别方式」里改用「云端（Gemini）」。");
    }
    if (!this.asr) this.startAsr(kind);
    this.asr.feed(buf);
    this.samples += buf.length / 2;
  }
```

4. 把 `startAsr()` 的第一行
```js
    const asr = this.makeAsr(this.cfg.speaker, this.samples / SR);
```
   改为（方法签名也改成 `startAsr(kind)`）：
```js
    const asr = this.makeAsr(kind, this.cfg.speaker, this.samples / SR, () => this.cfg.target);
```
5. 把 `onAsr` 里的
```js
    } else if (m.type === "final") {
      this.send({ type: "partial", text: "" });
      const r = acceptFinal(m, asr.speaker);
      if (r) this.addLine(r.text, r.lang, "", asr.offset + r.start);
```
   改为
```js
    } else if (m.type === "final" && m.source === "cloud") {
      const r = acceptCloudFinal(m, asr.speaker);
      if (r) this.addLine(r.text, r.lang, r.tr, asr.offset + r.start);
    } else if (m.type === "final") {
      this.send({ type: "partial", text: "" });
      const r = acceptFinal(m, asr.speaker);
      if (r) this.addLine(r.text, r.lang, "", asr.offset + r.start);
    } else if (m.type === "status") {
      this.send({ type: "status", recognizing: !!m.recognizing });
```
6. 把 `onAsr` 里的
```js
    } else if (m.type === "error") {
      this.send({ type: "error", msg: `苹果识别出错：${String(m.msg ?? "").slice(0, 60)}` });
```
   改为
```js
    } else if (m.type === "error") {
      this.send({ type: "error", msg: asr.kind === "cloud" ? m.msg : `苹果识别出错：${String(m.msg ?? "").slice(0, 60)}` });
```

- [ ] **Step 4: 运行测试确认通过**

Run：`npm test`
Expected: 全部 PASS（含第 1 期全部旧测试）。

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/session.js desktop/test/session.test.js
git commit -m "桌面版：一节课可选苹果识别或云端识别"
```

---

### Task 6: 主进程接线、功能检测、Windows 回环录音

**Files:**
- Modify: `desktop/src/main/platform.js`、`desktop/test/platform.test.js`、`desktop/src/main/main.js`

**Interfaces:**
- Consumes: `VoiceDetector`（Task 1）、`CloudASR`（Task 4）、新的 `makeAsr` 签名（Task 5）
- Produces: `capabilities()` 返回新增 `cloudAsr: true`、`loopback: platform === "win32"`；Windows 上 `systemAudio: true`；冒烟环境变量 `CT_SMOKE_ASR=apple|cloud`

- [ ] **Step 1: 改 platform 测试**

把 `desktop/test/platform.test.js` 整个替换为：

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run：`npm test`
Expected: FAIL（缺 `cloudAsr`、`loopback`，Windows 的 `systemAudio` 为 false）。

- [ ] **Step 3: 实现 platform.js**

把 `desktop/src/main/platform.js` 整个替换为：

```js
/** 这台电脑能用哪些功能：苹果识别 / 翻译只在新 Mac；云端识别都能用；Windows 用系统回环录电脑声音 */
export function capabilities({ platform, version, has, bins }) {
  const [maj = 0, min = 0] = String(version).split(".").map(Number);
  const atLeast = (a, b) => maj > a || (maj === a && min >= b);
  const mac = platform === "darwin", win = platform === "win32";
  return {
    platform, version,
    appleAsr: mac && atLeast(26, 0) && has(bins.asr),
    appleTranslate: mac && atLeast(26, 0) && has(bins.translate),
    systemAudio: (mac && atLeast(14, 2) && has(bins.syscap)) || win,
    cloudAsr: true,
    loopback: win,
  };
}
```

Run：`npm test`
Expected: 全部 PASS。

- [ ] **Step 4: 主进程接线**

在 `desktop/src/main/main.js`：

1. import 区：把 `import { app, BrowserWindow, ipcMain, safeStorage, session, shell, systemPreferences } from "electron";` 改为
   `import { app, BrowserWindow, desktopCapturer, ipcMain, safeStorage, session, shell, systemPreferences } from "electron";`
   并追加：
```js
import { VoiceDetector } from "./cloud/vad.js";
import { CloudASR } from "./cloud/asr.js";
```
2. 在 `build()` 里 `const appleTr = new AppleTranslator(bins.translate);` 之后插入：
```js
  // 人声检测模型启动时就开始加载；云端识别第一次用到时等它加载完
  const vadReady = VoiceDetector.load(path.join(here, "../../assets/silero_vad.onnx"));
  vadReady.catch((e) => console.error("人声检测模型加载失败", e));
  const vad = { hasVoice: async (f32) => (await vadReady).hasVoice(f32) };
```
3. 把 `makeAsr: (speaker, offset) => new AppleASR(bins.asr, speaker, offset),` 改为
```js
    makeAsr: (kind, speaker, offset, getTarget) => (kind === "cloud"
      ? new CloudASR({ llm, vad, speaker, offset, getTarget })
      : new AppleASR(bins.asr, speaker, offset)),
```
4. 在 `main()` 里 `session.defaultSession.setPermissionCheckHandler(...)` 这一行之后插入：
```js
  if (process.platform === "win32") {
    // Windows 录电脑内部声音：直接给整个屏幕 + 系统回环音频，不弹选择框（视频轨道在窗口里会马上停掉）
    session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
      desktopCapturer.getSources({ types: ["screen"] })
        .then((sources) => callback({ video: sources[0], audio: "loopback" }))
        .catch(() => callback({}));
    });
  }
```
5. 在 `runSmoke` 里把 `asr: "apple",` 改为 `asr: process.env.CT_SMOKE_ASR ?? "apple",`
6. 在 `CT_SMOKE_OPEN` 的 `executeJavaScript` 状态里，把 `speakers: [...document.querySelectorAll("#speaker option")].map(o => o.value) })` 改为
   `speakers: [...document.querySelectorAll("#speaker option")].map(o => o.value), mics: [...document.querySelectorAll("#mic option")].map(o => o.textContent), privacyApple: !document.querySelector(".apple-only")?.hidden })`

- [ ] **Step 5: 冒烟测试云端识别（Mac，需要已填的 Gemini key）**

Run（在 `desktop/` 下）：
```bash
T=$(mktemp -d)
say -v Samantha -o $T/a.aiff "Good morning everyone. Today we will talk about thermodynamics."
afconvert -f WAVE -d LEI16@16000 -c 1 $T/a.aiff $T/a.wav
CT_SMOKE_WAV=$T/a.wav CT_SMOKE_ASR=cloud CT_RECORDS_DIR=$T/records npx electron . > $T/out.txt 2>&1
grep SMOKE $T/out.txt | grep -E '"line"|"error"|"done"'
```
Expected: 有 key 时打印含 `thermodynamics` 的 `line`，且 `tr` 已带中文译文；没 key 时打印一条「还没填写 Gemini 的 API key」的 `error`（只一条），最后都有 `done`。系统弹出钥匙串访问询问时，请南瓜点「允许」。若额度用完，会看到「额度用完」提示，这也算通过（说明人声检测通过、请求已发出）。

- [ ] **Step 6: Commit**

```bash
git add desktop/src/main/platform.js desktop/test/platform.test.js desktop/src/main/main.js
git commit -m "桌面版：主进程接入云端识别和人声检测，Windows 系统回环录音"
```

---

### Task 7: 界面

**Files:**
- Modify: `desktop/src/renderer/app.js`、`desktop/src/renderer/index.html`

**Interfaces:**
- Consumes: `/api/app-info` 返回的 `caps.appleAsr / appleTranslate / systemAudio / cloudAsr / loopback`（Task 6）
- Produces: 冒烟检查状态新增 `mics`、`privacyApple`（Task 6 Step 4）

- [ ] **Step 1: 记录改动前的冒烟状态（作为对照）**

Run（在 `desktop/` 下）：`CT_SMOKE_OPEN=1 npx electron . > /tmp/claude-501/p2-open.txt 2>/dev/null; grep window-loaded /tmp/claude-501/p2-open.txt`
Expected: `asr` 只有「苹果自带（最快，边说边出字）」——还没有云端选项，这就是要改的地方。

- [ ] **Step 2: 改 index.html（隐私说明按系统显示）**

把
```html
      <tr><td>苹果识别、苹果翻译</td><td>只在这台电脑上处理，不上传</td></tr>
```
改为
```html
      <tr class="apple-only"><td>苹果识别、苹果翻译</td><td>只在这台电脑上处理，不上传</td></tr>
      <tr><td>云端识别（Gemini）</td><td>有人说话的音频片段会发送给 Google</td></tr>
```
把 `<p class="hint">课堂记录和课后精讲都保存在「文稿/课堂同传」文件夹里，可以随时删除。</p>` 改为
`<p class="hint">课堂记录和课后精讲都保存在「文稿」（Windows 上叫「文档」）里的「课堂同传」文件夹，可以随时删除。</p>`

- [ ] **Step 3: 改 app.js**

1. 把 `const ASRS = { apple: "苹果自带（最快，边说边出字）", cloud: "云端（Gemini，不发热）", local: "本地（Whisper，免费）" };` 改为
```js
const ASRS = { apple: "苹果自带（最快，边说边出字）", cloud: "云端（Gemini，需要填 key）" };
const ALL_SPEAKERS = { ...SPEAKERS };
// 苹果识别要事先指定一种语言，做不到「自动（中/英）」；云端识别可以
function refreshSpeakers() {
  for (const k of Object.keys(SPEAKERS)) delete SPEAKERS[k];
  Object.assign(SPEAKERS, ALL_SPEAKERS);
  if ($("asr").value === "apple") delete SPEAKERS.auto;
  fillSelect($("speaker"), SPEAKERS, load("speaker", "en", SPEAKERS));
}
```
   注意：这几行依赖 `SPEAKERS` 已定义，放在 `const SPEAKERS = …` 之后（原 `ASRS` 就在它下一行）。
2. 把 `    source: $("mic").value === SYSTEM ? "system" : "mic",` 改为
```js
    // Mac 的电脑内部声音由后台的 syscap 录；Windows 的系统回环在窗口里录，和麦克风走同一条路
    source: $("mic").value === SYSTEM && !window.APP_INFO?.caps.loopback ? "system" : "mic",
```
3. 在 `for (const id of ["speaker", "target", "asr", "translator"])` 的 onchange 里，`sendLangs();` 之前插入一行：
```js
    if (id === "asr") refreshSpeakers();
```
4. 把 `listMics` 函数整个替换为：
```js
async function listMics() {
  await apiFetch("/api/mic-access", { method: "POST" }); // 先走系统的麦克风授权
  try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); } catch {}
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId);
  const caps = window.APP_INFO?.caps ?? {};
  $("mic").innerHTML = devs.map((d) => `<option value="${d.deviceId}">${d.label || "麦克风"}</option>`).join("")
    + (caps.systemAudio ? `<option value="${SYSTEM}">电脑内部声音（视频/电影）</option>` : "");
  if (!devs.length) {
    $("mic").insertAdjacentHTML("afterbegin", '<option value="" disabled>没有找到麦克风</option>');
    if (!caps.systemAudio) $("mic").value = "";
    toast(caps.platform === "win32"
      ? "没有找到麦克风：请到 设置 → 隐私和安全性 → 麦克风，打开「允许桌面应用访问麦克风」"
      : "没有找到麦克风：请到 系统设置 → 隐私与安全 → 麦克风，允许「课堂同传」");
  }
}
```
5. 在 `start()` 里，把
```js
  const system = $("mic").value === SYSTEM;
  if (!system)
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: $("mic").value || undefined, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
```
   改为
```js
  // Mac 的电脑内部声音由后台录（system=true）；Windows 的系统回环在这里录，和麦克风走同一条路
  const loopback = $("mic").value === SYSTEM && !!window.APP_INFO?.caps.loopback;
  const system = $("mic").value === SYSTEM && !loopback;
  if (loopback) {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    stream.getVideoTracks().forEach((t) => t.stop()); // 只要声音
    if (!stream.getAudioTracks().length) throw new Error("没有录到电脑声音");
  } else if (!system) {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: $("mic").value || undefined, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
  }
```
6. 把 `app-info` 处理里的
```js
  for (const k of Object.keys(ASRS)) delete ASRS[k];
  Object.assign(ASRS, info.caps.appleAsr
    ? { apple: "苹果自带（最快，边说边出字）" }
    : { none: "暂不支持（需要 macOS 26，下个版本加入云端识别）" });
  fillSelect($("asr"), ASRS, Object.keys(ASRS)[0]);
  if (info.caps.appleAsr) { // 苹果识别要事先指定一种语言，做不到「自动（中/英）」
    delete SPEAKERS.auto;
    fillSelect($("speaker"), SPEAKERS, load("speaker", "en", SPEAKERS));
  }
```
   改为
```js
  if (!info.caps.appleAsr) delete ASRS.apple;
  fillSelect($("asr"), ASRS, load("asr2", Object.keys(ASRS)[0], ASRS));
  refreshSpeakers();
  for (const el of document.querySelectorAll(".apple-only")) el.hidden = !(info.caps.appleAsr || info.caps.appleTranslate);
```
7. 把 `toast("已保存到「文稿/课堂同传」");` 改为 `toast("已保存到课堂记录文件夹");`；把 ``toast(`课后精讲已保存：文稿/课堂同传/${r.file}`);`` 改为 ``toast(`课后精讲已保存：${r.file}`);``

- [ ] **Step 4: 冒烟检查（Mac）**

Run（在 `desktop/` 下）：`CT_SMOKE_OPEN=1 npx electron . > /tmp/claude-501/p2-open.txt 2>/dev/null; grep -E "window-loaded|CONSOLE" /tmp/claude-501/p2-open.txt`
Expected: 没有 `CONSOLE` 报错行；`asr` 为 `["苹果自带（最快，边说边出字）","云端（Gemini，需要填 key）"]`；当前识别方式是苹果时 `speakers` 不含 `auto`；`mics` 末尾有「电脑内部声音（视频/电影）」；`privacyApple` 为 true。

- [ ] **Step 5: Commit**

```bash
git add desktop/src/renderer/app.js desktop/src/renderer/index.html
git commit -m "桌面版界面：云端识别选项、Windows 录电脑声音、没有麦克风时提示、隐私说明按系统显示"
```

---

### Task 8: 打包（Mac + Windows）

**Files:**
- Modify: `desktop/electron-builder.yml`、`desktop/scripts/check-package.mjs`、`desktop/package.json`

**Interfaces:**
- Produces: `npm run dist`（Mac dmg）、`npm run dist:win`（Windows x64 和 arm64 两个安装程序）；产物：`dist/ClassTranslator-0.2.0-arm64.dmg`、`dist/ClassTranslator-0.2.0-x64.dmg`、`dist/ClassTranslator-0.2.0-win-x64-setup.exe`、`dist/ClassTranslator-0.2.0-win-arm64-setup.exe`

- [ ] **Step 1: 征得同意后安装 Rosetta**

Windows 安装程序的制作工具（makensis）只有 Intel 版本，苹果芯片 Mac 需要 Rosetta 才能运行（上次报错 -86）。**先问南瓜**：「需要安装苹果官方的 Rosetta 转译工具，可以吗？」同意后运行：
```bash
softwareupdate --install-rosetta --agree-to-license && arch -x86_64 /usr/bin/true && echo Rosetta 可用
```
Expected: 打印「Rosetta 可用」。若南瓜不同意：Windows 只出免安装的 zip 版（把下面 `win.target` 改成 `zip`，安装程序相关检查跳过），并在 ledger 记一条 Ruling。

- [ ] **Step 2: 改打包配置**

把 `desktop/electron-builder.yml` 整个替换为：

```yaml
appId: local.nangua.classtranslator
productName: 课堂同传
copyright: Powered by 南瓜
directories:
  output: dist
files:
  - package.json
  - src/**
  - assets/silero_vad.onnx
  - assets/SILERO_LICENSE.txt
  # onnxruntime-web 只带实际用到的 4 个文件（整个包 130 多 MB）
  - "!node_modules/onnxruntime-web/dist/**"
  - node_modules/onnxruntime-web/dist/ort.node.min.js
  - node_modules/onnxruntime-web/dist/ort.node.min.mjs
  - node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs
  - node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm
asar: true
asarUnpack:
  - node_modules/onnxruntime-web/dist/**   # WebAssembly 文件放在压缩包外，按文件路径加载更可靠
mac:
  target:
    - target: dmg
      arch: [arm64, x64]
  category: public.app-category.education
  icon: assets/icon.icns     # 「天空字幕」图标（源文件 assets/icon.svg）
  identity: null            # 暂不使用开发者证书（见设计文档 9.2），打包后做 ad-hoc 签名
  minimumSystemVersion: "12.0"
  extraResources:
    - from: build/bin
      to: bin
  extendInfo:
    NSMicrophoneUsageDescription: 课堂同传需要使用麦克风来识别老师说的话。
    NSAudioCaptureUsageDescription: 课堂同传需要录制电脑播放的声音，用来给视频和网课生成字幕。
    NSSpeechRecognitionUsageDescription: 课堂同传使用苹果自带的语音识别，在这台电脑上把语音转成文字。
afterSign: scripts/adhoc-sign.cjs
dmg:
  title: 课堂同传
  # 文件名用英文：GitHub 发布页会把中文文件名去掉
  artifactName: ClassTranslator-${version}-${arch}.${ext}
win:
  target: nsis
  icon: assets/icon.png
nsis:
  oneClick: false                         # 显示安装向导，可以选安装位置
  perMachine: false                       # 装在当前用户下，不需要管理员权限
  allowToChangeInstallationDirectory: true
  shortcutName: 课堂同传
  artifactName: ClassTranslator-${version}-win-${arch}-setup.${ext}
```

在 `desktop/package.json`：把 `"version": "0.1.0"` 改为 `"version": "0.2.0"`；在 `scripts` 里 `"dist"` 一行之后加：
```json
    "dist:win": "npm run vendor && electron-builder --win --x64 && electron-builder --win --arm64 && node scripts/check-package.mjs",
```

- [ ] **Step 3: 打包检查同时覆盖 Mac、Windows，并确认必需文件在包里**

把 `desktop/scripts/check-package.mjs` 中从 `const apps = fs.readdirSync(dist)` 开始到 `if (problems.length) {` 之前的部分替换为：

```js
// 找出所有打好的 App：Mac 在 dist/mac*/课堂同传.app/Contents/Resources，Windows 在 dist/win*-unpacked/resources
const resourceDirs = fs.readdirSync(dist).flatMap((d) => {
  if (d.startsWith("mac")) return [path.join(dist, d, "课堂同传.app", "Contents", "Resources")];
  if (d.startsWith("win") && d.endsWith("unpacked")) return [path.join(dist, d, "resources")];
  return [];
}).filter((r) => fs.existsSync(path.join(r, "app.asar")));
if (!resourceDirs.length) throw new Error("dist 里没有找到打好的 App");

const MUST_HAVE = ["assets/silero_vad.onnx", "node_modules/onnxruntime-web/dist/ort.node.min.js"];
const MUST_UNPACKED = "app.asar.unpacked/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm";
for (const res of resourceDirs) {
  walk(res);
  const archive = path.join(res, "app.asar");
  const listed = asar.listPackage(archive).map((f) => f.replace(/^[\\/]/, "").replaceAll("\\", "/"));
  for (const rel of listed) {
    let buf;
    try { buf = asar.extractFile(archive, rel); } catch { continue; } // 目录
    checkFile(rel, buf);
  }
  for (const need of MUST_HAVE) if (!listed.includes(need)) problems.push(`缺少必需文件：${need}（${res}）`);
  if (!fs.existsSync(path.join(res, MUST_UNPACKED))) problems.push(`缺少人声检测运行文件：${MUST_UNPACKED}（${res}）`);
  const ortFiles = listed.filter((f) => f.startsWith("node_modules/onnxruntime-web/dist/") && f.split("/").length === 4);
  if (ortFiles.length > 4) problems.push(`onnxruntime-web 多带了文件：${ortFiles.length} 个（${res}）`);
}
```

并把最后一行 `console.log(...)` 改为：
```js
console.log(`打包检查通过：${resourceDirs.length} 个 App，未发现机密文件或 key，必需文件齐全`);
```

- [ ] **Step 4: 打 Mac 包并检查**

Run（在 `desktop/` 下）：`npm test && rm -rf dist && npm run dist`
Expected: 测试全过；生成 `ClassTranslator-0.2.0-arm64.dmg`、`ClassTranslator-0.2.0-x64.dmg`；打印「打包检查通过：2 个 App …必需文件齐全」。若报「缺少人声检测运行文件」，说明 asarUnpack 没生效，按报错修正配置后重打。

- [ ] **Step 5: 打包后的 Mac App 跑云端识别冒烟**

Run（在 `desktop/` 下）：
```bash
T=$(mktemp -d)
say -v Samantha -o $T/a.aiff "Today we are going to talk about the second law of thermodynamics."
afconvert -f WAVE -d LEI16@16000 -c 1 $T/a.aiff $T/a.wav
CT_SMOKE_WAV=$T/a.wav CT_SMOKE_ASR=cloud CT_RECORDS_DIR=$T/records "dist/mac-arm64/课堂同传.app/Contents/MacOS/课堂同传" > $T/out.txt 2>&1
grep SMOKE $T/out.txt | grep -E '"line"|"error"|"done"'; grep -i "人声检测模型加载失败" $T/out.txt || echo "人声检测模型加载正常"
codesign --verify --deep --strict "dist/mac-arm64/课堂同传.app" && echo 签名完整
```
Expected: 有 `line`（或「还没填写 Gemini 的 API key」/「额度用完」的 `error`——都说明人声检测在打包后能用、请求已发出）和 `done`；打印「人声检测模型加载正常」「签名完整」。

- [ ] **Step 6: 打 Windows 包并检查**

Run（在 `desktop/` 下）：`npm run dist:win`
Expected: 生成 `ClassTranslator-0.2.0-win-x64-setup.exe` 和 `ClassTranslator-0.2.0-win-arm64-setup.exe`；打印「打包检查通过：4 个 App …」（2 个 Mac + 2 个 Windows 解包目录）。

- [ ] **Step 7: 清理打包生成的 .app，免得出现在系统搜索里**

Run：`rm -rf dist/mac dist/mac-arm64`

- [ ] **Step 8: Commit**

```bash
git add desktop/electron-builder.yml desktop/scripts/check-package.mjs desktop/package.json desktop/package-lock.json
git commit -m "打包：Windows 安装程序、精简人声检测运行库、打包检查覆盖 Mac 和 Windows，版本 0.2.0"
```

---

### Task 9: 在 Windows 虚拟机里验证

**Files:** 无代码改动（发现问题按 systematic-debugging 修，修复要有测试并单独提交）

**Interfaces:**
- Consumes: Task 8 的 Windows 安装程序

- [ ] **Step 1: 征得同意，准备虚拟机**

先问南瓜：「要在 Parallels 的 Windows 11 虚拟机里装测试版，需要虚拟机开着；另外想打开虚拟机的麦克风共享（Parallels → 硬件 → 声音与摄像头 → 麦克风），可以吗？」同意后确认：
```bash
prlctl list -a | grep "Windows 11"
prlctl exec "Windows 11" --current-user cmd /c "echo ok"
```
Expected: 状态 running，打印 ok。

- [ ] **Step 2: 静默安装 arm64 版并做界面冒烟**

Run：
```bash
T=~/Downloads/ct-win-test; rm -rf $T; mkdir -p $T
cp ~/class-translator/desktop/dist/ClassTranslator-0.2.0-win-arm64-setup.exe $T/
cat > $T/install-and-open.ps1 <<'EOF'
$ErrorActionPreference = "Stop"
Start-Process -FilePath "Z:\Downloads\ct-win-test\ClassTranslator-0.2.0-win-arm64-setup.exe" -ArgumentList "/S" -Wait
$exe = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter "*.exe" | Where-Object { $_.Name -notmatch 'Uninstall|elevate' -and $_.DirectoryName -match '课堂同传' } | Select-Object -First 1
"exe=$($exe.FullName)" | Out-File -Encoding utf8 "Z:\Downloads\ct-win-test\where.txt"
$env:CT_SMOKE_OPEN = "1"; $env:CT_SMOKE_SHOT = "Z:\Downloads\ct-win-test\shot.png"
Start-Process -FilePath $exe.FullName -Wait -RedirectStandardOutput "Z:\Downloads\ct-win-test\out.txt" -RedirectStandardError "Z:\Downloads\ct-win-test\err.txt"
EOF
prlctl exec "Windows 11" --current-user powershell -NoProfile -ExecutionPolicy Bypass -File "Z:\\Downloads\\ct-win-test\\install-and-open.ps1"
cat $T/where.txt; grep -E "window-loaded|CONSOLE" $T/out.txt
```
Expected: 安装到 `%LOCALAPPDATA%\Programs\课堂同传`；`window-loaded` 中 `asr` 只有「云端（Gemini，需要填 key）」，`speakers` 含 `auto`，`mics` 含「电脑内部声音（视频/电影）」，`privacyApple` 为 false；没有 `CONSOLE` 报错。读取 `shot.png` 看界面是否正常。

- [ ] **Step 3: 在虚拟机里跑云端识别流水线冒烟（不需要 key 也能验证人声检测）**

Run：
```bash
T=~/Downloads/ct-win-test
say -v Samantha -o $T/a.aiff "Today we are going to talk about the second law of thermodynamics."
afconvert -f WAVE -d LEI16@16000 -c 1 $T/a.aiff $T/a.wav
cat > $T/smoke-cloud.ps1 <<'EOF'
$exe = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter "*.exe" | Where-Object { $_.Name -notmatch 'Uninstall|elevate' -and $_.DirectoryName -match '课堂同传' } | Select-Object -First 1
$env:CT_SMOKE_WAV = "Z:\Downloads\ct-win-test\a.wav"; $env:CT_SMOKE_ASR = "cloud"; $env:CT_RECORDS_DIR = "$env:TEMP\ct-smoke-records"
Start-Process -FilePath $exe.FullName -Wait -RedirectStandardOutput "Z:\Downloads\ct-win-test\cloud.txt" -RedirectStandardError "Z:\Downloads\ct-win-test\cloud-err.txt"
EOF
prlctl exec "Windows 11" --current-user powershell -NoProfile -ExecutionPolicy Bypass -File "Z:\\Downloads\\ct-win-test\\smoke-cloud.ps1"
grep SMOKE $T/cloud.txt | grep -E '"line"|"error"|"done"'; grep -c "人声检测模型加载失败" $T/cloud.txt $T/cloud-err.txt
```
Expected: 虚拟机里没填 key，所以应看到**一条**「还没填写 Gemini 的 API key」的 `error`（说明 Windows 上人声检测正常、识别请求已发出）和最后的 `done`；「人声检测模型加载失败」出现 0 次。

- [ ] **Step 4: x64 版在 ARM 版 Windows 上（转译运行）也装一遍**

先在虚拟机里卸载 arm64 版：`prlctl exec "Windows 11" --current-user powershell -NoProfile -Command "Get-ChildItem \"$env:LOCALAPPDATA\Programs\" -Recurse -Filter 'Uninstall*.exe' | Where-Object DirectoryName -match '课堂同传' | ForEach-Object { Start-Process $_.FullName -ArgumentList '/S' -Wait }"`，再把 Step 2 脚本里的 `win-arm64` 换成 `win-x64` 重跑 Step 2、Step 3。
Expected: 与 arm64 版相同。

- [ ] **Step 5: 和南瓜一起做的人工检查（需要真实声音）**

请南瓜在虚拟机里：
1. 打开课堂同传，在「AI 模型与 API」里填 Gemini key
2. 麦克风下拉框能看到麦克风（看不到就按提示去 Windows 设置里打开麦克风权限）；选麦克风，对着 Mac 说英文，能出字幕和翻译
3. 选「电脑内部声音（视频/电影）」，在虚拟机里播一段英文视频，能出字幕
4. 结束录制后能生成课后精讲、导出 PDF

把结果和截图记进 ledger；发现的问题先写复现测试再修。

- [ ] **Step 6: 清理**

Run：`rm -rf ~/Downloads/ct-win-test`，并在虚拟机里删除第 1 期试验留下的 `%LOCALAPPDATA%\ct-test`：
`prlctl exec "Windows 11" --current-user cmd /c "rmdir /s /q %LOCALAPPDATA%\ct-test"`
（测试安装的课堂同传保留，南瓜可以继续用；要卸载时在 Windows「设置 → 应用」里卸载。）

---

### Task 10: 说明文档与发布材料（发布前停下等确认）

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新 README**

1. 把 `<p align="center"><b>预览版 v0.1.0</b> · 免费 · Powered by 南瓜</p>` 改为 `<p align="center"><b>预览版 v0.2.0</b> · 免费 · Powered by 南瓜</p>`
2. 把「支持哪些电脑」表格替换为：
```markdown
| 电脑 | 语音识别 | 能不能录电脑内部声音 |
|---|---|---|
| Mac，系统 macOS 26 或更新 | 苹果自带（免费、边说边出字）或云端 Gemini | 可以 |
| Mac，系统 macOS 14.2 到 macOS 26 之前 | 云端 Gemini（需要填 key） | 可以 |
| Mac，系统更旧 | 云端 Gemini（需要填 key） | 不可以 |
| Windows 10 / 11 | 云端 Gemini（需要填 key） | 可以 |
```
3. 「下载安装」里把下载哪个文件的列表替换为：
```markdown
   - 苹果芯片的 Mac（M1、M2、M3、M4……）：下载文件名带 `arm64` 的 `.dmg`
   - Intel 芯片的 Mac：下载文件名带 `x64` 的 `.dmg`
   - 大多数 Windows 电脑：下载 `win-x64-setup.exe`
   - ARM 芯片的 Windows 电脑（比如部分 Surface、骁龙笔记本）：下载 `win-arm64-setup.exe`
```
4. 在「第一次打开被系统拦住怎么办」小节之后加一节：
```markdown
### Windows 安装时提示「Windows 已保护你的电脑」

课堂同传暂时没有微软的代码签名，第一次运行安装程序时可能会出现这个提示：

1. 点提示里的「更多信息」。
2. 点出现的「仍要运行」，然后按安装向导一路「下一步」。

装好后在开始菜单里找「课堂同传」。
```
5. 「第一次使用」第 3 条改为：
```markdown
3. **填 Gemini key**：点右上角「AI 模型与 API」，粘贴 Gemini key 后点保存。新 Mac 上可以不填（用苹果自带的识别和翻译）；旧 Mac 和 Windows 的语音识别要用它，必须填。
```
6. 「隐私」表格里加一行（放在苹果那一行后面）：`| 云端识别（Gemini） | 有人说话的音频片段会发送给 Google |`
7. 常见问题里加：
```markdown
**Windows 上麦克风列表是空的？**
到「设置 → 隐私和安全性 → 麦克风」，打开「麦克风访问权限」和「允许桌面应用访问麦克风」，然后重新打开课堂同传。
```
8. 「给开发者」里 `npm run dist` 那行后面加一行：`  npm run dist:win  # 打包 Windows 安装程序（苹果芯片 Mac 需要先装 Rosetta）`
9. 「许可证」一节改为：
```markdown
[MIT](LICENSE) · Powered by 南瓜

人声检测使用 Silero VAD 模型（MIT 许可证，见 `desktop/assets/SILERO_LICENSE.txt`）。
```

检查：`grep -nP "[\x{2600}-\x{27BF}\x{1F300}-\x{1FAFF}]" README.md || echo 无表情符号`
Expected: 打印「无表情符号」。

- [ ] **Step 2: Commit（只提交到本地）**

```bash
git add README.md
git commit -m "说明：Windows 和旧 Mac 的安装与使用，v0.2.0"
```

- [ ] **Step 3: 准备发布说明草稿，停下等南瓜确认**

草稿（不含表情符号）：

> **课堂同传 v0.2.0 预览版**
>
> 这一版开始支持 Windows 和旧版 Mac。
>
> - 新增「云端（Gemini）」识别：旧 Mac 和 Windows 填上免费的 Gemini key 就能用，只有在有人说话时才发送，省额度
> - Windows 可以录电脑内部声音，看网课、视频也能出字幕
> - 「自动（中/英）」在云端识别下可以同时识别中文和英文
>
> **下载哪个？** 苹果芯片 Mac 下载 `arm64.dmg`，Intel Mac 下载 `x64.dmg`，大多数 Windows 电脑下载 `win-x64-setup.exe`，ARM 芯片的 Windows 下载 `win-arm64-setup.exe`。
>
> 第一次打开被系统拦住，按 README 里的步骤操作一次即可。
>
> 课堂录音前，请先确认学校和老师的规定。
>
> Powered by 南瓜

列出将要推送的提交、将要上传的 4 个安装包（文件名、大小）、发布说明全文，**等南瓜明确回复同意后**再执行：
```bash
git push origin main
gh release create v0.2.0 --target main --title "课堂同传 v0.2.0 预览版" --notes-file <草稿文件> dist/ClassTranslator-0.2.0-*.dmg dist/ClassTranslator-0.2.0-win-*-setup.exe
```
发布后用 `gh release view v0.2.0` 核对附件名，并下载其中一个比对校验值。
