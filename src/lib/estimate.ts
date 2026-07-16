import type { CommentRow } from "../types/project";
import { calculateRecommendedClusterNums } from "./pipeline/clusterNums";

// コスト見積り(DESIGN §7 Step4)。
// 日本語は概ね 1文字 ≈ 0.7〜1 トークン。ここでは 0.8 で概算する。

const TOKENS_PER_CHAR = 0.8;

export type CostEstimate = {
  chatInputTokens: number;
  chatOutputTokens: number;
  embeddingTokens: number;
  chatCalls: number;
};

export function estimateCost(
  comments: CommentRow[],
  promptChars: { extraction: number; initialLabelling: number; mergeLabelling: number; overview: number },
  clusterNums: number[],
  samplingNum: number,
): CostEstimate {
  const n = comments.length;
  const totalCommentChars = comments.reduce((sum, c) => sum + c.body.length, 0);
  const avgCommentChars = n > 0 ? totalCommentChars / n : 0;
  // 経験的に1コメントから1〜2件の意見が出る。意見の平均長はコメントの6割程度と仮定。
  const estimatedArgs = Math.max(2, Math.round(n * 1.3));
  const avgArgChars = Math.max(20, avgCommentChars * 0.6);

  const nums = clusterNums.length > 0 ? clusterNums : n >= 2 ? calculateRecommendedClusterNums(estimatedArgs) : [2];
  const totalClusters = nums.reduce((a, b) => a + b, 0);
  const deepestClusters = nums[nums.length - 1];

  // extraction: コメント1件 = 1呼び出し
  const extractionInput = n * (promptChars.extraction + avgCommentChars) * TOKENS_PER_CHAR;
  const extractionOutput = estimatedArgs * avgArgChars * TOKENS_PER_CHAR;

  // labelling: クラスタ1つ = 1呼び出し(サンプル意見 + プロンプト)
  const labelInput = totalClusters * (promptChars.initialLabelling + samplingNum * avgArgChars) * TOKENS_PER_CHAR;
  const labelOutput = totalClusters * 200 * TOKENS_PER_CHAR;

  // overview: 1呼び出し
  const overviewInput = (promptChars.overview + nums[0] * 250) * TOKENS_PER_CHAR;
  const overviewOutput = 300 * TOKENS_PER_CHAR;

  const embeddingTokens = estimatedArgs * avgArgChars * TOKENS_PER_CHAR;

  return {
    chatInputTokens: Math.round(extractionInput + labelInput + overviewInput),
    chatOutputTokens: Math.round(extractionOutput + labelOutput + overviewOutput),
    embeddingTokens: Math.round(embeddingTokens),
    chatCalls: n + totalClusters - deepestClusters + deepestClusters + 1,
  };
}

/** 参考価格(USD / 1M tokens)。既定は gpt-4o-mini / text-embedding-3-small */
export function estimateUsd(estimate: CostEstimate, pricePerM = { input: 0.15, output: 0.6, embedding: 0.02 }): number {
  return (
    (estimate.chatInputTokens / 1e6) * pricePerM.input +
    (estimate.chatOutputTokens / 1e6) * pricePerM.output +
    (estimate.embeddingTokens / 1e6) * pricePerM.embedding
  );
}
