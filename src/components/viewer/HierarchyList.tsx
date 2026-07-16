import { useMemo } from "react";
import type { Argument, Cluster } from "../../types/result";

// 本家 HierarchyListChart 相当: クラスタ階層を入れ子リストで表示する。

type Props = {
  clusterList: Cluster[];
  argumentList: Argument[];
  filteredArgumentIds?: Set<string>;
};

export function HierarchyList({ clusterList, argumentList, filteredArgumentIds }: Props) {
  const childrenByParent = useMemo(() => {
    const map = new Map<string, Cluster[]>();
    for (const cluster of clusterList) {
      if (cluster.level === 0) continue;
      const list = map.get(cluster.parent) ?? [];
      list.push(cluster);
      map.set(cluster.parent, list);
    }
    return map;
  }, [clusterList]);

  const argsByCluster = useMemo(() => {
    const map = new Map<string, Argument[]>();
    for (const arg of argumentList) {
      if (filteredArgumentIds && !filteredArgumentIds.has(arg.arg_id)) continue;
      const deepest = arg.cluster_ids[arg.cluster_ids.length - 1];
      const list = map.get(deepest) ?? [];
      list.push(arg);
      map.set(deepest, list);
    }
    return map;
  }, [argumentList, filteredArgumentIds]);

  const renderCluster = (cluster: Cluster): React.ReactNode => {
    const children = childrenByParent.get(cluster.id) ?? [];
    const args = children.length === 0 ? (argsByCluster.get(cluster.id) ?? []) : [];
    return (
      <details key={cluster.id} className="hierarchy-node" open={cluster.level <= 1}>
        <summary>
          <b>{cluster.label}</b> <span className="note">({cluster.value.toLocaleString()} 件)</span>
        </summary>
        {cluster.takeaway && <p className="note hierarchy-takeaway">{cluster.takeaway}</p>}
        <div className="hierarchy-children">
          {children.map(renderCluster)}
          {args.length > 0 && (
            <ul className="argument-list">
              {args.map((arg) => (
                <li key={arg.arg_id}>{arg.argument}</li>
              ))}
            </ul>
          )}
        </div>
      </details>
    );
  };

  const roots = childrenByParent.get("0") ?? [];
  return <div className="hierarchy-list">{roots.map(renderCluster)}</div>;
}
