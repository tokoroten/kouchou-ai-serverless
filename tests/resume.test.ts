import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryCheckpoints, type PipelineContext } from "../src/lib/pipeline/context";
import { embedding } from "../src/lib/pipeline/steps/embedding";
import { extraction } from "../src/lib/pipeline/steps/extraction";
import type { CommentRow } from "../src/types/project";

// M3 受け入れ基準: 実行途中で中断 → 再実行で未処理分のみ実行される

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeCtx(): PipelineContext {
  return {
    chat: { baseUrl: "https://mock/v1", apiKey: "k", model: "m" },
    embedding: { baseUrl: "https://mock/v1", apiKey: "k", model: "emb" },
    concurrency: 1, // 順次実行にして中断位置を決定的にする
    checkpoints: memoryCheckpoints(),
  };
}

const comments: CommentRow[] = Array.from({ length: 6 }, (_, i) => ({
  commentId: String(i),
  body: `コメント${i}`,
  attributes: {},
}));

describe("extraction の中断と再開", () => {
  it("中断後の再実行では処理済みコメントを再呼び出ししない", async () => {
    const ctx = makeCtx();
    const controller = new AbortController();
    ctx.signal = controller.signal;

    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        // 3件目の完了後に中断する
        if (calls === 3) controller.abort();
        const body = JSON.parse(String(init?.body));
        const userContent = body.messages[body.messages.length - 1].content as string;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ extractedOpinionList: [`${userContent}の意見`] }) } }],
            usage: {},
          }),
          { status: 200 },
        );
      }),
    );

    await expect(extraction(comments, "prompt", ctx)).rejects.toThrow();
    const callsBeforeResume = calls;
    expect(callsBeforeResume).toBeLessThan(comments.length);

    // 再開: 同じチェックポイントで signal なし
    ctx.signal = undefined;
    const result = await extraction(comments, "prompt", ctx);
    expect(result.args).toHaveLength(comments.length);
    // 再実行分 = 全体 - チェックポイント済み(中断時に完了保存された件数)
    expect(calls).toBeLessThanOrEqual(callsBeforeResume + comments.length - 2);
    // 全コメントの意見が揃っている
    expect(result.args.map((a) => a.argument).sort()).toEqual(comments.map((c) => `${c.body}の意見`).sort());
  });
});

describe("embedding のバッチ再開", () => {
  it("チェックポイント済みバッチは API を呼ばない", async () => {
    const ctx = makeCtx();
    const args = Array.from({ length: 150 }, (_, i) => ({ argId: `A${i}_0`, argument: `意見${i}` }));

    let apiCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        apiCalls++;
        const body = JSON.parse(String(init?.body));
        const texts = body.input as string[];
        return new Response(
          JSON.stringify({
            data: texts.map((_, i) => ({ index: i, embedding: [i, i + 1, i + 2] })),
            usage: {},
          }),
          { status: 200 },
        );
      }),
    );

    const first = await embedding(args, ctx);
    expect(apiCalls).toBe(2); // 100 + 50
    expect(first.dim).toBe(3);
    expect(first.vectors).toHaveLength(150 * 3);

    // 再実行: 全バッチがチェックポイント済みなので API 呼び出しゼロ
    const second = await embedding(args, ctx);
    expect(apiCalls).toBe(2);
    expect(Array.from(second.vectors)).toEqual(Array.from(first.vectors));
  });
});
