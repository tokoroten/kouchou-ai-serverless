import type { ChatMessage } from "./client";

// Chrome 内蔵 Gemini Nano(Prompt API)対応。
// チャットスロットの baseUrl に GEMINI_NANO_BASE_URL を指定すると、
// 意見分割(extraction)等のチャット呼び出しがブラウザ内で完結する。
// https://developer.chrome.com/docs/ai/prompt-api

export const GEMINI_NANO_BASE_URL = "local:gemini-nano";

export function isGeminiNano(endpoint: { baseUrl: string }): boolean {
  return endpoint.baseUrl === GEMINI_NANO_BASE_URL;
}

// biome-ignore lint/suspicious/noExplicitAny: Prompt API はまだ型定義が安定していない
type LanguageModelApi = any;

function getLanguageModelApi(): LanguageModelApi | null {
  // biome-ignore lint/suspicious/noExplicitAny: グローバルの実験的 API を探す
  const g = globalThis as any;
  // 新: グローバル LanguageModel(Chrome 138+) / 旧: window.ai.languageModel
  return g.LanguageModel ?? g.ai?.languageModel ?? null;
}

/** 'available' | 'downloadable' | 'downloading' | 'unavailable' */
export async function geminiNanoAvailability(): Promise<string> {
  const api = getLanguageModelApi();
  if (!api) return "unavailable";
  try {
    if (typeof api.availability === "function") return await api.availability();
    if (typeof api.capabilities === "function") {
      const caps = await api.capabilities();
      return caps.available === "readily" ? "available" : (caps.available ?? "unavailable");
    }
  } catch {
    // fallthrough
  }
  return "unavailable";
}

export type GeminiNanoDiagnosis = {
  availability: string;
  /** 実際に往復テストを行った場合の応答本文 */
  output?: string;
  latencyMs?: number;
  /** structured output(responseConstraint)の対応可否テスト結果 */
  structured?: {
    /** responseConstraint 付き prompt が例外を投げずに通ったか */
    supported: boolean;
    /** 応答本文(生) */
    output?: string;
    /** 応答が JSON としてパースでき、スキーマの必須フィールドを満たしたか */
    valid?: boolean;
    /** 未対応・失敗時のメッセージ */
    error?: string;
  };
};

/**
 * Gemini Nano の動作確認: availability を取得し、必要ならモデルをダウンロード
 * (monitor で進捗を通知)してから小さな往復テストを1回行う。
 *
 * 重要: モデル未ダウンロード時の create() は transient user activation を要求するため、
 * 必ずボタンの click ハンドラ内(await を跨ぐ前)から呼ぶこと。
 */
export async function prepareAndTestGeminiNano(
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<GeminiNanoDiagnosis> {
  const api = getLanguageModelApi();
  if (!api) {
    throw new Error("この環境では Gemini Nano を利用できません(Chrome 138+ の Prompt API / LanguageModel が必要です)");
  }
  const availability = await geminiNanoAvailability();
  if (availability === "unavailable") {
    throw new Error(
      "availability=unavailable。対応 Chrome か、chrome://flags の Prompt API 有効化・対応 GPU/メモリ要件を確認してください。",
    );
  }
  if (availability === "downloadable" || availability === "downloading") {
    onProgress?.("モデル未ダウンロード。準備を開始します...");
  }
  // monitor 付き create でダウンロード進捗を受け取る(未DLならここでDLが走る)
  // biome-ignore lint/suspicious/noExplicitAny: Prompt API のセッション/モニタは型未確定
  const session: any = await api.create({
    signal,
    // biome-ignore lint/suspicious/noExplicitAny: monitor の型は未公開
    monitor(m: any) {
      m.addEventListener?.("downloadprogress", (e: { loaded?: number }) => {
        const pct = Math.round((typeof e.loaded === "number" ? e.loaded : 0) * 100);
        onProgress?.(`モデルダウンロード中: ${pct}%`);
      });
    },
  });
  try {
    onProgress?.("応答テスト(text)中...");
    const start = Date.now();
    const output: string = await session.prompt("1 + 1 は? 数字のみで答えてください。", { signal });
    const latencyMs = Date.now() - start;

    // structured output(responseConstraint = JSON Schema)の対応可否を実際に叩いて判定する
    onProgress?.("structured output テスト中...");
    const structured = await testStructuredOutput(session, signal);

    return { availability, output: String(output).trim(), latencyMs, structured };
  } finally {
    try {
      session.destroy?.();
    } catch {
      // ignore
    }
  }
}

/** responseConstraint に小さな JSON Schema を渡して、structured output が使えるか判定する */
// biome-ignore lint/suspicious/noExplicitAny: Prompt API セッション
async function testStructuredOutput(session: any, signal?: AbortSignal): Promise<GeminiNanoDiagnosis["structured"]> {
  const schema = {
    type: "object",
    properties: { sum: { type: "number" } },
    required: ["sum"],
    additionalProperties: false,
  };
  try {
    const raw: string = await session.prompt("1 + 1 の答えを JSON で返してください。", {
      signal,
      responseConstraint: schema,
    });
    const text = String(raw).trim();
    let valid = false;
    try {
      const obj = JSON.parse(text);
      valid = !!obj && typeof obj === "object" && typeof (obj as { sum?: unknown }).sum === "number";
    } catch {
      // JSON にならなければ valid=false のまま
    }
    return { supported: true, output: text, valid };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    // responseConstraint 非対応の実装はここで例外になる
    return { supported: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// システムプロンプトごとにベースセッションをキャッシュし、リクエストごとに clone する
// (システムプロンプトの再処理を避ける。extraction は同一プロンプトで大量に呼ぶため効く)
// biome-ignore lint/suspicious/noExplicitAny: Prompt API セッション
const baseSessions = new Map<string, Promise<any>>();

async function getBaseSession(systemPrompt: string) {
  const api = getLanguageModelApi();
  if (!api) throw new Error("この環境では Gemini Nano (Prompt API) を利用できません");
  const existing = baseSessions.get(systemPrompt);
  if (existing) return existing;
  const created: Promise<unknown> = api.create({
    initialPrompts: systemPrompt ? [{ role: "system", content: systemPrompt }] : [],
  });
  baseSessions.set(systemPrompt, created);
  return created;
}

export async function chatWithGeminiNano(
  messages: ChatMessage[],
  jsonSchema?: { name: string; schema: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<string> {
  const systemPrompt = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  const userContent = messages
    .filter((m) => m.role !== "system")
    .map((m) => m.content)
    .join("\n");

  const base = await getBaseSession(systemPrompt);
  // clone できる実装ではセッションを使い回し、できなければ都度作成
  // biome-ignore lint/suspicious/noExplicitAny: Prompt API セッション
  let session: any;
  let ephemeral = false;
  try {
    session = await base.clone({ signal });
  } catch {
    const api = getLanguageModelApi();
    session = await api.create({
      initialPrompts: systemPrompt ? [{ role: "system", content: systemPrompt }] : [],
    });
    ephemeral = true;
  }
  try {
    // responseConstraint(JSON Schema)対応の実装では構造化出力を強制する
    if (jsonSchema) {
      try {
        return await session.prompt(userContent, { signal, responseConstraint: jsonSchema.schema });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") throw e;
        // 非対応実装はプレーンにフォールバック(呼び出し側の寛容パーサに任せる)
      }
    }
    return await session.prompt(`${userContent}\n\n必ずJSONのみで応答してください。`, { signal });
  } finally {
    try {
      if (ephemeral || session !== base) session.destroy?.();
    } catch {
      // ignore
    }
  }
}
