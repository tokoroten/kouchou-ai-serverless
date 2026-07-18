import { describe, expect, it } from "vitest";
import { trackClusters } from "../src/stance-spectrum/clusterTracker";
import { assignTagVector, normalizeTag } from "../src/stance-spectrum/codebook";
import { normalizeStance } from "../src/stance-spectrum/enrich";
import { parseExtractEnrich } from "../src/stance-spectrum/extractEnrich";
import {
  buildCandidateEdges,
  clusterByLayout,
  clusterByLouvain,
  computeEdgeWeights,
} from "../src/stance-spectrum/graph";
import { summarizeCluster } from "../src/stance-spectrum/labelTemplate";
import { sparseCosine, stanceSimilarity } from "../src/stance-spectrum/similarity";
import { migrateNamespace, migrateStep } from "../src/stance-spectrum/storageKeys";
import type { Codebook, OpinionRecord, StanceDistribution } from "../src/stance-spectrum/types";
import { DEFAULT_VIEW, dominantStance, emptyStance, stanceScore } from "../src/stance-spectrum/types";

function stance(partial: Partial<StanceDistribution>): StanceDistribution {
  const s = { ...emptyStance(), unknown: 0, ...partial };
  return normalizeStance(s as unknown as Record<string, unknown>);
}

describe("stanceSimilarity(累積L1)", () => {
  it("同一分布は類似度1", () => {
    const a = stance({ explicitSupport: 1 });
    expect(stanceSimilarity(a, a)).toBeCloseTo(1, 5);
  });

  it("明示的賛成と明示的反対は類似度0(順序軸の両端)", () => {
    const support = stance({ explicitSupport: 1 });
    const opposition = stance({ explicitOpposition: 1 });
    expect(stanceSimilarity(support, opposition)).toBeCloseTo(0, 5);
  });

  it("非反対は賛成より中立に近い(二重否定を賛成へ正規化しない)", () => {
    const nonOpposition = stance({ nonOpposition: 1 });
    const neutral = stance({ neutralOrDefer: 1 });
    const support = stance({ explicitSupport: 1 });
    expect(stanceSimilarity(nonOpposition, neutral)).toBeGreaterThan(stanceSimilarity(nonOpposition, support));
  });

  it("隣接クラスは遠いクラスより類似", () => {
    const conditional = stance({ conditionalSupport: 1 });
    const explicit = stance({ explicitSupport: 1 });
    const opposition = stance({ explicitOpposition: 1 });
    expect(stanceSimilarity(conditional, explicit)).toBeGreaterThan(stanceSimilarity(conditional, opposition));
  });
});

describe("parseExtractEnrich(結合抽出の投入口)", () => {
  it("opinions 配列を argument + enrichment に分解する", () => {
    const response = JSON.stringify({
      opinions: [
        {
          argument: "原発は再稼働すべき",
          target: "原発再稼働",
          topics: [{ label: "エネルギー政策", weight: 0.9 }],
          stance: { ...emptyStance(), unknown: 0, explicitSupport: 1 },
          reasons: [{ label: "安定供給", weight: 0.8 }],
          conditions: [],
          holder: "筆者",
          quotedSpeech: false,
          commitment: 0.9,
          confidence: 0.8,
        },
      ],
    });
    const out = parseExtractEnrich(response);
    expect(out).toHaveLength(1);
    expect(out[0].argument).toBe("原発は再稼働すべき");
    expect(dominantStance(out[0].enrichment.stance)).toBe("explicitSupport");
    expect(out[0].enrichment.topics[0].label).toBe("エネルギー政策");
  });

  it("複数意見を分割し、空文字は落とす", () => {
    const response = JSON.stringify({
      opinions: [
        { argument: "教育を強化すべき", topics: [], stance: emptyStance(), reasons: [] },
        { argument: "  ", topics: [], stance: emptyStance(), reasons: [] },
        { argument: "人材養成が必要", topics: [], stance: emptyStance(), reasons: [] },
      ],
    });
    const out = parseExtractEnrich(response);
    expect(out.map((o) => o.argument)).toEqual(["教育を強化すべき", "人材養成が必要"]);
  });

  it("従来形式(extractedOpinionList / 文字列配列)にフォールバックし enrichment は unknown 立場", () => {
    const response = JSON.stringify({ extractedOpinionList: ["市民教育が必要", "人材養成すべき"] });
    const out = parseExtractEnrich(response);
    expect(out.map((o) => o.argument)).toEqual(["市民教育が必要", "人材養成すべき"]);
    expect(dominantStance(out[0].enrichment.stance)).toBe("unknown");
  });

  it("壊れた JSON は空配列", () => {
    expect(parseExtractEnrich("これは JSON ではない")).toEqual([]);
  });
});

