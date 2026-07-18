import Delaunator from "delaunator";
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
  | { type: "computeLinkage" }
  | { type: "stop" };

export type LayoutWorkerResponse =
  | { type: "coords"; x: Float32Array; y: Float32Array; alpha: number }
  // 収束時(または computeLinkage 要求時)に、2D 座標の連結制約付き Ward 凝集の
  // 併合列(コスト昇順の (rootA, rootB) ペア)を返す。main 側で K 本カットする。
  | { type: "linkage"; a: Int32Array; b: Int32Array; n: number };

const KNN_K = 15;
const TICK_MS = 33; // ~30fps
const STEPS_PER_TICK = 3;

// 焼きなましの強さ。umap-js の学習率は alpha = learningRate * (1 - epoch/nEpochs) で減衰する。
//
// COLD: 初回のレイアウト。初期座標は「素の埋め込み距離」の UMAP 結果で、ここから
//   「結合特徴距離」の空間へ移す必要があるため、通常どおり全力で焼きなます。
// WARM: スライダー操作など、既にこの空間でレイアウト済みの状態からの再計算。
//   ここで COLD と同じ設定で回すと、ウォームスタートで渡した現在座標が最適化に
//   完全に上書きされ、連続的な遷移にならない(開始配置の保持率がほぼ 0 になる)。
//   学習率を落として短く回すことで、現在の配置を保ったまま重みの変化分だけ動かす。
const COLD_ANNEAL = { nEpochs: 500, learningRate: 1.0 };
const WARM_ANNEAL = { nEpochs: 100, learningRate: 0.2 };
// init 直後は COLD、一度レイアウトを組んだ後は WARM を使う
let hasLaidOut = false;

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
// 収束時に連結列を1回だけ送るためのフラグ(再加熱のたびにリセット)
let linkagePosted = false;

/**
 * 現在の 2D 座標に対する連結制約付き Ward 凝集の併合列を計算する。
 * 隣接はドロネー三角形分割(delaunator, O(n log n)。退化時は空間順の鎖)で与え、
 * 隣接クラスタ対のみを Ward コスト(= sA·sB/(sA+sB)·|重心差|²)で貪欲に併合する。
 * 返り値 (a[k], b[k]) は k 回目に併合した2クラスタの代表点(その時点のルート)。
 * main 側は先頭 n-K 回を再生すれば K クラスタになる(cutWardToK)。
 */
