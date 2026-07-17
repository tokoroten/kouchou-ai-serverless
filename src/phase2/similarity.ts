import type { StanceDistribution } from "./types";
import { STANCE_KEYS } from "./types";

// フェーズ2の類似度計算(一次資料「類似度と距離」+ レビューの置換表)。
// - stance: 順序付き7クラスなので累積分布の L1(=1次元 Wasserstein)を既定とする
// - topic/reason: コードブックに対する疎タグベクトルのコサイン類似度
// - semantic: 埋め込みのコサイン類似度

/** 累積分布の L1 距離(0..1 に正規化)から stance 類似度を返す。
 * unknown は順序軸に乗らないため、双方の unknown 差分をペナルティとして加える。 */
export function stanceSimilarity(a: StanceDistribution, b: StanceDistribution): number {
  // 7クラス部分を(unknown を除いて)正規化して比較する
  const na = normalizeKnown(a);
  const nb = normalizeKnown(b);
  let cumA = 0;
  let cumB = 0;
  let l1 = 0;
  for (const key of STANCE_KEYS) {
    cumA += na[key];
    cumB += nb[key];
    l1 += Math.abs(cumA - cumB);
  }
  // 累積L1の最大値は (クラス数-1) = 6
  const wasserstein = l1 / (STANCE_KEYS.length - 1);
  const unknownPenalty = Math.abs(a.unknown - b.unknown) * 0.5;
  return Math.max(0, 1 - wasserstein - unknownPenalty);
}

function normalizeKnown(stance: StanceDistribution): Record<string, number> {
  let sum = 0;
  for (const key of STANCE_KEYS) sum += stance[key];
  const result: Record<string, number> = {};
  for (const key of STANCE_KEYS) result[key] = sum > 0 ? stance[key] / sum : 1 / STANCE_KEYS.length;
  return result;
}

/** 疎タグベクトル(index → weight)のコサイン類似度 */
export function sparseCosine(a: Map<number, number>, b: Map<number, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [, w] of a) normA += w * w;
  for (const [, w] of b) normB += w * w;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [i, w] of small) {
    const v = large.get(i);
    if (v !== undefined) dot += w * v;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/** Float32Array 埋め込み(フラット格納)のコサイン類似度 */
export function denseCosine(vectors: Float32Array, dim: number, i: number, j: number): number {
  let dot = 0;
  let normI = 0;
  let normJ = 0;
  const offsetI = i * dim;
  const offsetJ = j * dim;
  for (let d = 0; d < dim; d++) {
    const a = vectors[offsetI + d];
    const b = vectors[offsetJ + d];
    dot += a * b;
    normI += a * a;
    normJ += b * b;
  }
  if (normI === 0 || normJ === 0) return 0;
  return dot / Math.sqrt(normI * normJ);
}
