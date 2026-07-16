import type { ChatMessage } from "./client";

// Chrome 内蔵 Gemini Nano(Prompt API)対応。
// チャットスロットの baseUrl に GEMINI_NANO_BASE_URL を指定すると、
// 意見分割(extraction)等のチャット呼び出しがブラウザ内で完結する。
// https://developer.chrome.com/docs/ai/prompt-api

export const GEMINI_NANO_BASE_URL = "local:gemini-nano";

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