function computeWardLinkage(): { a: Int32Array; b: Int32Array } | null {
  const n = coordsX.length;
  if (n < 1) return null;
  if (n === 1) return { a: new Int32Array(0), b: new Int32Array(0) };

  // --- 隣接グラフ ---
  const neighbor: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  const addAdj = (p: number, q: number) => {
    if (p !== q) {
      neighbor[p].add(q);
      neighbor[q].add(p);
    }
  };
  let edgeCount = 0;
  if (n >= 3) {
    const flat = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      flat[2 * i] = coordsX[i];
      flat[2 * i + 1] = coordsY[i];
    }
    const d = new Delaunator(flat);
    const tri = d.triangles;
    const half = d.halfedges;
    for (let e = 0; e < tri.length; e++) {
      if (e > half[e]) {
        addAdj(tri[e], tri[e % 3 === 2 ? e - 2 : e + 1]);
        edgeCount++;
      }
    }
  }
  if (edgeCount < n - 1) {
    // 退化(共線/重複)フォールバック: 空間順(x,y)で鎖状に連結する
    const ord = Array.from({ length: n }, (_, i) => i).sort(
      (i, j) => coordsX[i] - coordsX[j] || coordsY[i] - coordsY[j],
    );
    for (let i = 1; i < n; i++) addAdj(ord[i - 1], ord[i]);
  }

  // --- クラスタ状態 ---
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    let c = x;
    while (parent[c] !== r) {
      const nx = parent[c];
      parent[c] = r;
      c = nx;
    }
    return r;
  };
  const size = new Float64Array(n).fill(1);
  const cx = Float64Array.from(coordsX);
  const cy = Float64Array.from(coordsY);
  const version = new Int32Array(n); // ルートの世代(併合で++。古いヒープ項の無効化に使う)
  const wardCost = (a: number, b: number): number => {
    const s = size[a] + size[b];
    const dx = cx[a] - cx[b];
    const dy = cy[a] - cy[b];
    return ((size[a] * size[b]) / s) * (dx * dx + dy * dy);
  };

  // --- lazy binary min-heap ---
  type HE = { c: number; a: number; av: number; b: number; bv: number };
  const heap: HE[] = [];
  const hpush = (e: HE) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].c <= heap[i].c) break;
      const t = heap[p];
      heap[p] = heap[i];
      heap[i] = t;
      i = p;
    }
  };
  const hpop = (): HE | null => {
    if (heap.length === 0) return null;
    const top = heap[0];
    const last = heap.pop() as HE;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      const N = heap.length;
      for (;;) {
        let s = i;
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        if (l < N && heap[l].c < heap[s].c) s = l;
        if (r < N && heap[r].c < heap[s].c) s = r;
        if (s === i) break;
        const t = heap[s];
        heap[s] = heap[i];
        heap[i] = t;
        i = s;
      }
    }
    return top;
  };

  for (let i = 0; i < n; i++) {
    for (const j of neighbor[i]) if (i < j) hpush({ c: wardCost(i, j), a: i, av: 0, b: j, bv: 0 });
  }

  const mergeA: number[] = [];
  const mergeB: number[] = [];
  let e = hpop();
  while (e !== null) {
    const ra = find(e.a);
    const rb = find(e.b);
    // 片方が併合済み / どちらかの世代が変わっていれば古い項なのでスキップ
    if (ra !== rb && ra === e.a && rb === e.b && version[e.a] === e.av && version[e.b] === e.bv) {
      const s = size[ra] + size[rb];
      cx[ra] = (cx[ra] * size[ra] + cx[rb] * size[rb]) / s;
      cy[ra] = (cy[ra] * size[ra] + cy[rb] * size[rb]) / s;
      size[ra] = s;
      parent[rb] = ra;
      version[ra]++;
      mergeA.push(ra);
      mergeB.push(rb);
      for (const nbRaw of neighbor[rb]) {
        const nb = find(nbRaw);
        if (nb === ra) continue;
        neighbor[ra].add(nb);
        neighbor[nb].add(ra);
      }
      const seen = new Set<number>();
      for (const nbRaw of neighbor[ra]) {
        const nb = find(nbRaw);
        if (nb === ra || seen.has(nb)) continue;
        seen.add(nb);
        hpush({ c: wardCost(ra, nb), a: ra, av: version[ra], b: nb, bv: version[nb] });
      }
    }
    e = hpop();
  }
  return { a: Int32Array.from(mergeA), b: Int32Array.from(mergeB) };
}

function postLinkage(): void {
  const lk = computeWardLinkage();
  if (!lk) return;
  self.postMessage({ type: "linkage", a: lk.a, b: lk.b, n: coordsX.length } satisfies LayoutWorkerResponse, [
    lk.a.buffer,
    lk.b.buffer,
  ]);
}

/** 候補辺の結合類似度から kNN を作り、UMAP を組み立てて現在座標でウォームスタートする */
function rebuildOptimizer(source: Int32Array, target: Int32Array, weights: Float32Array, threshold: number): void {
  const n = coordsX.length;
  if (n === 0) return;
  linkagePosted = false; // 再加熱するので収束時に新しい連結列を送り直す

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
  if (usable === 0) {
    // 有効辺なし: レイアウトは動かないので現在座標で1回だけ連結列を送る(でないとクラスタが出ない)
    postLinkage();
    linkagePosted = true;
    return;
  }

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

  // 辺の重みが変わると kNN が変わるためインスタンスは作り直すしかないが、
  // 2回目以降は弱く短く焼きなますことでウォームスタートの効果を残す
  const anneal = hasLaidOut ? WARM_ANNEAL : COLD_ANNEAL;
  const rng = seedrandom("phase2-layout");
  const instance = new UMAP({
    nComponents: 2,
    nNeighbors: KNN_K,
    minDist: 0.15,
    spread: 1.5,
    nEpochs: anneal.nEpochs,
    learningRate: anneal.learningRate,
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
  hasLaidOut = true;
  if (!timer) timer = setInterval(tick, TICK_MS);
}

function tick(): void {
  if (!umap) return;
  const state = umap.optimizationState;
  if (state.currentEpoch >= nEpochs) {
    // 収束済み: 連結列を1回だけ送る(以後は次の edges 更新まで待機)
    if (!linkagePosted) {
      postLinkage();
      linkagePosted = true;
    }
    return;
  }

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
      linkagePosted = false;
      // 新しいデータ/スコープなので、次の edges は COLD で焼き直す
      hasLaidOut = false;
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
        linkagePosted = false;
      }
      break;
    case "computeLinkage":
      // 手動要求: 現在の座標から即 連結列を送る(linkagePosted は立てない ⇒ 収束時に最終版を再送)
      postLinkage();
      break;
    case "stop":
      if (timer) clearInterval(timer);
      timer = null;
      break;
  }
};
