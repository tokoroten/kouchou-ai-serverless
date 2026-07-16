import type { PipelineStepName } from "../../types/project";
import type { EndpointConfig } from "../../types/settings";
import type { Usage } from "../llm/client";

// パイプライン各ステップに渡す実行コンテキスト(DESIGN §12)。
// ステップは (input, config, ctx) => output の純関数に近い形にする。

export type ProgressEvent = {
  step: PipelineStepName;
  done: number;
  total: number;
  message?: string;
};

// チェックポイントの読み書き。ブラウザでは IndexedDB、テスト/Node ではメモリ実装を渡す。
export type Checkpoints = {
  getExtraction(commentId: string): Promise<string[] | undefined>;
  putExtraction(commentId: string, args: string[]): Promise<void>;
  // biome-ignore lint/suspicious/noExplicitAny: ステップごとに型が異なる
  getChunk(step: string, key: string): Promise<any | undefined>;
  // biome-ignore lint/suspicious/noExplicitAny: ステップごとに型が異なる
  putChunk(step: string, key: string, data: any): Promise<void>;
};

export type PipelineContext = {
  chat: EndpointConfig;
  embedding: EndpointConfig;
  concurrency: number;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
  onUsage?: (usage: Usage) => void;
  checkpoints: Checkpoints;
  /** シード可能な乱数(サンプリング用)。省略時は Math.random */
  random?: () => number;
};

/** メモリ上のチェックポイント実装(テスト・Node デバッグ用) */
export function memoryCheckpoints(): Checkpoints {
  const extraction = new Map<string, string[]>();
  // biome-ignore lint/suspicious/noExplicitAny: ステップごとに型が異なる
  const chunks = new Map<string, any>();
  return {
    async getExtraction(commentId) {
      return extraction.get(commentId);
    },
    async putExtraction(commentId, args) {
      extraction.set(commentId, args);
    },
    async getChunk(step, key) {
      return chunks.get(`${step}/${key}`);
    },
    async putChunk(step, key, data) {
      chunks.set(`${step}/${key}`, data);
    },
  };
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
