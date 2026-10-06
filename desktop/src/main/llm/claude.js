/** 调 Claude；Opus / Sonnet 打开服务端兜底（被拒时自动换模型），Haiku 不支持 effort / fallbacks */
export async function askClaude(client, model, { system, prompt, effort, maxTokens }) {
  const extra = model.includes("haiku") ? {} : {
    output_config: { effort },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };
  const resp = await client.beta.messages.create({
    model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }], ...extra,
  });
  if (resp.stop_reason === "refusal") return "（模型拒绝处理该段）";
  return resp.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}
