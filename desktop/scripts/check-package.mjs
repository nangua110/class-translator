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

// 找出所有打好的 App：Mac 在 dist/mac*/课堂同传.app/Contents/Resources，Windows 在 dist/win*-unpacked/resources
const resourceDirs = fs.readdirSync(dist).flatMap((d) => {
  if (d.startsWith("mac")) return [path.join(dist, d, "课堂同传.app", "Contents", "Resources")];
  if (d.startsWith("win") && d.endsWith("unpacked")) return [path.join(dist, d, "resources")];
  return [];
}).filter((r) => fs.existsSync(path.join(r, "app.asar")));
if (!resourceDirs.length) throw new Error("dist 里没有找到打好的 App");

const MUST_HAVE = ["assets/silero_vad.onnx", "node_modules/onnxruntime-web/dist/ort.node.min.js"];
const MUST_UNPACKED = "app.asar.unpacked/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm";
for (const res of resourceDirs) {
  walk(res);
  const archive = path.join(res, "app.asar");
  const listed = asar.listPackage(archive).map((f) => f.replace(/^[\\/]/, "").replaceAll("\\", "/"));
  for (const rel of listed) {
    let buf;
    try { buf = asar.extractFile(archive, rel); } catch { continue; } // 目录
    checkFile(rel, buf);
  }
  for (const need of MUST_HAVE) if (!listed.includes(need)) problems.push(`缺少必需文件：${need}（${res}）`);
  if (!fs.existsSync(path.join(res, MUST_UNPACKED))) problems.push(`缺少人声检测运行文件：${MUST_UNPACKED}（${res}）`);
  const ortFiles = listed.filter((f) => f.startsWith("node_modules/onnxruntime-web/dist/") && f.split("/").length === 4);
  if (ortFiles.length > 4) problems.push(`onnxruntime-web 多带了文件：${ortFiles.length} 个（${res}）`);
}
if (problems.length) {
  console.error("打包检查失败：\n" + problems.join("\n"));
  process.exit(1);
}
console.log(`打包检查通过：${resourceDirs.length} 个 App，未发现机密文件或 key，必需文件齐全`);
