import { useMemo } from "react";
import type { Argument, Cluster } from "../../types/result";
import { Plot } from "./Plot";
import { SOFT_COLORS, wrapHoverText, wrapLabelText } from "./colors";

// 本家 public-viewer ScatterChart の移植(簡略版)。
// クラスタ色分け散布図 + クラスタ中心のラベル表示。

type Props = {
  clusterList: Cluster[];
  argumentList: Argument[];
  targetLevel: number;
  showClusterLabels?: boolean;
  /** 密度表示モード: 指定時は densityFilter を満たすクラスタのみ色付け */
  densityFilter?: { maxPercentile: number; minValue: number };
  /** 属性フィルタ: 指定時は含まれない点をグレー表示(本家と同じ) */
  filteredArgumentIds?: Set<string> | null;
  onPointClick?: (argId: string) => void;
};

export function ScatterChart({
  clusterList,
  argumentList,
  targetLevel,
  showClusterLabels = true,
  densityFilter,
  filteredArgumentIds,
  onPointClick,
}: Props) {
  const { data, annotations } = useMemo(() => {
    const targetClusters = clusterList.filter((c) => c.level === targetLevel);
    const colorById = new Map<string, string>();
    targetClusters.forEach((cluster, index) => {
      colorById.set(cluster.id, SOFT_COLORS[index % SOFT_COLORS.length]);
    });

    const isDense = (cluster: Cluster) =>
      !densityFilter ||
      (cluster.density_rank_percentile <= densityFilter.maxPercentile && cluster.value >= densityFilter.minValue);

    // biome-ignore lint/suspicious/noExplicitAny: Plotly trace
    const data: any[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: Plotly annotations
    const annotations: any[] = [];

    for (const cluster of targetClusters) {
      const allArgs = argumentList.filter((arg) => arg.cluster_ids.includes(cluster.id));
      if (allArgs.length === 0) continue;
      const dense = isDense(cluster);
      const color = dense ? colorById.get(cluster.id) : "#cccccc";

      // 属性フィルタ対象外の点は背面にグレー表示(本家と同じ)
      const notMatching = filteredArgumentIds ? allArgs.filter((a) => !filteredArgumentIds.has(a.arg_id)) : [];
      const args = filteredArgumentIds ? allArgs.filter((a) => filteredArgumentIds.has(a.arg_id)) : allArgs;
      if (notMatching.length > 0) {
        data.push({
          x: notMatching.map((a) => a.x),
          y: notMatching.map((a) => a.y),
          mode: "markers",
          type: "scattergl",
          marker: { size: 7, color: "#cccccc", opacity: 0.4 },
          hoverinfo: "skip",
          showlegend: false,
        });
      }
      if (args.length > 0) {
        data.push({
          x: args.map((a) => a.x),
          y: args.map((a) => a.y),
          mode: "markers",
          type: "scattergl",
          marker: { size: 7, color, opacity: dense ? 1 : 0.4 },
          text: args.map((a) => `<b>${cluster.label}</b><br>${wrapHoverText(a.argument)}`),
          hoverinfo: "text",
          hoverlabel: {
            align: "left",
            bgcolor: "white",
            bordercolor: color,
            font: { size: 12, color: "#333" },
          },
          customdata: args.map((a) => a.arg_id),
          showlegend: false,
        });
      }
      if (showClusterLabels && dense) {
        // クラスタ中心はフィルタに関わらず全点から計算する(本家と同じ)
        const cx = allArgs.reduce((sum, a) => sum + a.x, 0) / allArgs.length;
        const cy = allArgs.reduce((sum, a) => sum + a.y, 0) / allArgs.length;
        annotations.push({
          x: cx,
          y: cy,
          text: wrapLabelText(cluster.label),
          showarrow: false,
          font: { color: "white", size: 14 },
          bgcolor: `${colorById.get(cluster.id)}cc`,
          borderpad: 10,
          width: 228,
          align: "left",
        });
      }
    }
    return { data, annotations };
  }, [clusterList, argumentList, targetLevel, showClusterLabels, densityFilter, filteredArgumentIds]);

  const layout = useMemo(
    () => ({
      uirevision: "scatter",
      margin: { l: 0, r: 0, b: 0, t: 0 },
      xaxis: { zeroline: false, showticklabels: false, showgrid: false },
      yaxis: { zeroline: false, showticklabels: false, showgrid: false },
      hovermode: "closest",
      dragmode: "pan",
      annotations,
      showlegend: false,
    }),
    [annotations],
  );

  return (
    <Plot
      data={data}
      layout={layout}
      config={{ displayModeBar: "hover", scrollZoom: true, locale: "ja" }}
      // biome-ignore lint/suspicious/noExplicitAny: Plotly event
      onClick={(event: any) => {
        const argId = event?.points?.[0]?.customdata;
        if (typeof argId === "string") onPointClick?.(argId);
      }}
    />
  );
}
