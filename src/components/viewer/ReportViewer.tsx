import { useMemo, useState } from "react";
import type { Cluster, Result } from "../../types/result";
import { AttributeFilter, type FilterState, applyFilter, propertyNames } from "./AttributeFilter";
import { HierarchyList } from "./HierarchyList";
import { ScatterChart } from "./ScatterChart";
import { TreemapChart } from "./TreemapChart";

// レポートビューア本体(本家 public-viewer 相当)。
// アプリ内(ViewerPage)と単一HTMLレポート(viewer-standalone)の両方から使う。
// タブ: 散布図 / 濃い意見グループ(密度) / ツリーマップ / 階層リスト。属性フィルタ対応。

type ChartTab = "scatter" | "density" | "treemap" | "hierarchy";

type Props = {
  result: Result;
};

export function ReportViewer({ result }: Props) {
  const [tab, setTab] = useState<ChartTab>("scatter");
  const [treemapLevel, setTreemapLevel] = useState("0");
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterState>({});

  const levels = useMemo(
    () => [...new Set(result.clusters.filter((c) => c.level > 0).map((c) => c.level))].sort((a, b) => a - b),
    [result],
  );
  const [scatterLevel, setScatterLevel] = useState(1);
  const deepestLevel = levels[levels.length - 1] ?? 1;

  const filteredIds = useMemo(() => applyFilter(result, filter), [result, filter]);
  const hasProperties = propertyNames(result).length > 0;

  const selectedCluster: Cluster | undefined = useMemo(
    () => result.clusters.find((c) => c.id === selectedClusterId),
    [result, selectedClusterId],
  );
  const selectedArguments = useMemo(() => {
    if (!selectedClusterId) return [];
    return result.arguments.filter(
      (arg) => arg.cluster_ids.includes(selectedClusterId) && (!filteredIds || filteredIds.has(arg.arg_id)),
    );
  }, [result, selectedClusterId, filteredIds]);

  const clustersAtLevel = useMemo(
    () => result.clusters.filter((c) => c.level === (tab === "density" ? deepestLevel : scatterLevel)),
    [result, tab, scatterLevel, deepestLevel],
  );

  // フィルタ適用時のクラスタ別件数
  const filteredCountByCluster = useMemo(() => {
    if (!filteredIds) return null;
    const counts = new Map<string, number>();
    for (const arg of result.arguments) {
      if (!filteredIds.has(arg.arg_id)) continue;
      for (const id of arg.cluster_ids) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return counts;
  }, [result, filteredIds]);

  const selectClusterFromPoint = (argId: string, level: number) => {
    const arg = result.arguments.find((a) => a.arg_id === argId);
    const clusterId = arg?.cluster_ids.find((id) => result.clusters.some((c) => c.id === id && c.level === level));
    if (clusterId) setSelectedClusterId(clusterId);
  };

  return (
    <div className="viewer">
      <header className="viewer-header">
        <h1>{result.config?.name || "レポート"}</h1>
        {result.config?.question && <p className="viewer-question">{result.config.question}</p>}
      </header>

      {(result.overview || result.config?.intro) && (
        <section className="viewer-overview card">
          {result.config?.intro && <p style={{ whiteSpace: "pre-wrap" }}>{result.config.intro}</p>}
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
        <button type="button" className={tab === "hierarchy" ? "active" : ""} onClick={() => setTab("hierarchy")}>
          階層リスト
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

      {hasProperties && <AttributeFilter result={result} filter={filter} onChange={setFilter} />}

      {tab !== "hierarchy" ? (
        <div className="viewer-chart">
          {tab === "scatter" && (
            <ScatterChart
              clusterList={result.clusters}
              argumentList={result.arguments}
              targetLevel={scatterLevel}
              filteredArgumentIds={filteredIds}
              onPointClick={(argId) => selectClusterFromPoint(argId, scatterLevel)}
            />
          )}
          {tab === "density" && (
            <ScatterChart
              clusterList={result.clusters}
              argumentList={result.arguments}
              targetLevel={deepestLevel}
              densityFilter={{ maxPercentile: 0.3, minValue: 3 }}
              filteredArgumentIds={filteredIds}
              onPointClick={(argId) => selectClusterFromPoint(argId, deepestLevel)}
            />
          )}
          {tab === "treemap" && (
            <TreemapChart
              clusterList={result.clusters}
              argumentList={result.arguments}
              level={treemapLevel}
              onTreeZoom={setTreemapLevel}
              filteredArgumentIds={filteredIds}
            />
          )}
        </div>
      ) : (
        <HierarchyList
          clusterList={result.clusters}
          argumentList={result.arguments}
          filteredArgumentIds={filteredIds ?? undefined}
        />
      )}

      {tab !== "hierarchy" && (
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
                <p className="cluster-value">
                  {filteredCountByCluster
                    ? `${(filteredCountByCluster.get(cluster.id) ?? 0).toLocaleString()} / ${cluster.value.toLocaleString()} 件 (フィルタ後)`
                    : `${cluster.value.toLocaleString()} 件`}
                </p>
                <p className="cluster-takeaway">{cluster.takeaway}</p>
              </button>
            ))}
          </div>
        </section>
      )}

      {selectedCluster && tab !== "hierarchy" && (
        <section className="viewer-cluster-detail card">
          <h2>
            {selectedCluster.label}({selectedArguments.length} 件)
          </h2>
          <p>{selectedCluster.takeaway}</p>
          <ul className="argument-list">
            {selectedArguments.map((arg) => (
              <li key={arg.arg_id}>
                {arg.argument}
                {arg.attributes && (
                  <span className="note">
                    {" "}
                    —{" "}
                    {Object.entries(arg.attributes)
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(" / ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
