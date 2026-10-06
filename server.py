"""课堂实时转写 + 翻译 + 总结。

浏览器采集麦克风 → WebSocket 发送 16kHz PCM → 本地 mlx-whisper 转写 → LLM 翻译 / 总结 → 推回浏览器。
"""
import asyncio
import io
import os
import re
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).parent
# 读取 .env（不依赖额外库）
env_file = ROOT / ".env"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

import json  # noqa: E402

import mlx_whisper  # noqa: E402
import torch  # noqa: E402
from silero_vad import get_speech_timestamps, load_silero_vad  # noqa: E402
from opencc import OpenCC  # noqa: E402
from fastapi import Body, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from llm import CLAUDE_MODELS, GEMINI_MODELS, LLM, PROVIDER, AllModelsBusy, NoKey, claude_model  # noqa: E402

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
# 网页上可选的语言（说话人语言 / 翻译成）
SPEAKER_LANGS = {"auto": "自动（中/英）", "en": "英语", "zh": "中文", "ja": "日语", "ko": "韩语",
                 "fr": "法语", "de": "德语", "es": "西班牙语"}
TARGET_LANGS = {"zh": "简体中文", "en": "英语", "ja": "日语", "ko": "韩语",
                "fr": "法语", "de": "德语", "es": "西班牙语"}
# 识别方式：apple 用苹果自带识别（本地、边说边出字），cloud 交给 Gemini，local 用本地 Whisper
ASR_MODES = {"apple": "苹果自带", "cloud": "云端（Gemini）", "local": "本地（Whisper）"}
DEFAULT_ASR = os.getenv("ASR_MODE", "apple")
# 翻译方式：Gemini / Claude 会结合上文纠正识别错字（翻得准）；苹果自带是本地直译，免费不限量。
# 选了 Gemini/Claude 但额度用完或没填 key 时，自动改用苹果翻译顶上
TRANSLATORS = {"gemini": "Gemini（推荐，会纠正识别错字）", "claude": "Claude（会纠正识别错字）",
               "apple": "苹果自带（免费、本地、直译）"}
DEFAULT_TRANSLATOR = os.getenv("TRANSLATOR", PROVIDER if PROVIDER in TRANSLATORS else "gemini")
APPLE_TR_BIN = ROOT / "apple_asr" / "apple_translate"
APPLE_TR_LANGS = {"en": "en", "zh": "zh-Hans", "ja": "ja", "ko": "ko", "fr": "fr", "de": "de", "es": "es"}
APPLE_BIN = ROOT / "apple_asr" / "apple_asr"
SYSCAP_BIN = ROOT / "apple_asr" / "syscap"  # 录电脑内部声音（视频、电影）
APPLE_LOCALES = {"auto": "en-US", "en": "en-US", "zh": "zh-CN", "ja": "ja-JP", "ko": "ko-KR",
                 "fr": "fr-FR", "de": "de-DE", "es": "es-ES"}
# 苹果识别的把握低于这个值就丢掉：说的不是所选语言时会出拼音一样的乱码，把握通常只有 0.2~0.45
APPLE_MIN_CONF = 0.5
KANA_RE = re.compile(r"[\u3040-\u30ff]")
LATIN_RE = re.compile(r"[A-Za-z]")
DEFAULT_SPEAKER = os.getenv("SPEAKER_LANGUAGE", "auto")
DEFAULT_TARGET = os.getenv("TARGET_LANGUAGE", "zh")
to_simplified = OpenCC("t2s").convert


def simplify(text: str, target: str) -> str:
    """输出中文时统一转成简体：苹果翻译偶尔会混进繁体字（如"一張吞食動物"），AI 偶尔也会。"""
    return to_simplified(text) if target == "zh" and text else text
CJK_RE = re.compile(r"[\u4e00-\u9fff]")
SUMMARY_INTERVAL = int(os.getenv("SUMMARY_INTERVAL_SEC", "180"))  # 每隔多少秒更新一次总结
SR = 16000

# 断句参数：静音超过 SILENCE_SEC 或片段超过 MAX_SEG_SEC 就切一段送去识别
SILENCE_SEC = 0.5
MAX_SEG_SEC = 8.0
MIN_SEG_SEC = 0.6
MIN_VOICE_SEC = 0.3  # 一段里真正的人声不足这么长就不送去识别（省云端额度）
FRAME = 480  # 30ms

# Whisper 在静音/噪音上常见的幻觉输出
HALLUCINATIONS = {
    "thank you.", "thanks for watching!", "thank you for watching.", "you", "bye.",
    "thank you very much.", "please subscribe.", ".", "so", "okay.",
}

