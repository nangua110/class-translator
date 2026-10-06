// 把 marked 复制进 renderer/vendor：App 不从网上加载任何脚本
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const candidates = ["lib/marked.umd.js", "marked.min.js", "lib/marked.umd.min.js"]
  .map((f) => path.join(here, "../node_modules/marked", f));
const src = candidates.find((f) => fs.existsSync(f));
if (!src) throw new Error("找不到 marked 的浏览器版脚本：" + candidates.join(", "));
const out = path.join(here, "../src/renderer/vendor");
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(src, path.join(out, "marked.umd.js"));
console.log("已复制", path.relative(process.cwd(), src));
