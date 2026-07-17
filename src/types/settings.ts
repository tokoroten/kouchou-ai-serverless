// LLM プロバイダ設定(DESIGN §4.1)。chat と embedding の2スロット。

export type EndpointConfig = {
  baseUrl: string; // 例: https://api.openai.com/v1
  apiKey: string; // LM Studio / Ollama では空でよい
  model: string; // 例: gpt-4o-mini / text-embedding-3-small
  /** 認証ヘッダの方式。既定 bearer。Azure OpenAI は api-key */
  authHeader?: "bearer" | "api-key";
  /** プロバイダ固有の追加ヘッダ(例: Anthropic のブラウザ直アクセス許可) */
  extraHeaders?: Record<string, string>;
  /** reasoning effort(対応モデルのみ)。空なら送信しない */
  reasoningEffort?: "" | "minimal" | "low" | "medium" | "high";
  /** 処理ティア/ルーティング(プロバイダ別)。空なら送信しない。
   * OpenAI: "flex"(Batch 価格・低速) / Anthropic: "standard_only" / OpenRouter: "floor"・"nitro"(モデルサフィックス) */
  serviceTier?: string;
};

// プロバイダごとの接続情報。API キーはプロバイダ単位で一度だけ入力し、
// chat / embedding スロットは「設定済みプロバイダ」からのみ選択できる。
export type ProviderConfig = {
  baseUrl: string;
  apiKey: string;
};

export type SlotSelection = {
  provider: PresetId | null;
  model: string;
  /** reasoning effort(chat スロットのみ・対応モデルのみ)。空なら送信しない */
  reasoningEffort?: "" | "minimal" | "low" | "medium" | "high";
  /** 処理ティア/ルーティング(chat スロットのみ、プロバイダ別) */
  serviceTier?: string;
};

export type Settings = {
  providers: Partial<Record<PresetId, ProviderConfig>>;
  chatSlot: SlotSelection;
  embeddingSlot: SlotSelection;
  concurrency: number; // 既定 8
};

export const DEFAULT_SETTINGS: Settings = {
  providers: {},
  chatSlot: { provider: null, model: "" },
  embeddingSlot: { provider: null, model: "" },
  concurrency: 8,
};

/** スロット選択を実際の EndpointConfig に解決する */
export function resolveEndpoint(settings: Settings, slot: "chat" | "embedding"): EndpointConfig {
  const selection = slot === "chat" ? settings.chatSlot : settings.embeddingSlot;
  if (!selection.provider) return { baseUrl: "", apiKey: "", model: "" };
  const preset = PRESETS.find((p) => p.id === selection.provider);
  const provider = settings.providers[selection.provider];
  return {
    baseUrl: provider?.baseUrl || preset?.baseUrl || "",
    apiKey: provider?.apiKey ?? "",
    model: selection.model || (slot === "chat" ? (preset?.chatModel ?? "") : (preset?.embeddingModel ?? "")),
    authHeader: preset?.authHeader ?? "bearer",
    extraHeaders: preset?.extraHeaders,
    reasoningEffort: slot === "chat" ? (selection.reasoningEffort ?? "") : "",
    serviceTier: slot === "chat" ? (selection.serviceTier ?? "") : "",
  };
}

/** 既知モデルリストから単価(USD/100万トークン)を引く。不明なら null */
export function lookupModelPrice(modelId: string): { input: number; output: number } | null {
  for (const preset of PRESETS) {
    for (const m of [...(preset.knownChatModels ?? []), ...(preset.knownEmbeddingModels ?? [])]) {
      if (m.id === modelId && m.price) {
        const nums = m.price.match(/\$([\d.]+)/g)?.map((s) => Number(s.slice(1)));
        if (nums && nums.length >= 1 && nums.every((n) => Number.isFinite(n))) {
          return { input: nums[0], output: nums[1] ?? 0 };
        }
      }
    }
  }
  return null;
}

/** 実績トークンからの概算費用(チャットモデル単価ベース。単価不明なら null)。
 * 入力トークンにはチャットと埋め込みが混ざるため、上限寄りの概算になる。 */
export function estimateActualCostUsd(
  usage: { input: number; output: number },
  chatModel: string,
  serviceTier?: string,
): number | null {
  const price = lookupModelPrice(chatModel);
  if (!price) return null;
  const cost = (usage.input / 1e6) * price.input + (usage.output / 1e6) * price.output;
  // Flex は Batch API 価格(約50%割引)
  return serviceTier === "flex" ? cost * 0.5 : cost;
}

/** プロバイダが「設定済み」か(選択可能にするかどうか) */
export function isProviderConfigured(id: PresetId, settings: Settings): boolean {
  const provider = settings.providers[id];
  switch (id) {
    case "openai":
    case "anthropic":
    case "grok":
    case "openrouter":
      return !!provider?.apiKey;
    case "azure":
    case "bedrock":
      return !!provider?.apiKey && !!provider?.baseUrl;
    case "lmstudio":
    case "ollama":
    case "custom":
      return !!provider?.baseUrl;
    case "gemini-nano":
    case "local-embedding":
      return true; // ブラウザ内実行(利用可否は接続テストで判定)
  }
}

