import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import seedrandom from "seedrandom";
import { sparseCosine, stanceSimilarity } from "./similarity";
import type { ClusterView, OpinionRecord } from "./types";

// 候補kNNグラフ(一次資料 + レビュー必須修正 §2)。
// 候補集合 = semantic kNN ∪ 同一 topic 点のサンプル ∪ stance 分布近傍 ∪ reason タグ一致。
// どの重み設定でも真の近傍がほぼ候補内にあることを担保する。
// スライダー操作時は候補辺の最終重みだけを再計算する(全点間距離の再計算はしない)。
// 辺は SoA(typed array)で保持し、Worker 間を transferable で移動・IndexedDB にそのまま保存する。

export type EdgeSet = {
  count: number;
  source: Int32Array;
  target: Int32Array;
  semantic: Float32Array;
  topic: Float32Array;
  stance: Float32Array;
  reason: Float32Array;
};

export type BuildGraphOptions = {
  semanticK?: number; // 既定 40
  stanceK?: number; // 既定 10
  topicSamples?: number; // 既定 10
  reasonSamples?: number; // 既定 10
  seed?: string;
  onProgress?: (done: number, total: number, phase: string) => void;
  shouldAbort?: () => boolean;
};

export function buildCandidateEdges(
  records: OpinionRecord[],
  vectors: Float32Array,
  dim: number,
  options: BuildGraphOptions = {},
): EdgeSet {
  const n = records.length;
  const semanticK = options.semanticK ?? 40;
  const stanceK = options.stanceK ?? 10;
  const topicSamples = options.topicSamples ?? 10;
  const reasonSamples = options.reasonSamples ?? 10;
  const rng = seedrandom(options.seed ?? "phase2");

  // 辺集合(i<j の組をキーに重複排除)
  const pairs = new Set<number>();
  const addPair = (i: number, j: number) => {
    if (i === j) return;
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    pairs.add(a * n + b);
  };

  // ---- 1. semantic kNN(総当たり。Worker 内で実行し進捗を出す) ----
  // 正規化済みベクトルを前計算して内積のみで比較する
  const normalized = new Float32Array(n * dim);
  for (let i = 0; i < n; i++) {
    let norm = 0;
    for (let d = 0; d < dim; d++) {
      const v = vectors[i * dim + d];
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d++) normalized[i * dim + d] = vectors[i * dim + d] / norm;
  }
  const sims = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (options.shouldAbort?.()) throw new DOMException("Aborted", "AbortError");
    for (let j = 0; j < n; j++) {
      let dot = 0;
      const oi = i * dim;
      const oj = j * dim;
      for (let d = 0; d < dim; d++) dot += normalized[oi + d] * normalized[oj + d];
      sims[j] = dot;
    }
    sims[i] = Number.NEGATIVE_INFINITY;
    for (const j of topKIndices(sims, semanticK)) addPair(i, j);
    if (i % 50 === 0) options.onProgress?.(i, n, "意味的近傍の計算");
  }
  options.onProgress?.(n, n, "意味的近傍の計算");

  // ---- 2. stance 分布近傍(7+1次元なので全点計算しても安い) ----
  const stanceSims = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (options.shouldAbort?.()) throw new DOMException("Aborted", "AbortError");
    for (let j = 0; j < n; j++) {
      stanceSims[j] =
        j === i
          ? Number.NEGATIVE_INFINITY
          : stanceSimilarity(records[i].enrichment.stance, records[j].enrichment.stance);
    }
    for (const j of topKIndices(stanceSims, stanceK)) addPair(i, j);
    if (i % 200 === 0) options.onProgress?.(i, n, "stance 近傍の計算");
  }

  // ---- 3. 同一 topic / 4. 同一 reason 点からのサンプル ----
  const byTopic = groupByTopTag(records, "topic");
  const byReason = groupByTopTag(records, "reason");
  for (let i = 0; i < n; i++) {
    sampleFromGroups(i, records[i].topicVector, byTopic, topicSamples, rng, addPair);
    sampleFromGroups(i, records[i].reasonVector, byReason, reasonSamples, rng, addPair);
  }

  // ---- 辺ごとのブロック別類似度を計算して SoA に保存 ----
  const count = pairs.size;
  const edges: EdgeSet = {
    count,
    source: new Int32Array(count),
    target: new Int32Array(count),
    semantic: new Float32Array(count),
    topic: new Float32Array(count),
    stance: new Float32Array(count),
    reason: new Float32Array(count),
  };
  let e = 0;
  for (const key of pairs) {
    const i = Math.floor(key / n);
    const j = key % n;
    edges.source[e] = i;
    edges.target[e] = j;
    // 正規化済みベクトルの内積 = コサイン類似度
    let dot = 0;
    const oi = i * dim;
    const oj = j * dim;
    for (let d = 0; d < dim; d++) dot += normalized[oi + d] * normalized[oj + d];
    edges.semantic[e] = dot;
    edges.topic[e] = sparseCosine(records[i].topicVector, records[j].topicVector);
    edges.stance[e] = stanceSimilarity(records[i].enrichment.stance, records[j].enrichment.stance);
    edges.reason[e] = sparseCosine(records[i].reasonVector, records[j].reasonVector);
    e++;
  }
  options.onProgress?.(n, n, "辺の類似度計算完了");
  return edges;
}

