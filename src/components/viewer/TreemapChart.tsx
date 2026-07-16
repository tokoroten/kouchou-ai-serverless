import { useMemo } from "react";
import type { Argument, Cluster } from "../../types/result";
import { Plot } from "./Plot";
import { TREEMAP_COLORWAY } from "./colors";

// 本家 public-viewer TreemapChart の移植(簡略版)。
// クラスタ階層 + 意見(リーフ)を treemap 表示し、クリックでズームする。

type Props = {
  clusterList: Cluster[];
  argumentList: Argument[];
  level: string; // 現在ズームしているノードID
  onTreeZoom: (level: string) => void;
};

export function TreemapChart({ clusterList, argumentList, level, onTreeZoom }: Props) {
  const data = useMemo(() => {
    const argNodes = argumentList.map((arg) => ({
      id: arg.arg_id,
      label: arg.argument,
      takeaway: "",
      value: 1,
      parent: arg.cluster_ids[arg.cluster_ids.length - 1],
    }));
    const clusterNodes = clusterList.map((cluster, index) => ({
      id: cluster.id,
      label: cluster.label,
      takeaway: cluster.takeaway,
      value: cluster.value,
      parent: index === 0 ? "" : cluster.parent,
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
      customdata: list.map((node) => node.takeaway.replace(/(.{15})/g, "$1<br />")),
      level,
      branchvalues: "total",
      marker: { line: { width: 1, color: "white" } },
      hoverinfo: "text",
      hovertemplate: "%{customdata}<extra></extra>",
      hoverlabel: { align: "left" },
      texttemplate: "%{label}<br>%{value:,}件<br>%{percentEntry:.2%}",
      maxdepth: 2,
      pathbar: { thickness: 28 },
    };
  }, [clusterList, argumentList, level]);

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
