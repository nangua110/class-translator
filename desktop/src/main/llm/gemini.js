import { AllModelsBusy, TimeoutError, withTimeout } from "./errors.js";

/** 指定了优先模型就排到最前；额度用完仍会自动换后面的 */
export function orderModels(models, pref) {
  const list = [...models];
  const i = list.indexOf(pref);
  if (i > 0) { list.splice(i, 1); list.unshift(pref); }
  return list;
}

/** 按顺序试模型；记住哪些模型额度用完 / 繁忙 / 超时，冷却期内直接跳过 */
export class GeminiPool {
  constructor(client, now = Date.now) {
    this.client = client;
    this.now = now;
    this.cooldown = new Map();
    this.reason = new Map(); // 模型 → 冷却原因：quota（额度用完）/ busy（超时、繁忙）
  }
  async generate(models, request, timeoutMs) {
    let lastErr = null;
    for (const model of models) {
      if ((this.cooldown.get(model) ?? 0) > this.now()) continue;
      try {
        return await withTimeout(this.client.models.generateContent({ model, ...request }), timeoutMs);
      } catch (e) {
        const status = e?.status ?? e?.code;
        const msg = String(e?.message ?? e);
        this.reason.set(model, status === 429 && msg.includes("PerDay") ? "quota" : "busy");
        if (e instanceof TimeoutError) this.cooldown.set(model, this.now() + 60_000);
        else if (status === 429 && msg.includes("PerDay")) {
          const m = msg.match(/retryDelay["']?\s*:\s*["']?(\d+)s/);
          this.cooldown.set(model, this.now() + (m ? Number(m[1]) : 6 * 3600) * 1000);
        } else if (status === 429) this.cooldown.set(model, this.now() + 60_000);
        else if ([500, 503, 504].includes(status)) this.cooldown.set(model, this.now() + 15_000);
        else throw e;
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    const quota = models.every((m) => this.reason.get(m) === "quota");
    throw new AllModelsBusy("所有模型都在冷却中", { quota });
  }
}
