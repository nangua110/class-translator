# 课堂同传 v0.3.0：本地实时识别 开发计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Windows 和旧 Mac 也能「边说边出字」：新增第三种识别方式「本地实时（英语）」，在电脑上直接识别，不联网、不用 key；翻译仍按所选方式做（带上文、会纠正识别错字）。

**Architecture:** 新增 `src/main/local/`：流式识别用 sherpa-onnx 的 WebAssembly 版（Apache-2.0）加 Kroko 英语社区模型（CC-BY-SA），放在后台线程（`worker_threads`）里运行，不卡界面。线程把识别器「只增不改」的结果交给一个纯逻辑的句子切分器：遇到句号、问号、叹号就把这一句定稿，其余作为灰色草稿；每句带把握值和开始时间。主进程一侧的 `LocalASR` 对外和 `AppleASR`、`CloudASR` 是同一套事件接口，`Session` 只多一种 `kind`。模型不进 git（66 MB），用脚本下载到 `desktop/models/`，打包时作为资源文件带上。

**Tech Stack:** 沿用现有（Node 22、Electron、electron-builder、node:test），新增 `sherpa-onnx`（npm，WASM）、模型 `sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06`、GitHub 命令行 `gh`（下载模型）。

**Spec:** `docs/superpowers/specs/2026-10-07-desktop-app-design.md`；本功能的设计已在对话中确认（方案 B：本地识别直接定稿，Gemini / Claude 只负责翻译；模型打进安装包；只支持英语）。

## Global Constraints

- 第 1、2 期的全部约束继续有效（见前两份计划的 Global Constraints）：简体中文、不用表情符号、提交不带 Claude 署名、key 只走 safeStorage、不开网络端口、翻译保留「前 3 句上文 + 识别可能有错字」提示词、发布前要南瓜明确同意、动虚拟机前先问。
- 识别方式显示名：`本地实时（英语，免费，边说边出字）`，内部代号 `local`。
- 本地实时只支持说话人语言为英语；其他语言要给出明确提示，不能输出乱码字幕。
- 一句话的平均把握低于 0.5 的丢弃（旁边有人说中文、日语时把握约 0.3–0.4，英语约 0.66–0.79）。
- 识别必须在后台线程运行，模型加载和解码都不能卡住窗口。
- 模型文件不提交到 git；`desktop/models/` 加入 `.gitignore`；打包前必须存在，否则打包检查失败。
- 默认识别方式：有苹果识别的电脑仍是苹果；其他电脑是本地实时；云端识别保留为可选项。
- 版本号改为 `0.3.0`。
- 安装包里要附第三方许可说明（sherpa-onnx：Apache-2.0；Kroko 社区模型：CC-BY-SA；Silero VAD：MIT；onnxruntime-web：MIT），README 写明出处。

## Review Focus

1. **旁边有人说中文 / 日语**：本地英语模型会把它听成不通的英文，必须按把握值丢掉，不能出字幕。→ Task 2（过滤）、Task 3（真实模型集成测试）。
2. **说话人语言不是英语却选了本地实时**：界面自动换成云端识别并提示；后台也要拦一道，只提示一次，不出乱码。→ Task 4、Task 6。
3. **识别线程崩溃或模型文件缺失**：提示一次，自动重启一次，再失败就停止并提示；`close()` 不能一直等下去。→ Task 3、Task 4。
4. **老师一直讲、没有标点也没有停顿**：20 秒强制定稿一次，内容不丢；结束录制时最后半句也要定稿。→ Task 2、Task 3。
5. **电脑太慢、识别跟不上说话**：积压超过 15 秒时提示一次「建议改用云端识别」，不能无声无息地越落越远。→ Task 3。

---

## 文件结构

```
desktop/
├─ scripts/fetch-models.sh        新增：下载本地识别模型到 models/kroko-en/
├─ models/                        新增（git 忽略）：kroko-en/{encoder,decoder,joiner}.onnx、tokens.txt
├─ assets/THIRD_PARTY_NOTICES.md  新增：第三方组件与模型的许可说明
├─ src/main/local/
│  ├─ sentences.js                句子切分器（纯逻辑）
│  ├─ filter.js                   本地识别结果过滤
│  ├─ worker.cjs                  后台线程：加载模型、解码、切句
│  └─ asr.js                      LocalASR（接口同 AppleASR / CloudASR）
├─ src/main/session.js            修改：加 local 这种 kind
├─ src/main/platform.js           修改：加 localAsr
├─ src/main/main.js               修改：创建 LocalASR、冒烟参数
├─ src/renderer/app.js / index.html  修改：识别方式选项、语言联动、隐私说明
├─ electron-builder.yml、scripts/check-package.mjs、package.json  修改：打包
└─ test/local-sentences.test.js、local-asr.test.js、local-asr.int.test.js  新增
```

---

### Task 1: 模型、依赖与许可说明

**Files:**
- Create: `desktop/scripts/fetch-models.sh`、`desktop/assets/THIRD_PARTY_NOTICES.md`
- Modify: `desktop/package.json`、`.gitignore`

**Interfaces:**
- Produces: `npm run models`（下载模型，已存在则跳过）；目录 `desktop/models/kroko-en/` 含 `encoder.onnx`、`decoder.onnx`、`joiner.onnx`、`tokens.txt`

- [ ] **Step 1: 下载脚本**

`desktop/scripts/fetch-models.sh`：

```bash
#!/bin/bash
# 下载本地实时识别用的英语模型（Kroko 社区模型，CC-BY-SA）。66 MB，不进 git。
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06
OUT=models/kroko-en
if [ -f "$OUT/encoder.onnx" ] && [ -f "$OUT/tokens.txt" ]; then exit 0; fi
TMP=$(mktemp -d)
gh release download asr-models -R k2-fsa/sherpa-onnx -p "$NAME.tar.bz2" -D "$TMP"
tar xjf "$TMP/$NAME.tar.bz2" -C "$TMP"
mkdir -p "$OUT"
cp "$TMP/$NAME/encoder.onnx" "$TMP/$NAME/decoder.onnx" "$TMP/$NAME/joiner.onnx" "$TMP/$NAME/tokens.txt" "$OUT/"
rm -rf "$TMP"
echo "已下载模型到 $OUT"
```

- [ ] **Step 2: 依赖、脚本、忽略规则**

Run（在 `desktop/` 下）：
```bash
chmod +x scripts/fetch-models.sh
npm install sherpa-onnx
```
在 `desktop/package.json` 的 `scripts` 里加 `"models": "bash scripts/fetch-models.sh",`，并把
`"start": "npm run helpers && npm run vendor && electron ."` 改为 `"start": "npm run helpers && npm run vendor && npm run models && electron ."`，
`"dist": "npm run helpers && npm run vendor && electron-builder --mac …"` 的 `npm run vendor &&` 后面加 `npm run models &&`，
`"dist:win": "npm run vendor && …"` 的 `npm run vendor &&` 后面加 `npm run models &&`。
在仓库根 `.gitignore` 的「桌面版生成物」一段末尾加一行 `desktop/models/`。

Run：`npm run models && ls -la models/kroko-en | awk 'NR>1{print int($5/1048576)" MB", $NF}' && git -C .. check-ignore -q desktop/models && echo 已忽略`
Expected: 四个文件齐全（encoder.onnx 约 66 MB），打印「已忽略」。

- [ ] **Step 3: 第三方许可说明**

`desktop/assets/THIRD_PARTY_NOTICES.md`：

