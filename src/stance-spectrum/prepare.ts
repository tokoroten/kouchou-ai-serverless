import type { PipelineContext } from "../lib/pipeline/context";
import { embedding } from "../lib/pipeline/steps/embedding";
import type { CommentRow, EmbeddingResult } from "../types/project";
import { assignTagVector, buildCodebook } from "./codebook";
import { extractAndEnrich } from "./extractEnrich";
import type { EdgeSet } from "./graph";
import { CHUNK_STEP } from "./storageKeys";
import type { Codebook, OpinionRecord } from "./types";

// 賛否スペクトラム分析のデータ準備(生コメント → OpinionRecord[] + Codebook + 埋め込み + 候補辺)。
// 賛否スペクトラム分析は通常版の extraction/embedding には依存せず、専用の投入口で
// 「意見抽出 + 構造化属性付与」を1コールにまとめ、意見文を独自に埋め込む。
// すべてチェックポイント付き: 抽出はコメント単位、埋め込みはバッチ単位、
// コードブックと辺は全体で1チャンク。

export type StanceSpectrumData = {
  records: OpinionRecord[];
  codebook: Codebook;
  embedding: EmbeddingResult;
};

export type StanceSpectrumStatus = (message: string, done?: number, total?: number) => void;

export async function prepareStanceSpectrumRecords(
  comments: CommentRow[],
  extractionPrompt: string,
  ctx: PipelineContext,
  onStatus?: StanceSpectrumStatus,
): Promise<StanceSpectrumData> {
  // 1. 結合抽出: 生コメント → 意見(argument) + 構造化属性(stance/topics/reasons 等)
  onStatus?.("意見抽出 + 構造化属性付与...", 0, comments.length);
  const { args, relations, enrichments } = await extractAndEnrich(comments, extractionPrompt, ctx, (done, total) =>
    onStatus?.("意見抽出 + 構造化属性付与...", done, total),
  );

  // 2. 意見文の埋め込み(通常版とは独立。賛否スペクトラム分析の隔離チェックポイントに保存)
  onStatus?.("意見のベクトル化...", 0, args.length);
  const embeddingResult = await embedding(args, {
    ...ctx,
    onProgress: (event) => onStatus?.("意見のベクトル化...", event.done, event.total),
  });

  // 3. コードブック統合(2パス方式)
  onStatus?.("タグのコードブック統合...");
  const codebook = await buildCodebook(enrichments, ctx);

  // 4. コードブックへの割当(疎ベクトル化)して OpinionRecord を組む
  const argIdToCommentId = new Map(relations.map((r) => [r.argId, r.commentId]));
  const records: OpinionRecord[] = args.map((arg, i) => ({
    id: arg.argId,
    originalCommentId: argIdToCommentId.get(arg.argId) ?? "",
    claimText: arg.argument,
    enrichment: enrichments[i],
    topicVector: assignTagVector(enrichments[i].topics, codebook.topicIndex),
    reasonVector: assignTagVector(enrichments[i].reasons, codebook.reasonIndex),
  }));
  return { records, codebook, embedding: embeddingResult };
}

/** 候補辺の構築(Worker)。IndexedDB にキャッシュする。 */
export async function buildEdgesWithWorker(
  records: OpinionRecord[],
  embedding: EmbeddingResult,
  ctx: PipelineContext,
  onStatus?: StanceSpectrumStatus,
): Promise<EdgeSet> {
  const cacheKey = `v1/${records.length}`;
  const cached = await ctx.checkpoints.getChunk(CHUNK_STEP.edges, cacheKey);
  if (cached) return cached as EdgeSet;

  const edges = await new Promise<EdgeSet>((resolve, reject) => {
    const worker = new Worker(new URL("./workers/graph.worker.ts", import.meta.url), { type: "module" });
    const onAbort = () => {
      worker.terminate();
      reject(new DOMException("Aborted", "AbortError"));
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === "progress") {
        onStatus?.(`候補グラフ構築: ${message.phase}`, message.done, message.total);
      } else if (message.type === "done") {
        ctx.signal?.removeEventListener("abort", onAbort);
        worker.terminate();
        resolve(message.edges);
      } else if (message.type === "error") {
        ctx.signal?.removeEventListener("abort", onAbort);
        worker.terminate();
        reject(new Error(message.message));
      }
    };
    worker.postMessage({
      type: "build",
      records,
      vectors: embedding.vectors,
      dim: embedding.dim,
    });
  });

  await ctx.checkpoints.putChunk(CHUNK_STEP.edges, cacheKey, edges);
  return edges;
}
