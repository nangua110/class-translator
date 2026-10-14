import { BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import { EMPTY, nextState } from "./state.js";
import { MIN_W, place } from "./place.js";

export const SHORTCUT = "CommandOrControl+Shift+Y";
export const SHORTCUT_LABEL = process.platform === "darwin" ? "⌘⇧Y" : "Ctrl+Shift+Y";
const DEFAULTS = { font: 26, opacity: 0.65, locked: false };
const FONT = [16, 48], OPACITY = [0.2, 0.95];
const SNAP = 1.8; // 拉高到一句高度的 1.8 倍以上才算「多显示几句」
const clamp = (v, [lo, hi], def) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);

/** 悬浮字幕：一直浮在最上层（PPT 全屏放映时也在），只显示老师正在说的这句和最近一句翻译。
 *  第一次打开时才建窗口；关掉只是藏起来，再开时内容还在 */
export class Overlay {
  constructor({ settings, preload, page, onVisible = () => {} }) {
    Object.assign(this, { settings, preload, page, onVisible });
    this.state = EMPTY;
    this.win = null;
    this.minH = 96;     // 只显示一句时需要的高度（页面量好告诉我们）
    this.tall = null;   // 拉高后的高度；null = 只显示一句
    this.grab = null; // 正在拖动 / 拉宽时，按下鼠标那一刻的窗口位置
    const p = settings.pref("overlay", {}) ?? {};
    this.prefs = { font: clamp(p.font, FONT, DEFAULTS.font), opacity: clamp(p.opacity, OPACITY, DEFAULTS.opacity), locked: !!p.locked };
    this.saved = p.bounds ?? null;
    this.tall = Number.isFinite(p.bounds?.tall) ? p.bounds.tall : null;
    this.#listen();
  }

  tap(m) {
    const next = nextState(this.state, m);
    if (next === this.state) return;
    this.state = next;
    this.#push();
  }

  visible() { return !!this.win && !this.win.isDestroyed() && this.win.isVisible(); }
  toggle() { this.visible() ? this.hide() : this.show(); return this.visible(); }
  hide() { if (this.visible()) { this.win.hide(); this.onVisible(false); } }

  show() {
    if (!this.win || this.win.isDestroyed()) this.#create();
    else this.win.setBounds(this.#bounds());
    this.win.showInactive(); // 不抢走 PPT 的焦点
    this.onVisible(true);
  }

  /** 全局快捷键：在别的软件里（包括 PPT 全屏放映）也能一键显示 / 隐藏。被别的软件占用时就只靠按钮 */
  registerShortcut() {
    try { return globalShortcut.register(SHORTCUT, () => this.toggle()); } catch { return false; }
  }

  destroy() {
    globalShortcut.unregister(SHORTCUT);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }

  #bounds() {
    const areas = [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].map((d) => d.workArea);
    return place(this.saved, areas, this.#height());
  }

  #height() { return Math.round(Math.max(this.minH, this.tall ?? 0)); }

  #create() {
    const win = new BrowserWindow({
      ...this.#bounds(), show: false, frame: false, transparent: true, hasShadow: false, resizable: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: false, fullscreenable: false, minimizable: false, maximizable: false,
      backgroundColor: "#00000000", title: "悬浮字幕",
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.setAlwaysOnTop(true, "screen-saver"); // 盖在全屏放映的 PPT 上面
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); // Mac：PPT 全屏是单独的桌面，也要跟过去
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.on("did-finish-load", () => { this.#applyLock(); this.#push(); });
    win.loadFile(this.page);
    this.win = win;
  }

  #push() {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send("overlay:state", { ...this.state, ...this.prefs, shortcut: SHORTCUT_LABEL });
  }

  /** 锁定：鼠标直接点到下面的 PPT；只有「解锁」按钮那一小块还能点（由页面在鼠标移上去时临时打开） */
  #applyLock(hot = false) {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.prefs.locked && !hot) this.win.setIgnoreMouseEvents(true, { forward: true });
    else this.win.setIgnoreMouseEvents(false);
  }

  #area(b) { return screen.getDisplayMatching(b).workArea; }

  /** 底边不动，把高度在 0.22 秒内平滑地变到 height（先快后慢），不是一下子跳过去 */
  #animateTo(height, ms = 220) {
    clearInterval(this.anim);
    const b = this.win.getBounds(), bottom = b.y + b.height, from = b.height, t0 = Date.now();
    if (from === height) return;
    const step = () => {
      if (this.win.isDestroyed()) return clearInterval(this.anim);
      const k = Math.min(1, (Date.now() - t0) / ms), h = Math.round(from + (height - from) * (1 - (1 - k) ** 3));
      this.win.setBounds({ x: b.x, width: b.width, y: bottom - h, height: h });
      if (k >= 1) { clearInterval(this.anim); this.anim = null; }
    };
    this.anim = setInterval(step, 16);
    step();
  }

