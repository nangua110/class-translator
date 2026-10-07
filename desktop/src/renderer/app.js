const $ = (id) => document.getElementById(id);
// Markdown 转网页：单个换行也换行（提示框标题单独一行）；
// 中文紧挨着的 **加粗**（如「**孤立系统（isolated system）**中」）标准 Markdown 认不出，先转成 <strong>
marked.use({ breaks: true });
const md2html = (md) => marked.parse(md.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>"));
let ws, ctx, stream, node, timerId;
let state = "idle"; // idle | recording | paused
let finishing = false; // 点了结束、后台还在收尾（生成最终笔记）；这期间也可以马上开新课，上一节课照样存盘
let elapsed = 0, lastTick = 0, summaryMd = "";
const SYSTEM = "__system__"; // 音源选"电脑内部声音"：由服务端直接录系统声音，不用麦克风
const lines = {};
const SPEAKERS = { auto: "自动（中/英）", en: "英语", zh: "中文", ja: "日语", ko: "韩语", fr: "法语", de: "德语", es: "西班牙语" };
const ASRS = { apple: "苹果自带（最快，边说边出字）", local: "本地实时（英语，免费，边说边出字）", cloud: "云端（Gemini，需要填 key）" };
const ALL_SPEAKERS = { ...SPEAKERS };
// 苹果识别和本地实时都要事先确定语言，做不到「自动（中/英）」；云端识别可以
function refreshSpeakers() {
  for (const k of Object.keys(SPEAKERS)) delete SPEAKERS[k];
  Object.assign(SPEAKERS, ALL_SPEAKERS);
  if ($("asr").value !== "cloud") delete SPEAKERS.auto; // 只有云端识别能同时认中英文
  fillSelect($("speaker"), SPEAKERS, load("speaker", "en", SPEAKERS));
}
const TRANSLATORS = { gemini: "Gemini（推荐，会纠正识别错字）", claude: "Claude（会纠正识别错字）", apple: "苹果自带（免费、本地、直译）" };
const TARGETS = { zh: "简体中文", en: "英语", ja: "日语", ko: "韩语", fr: "法语", de: "德语", es: "西班牙语" };

// 语言选择：记住上次的选择，录音中途切换也会立即生效
function load(key, def, options) {
  try { const v = localStorage.getItem(key); if (v in options) return v; } catch {}
  return def;
}
function fillSelect(el, options, value) {
  el.innerHTML = Object.entries(options).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  el.value = value;
}
fillSelect($("speaker"), SPEAKERS, load("speaker", "en", SPEAKERS));
fillSelect($("target"), TARGETS, load("target", "zh", TARGETS));
fillSelect($("asr"), ASRS, load("asr2", "apple", ASRS));
fillSelect($("translator"), TRANSLATORS, load("translator", "gemini", TRANSLATORS));
function sendLangs() {
  if (ws?.readyState === 1) ws.send(JSON.stringify({
    speaker: $("speaker").value, target: $("target").value, asr: $("asr").value, translator: $("translator").value,
    // Mac 的电脑内部声音由后台的 syscap 录；Windows 的系统回环在窗口里录，和麦克风走同一条路
    source: $("mic").value === SYSTEM && !window.APP_INFO?.caps.loopback ? "system" : "mic",
  }));
}
for (const id of ["speaker", "target", "asr", "translator"])
  $(id).onchange = () => {
    try { localStorage.setItem(id === "asr" ? "asr2" : id, $(id).value); } catch {}
    // 本地实时只支持英语：语言和识别方式互相迁就，免得出一堆乱码
    if (id === "speaker" && $("asr").value === "local" && $("speaker").value !== "en") {
      $("asr").value = "cloud";
      try { localStorage.setItem("asr2", "cloud"); } catch {}
      toast("本地实时只支持英语，已改用云端识别（需要填 Gemini key）");
    }
    if (id === "asr" && $("asr").value === "local" && $("speaker").value !== "en") {
      try { localStorage.setItem("speaker", "en"); } catch {}
      toast("本地实时只支持英语，说话人语言已改为英语");
    }
    if (id === "asr" || id === "speaker") refreshSpeakers();
    sendLangs();
    if (state !== "idle") toast("已切换，从下一句开始生效");
  };

function fmt(sec) {
  sec = Math.floor(sec);
  return [sec / 3600, (sec % 3600) / 60, sec % 60].map((n) => String(Math.floor(n)).padStart(2, "0")).join(":");
}
function toast(msg) {
  const el = $("toast"); el.textContent = msg; el.style.display = "block";
  clearTimeout(el._t); el._t = setTimeout(() => (el.style.display = "none"), 4000);
}
// 底部状态栏：录音中显示"正在聆听"，有句子在识别时显示"正在识别中…"
let recognizing = false;
function setFoot(r = recognizing) {
  recognizing = r && state !== "idle";
  $("recog").hidden = !recognizing;
  $("footText").textContent = state === "idle" ? "未开始录制" : state === "paused" ? "已暂停"
    : recognizing ? "正在识别中…" : "正在聆听…";
}
function setState(s) {
  state = s;
  setFoot();
  $("startBtn").disabled = s !== "idle";
  $("pauseBtn").disabled = s === "idle";
  $("pauseBtn").textContent = s === "paused" ? "继续" : "暂停";
  $("stopBtn").disabled = s === "idle";
  $("sumBtn").disabled = s === "idle";
  $("mic").disabled = s !== "idle";
  $("saveAudio").disabled = s !== "idle"; // 录到一半不能改
  $("dot").classList.toggle("on", s === "recording");
  if (s === "idle") renderLive("");
}

navigator.mediaDevices.addEventListener("devicechange", () => listMics()); // 插拔麦克风后自动刷新
async function listMics() {
  await apiFetch("/api/mic-access", { method: "POST" }); // 先走系统的麦克风授权（Mac）
  // App 里麦克风权限由主进程直接批准，不用像网页版那样先开一次麦克风才能看到设备名；
  // Windows 上开麦克风要十几秒，开了反而让列表迟迟出不来
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId);
  const caps = window.APP_INFO?.caps ?? {};
  $("mic").innerHTML = devs.map((d) => `<option value="${d.deviceId}">${d.label || "麦克风"}</option>`).join("")
    + (caps.systemAudio ? `<option value="${SYSTEM}">电脑内部声音（视频/电影）</option>` : "");
  if (!devs.length) {
    $("mic").insertAdjacentHTML("afterbegin", '<option value="" disabled>没有找到麦克风</option>');
    if (!caps.systemAudio) $("mic").value = "";
    toast(caps.platform === "win32"
      ? "没有找到麦克风：请到 设置 → 隐私和安全性 → 麦克风，打开「允许桌面应用访问麦克风」"
      : "没有找到麦克风：请到 系统设置 → 隐私与安全 → 麦克风，允许「课堂同传」");
  }
}

