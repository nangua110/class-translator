import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, desktopCapturer, ipcMain, safeStorage, session, shell, systemPreferences } from "electron";
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
import { VoiceDetector } from "./cloud/vad.js";
import { CloudASR } from "./cloud/asr.js";

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
  // 人声检测模型启动时就开始加载；云端识别第一次用到时等它加载完
  const vadReady = VoiceDetector.load(path.join(here, "../../assets/silero_vad.onnx"));
  vadReady.catch((e) => console.error("人声检测模型加载失败", e));
  const vad = { hasVoice: async (f32) => (await vadReady).hasVoice(f32) };
  const makeSession = (send) => new Session({
    send, llm, appleTr, records, caps,
    makeAsr: (kind, speaker, offset) => (kind === "cloud"
      ? new CloudASR({ llm, vad, speaker, offset })
      : new AppleASR(bins.asr, speaker, offset)),
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
  s.configure({ speaker: process.env.CT_SMOKE_SPEAKER ?? "en", target: "zh", asr: process.env.CT_SMOKE_ASR ?? "apple", translator: process.env.CT_SMOKE_TRANSLATOR ?? "apple" });
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
  if (!app.isPackaged && process.platform === "darwin") app.dock.setIcon(path.join(here, "../../assets/icon.png")); // 开发时程序坞也用新图标
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "media"));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === "media");
  if (process.platform === "win32") {
    // Windows 录电脑内部声音：直接给整个屏幕 + 系统回环音频，不弹选择框（视频轨道在窗口里会马上停掉）
    session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
      desktopCapturer.getSources({ types: ["screen"] })
        .then((sources) => callback({ video: sources[0], audio: "loopback" }))
        .catch(() => callback({}));
    });
  }
  if (process.env.CT_SMOKE_WAV) return runSmoke(deps);
  registerIpc({ ipcMain, ...deps });
  mainWindow = createWindow();
  if (process.env.CT_SMOKE_OPEN) {
    mainWindow.webContents.on("console-message", (_e, _lvl, msg) => console.log("CONSOLE " + msg));
    mainWindow.webContents.once("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, Number(process.env.CT_SMOKE_DELAY ?? 1500)));
      const state = await mainWindow.webContents.executeJavaScript(
        `JSON.stringify({ powered: document.querySelector(".powered")?.textContent.trim(), inFoot: !!document.querySelector(".card-foot .powered"), standalone: !!document.querySelector("footer.powered"), asr: [...document.querySelectorAll("#asr option")].map(o => o.textContent), speaker: document.querySelector("#speaker").value, speakers: [...document.querySelectorAll("#speaker option")].map(o => o.value), mics: [...document.querySelectorAll("#mic option")].map(o => o.textContent), privacyApple: !document.querySelector(".apple-only")?.hidden })`);
      if (process.env.CT_SMOKE_SHOT) fs.writeFileSync(process.env.CT_SMOKE_SHOT, (await mainWindow.webContents.capturePage()).toPNG());
      console.log("window-loaded " + state);
      app.quit();
    });
  }
  app.on("window-all-closed", () => { deps.appleTr.stop(); app.quit(); });
}

main();
