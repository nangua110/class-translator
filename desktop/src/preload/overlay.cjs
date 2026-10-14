// 悬浮字幕窗口只能收字幕和字幕条位置、发鼠标 / 位置 / 设置这几条消息
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  onState: (cb) => ipcRenderer.on("overlay:state", (_e, s) => cb(s)),
  onBar: (cb) => ipcRenderer.on("overlay:bar", (_e, b, area) => cb(b, area)),
  onArea: (cb) => ipcRenderer.on("overlay:area", (_e, area) => cb(area)),
  cross: (x, y) => ipcRenderer.send("overlay:cross", { x, y }),
  hot: (hot) => ipcRenderer.send("overlay:hot", { hot }),
  bar: (bar) => ipcRenderer.send("overlay:bar", { bar }),
  prefs: (p) => ipcRenderer.send("overlay:prefs", p),
  hide: () => ipcRenderer.send("overlay:hide"),
});
