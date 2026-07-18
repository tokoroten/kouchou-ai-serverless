import type { CommentRow } from "../types/project";
import { lookupModelPrice } from "../types/settings";
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

export const DEFAULT_PRICE_PER_M = { input: 0.2, output: 1.25, embedding: 0.02 };

/** チャット分の参考費用(USD)。既定価格は gpt-5.4-nano */
export function estimateChatUsd(estimate: CostEstimate, pricePerM = DEFAULT_PRICE_PER_M): number {
  return (estimate.chatInputTokens / 1e6) * pricePerM.input + (estimate.chatOutputTokens / 1e6) * pricePerM.output;
}

/** 埋め込み分の参考費用(USD)。既定価格は text-embedding-3-small */
export function estimateEmbeddingUsd(estimate: CostEstimate, pricePerM = DEFAULT_PRICE_PER_M): number {
  return (estimate.embeddingTokens / 1e6) * pricePerM.embedding;
}

/**
 * 参考価格(USD / 1M tokens)。既定は gpt-5.4-nano / text-embedding-3-small。
 *
 * local でスロットごとにローカル実行(Gemini Nano / ブラウザ内埋め込み)を指定できる。
 * チャットだけローカルで埋め込みは API、という構成があるため、スロット単位で
 * 除外しないと課金される分まで 0 円に見えてしまう。
 */
export function estimateUsd(
  estimate: CostEstimate,
  pricePerM = DEFAULT_PRICE_PER_M,
  local: { chat?: boolean; embedding?: boolean } = {},
): number {
  return (
    (local.chat ? 0 : estimateChatUsd(estimate, pricePerM)) +
    (local.embedding ? 0 : estimateEmbeddingUsd(estimate, pricePerM))
  );
}

/**
 * スロットごとの費用。既定価格ではなく、実際に選択されているモデルの単価を使う。
 * - local: ブラウザ内実行(Gemini Nano / ローカル埋め込み)なので課金されない
 * - unknown: 既知モデルリストに単価が無い(LM Studio・Ollama・カスタム等)。
 *   ここで既定価格を当てると別モデルの値段を出すことになるため、金額は出さない
 */
export type SlotCost =
  | { kind: "local"; model: string }
  | { kind: "unknown"; model: string }
  | { kind: "usd"; model: string; usd: number };

export type SlotEndpoint = { model: string; baseUrl: string; serviceTier?: string };

export function estimateSlotCosts(
  estimate: CostEstimate,
  chat: SlotEndpoint,
  embedding: SlotEndpoint,
): { chat: SlotCost; embedding: SlotCost; knownTotalUsd: number; hasUnknown: boolean } {
  const chatCost = ((): SlotCost => {
    if (chat.baseUrl.startsWith("local:")) return { kind: "local", model: chat.model };
    const price = lookupModelPrice(chat.model);
    if (!price) return { kind: "unknown", model: chat.model };
    const usd = estimateChatUsd(estimate, { ...DEFAULT_PRICE_PER_M, input: price.input, output: price.output });
    // Flex は Batch API 価格(約50%割引)。estimateActualCostUsd と揃える
    return { kind: "usd", model: chat.model, usd: chat.serviceTier === "flex" ? usd * 0.5 : usd };
  })();

  const embeddingCost = ((): SlotCost => {
    if (embedding.baseUrl.startsWith("local:")) return { kind: "local", model: embedding.model };
    const price = lookupModelPrice(embedding.model);
    // 埋め込みの price は "$0.02" の1数値のみ = input に入る
    if (!price) return { kind: "unknown", model: embedding.model };
    return {
      kind: "usd",
      model: embedding.model,
      usd: estimateEmbeddingUsd(estimate, { ...DEFAULT_PRICE_PER_M, embedding: price.input }),
    };
  })();

  const knownTotalUsd = [chatCost, embeddingCost].reduce((sum, c) => sum + (c.kind === "usd" ? c.usd : 0), 0);
  const hasUnknown = chatCost.kind === "unknown" || embeddingCost.kind === "unknown";
  return { chat: chatCost, embedding: embeddingCost, knownTotalUsd, hasUnknown };
}
