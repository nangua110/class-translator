import { BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import { EMPTY, nextState } from "./state.js";
import { place, toScreen } from "./place.js";

export const SHORTCUT = "CommandOrControl+Shift+Y";
export const SHORTCUT_LABEL = process.platform === "darwin" ? "⌘⇧Y" : "Ctrl+Shift+Y";
const DEFAULTS = { font: 26, opacity: 0.65, locked: false };
const FONT = [16, 48], OPACITY = [0.2, 0.95];
const clamp = (v, [lo, hi], def) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
const DISPLAY_EVENTS = ["display-added", "display-removed", "display-metrics-changed"];

/** 悬浮字幕：一直浮在最上层（PPT 全屏放映时也在），只显示老师正在说的这句和最近一句翻译。
 *  窗口铺满一整块屏幕、完全透明，字幕条只是页面里的一块：拖动、拉宽、拉高都只改页面，窗口从不变大小，
 *  所以不会抖、不会闪。字幕条以外不接鼠标（点下去落到下面的 PPT），鼠标移到字幕条上时页面告诉我们临时接一下。
 *  第一次打开时才建窗口；关掉只是藏起来，再开时内容还在 */
export class Overlay {
  constructor({ settings, preload, page, onVisible = () => {} }) {
    Object.assign(this, { settings, preload, page, onVisible });
    this.state = EMPTY;
    this.win = null;
    this.area = null; // 字幕条在哪块屏幕上（窗口就铺满这块屏幕）
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
    else this.#layout();
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

  #areas() { return [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].map((d) => d.workArea); }

  /** 窗口铺到字幕条所在的那块屏幕，把字幕条的位置告诉页面 */
  #layout() {
    const { area, bar } = place(this.saved, this.#areas());
    this.area = area;
    this.win.setBounds(area);
    this.win.webContents.send("overlay:bar", bar, area);
  }

  #create() {
    const { area } = place(this.saved, this.#areas());
    const win = new BrowserWindow({
      ...area, show: false, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: false, fullscreenable: false, minimizable: false, maximizable: false,
      backgroundColor: "#00000000", title: "悬浮字幕",
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.setAlwaysOnTop(true, "screen-saver"); // 盖在全屏放映的 PPT 上面
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); // Mac：PPT 全屏是单独的桌面，也要跟过去
    win.setIgnoreMouseEvents(true, { forward: true }); // 默认不接鼠标，但鼠标移动照样告诉页面（页面靠它知道鼠标是不是在字幕条上）
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.on("did-finish-load", () => { this.#layout(); this.#push(); });
    win.loadFile(this.page);
    this.win = win;
    // 接上 / 拔掉外接屏、改分辨率：重新铺满
    const relayout = () => { if (this.visible()) this.#layout(); };
    for (const ev of DISPLAY_EVENTS) screen.on(ev, relayout);
    win.on("closed", () => { for (const ev of DISPLAY_EVENTS) screen.off(ev, relayout); });
  }

  #push() {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send("overlay:state", { ...this.state, ...this.prefs, shortcut: SHORTCUT_LABEL });
  }

  #save() { this.settings.setPref("overlay", { ...this.prefs, bounds: this.saved }); }

  #listen() {
    const mine = (e) => this.win && !this.win.isDestroyed() && e.sender === this.win.webContents;
    const on = (ch, fn) => ipcMain.on(ch, (e, arg) => { if (mine(e)) fn(arg ?? {}); });
    // 鼠标在字幕条上：接鼠标（能拖、能点按钮）；离开：不接，点下去落到下面的 PPT
    on("overlay:hot", ({ hot }) => this.win.setIgnoreMouseEvents(!hot, { forward: true }));
    // 拖完 / 拉完松手：记住位置
    on("overlay:bar", ({ bar }) => {
      if (!bar || !this.area || ![bar.x, bar.bottom, bar.width].every(Number.isFinite)) return;
      this.saved = toScreen(this.area, bar);
      this.#save();
    });
    // 拖着字幕条、鼠标到了另一块屏幕上：把窗口搬过去，页面接着让字幕条跟着鼠标走（不用松手）
    on("overlay:cross", ({ x, y }) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const to = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea;
      if (to.x !== this.area.x || to.y !== this.area.y || to.width !== this.area.width || to.height !== this.area.height) {
        this.area = to;
        this.win.setBounds(to);
      }
      this.win.webContents.send("overlay:area", this.area);
    });
    on("overlay:prefs", (p) => {
      this.prefs = {
        font: clamp(p.font, FONT, this.prefs.font),
        opacity: clamp(p.opacity, OPACITY, this.prefs.opacity),
        locked: typeof p.locked === "boolean" ? p.locked : this.prefs.locked,
      };
      this.#save();
      this.#push();
    });
    on("overlay:hide", () => this.hide());
  }
}
