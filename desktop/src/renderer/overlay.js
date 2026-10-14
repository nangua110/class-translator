// 悬浮字幕页面：显示主进程推来的两行字，处理拖动、拉宽和几个小按钮
const $ = (id) => document.getElementById(id);
let cur = null;

/** 英文太长时只留最后两行（老师刚说的部分），前面用省略号 */
function fitTail(el, text, lines = 2) {
  el.textContent = text;
  const max = parseFloat(getComputedStyle(el).lineHeight) * lines + 2;
  if (el.scrollHeight <= max) return;
  const words = text.split(" ");
  let lo = 1, hi = words.length - 1;
  while (lo < hi) { // 二分找最多能留几个词
    const mid = Math.ceil((lo + hi) / 2);
    el.textContent = "…" + words.slice(-mid).join(" ");
    if (el.scrollHeight <= max) lo = mid; else hi = mid - 1;
  }
  el.textContent = "…" + words.slice(-lo).join(" ");
}

function render(s) {
  cur = s;
  document.documentElement.style.setProperty("--font", `${s.font}px`);
  document.documentElement.style.setProperty("--op", s.opacity);
  document.body.classList.toggle("locked", s.locked);
  $("hideBtn").title = `隐藏悬浮字幕（${s.shortcut} 可以随时显示 / 隐藏）`;
  const en = $("en");
  en.classList.toggle("low", !!s.low);
  en.classList.toggle("idle", !s.en);
  if (s.en) fitTail(en, s.en); else en.textContent = "字幕会显示在这里";
  $("zh").textContent = s.zh;
  renderHist(s);
  report();
}

/** 拉高时的列表：前面每一句的英文和它自己的翻译，最下面是老师正在说、还没说完的这句 */
function renderHist(s) {
  const box = $("hist");
  box.replaceChildren();
  const row = (en, zh, cls = "") => {
    const r = document.createElement("div");
    r.className = "row";
    const e = document.createElement("p"); e.className = `en ${cls}`; e.textContent = en; r.append(e);
    if (zh !== null) { const z = document.createElement("p"); z.className = zh ? "zh" : "zh wait"; z.textContent = zh || "翻译中…"; r.append(z); }
    box.append(r);
  };
  for (const l of s.lines ?? []) row(l.en, l.same ? null : l.zh, l.low ? "low" : "");
  if (s.live && s.en) row(s.en, null);
  if (!box.childElementCount) row("字幕会显示在这里", null, "idle");
}

const PAD = 22; // 字幕条上下的留白
const isTall = () => innerHeight > $("cur").offsetHeight + PAD + 8;
function report() { // 告诉主进程「只显示一句」要多高；窗口比这高就是拉高了，切成列表
  window.overlay.height($("cur").offsetHeight + PAD);
  document.body.classList.toggle("tall", isTall());
}
new ResizeObserver(report).observe($("cur"));
addEventListener("resize", report);
window.overlay.onState(render);

// 拖动整条字幕；按住左右边缘是拉宽
$("bar").addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.target.closest("button") || cur?.locked) return;
  const edge = e.target.dataset.edge, sx = e.screenX, sy = e.screenY;
  e.target.setPointerCapture(e.pointerId);
  window.overlay.grab();
  const move = (ev) => window.overlay.move(ev.screenX - sx, ev.screenY - sy, edge);
  const up = () => {
    e.target.removeEventListener("pointermove", move);
    window.overlay.release();
    if (edge && cur?.en) fitTail($("en"), cur.en);
  };
  e.target.addEventListener("pointermove", move);
  e.target.addEventListener("pointerup", up, { once: true });
  e.target.addEventListener("pointercancel", up, { once: true });
});

$("tools").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || !cur) return;
  const v = Number(b.dataset.v);
  if (b.dataset.act === "font") window.overlay.prefs({ font: cur.font + v });
  else if (b.dataset.act === "opacity") window.overlay.prefs({ opacity: Math.round((cur.opacity + v) * 100) / 100 });
  else if (b.dataset.act === "compact") window.overlay.prefs({ compact: true });
  else if (b.dataset.act === "lock") window.overlay.prefs({ locked: true });
  else if (b.dataset.act === "hide") window.overlay.hide();
});

// 锁定时整个窗口不接鼠标，只有鼠标移到「解锁」上时临时接一下
$("unlock").addEventListener("mouseenter", () => window.overlay.hot(true));
$("unlock").addEventListener("mouseleave", () => window.overlay.hot(false));
$("unlock").addEventListener("click", () => { window.overlay.hot(false); window.overlay.prefs({ locked: false }); });
addEventListener("resize", () => { if (cur?.en) fitTail($("en"), cur.en); });
