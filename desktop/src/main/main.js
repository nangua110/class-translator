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
