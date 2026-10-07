// 新版发布在 GitHub Releases；检查更新只看「最新版」页面跳到哪个版本号，不带任何个人信息
export const RELEASES = "https://github.com/nangua110/class-translator/releases";

const parts = (v) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
export function isNewer(latest, current) {
  const a = parts(latest), b = parts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** 查有没有新版：有就返回版本号，没有 / 连不上都返回 null（下次打开再查）。redirectOf(地址) 返回这个地址会跳到哪里 */
export async function latestVersion({ current, redirectOf, base = RELEASES }) {
  try {
    // 「最新版」页面会跳到 …/releases/tag/v1.2.3
    const url = String(await redirectOf(`${base}/latest`) ?? ""), prefix = `${base}/tag/v`;
    const v = url.startsWith(prefix) ? url.slice(prefix.length) : "";
    return isNewer(v, current) ? v : null;
  } catch { return null; }
}
