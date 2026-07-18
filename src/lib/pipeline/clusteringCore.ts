import { agnes } from "ml-hclust";
import { kmeans } from "ml-kmeans";
import seedrandom from "seedrandom";
import { UMAP } from "umap-js";

// 本家 hierarchical_clustering.py の移植(React/DOM 非依存)。
// Web Worker (clustering.worker.ts) と Node デバッグの両方から使う。
// UMAP は step() で1反復ずつ進め、数反復ごとに中間座標をコールバックで流せる
// (進捗表示と賛否スペクトラム分析のインタラクティブモードの土台。DESIGN §6.3)。

export type UmapParams = {
  /** 既定: min(15, N-1)。局所構造(小)⇔大域構造(大) */
  nNeighbors?: number;
  /** 既定: 0.1。点の詰まり具合(小=密集、大=分散) */
  minDist?: number;
  /** 既定: 1.0。埋め込み全体のスケール */
  spread?: number;
  /** 既定: 0(自動)。UMAP の反復回数 */
  nEpochs?: number;
  /** 既定: 5。負例サンプリング率 */
  negativeSampleRate?: number;
  /** 既定: 1.0。反発の強さ */
  repulsionStrength?: number;
};

export type ClusteringInput = {
  vectors: Float32Array; // count × dim のフラット配列
  dim: number;
  count: number;
  clusterNums: number[]; // 昇順でなくてもよい(内部でソート)
  seed?: string;
  umap?: UmapParams;
};

export type ClusteringOutput = {
  x: Float32Array;
  y: Float32Array;
  clusterNums: number[]; // 昇順
  assignments: Int32Array[]; // clusterNums と同順。各点のクラスタラベル
};

export type ClusteringCallbacks = {
  /** UMAP の進捗。coords は数反復ごとにのみ渡る(それ以外は undefined) */
  onUmapProgress?: (epoch: number, totalEpochs: number, coords?: { x: Float32Array; y: Float32Array }) => void;
  onPhase?: (phase: "umap" | "kmeans" | "ward") => void;
  shouldAbort?: () => boolean;
};

const COORDS_EVERY_N_EPOCHS = 10;

export function runClusteringCore(input: ClusteringInput, callbacks: ClusteringCallbacks = {}): ClusteringOutput {
  const { dim, count } = input;
  const data: number[][] = new Array(count);
  for (let i = 0; i < count; i++) {
    const row = new Array<number>(dim);
    for (let d = 0; d < dim; d++) row[d] = input.vectors[i * dim + d];
    data[i] = row;
  }

  const clusterNums = [...new Set(input.clusterNums)].sort((a, b) => a - b);
  const maxClusterNum = clusterNums[clusterNums.length - 1];
  if (count < 2) throw new Error("クラスタリングには2件以上の意見が必要です");
  if (maxClusterNum > count) throw new Error(`クラスタ数 ${maxClusterNum} がデータ件数 ${count} を超えています`);

  // ---- UMAP (本家: n_components=2, n_neighbors=min(15, N-1), 最低2) ----
  callbacks.onPhase?.("umap");
  const rng = seedrandom(input.seed ?? "kouchou-ai");
  const params = input.umap ?? {};
  const requestedNeighbors = params.nNeighbors ?? 15;
  const nNeighbors = Math.max(2, Math.min(requestedNeighbors, count - 1));
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors,
    random: () => rng(),
    ...(params.minDist !== undefined ? { minDist: params.minDist } : {}),
    ...(params.spread !== undefined ? { spread: params.spread } : {}),
    ...(params.nEpochs ? { nEpochs: params.nEpochs } : {}),
    ...(params.negativeSampleRate !== undefined ? { negativeSampleRate: params.negativeSampleRate } : {}),
    ...(params.repulsionStrength !== undefined ? { repulsionStrength: params.repulsionStrength } : {}),
  });
  const totalEpochs = umap.initializeFit(data);
  for (let epoch = 0; epoch < totalEpochs; epoch++) {
    if (callbacks.shouldAbort?.()) throw new DOMException("Aborted", "AbortError");
    umap.step();
    if (callbacks.onUmapProgress) {
      const sendCoords = epoch % COORDS_EVERY_N_EPOCHS === 0 || epoch === totalEpochs - 1;
      callbacks.onUmapProgress(epoch + 1, totalEpochs, sendCoords ? embeddingToXY(umap.getEmbedding()) : undefined);
    }
  }
  const embedded = umap.getEmbedding();
  const { x, y } = embeddingToXY(embedded);

  const { assignments } = clusterXY(embedded, clusterNums, input.seed ?? "kouchou-ai", callbacks);
  return { x, y, clusterNums, assignments };
}

