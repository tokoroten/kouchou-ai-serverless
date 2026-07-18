import { requestChat, Semaphore } from "../lib/llm/client";
import { parseJsonObjectLoose } from "../lib/llm/jsonParse";
import type { Checkpoints, PipelineContext } from "../lib/pipeline/context";
import { throwIfAborted } from "../lib/pipeline/context";
import type { ExtractedArgument } from "../types/project";
import { ENRICHMENT_SCHEMA, enrichmentPrompt } from "./prompts";
import type { OpinionEnrichment, StanceDistribution, WeightedTag } from "./types";
import { emptyStance, STANCE_KEYS } from "./types";

// 賛否スペクトラム分析の構造化抽出(enrichment)。
// 通常版の抽出済み意見(argument)を入力に、stance 分布・topics・reasons 等を付与する。
// チェックポイント: 意見単位(chunkCache step "enrich")。

export type EnrichProgress = (done: number, total: number) => void;

export async function enrichArguments(
  args: ExtractedArgument[],
  ctx: PipelineContext,
  onProgress?: EnrichProgress,
): Promise<OpinionEnrichment[]> {
  const semaphore = new Semaphore(ctx.concurrency);
  let done = 0;
  const results: OpinionEnrichment[] = new Array(args.length);
  await Promise.all(
    args.map((arg, index) =>
      semaphore.run(async () => {
        throwIfAborted(ctx.signal);
        results[index] = await enrichOne(arg, ctx);
        done++;
        onProgress?.(done, args.length);
      }),
    ),
  );
  return results;
}

async function enrichOne(arg: ExtractedArgument, ctx: PipelineContext): Promise<OpinionEnrichment> {
  const cacheKey = `${arg.argId}`;
  const cached = await ctx.checkpoints.getChunk("enrich", cacheKey);
  if (cached) return cached as OpinionEnrichment;
  let enrichment: OpinionEnrichment;
  try {
    const response = await requestChat(ctx.chat, {
      messages: [
        { role: "system", content: enrichmentPrompt },
        { role: "user", content: arg.argument },
      ],
      jsonSchema: ENRICHMENT_SCHEMA,
      signal: ctx.signal,
      onUsage: ctx.onUsage,
    });
    enrichment = parseEnrichment(response);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    console.error("enrich failed:", e);
    enrichment = fallbackEnrichment();
  }
  await ctx.checkpoints.putChunk("enrich", cacheKey, enrichment);
  return enrichment;
}

/** LLM 出力(文字列)を検証・正規化する(壊れた値は安全側に落とす) */
export function parseEnrichment(response: string): OpinionEnrichment {
  const obj = parseJsonObjectLoose(response);
  if (!obj) return fallbackEnrichment();
  return normalizeEnrichment(obj);
}

/** パース済みオブジェクトを OpinionEnrichment に正規化する(結合抽出でも再利用) */
export function normalizeEnrichment(obj: Record<string, unknown>): OpinionEnrichment {
  return {
    target: typeof obj.target === "string" && obj.target ? obj.target : null,
    topics: parseTags(obj.topics),
    stance: normalizeStance(obj.stance as Record<string, unknown> | undefined),
    reasons: parseTags(obj.reasons),
    conditions: Array.isArray(obj.conditions) ? obj.conditions.filter((c): c is string => typeof c === "string") : [],
    holder: typeof obj.holder === "string" && obj.holder ? obj.holder : null,
    quotedSpeech: obj.quotedSpeech === true,
    commitment: clamp01(Number(obj.commitment)),
    confidence: clamp01(Number(obj.confidence)),
  };
}

function parseTags(value: unknown): WeightedTag[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((t): t is { label: unknown; weight: unknown } => !!t && typeof t === "object")
    .map((t) => ({ label: String(t.label ?? "").trim(), weight: clamp01(Number(t.weight)) }))
    .filter((t) => t.label !== "")
    .slice(0, 3);
}

/** stance 分布を検証し、合計1に正規化する。全て不正なら unknown=1 */
export function normalizeStance(raw: Record<string, unknown> | undefined): StanceDistribution {
  if (!raw) return emptyStance();
  const stance = emptyStance();
  stance.unknown = clamp01(Number(raw.unknown));
  let sum = stance.unknown;
  for (const key of STANCE_KEYS) {
    stance[key] = clamp01(Number(raw[key]));
    sum += stance[key];
  }
  if (sum <= 0) return emptyStance();
  for (const key of STANCE_KEYS) stance[key] /= sum;
  stance.unknown /= sum;
  return stance;
}

export function fallbackEnrichment(): OpinionEnrichment {
  return {
    target: null,
    topics: [],
    stance: emptyStance(),
    reasons: [],
    conditions: [],
    holder: null,
    quotedSpeech: false,
    commitment: 0,
    confidence: 0,
  };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

export type { Checkpoints };
