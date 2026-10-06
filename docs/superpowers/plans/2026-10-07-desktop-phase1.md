# 课堂同传桌面版 第 1 期 开发计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出一个在新 Mac（macOS 26+）上双击就能用的「课堂同传」App，功能与现网页版一致（苹果识别、三种翻译、课堂笔记、课后精讲含历史记录、电脑内部声音、导出 Markdown / PDF），key 加密保存，底部写「Powered by 南瓜」。

**Architecture:** Electron App，放在仓库的 `desktop/` 子目录，现网页版（`server.py` 等）原样保留。后台逻辑从 Python 改写成 Node（ESM），拆成互不依赖 Electron 的纯模块（文本处理、记录、设置、AI 调用、苹果子程序封装、课堂流水线、接口路由），方便用 Node 自带测试框架测试；`main.js` 只负责把它们和 Electron 接起来。窗口沿用现网页的 HTML/JS，通过预加载桥（preload）走 IPC，不开任何网络端口。三个 Swift 子程序沿用 `apple_asr/` 里的源码，编译成通用二进制随 App 打包。

**Tech Stack:** Node.js 22（Homebrew）、Electron（最新稳定版）、electron-builder、`@google/genai`、`@anthropic-ai/sdk`、`opencc-js`、`marked`、Node 内置 `node:test`、Swift 6（命令行工具自带）。

**Spec:** `docs/superpowers/specs/2026-10-07-desktop-app-design.md`

## Global Constraints

- App 名：`课堂同传`；appId：`local.nangua.classtranslator`；版本从 `0.1.0` 开始。
- 主窗口底部固定一行：`Powered by 南瓜`。
- 界面文字全部简体中文；所有中文输出（字幕、翻译、笔记、精讲）都必须经过繁转简。
- 翻译必须保留「带前 3 句上文 + 提示语音识别可能有错字」的提示词（原样移植 `llm.py` 的 `TRANSLATE_SYSTEM`）。苹果翻译只做备用。
- 只识别所选说话人语言，其他语言一律丢弃（苹果识别：按把握值 < 0.5 或文字特征过滤）。
- 不开本地网络端口；窗口 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- API key 只用 Electron `safeStorage` 加密保存；系统加密不可用时拒绝保存；界面只显示末 4 位；任何文件、日志里都不能出现明文 key。
- 课堂记录目录：`文稿/课堂同传`（`app.getPath("documents")/课堂同传`）；设置文件：`app.getPath("userData")/settings.json`，权限 600。
- 系统要求：App 本身 macOS 12+；苹果识别 / 苹果翻译 macOS 26+；电脑内部声音 macOS 14.2+。第 1 期只支持苹果识别，不支持的电脑要给出说明而不是报错。
- 安装包里不得出现 `.env`、`records/`、`.venv/`、`settings.json` 或任何 key 字符串（打包后自动检查，命中即失败）。
- 不修改现网页版文件（`server.py`、`llm.py`、`static/`、`apple_asr/*.swift`）。

## Review Focus

1. **乱填记录名 / 路径穿越**（如 `../../.env`）：读记录、读写课后精讲、生成精讲都必须拒绝，返回「找不到这节课的记录」，绝不能读到别的文件。→ Task 3、Task 8 有测试。
2. **粘贴 key 时带空格、换行或中文**：首尾空白要去掉后正常保存；中间有空格或中文要拒绝并提示格式不对；设置文件里绝不能出现明文。→ Task 4 有测试。
3. **上课中途苹果识别程序崩溃**：自动重启一次；再崩就停止识别并提示一次，已识别的字幕不能丢、App 不能崩。→ Task 7 有测试。
4. **录制中途关窗口 / 退出 App**：已识别的内容要存盘，苹果识别和系统录音子程序要被杀掉，不能留在后台。→ Task 7（dispose）、Task 8（窗口销毁时关闭会话）有测试。
5. **两个多小时的长课**：3000 句的记录能正常列出、时长按小时显示（`1h 5m 9s`）、课后精讲的时间戳超过 1 小时也正确。→ Task 3 有测试。

---

## 文件结构

```
desktop/
├─ package.json                 依赖与脚本
├─ electron-builder.yml         打包配置（Task 10）
├─ scripts/
│  ├─ build-helpers.sh          编译 Swift 子程序为通用二进制 → build/bin/
│  ├─ vendor.mjs                把 marked 复制到 src/renderer/vendor/
│  ├─ adhoc-sign.cjs            打包后对 .app 做 ad-hoc 签名
│  └─ check-package.mjs         检查安装包里没有机密文件 / key
├─ src/
│  ├─ main/
│  │  ├─ main.js                Electron 入口：建窗口、权限、接线、冒烟模式
│  │  ├─ langs.js               语言、模型、翻译方式等常量
│  │  ├─ text.js                繁转简、清理、去复读、语言判断、时间格式、错误提示
│  │  ├─ platform.js            这台电脑能用哪些功能
│  │  ├─ helpers.js             Swift 子程序路径
│  │  ├─ api.js                 窗口调用的接口（设置、记录、精讲、PDF…）
│  │  ├─ ipc.js                 IPC 接线：会话、音频、命令
│  │  ├─ pdf.js                 HTML → PDF 并另存
│  │  ├─ session.js             一节课的流水线
│  │  ├─ store/records.js       课堂记录与课后精讲文件
│  │  ├─ store/settings.js      偏好设置与加密 key
│  │  ├─ llm/errors.js          NoKey / AllModelsBusy / TimeoutError / withTimeout / isAuthError
│  │  ├─ llm/prompts.js         全部提示词（原样移植）
│  │  ├─ llm/gemini.js          Gemini 多模型轮换与冷却
│  │  ├─ llm/claude.js          Claude 调用
│  │  ├─ llm/index.js           LLM 门面：translate / summarize / report / testKey
│  │  └─ apple/
│  │     ├─ jsonl.js            启动「一行一个 JSON」的子程序
│  │     ├─ filter.js           苹果识别结果过滤
│  │     ├─ asr.js              苹果识别子程序
│  │     ├─ translate.js        苹果翻译子程序
│  │     └─ syscap.js           电脑内部声音子程序
│  ├─ preload/preload.cjs       暴露给窗口的白名单接口
│  └─ renderer/                 由 static/ 复制并改造：index.html、app.js、worklet.js、bridge.js、vendor/
└─ test/                        *.test.js（node:test）
```

---

### Task 1: 开发环境与项目骨架

**Files:**
- Create: `desktop/package.json`、`desktop/src/main/main.js`（骨架版）、`desktop/src/renderer/index.html`（占位）
- Modify: `.gitignore`

**Interfaces:**
- Produces: `npm test`（跑 `test/**/*.test.js`）、`npm start`（编译子程序 + 复制 marked + 启动 Electron）；环境变量 `CT_SMOKE_OPEN=1` 时窗口加载完打印 `window-loaded` 并退出。

- [ ] **Step 1: 安装 Node.js**

Run: `brew install node@22 && brew link --overwrite --force node@22 && node --version && npm --version`
Expected: 打印 `v22.x.x` 和 npm 版本号。

- [ ] **Step 2: 建目录、写 package.json**

```bash
mkdir -p ~/class-translator/desktop/{scripts,src/main/store,src/main/llm,src/main/apple,src/preload,src/renderer,test}
```

`desktop/package.json`：

```json
{
  "name": "class-translator",
  "productName": "课堂同传",
  "version": "0.1.0",
  "description": "课堂实时字幕与翻译",
  "author": "南瓜",
  "license": "MIT",
  "type": "module",
  "main": "src/main/main.js",
  "scripts": {
    "test": "node --test \"test/**/*.test.js\"",
    "helpers": "bash scripts/build-helpers.sh",
    "vendor": "node scripts/vendor.mjs",
    "start": "npm run helpers && npm run vendor && electron .",
    "dist": "npm run helpers && npm run vendor && electron-builder --mac && node scripts/check-package.mjs"
  }
}
```

- [ ] **Step 3: 安装依赖**

Run（在 `desktop/` 下）：
```bash
npm install @google/genai @anthropic-ai/sdk opencc-js marked
npm install -D electron electron-builder @electron/asar
```
Expected: 无报错，生成 `node_modules/` 和 `package-lock.json`。

- [ ] **Step 4: 忽略生成文件**

在仓库根 `.gitignore` 末尾追加：

```
# 桌面版生成物
desktop/node_modules/
desktop/dist/
desktop/build/
desktop/src/renderer/vendor/
```

- [ ] **Step 5: 骨架入口和占位页面**

`desktop/src/main/main.js`（Task 8 会替换成完整版）：

```js
import { app, BrowserWindow } from "electron";
import path from "node:path";

const here = import.meta.dirname;
app.setName("课堂同传");

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280, height: 820, title: "课堂同传",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadFile(path.join(here, "../renderer/index.html"));
  if (process.env.CT_SMOKE_OPEN) {
    win.webContents.once("did-finish-load", () => { console.log("window-loaded"); app.quit(); });
  }
});
app.on("window-all-closed", () => app.quit());
```

`desktop/src/renderer/index.html`（Task 9 会替换）：

```html
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>课堂同传</title></head>
<body><p>课堂同传</p><footer>Powered by 南瓜</footer></body></html>
```

- [ ] **Step 6: 验证窗口能打开**

Run（在 `desktop/` 下）：`CT_SMOKE_OPEN=1 npx electron .`
Expected: 输出含 `window-loaded`，进程自动退出。

- [ ] **Step 7: Commit**

```bash
cd ~/class-translator
git add .gitignore desktop/package.json desktop/package-lock.json desktop/src
git commit -m "桌面版：项目骨架（Electron 空窗口）"
```

---

### Task 2: 常量、文本工具、苹果识别过滤

**Files:**
- Create: `desktop/src/main/langs.js`、`desktop/src/main/llm/errors.js`、`desktop/src/main/text.js`、`desktop/src/main/apple/filter.js`
- Test: `desktop/test/text.test.js`、`desktop/test/filter.test.js`

**Interfaces:**
- Produces:
  - `langs.js`：`SPEAKER_LANGS`、`TARGET_LANGS`、`TRANSLATORS`、`APPLE_LOCALES`、`APPLE_TR_LANGS`、`CLAUDE_MODELS`、`FAST_MODELS: string[]`、`SUMMARY_MODELS: string[]`、`GEMINI_MODELS`、`SR = 16000`、`SUMMARY_INTERVAL_MS = 180000`
  - `llm/errors.js`：`class NoKey`、`class AllModelsBusy`、`class TimeoutError`、`withTimeout(promise, ms)`、`isAuthError(err): boolean`
  - `text.js`：`toSimplified(s)`、`simplify(text, target)`、`collapseRepeats(s)`、`clean(text, lang)`、`hasCJK(s)`、`appleLangOk(text, speaker)`、`fmtTs(seconds): "hh:mm:ss"`、`friendly(err): string`
  - `apple/filter.js`：`APPLE_MIN_CONF = 0.5`、`acceptPartial(text, speaker): boolean`、`acceptFinal({text, conf, start}, speaker): {text, lang, start} | null`

- [ ] **Step 1: 写失败的测试**

`desktop/test/text.test.js`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { clean, simplify, appleLangOk, collapseRepeats, fmtTs, friendly } from "../src/main/text.js";
import { NoKey, AllModelsBusy, TimeoutError, withTimeout, isAuthError } from "../src/main/llm/errors.js";

test("繁转简只在目标是中文时做", () => {
  assert.equal(simplify("這是一張吞食動物的蟒蛇的照片", "zh"), "这是一张吞食动物的蟒蛇的照片");
  assert.equal(simplify("這是", "en"), "這是");
  assert.equal(simplify("", "zh"), "");
});

test("clean：中文全角标点、去标点前空格、去幻觉、去复读", () => {
  assert.equal(clean("同学们好 ，今天讲第二定律 。", "zh"), "同学们好，今天讲第二定律。");
  assert.equal(clean("你好,对吗?", "zh"), "你好，对吗？");
  assert.equal(clean("Thank you.", "en"), "");
  assert.equal(clean("  Hello, world?  ", "en"), "Hello, world?");
  assert.equal(collapseRepeats("喝酒 喝酒 喝酒 喝酒 喝酒"), "喝酒");
});

test("appleLangOk：只认所选语言", () => {
  assert.equal(appleLangOk("Today we talk about entropy.", "en"), true);
  assert.equal(appleLangOk("同学们好", "en"), false);
  assert.equal(appleLangOk("同学们好", "zh"), true);
  assert.equal(appleLangOk("Today we are going to talk", "zh"), false);
  assert.equal(appleLangOk("ん今日は今は日里学", "zh"), false);
  assert.equal(appleLangOk("今日は", "ja"), true);
  assert.equal(appleLangOk("안녕하세요", "ko"), true);
  assert.equal(appleLangOk("Bonjour à tous", "fr"), true);
});

test("fmtTs 支持超过 1 小时", () => {
  assert.equal(fmtTs(0), "00:00:00");
  assert.equal(fmtTs(65.9), "00:01:05");
  assert.equal(fmtTs(3909.7), "01:05:09");
});

test("friendly：把报错翻成看得懂的中文", () => {
  assert.equal(friendly(new NoKey("还没填写 Gemini 的 API key")), "还没填写 Gemini 的 API key");
  assert.equal(friendly(new AllModelsBusy("x")), "Gemini 今天的免费额度用完了");
  assert.equal(friendly(new Error("429 GenerateRequestsPerDayPerProjectPerModel")), "Gemini 今天的免费额度用完了");
  assert.equal(friendly(new Error("503 UNAVAILABLE")), "服务器繁忙");
  assert.equal(friendly(new TimeoutError("x")), "响应超时");
  assert.equal(friendly(new Error("API key not valid. Please pass a valid API key.")), "API key 无效");
});

