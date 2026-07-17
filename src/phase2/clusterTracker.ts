// クラスタIDの安定追跡(一次資料「クラスタの安定化」)。
// フレームごとに新しい番号を振らず、前回クラスタとの Jaccard overlap から ID を引き継ぐ。

export type TrackedAssignment = {
  /** 各点の安定クラスタID(null = 孤立/未所属) */
  labels: (string | null)[];
  /** 使用済みIDのカウンタ(次回の新規ID発番用) */
  nextIdCounter: number;
};

export function trackClusters(
  communities: Int32Array,
  previous: TrackedAssignment | null,
  /** focus+context 時: 再クラスタ対象外の点は前回ラベルを維持する */
  frozen?: boolean[],
): TrackedAssignment {
  const n = communities.length;
  const prevLabels = previous?.labels ?? new Array<string | null>(n).fill(null);
  let counter = previous?.nextIdCounter ?? 0;

  // 新コミュニティ → 所属点集合
  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (frozen?.[i]) continue;
    const c = communities[i];
    if (c < 0) continue;
    const list = members.get(c) ?? [];
    list.push(i);
    members.set(c, list);
  }

  // 前回ラベル → 所属点集合
  const prevMembers = new Map<string, Set<number>>();
  for (let i = 0; i < n; i++) {
    const label = prevLabels[i];
    if (label === null) continue;
    const set = prevMembers.get(label) ?? new Set<number>();
    set.add(i);
    prevMembers.set(label, set);
  }

  // Jaccard 最大の前回クラスタへ貪欲にマッチング(大きいコミュニティ優先)
  const sorted = [...members.entries()].sort((a, b) => b[1].length - a[1].length);
  const usedPrev = new Set<string>();
  const communityToLabel = new Map<number, string>();
  for (const [community, points] of sorted) {
    let bestLabel: string | null = null;
    let bestJaccard = 0;
    for (const [label, prevSet] of prevMembers) {
      if (usedPrev.has(label)) continue;
      let intersection = 0;
      for (const p of points) if (prevSet.has(p)) intersection++;
      const union = prevSet.size + points.length - intersection;
      const jaccard = union > 0 ? intersection / union : 0;
      if (jaccard > bestJaccard) {
        bestJaccard = jaccard;
        bestLabel = label;
      }
    }
    // 3割以上重なっていれば ID を引き継ぐ
    if (bestLabel !== null && bestJaccard >= 0.3) {
      communityToLabel.set(community, bestLabel);
      usedPrev.add(bestLabel);
    } else {
      communityToLabel.set(community, `c${counter++}`);
    }
  }

  const labels: (string | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    if (frozen?.[i]) {
      labels[i] = prevLabels[i];
    } else {
      const c = communities[i];
      labels[i] = c >= 0 ? (communityToLabel.get(c) ?? null) : null;
    }
  }
  return { labels, nextIdCounter: counter };
}