  #save({ compact = false } = {}) {
    if (this.win && !this.win.isDestroyed()) {
      const b = this.win.getBounds();
      this.tall = !compact && b.height >= this.minH * SNAP ? b.height : null; // 拉得不够高（放不下两句）：松手就弹回只显示一句，不停在半截
      if (!this.tall && b.height !== this.minH) this.#animateTo(this.minH);
      this.saved = { x: b.x, bottom: b.y + b.height, width: b.width, tall: this.tall };
    }
    this.settings.setPref("overlay", { ...this.prefs, bounds: this.saved });
  }

  #listen() {
    const mine = (e) => this.win && !this.win.isDestroyed() && e.sender === this.win.webContents;
    const on = (ch, fn) => ipcMain.on(ch, (e, arg) => { if (mine(e)) fn(arg ?? {}); });
    // 从上边 / 左边拉：窗口一边挪位置一边改大小时，系统会先把旧画面贴在左上角再重画，字就会抖。
    // 所以按下时先把窗口一次撑到够大（底边 / 右边不动），拉的过程中窗口不动，只让页面里的字幕条变大变小；松手再缩回去
    on("overlay:grab", ({ edge }) => {
      clearInterval(this.anim); this.anim = null;
      const g = this.grab = this.win.getBounds();
      this.edge = edge;
      this.target = null;
      const a = this.#area(g);
      if (edge === "t") this.canvas = { ...g, y: a.y, height: g.y + g.height - a.y };
      else if (edge === "l") this.canvas = { ...g, x: a.x, width: g.x + g.width - a.x };
      else this.canvas = null;
      if (this.canvas) this.win.setBounds(this.canvas);
    });
    on("overlay:move", ({ dx, dy }) => {
      const g = this.grab, edge = this.edge;
      if (!g || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
      if (edge === "r") this.win.setBounds({ ...g, width: Math.max(MIN_W, Math.round(g.width + dx)) });
      else if (edge === "l") {
        const width = Math.min(this.canvas.width, Math.max(MIN_W, Math.round(g.width - dx)));
        this.target = { ...g, x: g.x + g.width - width, width };
        this.win.webContents.send("overlay:frame", { w: width });
      } else if (edge === "t") { // 拉高 / 压矮：底边不动
        const height = Math.round(Math.min(this.canvas.height, Math.max(this.minH, g.height - dy)));
        this.target = { ...g, y: g.y + g.height - height, height };
        this.win.webContents.send("overlay:frame", { h: height });
      } else this.win.setBounds({ ...g, x: Math.round(g.x + dx), y: Math.round(g.y + dy) });
    });
    on("overlay:release", () => {
      if (this.canvas) this.win.setBounds(this.target ?? this.grab);
      this.canvas = this.target = this.grab = null;
      this.win.webContents.send("overlay:frame", null);
      this.#save();
    });
    on("overlay:height", ({ h }) => { // 一句话要多高；只显示一句时窗口跟着内容变高变矮，底边不动
      if (!Number.isFinite(h) || this.grab || this.anim) return;
      this.minH = Math.round(Math.min(600, Math.max(40, h)));
      const b = this.win.getBounds(), height = this.#height();
      if (height !== b.height) this.win.setBounds({ ...b, y: b.y + b.height - height, height });
    });
    on("overlay:prefs", (p) => {
      this.prefs = {
        font: clamp(p.font, FONT, this.prefs.font),
        opacity: clamp(p.opacity, OPACITY, this.prefs.opacity),
        locked: typeof p.locked === "boolean" ? p.locked : this.prefs.locked,
      };
      this.#applyLock();
      this.#save({ compact: !!p.compact }); // 「收起」：平滑地回到只显示一句
      this.#push();
    });
    on("overlay:hot", ({ hot }) => this.#applyLock(!!hot));
    on("overlay:hide", () => this.hide());
  }
}
