import { describe, expect, it } from "vitest";
import {
  estimateChatUsd,
  estimateCost,
  estimateEmbeddingUsd,
  estimateSlotCosts,
  estimateUsd,
} from "../src/lib/estimate";
import type { CommentRow } from "../src/types/project";

// コスト見積り。特に「ローカル実行はスロットごとに 0 円」の扱い
// (チャットだけ Gemini Nano・埋め込みは API という構成で 0 円と誤表示していた)

const comments: CommentRow[] = Array.from({ length: 50 }, (_, i) => ({
  commentId: String(i),
  body: `この法案に賛成する理由は、より良い社会が作れると思うからです(${i})`,
  attributes: {},
}));

const promptChars = { extraction: 500, initialLabelling: 400, mergeLabelling: 400, overview: 300 };
const estimate = estimateCost(comments, promptChars, [3, 9], 30);

describe("estimateUsd のローカル実行判定", () => {
  it("チャットと埋め込みの費用は分けて計算できる", () => {
    expect(estimateChatUsd(estimate)).toBeGreaterThan(0);
    expect(estimateEmbeddingUsd(estimate)).toBeGreaterThan(0);
    expect(estimateUsd(estimate)).toBeCloseTo(estimateChatUsd(estimate) + estimateEmbeddingUsd(estimate), 10);
  });

  it("チャットだけローカルなら埋め込み分は残る(0 円にしない)", () => {
    const usd = estimateUsd(estimate, undefined, { chat: true });
    expect(usd).toBeCloseTo(estimateEmbeddingUsd(estimate), 10);
    expect(usd).toBeGreaterThan(0);
  });

  it("埋め込みだけローカルならチャット分は残る", () => {
    const usd = estimateUsd(estimate, undefined, { embedding: true });
    expect(usd).toBeCloseTo(estimateChatUsd(estimate), 10);
    expect(usd).toBeGreaterThan(0);
  });

  it("両方ローカルなら 0 円", () => {
    expect(estimateUsd(estimate, undefined, { chat: true, embedding: true })).toBe(0);
  });

  it("指定なしなら従来どおり全額", () => {
    expect(estimateUsd(estimate, undefined, {})).toBeCloseTo(estimateUsd(estimate), 10);
  });
});

describe("estimateSlotCosts(選択中モデルの単価を使う)", () => {
  const openai = "https://api.openai.com/v1";
  const embSmall = { model: "text-embedding-3-small", baseUrl: openai };

  it("高いチャットモデルを選ぶと見積りも高くなる", () => {
    const nano = estimateSlotCosts(estimate, { model: "gpt-5-nano", baseUrl: openai }, embSmall);
    const sol = estimateSlotCosts(estimate, { model: "gpt-5.6-sol", baseUrl: openai }, embSmall);
    expect(nano.chat.kind).toBe("usd");
    expect(sol.chat.kind).toBe("usd");
    // gpt-5-nano $0.05/$0.40 に対し gpt-5.6-sol $5.00/$30.00
    expect(sol.knownTotalUsd).toBeGreaterThan(nano.knownTotalUsd * 10);
  });

  it("埋め込みモデルの単価も反映される(3-large は 3-small より高い)", () => {
    const chat = { model: "gpt-5.4-nano", baseUrl: openai };
    const small = estimateSlotCosts(estimate, chat, embSmall);
    const large = estimateSlotCosts(estimate, chat, { model: "text-embedding-3-large", baseUrl: openai });
    const smallCost = small.embedding.kind === "usd" ? small.embedding.usd : 0;
    const largeCost = large.embedding.kind === "usd" ? large.embedding.usd : 0;
    expect(largeCost).toBeCloseTo(smallCost * (0.13 / 0.02), 6);
  });

  it("Anthropic のチャットモデルも単価が引ける", () => {
    const r = estimateSlotCosts(
      estimate,
      { model: "claude-haiku-4-5", baseUrl: "https://api.anthropic.com/v1" },
      embSmall,
    );
    expect(r.chat.kind).toBe("usd");
    expect(r.hasUnknown).toBe(false);
  });

  it("ローカル実行のスロットは 0 円で、もう一方は課金される", () => {
    const r = estimateSlotCosts(estimate, { model: "gemini-nano", baseUrl: "local:gemini-nano" }, embSmall);
    expect(r.chat.kind).toBe("local");
    expect(r.embedding.kind).toBe("usd");
    expect(r.knownTotalUsd).toBeGreaterThan(0); // ここが 0 だと「全部無料」の誤表示になる
  });

  it("両方ローカルなら合計 0 円", () => {
    const r = estimateSlotCosts(
      estimate,
      { model: "gemini-nano", baseUrl: "local:gemini-nano" },
      { model: "Xenova/multilingual-e5-small", baseUrl: "local:embedding" },
    );
    expect(r.knownTotalUsd).toBe(0);
    expect(r.hasUnknown).toBe(false);
  });

  it("単価不明のモデルは金額を出さず hasUnknown で示す", () => {
    const r = estimateSlotCosts(estimate, { model: "my-local-llm", baseUrl: "http://localhost:1234/v1" }, embSmall);
    expect(r.chat.kind).toBe("unknown");
    expect(r.hasUnknown).toBe(true);
    // 既知の埋め込み分だけが合計に入る
    expect(r.knownTotalUsd).toBeCloseTo(estimateEmbeddingUsd(estimate, { input: 0, output: 0, embedding: 0.02 }), 10);
  });

  it("Flex ティアは約50%割引になる", () => {
    const std = estimateSlotCosts(estimate, { model: "gpt-5.4-nano", baseUrl: openai }, embSmall);
    const flex = estimateSlotCosts(estimate, { model: "gpt-5.4-nano", baseUrl: openai, serviceTier: "flex" }, embSmall);
    const stdChat = std.chat.kind === "usd" ? std.chat.usd : 0;
    const flexChat = flex.chat.kind === "usd" ? flex.chat.usd : 0;
    expect(flexChat).toBeCloseTo(stdChat * 0.5, 10);
  });
});
