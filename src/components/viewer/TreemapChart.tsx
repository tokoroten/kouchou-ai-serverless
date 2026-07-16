import { useMemo } from "react";
import type { Argument, Cluster } from "../../types/result";
import { Plot } from "./Plot";
import { TREEMAP_COLORWAY } from "./colors";

// 本家 public-viewer TreemapChart の移植(簡略版)。
// クラスタ階層 + 意見(リーフ)を treemap 表示し、クリックでズームする。
// 属性フィルタ適用時は本家と同じく: 対象外リーフは 0 値+グレー、クラスタ件数は再計算。

type Props = {
  clusterList: Cluster[];
  argumentList: Argument[];
  level: string; // 現在ズームしているノードID
  onTreeZoom: (level: string) => void;
  filteredArgumentIds?: Set<string> | null;
};

export function TreemapChart({ clusterList, argumentList, level, onTreeZoom, filteredArgumentIds }: Props) {
  const data = useMemo(() => {
    const isFiltering = !!filteredArgumentIds;
    // フィルタ適用後のクラスタ別件数(本家と同じ計算)
    const clusterCounts = new Map<string, number>();
    for (const cluster of clusterList) clusterCounts.set(cluster.id, 0);
    for (const arg of argumentList) {
      if (isFiltering && !filteredArgumentIds?.has(arg.arg_id)) continue;
      for (const clusterId of arg.cluster_ids) {
        if (clusterCounts.has(clusterId)) {
          clusterCounts.set(clusterId, (clusterCounts.get(clusterId) ?? 0) + 1);
        }
      }
    }

    const argNodes = argumentList.map((arg) => {
      const filtered = isFiltering && !filteredArgumentIds?.has(arg.arg_id);
      return {
        id: arg.arg_id,
        label: arg.argument,
        takeaway: "",
        value: filtered ? 0 : 1,
        parent: arg.cluster_ids[arg.cluster_ids.length - 1],
        filtered,
      };
    });
    const clusterNodes = clusterList.map((cluster, index) => ({
      id: cluster.id,
      label: cluster.label,
      takeaway: cluster.takeaway,
      value: isFiltering ? (clusterCounts.get(cluster.id) ?? 0) : cluster.value,
      parent: index === 0 ? "" : cluster.parent,
      filtered: false,
    }));
    const list = [...clusterNodes, ...argNodes];
    return {
      type: "treemap",
      ids: list.map((node) => node.id),
      labels: list.map((node) =>
        node.id === level ? node.label.replace(/(.{50})/g, "$1<br />") : node.label.replace(/(.{15})/g, "$1<br />"),
      ),
      parents: list.map((node) => node.parent),
      values: list.map((node) => node.value),
      customdata: list.map((node) => (node.filtered ? "" : node.takeaway.replace(/(.{15})/g, "$1<br />"))),
      level,
      branchvalues: "total",
      marker: {
        colors: list.map((node) => (node.filtered ? "#cccccc" : "")),
        line: { width: 1, color: "white" },
        opacity: list.map((node) => (node.filtered ? 0.5 : 1)),
      },
      hoverinfo: "text",
      hovertemplate: "%{customdata}<extra></extra>",
      hoverlabel: { align: "left" },
      texttemplate: isFiltering
        ? "%{label}<br>%{value:,}件 (フィルタ後)<br>%{percentEntry:.2%}"
        : "%{label}<br>%{value:,}件<br>%{percentEntry:.2%}",
      maxdepth: 2,
      pathbar: { thickness: 28 },
    };
  }, [clusterList, argumentList, level, filteredArgumentIds]);

  const layout = useMemo(
    () => ({
      margin: { l: 10, r: 10, b: 10, t: 30 },
      colorway: TREEMAP_COLORWAY,
    }),
    [],
  );

  return (
    <Plot
      data={[data]}
      layout={layout}
      config={{ displayModeBar: false, locale: "ja" }}
      // biome-ignore lint/suspicious/noExplicitAny: Plotly event
      onClick={(event: any) => {
        const point = event?.points?.[0];
        const newLevel = point?.data?.ids?.[point.pointNumber]?.toString() || "0";
        onTreeZoom(newLevel);
      }}
    />
  );
}
