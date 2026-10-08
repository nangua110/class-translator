// 网页上可选的语言、翻译方式、模型等常量（与网页版 server.py / llm.py 保持一致）
export const SPEAKER_LANGS = { auto: "自动（中/英）", en: "英语", zh: "中文", ja: "日语", ko: "韩语", fr: "法语", de: "德语", es: "西班牙语" };
export const TARGET_LANGS = { zh: "简体中文", en: "英语", ja: "日语", ko: "韩语", fr: "法语", de: "德语", es: "西班牙语" };
// AI 模型会结合上文纠正识别错字；苹果自带是本地直译，只做备用
export const TRANSLATORS = { gemini: "Gemini（推荐，会纠正识别错字）", claude: "Claude（会纠正识别错字）", openai: "其他模型（DeepSeek、OpenAI 等）", apple: "苹果自带（免费、本地、直译）" };
export const PROVIDER_LABELS = { gemini: "Gemini", claude: "Claude", openai: "其他模型" };
// 「其他模型」的常用服务商：选了就自动填好接口地址和推荐的模型名，都可以再改
export const OPENAI_PRESETS = {
  deepseek: { label: "DeepSeek", base: "https://api.deepseek.com/v1", model: "deepseek-flash", hint: "在 DeepSeek 开放平台申请 key（按用量付费）。" },
  openai: { label: "OpenAI", base: "https://api.openai.com/v1", model: "gpt-5.4-mini", hint: "在 OpenAI 平台申请 key（按用量付费）。" },
  openrouter: { label: "OpenRouter（一个 key 用多家模型）", base: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-v4.1-flash", hint: "在 OpenRouter 申请 key，模型名要带上厂商前缀。" },
  ollama: { label: "本地 Ollama（不联网，不用 key）", base: "http://localhost:11434/v1", model: "qwen3:8b", hint: "先在这台电脑上装好 Ollama 并下载模型，模型名填你下载的那个；不用填 key。" },
  custom: { label: "自定义", base: "", model: "", hint: "填服务商给的 OpenAI 兼容接口地址（一般以 /v1 结尾）、模型名和 key。" },
};
export const APPLE_LOCALES = { auto: "en-US", en: "en-US", zh: "zh-CN", ja: "ja-JP", ko: "ko-KR", fr: "fr-FR", de: "de-DE", es: "es-ES" };
export const APPLE_TR_LANGS = { en: "en", zh: "zh-Hans", ja: "ja", ko: "ko", fr: "fr", de: "de", es: "es" };
export const CLAUDE_MODELS = {
  "claude-opus-5-5": "Claude Opus 5.5（最强）",
  "claude-sonnet-5-5": "Claude Sonnet 5.5（均衡）",
  "claude-haiku-4-5": "Claude Haiku 4.5（最快最便宜）",
};
// 免费版每个模型每天各有额度，多列几个模型 = 额度叠加；前一个繁忙 / 用完就换下一个
export const FAST_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.7-flash", "gemini-3.8-flash", "gemini-3.6-flash"];
export const SUMMARY_MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
export const GEMINI_MODELS = { auto: "自动轮换（推荐，几个模型的免费额度叠加）", ...Object.fromEntries(FAST_MODELS.map((m) => [m, m])) };
export const SR = 16000;
export const SUMMARY_INTERVAL_MS = 180_000; // 每隔多久自动更新一次课堂笔记
export const SUMMARY_CONTEXT_CHARS = 2000;   // 整理新一段笔记时，给 AI 看前面笔记的最后多少字（只为衔接，不让它改）
export const SUMMARY_RETRY_MS = 30_000;     // 课堂笔记更新失败后多久再试