app = FastAPI()
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
whisper_pool = ThreadPoolExecutor(max_workers=1)  # MLX 一次只跑一个识别任务
vad_model = load_silero_vad()  # 区分人声和杂音（敲桌子、挪椅子、空调），CPU 上几毫秒


def has_voice(audio: np.ndarray) -> bool:
    """这段音频里有没有足够长的人声。"""
    spans = get_speech_timestamps(torch.from_numpy(audio), vad_model, sampling_rate=SR)
    return sum(s["end"] - s["start"] for s in spans) / SR >= MIN_VOICE_SEC
llm = LLM()


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


REPEAT_RE = re.compile(r"(\S+?)(?:[\s,，、。.]+\1){3,}", re.IGNORECASE)


def collapse_repeats(text: str) -> str:
    """把"喝酒 喝酒 喝酒 ……"这类连续重复（Whisper 卡住复读）合并成一个。"""
    return REPEAT_RE.sub(r"\1", text)


def transcribe(audio: np.ndarray, prompt: str | None, speaker: str) -> tuple[str, str]:
    """返回 (文字, 语言代码)。speaker 为 auto 时自动在中/英文之间判断。"""
    opts = dict(
        path_or_hf_repo=WHISPER_MODEL,
        condition_on_previous_text=False,
        # 允许升温重试：发现复读（压缩率过高）时会换个方式重新识别
        temperature=(0.0, 0.2, 0.4, 0.6),
        compression_ratio_threshold=2.0,
    )
    if speaker != "en":
        # 只有英语模式用英文上文做提示（帮助识别专有名词）；
        # 其他情况提示词会诱导 Whisper 把别的语言"翻译"过来（繁体统一在后面用 OpenCC 转成简体）
        prompt = None
    # 不强制语言，先让 Whisper 判断实际说的是什么：强制成某种语言时，旁边别的语言会被直接"翻译"进来
    result = mlx_whisper.transcribe(audio, language=None, initial_prompt=prompt, **opts)
    detected = result.get("language")
    expected = ("en", "zh") if speaker == "auto" else SPEAKER_LANGS
    if detected == "zh" and not CJK_RE.search(result.get("text", "")):
        # 判断是中文却输出了英文：强制按中文重新识别
        result = mlx_whisper.transcribe(audio, language="zh", **opts)
    elif detected not in expected:
        # 判断成了不在列表里的语言，多半是没听清：按预期语言重新识别
        detected = "en" if speaker == "auto" else speaker
        result = mlx_whisper.transcribe(audio, language=detected, **opts)
    segs = [
        s for s in result.get("segments", [])
        if s.get("no_speech_prob", 0) < 0.6 and s.get("compression_ratio", 0) < 2.4
    ]
    text = collapse_repeats(" ".join(s["text"].strip() for s in segs).strip())
    if text.lower() in HALLUCINATIONS:
        return "", "en"
    # 自动模式按文字内容判断：有汉字算中文，否则算英语（比 Whisper 的判断更可靠）
    lang = ("zh" if CJK_RE.search(text) else "en") if speaker == "auto" else detected
    if lang == "zh":
        text = to_simplified(text)  # Whisper 偶尔会输出繁体
        text = text.replace(",", "，").replace("?", "？").replace("!", "！")
    return text, lang


def friendly(e: Exception) -> str:
    """把 API 报错翻译成看得懂的中文。"""
    msg = str(e)
    if isinstance(e, NoKey):
        return msg
    if "PerDay" in msg or "所有模型都在冷却" in msg:
        return "Gemini 今天的免费额度用完了"
    if "429" in msg:
        return "Gemini 请求太频繁，被限流了"
    if "503" in msg or "UNAVAILABLE" in msg:
        return "Gemini 服务器繁忙"
    if isinstance(e, asyncio.TimeoutError):
        return "Gemini 响应超时"
    if "API key" in msg or "401" in msg or "403" in msg:
        return "API key 无效"
    return f"{type(e).__name__}: {msg[:80]}"


def to_wav(audio: np.ndarray) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())
    return buf.getvalue()


def clean(text: str, lang: str) -> str:
    """云端/本地识别结果统一清理：去复读、繁转简、中文全角标点、去掉常见幻觉。"""
    text = collapse_repeats(text.strip())
    if text.lower() in HALLUCINATIONS:
        return ""
    if lang == "zh":
        text = to_simplified(text).replace(",", "，").replace("?", "？").replace("!", "！")
        text = re.sub(r"\s+([，。？！、；：])", r"\1", text)  # 去掉中文标点前多余的空格
    return text


