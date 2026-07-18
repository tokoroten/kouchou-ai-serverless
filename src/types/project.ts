import type { EndpointConfig } from "./settings";

// プロジェクトに保存する解決済みの実行設定
// (設定画面のプロバイダ構成が変わっても、実行中プロジェクトは影響を受けない)
export type ResolvedSettings = {
  chat: EndpointConfig;
  embedding: EndpointConfig;
  concurrency: number;
};

// 入力 CSV の1行(正規化済み)
export type CommentRow = {
  commentId: string;
  body: string;
  attributes: Record<string, string>; // 属性として選択された列
};

export type PipelineStepName =
  | "extraction"
  | "embedding"
  | "clustering"
  | "initial_labelling"
  | "merge_labelling"
  | "overview"
  | "aggregation";

export const PIPELINE_STEPS: PipelineStepName[] = [
  "extraction",
  "embedding",
  "clustering",
  "initial_labelling",
  "merge_labelling",
  "overview",
  "aggregation",
];

export type ProjectStatus = "created" | "running" | "paused" | "error" | "done";

// プロジェクトの所属モード。通常版と賛否スペクトラム分析はアルゴリズムが異なり、
// 相互にデータが見えると混乱するため、一覧を領域分けするための区分。
// 未設定(既存プロジェクト)は通常版とみなす。
export type ProjectKind = "normal" | "stance-spectrum";

export type Project = {
  id: string;
  /** 所属モード。省略時は "normal"(既存データ互換) */
  kind?: ProjectKind;
  title: string;
  question: string;
  intro: string;
  createdAt: number;
  comments: CommentRow[]; // 正規化済み入力データ
  attributeColumns: string[];
  settingsSnapshot: ResolvedSettings;
  clusterNums: number[]; // 空なら自動(cube-root)
  prompts: {
    extraction: string;
    initialLabelling: string;
    mergeLabelling: string;
    overview: string;
  };
  samplingNum: number; // ラベリング時のサンプリング数
  status: ProjectStatus;
  currentStep: PipelineStepName | null;
  reportId?: string;
  errorMessage?: string;
  tokenUsage: TokenUsage;
};

export type TokenUsage = {
  input: number;
  output: number;
  total: number;
};

// extraction の出力。賛否スペクトラム分析で構造化フィールド(stance 等)を追加できるよう
// 抽出結果の型はここに一元化する(INTERACTIVE_DESIGN_REVIEW「通常版との合流点」#1)。
export type ExtractedArgument = {
  argId: string; // "A{commentId}_{j}"
  argument: string;
  // 賛否スペクトラム分析拡張用の追加フィールド置き場。下流は argId / argument 以外に依存しない。
  extra?: Record<string, unknown>;
};

// comment-id ↔ arg-id の関係(aggregation で使用)
export type Relation = {
  argId: string;
  commentId: string;
};

export type ExtractionResult = {
  args: ExtractedArgument[];
  relations: Relation[];
};

export type EmbeddingResult = {
  argIds: string[];
  dim: number;
  // argIds と同順の埋め込み(フラット格納)。IndexedDB には TypedArray のまま保存する。
  vectors: Float32Array;
};

export type ClusteringResult = {
  argIds: string[];
  x: Float32Array;
  y: Float32Array;
  clusterNums: number[]; // 昇順
  // clusterNums と同順。各レベルの割当ラベル(0..n-1 の整数)。ID化は "{level}_{label}"
  assignments: Int32Array[];
};

export type ClusterLabel = {
  clusterId: string; // "{level}_{label}"
  label: string;
  description: string;
};

export type LabellingResult = {
  // レベル(1始まり)ごとの全クラスタのラベル
  byLevel: Record<number, ClusterLabel[]>;
};
