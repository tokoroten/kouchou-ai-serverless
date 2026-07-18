import type { ClusteringResult, EmbeddingResult } from "../../../types/project";
import { type ClusteringInput, clusterXY, runClusteringCore } from "../clusteringCore";
import { calculateRecommendedClusterNums } from "../clusterNums";
import type { PipelineContext } from "../context";
import { throwIfAborted } from "../context";

// clustering ステップの駆動部。
// ブラウザでは Web Worker で実行し(メインスレッドを塞がない)、
// Node(テスト・デバッグ)では直接 clusteringCore を呼ぶ。

export type ClusteringProgressExtra = {
  /** UMAP 収束過程の中間座標(進捗表示・賛否スペクトラム分析用) */
  onCoords?: (x: Float32Array, y: Float32Array) => void;
};

export async function clustering(
  embeddingResult: EmbeddingResult,
  clusterNums: number[],
  ctx: PipelineContext,
  extra: ClusteringProgressExtra = {},
): Promise<ClusteringResult> {
  throwIfAborted(ctx.signal);
  const count = embeddingResult.argIds.length;
  // ユーザ指定のクラスタ数がデータ件数を超えていても、抽出・埋め込みのコストを
  // 払った後に落とさないよう件数でクランプする
  const requested = clusterNums.length > 0 ? clusterNums : calculateRecommendedClusterNums(count);
  const nums = [...new Set(requested.map((n) => Math.max(2, Math.min(n, count))))].sort((a, b) => a - b);
  const input: ClusteringInput = {
    vectors: embeddingResult.vectors,
    dim: embeddingResult.dim,
    count,
    clusterNums: nums,
    seed: "kouchou-ai",
  };

  const cached = await ctx.checkpoints.getChunk("clustering", JSON.stringify(nums));
  if (cached) return cached as ClusteringResult;

  // UMAP 座標のチェックポイント(タブが閉じられても UMAP を再計算しない。
  // クラスタ数だけ変えた再実行も UMAP をスキップして KMeans+ward のみになる)
  const umapKey = umapCheckpointKey(input);
  const savedCoords: { x: Float32Array; y: Float32Array } | undefined = await ctx.checkpoints.getChunk("umap", umapKey);

  let output: CoreOutput;
  if (savedCoords) {
    const embedded: number[][] = new Array(count);
    for (let i = 0; i < count; i++) embedded[i] = [savedCoords.x[i], savedCoords.y[i]];
    const { clusterNums: sortedNums, assignments } = clusterXY(embedded, nums, input.seed ?? "kouchou-ai");
    output = { x: savedCoords.x, y: savedCoords.y, clusterNums: sortedNums, assignments };
  } else {
    output = typeof Worker !== "undefined" ? await runInWorker(input, ctx, extra) : runClusteringCore(input, {});
    await ctx.checkpoints.putChunk("umap", umapKey, { x: output.x, y: output.y });
  }

  const result: ClusteringResult = {
    argIds: embeddingResult.argIds,
    x: output.x,
    y: output.y,
    clusterNums: output.clusterNums,
    assignments: output.assignments,
  };
  await ctx.checkpoints.putChunk("clustering", JSON.stringify(nums), result);
  return result;
}

type CoreOutput = {
  x: Float32Array;
  y: Float32Array;
  clusterNums: number[];
  assignments: Int32Array[];
};

export function umapCheckpointKey(input: Pick<ClusteringInput, "count" | "dim" | "seed" | "umap">): string {
  const params = input.umap && Object.keys(input.umap).length > 0 ? `/${JSON.stringify(input.umap)}` : "";
  return `${input.count}/${input.dim}/${input.seed ?? "kouchou-ai"}${params}`;
}

function runInWorker(
  input: ClusteringInput,
  ctx: PipelineContext,
  extra: ClusteringProgressExtra,
): Promise<CoreOutput> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../../workers/clustering.worker.ts", import.meta.url), { type: "module" });
    const onAbort = () => {
      worker.postMessage({ type: "abort" });
      worker.terminate();
      reject(new DOMException("Aborted", "AbortError"));
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    worker.onmessage = (event) => {
      const message = event.data;
      switch (message.type) {
        case "progress":
          ctx.onProgress?.({
            step: "clustering",
            done: message.epoch,
            total: message.totalEpochs,
            message: "UMAP",
          });
          break;
        case "coords":
          extra.onCoords?.(message.x, message.y);
          break;
        case "phase":
          ctx.onProgress?.({ step: "clustering", done: 0, total: 0, message: message.phase });
          break;
        case "done":
          cleanup();
          resolve({
            x: message.x,
            y: message.y,
            clusterNums: message.clusterNums,
            assignments: message.assignments,
          });
          break;
        case "error":
          cleanup();
          reject(
            message.message === "aborted" ? new DOMException("Aborted", "AbortError") : new Error(message.message),
          );
          break;
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(`clustering worker error: ${event.message}`));
    };

    function cleanup() {
      ctx.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    }

    // vectors は transfer せずコピーで渡す(チェックポイント再利用のため)
    worker.postMessage({ type: "run", input });
  });
}