describe("stance ヘルパ", () => {
  it("dominantStance は argmax を返す", () => {
    expect(dominantStance(stance({ nonOpposition: 0.6, neutralOrDefer: 0.4 }))).toBe("nonOpposition");
    expect(dominantStance(emptyStance())).toBe("unknown");
  });

  it("stanceScore は賛成で正・反対で負", () => {
    expect(stanceScore(stance({ explicitSupport: 1 }))).toBeCloseTo(1);
    expect(stanceScore(stance({ explicitOpposition: 1 }))).toBeCloseTo(-1);
    expect(stanceScore(stance({ neutralOrDefer: 1 }))).toBeCloseTo(0);
  });
});

describe("sparseCosine", () => {
  it("同一ベクトルは1、直交は0", () => {
    const a = new Map([
      [0, 1],
      [1, 0.5],
    ]);
    const b = new Map([[2, 1]]);
    expect(sparseCosine(a, a)).toBeCloseTo(1, 5);
    expect(sparseCosine(a, b)).toBe(0);
    expect(sparseCosine(a, new Map())).toBe(0);
  });
});

describe("codebook", () => {
  it("normalizeTag は空白・句読点を除去して小文字化する", () => {
    expect(normalizeTag(" 原発 再稼働。 ")).toBe("原発再稼働");
    expect(normalizeTag("AI Ethics")).toBe("aiethics");
  });

  it("assignTagVector はコードブックにあるタグのみ疎ベクトル化する", () => {
    const index = { 原発再稼働: 0, コスト: 1 };
    const vector = assignTagVector(
      [
        { label: "原発再稼働", weight: 0.9 },
        { label: "未知のタグ", weight: 0.8 },
        { label: "コスト", weight: 0.5 },
      ],
      index,
    );
    expect(vector.get(0)).toBe(0.9);
    expect(vector.get(1)).toBe(0.5);
    expect(vector.size).toBe(2);
  });
});

// ---- グラフ: 合成データで「stance スライダーで分裂する」ことを検証 ----

function makeRecord(id: number, topicIndex: number, s: StanceDistribution): OpinionRecord {
  return {
    id: `A${id}`,
    originalCommentId: String(id),
    claimText: `意見${id}`,
    enrichment: {
      target: null,
      topics: [],
      stance: s,
      reasons: [],
      conditions: [],
      holder: "筆者",
      quotedSpeech: false,
      commitment: 0.8,
      confidence: 0.9,
    },
    topicVector: new Map([[topicIndex, 1]]),
    reasonVector: new Map(),
  };
}

function makeSyntheticData() {
  // トピック2つ × 各トピックに賛成/反対 10件ずつ = 40件
  // 埋め込みはトピックごとに固まる4次元ベクトル
  const records: OpinionRecord[] = [];
  const dim = 4;
  const vectors = new Float32Array(40 * dim);
  for (let i = 0; i < 40; i++) {
    const topic = i < 20 ? 0 : 1;
    const support = i % 2 === 0;
    records.push(makeRecord(i, topic, stance(support ? { explicitSupport: 1 } : { explicitOpposition: 1 })));
    // トピック方向 + わずかなノイズ
    vectors[i * dim + topic] = 1;
    vectors[i * dim + 2] = (i % 5) * 0.01;
    vectors[i * dim + 3] = support ? 0.05 : -0.05;
  }
  return { records, vectors, dim };
}

