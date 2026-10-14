// 悬浮字幕窗口只能收字幕和字幕条位置、发鼠标 / 位置 / 设置这几条消息
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  onState: (cb) => ipcRenderer.on("overlay:state", (_e, s) => cb(s)),
  onBar: (cb) => ipcRenderer.on("overlay:bar", (_e, b) => cb(b)),
  hot: (hot) => ipcRenderer.send("overlay:hot", { hot }),
  bar: (bar, pt) => ipcRenderer.send("overlay:bar", { bar, pt }),
  prefs: (p) => ipcRenderer.send("overlay:prefs", p),
  hide: () => ipcRenderer.send("overlay:hide"),
});
