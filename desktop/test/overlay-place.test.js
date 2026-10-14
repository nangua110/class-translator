import { test } from "node:test";
import assert from "node:assert/strict";
import { place } from "../src/main/overlay/place.js";

const main = { x: 0, y: 25, width: 1440, height: 875 };
const ext = { x: 1440, y: 0, width: 1920, height: 1080 };

test("第一次打开：主屏底部正中", () => {
  assert.deepEqual(place(null, [main], 100), { x: 240, y: 752, width: 960, height: 100 });
  assert.equal(place(null, [{ x: 0, y: 0, width: 800, height: 600 }], 100).width, 720, "小屏幕两边留空");
});

test("记住的位置：底边不动，变高时往上长", () => {
  const s = { x: 100, bottom: 800, width: 700 };
  assert.deepEqual(place(s, [main], 100), { x: 100, y: 700, width: 700, height: 100 });
  assert.deepEqual(place(s, [main], 160), { x: 100, y: 640, width: 700, height: 160 });
});

test("外接屏上的位置：屏还在就用，拔掉后回到主屏", () => {
  const s = { x: 1600, bottom: 1000, width: 1200 };
  assert.equal(place(s, [main, ext], 100).x, 1600);
  assert.equal(place(s, [main], 100).x, 240);
});

test("太宽、太窄、伸出屏幕边缘时收回来", () => {
  assert.equal(place({ x: 0, bottom: 800, width: 5000 }, [main], 100).width, 1440);
  assert.equal(place({ x: 0, bottom: 800, width: 100 }, [main], 100).width, 360);
  assert.equal(place({ x: 1300, bottom: 800, width: 700 }, [main], 100).x, 740);
  assert.equal(place({ x: 10, bottom: "x", width: 700 }, [main], 100).x, 240, "存坏了就用默认位置");
});
