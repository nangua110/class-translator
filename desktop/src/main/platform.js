/** 这台电脑能用哪些功能：苹果识别 / 翻译只在新 Mac；本地实时和云端识别都能用；Windows 用系统回环录电脑声音 */
export function capabilities({ platform, version, has, bins, localModel }) {
  const [maj = 0, min = 0] = String(version).split(".").map(Number);
  const atLeast = (a, b) => maj > a || (maj === a && min >= b);
  const mac = platform === "darwin", win = platform === "win32";
  return {
    platform, version,
    appleAsr: mac && atLeast(26, 0) && has(bins.asr),
    appleTranslate: mac && atLeast(26, 0) && has(bins.translate),
    systemAudio: (mac && atLeast(14, 2) && has(bins.syscap)) || win,
    cloudAsr: true,
    localAsr: !!localModel && has(localModel),
    loopback: win,
  };
}
