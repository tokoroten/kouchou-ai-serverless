import type { ClusterLabel, LabellingResult } from "../../../types/project";
import { Semaphore, requestChat } from "../../llm/client";
import { parseLabelResponse } from "../../llm/jsonParse";
import type { ClusterTable } from "../clusterTable";
import { compositionHash, rowsInCluster, sampleRows, uniqueClusterIds } from "../clusterTable";
import type { PipelineContext } from "../context";
import { throwIfAborted } from "../context";

// 本家 hierarchical_initial_labelling.py / hierarchical_merge_labelling.py の移植。
// - initial: 最深レベルの各クラスタから sampling_num 件サンプリングして chat 1回
// - merge: 深いレベルから順に、子クラスタの label/description + サンプル意見から親を生成
// - 失敗時は本家と同じプレースホルダ文字列
// - チェックポイント: クラスタ単位

export const LABEL_ERROR_PLACEHOLDER = "エラーでラベル名が取得できませんでした";
export const DESCRIPTION_ERROR_PLACEHOLDER = "エラーで解説が取得できませんでした";

const LABEL_SCHEMA = {
  name: "LabellingFormat",
  schema: {
    type: "object",
    properties: {
      label: { type: "string", description: "クラスタのラベル名" },
      description: { type: "string", description: "クラスタの説明文" },
    },
    required: ["label", "description"],
    additionalProperties: false,
  },
};

async function requestLabel(
  systemPrompt: string,
  userContent: string,
  ctx: PipelineContext,
): Promise<{ label: string; description: string }> {
  try {
    const response = await requestChat(ctx.chat, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      jsonSchema: LABEL_SCHEMA,
      signal: ctx.signal,
      onUsage: ctx.onUsage,
    });
    const parsed = parseLabelResponse(response);
    if (parsed) {
      return {
        label: parsed.label || LABEL_ERROR_PLACEHOLDER,
        description: parsed.description || DESCRIPTION_ERROR_PLACEHOLDER,
      };
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    console.error("labelling failed:", e);
  }
  return { label: LABEL_ERROR_PLACEHOLDER, description: DESCRIPTION_ERROR_PLACEHOLDER };
}

/** 最深レベルのラベル付け(本家 initial_labelling) */
export async function initialLabelling(
  table: ClusterTable,
  prompt: string,
  samplingNum: number,
  ctx: PipelineContext,
): Promise<ClusterLabel[]> {
  const deepestLevel = table.levels[table.levels.length - 1];
  const clusterIds = uniqueClusterIds(table, deepestLevel);
  const semaphore = new Semaphore(ctx.concurrency);
  const random = ctx.random ?? Math.random;
  let done = 0;
  ctx.onProgress?.({ step: "initial_labelling", done, total: clusterIds.length });

  const results = await Promise.all(
    clusterIds.map((clusterId) =>
      semaphore.run(async (): Promise<ClusterLabel> => {
        throwIfAborted(ctx.signal);
        // クラスタ構成ハッシュをキーに含める: 再クラスタリング後も同一構成なら再利用できる
        const cacheKey = `initial/${clusterId}/${compositionHash(table, deepestLevel, clusterId)}`;
        let labelled: ClusterLabel | undefined = await ctx.checkpoints.getChunk("labelling", cacheKey);
        if (!labelled) {
          const rows = rowsInCluster(table, deepestLevel, clusterId);
          const sampled = sampleRows(rows, Math.min(samplingNum, rows.length), random);
          const input = sampled.map((row) => table.argumentTexts[row]).join("\n");
          const { label, description } = await requestLabel(prompt, input, ctx);
          labelled = { clusterId, label, description };
          await ctx.checkpoints.putChunk("labelling", cacheKey, labelled);
        }
        done++;
        ctx.onProgress?.({ step: "initial_labelling", done, total: clusterIds.length });
        return labelled;
      }),
    ),
  );
  return results;
}

/**
 * 上位レベルのラベル付け(本家 merge_labelling)。
 * 最深レベルのラベルを受け取り、深いレベルから順に親レベルのラベルを生成する。
 * 戻り値は全レベルのラベル(最深レベル含む)。
 */
export async function mergeLabelling(
  table: ClusterTable,
  deepestLabels: ClusterLabel[],
  prompt: string,
  samplingNum: number,
  ctx: PipelineContext,
): Promise<LabellingResult> {
  const byLevel: Record<number, ClusterLabel[]> = {};
  const deepestLevel = table.levels[table.levels.length - 1];
  byLevel[deepestLevel] = deepestLabels;

  const totalClusters = table.levels
    .slice(0, -1)
    .reduce((sum, level) => sum + uniqueClusterIds(table, level).length, 0);
  let done = 0;
  ctx.onProgress?.({ step: "merge_labelling", done, total: totalClusters });

  // 深いレベルから順に処理する(level = deepest-1 .. 1)
  for (let levelIndex = table.levels.length - 2; levelIndex >= 0; levelIndex--) {
    const level = table.levels[levelIndex];
    const childLevel = table.levels[levelIndex + 1];
    const childLabelById = new Map(byLevel[childLevel].map((l) => [l.clusterId, l]));
    const clusterIds = uniqueClusterIds(table, level);
    const semaphore = new Semaphore(ctx.concurrency);
    const random = ctx.random ?? Math.random;

    byLevel[level] = await Promise.all(
      clusterIds.map((clusterId) =>
        semaphore.run(async (): Promise<ClusterLabel> => {
          throwIfAborted(ctx.signal);
          const cacheKey = `merge/${clusterId}/${compositionHash(table, level, clusterId)}`;
          let labelled: ClusterLabel | undefined = await ctx.checkpoints.getChunk("labelling", cacheKey);
          if (!labelled) {
            labelled = await mergeOne(
              table,
              level,
              childLevel,
              clusterId,
              childLabelById,
              prompt,
              samplingNum,
              random,
              ctx,
            );
            await ctx.checkpoints.putChunk("labelling", cacheKey, labelled);
          }
          done++;
          ctx.onProgress?.({ step: "merge_labelling", done, total: totalClusters });
          return labelled;
        }),
      ),
    );
  }
  return { byLevel };
}

async function mergeOne(
  table: ClusterTable,
  level: number,
  childLevel: number,
  clusterId: string,
  childLabelById: Map<string, ClusterLabel>,
  prompt: string,
  samplingNum: number,
  random: () => number,
  ctx: PipelineContext,
): Promise<ClusterLabel> {
  const rows = rowsInCluster(table, level, clusterId);
  // このクラスタに属する子クラスタの label/description(ユニーク)
  const childIds = [...new Set(rows.map((row) => table.idsByLevel[childLevel - 1][row]))].sort();
  const children = childIds.map((id) => childLabelById.get(id)).filter((l): l is ClusterLabel => l !== undefined);

  // 本家と同じ: 子が1つだけなら LLM を呼ばずそのまま引き継ぐ
  if (children.length === 1) {
    return { clusterId, label: children[0].label, description: children[0].description };
  }
  if (children.length === 0) {
    return { clusterId, label: LABEL_ERROR_PLACEHOLDER, description: DESCRIPTION_ERROR_PLACEHOLDER };
  }

  const sampled = sampleRows(rows, Math.min(samplingNum, rows.length), random);
  const sampledText = sampled.map((row) => table.argumentTexts[row]).join("\n");
  const clusterText = children.map((c) => `- ${c.label}: ${c.description}`).join("\n");
  const userContent = `クラスタラベル\n${clusterText}\nクラスタの意見\n${sampledText}`;
  const { label, description } = await requestLabel(prompt, userContent, ctx);
  return { clusterId, label, description };
}
