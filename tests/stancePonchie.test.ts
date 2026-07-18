import { describe, expect, it } from "vitest";
import {
  buildStancePonchiePrompt,
  formatStanceMix,
  type StancePonchieCluster,
} from "../src/stance-spectrum/ponchiePrompt";

function makeCluster(overrides: Partial<StancePonchieCluster> = {}): StancePonchieCluster {
  return {
    label: "AIの権利付与",
    size: 42,
    stanceMix: { explicitSupport: 20, explicitOpposition: 15, neutralOrDefer: 7 },
    ...overrides,
  };
}

describe("formatStanceMix", () => {
  it("件数の多い順に日本語ラベルで並べる", () => {
    expect(formatStanceMix({ explicitSupport: 20, explicitOpposition: 15, neutralOrDefer: 7 })).toBe(
      "明確な賛成 20 / 明確な反対 15 / 中立・保留 7",
    );
  });

  it("上位3スタンスに絞る", () => {
    const mix = { explicitSupport: 5, explicitOpposition: 4, neutralOrDefer: 3, conditionalSupport: 2, unknown: 1 };
    const formatted = formatStanceMix(mix);
    expect(formatted.split(" / ")).toHaveLength(3);
    expect(formatted).not.toContain("立場不明");
  });

  it("0 件のスタンスは出さない", () => {
    expect(formatStanceMix({ explicitSupport: 3, explicitOpposition: 0 })).toBe("明確な賛成 3");
  });

  it("unknown は「立場不明」と表記する", () => {
    expect(formatStanceMix({ unknown: 2 })).toBe("立場不明 2");
  });
});

describe("buildStancePonchiePrompt", () => {
  it("タイトル・クラスタラベル・賛否内訳を含む", () => {
    const prompt = buildStancePonchiePrompt("AI人権法案の分析", [makeCluster()]);
    expect(prompt).toContain("AI人権法案の分析");
    expect(prompt).toContain("AIの権利付与");
    expect(prompt).toContain("42件");
    expect(prompt).toContain("明確な賛成 20");
  });

  it("LLM 生成の説明があれば含める", () => {
    const prompt = buildStancePonchiePrompt("t", [makeCluster({ description: "権利付与の是非で対立している" })]);
    expect(prompt).toContain("権利付与の是非で対立している");
  });

  it("件数の多い順に10件まで", () => {
    const clusters = Array.from({ length: 20 }, (_, i) =>
      makeCluster({ label: `論点${i}`, size: i + 1, stanceMix: { explicitSupport: 1 } }),
    );
    const prompt = buildStancePonchiePrompt("t", clusters);
    expect(prompt).toContain("論点19"); // 最大サイズ
    expect(prompt).not.toContain("論点0("); // 最小サイズは落ちる
    expect(prompt.match(/^- /gm)).toHaveLength(10);
  });

  it("クラスタが無くても成立し、タイトルが空なら既定名になる", () => {
    const prompt = buildStancePonchiePrompt("", []);
    expect(prompt).toContain("賛否スペクトラム分析");
    expect(prompt).not.toContain("意見グループ");
  });

  it("長い説明が並んでも 3800 字に収まる", () => {
    const clusters = Array.from({ length: 10 }, (_, i) =>
      makeCluster({ label: `論点${i}`, size: 10 - i, description: "あ".repeat(600) }),
    );
    expect(buildStancePonchiePrompt("t", clusters).length).toBeLessThanOrEqual(3800);
  });

  it("賛否の対立構図の指示(左右対置)を含む", () => {
    expect(buildStancePonchiePrompt("t", [makeCluster()])).toContain("賛成側と反対側を左右に対置");
  });
});