describe("候補グラフ + Louvain (合成データ)", () => {
  const { records, vectors, dim } = makeSyntheticData();
  const edges = buildCandidateEdges(records, vectors, dim, {
    semanticK: 8,
    stanceK: 4,
    topicSamples: 4,
    reasonSamples: 0,
  });

  it("候補辺はブロック別kNNの和集合として作られる", () => {
    expect(edges.count).toBeGreaterThan(40);
    // stance 近傍により、トピックをまたぐ同 stance 辺も候補に含まれる
    let crossTopic = 0;
    for (let e = 0; e < edges.count; e++) {
      const si = edges.source[e] < 20 ? 0 : 1;
      const ti = edges.target[e] < 20 ? 0 : 1;
      if (si !== ti) crossTopic++;
    }
    expect(crossTopic).toBeGreaterThan(0);
  });

  it("トピック重視ではトピック2クラスタに分かれる", () => {
    const view = { ...DEFAULT_VIEW, semanticWeight: 1, topicWeight: 1, stanceWeight: 0, edgeThreshold: 0.3 };
    const weights = computeEdgeWeights(edges, view, null);
    const communities = clusterByLouvain(40, edges, weights, view, null);
    const topicA = new Set<number>();
    const topicB = new Set<number>();
    for (let i = 0; i < 40; i++) {
      (i < 20 ? topicA : topicB).add(communities[i]);
    }
    // 各トピックがほぼ単一コミュニティで、互いに異なる
    expect(topicA.size).toBeLessThanOrEqual(2);
    expect(topicB.size).toBeLessThanOrEqual(2);
    expect([...topicA].some((c) => topicB.has(c))).toBe(false);
  });

  it("focus+context: 選択クラスタ内で stance を上げると賛否に分裂する", () => {
    // まずトピックビューでクラスタを得る
    const baseView = { ...DEFAULT_VIEW, semanticWeight: 1, topicWeight: 1, edgeThreshold: 0.3 };
    const baseWeights = computeEdgeWeights(edges, baseView, null);
    const baseCommunities = clusterByLouvain(40, edges, baseWeights, baseView, null);
    const tracked = trackClusters(baseCommunities, null);
    const clusterOfTopic0 = tracked.labels[0];
    expect(clusterOfTopic0).not.toBeNull();

    // トピック0 のクラスタを選択し、stance 重みを最大化
    const focusView = {
      ...baseView,
      stanceWeight: 3,
      selectedClusterId: clusterOfTopic0,
      edgeThreshold: 0.35,
    };
    const focusWeights = computeEdgeWeights(edges, focusView, tracked.labels);
    const focusCommunities = clusterByLouvain(40, edges, focusWeights, focusView, tracked.labels);

    // 選択クラスタ内(トピック0)が賛成群と反対群に分かれる
    const supportCommunities = new Set<number>();
    const oppositionCommunities = new Set<number>();
    for (let i = 0; i < 20; i++) {
      if (tracked.labels[i] !== clusterOfTopic0) continue;
      (i % 2 === 0 ? supportCommunities : oppositionCommunities).add(focusCommunities[i]);
    }
    expect([...supportCommunities].some((c) => oppositionCommunities.has(c))).toBe(false);
    // 選択外(トピック1)は再クラスタ対象外(-1 のまま)
    expect(focusCommunities[25]).toBe(-1);
  });
});

describe("trackClusters", () => {
  it("Jaccard 重なりで ID を引き継ぐ", () => {
    const first = trackClusters(Int32Array.from([0, 0, 0, 1, 1, 1]), null);
    expect(new Set(first.labels).size).toBe(2);
    // コミュニティ番号が変わっても構成が同じなら ID は同じ
    const second = trackClusters(Int32Array.from([5, 5, 5, 9, 9, 9]), first);
    expect(second.labels).toEqual(first.labels);
    // 片方が分裂したら、大きい方が ID を維持し、新 ID が発番される
    const third = trackClusters(Int32Array.from([5, 5, 7, 9, 9, 9]), second);
    expect(third.labels[0]).toBe(second.labels[0]);
    expect(third.labels[3]).toBe(second.labels[3]);
    expect(third.labels[2]).not.toBe(second.labels[2]);
  });

  it("frozen の点は前回ラベルを維持する", () => {
    const first = trackClusters(Int32Array.from([0, 0, 1, 1]), null);
    const frozen = [false, false, true, true];
    const next = trackClusters(Int32Array.from([0, 0, -1, -1]), first, frozen);
    expect(next.labels[2]).toBe(first.labels[2]);
    expect(next.labels[3]).toBe(first.labels[3]);
  });
});

