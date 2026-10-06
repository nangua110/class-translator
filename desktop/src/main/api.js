import { CLAUDE_MODELS, GEMINI_MODELS, TARGET_LANGS, TRANSLATORS } from "./langs.js";
import { friendly, simplify } from "./text.js";
import { isAuthError } from "./llm/errors.js";
import { reportMarkdown } from "./store/records.js";

const LABEL = { gemini: "Gemini", claude: "Claude" };
const safeName = (s) => String(s ?? "课后精讲").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);

/** 窗口调用的全部接口（与网页版 /api/* 同名同参数，前端改动最小） */
export function createApi({ settings, llm, appleTr, records, caps, version, openExternal, openPath, askMic, savePdf }) {
  async function getSettings(q) {
    const src = q.get("src") ?? "en", tgt = q.get("tgt") ?? "zh";
    const translators = { ...TRANSLATORS };
    if (!caps.appleTranslate) delete translators.apple;
    return {
      gemini: settings.keyState("gemini"), claude: settings.keyState("claude"),
      gemini_model: settings.pref("geminiModel", "auto"), gemini_models: GEMINI_MODELS,
      claude_model: settings.pref("claudeModel", "claude-opus-5-5"), claude_models: CLAUDE_MODELS,
      translators,
      apple: caps.appleTranslate ? await appleTr.status(src, tgt) : "unsupported",
    };
  }

  async function saveSettings(b = {}) {
    const notes = [];
    if (b.gemini_model in GEMINI_MODELS) settings.setPref("geminiModel", b.gemini_model);
    if (b.claude_model in CLAUDE_MODELS) settings.setPref("claudeModel", b.claude_model);
    for (const p of ["gemini", "claude"]) {
      if (b[`clear_${p}_key`]) { settings.clearKey(p); continue; }
      const value = String(b[`${p}_key`] ?? "").trim();
      if (!value) continue;
      const old = settings.getKey(p);
      try { settings.setKey(p, value); } catch (e) { return { ok: false, msg: e.message }; }
      llm.configure();
      try {
        await llm.testKey(p);
      } catch (e) {
        if (isAuthError(e)) { // key 本身不对：恢复原来的
          if (old) settings.setKey(p, old); else settings.clearKey(p);
          llm.configure();
          return { ok: false, msg: `${LABEL[p]} 的 key 不能用：${friendly(e)}` };
        }
        notes.push(`${LABEL[p]} 的 key 已保存（测试时${friendly(e)}，不影响使用）`);
      }
    }
    llm.configure();
    return { ok: true, msg: notes.join("；") };
  }

  async function makeReport(b = {}) {
    const name = b.record;
    if (!records.exists(name)) return { ok: false, msg: "找不到这节课的记录" };
    const lines = records.transcript(name);
    if (lines.length < 3) return { ok: false, msg: "这节课内容太少，不用生成课后精讲" };
    const avail = llm.available();
    const provider = avail.includes(b.translator) ? b.translator : avail[0];
    if (!provider) return { ok: false, msg: "要生成课后精讲，需要先在「AI 模型与 API」里填写 Gemini 或 Claude 的 key" };
    const target = b.target in TARGET_LANGS ? b.target : "zh";
    const transcript = lines.map(([t, text]) => `[${t}] ${text}`).join("\n");
    try {
      const { outline, body } = await llm.report(transcript, TARGET_LANGS[target], provider);
      const md = simplify(reportMarkdown(outline, body, name.replace(/\.md$/, ""), lines.at(-1)[0]), target);
      const file = records.writeReport(name, md);
      return { ok: true, md, file, title: md.split("\n", 1)[0].replace(/^#\s*/, "") };
    } catch (e) {
      return { ok: false, msg: `课后精讲生成失败：${friendly(e)}` };
    }
  }

  return async function handle(url, method = "GET", body) {
    const u = new URL(url, "app://local");
    const q = u.searchParams;
    switch (`${method} ${u.pathname}`) {
      case "GET /api/app-info": return { caps, version, privacyAccepted: settings.pref("privacyAccepted", false) };
      case "POST /api/privacy-accepted": settings.setPref("privacyAccepted", true); return { ok: true };
      case "POST /api/mic-access": return { granted: await askMic() };
      case "GET /api/settings": return getSettings(q);
      case "POST /api/settings": return saveSettings(body);
      case "GET /api/records": return records.list();
      case "GET /api/report": {
        const r = records.readReport(q.get("record"));
        return r ? { ok: true, ...r } : { ok: false };
      }
      case "POST /api/report": return makeReport(body);
      case "POST /api/open-translation-settings":
        openExternal("x-apple.systempreferences:com.apple.Localization-Settings.extension");
        return { ok: true };
      case "POST /api/open-records-folder": openPath(records.dir); return { ok: true };
      case "POST /api/pdf": return savePdf(String(body?.html ?? ""), safeName(body?.name));
      default: throw new Error(`未知接口：${method} ${u.pathname}`);
    }
  };
}
