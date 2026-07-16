import { afterEach, describe, expect, it, vi } from "vitest";
import { buildClusterTable } from "../src/lib/pipeline/clusterTable";
import { type PipelineContext, memoryCheckpoints } from "../src/lib/pipeline/context";
import { LABEL_ERROR_PLACEHOLDER, initialLabelling, mergeLabelling } from "../src/lib/pipeline/steps/labelling";
import type { ClusteringResult, ExtractedArgument } from "../src/types/project";

afterEach(() => {
  vi.unstubAllGlobals();
});

function fixtures() {
  const args: ExtractedArgument[] = [
    { argId: "A0_0", argument: "意見A" },
    { argId: "A1_0", argument: "意見B" },
    { argId: "A2_0", argument: "意見C" },
    { argId: "A3_0", argument: "意見D" },
  ];
  const clustering: ClusteringResult = {
    argIds: args.map((a) => a.argId),
    x: Float32Array.from([0, 0.1, 5, 5.1]),
    y: Float32Array.from([0, 0.1, 5, 5.1]),
    clusterNums: [2, 3],
    // level1: {1: [A0,A1], 2: [A2,A3]}, level2: {0: [A0,A1], 1: [A2], 2: [A3]}
    assignments: [Int32Array.from([1, 1, 2, 2]), Int32Array.from([0, 0, 1, 2])],
  };
  return { args, table: buildClusterTable(args, clustering) };
}

function makeCtx(): PipelineContext {
  return {
    chat: { baseUrl: "https://mock/v1", apiKey: "k", model: "m" },
    embedding: { baseUrl: "https://mock/v1", apiKey: "k", model: "m" },
    concurrency: 2,
    checkpoints: memoryCheckpoints(),
    random: () => 0.5,
  };
}

function stubLabelFetch(fn?: (userContent: string) => { label: string; description: string }) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const userContent = body.messages[body.messages.length - 1].content as string;
      calls.push(userContent);
      const result = fn?.(userContent) ?? { label: `ラベル${calls.length}`, description: `説明${calls.length}` };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }], usage: {} }), {
        status: 200,
      });
    }),
  );
  return calls;
}

describe("initialLabelling", () => {
  it("最深レベルの全クラスタにラベルを付ける", async () => {
    stubLabelFetch();
    const { table } = fixtures();
    const labels = await initialLabelling(table, "prompt", 30, makeCtx());
    expect(labels.map((l) => l.clusterId).sort()).toEqual(["2_0", "2_1", "2_2"]);
    for (const l of labels) {
      expect(l.label).not.toBe(LABEL_ERROR_PLACEHOLDER);
    }
  });

  it("API 失敗時はプレースホルダ(本家と同じ)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("error", { status: 401 })),
    );
    const { table } = fixtures();
    const labels = await initialLabelling(table, "prompt", 30, makeCtx());
    expect(labels.every((l) => l.label === LABEL_ERROR_PLACEHOLDER)).toBe(true);
  });
});

describe("mergeLabelling", () => {
  it("子が1つのクラスタは LLM を呼ばず引き継ぐ", async () => {
    const calls = stubLabelFetch();
    const { table } = fixtures();
    const deepest = [
      { clusterId: "2_0", label: "L0", description: "D0" },
      { clusterId: "2_1", label: "L1", description: "D1" },
      { clusterId: "2_2", label: "L2", description: "D2" },
    ];
    const result = await mergeLabelling(table, deepest, "prompt", 30, makeCtx());
    const level1 = result.byLevel[1];
    // 1_1 の子は 2_0 のみ → 引き継ぎ(LLM 呼び出しなし)
    expect(level1.find((l) => l.clusterId === "1_1")).toMatchObject({ label: "L0", description: "D0" });
    // 1_2 の子は 2_1, 2_2 → LLM 呼び出し1回
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("- L1: D1");
    expect(calls[0]).toContain("- L2: D2");
    expect(calls[0]).toContain("クラスタの意見");
    // 最深レベルのラベルも保持される
    expect(result.byLevel[2]).toEqual(deepest);
  });
});