test("withTimeout 超时抛 TimeoutError；isAuthError 识别无效 key", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 20), TimeoutError);
  assert.equal(await withTimeout(Promise.resolve(1), 20), 1);
  assert.equal(isAuthError(Object.assign(new Error("x"), { status: 401 })), true);
  assert.equal(isAuthError(new Error("API key not valid")), true);
  assert.equal(isAuthError(new Error("503 UNAVAILABLE")), false);
});
```

`desktop/test/filter.test.js`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptFinal, acceptPartial } from "../src/main/apple/filter.js";

test("说的不是所选语言（把握低的拼音乱码）丢掉", () => {
  assert.equal(acceptFinal({ text: "Hong Shiemen Hao, Xin Tian woman", conf: 0.24, start: 1 }, "en"), null);
});
test("所选语言正常保留，带上开始时间", () => {
  assert.deepEqual(acceptFinal({ text: "Today we talk.", conf: 0.95, start: 1.5 }, "en"),
    { text: "Today we talk.", lang: "en", start: 1.5 });
});
test("中文清理标点；自动模式按英语记", () => {
  assert.deepEqual(acceptFinal({ text: "同学们好 ，今天", conf: 0.98, start: 0 }, "zh"),
    { text: "同学们好，今天", lang: "zh", start: 0 });
  assert.equal(acceptFinal({ text: "Today", conf: -1, start: 0 }, "auto").lang, "en");
});
test("中文模式下的英文（把握 0.76 也要靠文字特征挡掉）", () => {
  assert.equal(acceptFinal({ text: "Today we are going to talk", conf: 0.76, start: 0 }, "zh"), null);
});
test("草稿只能按文字特征过滤", () => {
  assert.equal(acceptPartial("Kong X", "zh"), false);
  assert.equal(acceptPartial("Kong X", "en"), true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run（在 `desktop/` 下）：`npm test`
Expected: FAIL，提示找不到 `../src/main/text.js` 等模块。

- [ ] **Step 3: 实现**

`desktop/src/main/langs.js`：

```js
// 网页上可选的语言、翻译方式、模型等常量（与网页版 server.py / llm.py 保持一致）
export const SPEAKER_LANGS = { auto: "自动（中/英）", en: "英语", zh: "中文", ja: "日语", ko: "韩语", fr: "法语", de: "德语", es: "西班牙语" };
export const TARGET_LANGS = { zh: "简体中文", en: "英语", ja: "日语", ko: "韩语", fr: "法语", de: "德语", es: "西班牙语" };
// Gemini / Claude 会结合上文纠正识别错字；苹果自带是本地直译，只做备用
export const TRANSLATORS = { gemini: "Gemini（推荐，会纠正识别错字）", claude: "Claude（会纠正识别错字）", apple: "苹果自带（免费、本地、直译）" };
export const APPLE_LOCALES = { auto: "en-US", en: "en-US", zh: "zh-CN", ja: "ja-JP", ko: "ko-KR", fr: "fr-FR", de: "de-DE", es: "es-ES" };
export const APPLE_TR_LANGS = { en: "en", zh: "zh-Hans", ja: "ja", ko: "ko", fr: "fr", de: "de", es: "es" };
export const CLAUDE_MODELS = {
  "claude-opus-5-5": "Claude Opus 5.5（最强）",
  "claude-sonnet-5-5": "Claude Sonnet 5.5（均衡）",
  "claude-haiku-4-5": "Claude Haiku 4.5（最快最便宜）",
};
// 免费版每个模型每天各有额度，多列几个模型 = 额度叠加；前一个繁忙 / 用完就换下一个
export const FAST_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.7-flash", "gemini-3.8-flash", "gemini-3.6-flash"];
export const SUMMARY_MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
export const GEMINI_MODELS = { auto: "自动轮换（推荐，几个模型的免费额度叠加）", ...Object.fromEntries(FAST_MODELS.map((m) => [m, m])) };
export const SR = 16000;
export const SUMMARY_INTERVAL_MS = 180_000; // 每隔多久自动更新一次课堂笔记
```

`desktop/src/main/llm/errors.js`：

```js
export class NoKey extends Error { name = "NoKey"; }               // 还没填这家的 API key
export class AllModelsBusy extends Error { name = "AllModelsBusy"; } // 所有 Gemini 模型都在冷却（额度用完 / 繁忙）
export class TimeoutError extends Error { name = "TimeoutError"; }

export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`超过 ${Math.round(ms / 1000)} 秒没有响应`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// key 本身无效（而不是额度用完、服务器忙）
export function isAuthError(err) {
  if ([401, 403].includes(err?.status)) return true;
  return /API key not valid|API_KEY_INVALID|invalid x-api-key|authentication_error/i.test(String(err?.message ?? err));
}
```

`desktop/src/main/text.js`：

```js
import * as OpenCC from "opencc-js";
import { NoKey, AllModelsBusy, TimeoutError } from "./llm/errors.js";

const t2s = OpenCC.Converter({ from: "t", to: "cn" });
const KANA = /[\u3040-\u30ff]/;
const HANGUL = /[\uac00-\ud7af]/;
const count = (re, s) => (s.match(re) || []).length;
// 识别在静音 / 噪音上常见的胡编
const HALLUCINATIONS = new Set(["thank you.", "thanks for watching!", "thank you for watching.", "you", "bye.",
  "thank you very much.", "please subscribe.", ".", "so", "okay."]);
const REPEAT_RE = /(\S+?)(?:[\s,，、。.]+\1){3,}/giu;

export const toSimplified = (s) => t2s(s);
export const hasCJK = (s) => /[\u4e00-\u9fff]/.test(s);

/** 输出中文时统一转简体：苹果翻译偶尔混进繁体（如"一張吞食動物"），AI 偶尔也会 */
export function simplify(text, target) {
  return target === "zh" && text ? t2s(text) : text;
}

/** 把"喝酒 喝酒 喝酒 ……"这类卡住复读合并成一个 */
export const collapseRepeats = (s) => s.replace(REPEAT_RE, "$1");

/** 识别结果统一清理：去复读、去幻觉、中文转简体 + 全角标点 + 去标点前空格 */
export function clean(text, lang) {
  let t = collapseRepeats(text.trim());
  if (HALLUCINATIONS.has(t.toLowerCase())) return "";
  if (lang === "zh") {
    t = t2s(t).replaceAll(",", "，").replaceAll("?", "？").replaceAll("!", "！");
    t = t.replace(/\s+([，。？！、；：])/g, "$1");
  }
  return t;
}

/** 苹果识别按所选语言硬识别，旁边别的语言会变成乱码：按文字特征挑出来 */
export function appleLangOk(text, speaker) {
  const cjk = count(/[\u4e00-\u9fff]/g, text), latin = count(/[A-Za-z]/g, text);
  if (speaker === "zh") return cjk > 0 && cjk >= latin && !KANA.test(text);
  if (speaker === "ja") return KANA.test(text) || cjk > 0;
  if (speaker === "ko") return HANGUL.test(text);
  return cjk === 0 && !KANA.test(text); // 英、法、德、西、自动（按英语）
}

export function fmtTs(seconds) {
  const s = Math.floor(seconds);
  return [s / 3600, (s % 3600) / 60, s % 60].map((n) => String(Math.floor(n)).padStart(2, "0")).join(":");
}

/** 把 API 报错翻成看得懂的中文 */
export function friendly(err) {
  const msg = String(err?.message ?? err);
  if (err instanceof NoKey) return msg;
  if (err instanceof AllModelsBusy || msg.includes("PerDay")) return "Gemini 今天的免费额度用完了";
  if (err instanceof TimeoutError) return "响应超时";
  if (msg.includes("429")) return "请求太频繁，被限流了";
  if (/503|UNAVAILABLE|overloaded/i.test(msg)) return "服务器繁忙";
  if (/API key|401|403|invalid x-api-key|authentication/i.test(msg)) return "API key 无效";
  return msg.slice(0, 80);
}
```

`desktop/src/main/apple/filter.js`：

```js
import { appleLangOk, clean } from "../text.js";

// 说的不是所选语言时，苹果识别会出拼音一样的乱码，把握通常只有 0.2~0.45
export const APPLE_MIN_CONF = 0.5;

/** 草稿没有把握值，只能按文字特征挡掉一部分（比如中文模式下的英文） */
export const acceptPartial = (text, speaker) => appleLangOk(text, speaker);

