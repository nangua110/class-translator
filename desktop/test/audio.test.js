import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AudioRecorder, readAudioChunk, cleanOldAudio } from "../src/main/store/audio.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ct-audio-"));
const SEC = 32000; // 16kHz 16 位单声道，每秒字节数
// 每一秒的样本值都等于秒数，方便检查取出来的是哪一段
function seconds(from, n) {
  const b = Buffer.alloc(n * SEC);
  for (let s = 0; s < n; s++) for (let i = 0; i < SEC; i += 2) b.writeInt16LE(from + s, s * SEC + i);
  return b;
}
const header = (f) => { const b = fs.readFileSync(f); return { riff: b.toString("ascii", 0, 4), size: b.readUInt32LE(4), rate: b.readUInt32LE(24), data: b.readUInt32LE(40), len: b.length }; };

test("录音存成标准 WAV：结束后文件头里的长度正确", () => {
  const f = path.join(tmp(), "2026-10-07_09-00-00.wav");
  const r = new AudioRecorder(f);
  r.write(seconds(0, 2)); r.write(seconds(2, 1));
  r.close();
  assert.deepEqual(header(f), { riff: "RIFF", size: 36 + 3 * SEC, rate: 16000, data: 3 * SEC, len: 44 + 3 * SEC });
});

test("没有声音就不产生文件；关两次不出错", () => {
  const f = path.join(tmp(), "2026-10-07_09-00-00.wav");
  const r = new AudioRecorder(f);
  r.close(); r.close();
  assert.equal(fs.existsSync(f), false);
});

test("中途闪退也能播放：每隔一段就把文件头更新一次", () => {
  const f = path.join(tmp(), "2026-10-07_09-00-00.wav");
  const r = new AudioRecorder(f, { flushBytes: 2 * SEC });
  r.write(seconds(0, 1)); r.write(seconds(1, 1)); r.write(seconds(2, 1));
  assert.ok(header(f).data >= 2 * SEC, "没有 close 时文件头也应该已经写上长度"); // 故意不 close
  r.close();
});

test("按时间取一段：从那一秒开始，带文件头；能取正在录的文件；超出结尾返回 null", () => {
  const f = path.join(tmp(), "2026-10-07_09-00-00.wav");
  const r = new AudioRecorder(f);
  r.write(seconds(0, 10));
  const c = readAudioChunk(f, 4.2, 3); // 还没 close，文件头长度还是 0，也要能按实际大小取
  assert.equal(c.start, 4.2);
  assert.equal(c.total, 10);
  assert.equal(c.wav.length, 44 + 3 * SEC);
  assert.equal(c.wav.readUInt32LE(40), 3 * SEC);
  assert.equal(c.wav.readInt16LE(44 + SEC), 5, "第二秒的内容应该是原文件第 5 秒");
  assert.equal(readAudioChunk(f, 8, 5).wav.length, 44 + 2 * SEC, "快到结尾时只给剩下的");
  assert.equal(readAudioChunk(f, 10, 5), null);
  assert.equal(readAudioChunk(path.join(tmp(), "none.wav"), 0, 5), null);
  r.close();
});

test("自动清理：只删超过保留天数的课堂录音，别的文件一概不动", () => {
  const dir = tmp(), now = Date.parse("2026-10-20T12:00:00");
  const put = (name, daysAgo) => { const f = path.join(dir, name); fs.writeFileSync(f, "x"); const t = new Date(now - daysAgo * 86400_000); fs.utimesSync(f, t, t); };
  put("2026-10-10_09-00-00.wav", 10);   // 该删
  put("2026-10-15_09-00-00.wav", 5);    // 还没到期
  put("2026-10-10_09-00-00.md", 10);    // 课堂记录不删
  put("my-song.wav", 100);              // 不是课堂同传的录音，不删
  put("2026-10-01_09-00-00_备份.wav", 19);
  assert.equal(cleanOldAudio(dir, 7, now), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["2026-10-01_09-00-00_备份.wav", "2026-10-10_09-00-00.md", "2026-10-15_09-00-00.wav", "my-song.wav"]);
  assert.equal(cleanOldAudio(dir, 0, now), 0, "0 表示一直保留");
  assert.equal(cleanOldAudio(path.join(dir, "不存在"), 7, now), 0);
});
