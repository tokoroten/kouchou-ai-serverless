import type { EmbeddingResult, ExtractedArgument } from "../../../types/project";
import { requestEmbeddings } from "../../llm/client";
import { isLocalEmbedding } from "../../llm/localEmbedding";
import type { PipelineContext } from "../context";
import { throwIfAborted } from "../context";

// 本家 steps/embedding.py の移植。
// ブラウザではペイロードとタイムアウトを考慮しバッチ100件(本家は1000)。
// ローカル埋め込み(transformers.js + WebGPU)選択時は API を呼ばずブラウザ内で計算する。
// チェックポイント: バッチ単位。

const BATCH_SIZE = 100;
const LOCAL_BATCH_SIZE = 16;

export async function embedding(args: ExtractedArgument[], ctx: PipelineContext): Promise<EmbeddingResult> {
  const argIds = args.map((a) => a.argId);
  const texts = args.map((a) => a.argument);
  const local = isLocalEmbedding(ctx.embedding);
  const BATCH = local ? LOCAL_BATCH_SIZE : BATCH_SIZE;
  const total = Math.ceil(texts.length / BATCH);
  let dim = 0;
  const batches: Float32Array[] = [];

  for (let batchIndex = 0; batchIndex < total; batchIndex++) {
    throwIfAborted(ctx.signal);
    const key = `${local ? "local:" : ""}${ctx.embedding.model}/${BATCH}/${batchIndex}`;
    let flat: Float32Array | undefined = await ctx.checkpoints.getChunk("embedding", key);
    if (flat === undefined) {
      const start = batchIndex * BATCH;
      const batchTexts = texts.slice(start, start + BATCH);
      let vectors: Float32Array[];
      if (local) {
        const { embedLocallyViaWorker } = await import("../../llm/localEmbedding");
        vectors = await embedLocallyViaWorker(
          batchTexts,
          ctx.embedding.model,
          (message) => ctx.onProgress?.({ step: "embedding", done: batchIndex, total, message }),
          ctx.signal,
        );
      } else {
        vectors = await requestEmbeddings(ctx.embedding, {
          texts: batchTexts,
          signal: ctx.signal,
          onUsage: ctx.onUsage,
        });
      }
      if (vectors.length !== batchTexts.length) {
        throw new Error(`embeddings 応答件数が一致しません: 要求 ${batchTexts.length}, 応答 ${vectors.length}`);
      }
      const batchDim = vectors[0]?.length ?? 0;
      flat = new Float32Array(vectors.length * batchDim);
      vectors.forEach((v, i) => {
        flat?.set(v, i * batchDim);
      });
      // バッチ単位で逐次保存(タブが閉じられても失われない)
      await ctx.checkpoints.putChunk("embedding", key, flat);
    }
    batches.push(flat);
    if (batches[0].length > 0 && dim === 0) {
      const firstBatchCount = Math.min(BATCH, texts.length);
      dim = batches[0].length / firstBatchCount;
    }
    ctx.onProgress?.({ step: "embedding", done: batchIndex + 1, total });
  }

  const totalLength = batches.reduce((sum, b) => sum + b.length, 0);
  if (dim === 0 || totalLength !== argIds.length * dim) {
    throw new Error(`埋め込みの次元数が不正です (dim=${dim}, total=${totalLength}, args=${argIds.length})`);
  }
  const vectors = new Float32Array(totalLength);
  let offset = 0;
  for (const batch of batches) {
    vectors.set(batch, offset);
    offset += batch.length;
  }
  return { argIds, dim, vectors };
}
