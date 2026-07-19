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

/**
 * WebGPU が実際に使えるか。`navigator.gpu` の有無だけでは足りない —
 * ヘッドレスや GPU がブロックリストのブラウザでは API はあるのにアダプタが取れず、
 * device: "webgpu" で「no available backend found」になる。必ずアダプタまで確認する。
 */
async function canUseWebGpu(): Promise<boolean> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: navigator.gpu は lib.dom に無い環境がある
    const gpu = (globalThis.navigator as any)?.gpu;
    if (!gpu?.requestAdapter) return false;
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function getPipeline(model: string, onStatus?: (message: string) => void) {
  if (cachedPipeline?.model === model) return cachedPipeline.pipe;
  const { pipeline } = await import("@huggingface/transformers");
  // biome-ignore lint/suspicious/noExplicitAny: 進捗コールバックの型が公開されていない
  const progress_callback = (progress: any) => {
    if (progress.status === "progress" && progress.file) {
      onStatus?.(`モデルダウンロード中: ${progress.file} ${Math.round(progress.progress ?? 0)}%`);
    }
  };
  const load = (device: "webgpu" | "wasm") =>
    pipeline("feature-extraction", model, {
      device,
      dtype: device === "webgpu" ? "fp32" : "q8",
      progress_callback,
    });

  let pipe: Awaited<ReturnType<typeof load>>;
  if (await canUseWebGpu()) {
    onStatus?.("モデル読み込み中 (WebGPU)...");
    try {
      pipe = await load("webgpu");
    } catch (e) {
      // アダプタは取れても実際の初期化で落ちることがある。処理を止めず WASM へ落とす
      onStatus?.(`WebGPU の初期化に失敗したため WASM で再試行します (${e instanceof Error ? e.message : String(e)})`);
      pipe = await load("wasm");
    }
  } else {
    onStatus?.("モデル読み込み中 (WASM: WebGPU 非対応環境)...");
    pipe = await load("wasm");
  }
  cachedPipeline = { model, pipe };
  return pipe;
}

export type EmbeddingBackend = "webgpu" | "wasm" | "unknown";

export type EmbeddingBenchmark = {
  backend: EmbeddingBackend;
  count: number;
  totalMs: number;
  textsPerSec: number;
  dim: number;
};

/**
 * ローカル埋め込みの実効スループットを計測する。
 * ウォームアップ(モデルロード/DL)を計測対象から除外し、定常状態のバッチ処理時間を測る。
 * バックエンド(WebGPU / WASM)も判定して返す — WASM フォールバックだと桁で遅いため。
 */
export async function benchmarkLocalEmbedding(
  model: string,
  onStatus?: (message: string) => void,
  signal?: AbortSignal,
  options?: { count?: number; sampleText?: string },
): Promise<EmbeddingBenchmark> {
  const count = options?.count ?? 64;
  const sample =
    options?.sampleText ??
    "これはローカル埋め込みの速度計測用のサンプル文です。実データに近い長さの日本語テキストを想定しています。";
  let backend: EmbeddingBackend = "unknown";
  const captureBackend = (message: string) => {
    // WASM 側のメッセージは「WASM: WebGPU 非対応環境」のように両方の語を含むため、
    // WASM を先に判定する(WebGPU を先に見ると WASM 実行を取り違える)。
    if (/WASM/i.test(message)) backend = "wasm";
    else if (/WebGPU/i.test(message)) backend = "webgpu";
    onStatus?.(message);
  };

  // ウォームアップ(モデル読み込み/ダウンロード時間を計測から除外)
  onStatus?.("ウォームアップ(モデル読み込み)...");
  await embedLocallyViaWorker(new Array(8).fill(sample), model, captureBackend, signal);

  // 計測本番(実データに近い件数を定常状態で回す)
  onStatus?.(`計測中(${count} 件)...`);
  const texts = Array.from({ length: count }, (_, i) => `${sample} #${i}`);
  const start = Date.now();
  const vectors = await embedLocallyViaWorker(texts, model, () => {}, signal);
  const totalMs = Date.now() - start;

  // ロード済みで status が出なかった場合はアダプタの取得可否から推定
  if (backend === "unknown") {
    backend = (await canUseWebGpu()) ? "webgpu" : "wasm";
  }
  return {
    backend,
    count,
    totalMs,
    textsPerSec: totalMs > 0 ? count / (totalMs / 1000) : 0,
    dim: vectors[0]?.length ?? 0,
  };
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
  const resolvedModel = model || DEFAULT_LOCAL_EMBEDDING_MODEL;
  const pipe = await getPipeline(resolvedModel, onStatus);
  // e5 系モデルは "passage: " プレフィックスが必要(他のモデルには付けない)
  const prefixed = /(^|\/)(multilingual-)?e5-/.test(resolvedModel.toLowerCase())
    ? texts.map((t) => `passage: ${t}`)
    : texts;
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
