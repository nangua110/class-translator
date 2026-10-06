// 没有开发者证书时做 ad-hoc 签名，否则苹果芯片 Mac 上无法运行（不是绕过检查：首次打开仍会有系统提示）
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== "darwin") return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
};
