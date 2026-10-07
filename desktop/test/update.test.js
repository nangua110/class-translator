import { test } from "node:test";
import assert from "node:assert/strict";
import { isNewer, latestVersion } from "../src/main/update.js";

test("版本比较：只有更新的才算新版", () => {
  assert.equal(isNewer("0.5.0", "0.4.1"), true);
  assert.equal(isNewer("0.4.10", "0.4.9"), true);
  assert.equal(isNewer("0.4.1", "0.4.1"), false);
  assert.equal(isNewer("0.4.0", "0.4.1"), false);
  assert.equal(isNewer("abc", "0.4.1"), false);
});

test("检查：有新版给出版本号；已是最新 / 连不上 / 不认识的地址都当作没有新版", async () => {
  const to = (tag) => async (url) => {
    assert.equal(url, "https://github.com/nangua110/class-translator/releases/latest");
    return `https://github.com/nangua110/class-translator/releases/tag/${tag}`;
  };
  assert.equal(await latestVersion({ current: "0.4.1", redirectOf: to("v0.5.0") }), "0.5.0");
  assert.equal(await latestVersion({ current: "0.5.0", redirectOf: to("v0.5.0") }), null);
  assert.equal(await latestVersion({ current: "0.5.0", redirectOf: to("v0.4.1") }), null);
  assert.equal(await latestVersion({ current: "0.4.1", redirectOf: to("../../evil") }), null);
  assert.equal(await latestVersion({ current: "0.4.1", redirectOf: async () => "https://example.com/releases/tag/v9.9.9" }), null);
  assert.equal(await latestVersion({ current: "0.4.1", redirectOf: async () => { throw new Error("net::ERR_INTERNET_DISCONNECTED"); } }), null);
});
