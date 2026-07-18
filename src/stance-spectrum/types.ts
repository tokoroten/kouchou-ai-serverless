// 賛否スペクトラム分析(賛否スペクトラム分析)のドメイン型。
// 一次資料 docs/INTERACTIVE_DESIGN_MEMO.md の OpinionRecord を基に、
// docs/INTERACTIVE_DESIGN_REVIEW.md の修正(5分類への縮退を許すスキーマ等)を反映。

/** stance の順序付き7分類 + unknown。順序は反対(左)→賛成(右) */
export const STANCE_KEYS = [
  "explicitOpposition",
  "conditionalOpposition",
  "nonSupport",
  "neutralOrDefer",
  "nonOpposition",
  "conditionalSupport",
  "explicitSupport",
] as const;

export type StanceKey = (typeof STANCE_KEYS)[number];

/** UI 補助用の stance スコア(-1〜+1)。クラスタリングには分布全体を使う */
export const STANCE_SCORE: Record<StanceKey, number> = {
  explicitOpposition: -1.0,
  conditionalOpposition: -0.6,
  nonSupport: -0.2,
  neutralOrDefer: 0.0,
  nonOpposition: 0.2,
  conditionalSupport: 0.6,
  explicitSupport: 1.0,
};

/** 7分類の確率分布 + unknown(順序軸に乗らないため分離) */
export type StanceDistribution = Record<StanceKey, number> & { unknown: number };

export type WeightedTag = {
  label: string;
  weight: number; // 0..1
};

/** LLM 構造化抽出の出力(1主張ぶん) */
export type OpinionEnrichment = {
  target: string | null;
  topics: WeightedTag[];
  stance: StanceDistribution;
  reasons: WeightedTag[];
  conditions: string[];
  holder: string | null; // "筆者" 以外なら他者
  quotedSpeech: boolean;
  commitment: number; // 0..1 断定の強さ
  confidence: number; // 0..1 解析の確信度
};

/** 賛否スペクトラム分析で扱う意見レコード。通常版の ExtractedArgument + 埋め込み + 構造化属性 */
export type OpinionRecord = {
  id: string; // argId
  originalCommentId: string;
  claimText: string; // 通常版の argument と同一物
  enrichment: OpinionEnrichment;
  /** コードブックに対する疎なタグベクトル(codebook のインデックス → 重み) */
  topicVector: Map<number, number>;
  reasonVector: Map<number, number>;
  /** 元コメントの属性(年齢・性別・職業など)。属性軸での分離・色分けに使う */
  attributes?: Record<string, string>;
};

/** 2パス方式で確定するタグのコードブック */
export type Codebook = {
  topics: string[];
  reasons: string[];
  /** 自由生成タグ(正規化済み) → コードブックインデックス */
  topicIndex: Record<string, number>;
  reasonIndex: Record<string, number>;
};

/** 候補kNNグラフの辺。ブロック別類似度を保存し、スライダーでは重みのみ再計算する */
export type CandidateEdge = {
  source: number; // OpinionRecord 配列のインデックス
  target: number;
  semanticSimilarity: number;
  topicSimilarity: number;
  stanceSimilarity: number;
  reasonSimilarity: number;
};

/** ビュー定義(クラスタIDではなく重みと条件を保存する) */
export type ClusterView = {
  name: string;
  semanticWeight: number;
  topicWeight: number;
  stanceWeight: number;
  reasonWeight: number;
  edgeThreshold: number;
  resolution: number;
  /** 目標クラスタ数(レイアウト収束時の連結制約付き Ward 樹形図をこの数で切る) */
  clusterK: number;
  stanceAxisEnabled: boolean;
  /** focus+context: 選択クラスタ内のみ stance/reason 重みを適用する(必須制約) */
  selectedClusterId: string | null;
  /** 属性軸: 数値属性は範囲正規化距離、カテゴリカルは上位K+δ一致で分離できる */
  attributeKey: string | null;
  /** 属性の分離強度(0 = 無効) */
  attributeWeight: number;
};

export const DEFAULT_VIEW: ClusterView = {
  name: "トピック別",
  semanticWeight: 1.0,
  topicWeight: 0.5,
  stanceWeight: 0.0,
  reasonWeight: 0.0,
  edgeThreshold: 0.25,
  resolution: 1.0,
  clusterK: 8,
  stanceAxisEnabled: false,
  selectedClusterId: null,
  attributeKey: null,
  attributeWeight: 0,
};

export function emptyStance(): StanceDistribution {
  return {
    explicitOpposition: 0,
    conditionalOpposition: 0,
    nonSupport: 0,
    neutralOrDefer: 0,
    nonOpposition: 0,
    conditionalSupport: 0,
    explicitSupport: 0,
    unknown: 1,
  };
}

/** 分布の argmax クラス(unknown 含む) */
export function dominantStance(stance: StanceDistribution): StanceKey | "unknown" {
  let best: StanceKey | "unknown" = "unknown";
  let bestValue = stance.unknown;
  for (const key of STANCE_KEYS) {
    if (stance[key] > bestValue) {
      best = key;
      bestValue = stance[key];
    }
  }
  return best;
}

/** UI 用 stance スコア(-1〜+1)。unknown 分は 0 に寄与 */
export function stanceScore(stance: StanceDistribution): number {
  let score = 0;
  for (const key of STANCE_KEYS) score += stance[key] * STANCE_SCORE[key];
  return score;
}
