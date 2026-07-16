import type { LabellingResult } from "../../../types/project";
import { requestChat } from "../../llm/client";
import { parseOverviewResponse } from "../../llm/jsonParse";
import { fnv1a } from "../clusterTable";
import type { PipelineContext } from "../context";
import { throwIfAborted } from "../context";

// 本家 hierarchical_overview.py の移植。
// level 1 の全クラスタの label/description を連結して chat 1回。

const OVERVIEW_SCHEMA = {
  name: "OverviewResponse",
  schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "クラスターの全体的な要約" },
    },
    required: ["summary"],
    additionalProperties: false,
  },
};

export async function overview(labels: LabellingResult, prompt: string, ctx: PipelineContext): Promise<string> {
  throwIfAborted(ctx.signal);

  const level1 = labels.byLevel[1] ?? [];
  let inputText = "";
  level1.forEach((cluster, i) => {
    inputText += `# Cluster ${i}/${level1.length}: ${cluster.label}\n\n`;
    inputText += `${cluster.description}\n\n`;
  });

  // 入力内容をキーにキャッシュ(再クラスタリング後、level1 が同一構成なら再利用)
  const cacheKey = fnv1a(inputText);
  const cached = await ctx.checkpoints.getChunk("overview", cacheKey);
  if (typeof cached === "string") return cached;

  ctx.onProgress?.({ step: "overview", done: 0, total: 1 });
  const response = await requestChat(ctx.chat, {
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: inputText },
    ],
    jsonSchema: OVERVIEW_SCHEMA,
    signal: ctx.signal,
    onUsage: ctx.onUsage,
  });
  const summary = parseOverviewResponse(response);
  await ctx.checkpoints.putChunk("overview", cacheKey, summary);
  ctx.onProgress?.({ step: "overview", done: 1, total: 1 });
  return summary;
}
