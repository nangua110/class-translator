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
  worker.emit("message", { type: "partial", text: "Good" });
  worker.emit("message", { type: "final", text: "Good morning.", conf: 0.8, start: 1.2 });
  assert.deepEqual(msgs, [{ type: "partial", text: "Good" }, { type: "final", source: "local", text: "Good morning.", conf: 0.8, start: 1.2 }]);
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
  await asr.close(30);
  assert.equal(worker.terminated, true);
  assert.deepEqual(exits, [0]);
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

test("电脑太慢跟不上：积压超过 15 秒提示一次", () => {
  const { asr, worker, msgs } = setup();
  asr.feed(Buffer.alloc(32000 * 20)); // 送了 20 秒
  worker.emit("message", { type: "tick", processed: 2 });
  worker.emit("message", { type: "tick", processed: 3 });
  assert.equal(errors(msgs).length, 1);
  assert.match(errors(msgs)[0], /跟不上/);
});
