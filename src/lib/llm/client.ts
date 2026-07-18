import type { EndpointConfig } from "../../types/settings";

// OpenAI 互換 API クライアント(DESIGN §4.3)。
// - Structured Outputs → json_object → 素のプロンプト の三段フォールバック
// - 429/5xx は指数バックオフ(初期1s、最大60s、最大5回)。Retry-After を尊重
// - 全呼び出しに AbortSignal を配線し、usage を集計する

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type Usage = { input: number; output: number; total: number };

export type ChatOptions = {
  messages: ChatMessage[];
  // Structured Outputs 用 JSON Schema(name と schema)。省略時はプレーンテキスト応答。
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
  onUsage?: (usage: Usage) => void;
  /** 1呼び出し全体のタイムアウト(ms)。既定 300 秒(本家 EXTRACTION_WAIT_TIMEOUT と同じ)。
   * OpenRouter 等でモデルが応答しない場合に検知するため。 */
  timeoutMs?: number;
  /** 応答の message オブジェクトを生のまま受け取る(応答テストで reasoning 等を表示するため) */
  onRawMessage?: (message: Record<string, unknown>) => void;
  /** 応答全体を生のまま受け取る(usage 詳細等の診断用) */
  onRawResponse?: (data: Record<string, unknown>) => void;
};

export const DEFAULT_CHAT_TIMEOUT_MS = 300_000;
// Flex processing は低速のためタイムアウトを長めに取る(公式推奨は15分)
export const FLEX_CHAT_TIMEOUT_MS = 900_000;

/** 呼び出し元 signal + タイムアウトを合成した AbortSignal を作る */
function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cancel: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
    timedOut: () => timedOut,
  };
}

export type EmbeddingOptions = {
  texts: string[];
  signal?: AbortSignal;
  onUsage?: (usage: Usage) => void;
  /** 1呼び出し全体のタイムアウト(ms)。既定 300 秒。 */
  timeoutMs?: number;
};

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

export class LlmError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function buildHeaders(endpoint: EndpointConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (endpoint.apiKey) {
    // Azure OpenAI は api-key ヘッダ、それ以外は Bearer
    if (endpoint.authHeader === "api-key") {
      headers["api-key"] = endpoint.apiKey;
    } else {
      headers.Authorization = `Bearer ${endpoint.apiKey}`;
    }
  }
  // プロバイダ固有の追加ヘッダ(例: Anthropic のブラウザ直アクセス許可)
  if (endpoint.extraHeaders) Object.assign(headers, endpoint.extraHeaders);
  return headers;
}

/**
 * baseUrl のホストが指定プロバイダかを厳密判定する。
 * 部分文字列一致(includes)だと "api.openai.com.evil.com" や
 * "evil.com/?x=api.openai.com" のような URL も通ってしまうため、
 * URL としてパースしてホスト名の完全一致 / サブドメイン一致で判定する。
 */
function hostMatches(baseUrl: string, host: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === host || hostname.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

/** reasoning effort / service tier をプロバイダ方言に合わせて body に載せる */
function applyOptionalParams(body: Record<string, unknown>, endpoint: EndpointConfig): boolean {
  let applied = false;
  const effort = endpoint.reasoningEffort;
  if (effort) {
    if (hostMatches(endpoint.baseUrl, "openrouter.ai")) {
      body.reasoning = { effort };
    } else {
      body.reasoning_effort = effort;
    }
    applied = true;
  }
  if (endpoint.serviceTier) {
    if (hostMatches(endpoint.baseUrl, "openrouter.ai")) {
      // OpenRouter はモデルサフィックスでルーティング指定(:floor = 最安 / :nitro = 最速)
      body.model = `${endpoint.model}:${endpoint.serviceTier}`;
    } else {
      // OpenAI Flex(Batch 価格・低速。429 は課金されず既存のバックオフで再試行される)や
      // Anthropic standard_only はいずれも service_tier パラメータ
      body.service_tier = endpoint.serviceTier;
    }
    applied = true;
  }
  return applied;
}

/** 429/5xx をリトライしつつ fetch する */
async function fetchWithRetry(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  let backoff = INITIAL_BACKOFF_MS;
  let lastError: LlmError | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(Math.min(backoff, MAX_BACKOFF_MS), signal);
      backoff *= 2;
    }
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      // ネットワークエラーもリトライ対象
      lastError = new LlmError(`ネットワークエラー: ${String(e)}`);
      continue;
    }
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = res.headers.get("Retry-After");
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds > 0) backoff = seconds * 1000;
      }
      lastError = new LlmError(`HTTP ${res.status}: ${await safeText(res)}`, res.status);
      continue;
    }
    // 4xx(429以外)はリトライしない
    throw new LlmError(`HTTP ${res.status}: ${await safeText(res)}`, res.status);
  }
  throw lastError ?? new LlmError("リトライ上限に達しました");
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

