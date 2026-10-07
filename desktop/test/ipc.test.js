import { test } from "node:test";
import assert from "node:assert/strict";
import { registerIpc } from "../src/main/ipc.js";

function setup(makeSession) {
  const handles = {}, ons = {}, sent = [];
  const ipcMain = { handle: (ch, fn) => { handles[ch] = fn; }, on: (ch, fn) => { ons[ch] = fn; } };
  const wc = { id: 1, isDestroyed: () => false, send: (_ch, m) => sent.push(m), once() {} };
  registerIpc({ ipcMain, api: async () => ({}), makeSession, makeSystemAudio: () => ({ on() {}, start() {}, stop() {} }) });
  const e = { sender: wc };
  return { open: () => handles["session:open"](e), cmd: (c) => ons["session:cmd"](e, c), sent };
}

test("每条消息都带上所属课的标识，窗口能分清是哪节课的", async () => {
  const { open, sent } = setup((send) => ({ name: "a.md", configure() {}, dispose() {}, send, start() { send({ type: "line" }); } }));
  const r = await open();
  assert.deepEqual(r, { record: "a.md", audio: false });
});

test("消息带 sid；结束时出错也一定发 done，窗口不会卡在收尾", async () => {
  let n = 0;
  const { open, cmd, sent } = setup((send) => {
    const name = `s${++n}.md`;
    return { name, configure() {}, dispose() {}, stop: async () => { send({ type: "line" }); throw new Error("磁盘满"); } };
  });
  await open();
  await cmd("stop");
  assert.deepEqual(sent.map((m) => [m.type, m.sid]), [["line", "s1.md"], ["error", "s1.md"], ["done", "s1.md"]]);
});

test("上一节课还在收尾（生成最终笔记）时可以马上开新课：收尾不被打断，照样存盘", async () => {
  let n = 0, finish;
  const disposed = [], stopped = [];
  const { open, cmd } = setup((send) => {
    const name = `s${++n}.md`;
    return { name, configure() {}, dispose() { disposed.push(name); }, stop: () => new Promise((r) => { finish = () => { stopped.push(name); send({ type: "done", record: name }); r(); }; }) };
  });
  await open();
  const stopping = cmd("stop");          // 第一节课开始收尾，还没完
  const r = await open();                // 马上开第二节课
  assert.equal(r.record, "s2.md");
  assert.deepEqual(disposed, [], "收尾中的课不能被强行关掉");
  finish();
  await stopping;
  assert.deepEqual(stopped, ["s1.md"]);
});
