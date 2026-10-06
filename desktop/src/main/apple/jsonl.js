import { spawn } from "node:child_process";
import readline from "node:readline";

/** 启动一个「标准输出一行一个 JSON」的子程序；被 kill() 杀掉时 done 的结果是 -1 */
export function spawnJsonl(bin, args, onMessage) {
  const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "ignore"] });
  proc.stdin.on("error", () => {}); // 子程序先退出时写入会 EPIPE，忽略
  proc.on("error", () => {});
  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    onMessage(m);
  });
  const done = new Promise((resolve) => proc.on("close", (code, signal) => resolve(signal ? -1 : (code ?? -1))));
  const alive = () => proc.exitCode === null && proc.signalCode === null;
  return {
    proc, done,
    write: (data) => { if (alive() && proc.stdin.writable) proc.stdin.write(data); },
    end: () => { if (proc.stdin.writable) proc.stdin.end(); },
    kill: () => { if (alive()) proc.kill("SIGKILL"); },
  };
}
