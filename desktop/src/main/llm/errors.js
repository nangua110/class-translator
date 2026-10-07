export class NoKey extends Error { name = "NoKey"; }               // 还没填这家的 API key
// 所有 Gemini 模型都在冷却：quota 为 true 表示都是额度用完，false 表示有的只是超时 / 服务器忙
export class AllModelsBusy extends Error {
  name = "AllModelsBusy";
  constructor(message, { quota = true } = {}) { super(message); this.quota = quota; }
}
export class TimeoutError extends Error { name = "TimeoutError"; }

export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`超过 ${Math.round(ms / 1000)} 秒没有响应`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// key 本身无效（而不是额度用完、服务器忙）
export function isAuthError(err) {
  if ([401, 403].includes(err?.status)) return true;
  return /API key not valid|API_KEY_INVALID|invalid x-api-key|authentication_error/i.test(String(err?.message ?? err));
}
