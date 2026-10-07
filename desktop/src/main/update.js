import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// 新版发布在 GitHub Releases；检查更新只读「最新版」页面跳到哪个版本号，不带任何个人信息
export const RELEASES = "https://github.com/nangua110/class-translator/releases";
const SUMS_NAME = "SHA256SUMS.txt"; // 每次发布时一起上传：各安装包的校验值
const CHECK_TIMEOUT_MS = 15_000;

const parts = (v) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
export function isNewer(latest, current) {
  const a = parts(latest), b = parts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** 这台电脑该下哪个安装包（文件名和 electron-builder.yml 里的 artifactName 一致） */
export function assetName(version, platform, arch) {
  const a = arch === "arm64" ? "arm64" : "x64";
  if (platform === "darwin") return `ClassTranslator-${version}-${a}.dmg`;
  if (platform === "win32") return `ClassTranslator-${version}-win-${a}-setup.exe`;
  return null;
}

/** 「校验值  文件名」一行一个 */
export function parseSums(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/);
    if (m) out[m[2]] = m[1].toLowerCase();
  }
  return out;
}

/** 检查新版、下载安装包、核对校验值，然后交给 install（Mac 打开安装包；Windows 运行安装程序） */
export class Updater {
  constructor({ version, platform, arch, dir, fetch = globalThis.fetch, redirectOf, install, base = RELEASES }) {
    Object.assign(this, { version, platform, arch, dir, fetch, redirectOf, install, base });
    this.latest = null;
    this.state = "none"; // none 没有新版 / available 有新版 / downloading / ready 已交给安装 / error
    this.percent = 0;
    this.msg = "";
    this.running = null;
  }
  status() { return { current: this.version, latest: this.latest, state: this.state, percent: this.percent, msg: this.msg }; }

  async check() {
    if (this.state === "downloading" || this.state === "ready") return this.status();
    try {
      // 「最新版」页面会跳到 …/releases/tag/v1.2.3：只看它跳到哪个地址（redirectOf），不用下载页面内容
      const url = String(await this.redirectOf(`${this.base}/latest`) ?? ""), prefix = `${this.base}/tag/v`;
      const m = url.startsWith(prefix) ? url.slice(prefix.length).match(/^(\d+\.\d+\.\d+)$/) : null;
      if (m && isNewer(m[1], this.version) && assetName(m[1], this.platform, this.arch)) {
        this.latest = m[1]; this.state = "available"; this.msg = "";
      }
    } catch {} // 连不上就当没有新版，下次打开再查
    return this.status();
  }

  downloadAndInstall() {
    if (!this.latest || this.state === "ready") return Promise.resolve();
    this.running ??= this.#run().finally(() => { this.running = null; });
    return this.running;
  }
  async #run() {
    const name = assetName(this.latest, this.platform, this.arch);
    const base = `${this.base}/download/v${this.latest}`;
    const file = path.join(this.dir, name);
    this.state = "downloading"; this.percent = 0; this.msg = "";
    try {
      const sr = await this.fetch(`${base}/${SUMS_NAME}`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      const want = sr.ok ? parseSums(await sr.text())[name] : null;
      if (!want) throw new Error("这个版本没有提供校验值");
      const r = await this.fetch(`${base}/${name}`);
      if (!r.ok || !r.body) throw new Error(`下载失败（${r.status}）`);
      const total = Number(r.headers.get("content-length")) || 0;
      fs.mkdirSync(this.dir, { recursive: true });
      const hash = crypto.createHash("sha256");
      const out = fs.createWriteStream(file);
      let got = 0;
      try {
        for await (const chunk of r.body) {
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise((res) => out.once("drain", res));
          got += chunk.length;
          if (total) this.percent = Math.min(99, Math.floor((got / total) * 100));
        }
      } finally { await new Promise((res) => out.end(res)); }
      if (hash.digest("hex") !== want) throw new Error("安装包校验没通过，可能下载不完整");
      this.percent = 100;
      await this.install(file);
      this.state = "ready";
    } catch (e) {
      try { fs.rmSync(file, { force: true }); } catch {}
      this.state = "error";
      const m = String(e?.message ?? e);
      this.msg = /校验|下载失败/.test(m) ? m : `下载没成功（${m.slice(0, 60)}）`;
    }
  }
}
