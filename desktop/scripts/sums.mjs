// 给这一版的四个安装包生成 SHA256SUMS.txt，发布时一起上传；App 更新时用它核对下载的安装包
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const dist = path.join(import.meta.dirname, "../dist");
const { version } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8"));
const names = [`ClassTranslator-${version}-arm64.dmg`, `ClassTranslator-${version}-x64.dmg`,
  `ClassTranslator-${version}-win-x64-setup.exe`, `ClassTranslator-${version}-win-arm64-setup.exe`];
const lines = names.map((n) => {
  const f = path.join(dist, n);
  if (!fs.existsSync(f)) { console.error(`缺少安装包：${n}`); process.exit(1); }
  return `${crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")}  ${n}`;
});
fs.writeFileSync(path.join(dist, "SHA256SUMS.txt"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
