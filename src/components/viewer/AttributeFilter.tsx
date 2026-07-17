import { useMemo, useState } from "react";
import type { Argument } from "../../types/result";

// 本家 public-viewer の属性フィルタ(attributeFilterUtils.ts + AttributeFilterDialog.tsx)の移植。
// - カテゴリ属性: チェックボックス(属性間は AND、値間は OR)
// - 数値属性: レンジスライダー(有効化チェック + 空の値を含める)
// - テキスト検索: 意見本文の部分一致

export type AttributeFilters = Record<string, string[]>;
export type NumericRangeFilters = Record<string, [number, number]>;

export type FilterParams = {
  attributeFilters: AttributeFilters;
  numericRanges: NumericRangeFilters;
  enabledRanges: Record<string, boolean>;
  includeEmptyValues: Record<string, boolean>;
  textSearch: string;
};

export const EMPTY_FILTER: FilterParams = {
  attributeFilters: {},
  numericRanges: {},
  enabledRanges: {},
  includeEmptyValues: {},
  textSearch: "",
};

export type AttributeMeta = {
  name: string;
  type: "numeric" | "categorical";
  values: string[];
  valueCounts: Record<string, number>;
  numericRange?: [number, number];
};

/** 本家 computeAttributeMetas の移植 */
export function computeAttributeMetas(args: Argument[]): AttributeMeta[] {
  const attrMap: Record<
    string,
    { valueSet: Set<string>; valueCounts: Map<string, number>; isNumeric: boolean; min?: number; max?: number }
  > = {};

  for (const arg of args) {
    if (!arg.attributes) continue;
    for (const [name, rawValue] of Object.entries(arg.attributes)) {
      const value = rawValue == null ? "" : String(rawValue);
      if (!attrMap[name]) {
        attrMap[name] = { valueSet: new Set(), valueCounts: new Map(), isNumeric: true };
      }
      const info = attrMap[name];
      info.valueSet.add(value);
      info.valueCounts.set(value, (info.valueCounts.get(value) ?? 0) + 1);
      if (value.trim() !== "") {
        const num = Number(value);
        if (Number.isNaN(num)) {
          info.isNumeric = false;
        } else if (info.isNumeric) {
          if (info.min === undefined || num < info.min) info.min = num;
          if (info.max === undefined || num > info.max) info.max = num;
        }
      }
    }
  }

  return Object.entries(attrMap).map(([name, info]) => {
    const values = Array.from(info.valueSet)
      .filter((v) => v !== "")
      .sort();
    const valueCounts: Record<string, number> = {};
    for (const v of values) valueCounts[v] = info.valueCounts.get(v) ?? 0;
    return {
      name,
      type: info.isNumeric ? ("numeric" as const) : ("categorical" as const),
      values,
      valueCounts,
      numericRange:
        info.isNumeric && values.length > 0 && info.min !== undefined && info.max !== undefined
          ? ([info.min, info.max] as [number, number])
          : undefined,
    };
  });
}

export function hasActiveFilters(params: FilterParams): boolean {
  return (
    Object.keys(params.attributeFilters).length > 0 ||
    Object.values(params.enabledRanges).some(Boolean) ||
    params.textSearch.trim() !== ""
  );
}

/** 本家 filterArgumentIds の移植。フィルタなしなら null(全件表示)。 */
export function filterArgumentIds(args: Argument[], params: FilterParams): Set<string> | null {
  if (!hasActiveFilters(params)) return null;
  const { attributeFilters, numericRanges, enabledRanges, includeEmptyValues, textSearch } = params;
  const searchLower = textSearch.trim().toLowerCase();

  const ids = new Set<string>();
  for (const arg of args) {
    if (searchLower && !arg.argument.toLowerCase().includes(searchLower)) continue;

    if (!arg.attributes) {
      // 属性がない意見はカテゴリ/数値フィルタにマッチしない。テキスト検索のみなら通す(本家と同じ)
      const onlyText =
        Object.keys(attributeFilters).length === 0 && !Object.values(enabledRanges).some(Boolean) && !!searchLower;
      if (onlyText) ids.add(arg.arg_id);
      continue;
    }

    let match = true;
    // カテゴリフィルタ(属性間は AND、値間は OR)
    for (const [attr, values] of Object.entries(attributeFilters)) {
      if (values.length === 0) continue;
      const attrValue = String(arg.attributes[attr] ?? "");
      if (!values.includes(attrValue)) {
        match = false;
        break;
      }
    }
    // 数値レンジフィルタ
    if (match) {
      for (const [attr, range] of Object.entries(numericRanges)) {
        if (!enabledRanges[attr]) continue;
        const rawValue = arg.attributes[attr];
        const trimmed = rawValue == null ? "" : String(rawValue).trim();
        if (trimmed === "") {
          if (!includeEmptyValues[attr]) {
            match = false;
            break;
          }
        } else {
          const numValue = Number(trimmed);
          if (Number.isNaN(numValue) || numValue < range[0] || numValue > range[1]) {
            match = false;
            break;
          }
        }
      }
    }
    if (match) ids.add(arg.arg_id);
  }
  return ids;
}

export function countActiveFilters(params: FilterParams): number {
  const attrCount = new Set([
    ...Object.keys(params.attributeFilters),
    ...Object.keys(params.enabledRanges).filter((k) => params.enabledRanges[k]),
  ]).size;
  return attrCount + (params.textSearch.trim() !== "" ? 1 : 0);
}

// ---- UI ----

type Props = {
  metas: AttributeMeta[];
  filter: FilterParams;
  onChange: (filter: FilterParams) => void;
};