def apple_lang_ok(text: str, speaker: str) -> bool:
    """苹果识别是按所选语言硬识别的，旁边别的语言会变成乱码：按文字特征把它们挑出来。"""
    cjk, latin = len(CJK_RE.findall(text)), len(LATIN_RE.findall(text))
    if speaker == "zh":
        return cjk > 0 and cjk >= latin and not KANA_RE.search(text)
    if speaker == "ja":
        return bool(KANA_RE.search(text) or cjk)
    if speaker == "ko":
        return bool(re.search(r"[\uac00-\ud7af]", text))
    return cjk == 0 and not KANA_RE.search(text)  # 英、法、德、西


class AppleTranslator:
    """苹果自带翻译的常驻子进程（所有会话共用），一行一个请求。"""

    def __init__(self):
        self.proc = None
        self.pending: dict[int, asyncio.Future] = {}
        self.next_id = 0
        self.lock = asyncio.Lock()

    async def _ensure(self):
        async with self.lock:
            if self.proc and self.proc.returncode is None:
                return
            self.proc = await asyncio.create_subprocess_exec(
                str(APPLE_TR_BIN), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            asyncio.create_task(self._read(self.proc))

    async def _read(self, proc):
        async for raw in proc.stdout:
            try:
                m = json.loads(raw)
            except ValueError:
                continue
            fut = self.pending.pop(m.get("id"), None)
            if fut and not fut.done():
                fut.set_result(m)
        for fut in self.pending.values():  # 进程意外退出
            if not fut.done():
                fut.set_result({"error": "苹果翻译程序退出了", "code": "failed"})
        self.pending.clear()

    async def translate(self, text: str, src: str, tgt: str) -> tuple[str, str]:
        """返回 (译文, 错误码)；错误码为空表示成功，not_installed 表示还没下载这对语言。"""
        if src not in APPLE_TR_LANGS or tgt not in APPLE_TR_LANGS or not APPLE_TR_BIN.exists():
            return "", "unsupported"
        await self._ensure()
        self.next_id += 1
        fut = asyncio.get_running_loop().create_future()
        self.pending[self.next_id] = fut
        req = {"id": self.next_id, "text": text, "src": APPLE_TR_LANGS[src], "tgt": APPLE_TR_LANGS[tgt]}
        self.proc.stdin.write((json.dumps(req, ensure_ascii=False) + "\n").encode())
        try:
            m = await asyncio.wait_for(fut, 15)
        except asyncio.TimeoutError:
            return "", "failed"
        return m.get("tr", ""), m.get("code", "")

    async def status(self, src: str, tgt: str) -> str:
        """installed / supported（可以下载但还没下载）/ unsupported"""
        if src not in APPLE_TR_LANGS or tgt not in APPLE_TR_LANGS or not APPLE_TR_BIN.exists():
            return "unsupported"
        proc = await asyncio.create_subprocess_exec(
            str(APPLE_TR_BIN), "check", APPLE_TR_LANGS[src], APPLE_TR_LANGS[tgt],
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await proc.communicate()
        return out.decode().strip() or "unsupported"


apple_tr = AppleTranslator()


class AppleASR:
    """苹果自带语音识别的子进程：持续喂音频，边说边吐出草稿和确定下来的句子。"""

    def __init__(self, session: "Session", speaker: str, offset: float):
        self.session, self.speaker, self.offset = session, speaker, offset
        self.proc = None
        self.reader = None

    async def start(self):
        self.proc = await asyncio.create_subprocess_exec(
            str(APPLE_BIN), APPLE_LOCALES[self.speaker],
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        self.reader = asyncio.create_task(self._read())

    def feed(self, pcm: bytes):
        if self.proc and self.proc.returncode is None and not self.proc.stdin.is_closing():
            self.proc.stdin.write(pcm)

    async def close(self):
        """不再送音频，等最后一句确定下来。"""
        if not self.proc:
            return
        try:
            self.proc.stdin.close()
            await asyncio.wait_for(self.reader, 10)
        except Exception:
            self.kill()

    def kill(self):
        if self.proc and self.proc.returncode is None:
            self.proc.kill()

    async def _read(self):
        s = self.session
        async for raw in self.proc.stdout:
            try:
                m = json.loads(raw)
            except ValueError:
                continue
            if m["type"] == "partial":
                # 草稿没有把握值，只能按文字特征挡掉一部分别的语言（比如中文模式下的英文）
                if apple_lang_ok(m["text"], self.speaker):
                    await s.send(type="partial", text=m["text"])
            elif m["type"] == "final":
                await s.send(type="partial", text="")
                text = clean(m["text"], "zh" if self.speaker == "zh" else "en")
                if not text or not apple_lang_ok(text, self.speaker):
                    continue
                if 0 <= m.get("conf", -1) < APPLE_MIN_CONF:
                    continue
                lang = "en" if self.speaker == "auto" else self.speaker
                await s.add_line(text, lang, "", self.offset + m["start"])
            elif m["type"] == "downloading":
                await s.send(type="error", msg="第一次用这种语言，正在下载苹果语音模型，稍等片刻…")
            elif m["type"] == "error":
                await s.send(type="error", msg=f"苹果识别出错（{m['msg'][:60]}），改用本地 Whisper")
        if await self.proc.wait() not in (0, -9):  # -9 是我们自己关掉的
            s.apple_failed = self.speaker  # 这种语言用不了苹果识别，退回原来的方式
        if s.apple is self:
            s.apple = None


class Session:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.start = time.time()
        self.lines: list[dict] = []  # {id, t, text 原话, tr 译文, lang}
        self.asr = DEFAULT_ASR if DEFAULT_ASR in ASR_MODES else "cloud"
        self.cloud_fails = 0
        self.apple: AppleASR | None = None
        self.apple_failed = ""  # 苹果识别启动失败的说话人语言，这种语言改用原来的方式
        self.skipped = 0  # 被判定为没有人声、没发出去的片段数
        self.cloud_paused_until = 0.0  # 云端连续失败后暂时改用本地
        self.speaker = DEFAULT_SPEAKER if DEFAULT_SPEAKER in SPEAKER_LANGS else "auto"
        self.target = DEFAULT_TARGET if DEFAULT_TARGET in TARGET_LANGS else "zh"
        self.translator = DEFAULT_TRANSLATOR if DEFAULT_TRANSLATOR in TRANSLATORS else "gemini"
        self.fallback_noted = False  # 已经提示过"改用苹果翻译"了
        self.summary = ""
        self.summarized_upto = 0
        self.summarizing = False
        self.translations: set[asyncio.Task] = set()
        self.translate_slots = asyncio.Semaphore(6)
        self.last_summary_at = time.time()
        self.noise_floor = 0.003
        self.buf: list[np.ndarray] = []
        self.pending = np.zeros(0, dtype=np.float32)
        self.speech = False
        self.silence_frames = 0
        self.record_path = ROOT / "records" / f"{datetime.now():%Y-%m-%d_%H-%M-%S}.md"

    async def send(self, **msg):
        try:
            await self.ws.send_json(msg)
        except Exception:
            pass

    # ---------- 断句 ----------
    def feed(self, chunk: np.ndarray) -> list[np.ndarray]:
        """输入音频，返回已切好的完整语音片段。"""
        out = []
        self.pending = np.concatenate([self.pending, chunk])
        while len(self.pending) >= FRAME:
            frame, self.pending = self.pending[:FRAME], self.pending[FRAME:]
            rms = float(np.sqrt(np.mean(frame**2)))
            is_voice = rms > max(self.noise_floor * 3, 0.006)
            if not is_voice:
                # 缓慢跟踪环境噪音
                self.noise_floor = 0.995 * self.noise_floor + 0.005 * rms
            if is_voice:
                self.speech = True
                self.silence_frames = 0
            elif self.speech:
                self.silence_frames += 1
            if self.speech:
                self.buf.append(frame)
            seg_len = len(self.buf) * FRAME / SR
            if self.speech and (
                self.silence_frames * FRAME / SR >= SILENCE_SEC or seg_len >= MAX_SEG_SEC
            ):
                if seg_len >= MIN_SEG_SEC:
                    out.append(np.concatenate(self.buf))
                self.buf, self.speech, self.silence_frames = [], False, 0
        return out

    def flush(self) -> list[np.ndarray]:
        if self.buf and len(self.buf) * FRAME / SR >= MIN_SEG_SEC:
            seg = np.concatenate(self.buf)
            self.buf = []
            return [seg]
        return []

    # ---------- 处理流水线 ----------
    async def process(self, audio: np.ndarray, t: float):
        if not has_voice(audio):
            self.skipped += 1  # 只有杂音/静音，不发请求
            return
        await self.send(type="status", recognizing=True)
        target = self.target
        context = [l["text"] for l in self.lines[-3:]]
        text, lang, tr = await self.recognize(audio, context, target)
        await self.send(type="status", recognizing=False)
        if not text:
            return
        if self.speaker != "auto" and lang != self.speaker:
            return  # 选了某种说话人语言，就只要这种语言；旁边其他语言的说话一律忽略
        await self.add_line(text, lang, tr, t)

    async def add_line(self, text: str, lang: str, tr: str, t: float):
        """新增一句字幕：去重、推给网页、需要的话后台翻译。"""
        target = self.target
        context = [l["text"] for l in self.lines[-3:]]
        last = self.lines[-1] if self.lines else None
        if last and last["text"] == text and t - last["t"] < 10:
            return  # 几秒内一字不差地重复上一句，基本是杂音引起的胡编
        line = {"id": len(self.lines), "t": t, "text": text, "tr": "", "lang": lang, "same": False}
        self.lines.append(line)
        line["same"] = lang == target  # 原话已经是目标语言，不用翻译
        if not line["same"]:
            line["tr"] = simplify(tr, target)  # 云端识别时译文已经一起返回了
        await self.send(type="line", **line)
        if not (line["same"] or line["tr"]):
            # 本地识别的句子还没译文：翻译放到后台并行跑，不阻塞下一句的识别
            self.translations.add(asyncio.create_task(self.translate(line, context, target)))
        self.save()
        if time.time() - self.last_summary_at >= SUMMARY_INTERVAL:
            asyncio.create_task(self.update_summary())

    async def recognize(self, audio: np.ndarray, context: list[str], target: str) -> tuple[str, str, str]:
        """返回 (原话, 语言, 译文)。优先云端，失败自动改用本地 Whisper。"""
        use_cloud = self.asr == "cloud" and llm.gemini is not None and time.time() >= self.cloud_paused_until
        if use_cloud:
            speaker = None if self.speaker == "auto" else SPEAKER_LANGS[self.speaker]
            try:
                text, lang, tr = await llm.recognize(to_wav(audio), speaker, TARGET_LANGS[target])
                if self.speaker == "auto" and lang not in ("en", "zh"):
                    lang = "zh" if CJK_RE.search(text) else "en"
                self.cloud_fails = 0
                return clean(text, lang), lang, tr
            except Exception as e:
                self.cloud_fails += 1
                msg = f"云端识别失败（{friendly(e)}），这一句改用本地识别"
                if isinstance(e, AllModelsBusy) or "PerDay" in str(e):
                    # 额度用完了：短时间内再试也没用，直接切本地，10 分钟后再看
                    self.cloud_paused_until = time.time() + 600
                    msg = f"{friendly(e)}，接下来 10 分钟改用本地识别，之后自动再试云端"
                elif self.cloud_fails >= 2:
                    self.cloud_paused_until = time.time() + 180
                    msg = f"云端识别连续失败（{friendly(e)}），接下来 3 分钟改用本地识别，之后自动再试云端"
                await self.send(type="error", msg=msg)
        # 本地识别：用同语言的上两句做提示，帮助识别专有名词
        prev = [l for l in self.lines[-2:] if l["lang"] == "en"]
        prompt = " ".join(l["text"] for l in prev) or None
        loop = asyncio.get_running_loop()
        text, lang = await loop.run_in_executor(whisper_pool, transcribe, audio, prompt, self.speaker)
        return text, lang, ""

    async def translate(self, line: dict, context: list[str], target: str):
        async with self.translate_slots:
            line["tr"] = simplify(await self.translate_text(line["text"], line["lang"], context, target), target)
        await self.send(type="translation", id=line["id"], tr=line["tr"])
        self.save()

    async def translate_text(self, text: str, src: str, context: list[str], target: str) -> str:
        """按选的翻译方式翻译；Gemini/Claude 用不了时自动改用苹果翻译顶上。"""
        err = None
        if self.translator != "apple":
            for wait in (0, 3, 8):  # 失败了等一会儿再试，最多 3 次
                await asyncio.sleep(wait)
                try:
                    return await llm.translate(text, context, TARGET_LANGS[target], provider=self.translator)
                except Exception as e:
                    err = e
                    if isinstance(e, (AllModelsBusy, NoKey)) or "PerDay" in str(e):
                        break  # 额度用完 / 没填 key，重试也没用
        tr, code = await apple_tr.translate(text, src, target)
        if tr:
            if err and not self.fallback_noted:
                self.fallback_noted = True
                await self.send(type="error", msg=f"{TRANSLATORS[self.translator][:6]}用不了（{friendly(err)}），"
                                "先改用苹果翻译顶上（直译，不会纠正识别错字）")
            return tr
        if err:
            return f"（翻译失败：{friendly(err)}）"
        if code == "not_installed":
            # 苹果翻译还没下载这对语言：有 key 的话先用 AI 翻译
            for provider in llm.available():
                try:
                    return await llm.translate(text, context, TARGET_LANGS[target], provider=provider)
                except Exception:
                    pass
            return "（苹果翻译还没下载这对语言，请点右上角「设置」下载）"
        return "（翻译失败：苹果翻译不支持这对语言）"

    def summary_provider(self) -> str:
        """总结只能用 AI：优先用选的翻译方式那家，没 key 就用另一家。"""
        avail = llm.available()
        if self.translator in avail:
            return self.translator
        if avail:
            return PROVIDER if PROVIDER in avail else avail[0]
        raise NoKey("要生成总结，需要先在「设置」里填写 Gemini 或 Claude 的 API key")

    async def update_summary(self, final: bool = False):
        if self.summarizing or not self.lines:
            return
        self.summarizing = True
        self.last_summary_at = time.time()
        await self.send(type="summary_status", busy=True)
        try:
            if final:
                text = "\n".join(l["text"] for l in self.lines)
                self.summary = await llm.summarize(text, target=TARGET_LANGS[self.target],
                                                   provider=self.summary_provider())
                self.summarized_upto = len(self.lines)
            else:
                new = self.lines[self.summarized_upto:]
                if new:
                    text = "\n".join(l["text"] for l in new)
                    upto = len(self.lines)
                    self.summary = await llm.summarize(text, self.summary, TARGET_LANGS[self.target],
                                                       provider=self.summary_provider())
                    self.summarized_upto = upto
            self.summary = simplify(self.summary, self.target)
            await self.send(type="summary", md=self.summary)
            self.save()
        except Exception as e:
            await self.send(type="error", msg=f"总结失败：{friendly(e)}")
        finally:
            self.summarizing = False
            await self.send(type="summary_status", busy=False)

    def save(self):
        def ts(t):
            return f"{int(t // 3600):02d}:{int(t % 3600 // 60):02d}:{int(t % 60):02d}"

        parts = [f"# 课堂记录 {self.record_path.stem}\n", "## AI 总结\n", self.summary or "（暂无）", "\n## 转写\n"]
        for l in self.lines:
            parts.append(f"**[{ts(l['t'])}]** {l['text']}\n" + (f"\n> {l['tr']}\n" if l["tr"] else ""))
        self.record_path.write_text("\n".join(parts), encoding="utf-8")


def set_env(key: str, value: str):
    """改 .env 里的一项（没有就加上），同时立即生效。"""
    lines = env_file.read_text().splitlines() if env_file.exists() else []
    for i, line in enumerate(lines):
        if line.strip().startswith(f"{key}="):
            lines[i] = f"{key}={value}"
            break
    else:
        lines.append(f"{key}={value}")
    env_file.write_text("\n".join(lines) + "\n")
    env_file.chmod(0o600)  # key 只有自己能读
    os.environ[key] = value


def key_state(name: str) -> dict:
    v = os.getenv(name, "")
    return {"set": bool(v), "tail": v[-4:] if len(v) > 8 else ""}  # 只给末 4 位，网页上不显示完整 key


@app.get("/api/settings")
async def get_settings(src: str = "en", tgt: str = "zh"):
    return {
        "gemini": key_state("GEMINI_API_KEY"), "claude": key_state("ANTHROPIC_API_KEY"),
        "claude_model": claude_model(), "claude_models": CLAUDE_MODELS,
        "gemini_model": os.getenv("GEMINI_MODEL", "auto"), "gemini_models": GEMINI_MODELS,
        "translators": TRANSLATORS, "default_translator": DEFAULT_TRANSLATOR,
        "apple": await apple_tr.status(src, tgt),
    }


def same_origin(request: Request):
    """只接受本机这个网页发来的修改，别的网站不能偷偷改 key。"""
    origin = request.headers.get("origin")
    if origin not in (None, "http://localhost:8765", "http://127.0.0.1:8765"):
        raise HTTPException(403, "只能在本机网页上修改设置")


@app.post("/api/settings")
async def save_settings(request: Request, body: dict = Body(...)):
    same_origin(request)
    for field, env in (("gemini_key", "GEMINI_API_KEY"), ("claude_key", "ANTHROPIC_API_KEY")):
        v = (body.get(field) or "").strip()
        if body.get(f"clear_{field}"):
            set_env(env, "")
        elif v:
            if not re.fullmatch(r"[\w\-.]{10,300}", v):
                return {"ok": False, "msg": "API key 格式不对（不能有空格或中文）"}
            set_env(env, v)
    if body.get("claude_model") in CLAUDE_MODELS:
        set_env("CLAUDE_MODEL", body["claude_model"])
    if body.get("gemini_model") in GEMINI_MODELS:
        set_env("GEMINI_MODEL", body["gemini_model"])
    llm.configure()
    return {"ok": True}


LINE_RE = re.compile(r"^\*\*\[(\d\d:\d\d:\d\d)\]\*\* (.+)$")


def record_transcript(path: Path) -> list[tuple[str, str]]:
    """从课堂记录里读出 [(时间, 原话)]。"""
    return [m.groups() for line in path.read_text(encoding="utf-8").splitlines() if (m := LINE_RE.match(line))]


def report_markdown(outline: dict, body: str, stem: str, last_ts: str) -> str:
    h, m, sec = (int(x) for x in last_ts.split(":"))
    try:
        started = datetime.strptime(stem, "%Y-%m-%d_%H-%M-%S").strftime("%Y-%m-%d %H:%M")
    except ValueError:
        started = stem
    parts = [f"# {outline.get('title') or '课后精讲'}", "",
             f"> 上课 {started} · 时长 {h}h {m}m {sec}s", "", outline.get("overview", ""), "", "## 章节大纲", ""]
    for c in outline.get("chapters", []):
        parts += [f"- **[{c.get('start', '')} – {c.get('end', '')}] {c.get('title', '')}**  ", f"  {c.get('desc', '')}"]
    return "\n".join(parts) + "\n\n" + body.strip() + "\n"


def report_path(path: Path) -> Path:
    return path.with_name(f"{path.stem}_课后精讲.md")


@app.get("/api/records")
async def list_records():
    """以前录过的课（新的在前），以及有没有生成过课后精讲。"""
    out = []
    for path in sorted((ROOT / "records").glob("*.md"), reverse=True):
        if path.stem.endswith("_课后精讲"):
            continue
        lines = record_transcript(path)
        if not lines:
            continue
        rp = report_path(path)
        title = ""
        if rp.exists():
            first = rp.read_text(encoding="utf-8").split("\n", 1)[0]
            title = first.lstrip("# ").strip()
        h, m, _ = (int(x) for x in lines[-1][0].split(":"))
        out.append({"name": path.name, "stem": path.stem, "lines": len(lines),
                    "minutes": h * 60 + m, "has_report": rp.exists(), "title": title})
    return out


@app.get("/api/report")
async def get_report(record: str):
    path = ROOT / "records" / record
    if not re.fullmatch(r"[\w\-]+\.md", record) or not report_path(path).exists():
        return {"ok": False}
    md = report_path(path).read_text(encoding="utf-8")
    return {"ok": True, "md": md, "title": md.split("\n", 1)[0].lstrip("# ").strip()}


@app.post("/api/report")
async def make_report(request: Request, body: dict = Body(...)):
    """下课后（或任何时候）对一节课生成课后精讲，另存为「记录名_课后精讲.md」。"""
    same_origin(request)
    name = body.get("record", "")
    path = ROOT / "records" / name
    if not re.fullmatch(r"[\w\-]+\.md", name) or not path.exists():
        return {"ok": False, "msg": "找不到这节课的记录"}
    lines = record_transcript(path)
    if len(lines) < 3:
        return {"ok": False, "msg": "这节课内容太少，不用生成课后精讲"}
    avail = llm.available()
    provider = body.get("translator") if body.get("translator") in avail else (avail[0] if avail else None)
    if not provider:
        return {"ok": False, "msg": "要生成课后精讲，需要先在「AI 模型与 API」里填写 Gemini 或 Claude 的 key"}
    target = TARGET_LANGS.get(body.get("target"), "简体中文")
    transcript = "\n".join(f"[{t}] {text}" for t, text in lines)
    try:
        outline, md_body = await llm.report(transcript, target, provider)
    except Exception as e:
        return {"ok": False, "msg": f"课后精讲生成失败：{friendly(e)}"}
    md = simplify(report_markdown(outline, md_body, path.stem, lines[-1][0]), body.get("target", "zh"))
    out = report_path(path)
    out.write_text(md, encoding="utf-8")
    return {"ok": True, "md": md, "file": out.name, "title": outline.get("title", "")}


@app.post("/api/open-translation-settings")
async def open_translation_settings(request: Request):
    """打开 系统设置 → 通用 → 语言与地区（里面的「翻译语言」可以下载苹果翻译模型）。"""
    same_origin(request)
    await asyncio.create_subprocess_exec("open", "x-apple.systempreferences:com.apple.Localization-Settings.extension")
    return {"ok": True}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    s = Session(ws)
    queue: asyncio.Queue = asyncio.Queue()

    async def worker():
        while True:
            item = await queue.get()
            if item is None:
                break
            await s.process(*item)

    task = asyncio.create_task(worker())
    await s.send(type="hello", provider=PROVIDER, record=s.record_path.name,
                 speakers=SPEAKER_LANGS, targets=TARGET_LANGS)
    samples_seen = 0
    syscap = None  # 录电脑内部声音的子进程（音源选了"电脑内部声音"时才有）
    paused = False

    async def on_audio(data: bytes):
        """一段 16kHz int16 音频（来自网页麦克风或电脑内部声音）。"""
        nonlocal samples_seen
        if s.asr == "apple" and s.apple_failed != s.speaker and APPLE_BIN.exists():
            # 苹果识别：音频原样转给子进程，它自己断句、边说边出字
            if s.apple is None:
                s.apple = AppleASR(s, s.speaker, samples_seen / SR)
                await s.apple.start()
            s.apple.feed(data)
            samples_seen += len(data) // 2
            return
        chunk = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
        samples_seen += len(chunk)
        for seg in s.feed(chunk):
            t = max(0.0, samples_seen / SR - len(seg) / SR)
            await queue.put((seg, t))

    async def start_syscap():
        nonlocal syscap
        syscap = await asyncio.create_subprocess_exec(
            str(SYSCAP_BIN), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        proc = syscap

        async def pump():
            while chunk := await proc.stdout.read(3200):
                if not paused:
                    await on_audio(chunk)

        async def watch():
            async for raw in proc.stderr:
                try:
                    m = json.loads(raw)
                except ValueError:
                    continue
                if m.get("type") == "error":
                    await s.send(type="error", msg=f"录不到电脑内部声音：{m['msg']}。"
                                 "请到 系统设置 → 隐私与安全性 → 录屏与系统录音 里允许「终端」")

        asyncio.create_task(pump())
        asyncio.create_task(watch())

    def stop_syscap():
        nonlocal syscap
        if syscap and syscap.returncode is None:
            syscap.kill()
        syscap = None

    try:
        while True:
            msg = await ws.receive()
            if msg.get("bytes") is not None:
                await on_audio(msg["bytes"])
            elif msg.get("text"):
                cmd = msg["text"]
                if cmd.startswith("{"):  # 网页上切换了语言
                    cfg = json.loads(cmd)
                    if s.apple and (cfg.get("speaker") != s.apple.speaker or cfg.get("asr") != "apple"):
                        # 换了语言/识别方式：关掉旧的苹果识别（说到一半的那句会先确定下来）
                        asyncio.create_task(s.apple.close())
                        s.apple = None
                    if cfg.get("speaker") in SPEAKER_LANGS:
                        s.speaker = cfg["speaker"]
                    if cfg.get("target") in TARGET_LANGS:
                        s.target = cfg["target"]
                    if cfg.get("translator") in TRANSLATORS:
                        if cfg["translator"] != s.translator:
                            s.fallback_noted = False
                        s.translator = cfg["translator"]
                    if cfg.get("asr") in ASR_MODES:
                        s.asr = cfg["asr"]
                        s.cloud_fails, s.cloud_paused_until = 0, 0.0
                    if cfg.get("source") == "system" and syscap is None:
                        await start_syscap()
                    elif cfg.get("source") == "mic":
                        stop_syscap()
                elif cmd in ("pause", "resume"):
                    paused = cmd == "pause"  # 网页麦克风暂停时本来就不发音频，这里管的是电脑内部声音
                elif cmd == "summary":
                    asyncio.create_task(s.update_summary())
                elif cmd == "stop":
                    stop_syscap()
                    if s.apple:
                        await s.apple.close()
                        s.apple = None
                    for seg in s.flush():
                        await queue.put((seg, max(0.0, samples_seen / SR - len(seg) / SR)))
                    await queue.put(None)
                    await task
                    await asyncio.gather(*s.translations, return_exceptions=True)
                    await s.update_summary(final=True)
                    await s.send(type="done", record=s.record_path.name)
                    task = asyncio.create_task(asyncio.sleep(0))
            elif msg.get("type") == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    finally:
        task.cancel()
        stop_syscap()
        if s.apple:
            s.apple.kill()
        if s.lines:
            s.save()


if __name__ == "__main__":
    import uvicorn

    if not llm.available():
        print("⚠️  还没有填写 Gemini 或 Claude 的 API key，可以在网页右上角「设置」里填写（不填也能用苹果翻译）")
    print("打开浏览器访问 http://localhost:8765")
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")
