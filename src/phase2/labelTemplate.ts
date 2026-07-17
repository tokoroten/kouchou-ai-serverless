import type { Codebook, OpinionRecord, StanceKey } from "./types";
import { dominantStance } from "./types";

// LLM を使わないテンプレートラベル生成(一次資料「クラスタラベル」)。
// クラスタ内の上位 topic / 主な stance / 上位 reason を集計して組み立てる。

const STANCE_LABEL_JA: Record<StanceKey | "unknown", string> = {
  explicitOpposition: "明確な反対",
  conditionalOpposition: "条件付き反対",
  nonSupport: "非賛成",
  neutralOrDefer: "中立・保留",
  nonOpposition: "非反対",
  conditionalSupport: "条件付き賛成",
  explicitSupport: "明確な賛成",
  unknown: "立場不明",
};

export type ClusterSummary = {
  label: string;
  size: number;
  topTopics: { label: string; count: number }[];
  stanceMix: Partial<Record<StanceKey | "unknown", number>>;
  topReasons: { label: string; count: number }[];
  representatives: number[]; // 代表点のインデックス
};

export function summarizeCluster(
  memberIndices: number[],
  records: OpinionRecord[],
  codebook: Codebook,
): ClusterSummary {
  const topicCounts = new Map<number, number>();
  const reasonCounts = new Map<number, number>();
  const stanceCounts = new Map<StanceKey | "unknown", number>();

  for (const i of memberIndices) {
    const record = records[i];
    for (const [index, weight] of record.topicVector) {
      topicCounts.set(index, (topicCounts.get(index) ?? 0) + weight);
    }
    for (const [index, weight] of record.reasonVector) {
      reasonCounts.set(index, (reasonCounts.get(index) ?? 0) + weight);
    }
    const stance = dominantStance(record.enrichment.stance);
    stanceCounts.set(stance, (stanceCounts.get(stance) ?? 0) + 1);
  }

  const topTopics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([index, count]) => ({ label: codebook.topics[index] ?? "?", count: Math.round(count) }));
  const topReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([index, count]) => ({ label: codebook.reasons[index] ?? "?", count: Math.round(count) }));

  const stanceMix: Partial<Record<StanceKey | "unknown", number>> = {};
  for (const [key, count] of stanceCounts) stanceMix[key] = count;
  const dominant = [...stanceCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
  const dominantRatio = (stanceCounts.get(dominant) ?? 0) / Math.max(1, memberIndices.length);

  // テンプレート: 「{topic} — {stance}(主な論点: {reason})」
  // stance が支配的(6割以上)なときだけ stance を出す(トピックビューで無意味な stance を出さない)
  const topicPart = topTopics[0]?.label ?? "その他";
  const stancePart = dominantRatio >= 0.6 && dominant !== "unknown" ? ` — ${STANCE_LABEL_JA[dominant]}` : "";
  const reasonPart = topReasons[0] ? `(主な論点: ${topReasons[0].label})` : "";
  const label = `${topicPart}${stancePart}${reasonPart}`;

  // 代表点: confidence × commitment が高い順に3件
  const representatives = [...memberIndices]
    .sort(
      (a, b) =>
        records[b].enrichment.confidence * (0.5 + records[b].enrichment.commitment * 0.5) -
        records[a].enrichment.confidence * (0.5 + records[a].enrichment.commitment * 0.5),
    )
    .slice(0, 3);

  return { label, size: memberIndices.length, topTopics, stanceMix, topReasons, representatives };
}

export { STANCE_LABEL_JA };
