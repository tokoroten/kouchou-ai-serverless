import type { CommentRow, ExtractedArgument, ExtractionResult, Relation } from "../../../types/project";
import { requestChat, Semaphore } from "../../llm/client";
import { parseJsonObjectLoose } from "../../llm/jsonParse";
import type { PipelineContext } from "../context";
import { throwIfAborted } from "../context";

// 本家 steps/extraction.py の移植。
// - コメント1件につき chat 呼び出し1回(並列はセマフォで制御)
// - 同一の意見文字列は最初の arg_id に集約(本家 argument_map と同じ)
// - 正常な空応答と失敗を区別し、失敗はキャッシュせず中断する。
// - チェックポイント: コメント単位

const EXTRACTION_SCHEMA = {
  name: "ExtractionResponse",
  schema: {
    type: "object",
    properties: {
      extractedOpinionList: {
        type: "array",
        items: { type: "string" },
        description: "抽出した意見のリスト",
      },
    },
    required: ["extractedOpinionList"],
    additionalProperties: false,
  },
};

export async function extraction(
  comments: CommentRow[],
  prompt: string,
  ctx: PipelineContext,
): Promise<ExtractionResult> {
  const semaphore = new Semaphore(ctx.concurrency);
  let done = 0;
  const total = comments.length;
  ctx.onProgress?.({ step: "extraction", done, total });

  // コメント単位で抽出(チェックポイント優先)。結果はコメント順を保つ。
  const perComment: string[][] = new Array(comments.length);
  const outcomes = await Promise.allSettled(
    comments.map((comment, index) =>
      semaphore.run(async () => {
        throwIfAborted(ctx.signal);
        const cached = await ctx.checkpoints.getExtraction(comment.commentId);
        if (cached !== undefined) {
          perComment[index] = cached;
        } else {
          try {
            perComment[index] = await extractOne(comment.body, prompt, ctx);
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            await ctx.checkpoints.putChunk("extraction-diagnostics", comment.commentId, {
              commentId: comment.commentId,
              comment: comment.body,
              status: "error",
              errorType: error instanceof Error ? error.name : "Error",
            });
            throw new Error(`回答ID ${comment.commentId} の抽出に失敗しました。入力とモデル設定を確認してください。`);
          }
          await ctx.checkpoints.putExtraction(comment.commentId, perComment[index]);
        }
        await ctx.checkpoints.putChunk(
          "extraction-diagnostics",
          comment.commentId,
          perComment[index].length
            ? { commentId: comment.commentId, status: "ok" }
            : {
                commentId: comment.commentId,
                comment: comment.body,
                status: "empty",
                errorType: null,
              },
        );
        done++;
        ctx.onProgress?.({ step: "extraction", done, total });
      }),
    ),
  );

  // 実行中の入力を待ってから失敗を返し、即座の再試行と競合させない。
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;

  // 重複排除しつつ arg_id を割り当てる(本家 argument_map と同じ)
  const argumentMap = new Map<string, ExtractedArgument>();
  const relations: Relation[] = [];
  for (let i = 0; i < comments.length; i++) {
    const commentId = comments[i].commentId;
    const extractedArgs = perComment[i] ?? [];
    for (let j = 0; j < extractedArgs.length; j++) {
      const text = extractedArgs[j];
      let argId: string;
      const existing = argumentMap.get(text);
      if (existing === undefined) {
        argId = `A${commentId}_${j}`;
        argumentMap.set(text, { argId, argument: text });
      } else {
        argId = existing.argId;
      }
      relations.push({ argId, commentId });
    }
  }

  const args = [...argumentMap.values()];
  if (args.length === 0) {
    throw new Error("意見が1件も抽出できませんでした。プロンプトまたはモデル設定を確認してください。");
  }
  return { args, relations };
}

async function extractOne(body: string, prompt: string, ctx: PipelineContext): Promise<string[]> {
  const response = await requestChat(ctx.chat, {
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: body },
    ],
    jsonSchema: EXTRACTION_SCHEMA,
    signal: ctx.signal,
    onUsage: ctx.onUsage,
  });
  const parsed = parseJsonObjectLoose(response);
  const list = parsed?.extractedOpinionList;
  if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) {
    throw new Error("抽出応答の形式が不正です");
  }
  return list.map((item: string) => item.trim()).filter(Boolean);
}
