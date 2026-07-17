import seedrandom from "seedrandom";
import { UMAP } from "umap-js";

// 表示用レイアウト Worker: 本物の UMAP を「結合特徴の距離 + ウォームスタート」で回す。
//
// 発想(ユーザ提案 = 一次資料の combinedVector): 埋め込みに各ブロック(stance 等)を
// √weight でスケールして結合したベクトルの距離で UMAP する。
//   d² = Σ wᵦ·dᵦ² = (Σwᵦ)·(1 − 加重平均類似度)
// 候補辺には各ブロックの類似度が保存済みなので、メインスレッドで計算した
// 加重平均類似度(weights)から結合距離を復元し、公開 API setPrecomputedKNN で
// UMAP に渡す。UMAP は正規の fuzzy simplicial set 構築から実行される。
// weight=0 のブロックは距離に寄与しない = 分離に使われない。
//
// ウォームスタート: initializeOptimization() は embedding を参照で保持するため、
// initializeFit() 後に embedding の中身を現在座標へ書き換えれば続きから最適化される
// (Python 版 UMAP の init=array 相当)。

type UmapInternals = {
  embedding: number[][];
  optimizationState: { currentEpoch: number };
  getNEpochs: () => number;
  step: () => number;
};

export type LayoutWorkerRequest =
  | { type: "init"; x: Float32Array; y: Float32Array }
  | { type: "edges"; source: Int32Array; target: Int32Array; weights: Float32Array; threshold: number }
  | { type: "stanceAxis"; enabled: boolean; scores: Float32Array | null; lambda: number }
  | { type: "stop" };

export type LayoutWorkerResponse = { type: "coords"; x: Float32Array; y: Float32Array; alpha: number };

const KNN_K = 15;
const TICK_MS = 33; // ~30fps
const STEPS_PER_TICK = 3;

let coordsX: Float32Array = new Float32Array(0);
let coordsY: Float32Array = new Float32Array(0);
let umap: UmapInternals | null = null;
let nEpochs = 0;
// 表示の安定化: UMAP はセンタリングを持たず質量が漂流・スケールも変動するため、
// 出力座標を「初期レイアウトの重心と RMS 半径」に正規化する(最適化には触れない)
let targetRms = 10;
let stanceEnabled = false;
let stanceScores: Float32Array | null = null;
let stanceLambda = 0.15;
let timer: ReturnType<typeof setInterval> | null = null;

/** 候補辺の結合類似度から kNN を作り、UMAP を組み立てて現在座標でウォームスタートする */
function rebuildOptimizer(source: Int32Array, target: Int32Array, weights: Float32Array, threshold: number): void {
  const n = coordsX.length;
  if (n === 0) return;

  // 隣接リスト(しきい値以下の辺は使わない)
  const neighbors: { j: number; d: number }[][] = Array.from({ length: n }, () => []);
  let usable = 0;
  for (let e = 0; e < source.length; e++) {
    const w = weights[e];
    if (w <= threshold) continue;
    // 結合ベクトルの距離: d = sqrt(1 - 加重平均類似度)(単調変換。スケールは UMAP が局所正規化する)
    const d = Math.sqrt(Math.max(0, 1 - w));
    neighbors[source[e]].push({ j: target[e], d });
    neighbors[target[e]].push({ j: source[e], d });
    usable++;
  }
  if (usable === 0) return; // 辺が無ければ現状維持

  // 各点の kNN(自分自身を先頭に、結合距離の近い順)。UMAP は矩形配列を要求するため self でパディング
  const knnIndices: number[][] = new Array(n);
  const knnDistances: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    neighbors[i].sort((a, b) => a.d - b.d);
    const indices = [i];
    const distances = [0];
    for (let k = 0; k < Math.min(KNN_K - 1, neighbors[i].length); k++) {
      indices.push(neighbors[i][k].j);
      distances.push(neighbors[i][k].d);
    }
    while (indices.length < KNN_K) {
      indices.push(i);
      distances.push(0);
    }
    knnIndices[i] = indices;
    knnDistances[i] = distances;
  }

  const rng = seedrandom("phase2-layout");
  const instance = new UMAP({
    nComponents: 2,
    nNeighbors: KNN_K,
    minDist: 0.15,
    spread: 1.5,
    random: () => rng(),
  });
  instance.setPrecomputedKNN(knnIndices, knnDistances);
  // X は kNN が事前計算済みのため参照されない(次元1のダミー)
  const dummyX = Array.from({ length: n }, () => [0]);
  nEpochs = instance.initializeFit(dummyX);

  // ウォームスタート: embedding の中身を現在座標へ書き換える(参照は維持される)
  const internals = instance as unknown as UmapInternals;
  const embedding = internals.embedding;
  for (let i = 0; i < n; i++) {
    embedding[i][0] = coordsX[i];
    embedding[i][1] = coordsY[i];
  }
  umap = internals;
  if (!timer) timer = setInterval(tick, TICK_MS);
}

