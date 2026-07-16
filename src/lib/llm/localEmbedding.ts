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