describe("summarizeCluster(テンプレートラベル)", () => {
  it("上位 topic + 支配的 stance + 上位 reason からラベルを組み立てる", () => {
    const codebook: Codebook = {
      topics: ["原発再稼働"],
      reasons: ["安全性"],
      topicIndex: { 原発再稼働: 0 },
      reasonIndex: { 安全性: 0 },
    };
    const records: OpinionRecord[] = [0, 1, 2].map((i) => ({
      ...makeRecord(i, 0, stance({ nonOpposition: 1 })),
      reasonVector: new Map([[0, 0.8]]),
    }));
    const summary = summarizeCluster([0, 1, 2], records, codebook);
    expect(summary.label).toContain("原発再稼働");
    expect(summary.label).toContain("非反対");
    expect(summary.label).toContain("安全性");
    expect(summary.size).toBe(3);
    expect(summary.representatives).toHaveLength(3);
  });
});

describe("clusterByLayout(見た目で切り直す)", () => {
  it("2D 上で分離した2つの塊を別クラスタに切る", () => {
    // 左の塊 20 点、右の塊 20 点(十分離す)
    const n = 40;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    for (let i = 0; i < 20; i++) {
      x[i] = Math.cos(i) * 0.5;
      y[i] = Math.sin(i * 1.7) * 0.5;
      x[i + 20] = 30 + Math.cos(i * 1.3) * 0.5;
      y[i + 20] = Math.sin(i) * 0.5;
    }
    const communities = clusterByLayout(x, y, 1.0);
    const left = new Set(Array.from(communities.slice(0, 20)));
    const right = new Set(Array.from(communities.slice(20)));
    // 塊をまたいで同じクラスタにならない
    for (const c of left) expect(right.has(c)).toBe(false);
    expect(communities.every((c) => c >= 0)).toBe(true);
  });

  it("点数が k 以下なら全点を1クラスタにする", () => {
    const x = new Float32Array([0, 1, 2]);
    const y = new Float32Array([0, 0, 0]);
    const communities = clusterByLayout(x, y, 1.0);
    expect(Array.from(communities)).toEqual([0, 0, 0]);
  });
});

describe("storageKeys: phase2 からの永続キー移行", () => {
  it("実プロジェクトの namespace は接尾辞形で移行する", () => {
    expect(migrateNamespace("abc-123-phase2")).toBe("abc-123-stance-spectrum");
  });

  it("同梱サンプルの namespace は接頭辞形で移行する", () => {
    expect(migrateNamespace("phase2-sample")).toBe("stance-spectrum-sample");
    expect(migrateNamespace("phase2-sample-survey")).toBe("stance-spectrum-sample-survey");
  });

  it("通常版や移行済みの namespace は触らない", () => {
    expect(migrateNamespace("abc-123")).toBeNull();
    expect(migrateNamespace("abc-123-stance-spectrum")).toBeNull();
    expect(migrateNamespace("stance-spectrum-sample")).toBeNull();
  });

  it("賛否スペクトラム分析固有の step だけ移行する", () => {
    expect(migrateStep("phase2-extract")).toBe("stance-spectrum-extract");
    expect(migrateStep("phase2-label")).toBe("stance-spectrum-label");
    // embedding / codebook / umap は通常版と共通なので変えない
    expect(migrateStep("embedding")).toBeNull();
    expect(migrateStep("codebook")).toBeNull();
    expect(migrateStep("umap")).toBeNull();
    expect(migrateStep("stance-spectrum-extract")).toBeNull();
  });
});