function tick(): void {
  if (!umap) return;
  const state = umap.optimizationState;
  if (state.currentEpoch >= nEpochs) return; // 収束済み(次の edges 更新まで待機)

  for (let s = 0; s < STEPS_PER_TICK && state.currentEpoch < nEpochs; s++) {
    umap.step();
  }

  const embedding = umap.embedding;
  const n = embedding.length;

  // 重心と RMS 半径を計算し、表示座標を初期スケールへ正規化する
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += embedding[i][0];
    cy += embedding[i][1];
  }
  cx /= n;
  cy /= n;
  let rms = 0;
  for (let i = 0; i < n; i++) {
    const dx = embedding[i][0] - cx;
    const dy = embedding[i][1] - cy;
    rms += dx * dx + dy * dy;
  }
  rms = Math.sqrt(rms / n) || 1;
  const scale = targetRms / rms;

  for (let i = 0; i < n; i++) {
    // stance 軸ナッジ(埋め込み空間で実施。ターゲットも埋め込みスケールに合わせる)
    if (stanceEnabled && stanceScores) {
      const targetX = cx + stanceScores[i] * rms * 1.5;
      embedding[i][0] += stanceLambda * (targetX - embedding[i][0]);
    }
    coordsX[i] = (embedding[i][0] - cx) * scale;
    coordsY[i] = (embedding[i][1] - cy) * scale;
  }
  const alpha = 1 - state.currentEpoch / Math.max(1, nEpochs);
  self.postMessage({ type: "coords", x: coordsX.slice(), y: coordsY.slice(), alpha } satisfies LayoutWorkerResponse);
}

self.onmessage = (event: MessageEvent<LayoutWorkerRequest>) => {
  const message = event.data;
  switch (message.type) {
    case "init": {
      coordsX = message.x.slice();
      coordsY = message.y.slice();
      umap = null;
      // 初期レイアウトの RMS 半径を表示スケールの基準にする
      const n = coordsX.length;
      if (n > 0) {
        let cx = 0;
        let cy = 0;
        for (let i = 0; i < n; i++) {
          cx += coordsX[i];
          cy += coordsY[i];
        }
        cx /= n;
        cy /= n;
        let rms = 0;
        for (let i = 0; i < n; i++) {
          const dx = coordsX[i] - cx;
          const dy = coordsY[i] - cy;
          rms += dx * dx + dy * dy;
        }
        targetRms = Math.sqrt(rms / n) || 10;
      }
      break;
    }
    case "edges":
      rebuildOptimizer(message.source, message.target, message.weights, message.threshold);
      break;
    case "stanceAxis":
      stanceEnabled = message.enabled;
      stanceScores = message.scores;
      stanceLambda = message.lambda;
      // 軸の切替だけでも再加熱する(現在座標から数エポック再最適化)
      if (umap) {
        umap.optimizationState.currentEpoch = Math.min(umap.optimizationState.currentEpoch, Math.floor(nEpochs * 0.7));
      }
      break;
    case "stop":
      if (timer) clearInterval(timer);
      timer = null;
      break;
  }
};
