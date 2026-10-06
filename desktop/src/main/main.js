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
        `JSON.stringify({ powered: document.querySelector(".powered")?.textContent, asr: [...document.querySelectorAll("#asr option")].map(o => o.textContent), speaker: document.querySelector("#speaker").value, speakers: [...document.querySelectorAll("#speaker option")].map(o => o.value) })`);
      console.log("window-loaded " + state);
      app.quit();
    });
  }
  app.on("window-all-closed", () => { deps.appleTr.stop(); app.quit(); });
}

main();
