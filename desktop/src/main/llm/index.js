import { GoogleGenAI } from "@google/genai";
import Anthropic from "@anthropic-ai/sdk";
import { FAST_MODELS, SUMMARY_MODELS } from "../langs.js";
import { NoKey, withTimeout } from "./errors.js";
import { GeminiPool, orderModels } from "./gemini.js";
import { askClaude } from "./claude.js";
import { TRANSLATE_SYSTEM, SUMMARY_SYSTEM, REPORT_OUTLINE_SYSTEM, REPORT_BODY_SYSTEM, RECOGNIZE_SYSTEM, RECOGNIZE_SCHEMA } from "./prompts.js";

const DEFAULT_FACTORIES = {
  gemini: (apiKey) => new GoogleGenAI({ apiKey }),
  claude: (apiKey) => new Anthropic({ apiKey, maxRetries: 1 }),
};

export function parseJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/); // 去掉模型可能加的 ```json 包裹
  if (!m) throw new Error("AI 返回的章节格式不对");
  return JSON.parse(m[0]);
}

export class LLM {
  constructor(settings, factories = DEFAULT_FACTORIES) {
    this.settings = settings;
    this.factories = factories;
    this.configure();
  }
  /** 按当前保存的 key 建客户端；改了 key 之后再调一次就立即生效 */
  configure() {
    const g = this.settings.getKey("gemini"), c = this.settings.getKey("claude");
    this.gemini = g ? new GeminiPool(this.factories.gemini(g)) : null;
    this.claude = c ? this.factories.claude(c) : null;
  }
  available() { return [this.gemini && "gemini", this.claude && "claude"].filter(Boolean); }

  async ask(provider, { system, prompt, effort, maxTokens, timeoutMs, json = false }) {
    if (provider === "gemini") {
      if (!this.gemini) throw new NoKey("还没填写 Gemini 的 API key");
      const models = orderModels(effort === "low" ? FAST_MODELS : SUMMARY_MODELS, this.settings.pref("geminiModel", "auto"));
      const config = { systemInstruction: system, ...(json ? { responseMimeType: "application/json" } : {}) };
      const resp = await this.gemini.generate(models, { contents: prompt, config }, timeoutMs);
      return String(resp.text ?? "").trim();
    }
    if (provider === "claude") {
      if (!this.claude) throw new NoKey("还没填写 Claude 的 API key");
      const model = this.settings.pref("claudeModel", "claude-opus-5-5");
      return withTimeout(askClaude(this.claude, model, { system, prompt, effort, maxTokens }), timeoutMs);
    }
    throw new Error(`未知的服务：${provider}`);
  }

  /** 云端识别（只有 Gemini 能听音频）：一次拿回转写、语言、译文。speakerLabel 为 null 表示自动 */
  async recognize(wav, speakerLabel, targetLabel) {
    if (!this.gemini) throw new NoKey("还没填写 Gemini 的 API key（云端识别要用它）");
    const hint = speakerLabel
      ? `说话人主要讲${speakerLabel}，但旁边也可能有人说别的语言：一律按实际听到的语言逐字转写，绝不能把它翻译成${speakerLabel}；lang 填实际听到的语言。`
      : "";
    // 不附带上文：附带的话模型偶尔会把上文照抄进转写结果
    const contents = [{ role: "user", parts: [
      { inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } },
      { text: "请处理这段录音。" },
    ] }];
    const config = { systemInstruction: RECOGNIZE_SYSTEM(hint, targetLabel), responseMimeType: "application/json", responseJsonSchema: RECOGNIZE_SCHEMA };
    const models = orderModels(FAST_MODELS, this.settings.pref("geminiModel", "auto"));
    const resp = await this.gemini.generate(models, { contents, config }, 6_000); // 正常 1~2 秒就回
    const r = parseJson(resp.text ?? "");
    return { text: String(r.text ?? "").trim(), lang: String(r.lang ?? ""), tr: String(r.translation ?? "").trim() };
  }

  translate(sentence, context, targetLabel, provider) {
    const ctx = context.slice(-3).join("\n") || "（无）";
    return this.ask(provider, { system: TRANSLATE_SYSTEM(targetLabel), prompt: `【上文】\n${ctx}\n\n【当前句】\n${sentence}`,
      effort: "low", maxTokens: 2048, timeoutMs: 10_000 });
  }

  summarize(transcript, previous, targetLabel, provider) {
    let prompt = `课堂转写如下：\n\n${transcript}`;
    if (previous) prompt = `已有笔记（请在此基础上更新、合并，不要丢失已有重点）：\n\n${previous}\n\n` + prompt;
    return this.ask(provider, { system: SUMMARY_SYSTEM(targetLabel), prompt, effort: "medium", maxTokens: 16000, timeoutMs: 120_000 });
  }

  /** 课后精讲：先切带时间的章节（JSON），再写正文。transcript 每行「[hh:mm:ss] 原话」 */
  async report(transcript, targetLabel, provider) {
    const outline = parseJson(await this.ask(provider, { system: REPORT_OUTLINE_SYSTEM(targetLabel), prompt: transcript,
      effort: "medium", maxTokens: 8000, timeoutMs: 300_000, json: true }));
    const chapters = (outline.chapters ?? []).map((c) => `[${c.start} – ${c.end}] ${c.title}：${c.desc}`).join("\n");
    const prompt = `课程标题：${outline.title ?? ""}\n\n章节大纲：\n${chapters}\n\n完整转写：\n${transcript}`;
    const body = await this.ask(provider, { system: REPORT_BODY_SYSTEM(targetLabel), prompt,
      effort: "high", maxTokens: 16000, timeoutMs: 600_000 });
    return { outline, body };
  }

  /** 保存 key 时测一下能不能用 */
  testKey(provider) {
    return this.ask(provider, { system: "只回复 ok", prompt: "ok", effort: "low", maxTokens: 16, timeoutMs: 20_000 });
  }
}
