import { type ClusteringInput, runClusteringCore } from "../pipeline/clusteringCore";

// クラスタリングを実行する Web Worker(DESIGN §6.3)。
// プロトコルは進捗%だけでなく中間座標(Float32Array, transferable)を流せる形にする
// (フェーズ2のインタラクティブモードでもそのまま使う)。

export type WorkerRequest = { type: "run"; input: ClusteringInput } | { type: "abort" };

export type WorkerResponse =
  | { type: "phase"; phase: "umap" | "kmeans" | "ward" }
  | { type: "progress"; epoch: number; totalEpochs: number }
  | { type: "coords"; x: Float32Array; y: Float32Array }
  | {
      type: "done";
      x: Float32Array;
      y: Float32Array;
      clusterNums: number[];
      assignments: Int32Array[];
    }
  | { type: "error"; message: string };

let aborted = false;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === "abort") {
    aborted = true;
    return;
  }
  if (message.type !== "run") return;
  aborted = false;
  try {
    const result = runClusteringCore(message.input, {
      shouldAbort: () => aborted,
      onPhase: (phase) => {
        self.postMessage({ type: "phase", phase } satisfies WorkerResponse);
      },
      onUmapProgress: (epoch, totalEpochs, coords) => {
        self.postMessage({ type: "progress", epoch, totalEpochs } satisfies WorkerResponse);
        if (coords) {
          self.postMessage({ type: "coords", x: coords.x, y: coords.y } satisfies WorkerResponse, {
            transfer: [coords.x.buffer, coords.y.buffer],
          });
        }
      },
    });
    self.postMessage(
      {
        type: "done",
        x: result.x,
        y: result.y,
        clusterNums: result.clusterNums,
        assignments: result.assignments,
      } satisfies WorkerResponse,
      {
        transfer: [result.x.buffer, result.y.buffer, ...result.assignments.map((a) => a.buffer)],
      },
    );
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      self.postMessage({ type: "error", message: "aborted" } satisfies WorkerResponse);
    } else {
      self.postMessage({ type: "error", message: String(e) } satisfies WorkerResponse);
    }
  }
};
