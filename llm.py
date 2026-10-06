"""翻译和总结用的 LLM 调用。支持 Claude 和 Gemini，网页上可以随时切换、填写 API key。"""
import asyncio
import os
import re
import time

PROVIDER = os.getenv("PROVIDER", "claude").lower()  # 默认用哪家做总结（两家 key 都填了时）
CLAUDE_MODELS = {"claude-opus-5-5": "Claude Opus 5.5（最强）", "claude-sonnet-5-5": "Claude Sonnet 5.5（均衡）",
                 "claude-haiku-4-5": "Claude Haiku 4.5（最快最便宜）"}


def claude_model() -> str:
    return os.getenv("CLAUDE_MODEL", "claude-opus-5-5")


class NoKey(Exception):
    """还没填写这家的 API key。"""
# 都可以写多个（逗号分隔），前一个繁忙/额度用完/超时就换下一个。
# 免费版每个模型每天各有 500 次额度，多列几个模型 = 额度叠加。
FAST_MODELS = "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash,gemini-3.7-flash,gemini-3.8-flash,gemini-3.6-flash"
GEMINI_TRANSLATE_MODEL = os.getenv("GEMINI_TRANSLATE_MODEL", FAST_MODELS)
GEMINI_ASR_MODEL = os.getenv("GEMINI_ASR_MODEL", FAST_MODELS)
GEMINI_SUMMARY_MODEL = os.getenv(
    "GEMINI_SUMMARY_MODEL",
    "gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash,gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite",
)


GEMINI_MODELS = {"auto": "自动轮换（推荐，几个模型的免费额度叠加）",
                 **{m: m for m in FAST_MODELS.split(",")}}


def gemini_order(models: str) -> str:
    """网页上指定了优先用的 Gemini 模型，就把它排到最前；额度用完仍会自动换后面的。"""
    pref = os.getenv("GEMINI_MODEL", "auto")
    names = [m.strip() for m in models.split(",") if m.strip()]
    if pref in names:
        names.remove(pref)
        names.insert(0, pref)
    return ",".join(names)


class AllModelsBusy(Exception):
    """所有模型都在冷却中（额度用完 / 繁忙）。"""

TRANSLATE_SYSTEM = (
    "你是课堂同声传译。把用户给出的【当前句】翻译成自然、准确的{target}。"
    "【上文】只用于理解语境，不要翻译上文。专业术语可在译文后括号保留原词（原词若明显识别错误，括号里写正确拼写）。"
    "语音识别可能有错字，请按语境合理理解。只输出译文，不要任何解释。"
)

RECOGNIZE_SYSTEM = (
    "你是课堂同声传译。听这段课堂录音：\n"
    "1. text：逐字转写原话，保持原语言（中文用简体），不要翻译、不要总结；"
    "如果没有清晰的人声（只有噪音、静音、音乐、听不清的嘀咕），text 返回空字符串；听不清时宁可留空，绝不要猜或编造句子。{speaker_hint}\n"
    "2. lang：原话的语言。\n"
    "3. translation：把 text 翻译成自然、准确的{target}；如果原话本来就是{target}或 text 为空，返回空字符串。"
    "专业术语可在译文后括号保留原词。"
)

SUMMARY_SYSTEM = (
    "你是课堂笔记助手。根据课堂转写，用{target}整理结构化笔记（Markdown）。"
    "格式：用 `- **关键词**：说明` 的要点列表，按主题分组（可用 ### 小标题），"
    "保留公式、数字、例子和老师强调的重点（作业、考试、截止日期要单独标出）。"
    "忽略闲聊和口头禅。只输出笔记本身。"
)


# ---------- 课后精讲（下课后对整节课生成，分两步：先切章节，再写精讲） ----------
REPORT_OUTLINE_SYSTEM = (
    "你是课堂笔记助手。下面是一整节课带时间戳的转写（语音识别可能有错字，请按上下文理解）。"
    "请用{target}输出 JSON：\n"
    '{{"title": "这节课的标题（15 字以内）", "overview": "3~4 句概述：讲了哪些内容、用到哪些工具或方法", '
    '"chapters": [{{"start": "hh:mm:ss", "end": "hh:mm:ss", "title": "章节标题（12 字以内）", '
    '"desc": "1~2 句话：这一段讲了什么"}}]}}\n'
    "章节要求：按时间顺序覆盖整节课，不重叠；start/end 必须用转写里真实出现的时间戳；"
    "按话题切分，大约每 5~10 分钟一章，短课就少几章，不要硬凑。闲聊、调试设备之类的内容并入相邻章节。只输出 JSON。"
)

