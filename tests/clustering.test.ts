import { describe, expect, it } from "vitest";
import { clusterXY, mergeClustersWithHierarchy, runClusteringCore } from "../src/lib/pipeline/clusteringCore";

// 固定シードでクラスタリングの構造的性質を検証する(DESIGN §9-5)

function makeBlobs(centers: [number, number][], perCluster: number, spread = 0.05): number[][] {
  // 決定的な擬似ブロブ生成
  const points: number[][] = [];
  let state = 42;
  const rand = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648 - 0.5;
  };
  for (const [cx, cy] of centers) {
    for (let i = 0; i < perCluster; i++) {
      points.push([cx + rand() * spread, cy + rand() * spread]);
    }
  }
  return points;
}

describe("mergeClustersWithHierarchy", () => {
  it("重心のマージ先を各点が継承する", () => {
    // 4つの重心: 2つは左側で近接、2つは右側で近接 → 2カットで左右に分かれる
    const centroids = [
      [0, 0],
      [0.1, 0],
      [10, 0],
      [10.1, 0],
    ];
    // 点は重心 0,1,2,3 にそれぞれ属する
    const kmeansLabels = Int32Array.from([0, 0, 1, 2, 3, 3]);
    const merged = mergeClustersWithHierarchy(centroids, kmeansLabels, 2);
    // 重心0,1 は同グループ、重心2,3 は同グループ
    expect(merged[0]).toBe(merged[1]); // どちらも重心0
    expect(merged[1]).toBe(merged[2]); // 重心0 と重心1 は同グループ
    expect(merged[3]).toBe(merged[4]); // 重心2 と重心3 は同グループ
    expect(merged[0]).not.toBe(merged[3]); // 左右は別グループ
    // ラベルは 1 始まり(scipy fcluster 互換)
    for (const label of merged) {
      expect(label).toBeGreaterThanOrEqual(1);
      expect(label).toBeLessThanOrEqual(2);
    }
  });
});

describe("clusterXY", () => {
  it("明確に分離した4ブロブを正しく分割する", () => {
    const points = makeBlobs(
      [
        [0, 0],
        [10, 0],
        [0, 10],
        [10, 10],
      ],
      25,
    );
    const { clusterNums, assignments } = clusterXY(points, [2, 4], "test-seed");
    expect(clusterNums).toEqual([2, 4]);
    expect(assignments).toHaveLength(2);
    // 最深レベル: 4クラスタ。同一ブロブ内の点は同じラベル
    const deepest = assignments[1];
    for (let blob = 0; blob < 4; blob++) {
      const labels = new Set<number>();
      for (let i = blob * 25; i < (blob + 1) * 25; i++) labels.add(deepest[i]);
      expect(labels.size).toBe(1);
    }
    // 4ブロブで4ユニークラベル
    expect(new Set(deepest).size).toBe(4);
    // レベル1: 2クラスタ
    expect(new Set(assignments[0]).size).toBe(2);
  });
});

describe("runClusteringCore", () => {
  it("小規模データで x/y と全レベルの割当を返す(UMAP 経由)", () => {
    // 高次元(8次元)の2ブロブ
    const dim = 8;
    const count = 40;
    const vectors = new Float32Array(count * dim);
    for (let i = 0; i < count; i++) {
      const base = i < count / 2 ? 0 : 5;
      for (let d = 0; d < dim; d++) {
        vectors[i * dim + d] = base + Math.sin(i * 7.13 + d) * 0.1;
      }
    }
    const result = runClusteringCore({ vectors, dim, count, clusterNums: [2, 4], seed: "s" });
    expect(result.x).toHaveLength(count);
    expect(result.y).toHaveLength(count);
    expect(result.clusterNums).toEqual([2, 4]);
    expect(result.assignments).toHaveLength(2);
    expect(new Set(result.assignments[0]).size).toBe(2);
    expect(new Set(result.assignments[1]).size).toBe(4);
  });

  it("同一シードで再現性がある", () => {
    const dim = 4;
    const count = 20;
    const vectors = new Float32Array(count * dim).map((_, i) => Math.sin(i));
    const a = runClusteringCore({ vectors: vectors.slice(), dim, count, clusterNums: [2], seed: "x" });
    const b = runClusteringCore({ vectors: vectors.slice(), dim, count, clusterNums: [2], seed: "x" });
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(Array.from(a.assignments[0])).toEqual(Array.from(b.assignments[0]));
  });
});