function topKIndices(scores: Float32Array, k: number): number[] {
  // 単純な部分選択(O(n·k))。k が小さいので十分速い
  const indices: number[] = [];
  const taken = new Set<number>();
  for (let round = 0; round < k; round++) {
    let best = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < scores.length; i++) {
      if (!taken.has(i) && scores[i] > bestScore) {
        best = i;
        bestScore = scores[i];
      }
    }
    if (best === -1 || bestScore === Number.NEGATIVE_INFINITY) break;
    taken.add(best);
    indices.push(best);
  }
  return indices;
}

function groupByTopTag(records: OpinionRecord[], kind: "topic" | "reason"): Map<number, number[]> {
  const groups = new Map<number, number[]>();
  records.forEach((record, i) => {
    const vector = kind === "topic" ? record.topicVector : record.reasonVector;
    let top = -1;
    let topWeight = 0;
    for (const [index, weight] of vector) {
      if (weight > topWeight) {
        top = index;
        topWeight = weight;
      }
    }
    if (top >= 0) {
      const list = groups.get(top) ?? [];
      list.push(i);
      groups.set(top, list);
    }
  });
  return groups;
}

function sampleFromGroups(
  i: number,
  vector: Map<number, number>,
  groups: Map<number, number[]>,
  count: number,
  rng: () => number,
  addPair: (a: number, b: number) => void,
): void {
  let top = -1;
  let topWeight = 0;
  for (const [index, weight] of vector) {
    if (weight > topWeight) {
      top = index;
      topWeight = weight;
    }
  }
  if (top < 0) return;
  const members = groups.get(top);
  if (!members || members.length <= 1) return;
  for (let s = 0; s < count; s++) {
    const j = members[Math.floor(rng() * members.length)];
    addPair(i, j);
  }
}

// ---- 辺の重み再計算(スライダー操作時はここだけが走る) ----

/**
 * ビュー定義から辺の最終重みを計算する。
 * レビュー必須修正 §3: stance/reason の重みはトピック条件付きでのみ有効
 * (topicGate。無関係トピック同士を賛否で混ぜない)。
 * focus+context: selectedClusterId 指定時、stance/reason は選択クラスタ内の辺のみに適用する。
 */