function addLine({ id, t, text, tr, same }) {
  const record = ws?.audio ? ws.sid : "";
  $("empty")?.remove();
  const el = document.createElement("div");
  el.className = "line";
  el.innerHTML = `<div class="t">${fmt(t)}</div><div><p class="en"></p><p class="zh wait">翻译中…</p></div>`;
  el.querySelector(".en").textContent = text;
  const zh = el.querySelector(".zh");
  if (same) { zh.textContent = "（原话）"; zh.classList.add("tag"); zh.classList.remove("wait"); }
  else if (tr) { zh.textContent = tr; zh.classList.remove("wait"); }
  if (record) { // 这节课在保存录音：点时间就从这一句回听
    const tEl = el.querySelector(".t");
    tEl.classList.add("play"); tEl.title = "点击回听这一句";
    tEl.onclick = () => playAt(record, Math.max(0, t - 0.5));
  }
  lines[id] = el;
  const box = $("transcript");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.insertBefore(el, $("live"));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// ---------- 实时字幕：苹果识别边说边发回来的草稿，正式字幕一到就清掉 ----------
function renderLive(text) {
  const el = $("live");
  el.hidden = !text;
  el.querySelector(".en").textContent = text;
  const box = $("transcript");
  if (text && box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight;
}

function onMessage(ev) {
  const m = JSON.parse(ev.data);
  if (m.type === "line") addLine(m);
  else if (m.type === "partial") renderLive(m.text);
  else if (m.type === "translation") {
    const zh = lines[m.id]?.querySelector(".zh");
    if (zh) { zh.textContent = m.tr; zh.classList.remove("wait"); }
  } else if (m.type === "status") setFoot(m.recognizing);
  else if (m.type === "summary") {
    summaryMd = m.md;
    $("summary").innerHTML = md2html(m.md);
    if (tab === "notes") $("exportBtn").disabled = false;
  } else if (m.type === "summary_status") $("sumBadge").textContent = m.busy ? "归纳中…" : m.failed ? "更新失败，稍后重试" : "已更新";
  else if (m.type === "error") toast(m.msg);
  else if (m.type === "done") {
    finishing = false;
    setState(state);
    toast("已保存到课堂记录文件夹");
    ws.close();
    showTab("report");
    loadRecords(m.record).then(() => makeReport(m.record)); // 下课后自动生成课后精讲
  }
}

async function start() {
  // Mac 的电脑内部声音由后台录（system=true）；Windows 的系统回环在这里录，和麦克风走同一条路
  const loopback = $("mic").value === SYSTEM && !!window.APP_INFO?.caps.loopback;
  const system = $("mic").value === SYSTEM && !loopback;
  if (loopback) {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    stream.getVideoTracks().forEach((t) => t.stop()); // 只要声音
    if (!stream.getAudioTracks().length) throw new Error("没有录到电脑声音");
  } else if (!system) {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: $("mic").value || undefined, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
  }
  ws = await openSessionSocket();
  ws.onmessage = onMessage;
  sendLangs(); // 选了电脑内部声音时，服务端收到后就开始录

  if (!system) {
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule("worklet.js");
    node = new AudioWorkletNode(ctx, "pcm-capture");
    node.port.onmessage = (e) => { if (state === "recording" && ws.readyState === 1) ws.send(e.data); };
    ctx.createMediaStreamSource(stream).connect(node);
  }

  if (finishing) { finishing = false; $("sumBadge").textContent = ""; } // 上一节课的最终笔记在后台存进记录，不再显示到这节课里
  elapsed = 0; lastTick = performance.now();
  timerId = setInterval(() => {
    const now = performance.now();
    if (state === "recording") elapsed += (now - lastTick) / 1000;
    lastTick = now;
    $("timer").textContent = fmt(elapsed);
  }, 250);
  setState("recording");
}

function stopLocal() {
  setState("idle");
  clearInterval(timerId);
  stream?.getTracks().forEach((t) => t.stop());
  ctx?.close();
  stream = ctx = null;
  setFoot(false);
}

$("startBtn").onclick = () => start().catch((e) => {
  const caps = window.APP_INFO?.caps ?? {};
  const source = $("mic").value === SYSTEM && caps.loopback ? "loopback" : "mic";
  toast(startErrorText(e, caps.platform, source));
  console.warn("开始录制失败", e?.name, e?.message); // 原始报错留给排查用
  ws?.close();
  stopLocal();
});
$("pauseBtn").onclick = () => {
  setState(state === "paused" ? "recording" : "paused");
  if (ws?.readyState === 1) ws.send(state === "paused" ? "pause" : "resume");
};
$("stopBtn").onclick = () => {
  if (ws?.readyState === 1) { ws.send("stop"); finishing = true; }
  $("sumBadge").textContent = "生成最终总结…";
  stopLocal();
};
$("sumBtn").onclick = () => ws?.readyState === 1 && ws.send("summary");
// ---------- 课后精讲：下课后对整节课生成；也能从历史记录里选以前的课生成 ----------
let tab = "notes", reportMd = "", reportTitle = "", records = [];
const REPORT_EMPTY = "选一节课，点「生成课后精讲」：会把整节课整理成章节大纲、AI 精讲、术语表、思考题和核心要点";
function showTab(t) {
  tab = t;
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("on", b.dataset.tab === t);
  $("summary").hidden = t !== "notes";
  $("report").hidden = $("historyBar").hidden = t !== "report";
  $("sumBadge").hidden = $("sumBtn").hidden = t !== "notes";
  $("repBadge").hidden = t !== "report" || !$("repBadge").textContent;
  $("pdfBtn").hidden = t !== "report";
  $("exportBtn").disabled = t === "report" ? !reportMd : !summaryMd;
  if (t === "report" && !records.length) loadRecords();
}
for (const b of document.querySelectorAll(".tab")) b.onclick = () => showTab(b.dataset.tab);

// ---------- 回听原声：开了「保存录音」的课，点字幕或课后精讲里的时间就从那里播放 ----------
const KEEP_DAYS = { 3: "3 天后", 7: "7 天后", 30: "30 天后", 0: "不清理" };
let playing = null; // {record, start, url}
async function playAt(record, t) {
  let d;
  try { d = await (await apiFetch(`/api/audio?record=${encodeURIComponent(record)}&t=${t}`)).json(); } catch { d = { ok: false }; }
  if (!d.ok) { closePlayer(); return toast("这节课没有保存录音，或者录音已经被自动清理了"); }
  if (playing?.url) URL.revokeObjectURL(playing.url);
  playing = { record, start: d.start, total: d.total, url: URL.createObjectURL(new Blob([d.wav], { type: "audio/wav" })) };
  $("playerText").textContent = `回听 ${fmt(d.start)} 起`;
  $("player").hidden = false;
  $("audio").src = playing.url;
  $("audio").play().catch(() => {});
}
function closePlayer() {
  $("audio").pause();
  $("audio").removeAttribute("src");
  if (playing?.url) URL.revokeObjectURL(playing.url);
  playing = null;
  $("player").hidden = true;
}
$("playerClose").onclick = closePlayer;
// 一次只取两分钟，播完自动接下一段
$("audio").onended = () => {
  if (!playing) return;
  const next = playing.start + $("audio").duration;
  if (Number.isFinite(next) && next < playing.total - 0.5) playAt(playing.record, next); else closePlayer();
};
// 把课后精讲里的 00:12:34 变成可以点的时间（只有这节课存了录音才变）
function linkTimes(root, record) {
  if (!records.find((x) => x.name === record)?.has_audio) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (/\d\d:\d\d:\d\d/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    for (const part of node.nodeValue.split(/(\d\d:\d\d:\d\d)/)) {
      if (!/^\d\d:\d\d:\d\d$/.test(part)) { frag.append(part); continue; }
      const a = document.createElement("span");
      a.className = "ts"; a.textContent = part; a.title = "点击回听";
      const [h, m, s] = part.split(":").map(Number);
      a.onclick = () => playAt(record, h * 3600 + m * 60 + s);
      frag.append(a);
    }
    node.replaceWith(frag);
  }
}
// ---------- 查看录音：列出存在这台电脑上的录音，可以播放、删除 ----------
const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(b >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const fmtDur = (s) => (s >= 60 ? `${Math.round(s / 60)} 分钟` : `${Math.round(s)} 秒`);
async function openAudios() {
  let list;
  try { list = await (await apiFetch("/api/audios")).json(); } catch { return toast("连不上本地服务，打不开"); }
  const box = $("audioList");
  box.textContent = "";
  for (const a of list) {
    const [, mo, d, h, mi] = a.stem.match(/^\d{4}-(\d\d)-(\d\d)_(\d\d)-(\d\d)/);
    const item = document.createElement("div"); item.className = "item";
    const info = document.createElement("div"); info.className = "info";
    const name = document.createElement("div"); name.className = "name";
    name.textContent = `${mo}-${d} ${h}:${mi}${a.title ? ` · ${a.title}` : ""}`;
    const meta = document.createElement("div"); meta.className = "meta";
    meta.textContent = [fmtDur(a.seconds), fmtSize(a.bytes),
      a.days_left === null ? "不自动清理" : a.days_left > 0 ? `${a.days_left} 天后自动清理` : "即将自动清理"].join(" · ");
    info.append(name, meta);
    const play = document.createElement("button"); play.type = "button"; play.textContent = "播放";
    play.onclick = () => { $("audios").close(); playAt(a.record, 0); };
    const del = document.createElement("button"); del.type = "button"; del.className = "del"; del.textContent = "删除";
    del.onclick = async () => {
      if (!confirm("删除这段录音？文字记录和课后精讲会保留。")) return;
      let r;
      try { r = await (await apiFetch("/api/audio-delete", { method: "POST", body: JSON.stringify({ record: a.record }) })).json(); }
      catch { r = { ok: false }; }
      if (!r.ok) return toast(r.msg || "删除失败");
      if (playing?.record === a.record) closePlayer();
      const rec = records.find((x) => x.name === a.record);
      if (rec) rec.has_audio = false;
      openAudios();
    };
    item.append(info, play, del);
    box.append(item);
  }
  $("audioSum").textContent = list.length
    ? `共 ${list.length} 段，占 ${fmtSize(list.reduce((n, a) => n + a.bytes, 0))}。录音只存在这台电脑上。`
    : "还没有保存的录音。勾选「保存录音」后，之后录的课会出现在这里。";
  if (!$("audios").open) $("audios").showModal();
}
$("audiosBtn").onclick = openAudios;
$("audiosClose").onclick = () => $("audios").close();
$("audiosFolder").onclick = () => apiFetch("/api/open-records-folder", { method: "POST" });
async function savePrefs(body) {
  try { await apiFetch("/api/prefs", { method: "POST", body: JSON.stringify(body) }); } catch { toast("设置没保存上"); }
}
fillSelect($("keepDays"), KEEP_DAYS, "7");
$("saveAudio").onchange = () => {
  $("keepWrap").hidden = !$("saveAudio").checked;
  savePrefs({ saveAudio: $("saveAudio").checked });
  if ($("saveAudio").checked) toast("之后的课会保存原声录音，只存在这台电脑上，到期自动清理");
};
$("keepDays").onchange = () => savePrefs({ audioKeepDays: Number($("keepDays").value) });

function recordLabel(r) {
  const m = r.stem.match(/^\d{4}-(\d\d)-(\d\d)_(\d\d)-(\d\d)/);
  const when = m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : r.stem;
  return `${when} · ${r.minutes} 分钟 · ${r.lines} 句` + (r.has_report ? ` · ${r.title || "已生成"}` : " · 未生成");
}
function setReportView(md, title) {
  reportMd = md || ""; reportTitle = title || "课后精讲";
  if (md) { $("report").innerHTML = md2html(md); linkTimes($("report"), $("histSel").value); }
  else { $("report").innerHTML = '<div class="empty"></div>'; $("report").firstChild.textContent = REPORT_EMPTY; }
  $("pdfBtn").disabled = !md;
  if (tab === "report") $("exportBtn").disabled = !md;
}
// 读出历史记录；select 指定要选中的那节课
async function loadRecords(select) {
  try { records = await (await apiFetch("/api/records")).json(); } catch { records = []; }
  $("histSel").innerHTML = records.length ? "" : "<option>还没有录过的课</option>";
  for (const r of records) $("histSel").add(new Option(recordLabel(r), r.name));
  $("genBtn").disabled = !records.length;
  if (records.length) { $("histSel").value = select || records[0].name; await pickRecord(false); }
}
// 换了一节课：生成过就直接显示，没生成过就提示可以生成
async function pickRecord(fresh = true) {
  const r = records.find((x) => x.name === $("histSel").value);
  if (!r) return;
  $("genBtn").textContent = r.has_report ? "重新生成" : "生成课后精讲";
  $("repBadge").textContent = ""; $("repBadge").hidden = true;
  if (!r.has_report) return setReportView("");
  if (!fresh && reportMd && reportTitle === r.title) return; // 已经显示着这一节
  try {
    const d = await (await apiFetch(`/api/report?record=${encodeURIComponent(r.name)}`)).json();
    setReportView(d.ok ? d.md : "", d.title);
  } catch { setReportView(""); }
}
$("histSel").onchange = () => pickRecord();
$("genBtn").onclick = () => makeReport($("histSel").value);

async function makeReport(record) {
  $("repBadge").textContent = "生成中…"; $("repBadge").hidden = false;
  $("report").innerHTML = '<div class="empty">正在把整节课整理成课后精讲，大约需要半分钟到两分钟…</div>';
  $("genBtn").disabled = $("histSel").disabled = $("pdfBtn").disabled = true;
  if (tab !== "report") showTab("report");
  let r;
  try {
    r = await (await apiFetch("/api/report", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ record, target: $("target").value, translator: $("translator").value }),
    })).json();
  } catch { r = { ok: false, msg: "连不上本地服务" }; }
  $("genBtn").disabled = $("histSel").disabled = false;
  if (!r.ok) {
    $("report").innerHTML = '<div class="empty"></div>';
    $("report").firstChild.textContent = r.msg + "（可以稍后再点一次）";
    $("repBadge").textContent = "生成失败";
    return;
  }
  $("repBadge").textContent = "已生成";
  await loadRecords(record);     // 刷新列表里的"已生成"标记
  setReportView(r.md, r.title);
  toast(`课后精讲已保存：${r.file}`);
}

