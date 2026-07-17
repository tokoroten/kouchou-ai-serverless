import type { PipelineContext } from "../lib/pipeline/context";
import type { EmbeddingResult, ExtractionResult } from "../types/project";
import { assignTagVector, buildCodebook } from "./codebook";
import { enrichArguments } from "./enrich";
import type { EdgeSet } from "./graph";
import type { Codebook, OpinionRecord } from "./types";

// フェーズ2のデータ準備(前処理済みデータ → OpinionRecord[] + Codebook + 候補辺)。
// すべてチェックポイント付き: enrich は意見単位、コードブックと辺は全体で1チャンク。

export type Phase2Data = {
  records: OpinionRecord[];
  codebook: Codebook;
};

export type Phase2Status = (message: string, done?: number, total?: number) => void;

export async function preparePhase2Records(
  extraction: ExtractionResult,
  ctx: PipelineContext,
  onStatus?: Phase2Status,
): Promise<Phase2Data> {
  // 1パス目: 構造化抽出(自由生成タグ)
  onStatus?.("構造化抽出(stance/topics/reasons)...", 0, extraction.args.length);
  const enrichments = await enrichArguments(extraction.args, ctx, (done, total) =>
    onStatus?.("構造化抽出(stance/topics/reasons)...", done, total),
  );

  // コードブック統合(2パス方式)
  onStatus?.("タグのコードブック統合...");
  const codebook = await buildCodebook(enrichments, ctx);

  // 2パス目: コードブックへの割当(疎ベクトル化)
  const argIdToCommentId = new Map(extraction.relations.map((r) => [r.argId, r.commentId]));
  const records: OpinionRecord[] = extraction.args.map((arg, i) => ({
    id: arg.argId,
    originalCommentId: argIdToCommentId.get(arg.argId) ?? "",
    claimText: arg.argument,
    enrichment: enrichments[i],
    topicVector: assignTagVector(enrichments[i].topics, codebook.topicIndex),
    reasonVector: assignTagVector(enrichments[i].reasons, codebook.reasonIndex),
  }));
  return { records, codebook };
}

/** 候補辺の構築(Worker)。IndexedDB にキャッシュする。 */
export async function buildEdgesWithWorker(
  records: OpinionRecord[],
  embedding: EmbeddingResult,
  ctx: PipelineContext,
  onStatus?: Phase2Status,
): Promise<EdgeSet> {
  const cacheKey = `v1/${records.length}`;
  const cached = await ctx.checkpoints.getChunk("phase2-edges", cacheKey);
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

  await ctx.checkpoints.putChunk("phase2-edges", cacheKey, edges);
  return edges;
}
