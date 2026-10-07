import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { LocalASR } from "../src/main/local/asr.js";

class FakeWorker extends EventEmitter {
  constructor() { super(); this.posted = []; this.terminated = false; }
  postMessage(m) { this.posted.push(m); if (m.type === "finish" && this.autoDone !== false) setImmediate(() => this.emit("message", { type: "done" })); }
  async terminate() { this.terminated = true; this.emit("exit", 1); }
}
function setup() {
  const worker = new FakeWorker(), msgs = [], exits = [];
  const asr = new LocalASR({ workerPath: "w", modelDir: "m", speaker: "en", offset: 7, makeWorker: () => worker });
  asr.on("message", (m) => msgs.push(m));
  asr.on("exit", (c) => exits.push(c));
  asr.start();
  return { asr, worker, msgs, exits };
}
const errors = (msgs) => msgs.filter((m) => m.type === "error").map((m) => m.msg);

test("线程的草稿和定稿转成统一的消息；定稿标明来源 local", () => {
  const { worker, msgs } = setup();
  worker.emit("message", { type: "ready" });
  worker.emit("message", { type: "partial", text: "Good", conf: 0.7 });
  worker.emit("message", { type: "final", text: "Good morning.", conf: 0.8, start: 1.2 });
  assert.deepEqual(msgs, [{ type: "partial", text: "Good", conf: 0.7 }, { type: "final", source: "local", text: "Good morning.", conf: 0.8, start: 1.2 }]);
});

test("音频按完整样本送进线程：半个样本留到下一次", () => {
  const { asr, worker } = setup();
  asr.feed(Buffer.from([1, 2, 3]));
  asr.feed(Buffer.from([4, 5]));
  const sizes = worker.posted.filter((m) => m.type === "audio").map((m) => m.pcm.length);
  assert.deepEqual(sizes, [2, 2]);
  assert.deepEqual([...worker.posted[1].pcm], [3, 4]);
});

test("close：通知线程收尾，等它说 done，exit 0，只发一次", async () => {
  const { asr, worker, exits } = setup();
  await asr.close();
  assert.equal(worker.posted.at(-1).type, "finish");
  assert.equal(worker.terminated, true);
  assert.deepEqual(exits, [0]);
});

test("close 不会一直等：线程不回应时超时强制结束", async () => {
  const { asr, worker, exits } = setup();
  worker.autoDone = false;
  worker.emit("message", { type: "ready" });
  await asr.close(30);
  assert.equal(worker.terminated, true);
  assert.deepEqual(exits, [0]);
});

test("慢电脑：模型还在加载时结束录制，要等它加载完把积压的话识别出来，不能丢", async () => {
  const { asr, worker, msgs } = setup();
  worker.autoDone = false;
  asr.feed(Buffer.alloc(32000 * 8));
  const closing = asr.close(100, 2000); // 平时最多等 100ms 没动静；模型没加载好时最多等 2 秒
  setTimeout(() => worker.emit("message", { type: "ready" }), 150);
  setTimeout(() => worker.emit("message", { type: "tick", processed: 4 }), 160);
  setTimeout(() => worker.emit("message", { type: "tick", processed: 8 }), 170);
  setTimeout(() => { worker.emit("message", { type: "final", text: "Late but kept.", conf: 0.8, start: 1 }); worker.emit("message", { type: "done" }); }, 180);
  await closing;
  assert.deepEqual(msgs.filter((m) => m.type === "final").map((m) => m.text), ["Late but kept."]);
});

test("模型一直加载不出来：到时间也会结束，不会卡死", async () => {
  const { asr, worker, exits } = setup();
  worker.autoDone = false;
  await asr.close(20, 60);
  assert.equal(worker.terminated, true);
  assert.deepEqual(exits, [0]);
});

