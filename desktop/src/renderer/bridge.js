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
