import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";

/** 录电脑内部正在播放的声音（视频、网课）：子程序从标准输出持续吐 16kHz int16 PCM */
export class SystemAudio extends EventEmitter {
  constructor(bin) { super(); this.bin = bin; this.proc = null; }
  start() {
    const proc = spawn(this.bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    proc.on("error", (e) => this.emit("problem", String(e.message)));
    proc.stdin.on("error", () => {});
    proc.stdout.on("data", (b) => this.emit("data", b));
    readline.createInterface({ input: proc.stderr }).on("line", (line) => {
      try {
        const m = JSON.parse(line);
        if (m.type === "error") this.emit("problem", m.msg);
      } catch {}
    });
    this.proc = proc;
  }
  stop() {
    if (this.proc && this.proc.exitCode === null) this.proc.kill("SIGTERM");
    this.proc = null;
  }
}
