export const MIN_W = 360;
export const MARGIN = 48; // 默认离屏幕底边的距离：避开 PPT 放映时底部的翻页栏

const inside = (p, a) => p.x >= a.x && p.x < a.x + a.width && p.y >= a.y && p.y < a.y + a.height;

/** 悬浮字幕的窗口铺满一整块屏幕（透明），字幕条只是里面的一块。这里决定用哪块屏幕、字幕条在这块屏幕里的哪里。
 *  记住的位置还在某块屏幕上就用它（外接屏拔掉后会回到主屏），否则放在主屏底部正中。
 *  saved 是全屏坐标 {x, bottom, width, tall}；返回的 bar 是相对这块屏幕的坐标。记底边：字幕变高时往上长 */
export function place(saved, areas) {
  const ok = saved && Number.isFinite(saved.x) && Number.isFinite(saved.bottom) && Number.isFinite(saved.width)
    && areas.find((a) => inside({ x: saved.x + 40, y: saved.bottom - 10 }, a)); // 左边一截还在屏上就能拖回来
  if (ok) {
    const width = Math.min(Math.max(saved.width, MIN_W), ok.width);
    const x = Math.min(Math.max(saved.x, ok.x), ok.x + ok.width - width);
    const bottom = Math.min(saved.bottom, ok.y + ok.height);
    const tall = Number.isFinite(saved.tall) ? Math.round(saved.tall) : null;
    return { area: ok, bar: { x: Math.round(x - ok.x), bottom: Math.round(bottom - ok.y), width: Math.round(width), tall } };
  }
  const a = areas[0];
  const width = Math.min(960, a.width - 80);
  return { area: a, bar: { x: Math.round((a.width - width) / 2), bottom: a.height - MARGIN, width: Math.round(width), tall: null } };
}

/** 页面报回来的字幕条位置（相对屏幕）→ 全屏坐标，存起来下次用 */
export const toScreen = (area, bar) => ({ x: area.x + bar.x, bottom: area.y + bar.bottom, width: bar.width, tall: bar.tall ?? null });
