// 悬浮字幕窗口只能收字幕、发拖动 / 设置这几条消息
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  onState: (cb) => ipcRenderer.on("overlay:state", (_e, s) => cb(s)),
  grab: () => ipcRenderer.send("overlay:grab"),
  move: (dx, dy, edge) => ipcRenderer.send("overlay:move", { dx, dy, edge }),
  release: () => ipcRenderer.send("overlay:release"),
  height: (h) => ipcRenderer.send("overlay:height", { h }),
  prefs: (p) => ipcRenderer.send("overlay:prefs", p),
  hot: (hot) => ipcRenderer.send("overlay:hot", { hot }),
  hide: () => ipcRenderer.send("overlay:hide"),
});
