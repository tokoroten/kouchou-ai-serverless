import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryCheckpoints, type PipelineContext } from "../src/lib/pipeline/context";
import { extraction } from "../src/lib/pipeline/steps/extraction";
import type { CommentRow } from "../src/types/project";

// extraction の重複排除・arg_id 形式・チェックポイント再開を fetch モックで検証する

function makeCtx(): PipelineContext {
  return {
    chat: { baseUrl: "https://mock/v1", apiKey: "k", model: "m" },
    embedding: { baseUrl: "https://mock/v1", apiKey: "k", model: "m" },
    concurrency: 2,
    checkpoints: memoryCheckpoints(),
  };
}

function mockChatFetch(responder: (userContent: string) => string[]) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const userContent = body.messages[body.messages.length - 1].content as string;
    const list = responder(userContent);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ extractedOpinionList: list }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200 },
    );
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extraction", () => {
  const comments: CommentRow[] = [
    { commentId: "10", body: "コメント1", attributes: {} },
    { commentId: "20", body: "コメント2", attributes: {} },
  ];

  it("arg_id は A{commentId}_{j} 形式で、重複意見は最初の arg_id に集約される", async () => {
    vi.stubGlobal(
      "fetch",
      mockChatFetch((content) => (content === "コメント1" ? ["意見X", "意見Y"] : ["意見X", "意見Z"])),
    );
    const result = await extraction(comments, "prompt", makeCtx());
    // 「意見X」は最初の A10_0 に集約され、args は3件
    expect(result.args.map((a) => a.argId).sort()).toEqual(["A10_0", "A10_1", "A20_1"]);
    expect(result.args.find((a) => a.argId === "A10_0")?.argument).toBe("意見X");
    // relations は4件(重複含む)
    expect(result.relations).toHaveLength(4);
    expect(result.relations.filter((r) => r.argId === "A10_0").map((r) => r.commentId)).toEqual(["10", "20"]);
  });

  it("チェックポイント済みコメントは再呼び出ししない", async () => {
    const ctx = makeCtx();
    await ctx.checkpoints.putExtraction("10", ["キャッシュ済み意見"]);
    const fetchMock = mockChatFetch(() => ["新規意見"]);
    vi.stubGlobal("fetch", fetchMock);
    const result = await extraction(comments, "prompt", ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1); // コメント2のみ
    expect(result.args.map((a) => a.argument).sort()).toEqual(["キャッシュ済み意見", "新規意見"]);
  });

  it("全件失敗ならエラー", async () => {
    vi.stubGlobal(
      "fetch",
      mockChatFetch(() => []),
    );
    await expect(extraction(comments, "prompt", makeCtx())).rejects.toThrow();
  });

  it("トークン使用量が集計される", async () => {
    vi.stubGlobal(
      "fetch",
      mockChatFetch(() => ["意見"]),
    );
    const ctx = makeCtx();
    let total = 0;
    ctx.onUsage = (u) => {
      total += u.total;
    };
    await extraction(comments, "prompt", ctx);
    expect(total).toBe(30);
  });
});

it("正常な0件を診断に残し、失敗はキャッシュしない", async () => {
  const ctx = makeCtx();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const input = body.messages.at(-1).content;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: input === "empty" ? '{"extractedOpinionList":[]}' : "broken JSON" } }],
        }),
        { status: 200 },
      );
    }),
  );
  await expect(extraction([{ commentId: "e", body: "empty", attributes: {} }], "p", ctx)).rejects.toThrow("1件も");
  expect(await ctx.checkpoints.getChunk("extraction-diagnostics", "e")).toMatchObject({
    status: "empty",
    comment: "empty",
  });
  await expect(extraction([{ commentId: "f", body: "private input", attributes: {} }], "p", ctx)).rejects.toThrow(
    "回答ID f",
  );
  expect(await ctx.checkpoints.getExtraction("f")).toBeUndefined();
  expect(await ctx.checkpoints.getChunk("extraction-diagnostics", "f")).toMatchObject({
    status: "error",
    comment: "private input",
  });
});

it("一部失敗でも完成扱いせず、再試行は成功済み入力を再送しない", async () => {
  const ctx = makeCtx();
  const rows = [
    { commentId: "a", body: "a", attributes: {} },
    { commentId: "b", body: "b", attributes: {} },
  ];
  const bad = vi.fn(async (_url, init) => {
    const input = JSON.parse(String(init?.body)).messages.at(-1).content;
    return new Response(
      JSON.stringify({
        choices: [
          { message: { content: input === "a" ? '{"extractedOpinionList":["ok"]}' : '{"extractedOpinionList":[42]}' } },
        ],
      }),
    );
  });
  vi.stubGlobal("fetch", bad);
  await expect(extraction(rows, "p", ctx)).rejects.toThrow("回答ID b");
  expect(await ctx.checkpoints.getExtraction("a")).toEqual(["ok"]);
  expect(await ctx.checkpoints.getExtraction("b")).toBeUndefined();
  const retry = mockChatFetch(() => ["recovered"]);
  vi.stubGlobal("fetch", retry);
  expect((await extraction(rows, "p", ctx)).args).toHaveLength(2);
  expect(retry).toHaveBeenCalledTimes(1);
  expect(await ctx.checkpoints.getChunk("extraction-diagnostics", "b")).toEqual({ commentId: "b", status: "ok" });
});