test("模型加载超过 3 秒：提示一次正在加载", async () => {
  const worker = new FakeWorker(), msgs = [];
  const asr = new LocalASR({ workerPath: "w", modelDir: "m", speaker: "en", offset: 0, makeWorker: () => worker, loadNoticeMs: 20 });
  asr.on("message", (m) => msgs.push(m));
  asr.start();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(errors(msgs).length, 1);
  assert.match(errors(msgs)[0], /正在加载/);
  asr.kill();
  const fast = new FakeWorker(), msgs2 = [];
  const asr2 = new LocalASR({ workerPath: "w", modelDir: "m", speaker: "en", offset: 0, makeWorker: () => fast, loadNoticeMs: 20 });
  asr2.on("message", (m) => msgs2.push(m));
  asr2.start();
  fast.emit("message", { type: "ready" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(errors(msgs2).length, 0, "加载得快就不提示");
  asr2.kill();
});

test("kill：exit -1；线程自己出错或意外退出：提示并 exit 1", () => {
  const a = setup();
  a.asr.kill();
  assert.deepEqual(a.exits, [-1]);
  const b = setup();
  b.worker.emit("error", new Error("模型文件打不开"));
  assert.deepEqual(b.exits, [1]);
  assert.match(errors(b.msgs)[0], /本地实时识别出错/);
  const c = setup();
  c.worker.emit("message", { type: "error", msg: "找不到 encoder.onnx" });
  assert.match(errors(c.msgs)[0], /找不到 encoder\.onnx/);
});

test("电脑太慢跟不上：积压超过 15 秒而且还在变多，提示一次", () => {
  const { asr, worker, msgs } = setup();
  worker.emit("message", { type: "ready" });
  asr.feed(Buffer.alloc(32000 * 20)); // 送了 20 秒
  worker.emit("message", { type: "tick", processed: 2 });  // 落后 18 秒
  asr.feed(Buffer.alloc(32000 * 10));
  worker.emit("message", { type: "tick", processed: 8 });  // 落后 22 秒，越来越多
  asr.feed(Buffer.alloc(32000 * 10));
  worker.emit("message", { type: "tick", processed: 14 }); // 落后 26 秒
  assert.equal(errors(msgs).length, 1);
  assert.match(errors(msgs)[0], /跟不上/);
});

test("模型加载慢造成的积压正在追上：不提示跟不上", () => {
  const { asr, worker, msgs } = setup();
  asr.feed(Buffer.alloc(32000 * 20)); // 加载模型的 20 秒里一直在送音频
  worker.emit("message", { type: "ready" });
  for (const p of [1, 6, 12, 18, 20]) worker.emit("message", { type: "tick", processed: p });
  assert.deepEqual(errors(msgs), []);
});

test("收尾时线程意外退出：close 马上返回，不用等满超时", async () => {
  const { asr, worker } = setup();
  worker.autoDone = false;
  worker.emit("message", { type: "ready" });
  const t0 = Date.now();
  const closing = asr.close(5000);
  setTimeout(() => worker.emit("exit", 1), 20);
  await closing;
  assert.ok(Date.now() - t0 < 1000, `等了 ${Date.now() - t0}ms`);
});

test("电脑一直跟不上：收尾有总时间上限，不会让「结束」等几十分钟", async () => {
  const { asr, worker, exits } = setup();
  worker.autoDone = false;
  worker.emit("message", { type: "ready" });
  const beat = setInterval(() => worker.emit("message", { type: "tick", processed: 1 }), 10); // 线程一直有动静
  const t0 = Date.now();
  await asr.close(5000, 5000, 80);
  clearInterval(beat);
  assert.ok(Date.now() - t0 < 1000, `等了 ${Date.now() - t0}ms`);
  assert.deepEqual(exits, [0]);
});

test("一直落后 15 秒以上、没有在追上：也要提示", () => {
  const { asr, worker, msgs } = setup();
  worker.emit("message", { type: "ready" });
  asr.feed(Buffer.alloc(32000 * 18));
  for (const p of [2, 8, 14]) { worker.emit("message", { type: "tick", processed: p }); asr.feed(Buffer.alloc(32000 * 6)); } // 落后量稳定在 16 秒
  assert.equal(errors(msgs).length, 1);
});