export function AttributeFilter({ metas, filter, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const activeCount = countActiveFilters(filter);

  const toggleValue = (attr: string, value: string) => {
    const arr = filter.attributeFilters[attr] ?? [];
    const nextArr = arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
    const attributeFilters = { ...filter.attributeFilters };
    if (nextArr.length === 0) delete attributeFilters[attr];
    else attributeFilters[attr] = nextArr;
    onChange({ ...filter, attributeFilters });
  };

  const setRange = (attr: string, idx: 0 | 1, value: number, fullRange: [number, number]) => {
    const [min, max] = filter.numericRanges[attr] ?? fullRange;
    const next: [number, number] = idx === 0 ? [Math.min(value, max), max] : [min, Math.max(value, min)];
    onChange({ ...filter, numericRanges: { ...filter.numericRanges, [attr]: next } });
  };

  return (
    <div className="card filter-panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <button type="button" onClick={() => setOpen(!open)}>
          {open ? "▼" : "▶"} フィルタ{activeCount > 0 ? `(${activeCount} 件適用中)` : ""}
        </button>
        {activeCount > 0 && (
          <button type="button" onClick={() => onChange(EMPTY_FILTER)}>
            すべてクリア
          </button>
        )}
      </div>
      {open && (
        <div>
          <p className="note">フィルタ間は AND 結合、フィルタ内の条件は OR 結合されます。</p>
          <label>テキスト検索</label>
          <input
            placeholder="入力されたテキストが含まれる意見のみ表示されます"
            value={filter.textSearch}
            onChange={(e) => onChange({ ...filter, textSearch: e.target.value })}
          />
          {metas.map((attr) => (
            <div key={attr.name} style={{ marginTop: 12 }}>
              <b>{attr.name}</b>
              {attr.type === "numeric" && attr.numericRange ? (
                <NumericRangeControl
                  attr={attr}
                  fullRange={attr.numericRange}
                  filter={filter}
                  onChange={onChange}
                  setRange={setRange}
                />
              ) : (
                <div className="row" style={{ marginTop: 4 }}>
                  {attr.values.slice(0, 100).map((value) => {
                    const checked = filter.attributeFilters[attr.name]?.includes(value) ?? false;
                    return (
                      <label key={value} className={`filter-chip ${checked ? "checked" : ""}`}>
                        <input
                          type="checkbox"
                          style={{ width: "auto", marginRight: 4 }}
                          checked={checked}
                          onChange={() => toggleValue(attr.name, value)}
                        />
                        {value || "(空)"} <span className="note">{attr.valueCounts[value] ?? 0}</span>
                      </label>
                    );
                  })}
                  {attr.values.length > 100 && <span className="note">(上位100値のみ表示)</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NumericRangeControl({
  attr,
  fullRange,
  filter,
  onChange,
  setRange,
}: {
  attr: AttributeMeta;
  fullRange: [number, number];
  filter: FilterParams;
  onChange: (filter: FilterParams) => void;
  setRange: (attr: string, idx: 0 | 1, value: number, fullRange: [number, number]) => void;
}) {
  const enabled = !!filter.enabledRanges[attr.name];
  const [lo, hi] = filter.numericRanges[attr.name] ?? fullRange;
  const step = useMemo(() => {
    const span = fullRange[1] - fullRange[0];
    if (span <= 0) return 1;
    return Number.isInteger(fullRange[0]) && Number.isInteger(fullRange[1]) && span <= 1000 ? 1 : span / 100;
  }, [fullRange]);

  return (
    <div style={{ marginTop: 4 }}>
      <div className="row">
        <label style={{ fontWeight: 400, margin: 0 }}>
          <input
            type="checkbox"
            style={{ width: "auto", marginRight: 4 }}
            checked={enabled}
            onChange={() =>
              onChange({
                ...filter,
                enabledRanges: { ...filter.enabledRanges, [attr.name]: !enabled },
                numericRanges: { ...filter.numericRanges, [attr.name]: filter.numericRanges[attr.name] ?? fullRange },
              })
            }
          />
          フィルター有効化
        </label>
        <label style={{ fontWeight: 400, margin: 0, opacity: enabled ? 1 : 0.5 }}>
          <input
            type="checkbox"
            style={{ width: "auto", marginRight: 4 }}
            disabled={!enabled}
            checked={!!filter.includeEmptyValues[attr.name]}
            onChange={() =>
              onChange({
                ...filter,
                includeEmptyValues: {
                  ...filter.includeEmptyValues,
                  [attr.name]: !filter.includeEmptyValues[attr.name],
                },
              })
            }
          />
          空の値を含める
        </label>
      </div>
      <div className="row" style={{ opacity: enabled ? 1 : 0.5 }}>
        <span className="note" style={{ width: 90, textAlign: "right" }}>
          最小 {formatNum(lo)}
        </span>
        <input
          type="range"
          min={fullRange[0]}
          max={fullRange[1]}
          step={step}
          value={lo}
          disabled={!enabled}
          onChange={(e) => setRange(attr.name, 0, Number(e.target.value), fullRange)}
          style={{ flex: 1, minWidth: 120 }}
        />
        <input
          type="range"
          min={fullRange[0]}
          max={fullRange[1]}
          step={step}
          value={hi}
          disabled={!enabled}
          onChange={(e) => setRange(attr.name, 1, Number(e.target.value), fullRange)}
          style={{ flex: 1, minWidth: 120 }}
        />
        <span className="note" style={{ width: 90 }}>
          最大 {formatNum(hi)}
        </span>
        <span className="note">
          (範囲: {formatNum(fullRange[0])}〜{formatNum(fullRange[1])})
        </span>
      </div>
    </div>
  );
}

function formatNum(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2);
}
