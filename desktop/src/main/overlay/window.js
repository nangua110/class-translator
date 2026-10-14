import { BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import { EMPTY, nextState } from "./state.js";
import { MIN_W, place } from "./place.js";

export const SHORTCUT = "CommandOrControl+Shift+Y";
export const SHORTCUT_LABEL = process.platform === "darwin" ? "⌘⇧Y" : "Ctrl+Shift+Y";
const DEFAULTS = { font: 26, opacity: 0.65, locked: false };
const FONT = [16, 48], OPACITY = [0.2, 0.95];
const clamp = (v, [lo, hi], def) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);

/** 悬浮字幕：一直浮在最上层（PPT 全屏放映时也在），只显示老师正在说的这句和最近一句翻译。
 *  第一次打开时才建窗口；关掉只是藏起来，再开时内容还在 */
export class Overlay {
  constructor({ settings, preload, page, onVisible = () => {} }) {
    Object.assign(this, { settings, preload, page, onVisible });
    this.state = EMPTY;
    this.win = null;
    this.height = 96;
    this.grab = null; // 正在拖动 / 拉宽时，按下鼠标那一刻的窗口位置
    const p = settings.pref("overlay", {}) ?? {};
    this.prefs = { font: clamp(p.font, FONT, DEFAULTS.font), opacity: clamp(p.opacity, OPACITY, DEFAULTS.opacity), locked: !!p.locked };
    this.saved = p.bounds ?? null;
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
    return place(this.saved, areas, this.height);
  }

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

  #save() {
    if (this.win && !this.win.isDestroyed()) {
      const b = this.win.getBounds();
      this.saved = { x: b.x, bottom: b.y + b.height, width: b.width };
    }
    this.settings.setPref("overlay", { ...this.prefs, bounds: this.saved });
  }

  #listen() {
    const mine = (e) => this.win && !this.win.isDestroyed() && e.sender === this.win.webContents;
    const on = (ch, fn) => ipcMain.on(ch, (e, arg) => { if (mine(e)) fn(arg ?? {}); });
    on("overlay:grab", () => { this.grab = this.win.getBounds(); });
    on("overlay:move", ({ dx, dy, edge }) => {
      const g = this.grab;
      if (!g || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
      if (edge === "r") this.win.setBounds({ ...g, width: Math.max(MIN_W, Math.round(g.width + dx)) });
      else if (edge === "l") {
        const width = Math.max(MIN_W, Math.round(g.width - dx));
        this.win.setBounds({ ...g, x: g.x + g.width - width, width });
      } else this.win.setBounds({ ...g, x: Math.round(g.x + dx), y: Math.round(g.y + dy) });
    });
    on("overlay:release", () => { this.grab = null; this.#save(); });
    on("overlay:height", ({ h }) => { // 内容多高窗口就多高，底边不动
      if (!Number.isFinite(h) || this.grab) return;
      const height = Math.round(Math.min(600, Math.max(40, h)));
      if (height === this.height) return;
      const b = this.win.getBounds();
      this.height = height;
      this.win.setBounds({ ...b, y: b.y + b.height - height, height });
    });
    on("overlay:prefs", (p) => {
      this.prefs = {
        font: clamp(p.font, FONT, this.prefs.font),
        opacity: clamp(p.opacity, OPACITY, this.prefs.opacity),
        locked: typeof p.locked === "boolean" ? p.locked : this.prefs.locked,
      };
      this.#applyLock();
      this.#save();
      this.#push();
    });
    on("overlay:hot", ({ hot }) => this.#applyLock(!!hot));
    on("overlay:hide", () => this.hide());
  }
}
