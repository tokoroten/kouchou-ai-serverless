// 本家 kouchou-ai の apps/public-viewer/type.ts 由来の型定義。
// 出力レポートはこの Result とスキーマ互換を維持する(docs/DESIGN.md §5.2)。

export type Result = {
  arguments: Argument[];
  clusters: Cluster[];
  comments: Comments;
  // biome-ignore lint/suspicious/noExplicitAny: 本家互換
  propertyMap: Record<string, any>;
  // biome-ignore lint/suspicious/noExplicitAny: 本家互換
  translations: Record<string, any>;
  overview: string;
  config: ResultConfig;
  comment_num: number;
};

export type Argument = {
  arg_id: string;
  argument: string;
  comment_id: number | string;
  x: number;
  y: number;
  p: number;
  cluster_ids: string[];
  attributes?: Record<string, string | number>;
  url?: string;
};

export type Cluster = {
  level: number;
  id: string;
  label: string;
  takeaway: string;
  value: number;
  parent: string; // ルートは空文字
  density_rank_percentile: number;
};

export type Comments = Record<string, { comment: string }>;

// 本家 Config 型に概ね準拠(埋められない項目は空文字でよい: DESIGN §5.2)
export type ResultConfig = {
  name: string;
  question: string;
  input: string;
  model: string;
  intro: string;
  output_dir: string;
  is_embedded_at_local: boolean;
  extraction: {
    workers: number;
    limit: number;
    properties: string[];
    categories: Record<string, Record<string, string>>;
    category_batch_size: number;
    source_code: string;
    prompt: string;
    model: string;
  };
  hierarchical_clustering: {
    cluster_nums: number[];
    source_code: string;
  };
  embedding: {
    model: string;
    source_code: string;
  };
  hierarchical_initial_labelling: {
    workers: number;
    source_code: string;
    prompt: string;
    model: string;
  };
  hierarchical_merge_labelling: {
    workers: number;
    source_code: string;
    prompt: string;
    model: string;
  };
  hierarchical_overview: {
    source_code: string;
    prompt: string;
    model: string;
  };
  hierarchical_aggregation: {
    hidden_properties: Record<string, string[]>;
    source_code: string;
  };
  plan: { step: string; run: boolean | string; reason: string }[];
  status: string;
};