/** 确定下来的一句：清理 + 语言特征 + 把握值，不合格返回 null */
export function acceptFinal(m, speaker) {
  const text = clean(m.text ?? "", speaker === "zh" ? "zh" : "en");
  if (!text || !appleLangOk(text, speaker)) return null;
  const conf = m.conf ?? -1;
  if (conf >= 0 && conf < APPLE_MIN_CONF) return null;
  return { text, lang: speaker === "auto" ? "en" : speaker, start: m.start ?? 0 };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run：`npm test`
Expected: 全部 PASS。若 `simplify` 用例失败，检查 `opencc-js` 的 `Converter({ from: "t", to: "cn" })` 是否可用（`node -e 'import("opencc-js").then(m=>console.log(m.Converter({from:"t",to:"cn"})("這是一張")))'` 应打印 `这是一张`）。

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/langs.js desktop/src/main/llm/errors.js desktop/src/main/text.js desktop/src/main/apple/filter.js desktop/test/text.test.js desktop/test/filter.test.js
git commit -m "桌面版：常量、文本工具、苹果识别过滤"
```

---

### Task 3: 课堂记录存储

**Files:**
- Create: `desktop/src/main/store/records.js`
- Test: `desktop/test/records.test.js`

**Interfaces:**
- Consumes: `fmtTs` (Task 2)
- Produces:
  - `isValidName(name): boolean`（只接受 `^[\w-]+\.md$`）
  - `newRecordName(date = new Date()): "YYYY-MM-DD_HH-MM-SS.md"`
  - `recordMarkdown(stem, summary, lines): string`（`lines: {t, text, tr}[]`，格式与网页版一致）
  - `parseTranscript(md): [ts, text][]`
  - `reportMarkdown(outline, body, stem, lastTs): string`
  - `class Records(dir)`：`dir`、`newName()`、`exists(name)`、`save(name, summary, lines)`、`transcript(name)`（名字不合法抛错）、`list(): {name, stem, lines, minutes, hasReport, title}[]`（新的在前）、`readReport(name): {md, title} | null`、`writeReport(name, md): string`（返回精讲文件名）

- [ ] **Step 1: 写失败的测试**

`desktop/test/records.test.js`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Records, reportMarkdown, isValidName, newRecordName } from "../src/main/store/records.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ct-rec-"));
const NAME = "2026-10-07_09-00-00.md";

test("保存后能读回转写和列表", () => {
  const r = new Records(tmp());
  r.save(NAME, "笔记", [{ t: 0, text: "Hello", tr: "你好" }, { t: 65, text: "World", tr: "" }, { t: 3909, text: "Bye", tr: "再见" }]);
  assert.deepEqual(r.transcript(NAME), [["00:00:00", "Hello"], ["00:01:05", "World"], ["01:05:09", "Bye"]]);
  assert.deepEqual(r.list(), [{ name: NAME, stem: "2026-10-07_09-00-00", lines: 3, minutes: 65, hasReport: false, title: "" }]);
});

test("课后精讲：写入后列表显示标题，能读回", () => {
  const r = new Records(tmp());
  r.save(NAME, "", [{ t: 0, text: "a", tr: "" }]);
  assert.equal(r.writeReport(NAME, "# 热力学\n\n正文\n"), "2026-10-07_09-00-00_课后精讲.md");
  assert.deepEqual(r.readReport(NAME), { md: "# 热力学\n\n正文\n", title: "热力学" });
  assert.equal(r.list()[0].title, "热力学");
  assert.equal(r.list().length, 1, "精讲文件本身不能出现在列表里");
});

test("不合法的记录名一律拒绝，读不到别的文件", () => {
  const r = new Records(tmp());
  assert.equal(isValidName("../../.env"), false);
  assert.equal(isValidName("a/b.md"), false);
  assert.equal(isValidName("x_课后精讲.md"), false);
  assert.equal(isValidName(NAME), true);
  assert.throws(() => r.transcript("../x.md"));
  assert.equal(r.readReport("../../.env"), null);
  assert.equal(r.exists("../../.env"), false);
});

test("reportMarkdown：标题、上课时间、按小时的时长、章节", () => {
  const md = reportMarkdown(
    { title: "热力学", overview: "概述", chapters: [{ start: "00:00:00", end: "00:02:56", title: "引入", desc: "开场" }] },
    "## AI 精讲\n正文", "2026-10-06_23-42-48", "01:05:09");
  assert.match(md, /^# 热力学\n/);
  assert.match(md, /> 上课 2026-10-06 23:42 · 时长 1h 5m 9s/);
  assert.match(md, /- \*\*\[00:00:00 – 00:02:56\] 引入\*\*  \n  开场/);
  assert.match(md, /## AI 精讲\n正文\n$/);
});

test("两个半小时的长课（3000 句）能正常列出", () => {
  const r = new Records(tmp());
  r.save(NAME, "", Array.from({ length: 3000 }, (_, i) => ({ t: i * 3, text: `line ${i}`, tr: "" })));
  const [item] = r.list();
  assert.equal(item.lines, 3000);
  assert.equal(item.minutes, 149); // 最后一句 02:29:57
});

test("newRecordName 格式", () => {
  assert.equal(newRecordName(new Date(2026, 9, 7, 9, 5, 3)), "2026-10-07_09-05-03.md");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run：`npm test`
Expected: FAIL，找不到 `records.js`。

- [ ] **Step 3: 实现**

`desktop/src/main/store/records.js`：

```js
import fs from "node:fs";
import path from "node:path";
import { fmtTs } from "../text.js";

const NAME_RE = /^[\w-]+\.md$/;
const LINE_RE = /^\*\*\[(\d\d:\d\d:\d\d)\]\*\* (.+)$/;
const REPORT_SUFFIX = "_课后精讲.md";

export const isValidName = (name) => typeof name === "string" && NAME_RE.test(name);

export function newRecordName(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.md`;
}

/** 与网页版 records/*.md 格式一致 */
export function recordMarkdown(stem, summary, lines) {
  const parts = [`# 课堂记录 ${stem}\n`, "## AI 总结\n", summary || "（暂无）", "\n## 转写\n"];
  for (const l of lines) parts.push(`**[${fmtTs(l.t)}]** ${l.text}\n` + (l.tr ? `\n> ${l.tr}\n` : ""));
  return parts.join("\n");
}

export function parseTranscript(md) {
  return md.split("\n").map((l) => l.match(LINE_RE)).filter(Boolean).map((m) => [m[1], m[2]]);
}

export function reportMarkdown(outline, body, stem, lastTs) {
  const [h, m, s] = lastTs.split(":").map(Number);
  const mt = stem.match(/^(\d{4}-\d\d-\d\d)_(\d\d)-(\d\d)/);
  const started = mt ? `${mt[1]} ${mt[2]}:${mt[3]}` : stem;
  const parts = [`# ${outline.title || "课后精讲"}`, "", `> 上课 ${started} · 时长 ${h}h ${m}m ${s}s`, "",
    outline.overview ?? "", "", "## 章节大纲", ""];
  for (const c of outline.chapters ?? []) {
    parts.push(`- **[${c.start ?? ""} – ${c.end ?? ""}] ${c.title ?? ""}**  `, `  ${c.desc ?? ""}`);
  }
  return parts.join("\n") + "\n\n" + body.trim() + "\n";
}

export class Records {
  constructor(dir) { this.dir = dir; }
  newName() { return newRecordName(); }
  #file(name) {
    if (!isValidName(name)) throw new Error("记录名不合法");
    return path.join(this.dir, name);
  }
  #reportFile(name) { return path.join(this.dir, name.replace(/\.md$/, REPORT_SUFFIX)); }
  exists(name) { return isValidName(name) && fs.existsSync(path.join(this.dir, name)); }
  save(name, summary, lines) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.#file(name), recordMarkdown(name.replace(/\.md$/, ""), summary, lines), "utf8");
  }
  transcript(name) {
    const f = this.#file(name);
    return fs.existsSync(f) ? parseTranscript(fs.readFileSync(f, "utf8")) : [];
  }
  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter(isValidName).sort().reverse().flatMap((name) => {
      const lines = this.transcript(name);
      if (!lines.length) return [];
      const [h, m] = lines.at(-1)[0].split(":").map(Number);
      const report = this.readReport(name);
      return [{ name, stem: name.replace(/\.md$/, ""), lines: lines.length, minutes: h * 60 + m,
        hasReport: !!report, title: report?.title ?? "" }];
    });
  }
  readReport(name) {
    if (!isValidName(name)) return null;
    const f = this.#reportFile(name);
    if (!fs.existsSync(f)) return null;
    const md = fs.readFileSync(f, "utf8");
    return { md, title: md.split("\n", 1)[0].replace(/^#\s*/, "").trim() };
  }
  writeReport(name, md) {
    this.#file(name); // 校验名字
    const f = this.#reportFile(name);
    fs.writeFileSync(f, md, "utf8");
    return path.basename(f);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run：`npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/store/records.js desktop/test/records.test.js
git commit -m "桌面版：课堂记录与课后精讲文件存储"
```

---

### Task 4: 偏好设置与加密保存 key

**Files:**
- Create: `desktop/src/main/store/settings.js`
- Test: `desktop/test/settings.test.js`

**Interfaces:**
- Produces: `class Settings(file, crypto)`，`crypto` 形如 Electron `safeStorage`（`isEncryptionAvailable()`、`encryptString(s): Buffer`、`decryptString(buf): string`）。方法：`pref(key, def)`、`setPref(key, value)`、`getKey(provider): string`、`setKey(provider, value)`（去首尾空白；格式 `^[\w\-.]{10,300}$`；加密不可用抛错）、`clearKey(provider)`、`keyState(provider): {set, tail}`。`provider` 为 `"gemini" | "claude"`。

- [ ] **Step 1: 写失败的测试**

`desktop/test/settings.test.js`：

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run：`npm test`
Expected: FAIL，找不到 `settings.js`。

- [ ] **Step 3: 实现**

`desktop/src/main/store/settings.js`：

```js
import fs from "node:fs";
import path from "node:path";

const KEY_RE = /^[\w\-.]{10,300}$/;
const PROVIDERS = ["gemini", "claude"];

/** 偏好存普通 JSON；API key 用系统加密（Mac 钥匙串 / Windows DPAPI）后再存，绝不存明文 */
export class Settings {
  constructor(file, crypto) {
    this.file = file;
    this.crypto = crypto;
    try { this.data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { this.data = {}; }
    this.data.prefs ??= {};
    this.data.keys ??= {};
  }
  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }
  pref(key, def) { return this.data.prefs[key] ?? def; }
  setPref(key, value) { this.data.prefs[key] = value; this.#save(); }
  getKey(provider) {
    const enc = this.data.keys[provider];
    if (!enc) return "";
    try { return this.crypto.decryptString(Buffer.from(enc, "base64")); } catch { return ""; }
  }
  setKey(provider, value) {
    if (!PROVIDERS.includes(provider)) throw new Error("未知的服务");
    const v = String(value).trim();
    if (!KEY_RE.test(v)) throw new Error("API key 格式不对（不能有空格或中文）");
    if (!this.crypto.isEncryptionAvailable()) throw new Error("系统加密不可用，无法安全保存 key");
    this.data.keys[provider] = this.crypto.encryptString(v).toString("base64");
    this.#save();
  }
  clearKey(provider) { delete this.data.keys[provider]; this.#save(); }
  keyState(provider) {
    const v = this.getKey(provider);
    return { set: !!v, tail: v.length > 8 ? v.slice(-4) : "" }; // 只给末 4 位
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run：`npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/store/settings.js desktop/test/settings.test.js
git commit -m "桌面版：偏好设置与加密保存 API key"
```

---

### Task 5: AI 调用（Gemini / Claude）

**Files:**
- Create: `desktop/src/main/llm/prompts.js`、`desktop/src/main/llm/gemini.js`、`desktop/src/main/llm/claude.js`、`desktop/src/main/llm/index.js`
- Test: `desktop/test/llm.test.js`

**Interfaces:**
- Consumes: `NoKey`、`AllModelsBusy`、`TimeoutError`、`withTimeout`（Task 2）；`FAST_MODELS`、`SUMMARY_MODELS`（Task 2）；`Settings.pref` / `Settings.getKey`（Task 4）
- Produces:
  - `gemini.js`：`orderModels(models, pref): string[]`、`class GeminiPool(client, now = Date.now)` 的 `generate(models, request, timeoutMs)`（`request` 为 `{contents, config}`）
  - `claude.js`：`askClaude(client, model, {system, prompt, effort, maxTokens}): Promise<string>`
  - `index.js`：`parseJson(text)`；`class LLM(settings, factories?)`：`configure()`、`available(): ("gemini"|"claude")[]`、`ask(provider, {system, prompt, effort, maxTokens, timeoutMs, json})`、`translate(sentence, context, targetLabel, provider)`、`summarize(transcript, previous, targetLabel, provider)`、`report(transcript, targetLabel, provider): {outline, body}`、`testKey(provider)`

- [ ] **Step 1: 核对 SDK 接口名**

Run（在 `desktop/` 下）：
```bash
grep -n "class GoogleGenAI\|generateContent(\|class ApiError\|status:" node_modules/@google/genai/dist/genai.d.ts | head -20
grep -rn "fallbacks\|output_config" node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts | head -10
```
Expected: 能看到 `GoogleGenAI`、`models.generateContent`、`ApiError`（带 `status` 数字字段），以及 Anthropic beta messages 参数里的 `output_config`、`fallbacks`。若名字不同，以 d.ts 为准修改下面代码里对应的字段名，并在提交说明里写明。

- [ ] **Step 2: 写失败的测试**

`desktop/test/llm.test.js`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiPool, orderModels } from "../src/main/llm/gemini.js";
import { askClaude } from "../src/main/llm/claude.js";
import { LLM, parseJson } from "../src/main/llm/index.js";
import { NoKey, AllModelsBusy } from "../src/main/llm/errors.js";

const err = (status, message) => Object.assign(new Error(message), { status });
function fakeGemini(behave = {}) {
  const calls = [];
  return { calls, models: { generateContent: async (req) => {
    calls.push(req);
    const b = typeof behave === "function" ? behave(req) : behave[req.model];
    if (b instanceof Error) throw b;
    if (b === "hang") return new Promise(() => {});
    return { text: b ?? `ok:${req.model}` };
  } } };
}

test("额度用完的模型被记住，之后直接跳过", async () => {
  const c = fakeGemini({ a: err(429, 'GenerateRequestsPerDayPerProjectPerModel "retryDelay": "3600s"') });
  const pool = new GeminiPool(c, () => 0);
  assert.equal((await pool.generate(["a", "b"], {}, 1000)).text, "ok:b");
  assert.equal((await pool.generate(["a", "b"], {}, 1000)).text, "ok:b");
  assert.deepEqual(c.calls.map((r) => r.model), ["a", "b", "b"]);
});

test("超时的模型换下一个", async () => {
  const pool = new GeminiPool(fakeGemini({ a: "hang" }), () => 0);
  assert.equal((await pool.generate(["a", "b"], {}, 30)).text, "ok:b");
});

test("全部用完：第一次抛原错误，之后抛 AllModelsBusy", async () => {
  const quota = err(429, "PerDay");
  const pool = new GeminiPool(fakeGemini({ a: quota, b: quota }), () => 0);
  await assert.rejects(pool.generate(["a", "b"], {}, 1000), /PerDay/);
  await assert.rejects(pool.generate(["a", "b"], {}, 1000), AllModelsBusy);
});

test("其他错误（比如 key 无效）直接抛出，不换模型", async () => {
  const c = fakeGemini({ a: err(400, "API key not valid") });
  await assert.rejects(new GeminiPool(c, () => 0).generate(["a", "b"], {}, 1000), /API key not valid/);
  assert.equal(c.calls.length, 1);
});

test("指定的模型排到最前", () => {
  assert.deepEqual(orderModels(["a", "b", "c"], "c"), ["c", "a", "b"]);
  assert.deepEqual(orderModels(["a", "b"], "auto"), ["a", "b"]);
});

const settings = (keys = {}, prefs = {}) => ({ getKey: (p) => keys[p] ?? "", pref: (k, d) => prefs[k] ?? d });

test("没填 key：available 为空，调用抛 NoKey", async () => {
  const llm = new LLM(settings(), { gemini: () => fakeGemini(), claude: () => ({}) });
  assert.deepEqual(llm.available(), []);
  await assert.rejects(llm.translate("hi", [], "简体中文", "gemini"), NoKey);
});

test("翻译带上文和纠错提示词", async () => {
  const g = fakeGemini(() => " 你好 ");
  const llm = new LLM(settings({ gemini: "k" }), { gemini: () => g, claude: () => ({}) });
  assert.equal(await llm.translate("C", ["A", "B"], "简体中文", "gemini"), "你好");
  const req = g.calls[0];
  assert.equal(req.contents, "【上文】\nA\nB\n\n【当前句】\nC");
  assert.match(req.config.systemInstruction, /语音识别可能有错字/);
  assert.equal(req.model, "gemini-3.5-flash-lite");
});

test("课后精讲两步：先 JSON 大纲（可能带 ```json 包裹）再正文", async () => {
  const g = fakeGemini((req) => req.config.responseMimeType === "application/json"
    ? '```json\n{"title":"T","overview":"O","chapters":[{"start":"00:00:00","end":"00:01:00","title":"c","desc":"d"}]}\n```'
    : "## AI 精讲\nbody");
  const llm = new LLM(settings({ gemini: "k" }), { gemini: () => g, claude: () => ({}) });
  const { outline, body } = await llm.report("[00:00:00] hi", "简体中文", "gemini");
  assert.equal(outline.title, "T");
  assert.equal(body, "## AI 精讲\nbody");
  assert.match(g.calls[1].contents, /章节大纲：\n\[00:00:00 – 00:01:00\] c：d/);
  assert.throws(() => parseJson("没有 JSON"), /格式不对/);
});

test("Claude：取文字、拒绝时给提示、Haiku 不带 effort", async () => {
  const sent = [];
  const client = { beta: { messages: { create: async (p) => { sent.push(p); return p.model === "x"
    ? { stop_reason: "refusal", content: [] } : { stop_reason: "end_turn", content: [{ type: "text", text: " 你好 " }] }; } } } };
  assert.equal(await askClaude(client, "claude-opus-5-5", { system: "s", prompt: "p", effort: "low", maxTokens: 10 }), "你好");
  assert.equal(sent[0].output_config.effort, "low");
  assert.equal(sent[0].fallbacks, "default");
  await askClaude(client, "claude-haiku-4-5", { system: "s", prompt: "p", effort: "low", maxTokens: 10 });
  assert.equal(sent[1].output_config, undefined);
  assert.equal(await askClaude(client, "x", { system: "s", prompt: "p", effort: "low", maxTokens: 10 }), "（模型拒绝处理该段）");
});
```

- [ ] **Step 3: 运行测试确认失败**

Run：`npm test`
Expected: FAIL，找不到 `llm/gemini.js` 等。

- [ ] **Step 4: 实现提示词（原样移植 llm.py）**

`desktop/src/main/llm/prompts.js`：

```js
// 全部提示词原样移植自网页版 llm.py。TRANSLATE_SYSTEM 的「上文 + 纠错」是南瓜明确要求保留的。
export const TRANSLATE_SYSTEM = (target) =>
  `你是课堂同声传译。把用户给出的【当前句】翻译成自然、准确的${target}。` +
  "【上文】只用于理解语境，不要翻译上文。专业术语可在译文后括号保留原词（原词若明显识别错误，括号里写正确拼写）。" +
  "语音识别可能有错字，请按语境合理理解。只输出译文，不要任何解释。";

export const SUMMARY_SYSTEM = (target) =>
  `你是课堂笔记助手。根据课堂转写，用${target}整理结构化笔记（Markdown）。` +
  "格式：用 `- **关键词**：说明` 的要点列表，按主题分组（可用 ### 小标题），" +
  "保留公式、数字、例子和老师强调的重点（作业、考试、截止日期要单独标出）。" +
  "忽略闲聊和口头禅。只输出笔记本身。";

export const REPORT_OUTLINE_SYSTEM = (target) =>
  "你是课堂笔记助手。下面是一整节课带时间戳的转写（语音识别可能有错字，请按上下文理解）。" +
  `请用${target}输出 JSON：\n` +
  '{"title": "这节课的标题（15 字以内）", "overview": "3~4 句概述：讲了哪些内容、用到哪些工具或方法", ' +
  '"chapters": [{"start": "hh:mm:ss", "end": "hh:mm:ss", "title": "章节标题（12 字以内）", ' +
  '"desc": "1~2 句话：这一段讲了什么"}]}\n' +
  "章节要求：按时间顺序覆盖整节课，不重叠；start/end 必须用转写里真实出现的时间戳；" +
  "按话题切分，大约每 5~10 分钟一章，短课就少几章，不要硬凑。闲聊、调试设备之类的内容并入相邻章节。只输出 JSON。";

export const REPORT_BODY_SYSTEM = (target) =>
  "你是课堂笔记助手，要把一整节课整理成学生复习用的「课后精讲」。下面给出章节大纲和带时间戳的完整转写" +
  `（语音识别可能有错字，请按上下文理解、纠正）。用${target}输出 Markdown，严格包含以下四个二级标题，顺序不变：\n` +
  "## AI 精讲\n" +
  "先写一段导读（这节课的主线、建议的阅读顺序）。然后按主题写若干个 ### 小节（主题可以合并相邻章节）。" +
  "每个小节先用一两段讲解文字讲清概念和老师的论证思路，再按内容需要选用：时间线或步骤（有序列表）、" +
  "对比表（Markdown 表格）、具体例子、类比。老师强调的重点用 **加粗**。需要提醒的地方用引用块，" +
  "第一行写「> **注意事项**」；你补充的背景知识（老师没讲、但有助于理解）必须放在「> **补充说明**」引用块里，" +
  "和老师讲的内容区分开；类比放在「> **类比**」引用块里。作业、考试、截止日期、评分规则要完整列出，一个都不能漏。\n" +
  "## 术语表\n" +
  "每个术语一行：「- **术语（英文原词）**：一句话解释」。\n" +
  "## 思考题\n" +
  "4~6 道有深度的题目，有序列表，每题下一行写「提示：……」。\n" +
  "## 核心要点\n" +
  "5~8 条有序列表，每条「**要点标题**：一句话说明」。\n" +
  "篇幅与课程长度匹配：短课写短，不要编造课上没有的内容（补充说明除外）。不要输出这四部分以外的内容。";
```

- [ ] **Step 5: 实现 Gemini 轮换、Claude 调用、LLM 门面**

`desktop/src/main/llm/gemini.js`：

```js
import { AllModelsBusy, TimeoutError, withTimeout } from "./errors.js";

/** 指定了优先模型就排到最前；额度用完仍会自动换后面的 */
export function orderModels(models, pref) {
  const list = [...models];
  const i = list.indexOf(pref);
  if (i > 0) { list.splice(i, 1); list.unshift(pref); }
  return list;
}

/** 按顺序试模型；记住哪些模型额度用完 / 繁忙 / 超时，冷却期内直接跳过 */
export class GeminiPool {
  constructor(client, now = Date.now) {
    this.client = client;
    this.now = now;
    this.cooldown = new Map();
  }
  async generate(models, request, timeoutMs) {
    let lastErr = null;
    for (const model of models) {
      if ((this.cooldown.get(model) ?? 0) > this.now()) continue;
      try {
        return await withTimeout(this.client.models.generateContent({ model, ...request }), timeoutMs);
      } catch (e) {
        const status = e?.status ?? e?.code;
        const msg = String(e?.message ?? e);
        if (e instanceof TimeoutError) this.cooldown.set(model, this.now() + 60_000);
        else if (status === 429 && msg.includes("PerDay")) {
          const m = msg.match(/retryDelay["']?\s*:\s*["']?(\d+)s/);
          this.cooldown.set(model, this.now() + (m ? Number(m[1]) : 6 * 3600) * 1000);
        } else if (status === 429) this.cooldown.set(model, this.now() + 60_000);
        else if ([500, 503, 504].includes(status)) this.cooldown.set(model, this.now() + 15_000);
        else throw e;
        lastErr = e;
      }
    }
    throw lastErr ?? new AllModelsBusy("所有模型都在冷却中");
  }
}
```

`desktop/src/main/llm/claude.js`：

```js
/** 调 Claude；Opus / Sonnet 打开服务端兜底（被拒时自动换模型），Haiku 不支持 effort / fallbacks */
export async function askClaude(client, model, { system, prompt, effort, maxTokens }) {
  const extra = model.includes("haiku") ? {} : {
    output_config: { effort },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };
  const resp = await client.beta.messages.create({
    model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }], ...extra,
  });
  if (resp.stop_reason === "refusal") return "（模型拒绝处理该段）";
  return resp.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}
```

`desktop/src/main/llm/index.js`：

```js
import { GoogleGenAI } from "@google/genai";
import Anthropic from "@anthropic-ai/sdk";
import { FAST_MODELS, SUMMARY_MODELS } from "../langs.js";
import { NoKey, withTimeout } from "./errors.js";
import { GeminiPool, orderModels } from "./gemini.js";
import { askClaude } from "./claude.js";
import { TRANSLATE_SYSTEM, SUMMARY_SYSTEM, REPORT_OUTLINE_SYSTEM, REPORT_BODY_SYSTEM } from "./prompts.js";

const DEFAULT_FACTORIES = {
  gemini: (apiKey) => new GoogleGenAI({ apiKey }),
  claude: (apiKey) => new Anthropic({ apiKey, maxRetries: 1 }),
};

export function parseJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/); // 去掉模型可能加的 ```json 包裹
  if (!m) throw new Error("AI 返回的章节格式不对");
  return JSON.parse(m[0]);
}

