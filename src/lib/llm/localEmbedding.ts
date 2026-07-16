import type { EndpointConfig } from "../../types/settings";

// ブラウザ内ローカル埋め込み(transformers.js + WebGPU、DESIGN M8 の任意項目)。
// baseUrl に LOCAL_EMBEDDING_BASE_URL を指定すると API の代わりにこちらが使われる。
// モデルは初回に Hugging Face Hub からダウンロードされ、ブラウザにキャッシュされる。

export const LOCAL_EMBEDDING_BASE_URL = "local:transformers";
export const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/multilingual-e5-small";

export function isLocalEmbedding(endpoint: EndpointConfig): boolean {
  return endpoint.baseUrl === LOCAL_EMBEDDING_BASE_URL;
}

// biome-ignore lint/suspicious/noExplicitAny: transformers.js の pipeline は動的型
let cachedPipeline: { model: string; pipe: any } | null = null;

async function getPipeline(model: string, onStatus?: (message: string) => void) {
  if (cachedPipeline?.model === model) return cachedPipeline.pipe;
  const { pipeline } = await import("@huggingface/transformers");
  const hasWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
  onStatus?.(hasWebGpu ? "モデル読み込み中 (WebGPU)..." : "モデル読み込み中 (WASM: WebGPU 非対応環境)...");
  const pipe = await pipeline("feature-extraction", model, {
    device: hasWebGpu ? "webgpu" : "wasm",
    dtype: hasWebGpu ? "fp32" : "q8",
    // biome-ignore lint/suspicious/noExplicitAny: 進捗コールバックの型が公開されていない
    progress_callback: (progress: any) => {
      if (progress.status === "progress" && progress.file) {
        onStatus?.(`モデルダウンロード中: ${progress.file} ${Math.round(progress.progress ?? 0)}%`);
      }
    },
  });
  cachedPipeline = { model, pipe };
  return pipe;
}

// ---- Worker 経由の実行(ブラウザ用。WASM 時にメインスレッドを塞がない) ----

let embeddingWorker: Worker | null = null;
let requestSeq = 0;
// Worker 破棄時に、待機中の他リクエストも失敗させるための登録簿
const pendingRejects = new Map<number, (reason: unknown) => void>();

function destroyEmbeddingWorker(reason: unknown): void {
  embeddingWorker?.terminate();
  embeddingWorker = null;
  for (const reject of pendingRejects.values()) reject(reason);
  pendingRejects.clear();
}

/**
 * ローカル埋め込みを Web Worker で実行する。Worker が使えない環境(Node)では
 * メインスレッドで直接実行する。Worker とモデルは呼び出し間で使い回される。
 */
export function embedLocallyViaWorker(
  texts: string[],
  model: string,
  onStatus?: (message: string) => void,
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  if (typeof Worker === "undefined") return embedLocally(texts, model, onStatus);
  if (!embeddingWorker) {
    embeddingWorker = new Worker(new URL("../workers/embedding.worker.ts", import.meta.url), { type: "module" });
  }
  const worker = embeddingWorker;
  const id = ++requestSeq;
  return new Promise<Float32Array[]>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      // 中断時は Worker ごと破棄する(次回呼び出しで再生成・モデル再ロード)。
      // 同じ Worker を待っている他のリクエストもここで reject される。
      destroyEmbeddingWorker(new DOMException("Aborted", "AbortError"));
      reject(new DOMException("Aborted", "AbortError"));
    };
    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.id !== id) return;
      if (message.type === "status") {
        onStatus?.(message.message);
      } else if (message.type === "done") {
        cleanup();
        const { dim, flat } = message as { dim: number; flat: Float32Array };
        const vectors: Float32Array[] = [];
        for (let i = 0; i * dim < flat.length; i++) {
          vectors.push(flat.slice(i * dim, (i + 1) * dim));
        }
        resolve(vectors);
      } else if (message.type === "error") {
        cleanup();
        reject(new Error(message.message));
      }
    };
    function cleanup() {
      pendingRejects.delete(id);
      worker.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", onAbort);
    }
    pendingRejects.set(id, (reason) => {
      worker.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", onAbort);
      reject(reason instanceof Error || reason instanceof DOMException ? reason : new Error(String(reason)));
    });
    worker.addEventListener("message", onMessage);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    worker.postMessage({ type: "embed", id, texts, model });
  });
}

/**
 * テキスト配列をローカルで埋め込む。texts と同順の Float32Array 配列を返す。
 * e5 系モデルの流儀に従い "passage: " プレフィックスを付ける。
 */
export async function embedLocally(
  texts: string[],
  model: string,
  onStatus?: (message: string) => void,
): Promise<Float32Array[]> {
  const pipe = await getPipeline(model || DEFAULT_LOCAL_EMBEDDING_MODEL, onStatus);
  const prefixed = texts.map((t) => `passage: ${t}`);
  const output = await pipe(prefixed, { pooling: "mean", normalize: true });
  // output は [n, dim] の Tensor
  const [n, dim] = output.dims as [number, number];
  const data = output.data as Float32Array;
  const result: Float32Array[] = new Array(n);
  for (let i = 0; i < n; i++) {
    result[i] = data.slice(i * dim, (i + 1) * dim);
  }
  return result;
}