```markdown
# 第三方组件与模型

课堂同传本身以 MIT 许可证发布。安装包里还包含下面这些第三方组件和模型，它们各自的许可证如下。

| 名称 | 用途 | 许可证 | 来源 |
|---|---|---|---|
| sherpa-onnx | 本地实时语音识别的运行库 | Apache-2.0 | k2-fsa 项目 |
| Kroko ASR 英语社区模型（streaming zipformer，2025-08-06） | 本地实时识别用的英语模型 | CC-BY-SA | Banafo（Kroko ASR） |
| Silero VAD | 判断有没有人说话 | MIT | Silero Team（许可全文见 SILERO_LICENSE.txt） |
| onnxruntime-web | 运行 Silero VAD 模型 | MIT | Microsoft |
| Electron | 桌面应用框架 | MIT | OpenJS Foundation 及贡献者 |

Kroko 社区模型以 CC-BY-SA 协议提供：使用时需要署名；如果修改了模型本身并再分发，需要以相同协议分享。课堂同传没有修改该模型，原样随安装包分发。
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore desktop/package.json desktop/package-lock.json desktop/scripts/fetch-models.sh desktop/assets/THIRD_PARTY_NOTICES.md
git commit -m "本地实时识别：模型下载脚本、sherpa-onnx 依赖、第三方许可说明"
```

---

### Task 2: 句子切分与结果过滤（纯逻辑）

**Files:**
- Create: `desktop/src/main/local/sentences.js`、`desktop/src/main/local/filter.js`
- Test: `desktop/test/local-sentences.test.js`

**Interfaces:**
- Consumes: `clean`、`appleLangOk`（`src/main/text.js`）
- Produces:
  - `class SentenceSplitter`：`update(result, {flush = false} = {}): {finals: {text, conf, start}[], partial: string}`、`reset()`。`result` 是识别器当前这一段的结果 `{tokens: string[], timestamps: number[], ys_probs: number[], start_time: number}`，同一段内只增不改；`conf` 为这句词片把握（对数概率）平均后取指数，没有把握值时为 -1；`start` = `start_time + timestamps[这句第一个词片]`
  - `LOCAL_MIN_CONF = 0.5`；`acceptLocalFinal({text, conf, start}, speaker): {text, lang: "en", start} | null`

- [ ] **Step 1: 写失败的测试**

`desktop/test/local-sentences.test.js`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { SentenceSplitter } from "../src/main/local/sentences.js";
import { acceptLocalFinal } from "../src/main/local/filter.js";

