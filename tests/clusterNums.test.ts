import { describe, expect, it } from "vitest";
import { calculateRecommendedClusterNums } from "../src/lib/pipeline/clusterNums";

// 本家 calculate_recommended_cluster_nums と同じ挙動を検証する

describe("calculateRecommendedClusterNums", () => {
  it("1000 -> [10, 100]", () => {
    expect(calculateRecommendedClusterNums(1000)).toEqual([10, 100]);
  });

  it("125 -> [5, 25]", () => {
    expect(calculateRecommendedClusterNums(125)).toEqual([5, 25]);
  });

  it("lv1 は 10 でクランプされる", () => {
    expect(calculateRecommendedClusterNums(100000)).toEqual([10, 100]);
  });

  it("lv2 は N でクランプされる", () => {
    // N=10: lv1 = round(10^(1/3)) = 2, lv2 = min(1000, 10, 4) = 4
    expect(calculateRecommendedClusterNums(10)).toEqual([2, 4]);
  });

  it("lv1 == lv2 なら1要素", () => {
    // N=2: lv1 = 2 (clamp), lv2 = min(1000, 2, 4) = 2
    expect(calculateRecommendedClusterNums(2)).toEqual([2]);
  });

  it("2未満はエラー", () => {
    expect(() => calculateRecommendedClusterNums(1)).toThrow();
  });
});