function extractUsage(data: Record<string, unknown>): Usage {
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  const input = Number(usage.prompt_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? 0);
  const total = Number(usage.total_tokens ?? input + output);
  return { input, output, total };
}

type ResponseFormat =
  | { type: "json_schema"; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } }
  | { type: "json_object" }
  | null;

/**
 * chat 呼び出し。Structured Outputs 非対応プロバイダには
 * json_object → プロンプト追記 の順でフォールバックする。
 */
export async function requestChat(endpoint: EndpointConfig, options: ChatOptions): Promise<string> {
  // Chrome 内蔵 Gemini Nano(ブラウザ内で完結、トークン集計なし)
  if (endpoint.baseUrl === "local:gemini-nano") {
    const { chatWithGeminiNano } = await import("./geminiNano");
    return chatWithGeminiNano(options.messages, options.jsonSchema, options.signal);
  }
  const timeoutMs =
    options.timeoutMs ?? (endpoint.serviceTier === "flex" ? FLEX_CHAT_TIMEOUT_MS : DEFAULT_CHAT_TIMEOUT_MS);
  const timeout = withTimeout(options.signal, timeoutMs);
  try {
    return await requestChatInner(endpoint, options, timeout.signal);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError" && timeout.timedOut()) {
      throw new LlmError(
        `モデルの応答が ${Math.round(timeoutMs / 1000)} 秒以内に返りませんでした(タイムアウト)。別のモデルを試すか、時間をおいて再実行してください。`,
      );
    }
    throw e;
  } finally {
    timeout.cancel();
  }
}

/**
 * response_format の三段フォールバック計画を作る。
 * json_schema → json_object → 素のプロンプト(JSON指示を追記)
 */
function buildFormatPlan(options: ChatOptions): ResponseFormat[] {
  return options.jsonSchema
    ? [
        {
          type: "json_schema",
          json_schema: { name: options.jsonSchema.name, strict: true, schema: options.jsonSchema.schema },
        },
        { type: "json_object" },
        null,
      ]
    : [null];
}

/** 1試行分のリクエストボディを組み立てる(方言吸収はここに集約) */
function buildChatBody(
  endpoint: EndpointConfig,
  options: ChatOptions,
  format: ResponseFormat,
  withOptional: boolean,
): Record<string, unknown> {
  const messages = [...options.messages];
  if (options.jsonSchema && format === null) {
    // 最終フォールバック: プロンプトで JSON のみの応答を要求
    const last = messages[messages.length - 1];
    messages[messages.length - 1] = {
      ...last,
      content: `${last.content}\n\n必ずJSONのみで応答してください。`,
    };
  }
  const body: Record<string, unknown> = { model: endpoint.model, messages };
  if (format) body.response_format = format;
  if (withOptional) applyOptionalParams(body, endpoint);
  return body;
}

/** 1試行を実行して応答本文を返す */
async function executeChat(
  url: string,
  endpoint: EndpointConfig,
  body: Record<string, unknown>,
  options: ChatOptions,
  signal: AbortSignal,
): Promise<string> {
  const res = await fetchWithRetry(
    url,
    { method: "POST", headers: buildHeaders(endpoint), body: JSON.stringify(body) },
    signal,
  );
  const data = (await res.json()) as Record<string, unknown>;
  options.onUsage?.(extractUsage(data));
  options.onRawResponse?.(data);
  const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
  const message = choices?.[0]?.message;
  if (message) options.onRawMessage?.(message as Record<string, unknown>);
  const content = message?.content;
  if (typeof content !== "string") throw new LlmError("応答に content がありません");
  return content;
}

function isClientError(e: unknown): e is LlmError {
  return e instanceof LlmError && e.status !== undefined && e.status >= 400 && e.status < 500;
}

/**
 * フォールバック制御:
 * - 各 format について、オプションパラメータ(reasoning/service_tier)あり → なし の順に試す
 * - オプションありのみ 4xx → オプションが原因とみなし以後は外す
 * - オプションなしでも 4xx → format が原因なので次の format へ(オプションの疑いは晴れる)
 */