// 把一句话拆成识别器那样的词片：单词前带空格，标点单独一片
function result(text, { start_time = 0, prob = -0.2, step = 0.3 } = {}) {
  const tokens = text.match(/ ?[A-Za-z0-9']+|[.,?!]/g) ?? [];
  return { tokens, timestamps: tokens.map((_, i) => +(i * step).toFixed(2)), ys_probs: tokens.map(() => prob), start_time };
}
const grow = (s, text, opts) => s.update(result(text, opts));

test("句号后面出现下一句的词，上一句才定稿；其余是草稿", () => {
  const s = new SentenceSplitter();
  assert.deepEqual(grow(s, " Good morning"), { finals: [], partial: "Good morning" });
  assert.deepEqual(grow(s, " Good morning."), { finals: [], partial: "Good morning." });
  const r = grow(s, " Good morning. Today we");
  assert.deepEqual(r.finals.map((f) => f.text), ["Good morning."]);
  assert.equal(r.partial, "Today we");
});

test("同一句不会定稿两次；开始时间和把握值正确", () => {
  const s = new SentenceSplitter();
  grow(s, " One. Two", { start_time: 10 });
  const r = grow(s, " One. Two. Three", { start_time: 10 });
  assert.deepEqual(r.finals.map((f) => f.text), ["Two."]);
  assert.equal(r.finals[0].start, 10 + 0.6); // 第 3 个词片（" Two"）的时间
  assert.ok(Math.abs(r.finals[0].conf - Math.exp(-0.2)) < 1e-9);
});

test("问号、叹号也分句；小数点不分句", () => {
  const s = new SentenceSplitter();
  const r = grow(s, " Is it 3.14? Yes! Next");
  assert.deepEqual(r.finals.map((f) => f.text), ["Is it 3.14?", "Yes!"]);
});

test("没有标点一直讲：平时不定稿，flush（端点 / 结束）时整段定稿；只有标点的空段丢掉", () => {
  const s = new SentenceSplitter();
  assert.equal(grow(s, " so we keep going and going").finals.length, 0);
  const r = s.update(result(" so we keep going and going"), { flush: true });
  assert.deepEqual(r.finals.map((f) => f.text), ["so we keep going and going"]);
  assert.equal(r.partial, "");
  s.reset();
  assert.deepEqual(s.update(result("."), { flush: true }), { finals: [], partial: "" });
});

test("reset 后从新的一段重新开始", () => {
  const s = new SentenceSplitter();
  s.update(result(" First one. Second"), { flush: true });
  s.reset();
  const r = grow(s, " New segment. Next", { start_time: 30 });
  assert.deepEqual(r.finals.map((f) => [f.text, f.start]), [["New segment.", 30]]);
});

test("acceptLocalFinal：把握低（别的语言）丢掉；英语保留并清理", () => {
  assert.equal(acceptLocalFinal({ text: "Tong Yeminghau, Zing yang womanianli.", conf: 0.3, start: 1 }, "en"), null);
  assert.deepEqual(acceptLocalFinal({ text: " The second law. ", conf: 0.72, start: 4.5 }, "en"), { text: "The second law.", lang: "en", start: 4.5 });
  assert.equal(acceptLocalFinal({ text: "Thank you.", conf: 0.9, start: 0 }, "en"), null, "常见胡编句丢掉");
  assert.equal(acceptLocalFinal({ text: "Open the book.", conf: -1, start: 0 }, "en").text, "Open the book.", "没有把握值时不按把握过滤");
  assert.equal(acceptLocalFinal({ text: "Hello there.", conf: 0.9, start: 0 }, "zh"), null, "本地实时只出英语");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run（在 `desktop/` 下）：`npm test`
Expected: FAIL，找不到 `src/main/local/sentences.js`。

- [ ] **Step 3: 实现**

`desktop/src/main/local/sentences.js`：

```js
// 把流式识别器「只增不改」的结果切成句子：句末标点后面出现了下一句的词，上一句就定稿；其余是草稿。
// 不依赖任何其他模块：后台线程（worker.cjs）会直接加载它。
const SENTENCE_END = /[.?!]$/;
const HAS_WORD = /[A-Za-z0-9\u00c0-\u024f]/;

export class SentenceSplitter {
  constructor() { this.done = 0; } // 这一段里已经定稿到第几个词片

  /** result：识别器当前这一段的结果；flush 为真表示这一段结束（停顿够久 / 结束录制），剩下的也定稿 */
  update(result, { flush = false } = {}) {
    const tokens = result.tokens ?? [];
    const finals = [];
    let begin = this.done;
    for (let i = this.done; i < tokens.length; i++) {
      const next = tokens[i + 1];
      // 下一个词片以空格开头才算新的一句（"3.14" 里的 "14" 前面没有空格）
      if (SENTENCE_END.test(tokens[i].trim()) && next !== undefined && next.startsWith(" ")) {
        finals.push(this.#make(result, begin, i + 1));
        begin = i + 1;
      }
    }
    if (flush && begin < tokens.length) {
      finals.push(this.#make(result, begin, tokens.length));
      begin = tokens.length;
    }
    this.done = begin;
    return { finals: finals.filter(Boolean), partial: tokens.slice(begin).join("").trim() };
  }

  reset() { this.done = 0; }

  #make(result, a, b) {
    const text = result.tokens.slice(a, b).join("").trim();
    if (!HAS_WORD.test(text)) return null; // 只有标点的空段（识别器重置后偶尔会多出一个 "."）
    const probs = (result.ys_probs ?? []).slice(a, b);
    const conf = probs.length ? Math.exp(probs.reduce((x, y) => x + y, 0) / probs.length) : -1;
    return { text, conf, start: (result.start_time ?? 0) + ((result.timestamps ?? [])[a] ?? 0) };
  }
}
```

`desktop/src/main/local/filter.js`：

```js
import { appleLangOk, clean } from "../text.js";

// 本地模型只会英语：旁边有人说中文、日语时会硬听成不通的英文，这时平均把握只有 0.3~0.4（英语 0.66~0.79）
export const LOCAL_MIN_CONF = 0.5;

/** 本地实时识别定稿的一句：清理、只出英语、把握太低的丢掉 */
export function acceptLocalFinal(m, speaker) {
  if (speaker !== "en") return null;
  const text = clean(m.text ?? "", "en");
  if (!text || !appleLangOk(text, "en")) return null;
  const conf = m.conf ?? -1;
  if (conf >= 0 && conf < LOCAL_MIN_CONF) return null;
  return { text, lang: "en", start: m.start ?? 0 };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run：`npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/local/sentences.js desktop/src/main/local/filter.js desktop/test/local-sentences.test.js
git commit -m "本地实时识别：按句子切分定稿、按把握值过滤其他语言"
```

---

### Task 3: 后台识别线程与 LocalASR

**Files:**
- Create: `desktop/src/main/local/worker.cjs`、`desktop/src/main/local/asr.js`
- Test: `desktop/test/local-asr.test.js`（假线程，测 LocalASR 的逻辑）、`desktop/test/local-asr.int.test.js`（真模型）

**Interfaces:**
- Consumes: `SentenceSplitter`（Task 2）；`models/kroko-en/`（Task 1）
- Produces:
  - 线程消息协议。主 → 线程：`{type:"audio", pcm: Uint8Array /* 16kHz int16 小端 */}`、`{type:"finish"}`。线程 → 主：`{type:"ready"}`、`{type:"partial", text}`、`{type:"final", text, conf, start}`、`{type:"tick", processed /* 已处理的音频秒数 */}`、`{type:"error", msg}`、`{type:"done"}`
  - `LAG_WARN_SEC = 15`；`class LocalASR({workerPath, modelDir, speaker, offset, makeWorker?})`（EventEmitter）：属性 `kind = "local"`、`speaker`、`offset`；`start()`、`feed(buf)`、`close(timeoutMs = 10000): Promise`、`kill()`；事件 `"message"`：`{type:"partial", text}`、`{type:"final", source:"local", text, conf, start}`、`{type:"error", msg}`；`"exit"`（只发一次：正常结束 0，被我们 kill 为 -1，线程出错或意外退出为 1）
  - `makeWorker(workerPath, workerData)` 默认 `new Worker(workerPath, {workerData})`，测试里换成假线程

- [ ] **Step 1: 写失败的测试（LocalASR 逻辑，用假线程）**

`desktop/test/local-asr.test.js`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { LocalASR } from "../src/main/local/asr.js";

class FakeWorker extends EventEmitter {
  constructor() { super(); this.posted = []; this.terminated = false; }
  postMessage(m) { this.posted.push(m); if (m.type === "finish" && this.autoDone !== false) setImmediate(() => this.emit("message", { type: "done" })); }
  async terminate() { this.terminated = true; this.emit("exit", 1); }
}
function setup() {
  const worker = new FakeWorker(), msgs = [], exits = [];
  const asr = new LocalASR({ workerPath: "w", modelDir: "m", speaker: "en", offset: 7, makeWorker: () => worker });
  asr.on("message", (m) => msgs.push(m));
  asr.on("exit", (c) => exits.push(c));
  asr.start();
  return { asr, worker, msgs, exits };
}
const errors = (msgs) => msgs.filter((m) => m.type === "error").map((m) => m.msg);

test("线程的草稿和定稿转成统一的消息；定稿标明来源 local", () => {
  const { worker, msgs } = setup();
  worker.emit("message", { type: "ready" });
  worker.emit("message", { type: "partial", text: "Good" });
  worker.emit("message", { type: "final", text: "Good morning.", conf: 0.8, start: 1.2 });
  assert.deepEqual(msgs, [{ type: "partial", text: "Good" }, { type: "final", source: "local", text: "Good morning.", conf: 0.8, start: 1.2 }]);
});

test("音频按完整样本送进线程：半个样本留到下一次", () => {
  const { asr, worker } = setup();
  asr.feed(Buffer.from([1, 2, 3]));
  asr.feed(Buffer.from([4, 5]));
  const sizes = worker.posted.filter((m) => m.type === "audio").map((m) => m.pcm.length);
  assert.deepEqual(sizes, [2, 2]);
  assert.deepEqual([...worker.posted[1].pcm], [3, 4]);
});

test("close：通知线程收尾，等它说 done，exit 0，只发一次", async () => {
  const { asr, worker, exits } = setup();
  await asr.close();
  assert.equal(worker.posted.at(-1).type, "finish");
  assert.equal(worker.terminated, true);
  assert.deepEqual(exits, [0]);
});

test("close 不会一直等：线程不回应时超时强制结束", async () => {
  const { asr, worker, exits } = setup();
  worker.autoDone = false;
  await asr.close(30);
  assert.equal(worker.terminated, true);
  assert.deepEqual(exits, [0]);
});

test("kill：exit -1；线程自己出错或意外退出：提示并 exit 1", () => {
  const a = setup();
  a.asr.kill();
  assert.deepEqual(a.exits, [-1]);
  const b = setup();
  b.worker.emit("error", new Error("模型文件打不开"));
  assert.deepEqual(b.exits, [1]);
  assert.match(errors(b.msgs)[0], /本地实时识别出错/);
  const c = setup();
  c.worker.emit("message", { type: "error", msg: "找不到 encoder.onnx" });
  assert.match(errors(c.msgs)[0], /找不到 encoder\.onnx/);
});

test("电脑太慢跟不上：积压超过 15 秒提示一次", () => {
  const { asr, worker, msgs } = setup();
  asr.feed(Buffer.alloc(32000 * 20)); // 送了 20 秒
  worker.emit("message", { type: "tick", processed: 2 });
  worker.emit("message", { type: "tick", processed: 3 });
  assert.equal(errors(msgs).length, 1);
  assert.match(errors(msgs)[0], /跟不上/);
});
```

- [ ] **Step 2: 写失败的集成测试（真模型）**

`desktop/test/local-asr.int.test.js`：

```js
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
```

- [ ] **Step 3: 运行测试确认失败**

Run：`npm test`
Expected: FAIL，找不到 `src/main/local/asr.js`。

- [ ] **Step 4: 实现后台线程**

`desktop/src/main/local/worker.cjs`：

```js
// 后台线程：加载本地识别模型，持续解码，把结果切成句子发回主线程。放在线程里是为了加载（1~6 秒）和解码都不卡窗口。
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SR = 16000;

(async () => {
  const dir = workerData.modelDir;
  for (const f of ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"]) {
    if (!fs.existsSync(path.join(dir, f))) throw new Error(`找不到模型文件 ${f}`);
  }
  const { SentenceSplitter } = await import(pathToFileURL(path.join(__dirname, "sentences.js")).href);
  const sherpa = require("sherpa-onnx");
  const recognizer = sherpa.createOnlineRecognizer({
    featConfig: { sampleRate: SR, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: path.join(dir, "encoder.onnx"), decoder: path.join(dir, "decoder.onnx"), joiner: path.join(dir, "joiner.onnx") },
      tokens: path.join(dir, "tokens.txt"), numThreads: 1, provider: "cpu", debug: 0,
    },
    decodingMethod: "greedy_search", maxActivePaths: 4,
    enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4,   // 还没识别出字时，静音多久算一段结束
    rule2MinTrailingSilence: 0.8,   // 识别出字之后，停顿多久算一段结束
    rule3MinUtteranceLength: 20,    // 一直讲不停时，最长多久强制结束一段
  });
  const stream = recognizer.createStream();
  const splitter = new SentenceSplitter();
  let lastPartial = "", samples = 0;

  function step(flush) {
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    const endpoint = flush || recognizer.isEndpoint(stream);
    const { finals, partial } = splitter.update(recognizer.getResult(stream), { flush: endpoint });
    for (const f of finals) parentPort.postMessage({ type: "final", ...f });
    if (partial !== lastPartial) {
      lastPartial = partial;
      parentPort.postMessage({ type: "partial", text: partial });
    }
    if (endpoint) { recognizer.reset(stream); splitter.reset(); }
  }

  parentPort.on("message", (m) => {
    if (m.type === "audio") {
      const n = m.pcm.byteLength >> 1;
      const view = new DataView(m.pcm.buffer, m.pcm.byteOffset, n * 2);
      const f32 = new Float32Array(n);
      for (let i = 0; i < n; i++) f32[i] = view.getInt16(i * 2, true) / 32768;
      stream.acceptWaveform(SR, f32);
      samples += n;
      step(false);
      parentPort.postMessage({ type: "tick", processed: samples / SR });
    } else if (m.type === "finish") {
      stream.acceptWaveform(SR, new Float32Array(SR / 2)); // 补半秒静音，让最后几个词也解出来
      stream.inputFinished();
      step(true);
      parentPort.postMessage({ type: "done" });
    }
  });
  parentPort.postMessage({ type: "ready" });
})().catch((e) => {
  parentPort.postMessage({ type: "error", msg: String(e?.message ?? e) });
  process.exit(1);
});
```

- [ ] **Step 5: 实现 LocalASR**

`desktop/src/main/local/asr.js`：

```js
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";

export const LAG_WARN_SEC = 15; // 识别落后说话这么多秒就提醒一次

/** 本地实时识别（英语）：模型在后台线程里跑，边说边出草稿，按句定稿。接口和 AppleASR / CloudASR 一样 */
export class LocalASR extends EventEmitter {
  constructor({ workerPath, modelDir, speaker, offset, makeWorker }) {
    super();
    Object.assign(this, { workerPath, modelDir, speaker, offset });
    this.kind = "local";
    this.makeWorker = makeWorker ?? ((file, workerData) => new Worker(file, { workerData }));
    this.worker = null;
    this.carry = null;      // 上一块末尾多出来的半个样本
    this.fedSec = 0;
    this.exited = false;
    this.lagNoted = false;
    this.onDone = null;
  }

  start() {
    const w = this.makeWorker(this.workerPath, { modelDir: this.modelDir });
    w.on("message", (m) => this.#onWorker(m));
    w.on("error", (e) => { // 线程自己崩了
      this.emit("message", { type: "error", msg: `本地实时识别出错：${String(e?.message ?? e).slice(0, 80)}` });
      this.#exit(1);
    });
    w.on("exit", () => this.#exit(1)); // 没走正常结束流程就退出了
    this.worker = w;
  }

  #onWorker(m) {
    if (m.type === "partial") this.emit("message", { type: "partial", text: m.text });
    else if (m.type === "final") this.emit("message", { type: "final", source: "local", text: m.text, conf: m.conf, start: m.start });
    else if (m.type === "error") this.emit("message", { type: "error", msg: `本地实时识别出错：${String(m.msg).slice(0, 80)}` });
    else if (m.type === "done") this.onDone?.();
    else if (m.type === "tick" && !this.lagNoted && this.fedSec - m.processed > LAG_WARN_SEC) {
      this.lagNoted = true;
      this.emit("message", { type: "error", msg: "这台电脑的本地识别跟不上说话速度，字幕会越来越晚；建议在「识别方式」里改用「云端（Gemini）」" });
    }
  }

  #exit(code) {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code);
  }

  feed(buf) {
    if (!this.worker || this.exited) return;
    const data = this.carry ? Buffer.concat([this.carry, buf]) : buf;
    const even = data.length - (data.length % 2);
    this.carry = even < data.length ? Buffer.from(data.subarray(even)) : null;
    if (!even) return;
    this.fedSec += even / 2 / 16000;
    this.worker.postMessage({ type: "audio", pcm: new Uint8Array(data.subarray(0, even)) }); // 复制一份交给线程
  }

  /** 不再送音频：让线程把最后半句定稿；线程不回应就超时强制结束 */
  async close(timeoutMs = 10_000) {
    if (!this.worker || this.exited) return;
    let timer;
    await new Promise((resolve) => {
      this.onDone = resolve;
      timer = setTimeout(resolve, timeoutMs);
      this.worker.postMessage({ type: "finish" });
    });
    clearTimeout(timer);
    this.#exit(0);
    await this.worker.terminate();
  }

  kill() {
    if (this.exited) return;
    this.#exit(-1);
    this.worker?.terminate();
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run：`npm test`
Expected: 全部 PASS（集成测试在没有模型或非 Mac 时显示 skipped）。若「英文讲课」定稿不足 3 句，打印 `finals` 看标点情况再调整断言，不要改模型参数去迁就测试。

- [ ] **Step 7: Commit**

```bash
git add desktop/src/main/local/worker.cjs desktop/src/main/local/asr.js desktop/test/local-asr.test.js desktop/test/local-asr.int.test.js
git commit -m "本地实时识别：后台线程运行模型，LocalASR 统一接口"
```

---

### Task 4: Session 接入本地实时

**Files:**
- Modify: `desktop/src/main/session.js`、`desktop/test/session.test.js`

**Interfaces:**
- Consumes: `LocalASR` 的事件（Task 3）、`acceptLocalFinal`（Task 2）
- Produces: `makeAsr("local", speaker, offset)`；`caps.localAsr`；崩溃记录从 `appleFailed`（字符串）改为 `failed`（`Set<"kind:speaker">`），三种引擎通用

- [ ] **Step 1: 写失败的测试**

在 `desktop/test/session.test.js`：把 `function setup({ llm = {}, appleTr = {}, caps = { appleAsr: true, cloudAsr: true } } = {}) {` 里的 `caps = { appleAsr: true, cloudAsr: true }` 改为 `caps = { appleAsr: true, cloudAsr: true, localAsr: true }`，并在文件末尾追加：

```js
test("本地实时：草稿照发，定稿直接出字幕并按所选方式带上文翻译", async () => {
  const asked = [];
  const { s, sent, asrs } = setup({ llm: { translate: async (t, ctx, _target, provider) => { asked.push({ t, ctx, provider }); return `译:${t}`; } } });
  s.configure({ asr: "local" });
  s.audio(pcm(2));
  assert.equal(asrs[0].kind, "local");
  asrs[0].offset = 2;
  asrs[0].emit("message", { type: "partial", text: "The second" });
  asrs[0].emit("message", { type: "final", source: "local", text: "The second law.", conf: 0.75, start: 1 });
  asrs[0].emit("message", { type: "final", source: "local", text: "Entropy never decreases.", conf: 0.7, start: 4 });
  await s.idle();
  assert.deepEqual(sent.find((m) => m.type === "partial"), { type: "partial", text: "The second" });
  assert.deepEqual(sent.filter((m) => m.type === "line").map((m) => [m.text, m.t]), [["The second law.", 3], ["Entropy never decreases.", 6]]);
  assert.deepEqual(asked.find((a) => a.t === "Entropy never decreases.").ctx, ["The second law."]);
});

test("本地实时：把握低的句子（旁边有人说中文）不出字幕", async () => {
  const { s, sent, asrs } = setup();
  s.configure({ asr: "local" });
  s.audio(pcm(1));
  asrs[0].emit("message", { type: "final", source: "local", text: "Tong Yeminghau, Zing yang womanianli.", conf: 0.3, start: 0 });
  await s.idle();
  assert.equal(sent.filter((m) => m.type === "line").length, 0);
});

test("本地实时只支持英语：说话人语言选了别的，只提示一次，不启动识别", () => {
  const { s, sent, asrs } = setup();
  s.configure({ asr: "local", speaker: "zh" });
  s.audio(pcm(1)); s.audio(pcm(1));
  assert.equal(asrs.length, 0);
  assert.equal(errors(sent).length, 1);
  assert.match(errors(sent)[0], /只支持英语/);
});

test("本地实时线程出错：自动重启一次，再出错就停止并提示一次", () => {
  const { s, sent, asrs } = setup();
  s.configure({ asr: "local" });
  s.audio(pcm(1)); asrs[0].emit("exit", 1);
  s.audio(pcm(1));
  assert.equal(asrs.length, 2);
  asrs[1].emit("exit", 1);
  s.audio(pcm(1)); s.audio(pcm(1));
  assert.equal(asrs.length, 2);
  assert.equal(errors(sent).filter((m) => m.includes("连续出错")).length, 1);
});

test("一种识别方式出错停掉后，换另一种还能用", () => {
  const { s, asrs } = setup();
  s.configure({ asr: "local" });
  s.audio(pcm(1)); asrs[0].emit("exit", 1);
  s.audio(pcm(1)); asrs[1].emit("exit", 1);
  s.configure({ asr: "cloud" });
  s.audio(pcm(1));
  assert.equal(asrs[2].kind, "cloud");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run：`npm test`
Expected: FAIL（`local` 还不被接受，提示的是「用不了苹果自带识别」）。

- [ ] **Step 3: 实现**

在 `desktop/src/main/session.js`：

1. import 区追加：`import { acceptLocalFinal } from "./local/filter.js";`
2. 构造函数里把
```js
    this.appleFailed = "";    // 连续崩溃的说话人语言，不再重启
```
   改为
```js
    this.failed = new Set();  // 连续出错的「识别方式:说话人语言」，不再重启
```
3. 把 `asrKind()`、`audio(buf)`、`startAsr(kind)` 三个方法整体替换为：

```js
  /** 这节课用哪种识别：苹果（新 Mac）、本地实时（英语）或云端（Gemini）；都用不了返回 null */
  asrKind() {
    if (this.cfg.asr === "apple" && this.caps.appleAsr) return "apple";
    if (this.cfg.asr === "local" && this.caps.localAsr) return "local";
    if (this.cfg.asr === "cloud" && this.caps.cloudAsr) return "cloud";
    return null;
  }

  audio(buf) {
    if (this.paused) return;
    const kind = this.asrKind();
    if (!kind) {
      return this.warnOnce("no-asr", "这台电脑用不了苹果自带识别（需要 macOS 26 或更新），请在「识别方式」里选「本地实时」或「云端（Gemini）」。");
    }
    if (kind === "local" && this.cfg.speaker !== "en") {
      return this.warnOnce("local-lang", "本地实时识别目前只支持英语，请把「识别方式」改成「云端（Gemini）」。");
    }
    if (this.failed.has(`${kind}:${this.cfg.speaker}`)) {
      return this.warnOnce(`crash-${kind}`, "识别程序连续出错，已停止识别。请结束录制后重新开始，或者在「识别方式」里换一种。");
    }
    if (!this.asr) this.startAsr(kind);
    this.asr.feed(buf);
    this.samples += buf.length / 2;
  }

  startAsr(kind) {
    const asr = this.makeAsr(kind, this.cfg.speaker, this.samples / SR);
    asr.on("message", (m) => this.onAsr(asr, m));
    asr.on("exit", (code) => {
      if (this.asr === asr) this.asr = null;
      if (code !== 0 && code !== -1) {      // -1 是我们自己关掉的
        this.crashes.set(asr.kind, (this.crashes.get(asr.kind) ?? 0) + 1);
        // 下一段音频时自动重启一次，再出错就停
        if (this.crashes.get(asr.kind) >= 2) this.failed.add(`${asr.kind}:${asr.speaker}`);
      }
    });
    asr.start();
    this.asr = asr;
  }
```
4. 构造函数里把 `this.asrCrashes = 0;` 改为 `this.crashes = new Map(); // 每种识别方式出错的次数`
5. `onAsr` 里，在 `} else if (m.type === "final" && m.source === "cloud") {` 这个分支之前插入：
```js
    } else if (m.type === "final" && m.source === "local") {
      const r = acceptLocalFinal(m, asr.speaker);
      if (r) this.addLine(r.text, r.lang, "", asr.offset + r.start);
```
6. 把 `onAsr` 最后的错误分支
```js
      this.send({ type: "error", msg: asr.kind === "cloud" ? m.msg : `苹果识别出错：${String(m.msg ?? "").slice(0, 60)}` });
```
   改为
```js
      this.send({ type: "error", msg: asr.kind === "apple" ? `苹果识别出错：${String(m.msg ?? "").slice(0, 60)}` : m.msg });
```

- [ ] **Step 4: 运行测试确认通过**

Run：`npm test`
Expected: 全部 PASS（含旧的苹果识别崩溃测试：提示里仍有「连续出错」）。

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/session.js desktop/test/session.test.js
git commit -m "一节课可选本地实时识别；出错重启逻辑三种识别方式通用"
```

---

### Task 5: 功能检测与主进程接线

**Files:**
- Modify: `desktop/src/main/platform.js`、`desktop/test/platform.test.js`、`desktop/src/main/main.js`

**Interfaces:**
- Consumes: `LocalASR`（Task 3）
- Produces: `capabilities({platform, version, has, bins, localModel})` 返回新增 `localAsr: has(localModel)`；冒烟参数 `CT_SMOKE_ASR=local`

- [ ] **Step 1: 改测试**

在 `desktop/test/platform.test.js`：把 `const caps = (platform, version, has = () => true) => capabilities({ platform, version, has, bins });` 改为
`const caps = (platform, version, has = () => true) => capabilities({ platform, version, has, bins, localModel: "m" });`
两处 `deepEqual` 的期望对象里各加 `localAsr: true`，并追加：

```js
test("模型文件不在时本地实时不可用", () => {
  assert.equal(caps("win32", "10.0", (p) => p !== "m").localAsr, false);
});
```

Run：`npm test`
Expected: FAIL（没有 `localAsr`）。

- [ ] **Step 2: 实现 platform.js**

在 `desktop/src/main/platform.js`：函数签名改为 `export function capabilities({ platform, version, has, bins, localModel }) {`，返回对象里在 `cloudAsr: true,` 之后加一行 `localAsr: !!localModel && has(localModel),`，文件头注释改为
`/** 这台电脑能用哪些功能：苹果识别 / 翻译只在新 Mac；本地实时和云端识别都能用；Windows 用系统回环录电脑声音 */`

Run：`npm test`
Expected: 全部 PASS。

- [ ] **Step 3: 主进程接线**

在 `desktop/src/main/main.js`：

1. import 区追加：`import { LocalASR } from "./local/asr.js";`
2. 在 `build()` 里 `const caps = capabilities({ … });` 之前插入：
```js
  // 本地实时识别：模型是资源文件；线程脚本和 sherpa-onnx 打包时放在 asar 外面（线程和 WASM 都要按真实文件路径加载）
  const modelDir = app.isPackaged ? path.join(process.resourcesPath, "models", "kroko-en") : path.join(here, "../../models/kroko-en");
  const localWorker = path.join(here, "local/worker.cjs").replace("app.asar", "app.asar.unpacked");
```
   并把 `capabilities({ platform: process.platform, version: process.getSystemVersion(), has: (p) => fs.existsSync(p), bins })` 改为
   `capabilities({ platform: process.platform, version: process.getSystemVersion(), has: (p) => fs.existsSync(p), bins, localModel: path.join(modelDir, "encoder.onnx") })`
3. 把 `makeAsr` 改为：
```js
    makeAsr: (kind, speaker, offset) => {
      if (kind === "cloud") return new CloudASR({ llm, vad, speaker, offset });
      if (kind === "local") return new LocalASR({ workerPath: localWorker, modelDir, speaker, offset });
      return new AppleASR(bins.asr, speaker, offset);
    },
```

- [ ] **Step 4: 冒烟测试（Mac，不需要 key 也能出原文字幕）**

Run（在 `desktop/` 下）：
```bash
T=$(mktemp -d)
say -v Samantha -o $T/a.aiff "Good morning everyone. Today we will continue our discussion of thermodynamics. The second law tells us that entropy never decreases."
afconvert -f WAVE -d LEI16@16000 -c 1 $T/a.aiff $T/a.wav
CT_SMOKE_WAV=$T/a.wav CT_SMOKE_ASR=local CT_RECORDS_DIR=$T/records npx electron . > $T/out.txt 2>&1
grep SMOKE $T/out.txt | grep -E '"line"|"done"' | cut -c1-140; grep -c '"partial"' $T/out.txt
```
Expected: 至少 2 条 `line`（含 `thermodynamics`，`lang` 为 `en`），最后有 `done`，`partial` 条数大于 0。

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/platform.js desktop/test/platform.test.js desktop/src/main/main.js
git commit -m "主进程接入本地实时识别"
```

---

### Task 6: 界面

**Files:**
- Modify: `desktop/src/renderer/app.js`、`desktop/src/renderer/index.html`

**Interfaces:**
- Consumes: `/api/app-info` 的 `caps.localAsr`（Task 5）

- [ ] **Step 1: 记录改动前的状态**

Run（在 `desktop/` 下）：`CT_SMOKE_OPEN=1 npx electron . > /tmp/claude-501/v3-open.txt 2>/dev/null; grep -o '"asr":\[[^]]*\]' /tmp/claude-501/v3-open.txt`
Expected: 只有「苹果自带」和「云端」两项——还没有本地实时。

- [ ] **Step 2: 改 index.html**

把
```html
      <tr><td>云端识别（Gemini）</td><td>有人说话的音频片段会发送给 Google</td></tr>
```
改为
```html
      <tr><td>本地实时识别</td><td>只在这台电脑上处理，不上传</td></tr>
      <tr><td>云端识别（Gemini）</td><td>有人说话的音频片段会发送给 Google</td></tr>
```

- [ ] **Step 3: 改 app.js**

1. 把 `const ASRS = { apple: "苹果自带（最快，边说边出字）", cloud: "云端（Gemini，需要填 key）" };` 改为
```js
const ASRS = { apple: "苹果自带（最快，边说边出字）", local: "本地实时（英语，免费，边说边出字）", cloud: "云端（Gemini，需要填 key）" };
```
2. 把 `refreshSpeakers` 里的 `if ($("asr").value === "apple") delete SPEAKERS.auto;` 改为
```js
  if ($("asr").value !== "cloud") delete SPEAKERS.auto; // 只有云端识别能同时认中英文
```
   并把它上面的注释改为 `// 苹果识别和本地实时都要事先确定语言，做不到「自动（中/英）」；云端识别可以`
3. 在 `for (const id of ["speaker", "target", "asr", "translator"])` 的 onchange 里，把 `    if (id === "asr") refreshSpeakers();` 改为：
```js
    // 本地实时只支持英语：语言和识别方式互相迁就，免得出一堆乱码
    if (id === "speaker" && $("asr").value === "local" && $("speaker").value !== "en") {
      $("asr").value = "cloud";
      try { localStorage.setItem("asr2", "cloud"); } catch {}
      toast("本地实时只支持英语，已改用云端识别（需要填 Gemini key）");
    }
    if (id === "asr" && $("asr").value === "local" && $("speaker").value !== "en") {
      try { localStorage.setItem("speaker", "en"); } catch {}
      toast("本地实时只支持英语，说话人语言已改为英语");
    }
    if (id === "asr" || id === "speaker") refreshSpeakers();
```
4. 在 `app-info` 处理里，`if (!info.caps.appleAsr) delete ASRS.apple;` 之后加一行：
```js
  if (!info.caps.localAsr) delete ASRS.local;
```
   并在 `refreshSpeakers();` 之前加：
```js
  if ($("asr").value === "local" && load("speaker", "en", ALL_SPEAKERS) !== "en") $("asr").value = "cloud"; // 上次选的语言不是英语
```

- [ ] **Step 4: 冒烟检查**

Run：`CT_SMOKE_OPEN=1 npx electron . > /tmp/claude-501/v3-open.txt 2>/dev/null; grep -E "CONSOLE" /tmp/claude-501/v3-open.txt; grep -o '"asr":\[[^]]*\]' /tmp/claude-501/v3-open.txt`
Expected: 没有 `CONSOLE` 报错；`asr` 为 `["苹果自带（最快，边说边出字）","本地实时（英语，免费，边说边出字）","云端（Gemini，需要填 key）"]`。

- [ ] **Step 5: Commit**

```bash
git add desktop/src/renderer/app.js desktop/src/renderer/index.html
git commit -m "界面：识别方式加入本地实时，语言与识别方式联动"
```

---

### Task 7: 打包

**Files:**
- Modify: `desktop/electron-builder.yml`、`desktop/scripts/check-package.mjs`、`desktop/package.json`

**Interfaces:**
- Produces: `dist/ClassTranslator-0.3.0-{arm64,x64}.dmg`、`dist/ClassTranslator-0.3.0-win-{x64,arm64}-setup.exe`

- [ ] **Step 1: 让打包检查先表达要求（先失败）**

在 `desktop/scripts/check-package.mjs`：把
`const MUST_UNPACKED = "app.asar.unpacked/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm";`
改为
```js
// 必须以真实文件存在（不能只在 asar 里）：WASM、后台线程脚本、本地识别模型
const MUST_FILES = [
  "app.asar.unpacked/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
  "app.asar.unpacked/node_modules/sherpa-onnx/sherpa-onnx-wasm-nodejs.wasm",
  "app.asar.unpacked/src/main/local/worker.cjs",
  "app.asar.unpacked/src/main/local/sentences.js",
  "models/kroko-en/encoder.onnx",
  "models/kroko-en/tokens.txt",
];
```
把
`  if (!fs.existsSync(path.join(res, MUST_UNPACKED))) problems.push(`缺少人声检测运行文件：${MUST_UNPACKED}（${res}）`);`
改为
`  for (const f of MUST_FILES) if (!fs.existsSync(path.join(res, f))) problems.push(`缺少必需文件：${f}（${res}）`);`
并把 `const MUST_HAVE = [...]` 改为
`const MUST_HAVE = ["assets/silero_vad.onnx", "assets/THIRD_PARTY_NOTICES.md", "node_modules/onnxruntime-web/dist/ort.node.min.js"];`

Run（在 `desktop/` 下）：`rm -rf dist && npm run dist; echo "rc=$?"`
Expected: 打包检查失败，列出缺少 `sherpa-onnx-wasm-nodejs.wasm`、`worker.cjs`、`models/kroko-en/encoder.onnx` 等。

- [ ] **Step 2: 改打包配置和版本号**

在 `desktop/electron-builder.yml`：
1. `files:` 列表里，在 `  - assets/SILERO_LICENSE.txt` 之后加一行 `  - assets/THIRD_PARTY_NOTICES.md`
2. 把
```yaml
asarUnpack:
  - node_modules/onnxruntime-web/dist/**   # WebAssembly 文件放在压缩包外，按文件路径加载更可靠
```
   改为
```yaml
asarUnpack:
  - node_modules/onnxruntime-web/dist/**   # WebAssembly 文件放在压缩包外，按文件路径加载更可靠
  - node_modules/sherpa-onnx/**            # 本地实时识别的 WASM 运行库
  - src/main/local/**                      # 后台线程脚本要按真实文件路径启动
extraResources:
  - from: models                           # 本地实时识别模型（scripts/fetch-models.sh 下载，不进 git）
    to: models
```
在 `desktop/package.json`：`"version": "0.2.0"` 改为 `"version": "0.3.0"`。

- [ ] **Step 3: 打 Mac 包并检查**

Run（在 `desktop/` 下）：`npm test && rm -rf dist && npm run dist`
Expected: 测试全过；生成 `ClassTranslator-0.3.0-arm64.dmg`、`ClassTranslator-0.3.0-x64.dmg`；打印「打包检查通过：2 个 App …必需文件齐全」。

- [ ] **Step 4: 打包后的 Mac App 跑本地实时冒烟**

Run（在 `desktop/` 下）：
```bash
T=$(mktemp -d)
say -v Samantha -o $T/a.aiff "Good morning everyone. Today we will continue our discussion of thermodynamics. The second law tells us that entropy never decreases."
afconvert -f WAVE -d LEI16@16000 -c 1 $T/a.aiff $T/a.wav
CT_SMOKE_WAV=$T/a.wav CT_SMOKE_ASR=local CT_RECORDS_DIR=$T/records "dist/mac-arm64/课堂同传.app/Contents/MacOS/课堂同传" > $T/out.txt 2>&1
grep SMOKE $T/out.txt | grep -E '"line"|"error"|"done"' | cut -c1-140
codesign --verify --deep --strict "dist/mac-arm64/课堂同传.app" && echo 签名完整
```
Expected: 至少 2 条 `line`（含 `thermodynamics`），没有「本地实时识别出错」，最后 `done`；「签名完整」。若线程启动失败，按报错修正 `asarUnpack` 或 `localWorker` 路径后重打，并在 ledger 记 Ruling。

- [ ] **Step 5: 打 Windows 包并检查，清理 .app 副本**

Run（在 `desktop/` 下）：`npm run dist:win && rm -rf dist/mac dist/mac-arm64 && ls -la dist/*.dmg dist/*.exe | awk '{print int($5/1048576)" MB", $NF}'`
Expected: 生成两个 `0.3.0` 的 `setup.exe`；打包检查通过；四个安装包各比 0.2.0 大约 80 MB。

- [ ] **Step 6: Commit**

```bash
git add desktop/electron-builder.yml desktop/scripts/check-package.mjs desktop/package.json desktop/package-lock.json
git commit -m "打包：带上本地实时识别的运行库和模型，版本 0.3.0"
```

---

### Task 8: 在 Windows 虚拟机里验证

**Files:** 无代码改动（发现问题先写复现测试再修，单独提交）

- [ ] **Step 1: 征得同意，确认虚拟机可用**

先问南瓜：「要在 Windows 11 虚拟机里装 0.3.0 测试版，可以吗？」同意后：
```bash
prlctl list -a | grep "Windows 11" | grep -q running || prlctl resume "Windows 11"
prlctl exec "Windows 11" --current-user cmd /c "echo ok"
```
Expected: 打印 ok。

- [ ] **Step 2: 准备测试脚本和录音**

Run：
```bash
T=~/Downloads/ct-win-test; rm -rf $T; mkdir -p $T
cp ~/class-translator/desktop/dist/ClassTranslator-0.3.0-win-*-setup.exe $T/
say -v Samantha -o $T/a.aiff "Good morning everyone. Today we will continue our discussion of thermodynamics. The second law tells us that entropy never decreases."
afconvert -f WAVE -d LEI16@16000 -c 1 $T/a.aiff $T/a.wav
cat > $T/install.ps1 <<'EOF'
param([string]$Arch = "arm64")
$dir = "$env:LOCALAPPDATA\Programs\ClassTranslator"; $exe = "$dir\ClassTranslator.exe"
$u = Get-ChildItem $dir -Filter "Uninstall*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($u) { Start-Process $u.FullName -ArgumentList "/S" -Wait; for ($i = 0; $i -lt 30 -and (Test-Path $exe); $i++) { Start-Sleep 1 }; Start-Sleep 3 }
$dst = "$env:TEMP\ct-setup-$Arch.exe"
Copy-Item "Z:\Downloads\ct-win-test\ClassTranslator-0.3.0-win-$Arch-setup.exe" $dst -Force
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $dst -ArgumentList "/S" -PassThru
while ($sw.Elapsed.TotalSeconds -lt 240 -and -not ($p.HasExited -and (Test-Path $exe))) { Start-Sleep 1; if ($p.HasExited -and -not (Test-Path $exe)) { break } }
"installed=" + (Test-Path $exe) + " seconds=" + [int]$sw.Elapsed.TotalSeconds
EOF
cat > $T/smoke.ps1 <<'EOF'
param([string]$Mode = "open", [string]$Tag = "arm64")
$exe = "$env:LOCALAPPDATA\Programs\ClassTranslator\ClassTranslator.exe"
if ($Mode -eq "open") { $env:CT_SMOKE_OPEN = "1"; $env:CT_SMOKE_SHOT = "Z:\Downloads\ct-win-test\shot-$Tag.png" }
else { $env:CT_SMOKE_WAV = "Z:\Downloads\ct-win-test\a.wav"; $env:CT_SMOKE_ASR = "local"; $env:CT_RECORDS_DIR = "$env:TEMP\ct-smoke-records" }
Start-Process -FilePath $exe -Wait -RedirectStandardOutput "Z:\Downloads\ct-win-test\$Mode-$Tag.txt" -RedirectStandardError "Z:\Downloads\ct-win-test\$Mode-$Tag-err.txt"
EOF
```

- [ ] **Step 3: 两个版本各装一遍并检查**

Run：
```bash
T=~/Downloads/ct-win-test
for a in x64 arm64; do
  prlctl exec "Windows 11" --current-user powershell -NoProfile -ExecutionPolicy Bypass -File "Z:\\Downloads\\ct-win-test\\install.ps1" -Arch $a | tail -1
  for m in open local; do prlctl exec "Windows 11" --current-user powershell -NoProfile -ExecutionPolicy Bypass -File "Z:\\Downloads\\ct-win-test\\smoke.ps1" -Mode $m -Tag $a >/dev/null 2>&1; done
  echo "$a 界面: $(grep -c CONSOLE $T/open-$a.txt) 个报错 $(grep -o '"asr":\[[^]]*\]' $T/open-$a.txt)"
  grep SMOKE $T/local-$a.txt | grep -E '"line"|"error"|"done"' | cut -c1-140
done
rm -f ~/Desktop/课堂同传.lnk
```
Expected（两种架构都要满足）：`installed=True`；界面 0 个报错，`asr` 为「本地实时」「云端」两项，且本地实时排第一；本地实时冒烟输出至少 2 条 `line`（含 `thermodynamics`）和 `done`，没有「本地实时识别出错」「跟不上」。虚拟机没填 key 时会有一条「课堂笔记更新失败…需要先填写 key」，属正常。最后一行删掉 Parallels 共享桌面上生成的坏快捷方式。

- [ ] **Step 4: 和南瓜一起做的人工检查**

请南瓜在虚拟机里打开课堂同传（现在装的是 ARM64 版）：
1. 识别方式默认是「本地实时」；对着麦克风说英文，灰色草稿边说边出，句子说完马上定稿
2. 没填 key 时只有英文字幕；填了 Gemini key 后每句 1–2 秒内出中文翻译
3. 麦克风选「电脑内部声音」，放一段英文视频，能出字幕
4. 说几句中文：不应该出现乱码英文字幕
5. 把说话人语言改成中文：识别方式自动变成「云端」，并有提示

结果记进 ledger；发现的问题先写复现测试再修。

- [ ] **Step 5: 清理**

Run：`rm -rf ~/Downloads/ct-win-test; prlctl exec "Windows 11" --current-user cmd /c "del /q %TEMP%\ct-setup-*.exe & rmdir /s /q %TEMP%\ct-smoke-records & echo cleaned"`

---

### Task 9: 说明文档与发布材料（发布前停下等确认）

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新 README**

1. `<b>预览版 v0.2.0</b>` 改为 `<b>预览版 v0.3.0</b>`；文中「课堂同传 v0.2.0 预览版」改为「课堂同传 v0.3.0 预览版」；下载列表里四处 `课堂同传 0.2.0` 改为 `课堂同传 0.3.0`
2. 把「支持哪些电脑」表格替换为：
```markdown
| 电脑 | 语音识别 | 能不能录电脑内部声音 |
|---|---|---|
| Mac，系统 macOS 26 或更新 | 苹果自带、本地实时或云端 Gemini | 可以 |
| Mac，系统 macOS 14.2 到 macOS 26 之前 | 本地实时（英语）或云端 Gemini | 可以 |
| Mac，系统更旧 | 本地实时（英语）或云端 Gemini | 不可以 |
| Windows 10 / 11 | 本地实时（英语）或云端 Gemini | 可以 |

三种识别方式的区别：

| 识别方式 | 特点 |
|---|---|
| 苹果自带 | 只有新 Mac 能用。免费，边说边出字，在电脑上处理 |
| 本地实时 | 所有电脑都能用。免费，不用填 key，边说边出字，在电脑上处理；目前只支持英语 |
| 云端（Gemini） | 需要填 Gemini key。一句一句出，慢一些，但支持更多语言，也能同时识别中文和英文 |
```
3. 「能做什么」第一条改为：`- **实时字幕**：老师边说边出字，说完一句马上定稿并翻译成中文。英语课在所有电脑上都不用填 key 就能出字幕`
4. 「第一次使用」第 3 条改为：
```markdown
3. **填 Gemini key（推荐）**：点右上角「AI 模型与 API」，粘贴 Gemini key 后点保存。不填也能看到英文字幕；填了才有结合上下文的中文翻译、课堂笔记和课后精讲。新 Mac 不填 key 时可以用苹果自带翻译。
```
5. 「隐私」表格里在苹果那一行后面加：`| 本地实时识别 | 只在你的电脑上处理，不上传 |`
6. 「许可证」一节替换为：
```markdown
[MIT](LICENSE) · Powered by 南瓜

安装包里包含的第三方组件和模型（sherpa-onnx、Kroko ASR 英语社区模型、Silero VAD 等）及其许可证见 `desktop/assets/THIRD_PARTY_NOTICES.md`。其中本地实时识别使用的 Kroko 社区模型以 CC-BY-SA 协议提供，由 Banafo 发布，课堂同传未作修改。
```
7. 「给开发者」里 `npm start` 那行之前加一行：`  npm run models  # 下载本地实时识别模型（需要 GitHub 命令行工具 gh）`

检查：`python3 -c "import re;s=open('README.md').read();print('无表情符号' if not re.search('[\u2600-\u27bf\U0001F000-\U0001FAFF\ufe0f]',s) else '有表情符号'); print(s.count('0.2.0'))"`
Expected: 「无表情符号」，`0.2.0` 出现 0 次。

- [ ] **Step 2: Commit（只提交到本地）**

```bash
git add README.md
git commit -m "说明：本地实时识别，v0.3.0"
```

- [ ] **Step 3: 准备发布说明草稿，停下等南瓜确认**

草稿：

> **课堂同传 v0.3.0 预览版**
>
> Windows 和旧版 Mac 现在也能边说边出字了。
>
> - 新增「本地实时」识别：在电脑上直接识别英语，不联网、不用填 key，边说边出字，句子说完马上定稿
> - Windows 和旧 Mac 默认使用本地实时；云端（Gemini）识别仍然可以选，用于其他语言或中英混合
> - 翻译仍然结合前几句上文，会纠正识别错的字（需要填 Gemini 或 Claude 的 key）
> - 安装包比上一版大约 80 MB，因为内置了识别模型
>
> **下载哪个？** 看下面 Assets 里的名字：苹果芯片 Mac、Intel Mac、大多数 Windows 电脑、ARM 芯片的 Windows。
>
> 第一次打开被系统拦住，按 README 里的步骤操作一次即可。
>
> 课堂录音前，请先确认学校和老师的规定。
>
> Powered by 南瓜

列出将要推送的提交、四个安装包（显示名、文件名、大小）、发布说明全文和尚未验证的事项，**等南瓜明确回复同意后**再执行推送和 `gh release create v0.3.0 …`（附件显示名：`课堂同传 0.3.0 Mac（苹果芯片 M1–M4）`、`课堂同传 0.3.0 Mac（Intel 芯片）`、`课堂同传 0.3.0 Windows（大多数电脑）`、`课堂同传 0.3.0 Windows（ARM 芯片）`）。发布后核对附件名并下载其中一个比对校验值。