/**
 * 2次元座標に対する KMeans + ward(本家の手順のうち UMAP 以降)。
 * 数千点なら数十ms で終わるため、リアルタイムモードのクラスタ数変更にも直接使える。
 */
export function clusterXY(
  embedded: number[][],
  clusterNumsInput: number[],
  seed: string,
  callbacks: ClusteringCallbacks = {},
): { clusterNums: number[]; assignments: Int32Array[] } {
  const clusterNums = [...new Set(clusterNumsInput)].sort((a, b) => a - b);
  const maxClusterNum = clusterNums[clusterNums.length - 1];

  // ---- KMeans: 最大クラスタ数で1回だけ実行 ----
  callbacks.onPhase?.("kmeans");
  const seedNum = hashToNumber(seed);
  const kmeansResult = kmeans(embedded, maxClusterNum, { seed: seedNum, initialization: "kmeans++" });
  const kmeansLabels = Int32Array.from(kmeansResult.clusters);
  const centroids: number[][] = kmeansResult.centroids;

  // ---- 上位レベル: KMeans 重心に ward を適用し group(n) でカット ----
  callbacks.onPhase?.("ward");
  const assignments: Int32Array[] = [];
  for (const n of clusterNums.slice(0, -1)) {
    assignments.push(mergeClustersWithHierarchy(centroids, kmeansLabels, n));
  }
  assignments.push(kmeansLabels);
  return { clusterNums, assignments };
}

/**
 * 本家 merge_clusters_with_hierarchy の移植:
 * 重心の ward 木を n_cluster_cut 個にカットし、各点は自分の重心のマージ先ラベルを継承する。
 * ラベルは scipy fcluster に合わせて 1 始まり。
 */
export function mergeClustersWithHierarchy(
  centroids: number[][],
  kmeansLabels: Int32Array,
  nClusterCut: number,
): Int32Array {
  const tree = agnes(centroids, { method: "ward" });
  const grouped = tree.group(nClusterCut);
  // centroid index -> merged cluster label (1..n)
  const centroidToMerged = new Int32Array(centroids.length);
  grouped.children.forEach((group, groupIndex) => {
    for (const leafIndex of collectIndices(group)) {
      centroidToMerged[leafIndex] = groupIndex + 1;
    }
  });
  const finalLabels = new Int32Array(kmeansLabels.length);
  for (let i = 0; i < kmeansLabels.length; i++) {
    finalLabels[i] = centroidToMerged[kmeansLabels[i]];
  }
  return finalLabels;
}

/** group() の結果がリーフ単体のこともあるため indices() を安全に集める */
function collectIndices(cluster: { isLeaf: boolean; index: number; indices: () => number[] }): number[] {
  if (cluster.isLeaf) return [cluster.index];
  return cluster.indices();
}

function embeddingToXY(embedding: number[][]): { x: Float32Array; y: Float32Array } {
  const x = new Float32Array(embedding.length);
  const y = new Float32Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) {
    x[i] = embedding[i][0];
    y[i] = embedding[i][1];
  }
  return { x, y };
}

function hashToNumber(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
