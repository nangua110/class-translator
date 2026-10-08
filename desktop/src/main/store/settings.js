import fs from "node:fs";
import path from "node:path";

const KEY_RE = /^[\w\-.]{10,300}$/;
const PROVIDERS = ["gemini", "claude", "openai"];

/** 偏好存普通 JSON；API key 用系统加密（Mac 钥匙串 / Windows DPAPI）后再存，绝不存明文 */
export class Settings {
  constructor(file, crypto) {
    this.file = file;
    this.crypto = crypto;
    try { this.data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { this.data = {}; }
    this.data.prefs ??= {};
    this.data.keys ??= {};
  }
  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }
  pref(key, def) { return this.data.prefs[key] ?? def; }
  setPref(key, value) { this.data.prefs[key] = value; this.#save(); }
  getKey(provider) {
    const enc = this.data.keys[provider];
    if (!enc) return "";
    try { return this.crypto.decryptString(Buffer.from(enc, "base64")); } catch { return ""; }
  }
  setKey(provider, value) {
    if (!PROVIDERS.includes(provider)) throw new Error("未知的服务");
    const v = String(value).trim();
    if (!KEY_RE.test(v)) throw new Error("API key 格式不对（不能有空格或中文）");
    if (!this.crypto.isEncryptionAvailable()) throw new Error("系统加密不可用，无法安全保存 key");
    this.data.keys[provider] = this.crypto.encryptString(v).toString("base64");
    this.#save();
  }
  clearKey(provider) { delete this.data.keys[provider]; this.#save(); }
  keyState(provider) {
    const v = this.getKey(provider);
    return { set: !!v, tail: v.length > 8 ? v.slice(-4) : "" }; // 只给末 4 位
  }
}
