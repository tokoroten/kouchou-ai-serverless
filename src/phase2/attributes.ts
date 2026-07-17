import type { EdgeSet } from "./graph";
import type { OpinionRecord } from "./types";

// 属性軸による分離(ユーザ要望)。
// - 数値属性(年齢・収入など): 範囲正規化した距離 → 類似度。分離強度スライダーで混ぜる
// - カテゴリカル属性(職業など): 上位Kカテゴリ+「その他」に潰した一致/不一致(δ)。
//   既定は色分けのみを推奨(0/1 距離は中間がなく断片化しやすいため)
// 属性類似度は辺ごとに O(E) で計算できるため、EdgeSet には保存せず選択時に都度計算する。

export type AttributeInfo = {
  key: string;
  type: "numeric" | "categorical";
  /** numeric のとき: 値の範囲 */
  range?: [number, number];
  /** categorical のとき: 上位カテゴリ(これ以外は「その他」) */
  topCategories?: string[];
  valueCounts: Map<string, number>;
};

const TOP_K_CATEGORIES = 8;

/** レコード群から属性のメタ情報(数値/カテゴリカル判定)を作る */
export function analyzeAttributes(records: OpinionRecord[]): AttributeInfo[] {
  const byKey = new Map<string, Map<string, number>>();
  for (const record of records) {
    if (!record.attributes) continue;
    for (const [key, raw] of Object.entries(record.attributes)) {
      const value = String(raw ?? "").trim();
      if (value === "") continue;
      const counts = byKey.get(key) ?? new Map<string, number>();
      counts.set(value, (counts.get(value) ?? 0) + 1);
      byKey.set(key, counts);
    }
  }
  const infos: AttributeInfo[] = [];
  for (const [key, counts] of byKey) {
    let numeric = true;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of counts.keys()) {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        numeric = false;
        break;
      }
      min = Math.min(min, n);
      max = Math.max(max, n);
    }
    if (numeric && counts.size > 1) {
      infos.push({ key, type: "numeric", range: [min, max], valueCounts: counts });
    } else {
      const topCategories = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_K_CATEGORIES)
        .map(([v]) => v);
      infos.push({ key, type: "categorical", topCategories, valueCounts: counts });
    }
  }
  return infos;
}

/**
 * 各レコードの属性値を数値化する。
 * numeric: 0..1 に正規化 / categorical: 上位Kカテゴリのインデックス(その他 = K, 欠損 = -1)
 */
export function encodeAttribute(records: OpinionRecord[], info: AttributeInfo): Float32Array {
  const encoded = new Float32Array(records.length).fill(-1);
  for (let i = 0; i < records.length; i++) {
    const raw = records[i].attributes?.[info.key];
    const value = raw === undefined ? "" : String(raw).trim();
    if (value === "") continue;
    if (info.type === "numeric" && info.range) {
      const [min, max] = info.range;
      const span = max - min || 1;
      encoded[i] = (Number(value) - min) / span;
    } else if (info.topCategories) {
      const index = info.topCategories.indexOf(value);
      encoded[i] = index >= 0 ? index : info.topCategories.length; // その他
    }
  }
  return encoded;
}

/**
 * 辺ごとの属性類似度を計算する。
 * numeric: 1 - |a-b|(正規化済み) / categorical: 一致=1, 不一致=0。欠損は中立 0.5。
 */
export function computeAttributeSimilarities(
  edges: EdgeSet,
  encoded: Float32Array,
  type: "numeric" | "categorical",
): Float32Array {
  const sims = new Float32Array(edges.count);
  for (let e = 0; e < edges.count; e++) {
    const a = encoded[edges.source[e]];
    const b = encoded[edges.target[e]];
    if (a < 0 || b < 0) {
      sims[e] = 0.5; // 欠損は中立
    } else if (type === "numeric") {
      sims[e] = 1 - Math.abs(a - b);
    } else {
      sims[e] = a === b ? 1 : 0;
    }
  }
  return sims;
}
