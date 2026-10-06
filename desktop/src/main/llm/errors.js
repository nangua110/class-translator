export class NoKey extends Error { name = "NoKey"; }               // 还没填这家的 API key
export class AllModelsBusy extends Error { name = "AllModelsBusy"; } // 所有 Gemini 模型都在冷却（额度用完 / 繁忙）
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