function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  a.download = name;
  a.click();
}
const safeName = (s) => s.replace(/[\\/:*?"<>|]/g, "_");

// 导出 PDF：打开一个排好版的打印页，用浏览器「存储为 PDF」
const PRINT_CSS = `
  @page { size: A4; margin: 18mm 16mm 20mm;
    @bottom-center { content: "第 " counter(page) " 页 / 共 " counter(pages) " 页"; font-size: 9pt; color: #8a8fa3; } }
  body { margin: 0; color: #1d1f2b; font: 10.5pt/1.75 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
  .brand { letter-spacing: 4px; font-size: 9pt; font-weight: 600; color: #5b5bf0;
    border-bottom: 1px solid #e5e7f0; padding-bottom: 6px; margin-bottom: 18px; }
  h1 { font-size: 20pt; line-height: 1.3; margin: 0 0 6px; }
  h1 + blockquote { background: none !important; border: none !important; padding: 0 !important; color: #8a8fa3; margin: 0 0 12px; }
  h2 { font-size: 14pt; color: #5b5bf0; margin: 26px 0 10px; padding-bottom: 4px; border-bottom: 2px solid #eef0ff; break-after: avoid; }
  h3 { font-size: 12pt; margin: 18px 0 6px; break-after: avoid; }
  p, li { orphans: 2; widows: 2; }
  li { margin: 3px 0; }
  blockquote { margin: 10px 0; padding: 8px 12px; background: #f5f6fb; border-left: 3px solid #5b5bf0;
    border-radius: 4px; break-inside: avoid; }
  blockquote p { margin: 3px 0; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; break-inside: avoid; font-size: 10pt; }
  th, td { border: 1px solid #e5e7f0; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f5f6fb; }
  hr { display: none; }`;
$("pdfBtn").onclick = async () => {
  const title = document.createElement("title");
  title.textContent = safeName(reportTitle) + "-课后精讲";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${title.outerHTML}
    <style>${PRINT_CSS}</style></head><body><div class="brand">课堂同传 · 课后精讲</div>${md2html(reportMd)}</body></html>`;
  const r = await (await apiFetch("/api/pdf", { method: "POST", body: JSON.stringify({ html, name: title.textContent }) })).json();
  if (r.ok) toast(`已导出 PDF：${r.file}`);
  else if (r.msg) toast(r.msg);
};

$("exportBtn").onclick = () => {
  if (tab === "report") return reportMd && download(`${safeName(reportTitle)}-课后精讲.md`, reportMd);
  let md = `# 课堂笔记\n\n## AI 总结\n\n${summaryMd}\n\n## 转写\n\n`;
  for (const el of Object.values(lines))
    {
    const zh = el.querySelector(".zh");
    md += `**[${el.querySelector(".t").textContent}]** ${el.querySelector(".en").textContent}\n\n` + (zh.classList.contains("tag") ? "" : `> ${zh.textContent}\n\n`);
  }
  download(`课堂笔记-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}.md`, md);
};

// ---------- AI 模型与 API：key（修改 / 删除）、模型、苹果翻译 ----------
// 每家 key 的编辑状态：keep 保持不变 / edit 正在填新的 / remove 保存后删除
const keyMode = {};
function showKey(p, k, mode) {
  keyMode[p] = mode;
  const saved = $(p + "Saved"), input = $(p + "Key"), state = $(p + "State");
  saved.hidden = !k.set || mode === "edit";
  input.hidden = k.set && mode !== "edit";
  saved.classList.toggle("removing", mode === "remove");
  $(p + "Mask").textContent = "••••••••••" + (k.tail || "");
  $(p + "Edit").hidden = mode === "remove";
  $(p + "Del").textContent = mode === "remove" ? "撤销删除" : "删除";
  state.textContent = mode === "remove" ? "保存后删除" : k.set ? "已保存" : "未填写";
  state.classList.toggle("ok", k.set && mode !== "remove");
  if (mode === "edit") { input.value = ""; input.placeholder = k.set ? "粘贴新的 key（取消则保留原来的）" : input.placeholder; input.focus(); }
}
let keys = {};
async function openSettings() {
  const src = $("speaker").value === "auto" ? "en" : $("speaker").value;
  let st;
  try { st = await (await apiFetch(`/api/settings?src=${src}&tgt=${$("target").value}`)).json(); }
  catch { return toast("连不上本地服务，打不开"); }
  keys = { gemini: st.gemini, claude: st.claude };
  for (const p of ["gemini", "claude"]) { $(p + "Key").value = ""; showKey(p, keys[p], "keep"); }
  fillSelect($("geminiModel"), st.gemini_models, st.gemini_model);
  fillSelect($("claudeModel"), st.claude_models, st.claude_model);
  const pair = `${SPEAKERS[src]} → ${TARGETS[$("target").value]}`;
  $("appleState").textContent = { installed: `${pair}：已可用`, supported: `${pair}：还没下载`, unsupported: `${pair}：不支持` }[st.apple] || "";
  $("appleState").classList.toggle("ok", st.apple === "installed");
  $("settings").showModal();
}
for (const p of ["gemini", "claude"]) {
  $(p + "Edit").onclick = () => showKey(p, keys[p], "edit");
  $(p + "Del").onclick = () => showKey(p, keys[p], keyMode[p] === "remove" ? "keep" : "remove");
}
$("settingsBtn").onclick = openSettings;
$("settingsCancel").onclick = () => $("settings").close();
$("openTr").onclick = () => apiFetch("/api/open-translation-settings", { method: "POST" })
  .then(() => toast("在「翻译语言」里下载需要的语言，下载完回来就能用"));
$("settingsSave").onclick = async () => {
  const body = { gemini_model: $("geminiModel").value, claude_model: $("claudeModel").value };
  for (const p of ["gemini", "claude"]) {
    if (keyMode[p] === "remove") body[`clear_${p}_key`] = true;
    else body[`${p}_key`] = $(p + "Key").value; // 空着就是不修改
  }
  const btn = $("settingsSave");
  btn.disabled = true; btn.textContent = "正在测试 key…"; // 测试要联网，可能要等几秒到十几秒
  try {
    const r = await (await apiFetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })).json();
    if (!r.ok) return toast(r.msg || "保存失败");
    $("settings").close();
    toast(r.msg || "已保存，马上生效");
  } catch { toast("保存失败：连不上本地服务"); }
  finally { btn.disabled = false; btn.textContent = "保存"; }
};