export class LLM {
  constructor(settings, factories = DEFAULT_FACTORIES) {
    this.settings = settings;
    this.factories = factories;
    this.configure();
  }
  /** 按当前保存的 key 建客户端；改了 key 之后再调一次就立即生效 */
  configure() {
    const g = this.settings.getKey("gemini"), c = this.settings.getKey("claude");
    this.gemini = g ? new GeminiPool(this.factories.gemini(g)) : null;
    this.claude = c ? this.factories.claude(c) : null;
  }
  available() { return [this.gemini && "gemini", this.claude && "claude"].filter(Boolean); }

  async ask(provider, { system, prompt, effort, maxTokens, timeoutMs, json = false }) {
    if (provider === "gemini") {
      if (!this.gemini) throw new NoKey("还没填写 Gemini 的 API key");
      const models = orderModels(effort === "low" ? FAST_MODELS : SUMMARY_MODELS, this.settings.pref("geminiModel", "auto"));
      const config = { systemInstruction: system, ...(json ? { responseMimeType: "application/json" } : {}) };
      const resp = await this.gemini.generate(models, { contents: prompt, config }, timeoutMs);
      return String(resp.text ?? "").trim();
    }
    if (provider === "claude") {
      if (!this.claude) throw new NoKey("还没填写 Claude 的 API key");
      const model = this.settings.pref("claudeModel", "claude-opus-5-5");
      return withTimeout(askClaude(this.claude, model, { system, prompt, effort, maxTokens }), timeoutMs);
    }
    throw new Error(`未知的服务：${provider}`);
  }

  translate(sentence, context, targetLabel, provider) {
    const ctx = context.slice(-3).join("\n") || "（无）";
    return this.ask(provider, { system: TRANSLATE_SYSTEM(targetLabel), prompt: `【上文】\n${ctx}\n\n【当前句】\n${sentence}`,
      effort: "low", maxTokens: 2048, timeoutMs: 10_000 });
  }

  summarize(transcript, previous, targetLabel, provider) {
    let prompt = `课堂转写如下：\n\n${transcript}`;
    if (previous) prompt = `已有笔记（请在此基础上更新、合并，不要丢失已有重点）：\n\n${previous}\n\n` + prompt;
    return this.ask(provider, { system: SUMMARY_SYSTEM(targetLabel), prompt, effort: "medium", maxTokens: 16000, timeoutMs: 120_000 });
  }

  /** 课后精讲：先切带时间的章节（JSON），再写正文。transcript 每行「[hh:mm:ss] 原话」 */
  async report(transcript, targetLabel, provider) {
    const outline = parseJson(await this.ask(provider, { system: REPORT_OUTLINE_SYSTEM(targetLabel), prompt: transcript,
      effort: "medium", maxTokens: 8000, timeoutMs: 300_000, json: true }));
    const chapters = (outline.chapters ?? []).map((c) => `[${c.start} – ${c.end}] ${c.title}：${c.desc}`).join("\n");
    const prompt = `课程标题：${outline.title ?? ""}\n\n章节大纲：\n${chapters}\n\n完整转写：\n${transcript}`;
    const body = await this.ask(provider, { system: REPORT_BODY_SYSTEM(targetLabel), prompt,
      effort: "high", maxTokens: 16000, timeoutMs: 600_000 });
    return { outline, body };
  }

