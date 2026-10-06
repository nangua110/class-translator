// 开始录制失败时给同学看的中文说明（浏览器原始报错是英文，比如 "Could not start audio source"）
window.startErrorText = (err, platform, source) => {
  const win = platform === "win32";
  const name = err?.name ?? "";
  if (source === "loopback") {
    return "录不到电脑内部声音，请重新点一次「开始录制」；还不行的话，先改用麦克风录制";
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return win
      ? "没有麦克风权限：请到 设置 → 隐私和安全性 → 麦克风，打开「麦克风访问权限」和「允许桌面应用访问麦克风」，然后重新打开课堂同传"
      : "没有麦克风权限：请到 系统设置 → 隐私与安全 → 麦克风，允许「课堂同传」，然后重新打开课堂同传";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "麦克风打不开，可能正被别的程序占用（比如会议软件），关掉它们后再试";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "没有找到麦克风：请插上麦克风，或在「麦克风」里改选别的设备";
  }
  return "开始录制失败，请再试一次；还不行的话重新打开课堂同传";
};
