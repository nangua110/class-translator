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
