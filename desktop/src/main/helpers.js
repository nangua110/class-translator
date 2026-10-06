import path from "node:path";

/** Swift 子程序的位置：开发时在 build/bin，打包后在 App 的 Resources/bin */
export function helperPaths({ isPackaged, resourcesPath, devDir }) {
  const dir = isPackaged ? path.join(resourcesPath, "bin") : devDir;
  return { asr: path.join(dir, "apple_asr"), translate: path.join(dir, "apple_translate"), syscap: path.join(dir, "syscap") };
}
