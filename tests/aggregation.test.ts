import { describe, expect, it } from "vitest";
import { buildClusterTable } from "../src/lib/pipeline/clusterTable";
import {
  aggregation,
  buildParentChildMapping,
  calculateDensity,
  meltClusters,
} from "../src/lib/pipeline/steps/aggregation";
import type { ClusteringResult, ExtractedArgument, LabellingResult } from "../src/types/project";

// cluster_ids 組み立て・親子関係・密度パーセンタイル・Result スキーマの検証(DESIGN §9-5)

function fixtures() {
  const args: ExtractedArgument[] = [
    { argId: "A0_0", argument: "意見A" },
    { argId: "A0_1", argument: "意見B" },
    { argId: "A1_0", argument: "意見C" },
    { argId: "A2_0", argument: "意見D" },
  ];
  const clustering: ClusteringResult = {
    argIds: ["A0_0", "A0_1", "A1_0", "A2_0"],
    x: Float32Array.from([0, 0.1, 5, 5.1]),
    y: Float32Array.from([0, 0.1, 5, 5.1]),
    clusterNums: [2, 4],
    // level1: 2クラスタ(1,2), level2: 4クラスタ(0..3)
    assignments: [Int32Array.from([1, 1, 2, 2]), Int32Array.from([0, 1, 2, 3])],
  };
  const table = buildClusterTable(args, clustering);
  const labels: LabellingResult = {
    byLevel: {
      1: [
        { clusterId: "1_1", label: "L1-1", description: "D1-1" },
        { clusterId: "1_2", label: "L1-2", description: "D1-2" },
      ],
      2: [
        { clusterId: "2_0", label: "L2-0", description: "D2-0" },
        { clusterId: "2_1", label: "L2-1", description: "D2-1" },
        { clusterId: "2_2", label: "L2-2", description: "D2-2" },
        { clusterId: "2_3", label: "L2-3", description: "D2-3" },
      ],
    },
  };
  return { args, clustering, table, labels };
}

describe("buildParentChildMapping", () => {
  it("level1 の親は 0、level2 の親は所属する level1", () => {
    const { table } = fixtures();
    const mapping = buildParentChildMapping(table);
    expect(mapping.get("1_1")).toBe("0");
    expect(mapping.get("1_2")).toBe("0");
    expect(mapping.get("2_0")).toBe("1_1");
    expect(mapping.get("2_1")).toBe("1_1");
    expect(mapping.get("2_2")).toBe("1_2");
    expect(mapping.get("2_3")).toBe("1_2");
  });
});

describe("calculateDensity", () => {
  it("密集したクラスタほど密度が高い", () => {
    const dense = calculateDensity([0, 0.1], [0, 0.1]);
    const sparse = calculateDensity([0, 10], [0, 10]);
    expect(dense).toBeGreaterThan(sparse);
  });
});

describe("meltClusters", () => {
  it("level ごとに件数と密度パーセンタイルを計算する", () => {
    const { table, labels } = fixtures();
    const melted = meltClusters(table, labels);
    const level1 = melted.filter((c) => c.level === 1);
    expect(level1).toHaveLength(2);
    expect(level1.find((c) => c.id === "1_1")?.value).toBe(2);
    // パーセンタイルは (rank / count) で 0 < p <= 1
    for (const c of melted) {
      expect(c.densityRankPercentile).toBeGreaterThan(0);
      expect(c.densityRankPercentile).toBeLessThanOrEqual(1);
    }
  });
});

describe("aggregation", () => {
  it("本家互換の Result JSON を組み立てる", () => {
    const { table, labels } = fixtures();
    const result = aggregation({
      project: {
        title: "テスト",
        question: "Q",
        intro: "I",
        attributeColumns: ["age"],
        clusterNums: [2, 4],
        prompts: { extraction: "e", initialLabelling: "i", mergeLabelling: "m", overview: "o" },
        samplingNum: 30,
      },
      comments: [
        { commentId: "0", body: "コメント0", attributes: { age: "20代" } },
        { commentId: "1", body: "コメント1", attributes: { age: "30代" } },
        { commentId: "2", body: "コメント2", attributes: {} },
      ],
      extractionResult: {
        args: [
          { argId: "A0_0", argument: "意見A" },
          { argId: "A0_1", argument: "意見B" },
          { argId: "A1_0", argument: "意見C" },
          { argId: "A2_0", argument: "意見D" },
        ],
        relations: [
          { argId: "A0_0", commentId: "0" },
          { argId: "A0_1", commentId: "0" },
          { argId: "A1_0", commentId: "1" },
          { argId: "A2_0", commentId: "2" },
        ],
      },
      table,
      labels,
      overviewText: "全体概要",
      chatModel: "gpt-4o-mini",
      embeddingModel: "text-embedding-3-small",
      workers: 8,
    });

    // cluster_ids: ルート "0" + 全レベル
    expect(result.arguments[0].cluster_ids).toEqual(["0", "1_1", "2_0"]);
    expect(result.arguments[2].cluster_ids).toEqual(["0", "1_2", "2_2"]);
    // arg_id 形式
    expect(result.arguments[0].arg_id).toBe("A0_0");
    // comment_id は数値化される(本家サンプル互換)
    expect(result.arguments[0].comment_id).toBe(0);
    // ルートクラスタ
    const root = result.clusters[0];
    expect(root).toMatchObject({ level: 0, id: "0", label: "全体", parent: "", value: 4 });
    // クラスタ数: ルート + 2 + 4
    expect(result.clusters).toHaveLength(7);
    // parent 参照整合性: 全クラスタの parent は存在する ID か空
    const ids = new Set(result.clusters.map((c) => c.id));
    for (const cluster of result.clusters) {
      if (cluster.parent !== "") expect(ids.has(cluster.parent)).toBe(true);
    }
    // comments / propertyMap / attributes
    expect(result.comments["0"]).toEqual({ comment: "コメント0" });
    expect(result.comment_num).toBe(3);
    expect(result.propertyMap.age.A0_0).toBe("20代");
    expect(result.arguments[0].attributes).toEqual({ age: "20代" });
    expect(result.arguments[3].attributes).toBeUndefined();
    // overview / config
    expect(result.overview).toBe("全体概要");
    expect(result.config.question).toBe("Q");
    expect(result.translations).toEqual({});
  });
});