export type PresetId =
  | "openai"
  | "anthropic"
  | "grok"
  | "openrouter"
  | "azure"
  | "bedrock"
  | "lmstudio"
  | "ollama"
  | "gemini-nano"
  | "local-embedding"
  | "custom";

export type Preset = {
  id: PresetId;
  label: string;
  baseUrl: string;
  chatModel: string;
  embeddingModel: string; // embeddings 非対応なら空
  corsNote: string;
  /** このプリセットを表示するスロット(省略時は両方) */
  slot?: "chat" | "embedding";
  authHeader?: "bearer" | "api-key";
  extraHeaders?: Record<string, string>;
  /** 標準モデルリスト(接続テスト前でも選べるようにする)。安い順に並べる */
  knownChatModels?: ModelSuggestion[];
  knownEmbeddingModels?: ModelSuggestion[];
  /** 処理ティア/ルーティングの選択肢(chat スロット)。無いプロバイダは省略 */
  tierOptions?: { value: string; label: string }[];
  /** プロバイダの稼働状況ページ */
  statusUrl?: string;
};

export type ModelSuggestion = {
  id: string;
  /** USD / 100万トークン(入力/出力)。embeddings は入力のみ。2026-01 時点の参考値 */
  price?: string;
};

export const PRESETS: Preset[] = [
  // 既知モデルリストは「安い順」に並べる(旧世代モデルも互換性のため残す)。
  // 意見分割・ラベリング・要約は比較的軽いタスクなので、安価な小型モデルで十分。
  {
    id: "openai",
    statusUrl: "https://status.openai.com",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    chatModel: "gpt-5.4-nano",
    embeddingModel: "text-embedding-3-small",
    corsNote: "そのまま動作します。意見分割・要約は nano / mini 級で十分です。",
    knownChatModels: [
      { id: "gpt-5-nano", price: "$0.05 / $0.40" },
      { id: "gpt-4o-mini", price: "$0.15 / $0.60" },
      { id: "gpt-5.4-nano", price: "$0.20 / $1.25" },
      { id: "gpt-5-mini", price: "$0.25 / $2.00" },
      { id: "gpt-5.4-mini", price: "$0.75 / $4.50" },
      { id: "gpt-5.6-luna", price: "$1.00 / $6.00" },
      { id: "gpt-5.4", price: "$2.50 / $15.00" },
      { id: "gpt-5.6-terra", price: "$2.50 / $15.00" },
      { id: "gpt-5.6-sol", price: "$5.00 / $30.00" },
    ],
    knownEmbeddingModels: [
      { id: "text-embedding-3-small", price: "$0.02" },
      { id: "text-embedding-3-large", price: "$0.13" },
    ],
    tierOptions: [
      { value: "", label: "標準(即時処理)" },
      { value: "flex", label: "Flex — Batch 価格(約50%割引)・低速。混雑時は自動リトライ" },
    ],
  },
  {
    id: "anthropic",
    statusUrl: "https://status.anthropic.com",
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com/v1",
    chatModel: "claude-haiku-4-5",
    embeddingModel: "",
    corsNote:
      "Anthropic の OpenAI 互換エンドポイントを使用します(chat のみ。embeddings はないため埋め込みは別プロバイダを設定)。ブラウザ直アクセス許可ヘッダを自動送信します。意見分割・要約は Haiku で十分です。",
    slot: "chat",
    extraHeaders: { "anthropic-dangerous-direct-browser-access": "true", "anthropic-version": "2023-06-01" },
    knownChatModels: [
      { id: "claude-3-5-haiku-latest", price: "$0.80 / $4.00" },
      { id: "claude-haiku-4-5", price: "$1.00 / $5.00" },
      { id: "claude-sonnet-5", price: "$2.00 / $10.00 (〜2026-08)" },
      { id: "claude-sonnet-4-6", price: "$3.00 / $15.00" },
      { id: "claude-opus-4-8", price: "$5.00 / $25.00" },
    ],
    tierOptions: [
      { value: "", label: "auto(既定。Priority Tier 契約があれば優先枠を使用)" },
      { value: "standard_only", label: "standard_only — Priority Tier 枠を消費しない" },
    ],
  },
  {
    id: "grok",
    statusUrl: "https://status.x.ai",
    label: "Grok (xAI)",
    baseUrl: "https://api.x.ai/v1",
    chatModel: "grok-4.3",
    embeddingModel: "",
    corsNote:
      "xAI の OpenAI 互換 API を使用します(chat のみ。embeddings はないため埋め込みは別プロバイダを設定)。旧 grok-4 / grok-4.1-fast 系 ID は 2026-05 に廃止され grok-4.3 へ自動転送されます。",
    slot: "chat",
    knownChatModels: [
      { id: "grok-4.3", price: "$1.25 / $2.50" },
      { id: "grok-4.20", price: "$1.25 / $2.50" },
      { id: "grok-4.5", price: "$2.00 / $6.00" },
    ],
  },
  {
    id: "openrouter",
    statusUrl: "https://status.openrouter.ai",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    chatModel: "openai/gpt-5.4-nano",
    embeddingModel: "",
    corsNote:
      "chat のみ対応。embeddings はないため、埋め込みスロットは別プロバイダ(OpenAI 等)を設定してください。「無償モデルを探す」で :free モデルも使えます(価格はモデル一覧取得時に実勢値で表示されます)。",
    knownChatModels: [
      { id: "openai/gpt-oss-20b", price: "$0.03 / $0.13" },
      { id: "google/gemini-2.5-flash-lite", price: "$0.10 / $0.40" },
      { id: "meta-llama/llama-4-maverick", price: "$0.20 / $0.80" },
      { id: "openai/gpt-5.4-nano", price: "$0.20 / $1.25" },
      { id: "deepseek/deepseek-chat-v3.1", price: "$0.25 / $0.95" },
      { id: "google/gemini-3.1-flash-lite", price: "$0.25 / $1.50" },
      { id: "moonshotai/kimi-k2", price: "$0.57 / $2.30" },
      { id: "anthropic/claude-haiku-4.5", price: "$1.00 / $5.00" },
      { id: "x-ai/grok-4.3", price: "$1.25 / $2.50" },
    ],
    tierOptions: [
      { value: "", label: "標準ルーティング" },
      { value: "floor", label: ":floor — 常に最安のプロバイダを選択" },
      { value: "nitro", label: ":nitro — 最速(スループット順)のプロバイダを選択" },
    ],
  },
  {
    id: "azure",
    statusUrl: "https://azure.status.microsoft",
    label: "Azure OpenAI",
    baseUrl: "",
    chatModel: "",
    embeddingModel: "",
    corsNote:
      "ベース URL に https://{リソース名}.openai.azure.com/openai/v1 を指定してください(v1 互換 API)。認証は api-key ヘッダで送信されます。モデル名にはデプロイ名を指定します。",
    authHeader: "api-key",
  },
  {
    id: "bedrock",
    statusUrl: "https://health.aws.amazon.com/health/status",
    label: "AWS Bedrock (OpenAI互換)",
    baseUrl: "",
    chatModel: "",
    embeddingModel: "",
    corsNote:
      "ベース URL に https://bedrock-runtime.{リージョン}.amazonaws.com/openai/v1 を指定し、Bedrock API キーを入力してください。注意: Bedrock は CORS ヘッダを返さないため、ブラウザから直接呼べない場合があります(その場合は CORS プロキシ経由の URL を指定)。",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    chatModel: "",
    embeddingModel: "",
    corsNote: "LM Studio のサーバ設定で CORS を有効にしてください。",
  },
  {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    chatModel: "",
    embeddingModel: "",
    corsNote: "環境変数 OLLAMA_ORIGINS の設定が必要です(例: OLLAMA_ORIGINS=*)。",
  },
  {
    id: "gemini-nano",
    label: "Gemini Nano (Chrome 内蔵・無料)",
    baseUrl: "local:gemini-nano",
    chatModel: "gemini-nano",
    embeddingModel: "",
    corsNote:
      "Chrome 内蔵の Prompt API を使い、意見分割等がブラウザ内で完結します(データ送信なし・無料)。Chrome 138+ で利用可。初回はモデルのダウンロードが走ることがあります。",
    slot: "chat",
  },
  {
    id: "local-embedding",
    label: "ローカル埋め込み (ブラウザ内 WebGPU・無料)",
    baseUrl: "local:transformers",
    chatModel: "",
    embeddingModel: "Xenova/multilingual-e5-small",
    corsNote:
      "transformers.js でブラウザ内で埋め込みを計算します(データ送信なし・無料)。モデル名は Hugging Face のリポジトリ名(「組織名/モデル名」形式。https://huggingface.co で公開されている ONNX 対応モデル)で、初回にブラウザへダウンロードされキャッシュされます。候補から選ぶだけでも使えます。WebGPU 対応ブラウザで高速、非対応時は WASM で動作します。",
    slot: "embedding",
    knownEmbeddingModels: [
      // price 欄はサイズ/次元の目安として使う(ローカルなので費用は0)
      { id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", price: "384次元・約120MB・最速" },
      { id: "Xenova/multilingual-e5-small", price: "384次元・約120MB・軽量" },
      { id: "Xenova/multilingual-e5-base", price: "768次元・約280MB・バランス" },
      { id: "Xenova/multilingual-e5-large", price: "1024次元・約560MB・高精度" },
      { id: "Xenova/bge-m3", price: "1024次元・約570MB・多言語最高精度" },
    ],
  },
  {
    id: "custom",
    label: "カスタム",
    baseUrl: "",
    chatModel: "",
    embeddingModel: "",
    corsNote: "OpenAI 互換 API のベース URL(.../v1)を指定してください。",
  },
];
