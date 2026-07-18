import { requestChat, Semaphore } from "../lib/llm/client";
import { parseJsonObjectLoose } from "../lib/llm/jsonParse";
import type { PipelineContext } from "../lib/pipeline/context";
import { throwIfAborted } from "../lib/pipeline/context";
import type { CommentRow, ExtractedArgument, Relation } from "../types/project";
import { fallbackEnrichment, normalizeEnrichment } from "./enrich";
import { buildExtractEnrichPrompt, EXTRACT_ENRICH_SCHEMA } from "./prompts";
import { CHUNK_STEP } from "./storageKeys";
import type { OpinionEnrichment } from "./types";

// 賛否スペクトラム分析の投入口: 生コメントから「意見抽出 + 構造化属性付与(stance/topics/reasons 等)」を
// コメント1件=チャット1回でまとめて行う。通常版の extraction には依存しない。
// - 同一の意見文字列は最初の arg_id に集約(本家 argument_map と同じ)。enrichment は初出を採用
// - 失敗したコメントは空リスト扱いで続行。全件失敗ならエラー
// - チェックポイント: コメント単位(chunkCache step CHUNK_STEP.extract)

/** 1意見ぶんの抽出結果(意見文 + 構造化属性) */
export type RawOpinion = { argument: string; enrichment: OpinionEnrichment };

/** args と enrichments は同順・同長(ユニークな argId ごと) */
export type ExtractEnrichResult = {
  args: ExtractedArgument[];
  relations: Relation[];
  enrichments: OpinionEnrichment[];
};

export type ExtractEnrichProgress = (done: number, total: number) => void;

export async function extractAndEnrich(
  comments: CommentRow[],
  extractionPrompt: string,
  ctx: PipelineContext,
  onProgress?: ExtractEnrichProgress,
): Promise<ExtractEnrichResult> {
  const systemPrompt = buildExtractEnrichPrompt(extractionPrompt);
  const semaphore = new Semaphore(ctx.concurrency);
  let done = 0;
  const total = comments.length;
  onProgress?.(0, total);

  // コメント単位で抽出+分類(チェックポイント優先)。結果はコメント順を保つ。
  const perComment: RawOpinion[][] = new Array(comments.length);
  await Promise.all(
    comments.map((comment, index) =>
      semaphore.run(async () => {
        throwIfAborted(ctx.signal);
        const cached = await ctx.checkpoints.getChunk(CHUNK_STEP.extract, comment.commentId);
        if (cached !== undefined) {
          perComment[index] = cached as RawOpinion[];
        } else {
          perComment[index] = await extractEnrichOne(comment.body, systemPrompt, ctx);
          await ctx.checkpoints.putChunk(CHUNK_STEP.extract, comment.commentId, perComment[index]);
        }
        done++;
        onProgress?.(done, total);
      }),
    ),
  );

  // 重複排除しつつ arg_id を割り当てる(本家 argument_map と同じ)。enrichment は初出を採用。
  const argumentMap = new Map<string, { arg: ExtractedArgument; enrichment: OpinionEnrichment }>();
  const relations: Relation[] = [];
  for (let i = 0; i < comments.length; i++) {
    const commentId = comments[i].commentId;
    const ops = perComment[i] ?? [];
    for (let j = 0; j < ops.length; j++) {
      const text = ops[j].argument;
      let argId: string;
      const existing = argumentMap.get(text);
      if (existing === undefined) {
        argId = `A${commentId}_${j}`;
        argumentMap.set(text, { arg: { argId, argument: text }, enrichment: ops[j].enrichment });
      } else {
        argId = existing.arg.argId;
      }
      relations.push({ argId, commentId });
    }
  }

  const entries = [...argumentMap.values()];
  if (entries.length === 0) {
    throw new Error("意見が1件も抽出できませんでした。プロンプトまたはモデル設定を確認してください。");
  }
  return {
    args: entries.map((e) => e.arg),
    relations,
    enrichments: entries.map((e) => e.enrichment),
  };
}

async function extractEnrichOne(body: string, systemPrompt: string, ctx: PipelineContext): Promise<RawOpinion[]> {
  try {
    const response = await requestChat(ctx.chat, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: body },
      ],
      jsonSchema: EXTRACT_ENRICH_SCHEMA,
      signal: ctx.signal,
      onUsage: ctx.onUsage,
    });
    return parseExtractEnrich(response);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    // 本家と同じ思想: 失敗したコメントは空リスト扱いで続行
    console.error("extract+enrich failed for a comment:", e);
    return [];
  }
}

/**
 * 結合抽出レスポンスのパース。
 * 期待形: {"opinions": [{"argument": "...", ...enrichment}]}。
 * モデルが従来形式に戻った場合(extractedOpinionList / 素の文字列配列)も拾い、
 * その場合 enrichment はフォールバック(unknown 立場)にする。
 */
export function parseExtractEnrich(response: string): RawOpinion[] {
  const obj = parseJsonObjectLoose(response);
  if (!obj) return [];
  const list = Array.isArray(obj.opinions)
    ? obj.opinions
    : Array.isArray(obj.extractedOpinionList)
      ? obj.extractedOpinionList
      : null;
  if (!list) return [];
  const out: RawOpinion[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text) out.push({ argument: text, enrichment: fallbackEnrichment() });
    } else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const text = String(record.argument ?? "").trim();
      if (text) out.push({ argument: text, enrichment: normalizeEnrichment(record) });
    }
  }
  return out;
}
