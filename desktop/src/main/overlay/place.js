export const MIN_W = 360;
export const MARGIN = 48; // 默认离屏幕底边的距离：避开 PPT 放映时底部的翻页栏

const inside = (p, a) => p.x >= a.x && p.x < a.x + a.width && p.y >= a.y && p.y < a.y + a.height;

/** 悬浮字幕放在哪：记住的位置还在某块屏幕上就用它（外接屏拔掉后会回到主屏），否则放在主屏底部正中。
 *  记的是底边位置：字号变大、字幕变高时往上长，不会跑出屏幕底部 */
export function place(saved, areas, height) {
  const ok = saved && Number.isFinite(saved.x) && Number.isFinite(saved.bottom) && Number.isFinite(saved.width)
    && areas.find((a) => inside({ x: saved.x + 40, y: saved.bottom - 10 }, a)); // 左边一截还在屏上就能拖回来
  if (ok) {
    const width = Math.min(Math.max(saved.width, MIN_W), ok.width);
    const x = Math.min(Math.max(saved.x, ok.x), ok.x + ok.width - width);
    const bottom = Math.min(saved.bottom, ok.y + ok.height);
    return { x: Math.round(x), y: Math.round(Math.max(ok.y, bottom - height)), width: Math.round(width), height };
  }
  const a = areas[0];
  const width = Math.min(960, a.width - 80);
  return { x: Math.round(a.x + (a.width - width) / 2), y: Math.round(a.y + a.height - MARGIN - height), width: Math.round(width), height };
}
