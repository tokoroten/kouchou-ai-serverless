import { useMemo } from "react";
import type { Result } from "../../types/result";

// 属性フィルタ(本家の attribute filter 相当)。
// propertyMap: { 属性名: { argId: 値 } } を元に、属性値で意見を絞り込む。

export type FilterState = Record<string, string>; // 属性名 -> 選択値("" = すべて)

type Props = {
  result: Result;
  filter: FilterState;
  onChange: (filter: FilterState) => void;
};

export function propertyNames(result: Result): string[] {
  return Object.keys(result.propertyMap ?? {}).filter(
    (key) => typeof result.propertyMap[key] === "object" && result.propertyMap[key] !== null,
  );
}

/** フィルタに一致する argId の集合。フィルタが空なら null(=フィルタなし) */
export function applyFilter(result: Result, filter: FilterState): Set<string> | null {
  const active = Object.entries(filter).filter(([, value]) => value !== "");
  if (active.length === 0) return null;
  const ids = new Set<string>();
  for (const arg of result.arguments) {
    let match = true;
    for (const [prop, value] of active) {
      const argValue = result.propertyMap[prop]?.[arg.arg_id];
      if (String(argValue ?? "") !== value) {
        match = false;
        break;
      }
    }
    if (match) ids.add(arg.arg_id);
  }
  return ids;
}

export function AttributeFilter({ result, filter, onChange }: Props) {
  const properties = useMemo(() => {
    return propertyNames(result).map((prop) => {
      const counts = new Map<string, number>();
      const map = result.propertyMap[prop] as Record<string, unknown>;
      for (const value of Object.values(map)) {
        const key = String(value ?? "");
        if (key === "" || key === "null") continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const values = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
      return { prop, values };
    });
  }, [result]);

  if (properties.length === 0) return null;

  return (
    <div className="row" style={{ margin: "8px 0" }}>
      <span className="note">属性で絞り込み:</span>
      {properties.map(({ prop, values }) => (
        <select
          key={prop}
          value={filter[prop] ?? ""}
          onChange={(e) => onChange({ ...filter, [prop]: e.target.value })}
          style={{ width: "auto" }}
        >
          <option value="">{prop}: すべて</option>
          {values.map(([value, count]) => (
            <option key={value} value={value}>
              {prop}: {value} ({count})
            </option>
          ))}
        </select>
      ))}
      {Object.values(filter).some((v) => v !== "") && (
        <button type="button" onClick={() => onChange({})}>
          解除
        </button>
      )}
    </div>
  );
}
