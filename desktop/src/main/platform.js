/** 这台电脑能用哪些功能（第 1 期只有苹果系能力；Windows / 云端识别在第 2 期） */
export function capabilities({ platform, version, has, bins }) {
  const [maj = 0, min = 0] = String(version).split(".").map(Number);
  const atLeast = (a, b) => maj > a || (maj === a && min >= b);
  const mac = platform === "darwin";
  return {
    platform, version,
    appleAsr: mac && atLeast(26, 0) && has(bins.asr),
    appleTranslate: mac && atLeast(26, 0) && has(bins.translate),
    systemAudio: mac && atLeast(14, 2) && has(bins.syscap),
  };
}