REPORT_BODY_SYSTEM = (
    "你是课堂笔记助手，要把一整节课整理成学生复习用的「课后精讲」。下面给出章节大纲和带时间戳的完整转写"
    "（语音识别可能有错字，请按上下文理解、纠正）。用{target}输出 Markdown，严格包含以下四个二级标题，顺序不变：\n"
    "## AI 精讲\n"
    "先写一段导读（这节课的主线、建议的阅读顺序）。然后按主题写若干个 ### 小节（主题可以合并相邻章节）。"
    "每个小节先用一两段讲解文字讲清概念和老师的论证思路，再按内容需要选用：时间线或步骤（有序列表）、"
    "对比表（Markdown 表格）、具体例子、类比。老师强调的重点用 **加粗**。需要提醒的地方用引用块，"
    "第一行写「> **注意事项**」；你补充的背景知识（老师没讲、但有助于理解）必须放在「> **补充说明**」引用块里，"
    "和老师讲的内容区分开；类比放在「> **类比**」引用块里。作业、考试、截止日期、评分规则要完整列出，一个都不能漏。\n"
    "## 术语表\n"
    "每个术语一行：「- **术语（英文原词）**：一句话解释」。\n"
    "## 思考题\n"
    "4~6 道有深度的题目，有序列表，每题下一行写「提示：……」。\n"
    "## 核心要点\n"
    "5~8 条有序列表，每条「**要点标题**：一句话说明」。\n"
    "篇幅与课程长度匹配：短课写短，不要编造课上没有的内容（补充说明除外）。不要输出这四部分以外的内容。"
)


def _parse_json(text: str):
    import json

    m = re.search(r"\{.*\}", text, re.S)  # 去掉模型可能加的 ```json 包裹
    if not m:
        raise ValueError("AI 返回的章节格式不对")
    return json.loads(m.group(0))


