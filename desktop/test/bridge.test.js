import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const code = fs.readFileSync(new URL("../src/renderer/bridge.js", import.meta.url), "utf8");
function fakeApi() {
  const handlers = [];
  let n = 0;
  return {
    handlers,
    onMessage: (cb) => { handlers.push(cb); return () => handlers.splice(handlers.indexOf(cb), 1); },
    openSession: async () => ({ record: `r${++n}.md` }),
    sendCmd() {}, sendAudio() {}, closeSession() {},
    emit: (m) => [...handlers].forEach((h) => h(m)),
  };
}
const load = (api) => { const window = { api }; vm.runInNewContext(code, { window, JSON }); return window; };

test("刚结束就开新课：上一节课迟到的消息（包括 done）不会送到新课", async () => {
  const api = fakeApi();
  const w = load(api);
  const s1 = await w.openSessionSocket();
  const s2 = await w.openSessionSocket();
  const got = [];
  s1.onmessage = (e) => got.push(["s1", JSON.parse(e.data).type]);
  s2.onmessage = (e) => got.push(["s2", JSON.parse(e.data).type]);
  api.emit({ type: "done", record: "r1.md", sid: "r1.md" });
  api.emit({ type: "line", sid: "r2.md" });
  assert.deepEqual(got, [["s2", "line"]]);
  assert.equal(api.handlers.length, 1, "上一节课的监听要移除，否则每条消息处理两次");
});
