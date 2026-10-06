import { test } from "node:test";
import assert from "node:assert/strict";
import { Segmenter } from "../src/main/cloud/segmenter.js";
import { toWav } from "../src/main/cloud/wav.js";

const SR = 16000;
const tone = (sec) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR));
const quiet = (sec) => new Float32Array(Math.round(sec * SR));
function pcm(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = Buffer.alloc(total * 2);
  let o = 0;
  for (const p of parts) for (const v of p) { buf.writeInt16LE(Math.round(v * 32767), o); o += 2; }
  return buf;
}
const near = (a, b, tol = 0.1) => assert.ok(Math.abs(a - b) <= tol, `${a} 应接近 ${b}`);

test("两句话中间停顿 1 秒：切成两段，开始时间正确", () => {
  const s = new Segmenter();
  const segs = s.feed(pcm(tone(1), quiet(1), tone(2), quiet(1)));
  assert.equal(segs.length, 2);
  near(segs[0].start, 0);
  near(segs[1].start, 2);
  near(segs[1].audio.length / SR, 2.5, 0.15); // 2 秒话 + 0.5 秒判定静音
});

test("连续讲 20 秒不停：每段最长 8 秒，内容不丢", () => {
  const s = new Segmenter();
  const segs = [...s.feed(pcm(tone(20))), ...s.flush()];
  assert.ok(segs.every((g) => g.audio.length / SR <= 8.01));
  near(segs.reduce((n, g) => n + g.audio.length, 0) / SR, 20, 0.1);
});

test("很短的声音（0.05 秒，比如敲一下）丢掉：连同句尾静音也不到 0.6 秒", () => {
  assert.deepEqual(new Segmenter().feed(pcm(tone(0.05), quiet(1))), []);
});

test("结束时把没说完的半句交出来", () => {
  const s = new Segmenter();
  assert.deepEqual(s.feed(pcm(tone(1.5))), []);
  const [last] = s.flush();
  near(last.audio.length / SR, 1.5, 0.05);
  assert.deepEqual(s.flush(), []);
});

test("数据在半个样本处断开也能正确拼接", () => {
  const whole = pcm(tone(1), quiet(1));
  const a = new Segmenter().feed(whole);
  const s = new Segmenter();
  const b = [...s.feed(whole.subarray(0, 12345)), ...s.feed(whole.subarray(12345))];
  assert.equal(b.length, a.length);
  assert.equal(b[0].audio.length, a[0].audio.length);
});

test("toWav：44 字节文件头 + 16 位数据", () => {
  const wav = toWav(Float32Array.from([0, 0.5, -1]));
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.length, 44 + 6);
  assert.deepEqual([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)], [0, 16384, -32767]);
});
