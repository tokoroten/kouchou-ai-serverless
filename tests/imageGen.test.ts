import { describe, expect, it } from "vitest";
import { buildPonchiePrompt } from "../src/lib/imageGen";
import type { Result } from "../src/types/result";

const makeResult = (overrides: Partial<Result> = {}): Result => ({
  arguments: [],
  clusters: [
    {
      level: 0,
      id: "root",
      label: "全体",
      takeaway: "",
      value: 10,
      parent: "",
      density_rank_percentile: 0,
    },
    {
      level: 1,
      id: "c1",
      label: "AIによる業務効率化",
      takeaway: "AIで作業を自動化すべき",
      value: 5,
      parent: "root",
      density_rank_percentile: 0.5,
    },
    {
      level: 1,
      id: "c2",
      label: "教育分野への活用",
      takeaway: "教育現場でのAI活用を進める",
      value: 5,
      parent: "root",
      density_rank_percentile: 0.5,
    },
  ],
  comments: {},
  propertyMap: {},
  translations: {},
  overview: "市民からAI活用について幅広い意見が寄せられました。",
  config: {
    name: "AIに関するパブリックコンサルテーション",
    question: "AIについてどう思いますか？",
    input: "",
    model: "gpt-4o-mini",
    intro: "",
    output_dir: "",
    is_embedded_at_local: false,
    extraction: {
      workers: 8,
      limit: 0,
      properties: [],
      categories: {},
      category_batch_size: 0,
      source_code: "",
      prompt: "",
      model: "",
    },
    hierarchical_clustering: { cluster_nums: [2, 4], source_code: "" },
    embedding: { model: "", source_code: "" },
    hierarchical_initial_labelling: { workers: 8, source_code: "", prompt: "", model: "" },
    hierarchical_merge_labelling: { workers: 8, source_code: "", prompt: "", model: "" },
    hierarchical_overview: { source_code: "", prompt: "", model: "" },
    hierarchical_aggregation: { hidden_properties: {}, source_code: "" },
    plan: [],
    status: "completed",
  },
  comment_num: 10,
  ...overrides,
});

describe("buildPonchiePrompt", () => {
  it("タイトルとクラスタラベルがプロンプトに含まれる", () => {
    const result = makeResult();
    const prompt = buildPonchiePrompt(result);
    expect(prompt).toContain("AIに関するパブリックコンサルテーション");
    expect(prompt).toContain("AIによる業務効率化");
    expect(prompt).toContain("教育分野への活用");
  });

  it("概要がプロンプトに含まれる", () => {
    const result = makeResult();
    const prompt = buildPonchiePrompt(result);
    expect(prompt).toContain("市民からAI活用について幅広い意見が寄せられました。");
  });

  it("クラスタが存在しない場合でもクラッシュしない", () => {
    const result = makeResult({ clusters: [] });
    expect(() => buildPonchiePrompt(result)).not.toThrow();
  });

  it("概要が長い場合は300文字で切り詰める", () => {
    const longOverview = "あ".repeat(500);
    const result = makeResult({ overview: longOverview });
    const prompt = buildPonchiePrompt(result);
    // 切り詰めた概要(300文字)がプロンプトに含まれ、500文字は含まれない
    expect(prompt).toContain("あ".repeat(300));
    expect(prompt).not.toContain("あ".repeat(301));
  });

  it("configがない場合でもデフォルトタイトルを使う", () => {
    const result = makeResult({ config: undefined as unknown as Result["config"] });
    const prompt = buildPonchiePrompt(result);
    expect(prompt).toContain("広聴AIレポート");
  });

  it("最深レベルのクラスタラベルだけを使う", () => {
    // level 1 と level 2 がある場合、level 2 のラベルのみを使う
    const result = makeResult({
      clusters: [
        { level: 0, id: "root", label: "全体", takeaway: "", value: 10, parent: "", density_rank_percentile: 0 },
        {
          level: 1,
          id: "c1",
          label: "上位グループA",
          takeaway: "",
          value: 5,
          parent: "root",
          density_rank_percentile: 0,
        },
        {
          level: 2,
          id: "c1-1",
          label: "下位グループX",
          takeaway: "",
          value: 3,
          parent: "c1",
          density_rank_percentile: 0,
        },
      ],
    });
    const prompt = buildPonchiePrompt(result);
    expect(prompt).toContain("下位グループX");
    expect(prompt).not.toContain("上位グループA");
  });
});
