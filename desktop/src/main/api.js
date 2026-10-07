import { CLAUDE_MODELS, GEMINI_MODELS, TARGET_LANGS, TRANSLATORS } from "./langs.js";
import { friendly, simplify } from "./text.js";
import { isAuthError } from "./llm/errors.js";
import { reportMarkdown } from "./store/records.js";
import fs from "node:fs";
import { RELEASES } from "./update.js";
import { isRecordingTo, listAudio, readAudioChunk } from "./store/audio.js";

const LABEL = { gemini: "Gemini", claude: "Claude" };
const KEEP_DAYS = [0, 3, 7, 30];  // 录音保留天数的可选项；0 = 一直保留
const AUDIO_CHUNK_SEC = 120;     // 播放录音时一次给窗口多长一段
const safeName = (s) => String(s ?? "课后精讲").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);

/** 窗口调用的全部接口（与网页版 /api/* 同名同参数，前端改动最小） */
export function createApi({ settings, llm, appleTr, records, caps, version, openExternal, openPath, askMic, savePdf, cleanAudio, checkUpdate }) {
  const audioPrefs = () => ({ saveAudio: !!settings.pref("saveAudio", false), audioKeepDays: settings.pref("audioKeepDays", 7) });
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
      case "GET /api/app-info": return { caps, version, privacyAccepted: settings.pref("privacyAccepted", false), ...audioPrefs() };
      case "POST /api/prefs":
        if (typeof body?.saveAudio === "boolean") settings.setPref("saveAudio", body.saveAudio);
        if (KEEP_DAYS.includes(body?.audioKeepDays)) { settings.setPref("audioKeepDays", body.audioKeepDays); cleanAudio?.(); }
        return { ok: true, ...audioPrefs() };
      case "GET /api/audio": { // 从第 t 秒起的一小段原声
        const name = q.get("record");
        const chunk = records.hasAudio(name) ? readAudioChunk(records.audioFile(name), Number(q.get("t")) || 0, AUDIO_CHUNK_SEC) : null;
        return chunk ? { ok: true, ...chunk } : { ok: false };
      }
      case "GET /api/audios": { // 「查看录音」里的列表
        const keep = audioPrefs().audioKeepDays;
        return listAudio(records.dir).map((a) => ({
          record: `${a.stem}.md`, ...a, title: records.readReport(`${a.stem}.md`)?.title ?? "",
          days_left: keep > 0 ? Math.max(0, Math.ceil(keep - (Date.now() - a.mtime) / 86400_000)) : null,
        }));
      }
      case "POST /api/audio-delete": { // 只删录音，文字记录和课后精讲不动
        const name = body?.record;
        if (!records.hasAudio(name)) return { ok: false, msg: "找不到这段录音" };
        if (isRecordingTo(records.audioFile(name))) return { ok: false, msg: "这节课还在录，结束录制后才能删除录音" };
        try { fs.unlinkSync(records.audioFile(name)); } catch (e) { return { ok: false, msg: `删除失败：${friendly(e)}` }; }
        return { ok: true };
      }
      case "POST /api/update-check": return { current: version, latest: checkUpdate ? await checkUpdate() : null }; // 打开窗口时查一次有没有新版
      case "POST /api/update-page": openExternal(`${RELEASES}/latest`); return { ok: true };
      case "POST /api/privacy-accepted":
        settings.setPref("privacyAccepted", true);
        try { records.ensureDir(); } catch {} // 让系统的「文稿」权限询问在这时弹出，而不是上课中途
        return { ok: true };
      case "POST /api/mic-access": return { granted: await askMic() };
      case "GET /api/settings": return getSettings(q);
      case "POST /api/settings": return saveSettings(body);
      case "GET /api/records": return records.list().map((r) => ({ ...r, has_report: r.hasReport, has_audio: r.hasAudio })); // 界面沿用网页版字段名
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
