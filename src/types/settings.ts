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

export type SlotName = "chat" | "embedding" | "image";

/** 疎通確認に成功した記録。fingerprint は確認した時点の接続構成 */
export type SlotVerification = { fingerprint: string; at: number };

export type Settings = {
  providers: Partial<Record<PresetId, ProviderConfig>>;
  chatSlot: SlotSelection;
  embeddingSlot: SlotSelection;
  /** ポンチ絵生成に使う画像モデル。images/generations 互換のプロバイダのみ */
  imageSlot: SlotSelection;
  concurrency: number; // 既定 8
  /** スロットごとの疎通確認記録。設定を変えると fingerprint が変わり「未確認」に戻る */
  verification: Partial<Record<SlotName, SlotVerification>>;
};

export const DEFAULT_SETTINGS: Settings = {
  providers: {},
  chatSlot: { provider: null, model: "" },
  embeddingSlot: { provider: null, model: "" },
  imageSlot: { provider: null, model: "" },
  concurrency: 8,
  verification: {},
};

function selectionFor(settings: Settings, slot: SlotName): SlotSelection {
  if (slot === "chat") return settings.chatSlot;
  if (slot === "embedding") return settings.embeddingSlot;
  return settings.imageSlot;
}

function defaultModelFor(preset: Preset | undefined, slot: SlotName): string {
  if (!preset) return "";
  if (slot === "chat") return preset.chatModel ?? "";
  if (slot === "embedding") return preset.embeddingModel ?? "";
  return preset.imageModel ?? "";
}

/** スロット選択を実際の EndpointConfig に解決する */
export function resolveEndpoint(settings: Settings, slot: SlotName): EndpointConfig {
  const selection = selectionFor(settings, slot);
  if (!selection.provider) return { baseUrl: "", apiKey: "", model: "" };
  const preset = PRESETS.find((p) => p.id === selection.provider);
  const provider = settings.providers[selection.provider];
  return {
    baseUrl: provider?.baseUrl || preset?.baseUrl || "",
    apiKey: provider?.apiKey ?? "",
    model: selection.model || defaultModelFor(preset, slot),
    authHeader: preset?.authHeader ?? "bearer",
    extraHeaders: preset?.extraHeaders,
    reasoningEffort: slot === "chat" ? (selection.reasoningEffort ?? "") : "",
    serviceTier: slot === "chat" ? (selection.serviceTier ?? "") : "",
  };
}

/**
 * 接続構成の指紋。疎通確認したときの構成と現在の構成が同じかを判定するために使う。
 * API キーはそのまま持たず数値ハッシュにする(キー本体は providers 側にあり、
 * ここで断片を重複して持つ理由がない)。キーを差し替えれば指紋も変わる。
 *
 * 「疎通するか」を左右する baseUrl / model / キーだけを見る。処理ティア(flex 等)や
 * reasoning effort は到達性を変えないので、変えても「未確認」に戻さない
 * (戻すと、価格や速度をいじるたびに警告が復活して煩わしいだけになる)。
 */
export function endpointFingerprint(endpoint: EndpointConfig): string {
  let hash = 5381;
  for (let i = 0; i < endpoint.apiKey.length; i++) {
    hash = ((hash << 5) + hash + endpoint.apiKey.charCodeAt(i)) | 0;
  }
  return `${endpoint.baseUrl}|${endpoint.model}|${endpoint.apiKey ? hash : ""}`;
}

export type SlotReadiness =
  /** プロバイダ未選択・キー未入力・モデル未指定のいずれか */
  | { state: "unset"; reason: string }
  /** 設定は揃っているが、この構成での疎通確認がまだ(または設定変更で無効になった) */
  | { state: "unverified"; reason: string }
  | { state: "ok"; reason: "" };

const SLOT_LABEL: Record<SlotName, string> = { chat: "チャット", embedding: "埋め込み", image: "画像生成" };

/**
 * スロットが実際に使える状態かを一本化して判定する。
 *
 * baseUrl の有無だけを見ると、プロバイダのキーを削除した後でもプリセットの baseUrl で
 * 埋まってしまい「設定済み」と誤判定する。プロバイダ単位の設定(isProviderConfigured)と
 * モデル指定の有無まで見て、さらに疎通確認の記録と突き合わせる。
 */
