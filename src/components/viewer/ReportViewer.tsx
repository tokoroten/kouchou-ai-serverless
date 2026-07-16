import { useMemo, useState } from "react";
import type { Cluster, Result } from "../../types/result";
import { ScatterChart } from "./ScatterChart";
import { TreemapChart } from "./TreemapChart";

// レポートビューア本体(本家 public-viewer 相当)。
// アプリ内(ViewerPage)と単一HTMLレポート(viewer-standalone)の両方から使う。

type ChartTab = "scatter" | "density" | "treemap";

type Props = {
  result: Result;
};

export function ReportViewer({ result }: Props) {
  const [tab, setTab] = useState<ChartTab>("scatter");
  const [treemapLevel, setTreemapLevel] = useState("0");
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);

  const levels = useMemo(
    () => [...new Set(result.clusters.filter((c) => c.level > 0).map((c) => c.level))].sort((a, b) => a - b),
    [result],
  );
  const [scatterLevel, setScatterLevel] = useState(1);
  const deepestLevel = levels[levels.length - 1] ?? 1;

  const selectedCluster: Cluster | undefined = useMemo(
    () => result.clusters.find((c) => c.id === selectedClusterId),
    [result, selectedClusterId],
  );
  const selectedArguments = useMemo(() => {
    if (!selectedClusterId) return [];
    return result.arguments.filter((arg) => arg.cluster_ids.includes(selectedClusterId));
  }, [result, selectedClusterId]);

  const clustersAtLevel = useMemo(
    () => result.clusters.filter((c) => c.level === (tab === "density" ? deepestLevel : scatterLevel)),
    [result, tab, scatterLevel, deepestLevel],
  );

  return (
    <div className="viewer">
      <header className="viewer-header">
        <h1>{result.config?.name || "レポート"}</h1>
        {result.config?.question && <p className="viewer-question">{result.config.question}</p>}
      </header>

      {result.overview && (
        <section className="viewer-overview card">
          <h2>概要</h2>
          <p style={{ whiteSpace: "pre-wrap" }}>{result.overview}</p>
          <p className="viewer-meta">
            コメント数 {result.comment_num.toLocaleString()} 件 / 意見数 {result.arguments.length.toLocaleString()} 件
          </p>
        </section>
      )}

      <nav className="viewer-tabs">
        <button type="button" className={tab === "scatter" ? "active" : ""} onClick={() => setTab("scatter")}>
          散布図
        </button>
        <button type="button" className={tab === "density" ? "active" : ""} onClick={() => setTab("density")}>
          濃い意見グループ
        </button>
        <button type="button" className={tab === "treemap" ? "active" : ""} onClick={() => setTab("treemap")}>
          ツリーマップ
        </button>
        {tab === "scatter" && levels.length > 1 && (
          <select value={scatterLevel} onChange={(e) => setScatterLevel(Number(e.target.value))}>
            {levels.map((level) => (
              <option key={level} value={level}>
                第{level}階層 ({result.clusters.filter((c) => c.level === level).length} グループ)
              </option>
            ))}
          </select>
        )}
      </nav>

      <div className="viewer-chart">
        {tab === "scatter" && (
          <ScatterChart
            clusterList={result.clusters}
            argumentList={result.arguments}
            targetLevel={scatterLevel}
            onPointClick={(argId) => {
              const arg = result.arguments.find((a) => a.arg_id === argId);
              const clusterId = arg?.cluster_ids.find((id) =>
                result.clusters.some((c) => c.id === id && c.level === scatterLevel),
              );
              if (clusterId) setSelectedClusterId(clusterId);
            }}
          />
        )}
        {tab === "density" && (
          <ScatterChart
            clusterList={result.clusters}
            argumentList={result.arguments}
            targetLevel={deepestLevel}
            densityFilter={{ maxPercentile: 0.3, minValue: 3 }}
            onPointClick={(argId) => {
              const arg = result.arguments.find((a) => a.arg_id === argId);
              const clusterId = arg?.cluster_ids.find((id) =>
                result.clusters.some((c) => c.id === id && c.level === deepestLevel),
              );
              if (clusterId) setSelectedClusterId(clusterId);
            }}
          />
        )}
        {tab === "treemap" && (
          <TreemapChart
            clusterList={result.clusters}
            argumentList={result.arguments}
            level={treemapLevel}
            onTreeZoom={setTreemapLevel}
          />
        )}
      </div>

      <section className="viewer-clusters">
        <h2>意見グループ一覧</h2>
        <div className="cluster-grid">
          {clustersAtLevel.map((cluster) => (
            <button
              type="button"
              key={cluster.id}
              className={`cluster-card ${selectedClusterId === cluster.id ? "selected" : ""}`}
              onClick={() => setSelectedClusterId(cluster.id === selectedClusterId ? null : cluster.id)}
            >
              <h3>{cluster.label}</h3>
              <p className="cluster-value">{cluster.value.toLocaleString()} 件</p>
              <p className="cluster-takeaway">{cluster.takeaway}</p>
            </button>
          ))}
        </div>
      </section>

      {selectedCluster && (
        <section className="viewer-cluster-detail card">
          <h2>
            {selectedCluster.label}({selectedArguments.length} 件)
          </h2>
          <p>{selectedCluster.takeaway}</p>
          <ul className="argument-list">
            {selectedArguments.map((arg) => (
              <li key={arg.arg_id}>{arg.argument}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
