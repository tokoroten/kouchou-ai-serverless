import { embedLocally } from "../llm/localEmbedding";

// ローカル埋め込み(transformers.js)を実行する Web Worker。
// WASM フォールバック時にメインスレッドを塞がないための分離。
// Worker は使い回され、モデルはロード済みのまま保持される。

export type EmbeddingWorkerRequest = {
  type: "embed";
  id: number;
  texts: string[];
  model: string;
};

export type EmbeddingWorkerResponse =
  | { type: "status"; id: number; message: string }
  | { type: "done"; id: number; dim: number; flat: Float32Array }
  | { type: "error"; id: number; message: string };

self.onmessage = async (event: MessageEvent<EmbeddingWorkerRequest>) => {
  const message = event.data;
  if (message.type !== "embed") return;
  const { id, texts, model } = message;
  try {
    const vectors = await embedLocally(texts, model, (status) => {
      self.postMessage({ type: "status", id, message: status } satisfies EmbeddingWorkerResponse);
    });
    const dim = vectors[0]?.length ?? 0;
    const flat = new Float32Array(vectors.length * dim);
    vectors.forEach((v, i) => {
      flat.set(v, i * dim);
    });
    self.postMessage({ type: "done", id, dim, flat } satisfies EmbeddingWorkerResponse, {
      transfer: [flat.buffer],
    });
  } catch (e) {
    self.postMessage({ type: "error", id, message: String(e) } satisfies EmbeddingWorkerResponse);
  }
};