async function requestChatInner(endpoint: EndpointConfig, options: ChatOptions, signal: AbortSignal): Promise<string> {
  const url = `${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const hasOptionalParams = !!(endpoint.reasoningEffort || endpoint.serviceTier);

  let lastError: unknown = null;
  let optionalSuspected = false;
  for (const format of buildFormatPlan(options)) {
    const attempts = hasOptionalParams && !optionalSuspected ? [true, false] : [false];
    for (const withOptional of attempts) {
      try {
        return await executeChat(
          url,
          endpoint,
          buildChatBody(endpoint, options, format, withOptional),
          options,
          signal,
        );
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") throw e;
        if (!isClientError(e)) throw e;
        lastError = e;
        if (withOptional) {
          optionalSuspected = true;
          continue; // 同じ format でオプションなしを試す
        }
        if (format === null) throw e; // 最終フォールバックでも失敗
        optionalSuspected = false; // format が原因 → オプションの疑いは晴れた
        break; // 次の format へ
      }
    }
  }
  throw lastError ?? new LlmError("chat 呼び出しに失敗しました");
}

/** embeddings 呼び出し。texts と同順の Float32Array 配列を返す。 */
export async function requestEmbeddings(endpoint: EndpointConfig, options: EmbeddingOptions): Promise<Float32Array[]> {
  const timeout = withTimeout(options.signal, options.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS);
  try {
    return await requestEmbeddingsInner(endpoint, options, timeout.signal);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError" && timeout.timedOut()) {
      throw new LlmError("embeddings の応答がタイムアウトしました。エンドポイント設定を確認してください。");
    }
    throw e;
  } finally {
    timeout.cancel();
  }
}

async function requestEmbeddingsInner(
  endpoint: EndpointConfig,
  options: EmbeddingOptions,
  signal: AbortSignal,
): Promise<Float32Array[]> {
  const url = `${endpoint.baseUrl.replace(/\/$/, "")}/embeddings`;
  const body = { model: endpoint.model, input: options.texts };
  const res = await fetchWithRetry(
    url,
    { method: "POST", headers: buildHeaders(endpoint), body: JSON.stringify(body) },
    signal,
  );
  const data = (await res.json()) as Record<string, unknown>;
  options.onUsage?.(extractUsage(data));
  const items = data.data as Array<{ index: number; embedding: number[] }> | undefined;
  if (!Array.isArray(items)) throw new LlmError("embeddings 応答が不正です");
  const sorted = [...items].sort((a, b) => a.index - b.index);
  return sorted.map((item) => Float32Array.from(item.embedding));
}

/** 接続テスト: モデル一覧を取得する */
export async function listModels(endpoint: EndpointConfig, signal?: AbortSignal): Promise<string[]> {
  if (endpoint.baseUrl === "local:gemini-nano") {
    const { geminiNanoAvailability } = await import("./geminiNano");
    const availability = await geminiNanoAvailability();
    if (availability === "unavailable") {
      throw new LlmError("この環境では Gemini Nano を利用できません(Chrome 138+ の Prompt API が必要です)");
    }
    if (availability === "downloadable" || availability === "downloading") {
      throw new LlmError(
        `Gemini Nano はまだ使用できません(${availability})。設定画面の「Gemini Nano を準備」でモデルをダウンロードしてください。`,
      );
    }
    return ["gemini-nano"];
  }
  const url = `${endpoint.baseUrl.replace(/\/$/, "")}/models`;
  const res = await fetchWithRetry(url, { method: "GET", headers: buildHeaders(endpoint) }, signal);
  const data = (await res.json()) as { data?: Array<{ id: string }> };
  return (data.data ?? []).map((m) => m.id).sort();
}

export type ModelInfo = {
  id: string;
  /** OpenRouter の pricing 情報から判定した無償フラグ(情報がなければ undefined) */
  isFree?: boolean;
  /** USD / 100万トークン(入力/出力)。pricing 情報があるプロバイダのみ */
  price?: string;
};

/** モデル一覧を料金情報付きで取得する(OpenRouter の無償モデル検索・価格表示用) */
export async function listModelsDetailed(endpoint: EndpointConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
  const url = `${endpoint.baseUrl.replace(/\/$/, "")}/models`;
  const res = await fetchWithRetry(url, { method: "GET", headers: buildHeaders(endpoint) }, signal);
  const data = (await res.json()) as {
    data?: Array<{ id: string; pricing?: { prompt?: string | number; completion?: string | number } }>;
  };
  const perMillion = (v: string | number | undefined) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const m = n * 1_000_000;
    return m >= 10 ? m.toFixed(0) : m >= 0.1 ? m.toFixed(2) : m.toFixed(3);
  };
  return (data.data ?? []).map((m) => {
    let isFree: boolean | undefined;
    let price: string | undefined;
    if (m.pricing) {
      isFree = Number(m.pricing.prompt ?? 1) === 0 && Number(m.pricing.completion ?? 1) === 0;
      const input = perMillion(m.pricing.prompt);
      const output = perMillion(m.pricing.completion);
      if (input !== null && output !== null) price = `$${input} / $${output}`;
    }
    return { id: m.id, isFree, price };
  });
}

export type ChatProbeResult = {
  ok: boolean;
  latencyMs: number;
  /** テストで送信した入力プロンプト */
  input: string;
  /** モデルの応答本文(失敗時は空) */
  output: string;
  /** reasoning/thinking(reasoning_content・reasoning フィールドや <think> タグ)があれば */
  reasoning?: string;
  message: string;
};

// 軽い計算を含めることで、reasoning 対応モデルでは思考過程が返り、応答テストで確認できる
export const PROBE_PROMPT = "接続テストです。17×23 を計算して、数字のみで答えてください。";

/**
 * チャット応答テスト: 小さなリクエストを投げ、応答時間を計測する。
 * OpenRouter などでモデルが応答しない(タイムアウトする)かを事前確認できる。
 */
export async function probeChat(endpoint: EndpointConfig, timeoutMs = 30_000): Promise<ChatProbeResult> {
  const start = Date.now();
  try {
    let raw: Record<string, unknown> | null = null;
    let rawResponse: Record<string, unknown> | null = null;
    const content = await requestChat(endpoint, {
      messages: [{ role: "user", content: PROBE_PROMPT }],
      timeoutMs,
      onRawMessage: (message) => {
        raw = message;
      },
      onRawResponse: (data) => {
        rawResponse = data;
      },
    });
    const latencyMs = Date.now() - start;

    // reasoning/thinking の抽出: プロバイダごとにフィールド名が異なる
    // LM Studio: reasoning_content / OpenRouter: reasoning / DeepSeek 系: content 内の <think> タグ
    let reasoning: string | undefined;
    const rawMessage = raw as Record<string, unknown> | null;
    for (const field of ["reasoning_content", "reasoning", "thinking"]) {
      const value = rawMessage?.[field];
      if (typeof value === "string" && value.trim()) {
        reasoning = value.trim();
        break;
      }
    }
    let output = content;
    if (!reasoning) {
      const thinkMatch = content.match(/<think\b[^>]*>([\s\S]*?)<\/think>/);
      if (thinkMatch) {
        reasoning = thinkMatch[1].trim();
        output = content.replace(/<think\b[^>]*>[\s\S]*?<\/think>/g, "").trim();
      }
    }

    // OpenAI: Chat Completions は思考本文を返さない(トークン数のみ)。
    // 思考トークンが消費されていれば Responses API で思考要約の取得を試みる。
    if (!reasoning) {
      const usageDetails = (rawResponse as Record<string, unknown> | null)?.usage as
        | { completion_tokens_details?: { reasoning_tokens?: number } }
        | undefined;
      const reasoningTokens = usageDetails?.completion_tokens_details?.reasoning_tokens ?? 0;
      if (reasoningTokens > 0) {
        const summary = hostMatches(endpoint.baseUrl, "api.openai.com")
          ? await fetchOpenAiReasoningSummary(endpoint).catch(() => null)
          : null;
        reasoning = summary
          ? `${summary}\n(Responses API による思考要約)`
          : `(思考トークンを ${reasoningTokens.toLocaleString()} 消費しましたが、この API は思考の本文を返しません。OpenAI は Responses API 経由の要約のみで、短い思考では要約も生成されません)`;
      }
    }

    return {
      ok: true,
      latencyMs,
      input: PROBE_PROMPT,
      output,
      reasoning,
      message: `応答 ${Math.round(latencyMs / 100) / 10} 秒${reasoning ? "(reasoning あり)" : ""}`,
    };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      input: PROBE_PROMPT,
      output: "",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * OpenAI Responses API で思考要約を取得する(応答テスト専用)。
 * 要約が生成されなかった場合は null。
 */
async function fetchOpenAiReasoningSummary(endpoint: EndpointConfig): Promise<string | null> {
  const url = `${endpoint.baseUrl.replace(/\/$/, "")}/responses`;
  const body = {
    model: endpoint.model,
    input: PROBE_PROMPT,
    reasoning: { effort: endpoint.reasoningEffort || "medium", summary: "auto" },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(endpoint),
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    output?: Array<{ type: string; summary?: Array<{ type: string; text?: string }> }>;
  };
  const reasoningItem = data.output?.find((o) => o.type === "reasoning");
  const text = (reasoningItem?.summary ?? [])
    .map((s) => s.text ?? "")
    .filter(Boolean)
    .join("\n");
  return text.trim() || null;
}

/** 並列実行のためのセマフォ */
export class Semaphore {
  private queue: Array<() => void> = [];
  private available: number;

  constructor(concurrency: number) {
    this.available = Math.max(1, concurrency);
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