export function computeEdgeWeights(
  edges: EdgeSet,
  view: ClusterView,
  membership: (string | null)[] | null,
  /** 属性軸の辺類似度(attributes.computeAttributeSimilarities の結果)。無ければ null */
  attributeSims: Float32Array | null = null,
  /** トピック絞り込み済み(ドリルダウン)のとき true: 構成上トピック条件が満たされているため
   * stance/reason をゲートなしで全辺に適用できる */
  topicConditioned = false,
): Float32Array {
  const weights = new Float32Array(edges.count);
  const focus = view.selectedClusterId;
  const attrWeight = attributeSims ? view.attributeWeight : 0;
  for (let e = 0; e < edges.count; e++) {
    const source = edges.source[e];
    const target = edges.target[e];
    const inFocus =
      topicConditioned ||
      focus === null ||
      (membership !== null && membership[source] === focus && membership[target] === focus);
    let w = view.semanticWeight * edges.semantic[e] + view.topicWeight * edges.topic[e];
    let totalWeight = view.semanticWeight + view.topicWeight;
    if (attrWeight > 0 && attributeSims) {
      // 属性(年齢層・職業など)は人口統計的な分離なのでグローバルに適用してよい
      w += attrWeight * attributeSims[e];
      totalWeight += attrWeight;
    }
    if (inFocus && (view.stanceWeight > 0 || view.reasonWeight > 0)) {
      // トピック絞り込み中 or クラスタ明示選択中はトピック条件が満たされているためゲート=1。
      // 非選択(グローバル)の場合のみトピック類似度でゲートし、無関係トピックを賛否で混ぜない。
      const gate = topicConditioned || focus !== null ? 1 : Math.max(edges.topic[e], edges.semantic[e] * 0.5);
      w += gate * (view.stanceWeight * edges.stance[e] + view.reasonWeight * edges.reason[e]);
      // 分母もゲート後の実効重みで正規化する(過剰な希釈を防ぐ)
      totalWeight += gate * (view.stanceWeight + view.reasonWeight);
    }
    weights[e] = totalWeight > 0 ? Math.max(0, w / totalWeight) : 0;
  }
  return weights;
}

/** トピック絞り込み(ドリルダウン)用: 部分集合に含まれる辺だけを抜き出し、インデックスを振り直す */
export function subsetEdges(edges: EdgeSet, indices: number[]): EdgeSet {
  const remap = new Map<number, number>();
  indices.forEach((original, local) => {
    remap.set(original, local);
  });
  const keep: number[] = [];
  for (let e = 0; e < edges.count; e++) {
    if (remap.has(edges.source[e]) && remap.has(edges.target[e])) keep.push(e);
  }
  const sub: EdgeSet = {
    count: keep.length,
    source: new Int32Array(keep.length),
    target: new Int32Array(keep.length),
    semantic: new Float32Array(keep.length),
    topic: new Float32Array(keep.length),
    stance: new Float32Array(keep.length),
    reason: new Float32Array(keep.length),
  };
  keep.forEach((e, i) => {
    sub.source[i] = remap.get(edges.source[e]) as number;
    sub.target[i] = remap.get(edges.target[e]) as number;
    sub.semantic[i] = edges.semantic[e];
    sub.topic[i] = edges.topic[e];
    sub.stance[i] = edges.stance[e];
    sub.reason[i] = edges.reason[e];
  });
  return sub;
}

// ---- クラスタリング(Louvain。2次元座標ではなく重み付きグラフから決める) ----

export function clusterByLouvain(
  n: number,
  edges: EdgeSet,
  weights: Float32Array,
  view: ClusterView,
  membership: (string | null)[] | null,
): Int32Array {
  const graph = new Graph({ type: "undirected", multi: false });
  const focus = view.selectedClusterId;
  // focus+context: 選択クラスタ内のみ再クラスタリング。他はそのまま(呼び出し側で frozen 扱い)
  const inScope = (i: number) => focus === null || (membership !== null && membership[i] === focus);
  for (let i = 0; i < n; i++) {
    if (inScope(i)) graph.addNode(i);
  }
  for (let e = 0; e < edges.count; e++) {
    const source = edges.source[e];
    const target = edges.target[e];
    const weight = weights[e];
    if (weight <= view.edgeThreshold) continue;
    if (!inScope(source) || !inScope(target)) continue;
    if (graph.hasEdge(source, target)) continue;
    graph.addEdge(source, target, { weight });
  }
  const communities = new Int32Array(n).fill(-1);
  if (graph.order > 0 && graph.size > 0) {
    const mapping = louvain(graph, { resolution: view.resolution, getEdgeWeight: "weight" });
    for (const node of graph.nodes()) {
      communities[Number(node)] = mapping[node];
    }
  } else {
    for (const node of graph.nodes()) communities[Number(node)] = 0;
  }
  return communities;
}

