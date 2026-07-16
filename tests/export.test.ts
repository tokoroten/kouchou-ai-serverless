import { describe, expect, it } from "vitest";
import { parsePreprocessed, parseResultJson, serializePreprocessed } from "../src/lib/export";

describe("parseResultJson", () => {
  it("最低限のスキーマ検証を行う", () => {
    expect(() => parseResultJson('{"foo": 1}')).toThrow();
    const ok = parseResultJson(
      JSON.stringify({ arguments: [], clusters: [], overview: "o", comments: {}, comment_num: 0 }),
    );
    expect(ok.overview).toBe("o");
  });

  it("欠けたフィールドを補完する", () => {
    const result = parseResultJson(JSON.stringify({ arguments: [], clusters: [] }));
    expect(result.overview).toBe("");
    expect(result.translations).toEqual({});
    expect(result.comment_num).toBe(0);
  });
});

describe("前処理データの直列化", () => {
  it("プロジェクト情報と embeddings がラウンドトリップする", () => {
    const project = {
      title: "T",
      question: "Q",
      intro: "I",
      comments: [{ commentId: "0", body: "コメント", attributes: { age: "20代" } }],
      attributeColumns: ["age"],
      clusterNums: [2, 4],
      samplingNum: 30,
      prompts: { extraction: "e", initialLabelling: "i", mergeLabelling: "m", overview: "o" },
    };
    const extraction = {
      args: [
        { argId: "A0_0", argument: "a" },
        { argId: "A1_0", argument: "b" },
      ],
      relations: [
        { argId: "A0_0", commentId: "0" },
        { argId: "A1_0", commentId: "1" },
      ],
    };
    const embedding = {
      argIds: ["A0_0", "A1_0"],
      dim: 3,
      vectors: Float32Array.from([1.5, -2.25, 0, 0.125, 4, -8]),
    };
    const text = serializePreprocessed(project, extraction, embedding);
    const parsed = parsePreprocessed(text);
    expect(parsed.project).toEqual(project);
    expect(parsed.extraction).toEqual(extraction);
    expect(parsed.embedding.dim).toBe(3);
    expect(Array.from(parsed.embedding.vectors)).toEqual([1.5, -2.25, 0, 0.125, 4, -8]);
  });

  it("不正なファイルは拒否する", () => {
    expect(() => parsePreprocessed('{"type": "other"}')).toThrow();
    expect(() => parsePreprocessed('{"type": "kouchou-ai-preprocessed"}')).toThrow();
  });
});
