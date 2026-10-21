// 麦克风：记住用户选的那个、录音中发现没声音就重新接上

/** 列表刷新后该选哪个麦克风：用户选过的优先（按 id，id 变了按名字找），
 *  没选过就优先电脑自带的麦克风——「Default」会跟着系统走，连上耳机就被切到耳机上 */
window.pickMic = (devs, want) => {
  const real = devs.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications");
  if (want?.id && devs.some((d) => d.deviceId === want.id)) return want.id;
  const byLabel = want?.label && real.find((d) => d.label === want.label);
  if (byLabel) return byLabel.deviceId;
  if (want?.id) return devs[0]?.deviceId ?? ""; // 选过的麦克风拔掉了：先用系统默认的顶上
  const builtIn = real.find((d) => /built-in|内建|内置/i.test(d.label));
  return (builtIn ?? devs[0])?.deviceId ?? "";
};

/** 录音中盯着麦克风：连续一段时间收到的全是 0（真实的麦克风哪怕没人说话也有底噪），
 *  或者干脆收不到声音，就说明麦克风被系统切走或断了 */
window.MicWatch = class {
  constructor({ zeroMs = 2500, stallMs = 2500 } = {}) {
    Object.assign(this, { zeroMs, stallMs });
    this.reset(0);
  }
  reset(now) { this.zeroSince = null; this.lastFeed = now; }
  feed(samples, now) {
    this.lastFeed = now;
    if (samples.some((v) => v !== 0)) this.zeroSince = null;
    else this.zeroSince ??= now;
  }
  /** 有问题返回 "silent" / "stalled"，正常返回 null */
  check(now) {
    if (now - this.lastFeed >= this.stallMs) return "stalled";
    if (this.zeroSince !== null && now - this.zeroSince >= this.zeroMs) return "silent";
    return null;
  }
};
