// 把网页版的 fetch("/api/…") 和 WebSocket 换成 App 内部通信，app.js 其余逻辑不用改
window.apiFetch = async (url, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  const data = await window.api.call(url, opts.method ?? "GET", body);
  return { json: async () => data };
};

// 同一时间只有一节课：开新课时先断开上一节课的监听，并且只收带本节课标识（sid）的消息，
// 免得上一节课收尾时迟到的消息（比如 done）串到新课里
let current = null;
window.openSessionSocket = async () => {
  if (current) { current.readyState = 3; current.off(); }
  const sock = { readyState: 0, onmessage: null, sid: null };
  sock.off = window.api.onMessage((m) => { if (sock.sid && m.sid === sock.sid) sock.onmessage?.({ data: JSON.stringify(m) }); });
  current = sock;
  const opened = await window.api.openSession();
  sock.sid = opened.record;
  sock.audio = !!opened.audio; // 这节课有没有在保存录音
  sock.readyState = 1;
  sock.send = (d) => (typeof d === "string" ? window.api.sendCmd(d) : window.api.sendAudio(d));
  sock.close = () => {
    if (sock.readyState !== 1) return;
    sock.readyState = 3;
    sock.off();
    if (current === sock) { current = null; window.api.closeSession(); }
  };
  return sock;
};