// ---------- 更新：打开时查一次；Windows 点一下自动装好，Mac 下载好安装包后要自己拖进「应用程序」 ----------
let upd = { state: "none" }, updTimer = null;
const isWin = () => window.APP_INFO?.caps.platform === "win32";
async function updCall(path, method = "POST") {
  try { upd = await (await apiFetch(path, { method })).json(); } catch {}
  renderUpdate();
}
function renderUpdate() {
  const s = upd.state;
  $("updBtn").hidden = !upd.latest || s === "none";
  $("updBtn").textContent = s === "downloading" ? `正在下载新版 ${upd.percent}%` : `有新版 v${upd.latest}，点击更新`;
  $("updTitle").textContent = `有新版本 v${upd.latest}`;
  const busy = s === "downloading";
  $("updGo").disabled = busy;
  $("updGo").hidden = false;
  $("updGo").textContent = busy ? `正在下载 ${upd.percent}%` : isWin() ? "下载并安装" : "下载安装包";
  $("updHint").textContent = "";
  if (s === "available") {
    $("updText").textContent = `现在用的是 v${upd.current}。`;
    $("updHint").textContent = isWin() ? "下载完会自动安装，装好后课堂同传会重新打开。" : "下载完会打开安装包，把「课堂同传」拖进「应用程序」替换旧版就行。";
  } else if (busy) {
    $("updText").textContent = "正在下载新版，可以先关掉这个窗口继续用，下载好会提示。";
  } else if (s === "ready") {
    $("updText").textContent = isWin() ? "正在安装，课堂同传马上会关闭，装好后自动重新打开。"
      : "安装包已经打开。请先退出课堂同传，再把安装包窗口里的「课堂同传」拖进「应用程序」，提示时选「替换」。";
    $("updGo").textContent = "退出课堂同传";
    $("updGo").hidden = isWin();
  } else if (s === "error") {
    $("updText").textContent = `${upd.msg}。可以再试一次，或者打开下载页自己下载。`;
    $("updGo").textContent = "再试一次";
  }
  clearTimeout(updTimer);
  if (busy) updTimer = setTimeout(async () => {
    await updCall("/api/update", "GET");
    if (upd.state !== "downloading" && !$("update").open) $("update").showModal(); // 下载完（或失败）时把窗口弹回来
  }, 700);
}
$("updBtn").onclick = () => { renderUpdate(); $("update").showModal(); };
$("updLater").onclick = () => $("update").close();
$("updPage").onclick = () => apiFetch("/api/update-page", { method: "POST" });
$("updGo").onclick = () => {
  if (upd.state === "ready") return apiFetch("/api/quit", { method: "POST" });
  if (state !== "idle") return toast("正在录制，结束录制后再更新");
  updCall("/api/update-install");
};

