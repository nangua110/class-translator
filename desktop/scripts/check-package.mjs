// 打包后检查：安装包里不能有 .env、课堂记录、虚拟环境、设置文件或任何 key
import fs from "node:fs";
import path from "node:path";
import * as asar from "@electron/asar";

const dist = path.join(import.meta.dirname, "../dist");
const BAD_PATH = /(^|\/)(\.env|records\/|\.venv\/|settings\.json$)/;
const KEY_RE = /AIza[0-9A-Za-z_-]{30,}|sk-ant-[0-9A-Za-z_-]{20,}/;
const problems = [];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walk(f);
    else checkFile(f, fs.readFileSync(f));
  }
}
function checkFile(name, buf) {
  if (BAD_PATH.test(name)) problems.push(`不该打包的文件：${name}`);
  if (KEY_RE.test(buf.toString("latin1"))) problems.push(`疑似包含 API key：${name}`);
}

const apps = fs.readdirSync(dist).filter((d) => d.startsWith("mac")).map((d) => path.join(dist, d, "课堂同传.app"));
if (!apps.length) throw new Error("dist 里没有找到 课堂同传.app");
for (const app of apps) {
  const res = path.join(app, "Contents/Resources");
  walk(res);
  const archive = path.join(res, "app.asar");
  for (const f of asar.listPackage(archive)) {
    const rel = f.replace(/^\//, "");
    let buf;
    try { buf = asar.extractFile(archive, rel); } catch { continue; } // 目录
    checkFile(rel, buf);
  }
}
if (problems.length) {
  console.error("打包检查失败：\n" + problems.join("\n"));
  process.exit(1);
}
console.log(`打包检查通过：${apps.length} 个 App，未发现机密文件或 key`);
