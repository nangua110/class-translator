import fs from "node:fs";
import path from "node:path";

const SR = 16000, BYTES_PER_SEC = SR * 2; // 16kHz、16 位、单声道
const HEADER = 44;
// 只认课堂同传自己起的录音文件名，自动清理时别的 wav 一概不碰
export const AUDIO_NAME_RE = /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.wav$/;

export function wavHeader(dataBytes) {
  const b = Buffer.alloc(HEADER);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(36 + dataBytes, 4); b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii"); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(BYTES_PER_SEC, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii"); b.writeUInt32LE(dataBytes, 40);
  return b;
}

/** 把一节课的原声边录边写成 WAV。第一段声音到了才建文件；每隔一段更新文件头，中途闪退也能播放 */
export class AudioRecorder {
  constructor(file, { flushBytes = BYTES_PER_SEC * 10 } = {}) {
    Object.assign(this, { file, flushBytes });
    this.fd = null;
    this.bytes = 0;
    this.flushed = 0;
  }
  write(buf) {
    if (this.fd === null) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.fd = fs.openSync(this.file, "w");
      fs.writeSync(this.fd, wavHeader(0), 0, HEADER, 0);
    }
    fs.writeSync(this.fd, buf, 0, buf.length, HEADER + this.bytes);
    this.bytes += buf.length;
    if (this.bytes - this.flushed >= this.flushBytes) this.#header();
  }
  #header() {
    fs.writeSync(this.fd, wavHeader(this.bytes), 0, HEADER, 0);
    this.flushed = this.bytes;
  }
  close() {
    if (this.fd === null) return;
    const fd = this.fd;
    try { this.#header(); } finally { this.fd = null; fs.closeSync(fd); }
  }
}

/** 从第 t 秒起取 dur 秒，包成一小段完整的 WAV 给窗口播放；按文件实际大小算，正在录的也能取 */
export function readAudioChunk(file, t, dur) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    const dataBytes = Math.max(0, fs.fstatSync(fd).size - HEADER);
    const from = Math.floor(Math.max(0, t) * SR) * 2;
    if (from >= dataBytes) return null;
    const len = Math.min(Math.floor(dur * SR) * 2, dataBytes - from);
    const wav = Buffer.alloc(HEADER + len);
    wavHeader(len).copy(wav);
    fs.readSync(fd, wav, HEADER, len, HEADER + from);
    return { wav, start: Math.max(0, t), total: dataBytes / BYTES_PER_SEC };
  } finally { fs.closeSync(fd); }
}

/** 删掉超过保留天数的课堂录音（按最后修改时间）；keepDays 为 0 表示一直保留。返回删了几个 */
export function cleanOldAudio(dir, keepDays, now = Date.now()) {
  if (!(keepDays > 0)) return 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!AUDIO_NAME_RE.test(name)) continue;
    const f = path.join(dir, name);
    try {
      if (now - fs.statSync(f).mtimeMs > keepDays * 86400_000) { fs.unlinkSync(f); n += 1; }
    } catch {} // 正在被别的程序占用等：下次再清
  }
  return n;
}