export function slotReadiness(settings: Settings, slot: SlotName): SlotReadiness {
  const label = SLOT_LABEL[slot];
  const selection = selectionFor(settings, slot);
  if (!selection.provider) return { state: "unset", reason: `${label}のプロバイダが未選択です` };
  if (!isProviderConfigured(selection.provider, settings)) {
    const preset = PRESETS.find((p) => p.id === selection.provider);
    return {
      state: "unset",
      reason: `${label}の ${preset?.label ?? selection.provider} が未設定です(API キー / ベース URL)`,
    };
  }
  const endpoint = resolveEndpoint(settings, slot);
  if (!endpoint.baseUrl) return { state: "unset", reason: `${label}のベース URL が未設定です` };
  if (!endpoint.model) return { state: "unset", reason: `${label}のモデルが未指定です` };

  const verified = settings.verification?.[slot];
  if (!verified) return { state: "unverified", reason: `${label}の疎通確認がまだです` };
  if (verified.fingerprint !== endpointFingerprint(endpoint)) {
    return { state: "unverified", reason: `${label}は設定を変更したため疎通が未確認です` };
  }
  return { state: "ok", reason: "" };
}

/** 新規レポート作成に必要な chat / embedding が揃っているか */
export function pipelineReadiness(settings: Settings): {
  ready: boolean;
  blocked: boolean;
  slots: { slot: SlotName; readiness: SlotReadiness }[];
} {
  const slots = (["chat", "embedding"] as const).map((slot) => ({ slot, readiness: slotReadiness(settings, slot) }));
  return {
    ready: slots.every((s) => s.readiness.state === "ok"),
    // 未設定が1つでもあれば実行自体できない(未確認は実行だけならできる)
    blocked: slots.some((s) => s.readiness.state === "unset"),
    slots,
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
  /** images/generations 対応プロバイダの既定画像モデル。非対応なら空 */
  imageModel?: string;
  corsNote: string;
  /** このプリセットを表示するスロット(省略時は chat と embedding の両方) */
  slot?: SlotName;
  authHeader?: "bearer" | "api-key";
  extraHeaders?: Record<string, string>;
  /** 標準モデルリスト(接続テスト前でも選べるようにする)。安い順に並べる */
  knownChatModels?: ModelSuggestion[];
  knownEmbeddingModels?: ModelSuggestion[];
  /** 画像モデルの候補。images/generations 非対応のプロバイダは省略する */
  knownImageModels?: ModelSuggestion[];
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
    imageModel: "gpt-image-1.5",
    corsNote: "そのまま動作します。意見分割・要約は nano / mini 級で十分です。",
    // dall-e-3 は API から廃止済み(2026-07 実測: The model 'dall-e-3' does not exist)。
    // 現行の画像モデルは gpt-image 系のみ。価格は 2026-07 時点の公表値。
    // gpt-image-2 のみ 16 の倍数の任意サイズ(= 真の 4:3)に対応、他は固定サイズ。
    knownImageModels: [
      { id: "gpt-image-1-mini", price: "$0.005 - $0.052 / 枚(サイズと品質による)" },
      { id: "gpt-image-1.5", price: "$0.009 - $0.20 / 枚(サイズと品質による)" },
      { id: "gpt-image-1", price: "$0.011 - $0.167 / 枚(2026-10 廃止予定)" },
      { id: "gpt-image-2", price: "$0.006 - $0.21 / 枚(サイズと品質による)" },
    ],
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
    // 自前の OpenAI 互換サーバが images/generations を持つ場合に使える。
    // 既定モデル名は分からないので空にし、ユーザに入力させる。
    imageModel: "",
    corsNote: "OpenAI 互換 API のベース URL(.../v1)を指定してください。",
  },
];

/**
 * このプリセットが画像生成(images/generations)に使えるか。
 * imageModel を持つプリセットだけを画像スロットの候補にする。
 * chat/embedding と違い、対応プロバイダがごく限られるため明示的に列挙する。
 */
export function supportsImageGeneration(preset: Preset): boolean {
  return preset.imageModel !== undefined;
}