  /** 保存 key 时测一下能不能用 */
  testKey(provider) {
    return this.ask(provider, { system: "只回复 ok", prompt: "ok", effort: "low", maxTokens: 16, timeoutMs: 20_000 });
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run：`npm test`
Expected: 全部 PASS。

- [ ] **Step 7: Commit**

```bash
git add desktop/src/main/llm desktop/test/llm.test.js
git commit -m "桌面版：Gemini 多模型轮换、Claude 调用、翻译 / 笔记 / 课后精讲"
```

---

### Task 6: Swift 子程序打包与 Node 封装

**Files:**
- Create: `desktop/scripts/build-helpers.sh`、`desktop/src/main/helpers.js`、`desktop/src/main/apple/jsonl.js`、`desktop/src/main/apple/asr.js`、`desktop/src/main/apple/translate.js`、`desktop/src/main/apple/syscap.js`
- Test: `desktop/test/apple.int.test.js`（集成测试：真跑子程序，需 macOS 26 和 `build/bin`）

**Interfaces:**
- Consumes: `APPLE_LOCALES`、`APPLE_TR_LANGS`（Task 2）；`withTimeout`（Task 2）
- Produces:
  - `helperPaths({isPackaged, resourcesPath, devDir}): {asr, translate, syscap}`
  - `spawnJsonl(bin, args, onMessage): {proc, done: Promise<number>, write(data), end(), kill()}`（被 `kill()` 杀掉时 `done` 结果为 `-1`）
  - `class AppleASR(bin, speaker, offset)`（EventEmitter）：属性 `speaker`、`offset`；`start()`、`feed(buf)`、`close(timeoutMs = 10000)`、`kill()`；事件 `"message"`（`{type: "partial"|"final"|"downloading"|"ready"|"error", ...}`）、`"exit"`（退出码）
  - `class AppleTranslator(bin)`：`translate(text, src, tgt): {tr, code}`、`status(src, tgt): "installed"|"supported"|"unsupported"`、`stop()`
  - `class SystemAudio(bin)`（EventEmitter）：`start()`、`stop()`；事件 `"data"`（Buffer，16kHz int16）、`"problem"`（中文说明）

- [ ] **Step 1: 编译脚本**

`desktop/scripts/build-helpers.sh`：

```bash
#!/bin/bash
# 把 ../apple_asr/*.swift 编译成苹果芯片 + Intel 通用二进制，放到 build/bin/
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=../apple_asr
OUT=build/bin
mkdir -p "$OUT"

build() { # 名字 源文件 最低系统版本
  local name=$1 src=$2 min=$3
  if [ "$OUT/$name" -nt "$SRC/$src" ]; then return; fi  # 源码没变就不重编
  for arch in arm64 x86_64; do
    swiftc -O -swift-version 5 -target "$arch-apple-macos$min" "$SRC/$src" -o "$OUT/$name-$arch"
  done
  lipo -create "$OUT/$name-arm64" "$OUT/$name-x86_64" -output "$OUT/$name"
  rm "$OUT/$name-arm64" "$OUT/$name-x86_64"
  codesign --force --sign - "$OUT/$name"
  echo "已编译 $name"
}

build apple_asr main.swift 26.0       # 苹果语音识别（SpeechAnalyzer）
build apple_translate translate.swift 26.0  # 苹果翻译
build syscap syscap.swift 14.2        # 电脑内部声音（Core Audio Tap）
```

Run（在 `desktop/` 下）：`npm run helpers && lipo -info build/bin/*`
Expected: 三个文件都显示 `x86_64 arm64`。若 x86_64 编译失败，把该次报错贴进提交说明，并临时只编 arm64（第 1 期只在苹果芯片 Mac 上验证）。

- [ ] **Step 2: 写失败的集成测试**

`desktop/test/apple.int.test.js`：

```js
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
```

- [ ] **Step 3: 运行测试确认失败**

Run：`npm test`
Expected: FAIL，找不到 `helpers.js` 等。

- [ ] **Step 4: 实现**

`desktop/src/main/helpers.js`：

```js
import path from "node:path";

/** Swift 子程序的位置：开发时在 build/bin，打包后在 App 的 Resources/bin */
export function helperPaths({ isPackaged, resourcesPath, devDir }) {
  const dir = isPackaged ? path.join(resourcesPath, "bin") : devDir;
  return { asr: path.join(dir, "apple_asr"), translate: path.join(dir, "apple_translate"), syscap: path.join(dir, "syscap") };
}
```

`desktop/src/main/apple/jsonl.js`：

```js
import { spawn } from "node:child_process";
import readline from "node:readline";

/** 启动一个「标准输出一行一个 JSON」的子程序；被 kill() 杀掉时 done 的结果是 -1 */
export function spawnJsonl(bin, args, onMessage) {
  const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "ignore"] });
  proc.stdin.on("error", () => {}); // 子程序先退出时写入会 EPIPE，忽略
  proc.on("error", () => {});
  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    onMessage(m);
  });
  const done = new Promise((resolve) => proc.on("close", (code, signal) => resolve(signal ? -1 : (code ?? -1))));
  const alive = () => proc.exitCode === null && proc.signalCode === null;
  return {
    proc, done,
    write: (data) => { if (alive() && proc.stdin.writable) proc.stdin.write(data); },
    end: () => { if (proc.stdin.writable) proc.stdin.end(); },
    kill: () => { if (alive()) proc.kill("SIGKILL"); },
  };
}
```

`desktop/src/main/apple/asr.js`：

```js
import { EventEmitter } from "node:events";
import { spawnJsonl } from "./jsonl.js";
import { APPLE_LOCALES } from "../langs.js";

/** 苹果自带语音识别：持续喂 16kHz int16 音频，边说边吐出草稿（partial）和确定句（final） */
export class AppleASR extends EventEmitter {
  constructor(bin, speaker, offset) {
    super();
    this.bin = bin;
    this.speaker = speaker;
    this.offset = offset; // 这个识别进程开始时，这节课已经录了多少秒
    this.p = null;
  }
  start() {
    this.p = spawnJsonl(this.bin, [APPLE_LOCALES[this.speaker] ?? "en-US"], (m) => this.emit("message", m));
    this.p.done.then((code) => this.emit("exit", code));
  }
  feed(buf) { this.p?.write(buf); }
  /** 不再送音频，等最后一句确定下来；超时就强制结束 */
  async close(timeoutMs = 10_000) {
    if (!this.p) return;
    this.p.end();
    const timer = setTimeout(() => this.p.kill(), timeoutMs);
    await this.p.done;
    clearTimeout(timer);
  }
  kill() { this.p?.kill(); }
}
```

`desktop/src/main/apple/translate.js`：

```js
import fs from "node:fs";
import { execFile } from "node:child_process";
import { spawnJsonl } from "./jsonl.js";
import { APPLE_TR_LANGS } from "../langs.js";
import { withTimeout } from "../llm/errors.js";

/** 苹果自带翻译的常驻子程序（所有会话共用），一行一个请求 */
export class AppleTranslator {
  constructor(bin) {
    this.bin = bin;
    this.p = null;
    this.pending = new Map();
    this.nextId = 0;
  }
  #supported(src, tgt) { return src in APPLE_TR_LANGS && tgt in APPLE_TR_LANGS && fs.existsSync(this.bin); }
  #ensure() {
    if (this.p && this.p.proc.exitCode === null && this.p.proc.signalCode === null) return;
    const p = spawnJsonl(this.bin, [], (m) => {
      const resolve = this.pending.get(m.id);
      if (resolve) { this.pending.delete(m.id); resolve(m); }
    });
    p.done.then(() => { // 进程意外退出：没回的请求都按失败处理
      if (this.p !== p) return;
      for (const resolve of this.pending.values()) resolve({ error: "苹果翻译程序退出了", code: "failed" });
      this.pending.clear();
    });
    this.p = p;
  }
  /** 返回 {tr, code}：code 为空表示成功，not_installed 表示还没下载这对语言 */
  async translate(text, src, tgt) {
    if (!this.#supported(src, tgt)) return { tr: "", code: "unsupported" };
    this.#ensure();
    const id = ++this.nextId;
    const reply = new Promise((resolve) => this.pending.set(id, resolve));
    this.p.write(JSON.stringify({ id, text, src: APPLE_TR_LANGS[src], tgt: APPLE_TR_LANGS[tgt] }) + "\n");
    try {
      const m = await withTimeout(reply, 15_000);
      return { tr: m.tr ?? "", code: m.code ?? "" };
    } catch {
      this.pending.delete(id);
      return { tr: "", code: "failed" };
    }
  }
  /** installed / supported（能下载但还没下载）/ unsupported */
  status(src, tgt) {
    if (!this.#supported(src, tgt)) return Promise.resolve("unsupported");
    return new Promise((resolve) => execFile(this.bin, ["check", APPLE_TR_LANGS[src], APPLE_TR_LANGS[tgt]],
      (_err, out) => resolve(String(out ?? "").trim() || "unsupported")));
  }
  stop() { this.p?.kill(); this.p = null; }
}
```

`desktop/src/main/apple/syscap.js`：

```js
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";

/** 录电脑内部正在播放的声音（视频、网课）：子程序从标准输出持续吐 16kHz int16 PCM */
export class SystemAudio extends EventEmitter {
  constructor(bin) { super(); this.bin = bin; this.proc = null; }
  start() {
    const proc = spawn(this.bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    proc.on("error", (e) => this.emit("problem", String(e.message)));
    proc.stdin.on("error", () => {});
    proc.stdout.on("data", (b) => this.emit("data", b));
    readline.createInterface({ input: proc.stderr }).on("line", (line) => {
      try {
        const m = JSON.parse(line);
        if (m.type === "error") this.emit("problem", m.msg);
      } catch {}
    });
    this.proc = proc;
  }
  stop() {
    if (this.proc && this.proc.exitCode === null) this.proc.kill("SIGTERM");
    this.proc = null;
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run：`npm test`
Expected: 全部 PASS（非 macOS 26 时集成测试显示 skipped）。第一次运行可能弹出「终端想录制系统音频」，点允许后重跑。

- [ ] **Step 6: Commit**

```bash
git add desktop/scripts/build-helpers.sh desktop/src/main/helpers.js desktop/src/main/apple desktop/test/apple.int.test.js
git commit -m "桌面版：Swift 子程序编译脚本与 Node 封装（苹果识别 / 翻译 / 系统声音）"
```

---

### Task 7: 一节课的流水线（Session）

**Files:**
- Create: `desktop/src/main/session.js`
- Test: `desktop/test/session.test.js`

**Interfaces:**
- Consumes: `TARGET_LANGS`、`TRANSLATORS`、`SPEAKER_LANGS`、`SR`、`SUMMARY_INTERVAL_MS`（Task 2）；`simplify`、`friendly`（Task 2）；`acceptFinal`、`acceptPartial`（Task 2）；`NoKey`、`AllModelsBusy`（Task 2）；`Records.newName/save`（Task 3）；`LLM.translate/summarize/available`（Task 5）；`AppleTranslator.translate`（Task 6）；`AppleASR` 的接口（Task 6，测试用假对象）
- Produces: `class Session({send, llm, appleTr, records, caps, makeAsr, sleep?, now?})`：属性 `name`、`lines`、`paused`；方法 `configure(cfg)`、`audio(buf)`、`addLine(text, lang, tr, t)`、`updateSummary(final = false)`、`stop()`、`idle()`、`dispose()`。发给窗口的消息与网页版一致：`partial`、`line`、`translation`、`summary`、`summary_status`、`error`、`done`。

- [ ] **Step 1: 写失败的测试**

`desktop/test/session.test.js`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session } from "../src/main/session.js";
import { AllModelsBusy } from "../src/main/llm/errors.js";

class FakeAsr extends EventEmitter {
  constructor(speaker, offset) { super(); Object.assign(this, { speaker, offset, fed: 0, closed: false, killed: false }); }
  start() {}
  feed(b) { this.fed += b.length; }
  async close() { this.closed = true; }
  kill() { this.killed = true; }
}

function setup({ llm = {}, appleTr = {}, caps = { appleAsr: true } } = {}) {
  const sent = [], asrs = [], saved = [];
  const s = new Session({
    send: (m) => sent.push(m),
    llm: { available: () => ["gemini"], translate: async (t) => `译:${t}`, summarize: async () => "笔记", ...llm },
    appleTr: { translate: async () => ({ tr: "苹果译", code: "" }), ...appleTr },
    records: { newName: () => "2026-10-07_09-00-00.md", save: (_n, _s, lines) => saved.push(lines.length) },
    caps,
    makeAsr: (sp, off) => { const a = new FakeAsr(sp, off); asrs.push(a); return a; },
    sleep: async () => {},
  });
  s.configure({ speaker: "en", target: "zh", asr: "apple", translator: "gemini" });
  return { s, sent, asrs, saved };
}
const pcm = (sec) => Buffer.alloc(sec * 32000);
const final = (text, conf = 0.95, start = 0) => ({ type: "final", text, conf, start });
const errors = (sent) => sent.filter((m) => m.type === "error").map((m) => m.msg);

test("确定句 → 字幕 + 后台翻译 + 存盘；草稿照发", async () => {
  const { s, sent, asrs, saved } = setup();
  s.audio(pcm(1));
  asrs[0].emit("message", { type: "partial", text: "Today we" });
  asrs[0].emit("message", final("Today we talk about entropy.", 0.95, 0.5));
  await s.idle();
  assert.deepEqual(sent.find((m) => m.type === "partial"), { type: "partial", text: "Today we" });
  const line = sent.find((m) => m.type === "line");
  assert.equal(line.text, "Today we talk about entropy.");
  assert.equal(line.t, 0.5);
  assert.deepEqual(sent.find((m) => m.type === "translation"), { type: "translation", id: 0, tr: "译:Today we talk about entropy." });
  assert.ok(saved.length >= 2);
});

test("其他语言的乱码不出字幕", async () => {
  const { s, sent, asrs } = setup();
  s.audio(pcm(1));
  asrs[0].emit("message", final("Hong Shiemen Hao, Xin Tian woman", 0.24));
  await s.idle();
  assert.equal(sent.filter((m) => m.type === "line").length, 0);
});

test("中途换说话人语言：关掉旧识别，新识别从当前时间算起", () => {
  const { s, asrs } = setup();
  s.audio(pcm(2));
  s.configure({ speaker: "zh" });
  assert.equal(asrs[0].closed, true);
  s.audio(pcm(1));
  assert.equal(asrs[1].speaker, "zh");
  assert.equal(asrs[1].offset, 2);
});

test("Gemini 额度用完：改用苹果翻译，只提示一次", async () => {
  const { s, sent, asrs } = setup({ llm: { translate: async () => { throw new AllModelsBusy("x"); } } });
  s.audio(pcm(1));
  asrs[0].emit("message", final("First sentence here."));
  asrs[0].emit("message", final("Second sentence here."));
  await s.idle();
  assert.deepEqual(sent.filter((m) => m.type === "translation").map((m) => m.tr), ["苹果译", "苹果译"]);
  assert.equal(errors(sent).filter((m) => m.includes("苹果翻译")).length, 1);
});

test("苹果翻译出的繁体转成简体", async () => {
  const { s, sent, asrs } = setup({ appleTr: { translate: async () => ({ tr: "這是一張吞食動物的照片", code: "" }) } });
  s.configure({ translator: "apple" });
  s.audio(pcm(1));
  asrs[0].emit("message", final("It was a picture."));
  await s.idle();
  assert.equal(sent.find((m) => m.type === "translation").tr, "这是一张吞食动物的照片");
});

test("10 秒内一字不差的重复句只留一条", async () => {
  const { s, sent, asrs } = setup();
  s.audio(pcm(1));
  asrs[0].emit("message", final("I can't get more from you.", 0.95, 1));
  asrs[0].emit("message", final("I can't get more from you.", 0.95, 3));
  await s.idle();
  assert.equal(sent.filter((m) => m.type === "line").length, 1);
});

test("识别程序崩溃：自动重启一次；再崩就停止并只提示一次，字幕不丢", async () => {
  const { s, sent, asrs } = setup();
  s.audio(pcm(1));
  asrs[0].emit("message", final("Kept line."));
  asrs[0].emit("exit", 1);
  s.audio(pcm(1));
  assert.equal(asrs.length, 2, "第一次崩溃后应自动重启");
  asrs[1].emit("exit", 1);
  s.audio(pcm(1));
  s.audio(pcm(1));
  assert.equal(asrs.length, 2, "第二次崩溃后不再重启");
  assert.equal(errors(sent).filter((m) => m.includes("连续出错")).length, 1);
  assert.equal(s.lines.length, 1);
});

test("被我们自己关掉（exit -1 / 0）不算崩溃", () => {
  const { s, asrs } = setup();
  s.audio(pcm(1)); asrs[0].emit("exit", -1);
  s.audio(pcm(1)); asrs[1].emit("exit", 0);
  s.audio(pcm(1));
  assert.equal(asrs.length, 3);
});

test("结束录制：关识别、等翻译、生成最终笔记、发 done", async () => {
  const { s, sent, asrs } = setup();
  s.audio(pcm(1));
  asrs[0].emit("message", final("A sentence."));
  await s.stop();
  assert.equal(asrs[0].closed, true);
  assert.ok(sent.some((m) => m.type === "summary" && m.md === "笔记"));
  assert.deepEqual(sent.at(-1), { type: "done", record: "2026-10-07_09-00-00.md" });
});

test("关窗口 / 退出（dispose）：杀掉识别程序并存盘", () => {
  const { s, asrs, saved } = setup();
  s.audio(pcm(1));
  asrs[0].emit("message", final("Save me."));
  const before = saved.length;
  s.dispose();
  assert.equal(asrs[0].killed, true);
  assert.ok(saved.length > before);
});

test("不支持苹果识别的电脑：只提示一次，不崩", () => {
  const { s, sent, asrs } = setup({ caps: { appleAsr: false } });
  s.audio(pcm(1)); s.audio(pcm(1));
  assert.equal(asrs.length, 0);
  assert.equal(errors(sent).length, 1);
  assert.match(errors(sent)[0], /macOS 26/);
});

test("暂停时不送音频", () => {
  const { s, asrs } = setup();
  s.paused = true;
  s.audio(pcm(1));
  assert.equal(asrs.length, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run：`npm test`
Expected: FAIL，找不到 `session.js`。

- [ ] **Step 3: 实现**

`desktop/src/main/session.js`：

```js
import { TARGET_LANGS, TRANSLATORS, SPEAKER_LANGS, SR, SUMMARY_INTERVAL_MS } from "./langs.js";
import { simplify, friendly } from "./text.js";
import { acceptFinal, acceptPartial } from "./apple/filter.js";
import { AllModelsBusy, NoKey } from "./llm/errors.js";

const DEFAULTS = { speaker: "en", target: "zh", asr: "apple", translator: "gemini" };
const MAX_PARALLEL_TRANSLATIONS = 6;

/** 一节课：收音频 → 苹果识别 → 字幕 → 后台翻译 → 定时更新笔记 → 每句存盘 */
export class Session {
  constructor({ send, llm, appleTr, records, caps, makeAsr, sleep, now }) {
    Object.assign(this, { send, llm, appleTr, records, caps, makeAsr });
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = now ?? Date.now;
    this.cfg = { ...DEFAULTS };
    this.name = records.newName();
    this.lines = [];
    this.summary = "";
    this.summarizedUpto = 0;
    this.summarizing = false;
    this.lastSummaryAt = this.now();
    this.translations = new Set();
    this.active = 0;
    this.waiters = [];
    this.samples = 0;         // 已收到的音频样本数，用来算时间
    this.asr = null;
    this.asrCrashes = 0;
    this.appleFailed = "";    // 连续崩溃的说话人语言，不再重启
    this.paused = false;
    this.fallbackNoted = false;
    this.warned = new Set();
  }

  configure(cfg = {}) {
    const speakerChanged = cfg.speaker && this.asr && cfg.speaker !== this.asr.speaker;
    if (this.asr && (speakerChanged || (cfg.asr && cfg.asr !== "apple"))) {
      const old = this.asr; // 说到一半的那句会先确定下来
      this.asr = null;
      old.close();
    }
    if (cfg.speaker in SPEAKER_LANGS) this.cfg.speaker = cfg.speaker;
    if (cfg.target in TARGET_LANGS) this.cfg.target = cfg.target;
    if (cfg.asr) this.cfg.asr = cfg.asr;
    if (cfg.translator in TRANSLATORS && cfg.translator !== this.cfg.translator) {
      this.cfg.translator = cfg.translator;
      this.fallbackNoted = false;
    }
  }

  warnOnce(key, msg) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.send({ type: "error", msg });
  }

  audio(buf) {
    if (this.paused) return;
    if (this.cfg.asr !== "apple" || !this.caps.appleAsr) {
      return this.warnOnce("no-asr", "这台电脑暂时不能识别语音：苹果自带识别需要 macOS 26 或更新。旧电脑的云端识别会在下个版本加入。");
    }
    if (this.appleFailed === this.cfg.speaker) {
      return this.warnOnce("crash", "苹果识别连续出错，已停止识别。请结束录制后重新开始；如果还不行，检查系统设置里的语音识别是否可用。");
    }
    if (!this.asr) this.startAsr();
    this.asr.feed(buf);
    this.samples += buf.length / 2;
  }

  startAsr() {
    const asr = this.makeAsr(this.cfg.speaker, this.samples / SR);
    asr.on("message", (m) => this.onAsr(asr, m));
    asr.on("exit", (code) => {
      if (this.asr === asr) this.asr = null;
      if (code !== 0 && code !== -1) {      // -1 是我们自己关掉的
        this.asrCrashes += 1;
        if (this.asrCrashes >= 2) this.appleFailed = asr.speaker; // 下一段音频时自动重启一次，再崩就停
      }
    });
    asr.start();
    this.asr = asr;
  }

  onAsr(asr, m) {
    if (m.type === "partial") {
      if (acceptPartial(m.text ?? "", asr.speaker)) this.send({ type: "partial", text: m.text });
    } else if (m.type === "final") {
      this.send({ type: "partial", text: "" });
      const r = acceptFinal(m, asr.speaker);
      if (r) this.addLine(r.text, r.lang, "", asr.offset + r.start);
    } else if (m.type === "downloading") {
      this.send({ type: "error", msg: "第一次用这种语言，正在下载苹果语音模型，稍等片刻…" });
    } else if (m.type === "error") {
      this.send({ type: "error", msg: `苹果识别出错：${String(m.msg ?? "").slice(0, 60)}` });
    }
  }

  /** 新增一句字幕：去重、推给窗口、需要的话后台翻译 */
  addLine(text, lang, tr, t) {
    const target = this.cfg.target;
    const context = this.lines.slice(-3).map((l) => l.text);
    const last = this.lines.at(-1);
    if (last && last.text === text && t - last.t < 10) return null; // 几秒内一字不差的重复，多半是杂音胡编
    const line = { id: this.lines.length, t, text, tr: "", lang, same: lang === target };
    this.lines.push(line);
    if (!line.same) line.tr = simplify(tr, target);
    this.send({ type: "line", ...line });
    if (!(line.same || line.tr)) {
      const p = this.translateLine(line, context, target);
      this.translations.add(p);
      p.finally(() => this.translations.delete(p));
    }
    this.save();
    if (this.now() - this.lastSummaryAt >= SUMMARY_INTERVAL_MS) this.updateSummary();
    return line;
  }

  async withSlot(fn) {
    while (this.active >= MAX_PARALLEL_TRANSLATIONS) await new Promise((r) => this.waiters.push(r));
    this.active += 1;
    try { return await fn(); } finally { this.active -= 1; this.waiters.shift()?.(); }
  }

  async translateLine(line, context, target) {
    const tr = await this.withSlot(() => this.translateText(line.text, line.lang, context, target));
    line.tr = simplify(tr, target);
    this.send({ type: "translation", id: line.id, tr: line.tr });
    this.save();
  }

  /** 按选的翻译方式翻；Gemini / Claude 用不了时改用苹果翻译顶上 */
  async translateText(text, src, context, target) {
    let err = null;
    if (this.cfg.translator !== "apple") {
      for (const wait of [0, 3000, 8000]) { // 失败了等一会儿再试，最多 3 次
        if (wait) await this.sleep(wait);
        try {
          return await this.llm.translate(text, context, TARGET_LANGS[target], this.cfg.translator);
        } catch (e) {
          err = e;
          if (e instanceof AllModelsBusy || e instanceof NoKey || String(e?.message).includes("PerDay")) break;
        }
      }
    }
    const { tr, code } = await this.appleTr.translate(text, src, target);
    if (tr) {
      if (err && !this.fallbackNoted) {
        this.fallbackNoted = true;
        const who = this.cfg.translator === "claude" ? "Claude" : "Gemini";
        this.send({ type: "error", msg: `${who} 用不了（${friendly(err)}），先改用苹果翻译顶上（直译，不会纠正识别错字）` });
      }
      return tr;
    }
    if (err) return `（翻译失败：${friendly(err)}）`;
    if (code === "not_installed") { // 苹果翻译还没下载这对语言：有 key 就先用 AI 翻
      for (const p of this.llm.available()) {
        try { return await this.llm.translate(text, context, TARGET_LANGS[target], p); } catch {}
      }
      return "（苹果翻译还没下载这对语言，请在「AI 模型与 API」里点「打开系统设置下载语言」）";
    }
    return "（翻译失败：苹果翻译不支持这对语言）";
  }

  summaryProvider() {
    const avail = this.llm.available();
    if (avail.includes(this.cfg.translator)) return this.cfg.translator;
    if (avail.length) return avail[0];
    throw new NoKey("要生成课堂笔记，需要先在「AI 模型与 API」里填写 Gemini 或 Claude 的 key");
  }

  async updateSummary(final = false) {
    if (this.summarizing || !this.lines.length) return;
    this.summarizing = true;
    this.lastSummaryAt = this.now();
    this.send({ type: "summary_status", busy: true });
    try {
      const label = TARGET_LANGS[this.cfg.target];
      if (final) {
        this.summary = await this.llm.summarize(this.lines.map((l) => l.text).join("\n"), "", label, this.summaryProvider());
        this.summarizedUpto = this.lines.length;
      } else {
        const fresh = this.lines.slice(this.summarizedUpto);
        if (fresh.length) {
          const upto = this.lines.length;
          this.summary = await this.llm.summarize(fresh.map((l) => l.text).join("\n"), this.summary, label, this.summaryProvider());
          this.summarizedUpto = upto;
        }
      }
      this.summary = simplify(this.summary, this.cfg.target);
      this.send({ type: "summary", md: this.summary });
      this.save();
    } catch (e) {
      this.send({ type: "error", msg: `课堂笔记更新失败：${friendly(e)}` });
    } finally {
      this.summarizing = false;
      this.send({ type: "summary_status", busy: false });
    }
  }

  async idle() { while (this.translations.size) await Promise.allSettled([...this.translations]); }

  /** 结束录制：最后一句确定下来 → 等翻译 → 最终笔记 → 通知窗口 */
  async stop() {
    if (this.asr) { const a = this.asr; this.asr = null; await a.close(); }
    await this.idle();
    await this.updateSummary(true);
    this.save();
    this.send({ type: "done", record: this.name });
  }

  /** 关窗口 / 退出：立刻杀掉子程序并存盘 */
  dispose() {
    if (this.asr) { this.asr.kill(); this.asr = null; }
    this.save();
  }

  save() { if (this.lines.length) this.records.save(this.name, this.summary, this.lines); }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run：`npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/session.js desktop/test/session.test.js
git commit -m "桌面版：一节课的流水线（识别、翻译兜底、笔记、崩溃重启、存盘）"
```

---

### Task 8: 接口、IPC 与主进程

**Files:**
- Create: `desktop/src/main/platform.js`、`desktop/src/main/api.js`、`desktop/src/main/ipc.js`、`desktop/src/main/pdf.js`、`desktop/src/preload/preload.cjs`
- Modify: `desktop/src/main/main.js`（替换骨架）
- Test: `desktop/test/api.test.js`、`desktop/test/platform.test.js`

**Interfaces:**
- Consumes: Task 2–7 的全部模块
- Produces:
  - `capabilities({platform, version, has, bins}): {platform, version, appleAsr, appleTranslate, systemAudio}`
  - `createApi(deps): (url, method, body) => Promise<object>`；`deps = {settings, llm, appleTr, records, caps, version, openExternal, openPath, askMic, savePdf}`。接口：`GET /api/app-info`、`POST /api/privacy-accepted`、`POST /api/mic-access`、`GET /api/settings?src=&tgt=`、`POST /api/settings`、`GET /api/records`、`GET /api/report?record=`、`POST /api/report`、`POST /api/open-translation-settings`、`POST /api/open-records-folder`、`POST /api/pdf`
  - `registerIpc({ipcMain, api, makeSession, makeSystemAudio})`；IPC 通道：`api`（invoke）、`session:open`（invoke，返回 `{record}`）、`session:audio`、`session:cmd`、`session:close`（send）、主进程推送 `session:msg`
  - 预加载 `window.api`：`call(url, method, body)`、`openSession()`、`sendAudio(buf)`、`sendCmd(str)`、`closeSession()`、`onMessage(cb): () => void`
  - `main.js` 环境变量：`CT_SMOKE_OPEN=1`（加载完打印页面状态并退出）、`CT_SMOKE_WAV=<wav>`（不开窗口，按实时速度把 wav 喂给一节课并打印消息）、`CT_RECORDS_DIR`（覆盖记录目录，冒烟测试用）

- [ ] **Step 1: 写失败的测试**

`desktop/test/platform.test.js`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilities } from "../src/main/platform.js";

const bins = { asr: "a", translate: "t", syscap: "s" };
const caps = (platform, version, has = () => true) => capabilities({ platform, version, has, bins });

test("新 Mac：全部可用", () => {
  assert.deepEqual(caps("darwin", "26.0.1"), { platform: "darwin", version: "26.0.1", appleAsr: true, appleTranslate: true, systemAudio: true });
  assert.equal(caps("darwin", "27.0").appleAsr, true);
});
test("macOS 15：没有苹果识别，但能录系统声音", () => {
  const c = caps("darwin", "15.4");
  assert.equal(c.appleAsr, false);
  assert.equal(c.systemAudio, true);
});
test("macOS 14.1 录不了系统声音；子程序缺失也算不可用", () => {
  assert.equal(caps("darwin", "14.1").systemAudio, false);
  assert.equal(caps("darwin", "26.0", () => false).appleAsr, false);
});
test("Windows 第 1 期什么都不支持", () => {
  assert.deepEqual(caps("win32", "10.0.22631"), { platform: "win32", version: "10.0.22631", appleAsr: false, appleTranslate: false, systemAudio: false });
});
```

`desktop/test/api.test.js`：

```js
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
  assert.equal(r.title, "熱力學");
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
```

- [ ] **Step 2: 运行测试确认失败**

Run：`npm test`
Expected: FAIL，找不到 `platform.js`、`api.js`。

- [ ] **Step 3: 实现 platform.js 和 api.js**

`desktop/src/main/platform.js`：

```js
/** 这台电脑能用哪些功能（第 1 期只有苹果系能力；Windows / 云端识别在第 2 期） */
export function capabilities({ platform, version, has, bins }) {
  const [maj = 0, min = 0] = String(version).split(".").map(Number);
  const atLeast = (a, b) => maj > a || (maj === a && min >= b);
  const mac = platform === "darwin";
  return {
    platform, version,
    appleAsr: mac && atLeast(26, 0) && has(bins.asr),
    appleTranslate: mac && atLeast(26, 0) && has(bins.translate),
    systemAudio: mac && atLeast(14, 2) && has(bins.syscap),
  };
}
```

`desktop/src/main/api.js`：

```js
import { CLAUDE_MODELS, GEMINI_MODELS, TARGET_LANGS, TRANSLATORS } from "./langs.js";
import { friendly, simplify } from "./text.js";
import { isAuthError } from "./llm/errors.js";
import { reportMarkdown } from "./store/records.js";

const LABEL = { gemini: "Gemini", claude: "Claude" };
const safeName = (s) => String(s ?? "课后精讲").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);