class LLM:
    def __init__(self):
        self.gemini = self.claude = None
        self.configure()
        self.cooldown: dict[str, float] = {}  # 模型 → 到这个时间点之前先不用它
        self.quota_out: set[str] = set()  # 今天额度已用完的模型

    def configure(self):
        """按当前的 API key 建客户端；网页上改了 key 之后再调一次就立即生效。"""
        self.gemini = self.claude = None
        if os.getenv("GEMINI_API_KEY"):
            from google import genai
            from google.genai import types
            # 关掉 SDK 自带的重试，繁忙时直接换模型，避免一句话卡很久
            self.gemini = genai.Client(
                api_key=os.getenv("GEMINI_API_KEY"),
                http_options=types.HttpOptions(retry_options=types.HttpRetryOptions(attempts=1)),
            )
        if os.getenv("ANTHROPIC_API_KEY"):
            from anthropic import AsyncAnthropic
            self.claude = AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
        self.cooldown, self.quota_out = {}, set()

    def available(self) -> list[str]:
        return [p for p, c in (("gemini", self.gemini), ("claude", self.claude)) if c]

    async def _gemini(self, models: str, contents, cfg, timeout: float):
        """按顺序尝试模型；记住哪些模型额度用完/繁忙，下次直接跳过。"""
        from google.genai import errors

        last_err = None
        now = time.time()
        for model in [m.strip() for m in models.split(",") if m.strip()]:
            if self.cooldown.get(model, 0) > now:
                continue
            try:
                return await asyncio.wait_for(
                    self.gemini.aio.models.generate_content(model=model, contents=contents, config=cfg),
                    timeout,
                )
            except asyncio.TimeoutError as e:
                self.cooldown[model] = time.time() + 60  # 超时的模型一分钟内不再用，免得每句都白等
                last_err = e
            except errors.APIError as e:
                if e.code == 429:
                    msg = str(e)
                    if "PerDay" in msg:  # 今天的额度用完了，等到额度重置
                        m = re.search(r"retryDelay'?:\s*'?(\d+)s", msg)
                        self.cooldown[model] = time.time() + (int(m.group(1)) if m else 6 * 3600)
                        self.quota_out.add(model)
                    else:  # 每分钟次数超了
                        self.cooldown[model] = time.time() + 60
                elif e.code in (500, 503, 504):
                    self.cooldown[model] = time.time() + 15
                else:
                    raise
                last_err = e
        if last_err is None:
            raise AllModelsBusy("所有模型都在冷却中")
        raise last_err

    async def _ask(self, system: str, prompt: str, effort: str, max_tokens: int, provider: str,
                   timeout: float = 120, json_mode: bool = False) -> str:
        if provider == "gemini" and not self.gemini:
            raise NoKey("还没填写 Gemini 的 API key")
        if provider == "claude" and not self.claude:
            raise NoKey("还没填写 Claude 的 API key")
        if provider == "gemini":
            from google.genai import types
            models = GEMINI_TRANSLATE_MODEL if effort == "low" else GEMINI_SUMMARY_MODEL
            cfg = types.GenerateContentConfig(
                system_instruction=system, response_mime_type="application/json" if json_mode else None
            )
            resp = await self._gemini(gemini_order(models), prompt, cfg, timeout)
            return (resp.text or "").strip()

        model = claude_model()
        extra = {}
        if "haiku" not in model:  # Haiku 不支持 effort / fallbacks
            extra = dict(
                output_config={"effort": effort},
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )
        resp = await self.claude.beta.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": prompt}],
            **extra,
        )
        if resp.stop_reason == "refusal":
            return "（模型拒绝处理该段）"
        return "".join(b.text for b in resp.content if b.type == "text").strip()

    async def recognize(self, wav: bytes, speaker: str | None, target: str) -> tuple[str, str, str]:
        """云端听写 + 翻译（仅 Gemini 支持音频）。返回 (原话, 语言代码, 译文)。"""
        if not self.gemini:
            raise NoKey("还没填写 Gemini 的 API key")
        from typing import Literal

        from google.genai import types
        from pydantic import BaseModel

        class Result(BaseModel):
            text: str
            lang: Literal["en", "zh", "ja", "ko", "fr", "de", "es", "other"]
            translation: str

        hint = (
            f"说话人主要讲{speaker}，但旁边也可能有人说别的语言：一律按实际听到的语言逐字转写，"
            f"绝不能把它翻译成{speaker}；lang 填实际听到的语言。" if speaker else ""
        )
        system = RECOGNIZE_SYSTEM.format(speaker_hint=hint, target=target)
        # 不附带上文：附带的话模型偶尔会把上文照抄进转写结果
        prompt = "请处理这段录音。"
        cfg = types.GenerateContentConfig(
            system_instruction=system, response_mime_type="application/json", response_schema=Result
        )
        contents = [types.Part.from_bytes(data=wav, mime_type="audio/wav"), prompt]
        # 正常 1~2 秒就返回，6 秒还没回就当它卡了
        resp = await self._gemini(gemini_order(GEMINI_ASR_MODEL), contents, cfg, timeout=6)
        r = resp.parsed
        if r is None:
            raise ValueError("云端返回格式不对")
        return r.text.strip(), r.lang, r.translation.strip()

    async def translate(self, sentence: str, context: list[str], target: str = "简体中文",
                        provider: str = PROVIDER) -> str:
        ctx = "\n".join(context[-3:]) or "（无）"
        prompt = f"【上文】\n{ctx}\n\n【当前句】\n{sentence}"
        system = TRANSLATE_SYSTEM.format(target=target)
        return await self._ask(system, prompt, effort="low", max_tokens=2048, provider=provider, timeout=10)

    async def summarize(self, transcript: str, previous: str = "", target: str = "简体中文",
                        provider: str = PROVIDER) -> str:
        prompt = f"课堂转写如下：\n\n{transcript}"
        if previous:
            prompt = f"已有笔记（请在此基础上更新、合并，不要丢失已有重点）：\n\n{previous}\n\n" + prompt
        return await self._ask(SUMMARY_SYSTEM.format(target=target), prompt, effort="medium", max_tokens=16000,
                               provider=provider)

    async def report(self, transcript: str, target: str, provider: str) -> tuple[dict, str]:
        """课后精讲。transcript 每行「[hh:mm:ss] 原话」。返回 (大纲 dict, 正文 Markdown)。"""
        outline = _parse_json(await self._ask(
            REPORT_OUTLINE_SYSTEM.format(target=target), transcript, effort="medium",
            max_tokens=8000, provider=provider, timeout=300, json_mode=True,
        ))
        chapters = "\n".join(f"[{c['start']} – {c['end']}] {c['title']}：{c['desc']}" for c in outline.get("chapters", []))
        prompt = f"课程标题：{outline.get('title', '')}\n\n章节大纲：\n{chapters}\n\n完整转写：\n{transcript}"
        body = await self._ask(REPORT_BODY_SYSTEM.format(target=target), prompt, effort="high",
                               max_tokens=16000, provider=provider, timeout=600)
        return outline, body
