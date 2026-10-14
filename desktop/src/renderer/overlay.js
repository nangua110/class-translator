// 悬浮字幕页面：窗口铺满整块屏幕，这里只画字幕条。拖动、拉宽、拉高都在页面里做，窗口不动，所以不抖不闪
const $ = (id) => document.getElementById(id);
const bar = $("bar");
const MIN_W = 360, PAD = 22, SNAP = 1.8; // 最窄宽度；字幕条上下留白；拉到一句高度的 1.8 倍以上才算「多显示几句」
let cur = null;   // 主进程推来的字幕和设置
let geo = null;   // 字幕条位置（相对这块屏幕）：{x, bottom, width, tall}；tall 是拉高后的高度，null = 只显示一句
let drag = null;  // 正在拖 / 拉
let area = null;  // 窗口铺着的这块屏幕在整个桌面上的位置和大小（跨屏拖动时会换）

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
  apply();
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

const oneH = () => $("cur").offsetHeight + PAD; // 只显示一句要多高

/** 把 geo 画到字幕条上；位置收在屏幕里面 */
function apply(h = drag?.h) {
  if (!geo) return;
  const W = area?.width ?? innerWidth, H = area?.height ?? innerHeight; // 刚搬到另一块屏幕时窗口大小可能还没更新，以屏幕大小为准
  geo.width = Math.min(W, Math.max(MIN_W, geo.width));
  geo.x = Math.min(W - geo.width, Math.max(0, geo.x));
  const height = h ?? geo.tall;                       // 正在拉高时用手上的高度
  geo.bottom = Math.min(H, Math.max(height ?? oneH(), geo.bottom));
  bar.style.left = `${geo.x}px`;
  bar.style.width = `${geo.width}px`;
  bar.style.bottom = `${H - geo.bottom}px`;
  if (!bar.classList.contains("collapsing")) {
    bar.style.height = height ? `${Math.min(height, geo.bottom)}px` : "";
    bar.classList.toggle("tall", !!height && height > oneH() + 8);
  }
  bar.classList.add("placed");
}

/** 平滑地回到只显示一句：高度慢慢缩，缩完再换成一句的样子 */
function collapse() {
  const from = bar.offsetHeight, to = oneH();
  geo.tall = null;
  if (from <= to + 2) return apply();
  bar.classList.add("collapsing");
  bar.style.height = `${from}px`;
  bar.offsetHeight; // 让浏览器先记住起点
  bar.style.transition = "height .22s cubic-bezier(.2,.8,.2,1)";
  bar.style.height = `${to}px`;
  const done = () => {
    bar.removeEventListener("transitionend", done);
    clearTimeout(timer);
    bar.style.transition = "";
    bar.classList.remove("collapsing");
    apply();
  };
  const timer = setTimeout(done, 400);
  bar.addEventListener("transitionend", done);
}

const save = () => window.overlay.bar({ ...geo });

window.overlay.onState(render);
window.overlay.onBar((b, a) => { geo = { ...b }; area = a ?? area; apply(); if (cur?.en) fitTail($("en"), cur.en); });
window.overlay.onArea((a) => { area = a; if (drag) drag.crossing = false; apply(); });
addEventListener("resize", () => apply());
new ResizeObserver(() => { if (!drag) apply(); }).observe($("cur"));

// ---------- 鼠标：只有在字幕条上时窗口才接鼠标，别处点下去落到下面的 PPT ----------
let hot = false;
const setHot = (v) => { if (v !== hot) { hot = v; window.overlay.hot(v); } };
document.addEventListener("mousemove", (e) => {
  if (drag) return setHot(true);
  setHot(!!e.target.closest(document.body.classList.contains("locked") ? "#unlock" : "#bar"));
});
document.documentElement.addEventListener("mouseleave", () => { if (!drag) setHot(false); });

// 拖动整条字幕；按住左右边缘拉宽，按住上边拉高
bar.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.target.closest("button") || cur?.locked || bar.classList.contains("collapsing")) return;
  const edge = e.target.dataset.edge ?? "move", sx = e.screenX, sy = e.screenY;
  const g0 = { ...geo }, h0 = bar.offsetHeight;
  // 拖整条时记住鼠标在字幕条里的哪个位置：之后按鼠标在桌面上的绝对位置算，换了屏幕也接得上
  const org = area ?? { x: e.screenX - e.clientX, y: e.screenY - e.clientY };
  const ox = e.screenX - org.x - g0.x, oy = g0.bottom - (e.screenY - org.y);
  drag = { edge, h: edge === "t" ? h0 : undefined, crossing: false };
  bar.classList.add("dragging");
  e.target.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const dx = ev.screenX - sx, dy = ev.screenY - sy;
    if (edge === "move") {
      const a = area ?? { ...org, width: innerWidth, height: innerHeight };
      const px = ev.screenX - a.x, py = ev.screenY - a.y;
      Object.assign(geo, { x: px - ox, bottom: py + oy });
      if (!drag.crossing && (px < 0 || py < 0 || px >= a.width || py >= a.height)) { // 鼠标出了这块屏幕：问主进程要不要搬窗口
        drag.crossing = true;
        window.overlay.cross(ev.screenX, ev.screenY);
      }
    }
    else if (edge === "r") geo.width = g0.width + dx;
    else if (edge === "l") { const w = Math.max(MIN_W, g0.width - dx); Object.assign(geo, { width: w, x: g0.x + g0.width - w }); }
    else if (edge === "t") drag.h = Math.min(g0.bottom, Math.max(oneH(), h0 - dy));
    apply();
    if (edge === "l" || edge === "r") { if (cur?.en) fitTail($("en"), cur.en); }
  };
  const up = (ev) => {
    e.target.removeEventListener("pointermove", move);
    bar.classList.remove("dragging");
    const h = drag.h;
    drag = null;
    if (edge === "t") {
      if (h >= oneH() * SNAP) geo.tall = Math.round(h);
      else { bar.style.height = `${h}px`; collapse(); }  // 拉得不够高（放不下两句）：松手就平滑弹回一句，不停在半截
    }
    apply();
    save();
    setHot(!!document.elementFromPoint(ev.clientX, ev.clientY)?.closest("#bar"));
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
  else if (b.dataset.act === "compact") { collapse(); save(); }
  else if (b.dataset.act === "lock") window.overlay.prefs({ locked: true });
  else if (b.dataset.act === "hide") { setHot(false); window.overlay.hide(); }
});

// 锁定时只有「解锁」按钮接鼠标
$("unlock").addEventListener("click", () => window.overlay.prefs({ locked: false }));