/** 窗口调用的全部接口（与网页版 /api/* 同名同参数，前端改动最小） */
export function createApi({ settings, llm, appleTr, records, caps, version, openExternal, openPath, askMic, savePdf }) {
  async function getSettings(q) {
    const src = q.get("src") ?? "en", tgt = q.get("tgt") ?? "zh";
    const translators = { ...TRANSLATORS };
    if (!caps.appleTranslate) delete translators.apple;
    return {
      gemini: settings.keyState("gemini"), claude: settings.keyState("claude"),
      gemini_model: settings.pref("geminiModel", "auto"), gemini_models: GEMINI_MODELS,
      claude_model: settings.pref("claudeModel", "claude-opus-5-5"), claude_models: CLAUDE_MODELS,
      translators,
      apple: caps.appleTranslate ? await appleTr.status(src, tgt) : "unsupported",
    };
  }

  async function saveSettings(b = {}) {
    const notes = [];
    if (b.gemini_model in GEMINI_MODELS) settings.setPref("geminiModel", b.gemini_model);
    if (b.claude_model in CLAUDE_MODELS) settings.setPref("claudeModel", b.claude_model);
    for (const p of ["gemini", "claude"]) {
      if (b[`clear_${p}_key`]) { settings.clearKey(p); continue; }
      const value = String(b[`${p}_key`] ?? "").trim();
      if (!value) continue;
      const old = settings.getKey(p);
      try { settings.setKey(p, value); } catch (e) { return { ok: false, msg: e.message }; }
      llm.configure();
      try {
        await llm.testKey(p);
      } catch (e) {
        if (isAuthError(e)) { // key 本身不对：恢复原来的
          if (old) settings.setKey(p, old); else settings.clearKey(p);
          llm.configure();
          return { ok: false, msg: `${LABEL[p]} 的 key 不能用：${friendly(e)}` };
        }
        notes.push(`${LABEL[p]} 的 key 已保存（测试时${friendly(e)}，不影响使用）`);
      }
    }
    llm.configure();
    return { ok: true, msg: notes.join("；") };
  }

  async function makeReport(b = {}) {
    const name = b.record;
    if (!records.exists(name)) return { ok: false, msg: "找不到这节课的记录" };
    const lines = records.transcript(name);
    if (lines.length < 3) return { ok: false, msg: "这节课内容太少，不用生成课后精讲" };
    const avail = llm.available();
    const provider = avail.includes(b.translator) ? b.translator : avail[0];
    if (!provider) return { ok: false, msg: "要生成课后精讲，需要先在「AI 模型与 API」里填写 Gemini 或 Claude 的 key" };
    const target = b.target in TARGET_LANGS ? b.target : "zh";
    const transcript = lines.map(([t, text]) => `[${t}] ${text}`).join("\n");
    try {
      const { outline, body } = await llm.report(transcript, TARGET_LANGS[target], provider);
      const md = simplify(reportMarkdown(outline, body, name.replace(/\.md$/, ""), lines.at(-1)[0]), target);
      const file = records.writeReport(name, md);
      return { ok: true, md, file, title: md.split("\n", 1)[0].replace(/^#\s*/, "") };
    } catch (e) {
      return { ok: false, msg: `课后精讲生成失败：${friendly(e)}` };
    }
  }

  return async function handle(url, method = "GET", body) {
    const u = new URL(url, "app://local");
    const q = u.searchParams;
    switch (`${method} ${u.pathname}`) {
      case "GET /api/app-info": return { caps, version, privacyAccepted: settings.pref("privacyAccepted", false) };
      case "POST /api/privacy-accepted": settings.setPref("privacyAccepted", true); return { ok: true };
      case "POST /api/mic-access": return { granted: await askMic() };
      case "GET /api/settings": return getSettings(q);
      case "POST /api/settings": return saveSettings(body);
      case "GET /api/records": return records.list();
      case "GET /api/report": {
        const r = records.readReport(q.get("record"));
        return r ? { ok: true, ...r } : { ok: false };
      }
      case "POST /api/report": return makeReport(body);
      case "POST /api/open-translation-settings":
        openExternal("x-apple.systempreferences:com.apple.Localization-Settings.extension");
        return { ok: true };
      case "POST /api/open-records-folder": openPath(records.dir); return { ok: true };
      case "POST /api/pdf": return savePdf(String(body?.html ?? ""), safeName(body?.name));
      default: throw new Error(`未知接口：${method} ${u.pathname}`);
    }
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run：`npm test`
Expected: 全部 PASS。

- [ ] **Step 5: 实现 PDF、IPC、预加载、主进程**

`desktop/src/main/pdf.js`：

```js
import fs from "node:fs";
import { BrowserWindow, dialog } from "electron";

/** 把排好版的 HTML 打成 A4 PDF，让用户选位置保存 */
export async function savePdf(parent, html, name) {
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    const { canceled, filePath } = await dialog.showSaveDialog(parent, {
      defaultPath: `${name}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (canceled || !filePath) return { ok: false, msg: "" };
    fs.writeFileSync(filePath, pdf);
    return { ok: true, file: filePath };
  } finally {
    win.destroy();
  }
}
```

`desktop/src/main/ipc.js`：

```js
const SYS_HINT = "请到 系统设置 → 隐私与安全性 → 录屏与系统录音 里允许「课堂同传」";

/** 窗口 ↔ 后台：每个窗口最多一节进行中的课 */
export function registerIpc({ ipcMain, api, makeSession, makeSystemAudio }) {
  const live = new Map(); // webContents.id → {session, sys, send}
  const closeFor = (id) => {
    const x = live.get(id);
    if (!x) return;
    x.sys?.stop();
    x.session.dispose();
    live.delete(id);
  };

  ipcMain.handle("api", (_e, { url, method, body }) => api(url, method, body));

  ipcMain.handle("session:open", (e) => {
    const wc = e.sender;
    closeFor(wc.id);
    const send = (m) => { if (!wc.isDestroyed()) wc.send("session:msg", m); };
    const session = makeSession(send);
    live.set(wc.id, { session, sys: null, send });
    wc.once("destroyed", () => closeFor(wc.id)); // 关窗口：存盘并杀掉子程序
    return { record: session.name };
  });

  ipcMain.on("session:audio", (e, data) => {
    const x = live.get(e.sender.id);
    if (x && !x.sys) x.session.audio(Buffer.from(data));
  });

  ipcMain.on("session:cmd", async (e, cmd) => {
    const x = live.get(e.sender.id);
    if (!x) return;
    if (cmd.startsWith("{")) {
      const cfg = JSON.parse(cmd);
      x.session.configure(cfg);
      if (cfg.source === "system" && !x.sys) {
        x.sys = makeSystemAudio();
        x.sys.on("data", (b) => x.session.audio(b));
        x.sys.on("problem", (msg) => x.send({ type: "error", msg: `录不到电脑内部声音：${msg}。${SYS_HINT}` }));
        x.sys.start();
      } else if (cfg.source === "mic" && x.sys) {
        x.sys.stop();
        x.sys = null;
      }
    } else if (cmd === "pause") x.session.paused = true;
    else if (cmd === "resume") x.session.paused = false;
    else if (cmd === "summary") x.session.updateSummary();
    else if (cmd === "stop") {
      x.sys?.stop();
      x.sys = null;
      await x.session.stop();
    }
  });

  ipcMain.on("session:close", (e) => closeFor(e.sender.id));
}
```

`desktop/src/preload/preload.cjs`：

```js
// 只把这几个白名单接口暴露给窗口；窗口拿不到 Node / Electron 的其他能力
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  call: (url, method = "GET", body) => ipcRenderer.invoke("api", { url, method, body }),
  openSession: () => ipcRenderer.invoke("session:open"),
  sendAudio: (buf) => ipcRenderer.send("session:audio", buf),
  sendCmd: (cmd) => ipcRenderer.send("session:cmd", cmd),
  closeSession: () => ipcRenderer.send("session:close"),
  onMessage: (cb) => {
    const handler = (_e, m) => cb(m);
    ipcRenderer.on("session:msg", handler);
    return () => ipcRenderer.removeListener("session:msg", handler);
  },
});
```

`desktop/src/main/main.js`（整个替换 Task 1 的骨架）：

```js
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, ipcMain, safeStorage, session, shell, systemPreferences } from "electron";
import { SR } from "./langs.js";
import { Settings } from "./store/settings.js";
import { Records } from "./store/records.js";
import { LLM } from "./llm/index.js";
import { AppleASR } from "./apple/asr.js";
import { AppleTranslator } from "./apple/translate.js";
import { SystemAudio } from "./apple/syscap.js";
import { helperPaths } from "./helpers.js";
import { capabilities } from "./platform.js";
import { createApi } from "./api.js";
import { registerIpc } from "./ipc.js";
import { Session } from "./session.js";
import { savePdf } from "./pdf.js";

