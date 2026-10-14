import { test } from "node:test";
import assert from "node:assert/strict";
import { place, toScreen } from "../src/main/overlay/place.js";

const main = { x: 0, y: 25, width: 1440, height: 875 };
const ext = { x: 1440, y: 0, width: 1920, height: 1080 };

test("第一次打开：主屏底部正中", () => {
  assert.deepEqual(place(null, [main]), { area: main, bar: { x: 240, bottom: 827, width: 960, tall: null } });
  assert.equal(place(null, [{ x: 0, y: 0, width: 800, height: 600 }]).bar.width, 720, "小屏幕两边留空");
});

test("记住的位置：换成相对这块屏幕的坐标，存回去还是原样", () => {
  const s = { x: 100, bottom: 800, width: 700, tall: 300 };
  const p = place(s, [main]);
  assert.deepEqual(p.bar, { x: 100, bottom: 775, width: 700, tall: 300 });
  assert.deepEqual(toScreen(p.area, p.bar), s);
});

test("外接屏上的位置：屏还在就用，拔掉后回到主屏", () => {
  const s = { x: 1600, bottom: 1000, width: 1200 };
  assert.deepEqual(place(s, [main, ext]).area, ext);
  assert.equal(place(s, [main, ext]).bar.x, 160);
  assert.deepEqual(place(s, [main]).area, main);
});

test("太宽、太窄、伸出屏幕边缘时收回来", () => {
  assert.equal(place({ x: 0, bottom: 800, width: 5000 }, [main]).bar.width, 1440);
  assert.equal(place({ x: 0, bottom: 800, width: 100 }, [main]).bar.width, 360);
  assert.equal(place({ x: 1300, bottom: 800, width: 700 }, [main]).bar.x, 740);
  assert.equal(place({ x: 10, bottom: "x", width: 700 }, [main]).bar.x, 240, "存坏了就用默认位置");
});
