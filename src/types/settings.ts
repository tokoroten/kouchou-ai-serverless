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
  };
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
  /** 標準モデルリスト(接続テスト前でも選べるようにする) */
  knownChatModels?: string[];
  knownEmbeddingModels?: string[];
};

export const PRESETS: Preset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    chatModel: "gpt-4o-mini",
    embeddingModel: "text-embedding-3-small",
    corsNote: "そのまま動作します。",
    knownChatModels: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "gpt-5-mini", "gpt-5.1", "o4-mini"],
    knownEmbeddingModels: ["text-embedding-3-small", "text-embedding-3-large"],
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com/v1",
    chatModel: "claude-haiku-4-5",
    embeddingModel: "",
    corsNote:
      "Anthropic の OpenAI 互換エンドポイントを使用します(chat のみ。embeddings はないため埋め込みは別プロバイダを設定)。ブラウザ直アクセス許可ヘッダを自動送信します。",
    slot: "chat",
    extraHeaders: { "anthropic-dangerous-direct-browser-access": "true", "anthropic-version": "2023-06-01" },
    knownChatModels: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8"],
  },
  {
    id: "grok",
    label: "Grok (xAI)",
    baseUrl: "https://api.x.ai/v1",
    chatModel: "grok-4-fast",
    embeddingModel: "",
    corsNote: "xAI の OpenAI 互換 API を使用します(chat のみ。embeddings はないため埋め込みは別プロバイダを設定)。",
    slot: "chat",
    knownChatModels: ["grok-4-fast", "grok-4", "grok-3-mini"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    chatModel: "openai/gpt-4o-mini",
    embeddingModel: "",
    corsNote: "chat のみ対応。embeddings はないため、埋め込みスロットは別プロバイダ(OpenAI 等)を設定してください。",
    knownChatModels: [
      "openai/gpt-4o-mini",
      "anthropic/claude-haiku-4.5",
      "google/gemini-2.5-flash",
      "deepseek/deepseek-chat-v3.1",
    ],
  },
  {
    id: "azure",
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
      "transformers.js でブラウザ内で埋め込みを計算します(データ送信なし・無料)。初回にモデル(約120MB)をダウンロードします。WebGPU 対応ブラウザで高速、非対応時は WASM で動作します。",
    slot: "embedding",
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
