import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Records, reportMarkdown, isValidName, newRecordName } from "../src/main/store/records.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ct-rec-"));
const NAME = "2026-10-07_09-00-00.md";

test("保存后能读回转写和列表", () => {
  const r = new Records(tmp());
  r.save(NAME, "笔记", [{ t: 0, text: "Hello", tr: "你好" }, { t: 65, text: "World", tr: "" }, { t: 3909, text: "Bye", tr: "再见" }]);
  assert.deepEqual(r.transcript(NAME), [["00:00:00", "Hello"], ["00:01:05", "World"], ["01:05:09", "Bye"]]);
  assert.deepEqual(r.list(), [{ name: NAME, stem: "2026-10-07_09-00-00", lines: 3, minutes: 65, hasReport: false, title: "", hasAudio: false }]);
});

test("课后精讲：写入后列表显示标题，能读回", () => {
  const r = new Records(tmp());
  r.save(NAME, "", [{ t: 0, text: "a", tr: "" }]);
  assert.equal(r.writeReport(NAME, "# 热力学\n\n正文\n"), "2026-10-07_09-00-00_课后精讲.md");
  assert.deepEqual(r.readReport(NAME), { md: "# 热力学\n\n正文\n", title: "热力学" });
  assert.equal(r.list()[0].title, "热力学");
  assert.equal(r.list().length, 1, "精讲文件本身不能出现在列表里");
});

test("不合法的记录名一律拒绝，读不到别的文件", () => {
  const r = new Records(tmp());
  assert.equal(isValidName("../../.env"), false);
  assert.equal(isValidName("a/b.md"), false);
  assert.equal(isValidName("x_课后精讲.md"), false);
  assert.equal(isValidName(NAME), true);
  assert.throws(() => r.transcript("../x.md"));
  assert.equal(r.readReport("../../.env"), null);
  assert.equal(r.exists("../../.env"), false);
});

test("reportMarkdown：标题、上课时间、按小时的时长、章节", () => {
  const md = reportMarkdown(
    { title: "热力学", overview: "概述", chapters: [{ start: "00:00:00", end: "00:02:56", title: "引入", desc: "开场" }] },
    "## AI 精讲\n正文", "2026-10-06_23-42-48", "01:05:09");
  assert.match(md, /^# 热力学\n/);
  assert.match(md, /> 上课 2026-10-06 23:42 · 时长 1h 5m 9s/);
  assert.match(md, /- \*\*\[00:00:00 – 00:02:56\] 引入\*\*  \n  开场/);
  assert.match(md, /## AI 精讲\n正文\n$/);
});

test("两个半小时的长课（3000 句）能正常列出", () => {
  const r = new Records(tmp());
  r.save(NAME, "", Array.from({ length: 3000 }, (_, i) => ({ t: i * 3, text: `line ${i}`, tr: "" })));
  const [item] = r.list();
  assert.equal(item.lines, 3000);
  assert.equal(item.minutes, 149); // 最后一句 02:29:57
});

test("newRecordName 格式", () => {
  assert.equal(newRecordName(new Date(2026, 9, 7, 9, 5, 3)), "2026-10-07_09-05-03.md");
});