// App：按这台电脑能用的功能调整选项，第一次打开先看隐私说明
apiFetch("/api/app-info").then((r) => r.json()).then((info) => {
  window.APP_INFO = info;
  if (info.version) $("ver").textContent = ` · v${info.version}`;
  updCall("/api/update-check");
  $("saveAudio").checked = !!info.saveAudio;
  $("keepWrap").hidden = !info.saveAudio;
  $("keepDays").value = String(info.audioKeepDays ?? 7);
  if (!info.caps.appleAsr) delete ASRS.apple;
  if (!info.caps.localAsr) delete ASRS.local;
  fillSelect($("asr"), ASRS, load("asr2", Object.keys(ASRS)[0], ASRS));
  if ($("asr").value === "local" && load("speaker", "en", ALL_SPEAKERS) !== "en") $("asr").value = "cloud"; // 上次选的语言不是英语
  refreshSpeakers();
  for (const el of document.querySelectorAll(".apple-only")) el.hidden = !(info.caps.appleAsr || info.caps.appleTranslate);
  if (!info.caps.appleTranslate) delete TRANSLATORS.apple;
  fillSelect($("translator"), TRANSLATORS, load("translator", "gemini", TRANSLATORS));
  $("credit").title = "课堂同传 v" + info.version; // 版本号放在悬停提示里
  listMics();
  if (!info.privacyAccepted) $("privacy").showModal();
});
$("privacy").addEventListener("cancel", (e) => e.preventDefault()); // 必须点「我知道了」
$("privacyOk").onclick = async () => { await apiFetch("/api/privacy-accepted", { method: "POST" }); $("privacy").close(); };
$("openRecords").onclick = () => apiFetch("/api/open-records-folder", { method: "POST" });
