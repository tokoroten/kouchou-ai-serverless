import { buildCandidateEdges, type EdgeSet } from "../graph";
import type { OpinionRecord } from "../types";

// 候補kNNグラフ構築 Worker。semantic kNN の総当たりが重いためメインスレッドから分離。

export type GraphWorkerRequest = {
  type: "build";
  records: OpinionRecord[]; // Map は structured clone で送れる
  vectors: Float32Array;
  dim: number;
};

export type GraphWorkerResponse =
  | { type: "progress"; done: number; total: number; phase: string }
  | { type: "done"; edges: EdgeSet }
  | { type: "error"; message: string };

self.onmessage = (event: MessageEvent<GraphWorkerRequest>) => {
  const message = event.data;
  if (message.type !== "build") return;
  try {
    const edges = buildCandidateEdges(message.records, message.vectors, message.dim, {
      onProgress: (done, total, phase) => {
        self.postMessage({ type: "progress", done, total, phase } satisfies GraphWorkerResponse);
      },
    });
    self.postMessage({ type: "done", edges } satisfies GraphWorkerResponse, {
      transfer: [
        edges.source.buffer,
        edges.target.buffer,
        edges.semantic.buffer,
        edges.topic.buffer,
        edges.stance.buffer,
        edges.reason.buffer,
      ],
    });
  } catch (e) {
    self.postMessage({ type: "error", message: String(e) } satisfies GraphWorkerResponse);
  }
};
