import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Updater, assetName, isNewer, parseSums } from "../src/main/update.js";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const FILE = Buffer.from("假装是安装包".repeat(1000));
const NAME = "ClassTranslator-0.5.0-arm64.dmg";

/** 假的 GitHub：latest 跳转到 tag 页、校验文件、安装包 */
function fakeFetch({ tag = "v0.5.0", sums = `${sha(FILE)}  ${NAME}\n`, file = FILE, fail = false } = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (fail) throw new Error("fetch failed");
    if (url.endsWith("/SHA256SUMS.txt")) return sums === null ? { ok: false, status: 404 } : { ok: true, status: 200, text: async () => sums };
    if (url.endsWith(NAME)) return new Response(file, { headers: { "content-length": String(file.length) } });
    return { ok: false, status: 404 };
  };
  const redirectOf = async (url) => {
    assert.equal(url, "https://github.com/nangua110/class-translator/releases/latest");
    if (fail) throw new Error("net::ERR_INTERNET_DISCONNECTED");
    return `https://github.com/nangua110/class-translator/releases/tag/${tag}`;
  };
  return { fetch, calls, redirectOf };
}
function setup(opts = {}, { version = "0.4.1", platform = "darwin", arch = "arm64" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-upd-"));
  const { fetch, calls, redirectOf } = fakeFetch(opts);
  const installed = [];
  const u = new Updater({ version, platform, arch, dir, fetch, redirectOf, install: (f) => installed.push(f) });
  return { u, dir, calls, installed };
}

test("版本比较：只有更新的才算新版", () => {
  assert.equal(isNewer("0.5.0", "0.4.1"), true);
  assert.equal(isNewer("0.4.10", "0.4.9"), true);
  assert.equal(isNewer("0.4.1", "0.4.1"), false);
  assert.equal(isNewer("0.4.0", "0.4.1"), false);
  assert.equal(isNewer("abc", "0.4.1"), false);
});

test("按电脑挑安装包；校验文件解析", () => {
  assert.equal(assetName("0.5.0", "darwin", "arm64"), "ClassTranslator-0.5.0-arm64.dmg");
  assert.equal(assetName("0.5.0", "darwin", "x64"), "ClassTranslator-0.5.0-x64.dmg");
  assert.equal(assetName("0.5.0", "win32", "x64"), "ClassTranslator-0.5.0-win-x64-setup.exe");
  assert.equal(assetName("0.5.0", "win32", "arm64"), "ClassTranslator-0.5.0-win-arm64-setup.exe");
  assert.equal(assetName("0.5.0", "linux", "x64"), null);
  assert.deepEqual(parseSums(`${"a".repeat(64)}  x.dmg\n${"B".repeat(64)} *y.exe\n乱七八糟\n`), { "x.dmg": "a".repeat(64), "y.exe": "b".repeat(64) });
});

test("检查：有新版给出版本号；已是最新 / 连不上 / 不认识的地址都当作没有新版", async () => {
  const a = setup();
  assert.deepEqual(await a.u.check(), { current: "0.4.1", latest: "0.5.0", state: "available", percent: 0, msg: "" });
  assert.equal((await setup({ tag: "v0.4.1" }).u.check()).state, "none");
  assert.equal((await setup({ fail: true }).u.check()).state, "none");
  assert.equal((await setup({ tag: "../../evil" }).u.check()).state, "none");
});

test("下载：校验通过才交给安装；进度到 100", async () => {
  const { u, dir, installed } = setup();
  await u.check();
  await u.downloadAndInstall();
  assert.deepEqual(installed, [path.join(dir, NAME)]);
  assert.deepEqual(fs.readFileSync(installed[0]), FILE);
  assert.deepEqual(u.status(), { current: "0.4.1", latest: "0.5.0", state: "ready", percent: 100, msg: "" });
});

test("下载：校验不对 / 没有校验文件 → 不安装、删掉文件、可以重试", async () => {
  for (const opts of [{ file: Buffer.from("被换掉的文件") }, { sums: null }, { sums: `${"0".repeat(64)}  别的.dmg\n` }]) {
    const { u, dir, installed } = setup(opts);
    await u.check();
    await u.downloadAndInstall();
    assert.deepEqual(installed, []);
    assert.equal(u.status().state, "error");
    assert.match(u.status().msg, /校验|下载/);
    assert.deepEqual(fs.readdirSync(dir), []);
  }
});

test("没检查到新版时不下载；同时点两次只下载一次", async () => {
  const none = setup({ tag: "v0.4.1" });
  await none.u.check();
  await none.u.downloadAndInstall();
  assert.deepEqual(none.installed, []);
  const { u, installed, calls } = setup();
  await u.check();
  await Promise.all([u.downloadAndInstall(), u.downloadAndInstall()]);
  assert.equal(installed.length, 1);
  assert.equal(calls.filter((c) => c.endsWith(NAME)).length, 1);
});