/**
 * 現在の 2D レイアウト座標の近接グラフで Louvain を回し、「見た目どおり」にクラスタを切り直す。
 *
 * 通常のクラスタリングは候補辺グラフ(特徴の類似度)に対して行うため、UMAP が視覚的に
 * 複数の塊へ分離しても 1 コミュニティのまま残ることがある。このとき配置の近さから
 * 切り直すことで、目に見える分離とクラスタ色・ラベルを一致させる。
 * kNN はブルートフォース(想定規模 <1万点)、辺の重みはガウシアン(σ=kNN距離の中央値)。
 */
/**
 * Ward 凝集の併合列(コスト昇順の (rootA, rootB) ペア)から K クラスタを作る樹形図カット。
 * n 点を K クラスタにするには「安い方から n-K 回」併合すればよい(union-find で再生)。
 * 併合数が足りない(グラフが非連結で C 成分)場合は全併合を適用し C クラスタになる。
 * 返り値は各点のコミュニティ番号(0..)。
 */
export function cutWardToK(mergeA: Int32Array, mergeB: Int32Array, n: number, k: number): Int32Array {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    let cur = x;
    while (parent[cur] !== r) {
      const next = parent[cur];
      parent[cur] = r;
      cur = next;
    }
    return r;
  };
  const total = mergeA.length;
  const merges = Math.min(Math.max(0, n - k), total); // K クラスタにするための併合回数
  for (let m = 0; m < merges; m++) {
    const ra = find(mergeA[m]);
    const rb = find(mergeB[m]);
    if (ra !== rb) parent[rb] = ra;
  }
  // ルート → 0 始まりの連番ラベル
  const labelOf = new Map<number, number>();
  const out = new Int32Array(n);
  let next = 0;
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let lbl = labelOf.get(r);
    if (lbl === undefined) {
      lbl = next++;
      labelOf.set(r, lbl);
    }
    out[i] = lbl;
  }
  return out;
}

export function clusterByLayout(x: Float32Array, y: Float32Array, resolution: number, k = 8): Int32Array {
  const n = x.length;
  const communities = new Int32Array(n).fill(-1);
  if (n === 0) return communities;
  if (n <= k) return communities.fill(0);

  // 各点の kNN(挿入選択で上位 k 件のみ保持)
  const knn: { j: number; d: number }[][] = new Array(n);
  const allDists: number[] = [];
  for (let i = 0; i < n; i++) {
    const best: { j: number; d: number }[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = x[i] - x[j];
      const dy = y[i] - y[j];
      const d = dx * dx + dy * dy;
      if (best.length < k) {
        best.push({ j, d });
        if (best.length === k) best.sort((a, b) => a.d - b.d);
      } else if (d < best[k - 1].d) {
        best[k - 1] = { j, d };
        best.sort((a, b) => a.d - b.d);
      }
    }
    knn[i] = best;
    for (const { d } of best) allDists.push(d);
  }
  allDists.sort((a, b) => a - b);
  const sigma2 = Math.max(allDists[Math.floor(allDists.length / 2)], 1e-12);

  const graph = new Graph({ type: "undirected", multi: false });
  for (let i = 0; i < n; i++) graph.addNode(i);
  for (let i = 0; i < n; i++) {
    for (const { j, d } of knn[i]) {
      if (graph.hasEdge(i, j)) continue;
      graph.addEdge(i, j, { weight: Math.exp(-d / (2 * sigma2)) });
    }
  }
  const mapping = louvain(graph, { resolution, getEdgeWeight: "weight" });
  for (const node of graph.nodes()) {
    communities[Number(node)] = mapping[node];
  }
  return communities;
}
