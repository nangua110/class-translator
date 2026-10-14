// 悬浮字幕窗口只能收字幕、发拖动 / 设置这几条消息
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  onState: (cb) => ipcRenderer.on("overlay:state", (_e, s) => cb(s)),
  onFrame: (cb) => ipcRenderer.on("overlay:frame", (_e, f) => cb(f)),
  grab: (edge) => ipcRenderer.send("overlay:grab", { edge }),
  move: (dx, dy) => ipcRenderer.send("overlay:move", { dx, dy }),
  release: () => ipcRenderer.send("overlay:release"),
  height: (h) => ipcRenderer.send("overlay:height", { h }),
  prefs: (p) => ipcRenderer.send("overlay:prefs", p),
  hot: (hot) => ipcRenderer.send("overlay:hot", { hot }),
  hide: () => ipcRenderer.send("overlay:hide"),
});
