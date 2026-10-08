import { TimeoutError } from "./errors.js";

/** 用户填的接口地址：去掉首尾空格、结尾的斜杠，以及误贴进来的 /chat/completions */
export function normalizeBase(s) {
  return String(s ?? "").trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "").replace(/\/+$/, "");
}
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** 是不是这台电脑上跑的模型（Ollama、LM Studio 之类）：不用 key，也可以不加密 */
export function isLocalBase(base) {
  try { return LOCAL_HOSTS.has(new URL(base).hostname); } catch { return false; }
}
/** 地址能用就返回空字符串，否则返回给用户看的原因 */
export function checkBase(base) {
  let u;
  try { u = new URL(base); } catch { return "接口地址格式不对，应该像 https://…/v1 这样"; }
  if (u.protocol === "https:" || (u.protocol === "http:" && isLocalBase(base))) return "";
  return "接口地址要以 https:// 开头（只有这台电脑上的本地模型可以用 http://）";
}

/** OpenAI 兼容接口：DeepSeek、OpenAI、OpenRouter、本地 Ollama 等大多数服务都支持这种格式 */
export class OpenAICompat {
  constructor({ base, apiKey, fetch = globalThis.fetch }) {
    Object.assign(this, { base, apiKey, fetch });
  }
  /** 只发各家都认的字段（不带 max_tokens、temperature，有的模型不收） */
  async chat({ model, system, prompt, timeoutMs }) {
    const ctl = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { ctl.abort(); reject(new TimeoutError(`超过 ${Math.round(timeoutMs / 1000)} 秒没有响应`)); }, timeoutMs);
    });
    try {
      return await Promise.race([this.#request(model, system, prompt, ctl.signal), timeout]);
    } finally { clearTimeout(timer); }
  }
  async #request(model, system, prompt, signal) {
    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    let resp, text;
    try {
      resp = await this.fetch(`${this.base}/chat/completions`, { method: "POST", headers, signal,
        body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], stream: false }) });
      text = await resp.text();
    } catch (e) {
      throw Object.assign(new Error("连不上接口地址"), { unreachable: true, cause: e });
    }
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!resp.ok) {
      const detail = data?.error?.message ?? (typeof data?.error === "string" ? data.error : data?.message) ?? String(text).slice(0, 200);
      throw Object.assign(new Error(`${resp.status} ${detail}`), { status: resp.status });
    }
    const content = data?.choices?.[0]?.message?.content;
    const raw = Array.isArray(content) ? content.map((p) => p?.text ?? "").join("") : String(content ?? "");
    const out = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim(); // 有的模型把思考过程也放在回复里
    if (!out) throw new Error("模型没有返回内容");
    return out;
  }
}