const here = import.meta.dirname;
app.setName("课堂同传");
let mainWindow = null;

function build() {
  const bins = helperPaths({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, devDir: path.join(here, "../../build/bin") });
  const caps = capabilities({ platform: process.platform, version: process.getSystemVersion(), has: (p) => fs.existsSync(p), bins });
  const settings = new Settings(path.join(app.getPath("userData"), "settings.json"), safeStorage);
  const records = new Records(process.env.CT_RECORDS_DIR ?? path.join(app.getPath("documents"), "课堂同传"));
  const llm = new LLM(settings);
  const appleTr = new AppleTranslator(bins.translate);
  const makeSession = (send) => new Session({
    send, llm, appleTr, records, caps,
    makeAsr: (speaker, offset) => new AppleASR(bins.asr, speaker, offset),
  });
  const api = createApi({
    settings, llm, appleTr, records, caps, version: app.getVersion(),
    openExternal: (u) => shell.openExternal(u),
    openPath: (p) => { fs.mkdirSync(p, { recursive: true }); return shell.openPath(p); },
    askMic: () => (process.platform === "darwin" ? systemPreferences.askForMediaAccess("microphone") : Promise.resolve(true)),
    savePdf: (html, name) => savePdf(mainWindow, html, name),
  });
  return { api, makeSession, makeSystemAudio: () => new SystemAudio(bins.syscap), appleTr };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600, title: "课堂同传",
    webPreferences: { preload: path.join(here, "../preload/preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadFile(path.join(here, "../renderer/index.html"));
  return win;
}

/** 冒烟测试：不开窗口，按实时速度把一段 wav 喂给一节课，打印所有消息 */
async function runSmoke({ makeSession }) {
  const wav = fs.readFileSync(process.env.CT_SMOKE_WAV);
  const pcm = wav.subarray(wav.indexOf("data") + 8);
  const s = makeSession((m) => console.log("SMOKE " + JSON.stringify(m)));
  s.configure({ speaker: process.env.CT_SMOKE_SPEAKER ?? "en", target: "zh", asr: "apple", translator: process.env.CT_SMOKE_TRANSLATOR ?? "apple" });
  for (const chunk of [pcm, Buffer.alloc(SR * 2 * 2)]) {
    for (let i = 0; i < chunk.length; i += 3200) {
      s.audio(chunk.subarray(i, i + 3200));
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await s.stop();
  app.quit();
}

async function main() {
  await app.whenReady();
  const deps = build();
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "media"));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === "media");
  if (process.env.CT_SMOKE_WAV) return runSmoke(deps);
  registerIpc({ ipcMain, ...deps });
  mainWindow = createWindow();
  if (process.env.CT_SMOKE_OPEN) {
    mainWindow.webContents.on("console-message", (_e, _lvl, msg) => console.log("CONSOLE " + msg));
    mainWindow.webContents.once("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const state = await mainWindow.webContents.executeJavaScript(
        `JSON.stringify({ powered: document.querySelector(".powered")?.textContent, asr: [...document.querySelectorAll("#asr option")].map(o => o.textContent) })`);
      console.log("window-loaded " + state);
      app.quit();
    });
  }
  app.on("window-all-closed", () => { deps.appleTr.stop(); app.quit(); });
}

