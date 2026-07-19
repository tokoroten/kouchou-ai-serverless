import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canRecluster, projectFromResult } from "../src/lib/reportProject";
import type { Result } from "../src/types/result";
import type { Settings } from "../src/types/settings";

// サンプルレポート(生成元プロジェクトが存在しない)から、クラスタリング再実行用の
// プロジェクトを復元できることを確認する。

const result = JSON.parse(readFileSync("public/sample-report.json", "utf8")) as Result;

const settings = {
  chatSlot: { provider: null, model: "" },
  embeddingSlot: { provider: null, model: "" },
  imageSlot: { provider: null, model: "" },
  concurrency: 8,
} as unknown as Settings;

describe("projectFromResult", () => {
  it("サンプルレポートは再クラスタリング可能", () => {
    expect(canRecluster(result)).toBe(true);
  });

  it("意見・コメント・座標・階層割当を復元する", () => {
    const { project, extraction, clustering } = projectFromResult(result, {
      id: "p1",
      reportId: "sample",
      title: "サンプル",
      settings,
    });

    expect(extraction.args).toHaveLength(result.arguments.length);
    expect(extraction.relations).toHaveLength(result.arguments.length);
    expect(project.comments).toHaveLength(Object.keys(result.comments).length);
    expect(project.reportId).toBe("sample");
    expect(project.attributeColumns).toEqual(Object.keys(result.propertyMap));
    // 属性は意見側から引き当てる
    expect(project.comments[0].attributes.age).toBe(String(result.arguments[0].attributes?.age));

    // 座標は意見と同順・同数
    expect(clustering.argIds).toHaveLength(result.arguments.length);
    expect(clustering.x[0]).toBeCloseTo(result.arguments[0].x, 5);
    expect(clustering.y[0]).toBeCloseTo(result.arguments[0].y, 5);
    // cluster_ids から階層ごとの割当を復元(未割当 -1 が残らないこと)
    expect(clustering.assignments).toHaveLength(2);
    for (const labels of clustering.assignments) {
      expect(Math.min(...labels)).toBeGreaterThanOrEqual(0);
    }
    expect(clustering.clusterNums).toEqual(result.config.hierarchical_clustering.cluster_nums);
    // プロンプトはレポートの config から引き継ぐ
    expect(project.prompts.extraction).toBe(result.config.extraction.prompt);
  });

  it("座標の無いレポートは再クラスタリング不可", () => {
    const broken = { ...result, arguments: result.arguments.map((a) => ({ ...a, x: Number.NaN })) };
    expect(canRecluster(broken)).toBe(false);
  });
});
