import { describe, expect, it } from "vitest";
import {
  clusterLevels,
  fitRect,
  MAX_PAGES_PER_LEVEL,
  paginate,
  planClusterPages,
  sanitizeFileName,
  truncate,
} from "../src/lib/pptx";
import type { Cluster } from "../src/types/result";

function makeCluster(level: number, id: string): Cluster {
  return { level, id, label: `L${id}`, takeaway: "", value: 1, parent: "", density_rank_percentile: 0 };
}

describe("truncate", () => {
  it("上限以内の文字列はそのまま返す", () => {
    expect(truncate("こんにちは", 5)).toBe("こんにちは");
    expect(truncate("", 10)).toBe("");
  });

  it("上限を超えたら末尾を「…」にして上限文字数に収める", () => {
    const out = truncate("あいうえおかきくけこ", 5);
    expect(out).toBe("あいうえ…");
    expect(out.length).toBe(5);
  });

  it("上限が 0 以下なら空文字を返す", () => {
    expect(truncate("abc", 0)).toBe("");
    expect(truncate("abc", -1)).toBe("");
  });
});

describe("sanitizeFileName", () => {
  it("Windows で使えない文字を除去する", () => {
    expect(sanitizeFileName('市政<への>意見: "2026/07" 集計|結果?*')).toBe("市政への意見 202607 集計結果");
  });

  it("空・空白のみ・不正文字のみは report にフォールバックする", () => {
    expect(sanitizeFileName("")).toBe("report");
    expect(sanitizeFileName("   ")).toBe("report");
    expect(sanitizeFileName('\\/:*?"<>|')).toBe("report");
  });

  it("末尾のドットを落とし、連続空白を1つにまとめる", () => {
    expect(sanitizeFileName("レポート  最終版...")).toBe("レポート 最終版");
  });
});

describe("clusterLevels", () => {
  it("level > 0 の階層番号を重複なし昇順で返す", () => {
    const clusters = [makeCluster(2, "a"), makeCluster(0, "root"), makeCluster(1, "b"), makeCluster(2, "c")];
    expect(clusterLevels(clusters)).toEqual([1, 2]);
  });

  it("空配列・null・undefined でも落ちない", () => {
    expect(clusterLevels([])).toEqual([]);
    expect(clusterLevels(null)).toEqual([]);
    expect(clusterLevels(undefined)).toEqual([]);
  });
});

describe("planClusterPages", () => {
  it("3件以下は1列レイアウト", () => {
    const plan = planClusterPages(3);
    expect(plan.cols).toBe(1);
    expect(plan.perPage).toBe(3);
    expect(plan.pageCount).toBe(1);
    expect(plan.shownCount).toBe(3);
    expect(plan.omittedCount).toBe(0);
  });

  it("4件以上は2列レイアウトで、続きページでも列数が変わらない(総数で決まる)", () => {
    const plan = planClusterPages(7);
    expect(plan.cols).toBe(2);
    expect(plan.perPage).toBe(6);
    expect(plan.pageCount).toBe(2); // 6 + 1
  });

  it("0件ならページを作らない", () => {
    const plan = planClusterPages(0);
    expect(plan.pageCount).toBe(0);
    expect(plan.shownCount).toBe(0);
    expect(plan.omittedCount).toBe(0);
  });

  it("ページ数は上限で打ち切り、超過分を omittedCount として返す", () => {
    // 2列 × 3行 × 8ページ = 48 件まで。300 件なら 252 件が省略される
    const plan = planClusterPages(300);
    expect(plan.pageCount).toBe(MAX_PAGES_PER_LEVEL);
    expect(plan.shownCount).toBe(48);
    expect(plan.omittedCount).toBe(252);
  });

  it("ちょうど上限いっぱいのときは省略なし", () => {
    const plan = planClusterPages(48);
    expect(plan.pageCount).toBe(8);
    expect(plan.shownCount).toBe(48);
    expect(plan.omittedCount).toBe(0);
  });
});

describe("paginate", () => {
  it("perPage 件ずつに分割し、端数は最終ページに入る", () => {
    expect(paginate([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("空配列は空のページ一覧になる", () => {
    expect(paginate([], 3)).toEqual([]);
  });

  it("perPage が 0 以下なら空を返す(無限ループしない)", () => {
    expect(paginate([1, 2], 0)).toEqual([]);
  });
});

describe("fitRect(枠内中央配置)", () => {
  const box = { x: 1, y: 1, w: 8, h: 4 };

  it("4:3 の横長画像は高さ基準で収まり、水平中央に置かれる", () => {
    const r = fitRect(1280, 960, box);
    // h=4 に合わせて w = 4 * 4/3 ≈ 5.333
    expect(r.h).toBeCloseTo(4);
    expect(r.w).toBeCloseTo(16 / 3);
    expect(r.x).toBeCloseTo(1 + (8 - 16 / 3) / 2);
    expect(r.y).toBeCloseTo(1);
  });

  it("正方形(旧生成)は高さ基準で収まる", () => {
    const r = fitRect(1024, 1024, box);
    expect(r.w).toBeCloseTo(4);
    expect(r.h).toBeCloseTo(4);
    expect(r.x).toBeCloseTo(1 + 2);
  });

  it("横に極端に長い画像は幅基準で収まり、垂直中央に置かれる", () => {
    const r = fitRect(4000, 500, box);
    expect(r.w).toBeCloseTo(8);
    expect(r.h).toBeCloseTo(1);
    expect(r.y).toBeCloseTo(1 + 1.5);
  });

  it("枠より小さい画像は拡大されて収まる(スライドでは常に枠いっぱいを使う)", () => {
    const r = fitRect(4, 3, box);
    expect(r.h).toBeCloseTo(4);
    expect(r.w).toBeCloseTo(16 / 3);
  });

  it("寸法が不明(0)なら枠をそのまま返す", () => {
    expect(fitRect(0, 0, box)).toEqual(box);
  });
});