main();
```

- [ ] **Step 6: 冒烟测试整条流水线（不开窗口）**

Run（在 `desktop/` 下）：
```bash
T=$(mktemp -d)
say -v Samantha -o $T/a.aiff "Good morning everyone. Today we will continue our discussion of thermodynamics. The second law tells us that the entropy of an isolated system never decreases."
afconvert -f WAVE -d LEI16@16000 -c 1 $T/a.aiff $T/a.wav
CT_SMOKE_WAV=$T/a.wav CT_RECORDS_DIR=$T/records npx electron . | grep SMOKE | grep -v '"partial"'
ls $T/records
```
Expected: 打印若干 `"type":"line"`（内容含 `thermodynamics`）、对应的 `"type":"translation"`（苹果翻译未下载时会是 AI 译文或提示）、最后 `"type":"done"`；`$T/records` 里有一个 `.md` 记录文件。

- [ ] **Step 7: Commit**

```bash
git add desktop/src/main desktop/src/preload desktop/test/api.test.js desktop/test/platform.test.js
git commit -m "桌面版：接口、IPC、主进程（无网络端口）与冒烟测试模式"
```

---

### Task 9: 界面移植

**Files:**
- Create: `desktop/src/renderer/index.html`、`app.js`、`worklet.js`（由 `static/` 复制后改造）、`desktop/src/renderer/bridge.js`、`desktop/scripts/vendor.mjs`
- Test: `CT_SMOKE_OPEN=1` 冒烟检查 + 手动清单

**Interfaces:**
- Consumes: 预加载的 `window.api`（Task 8）；所有 `/api/*` 接口（Task 8）
- Produces: `bridge.js` 提供 `apiFetch(url, opts)`（返回 `{json()}`，与 `fetch` 用法一致）和 `openSessionSocket()`（返回类 WebSocket 对象：`readyState`、`send()`、`close()`、`onmessage`）

- [ ] **Step 1: 复制 marked 的脚本**

`desktop/scripts/vendor.mjs`：

```js
// 把 marked 复制进 renderer/vendor：App 不从网上加载任何脚本
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const candidates = ["lib/marked.umd.js", "marked.min.js", "lib/marked.umd.min.js"]
  .map((f) => path.join(here, "../node_modules/marked", f));
const src = candidates.find((f) => fs.existsSync(f));
if (!src) throw new Error("找不到 marked 的浏览器版脚本：" + candidates.join(", "));
const out = path.join(here, "../src/renderer/vendor");
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(src, path.join(out, "marked.umd.js"));
console.log("已复制", path.relative(process.cwd(), src));
```

Run：`npm run vendor`
Expected: 打印「已复制 …」，生成 `src/renderer/vendor/marked.umd.js`。

- [ ] **Step 2: 复制网页版界面**

```bash
cp ~/class-translator/static/index.html ~/class-translator/static/app.js ~/class-translator/static/worklet.js ~/class-translator/desktop/src/renderer/
```

- [ ] **Step 3: 写 bridge.js**

`desktop/src/renderer/bridge.js`：

```js
// 把网页版的 fetch("/api/…") 和 WebSocket 换成 App 内部通信，app.js 其余逻辑不用改
window.apiFetch = async (url, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  const data = await window.api.call(url, opts.method ?? "GET", body);
  return { json: async () => data };
};

window.openSessionSocket = async () => {
  const sock = { readyState: 0, onmessage: null };
  const off = window.api.onMessage((m) => sock.onmessage?.({ data: JSON.stringify(m) }));
  await window.api.openSession();
  sock.readyState = 1;
  sock.send = (d) => (typeof d === "string" ? window.api.sendCmd(d) : window.api.sendAudio(d));
  sock.close = () => {
    if (sock.readyState !== 1) return;
    sock.readyState = 3;
    off();
    window.api.closeSession();
  };
  return sock;
};
```

- [ ] **Step 4: 改 index.html**

在 `desktop/` 下运行：

```bash
python3 - <<'EOF'
import re
from pathlib import Path
p = Path("src/renderer/index.html"); h = p.read_text()
def rep(old, new):
    global h
    assert old in h, old[:60]; h = h.replace(old, new, 1)
# 不从网上加载脚本；加内容安全策略
h, n = re.subn(r'<script src="https://[^"]*marked[^"]*"></script>',
  '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; '
  'style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; media-src \'self\' mediastream: blob:">\n'
  '<script src="vendor/marked.umd.js"></script>', h); assert n == 1
rep('<script src="/static/app.js"></script>', '<script src="bridge.js"></script>\n<script src="app.js"></script>')
# 底部署名
rep('</main>', '</main>\n<footer class="powered">Powered by 南瓜 · <span id="version"></span></footer>')
rep('  [hidden] { display: none !important; }', '''  [hidden] { display: none !important; }
  .powered { text-align: center; font-size: 12px; color: var(--muted); padding: 0 0 10px; }''')
# 设置里加「打开记录文件夹」
rep('  <p class="hint">key 只保存在这台电脑上，网页上只显示末尾 4 位。</p>', '''  <section>
    <div class="row"><b>课堂记录</b></div>
    <p class="hint">课堂记录和课后精讲都保存在「文稿/课堂同传」文件夹里，可以随时删除。</p>
    <p><button id="openRecords" type="button">打开记录文件夹</button></p>
  </section>
  <p class="hint">key 用系统加密保存在这台电脑上，界面上只显示末尾 4 位。</p>''')
# 第一次打开的隐私说明
rep('<dialog id="settings">', '''<dialog id="privacy">
  <h3>使用前请看一下</h3>
  <section>
    <table class="privacy">
      <tr><td>苹果识别、苹果翻译</td><td>只在这台电脑上处理，不上传</td></tr>
      <tr><td>Gemini 翻译、课堂笔记、课后精讲</td><td>转写的文字会发送给 Google</td></tr>
      <tr><td>Claude 翻译、课堂笔记、课后精讲</td><td>转写的文字会发送给 Anthropic</td></tr>
      <tr><td>南瓜（作者）</td><td>收不到任何数据：App 里没有统计、没有上传</td></tr>
    </table>
    <p class="hint">课堂录音前，请先确认学校和老师的规定。</p>
  </section>
  <div class="actions"><button class="primary" id="privacyOk" type="button">我知道了</button></div>
</dialog>
<dialog id="settings">''')
rep('  dialog [hidden] { display: none !important; }', '''  dialog [hidden] { display: none !important; }
  table.privacy { border-collapse: collapse; width: 100%; font-size: 14px; }
  table.privacy td { border-bottom: 1px solid var(--line); padding: 8px 6px; vertical-align: top; }
  table.privacy td:first-child { color: var(--muted); width: 44%; }''')
p.write_text(h)
EOF
grep -c "Powered by 南瓜" src/renderer/index.html
```
Expected: 打印 `1`。

- [ ] **Step 5: 改 app.js**

在 `desktop/` 下运行：

```bash
python3 - <<'EOF'
import re
from pathlib import Path
p = Path("src/renderer/app.js"); s = p.read_text()
def rep(old, new):
    global s
    assert old in s, old[:60]; s = s.replace(old, new, 1)

# 1. 所有 /api 请求走 App 内部通信
s, n = re.subn(r'\bfetch\((["`])/api/', r'apiFetch(\1/api/', s); assert n >= 6, n

# 2. WebSocket 换成内部会话
rep('''  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = onMessage;
  ws.onclose = () => { if (state !== "idle") { toast("与本地服务的连接断开了"); stopLocal(); } };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });''', '''  ws = await openSessionSocket();
  ws.onmessage = onMessage;''')
rep('await ctx.audioWorklet.addModule("/static/worklet.js");', 'await ctx.audioWorklet.addModule("worklet.js");')

# 3. 选项按这台电脑的能力来：识别方式、翻译方式、电脑内部声音
rep('''async function listMics() {
  try {''', '''async function listMics() {
  await apiFetch("/api/mic-access", { method: "POST" }); // 先走系统的麦克风授权
  try {''')
rep('''    + `<option value="${SYSTEM}">电脑内部声音（视频/电影）</option>`;''',
    '''    + (window.APP_INFO?.caps.systemAudio ? `<option value="${SYSTEM}">电脑内部声音（视频/电影）</option>` : "");''')
s = s.rstrip()
assert s.endswith("listMics();"); s = s[: -len("listMics();")]
s += '''// App：按这台电脑能用的功能调整选项，第一次打开先看隐私说明
apiFetch("/api/app-info").then((r) => r.json()).then((info) => {
  window.APP_INFO = info;
  for (const k of Object.keys(ASRS)) delete ASRS[k];
  Object.assign(ASRS, info.caps.appleAsr
    ? { apple: "苹果自带（最快，边说边出字）" }
    : { none: "暂不支持（需要 macOS 26，下个版本加入云端识别）" });
  fillSelect($("asr"), ASRS, Object.keys(ASRS)[0]);
  if (!info.caps.appleTranslate) delete TRANSLATORS.apple;
  fillSelect($("translator"), TRANSLATORS, load("translator", "gemini", TRANSLATORS));
  $("version").textContent = "v" + info.version;
  listMics();
  if (!info.privacyAccepted) $("privacy").showModal();
});
$("privacy").addEventListener("cancel", (e) => e.preventDefault()); // 必须点「我知道了」
$("privacyOk").onclick = async () => { await apiFetch("/api/privacy-accepted", { method: "POST" }); $("privacy").close(); };
$("openRecords").onclick = () => apiFetch("/api/open-records-folder", { method: "POST" });
'''

# 4. 导出 PDF 改由 App 直接生成文件
s, n = re.subn(r'\$\("pdfBtn"\)\.onclick = \(\) => \{.*?\n\};\n', '''$("pdfBtn").onclick = async () => {
  const title = document.createElement("title");
  title.textContent = safeName(reportTitle) + "-课后精讲";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${title.outerHTML}
    <style>${PRINT_CSS}</style></head><body><div class="brand">课堂同传 · 课后精讲</div>${md2html(reportMd)}</body></html>`;
  const r = await (await apiFetch("/api/pdf", { method: "POST", body: JSON.stringify({ html, name: title.textContent }) })).json();
  if (r.ok) toast(`已导出 PDF：${r.file}`);
  else if (r.msg) toast(r.msg);
};
''', s, flags=re.S); assert n == 1

# 5. 提示文字里的路径
rep('toast(`已保存到 records/${m.record}`);', 'toast("已保存到「文稿/课堂同传」");')
rep('toast(`课后精讲已保存到 records/${r.file}`);', 'toast(`课后精讲已保存：文稿/课堂同传/${r.file}`);')
rep('toast("已保存，马上生效");', 'toast(r.msg || "已保存，马上生效");')
p.write_text(s)
EOF
grep -n "WebSocket\|/static/\|\bfetch(" src/renderer/app.js || echo "已全部替换"
```
Expected: 打印「已全部替换」。

- [ ] **Step 6: 冒烟检查界面能加载、无报错、有署名**

Run（在 `desktop/` 下）：`CT_SMOKE_OPEN=1 npx electron . 2>&1 | grep -E "window-loaded|CONSOLE"`
Expected: 一行 `window-loaded {"powered":"Powered by 南瓜 · v0.1.0","asr":["苹果自带（最快，边说边出字）"]}`，且没有任何 `CONSOLE` 开头的报错行（若有 `Refused to …`（内容安全策略）或 `is not defined`，按报错修正后重跑）。

- [ ] **Step 7: 手动验证（在南瓜的 Mac 上，`npm start`）**

逐项确认并在提交说明里记录结果：
1. 第一次打开弹出隐私说明，按 Esc 关不掉，点「我知道了」后再开 App 不再弹出
2. 系统弹出麦克风授权，提示文字显示为「课堂同传需要使用麦克风…」或系统默认文字（打包后才会显示自定义文字）
3. 开始录制，对着麦克风说英文：灰色草稿边说边出字；说完 1–2 秒出现正式字幕和中文翻译
4. 麦克风选「电脑内部声音」，播放一段英文视频：能出字幕
5. 「AI 模型与 API」：能保存、修改、删除 Gemini key；填错 key 提示「不能用」；「打开记录文件夹」能打开「文稿/课堂同传」
6. 结束录制：自动切到「课后精讲」并生成；「导出 PDF」弹出保存框，生成的 PDF 有页眉和页码；「导出 Markdown」能下载
7. 窗口底部显示「Powered by 南瓜 · v0.1.0」

- [ ] **Step 8: Commit**

```bash
git add desktop/scripts/vendor.mjs desktop/src/renderer
git commit -m "桌面版：界面移植（内部通信、隐私说明、Powered by 南瓜、PDF 导出）"
```

---

### Task 10: 打包成 Mac 安装包

**Files:**
- Create: `desktop/electron-builder.yml`、`desktop/scripts/adhoc-sign.cjs`、`desktop/scripts/check-package.mjs`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: `desktop/dist/课堂同传-0.1.0-arm64.dmg`、`desktop/dist/课堂同传-0.1.0.dmg`（Intel）；`npm run dist` 打包并自动检查。

- [ ] **Step 1: 打包配置**

`desktop/electron-builder.yml`：

```yaml
appId: local.nangua.classtranslator
productName: 课堂同传
copyright: Powered by 南瓜
directories:
  output: dist
files:
  - package.json
  - src/**
extraResources:
  - from: build/bin
    to: bin
asar: true
mac:
  target:
    - target: dmg
      arch: [arm64, x64]
  category: public.app-category.education
  identity: null            # 暂不使用开发者证书（见设计文档 9.2），打包后做 ad-hoc 签名
  minimumSystemVersion: "12.0"
  extendInfo:
    NSMicrophoneUsageDescription: 课堂同传需要使用麦克风来识别老师说的话。
    NSAudioCaptureUsageDescription: 课堂同传需要录制电脑播放的声音，用来给视频和网课生成字幕。
    NSSpeechRecognitionUsageDescription: 课堂同传使用苹果自带的语音识别，在这台电脑上把语音转成文字。
afterSign: scripts/adhoc-sign.cjs
dmg:
  title: 课堂同传
```

`desktop/scripts/adhoc-sign.cjs`：

```js
// 没有开发者证书时做 ad-hoc 签名，否则苹果芯片 Mac 上无法运行（不是绕过检查：首次打开仍会有系统提示）
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== "darwin") return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
};
```

- [ ] **Step 2: 打包后的安全检查脚本**

`desktop/scripts/check-package.mjs`：

```js
// 打包后检查：安装包里不能有 .env、课堂记录、虚拟环境、设置文件或任何 key
import fs from "node:fs";
import path from "node:path";
import asar from "@electron/asar";

const dist = path.join(import.meta.dirname, "../dist");
const BAD_PATH = /(^|\/)(\.env|records\/|\.venv\/|settings\.json$)/;
const KEY_RE = /AIza[0-9A-Za-z_-]{30,}|sk-ant-[0-9A-Za-z_-]{20,}/;
const problems = [];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walk(f);
    else checkFile(f, fs.readFileSync(f));
  }
}
function checkFile(name, buf) {
  if (BAD_PATH.test(name)) problems.push(`不该打包的文件：${name}`);
  if (KEY_RE.test(buf.toString("latin1"))) problems.push(`疑似包含 API key：${name}`);
}

const apps = fs.readdirSync(dist).filter((d) => d.startsWith("mac")).map((d) => path.join(dist, d, "课堂同传.app"));
if (!apps.length) throw new Error("dist 里没有找到 课堂同传.app");
for (const app of apps) {
  const res = path.join(app, "Contents/Resources");
  walk(res);
  const archive = path.join(res, "app.asar");
  for (const f of asar.listPackage(archive)) {
    const rel = f.replace(/^\//, "");
    let buf;
    try { buf = asar.extractFile(archive, rel); } catch { continue; } // 目录
    checkFile(rel, buf);
  }
}
if (problems.length) {
  console.error("打包检查失败：\n" + problems.join("\n"));
  process.exit(1);
}
console.log(`打包检查通过：${apps.length} 个 App，未发现机密文件或 key`);
```

- [ ] **Step 3: 打包**

Run（在 `desktop/` 下）：`npm test && npm run dist`
Expected: 测试全部通过；`dist/` 下生成两个 `.dmg`；最后打印「打包检查通过」。

- [ ] **Step 4: 验证签名和打包后的 App 能跑**

Run（在 `desktop/` 下）：
```bash
codesign --verify --deep --strict "dist/mac-arm64/课堂同传.app" && echo 签名完整
T=$(mktemp -d)
say -v Samantha -o $T/a.aiff "Today we are going to talk about the second law of thermodynamics."
afconvert -f WAVE -d LEI16@16000 -c 1 $T/a.aiff $T/a.wav
CT_SMOKE_WAV=$T/a.wav CT_RECORDS_DIR=$T/records "dist/mac-arm64/课堂同传.app/Contents/MacOS/课堂同传" | grep SMOKE | grep -E '"line"|"done"'
```
Expected: 打印「签名完整」；打包后的 App 用内置的苹果识别输出了含 `thermodynamics` 的 `line` 和最后的 `done`。

- [ ] **Step 5: 验证 dmg 安装流程**

Run：`open "dist/课堂同传-0.1.0-arm64.dmg"`，把 App 拖进「应用程序」，双击打开。
Expected: 出现「无法验证开发者」类提示时，到 系统设置 → 隐私与安全性 点「仍要打开」后能正常启动；隐私说明、麦克风授权、底部「Powered by 南瓜 · v0.1.0」都正常。把这几步截图留给第 4 期写下载页说明用。

- [ ] **Step 6: Commit**

```bash
git add desktop/electron-builder.yml desktop/scripts/adhoc-sign.cjs desktop/scripts/check-package.mjs
git commit -m "桌面版：Mac 安装包（ad-hoc 签名、打包后机密检查）"
```
