import type { UmapParams } from "../lib/pipeline/clusteringCore";

// UMAP 詳細パラメータの折り畳みパネル(通常は触らなくてよい拡張設定)。
// 新規作成ウィザード / クラスタリング再実行 / 賛否スペクトラム分析の3画面で共有する。
//
// 重要な規約: UI 値がデフォルトと一致するキーは toUmapInput() で出力しない。
// これによりチェックポイントキー(umapCheckpointKey)が既定実行時と一致し、
// パラメータを触っていないユーザは既存キャッシュをそのまま再利用できる。

export type UmapUiParams = {
  nNeighbors: number;
  minDist: number;
  spread: number;
  /** 0 = 自動(umap-js のヒューリスティック: 1万件未満なら500、以上なら200) */
  nEpochs: number;
  seed: string;
};

export const UMAP_UI_DEFAULTS: UmapUiParams = {
  nNeighbors: 15,
  minDist: 0.1,
  spread: 1.0,
  nEpochs: 0,
  seed: "kouchou-ai",
};

export function toUmapInput(
  p: UmapUiParams,
  defaults: UmapUiParams = UMAP_UI_DEFAULTS,
): { seed: string; umap: UmapParams } {
  return {
    seed: p.seed || defaults.seed,
    umap: {
      ...(p.nNeighbors !== defaults.nNeighbors ? { nNeighbors: p.nNeighbors } : {}),
      ...(p.minDist !== defaults.minDist ? { minDist: p.minDist } : {}),
      ...(p.spread !== defaults.spread ? { spread: p.spread } : {}),
      ...(p.nEpochs !== defaults.nEpochs && p.nEpochs > 0 ? { nEpochs: p.nEpochs } : {}),
    },
  };
}

/** 変更検知・キャッシュキー用の安定文字列 */
export function umapInputKey(p: UmapUiParams, defaults: UmapUiParams = UMAP_UI_DEFAULTS): string {
  return JSON.stringify(toUmapInput(p, defaults));
}

export function isUmapDefault(p: UmapUiParams, defaults: UmapUiParams = UMAP_UI_DEFAULTS): boolean {
  return umapInputKey(p, defaults) === umapInputKey(defaults, defaults);
}

/** 別レイアウトを試すためのランダムなシード文字列 */
export function randomSeed(): string {
  return `seed-${Math.random().toString(36).slice(2, 10)}`;
}

type Props = {
  params: UmapUiParams;
  onChange: (next: UmapUiParams) => void;
  /** この画面での既定値。既定と一致するキーは入力に含めない */
  defaults?: UmapUiParams;
  /** 表示中の結果に未反映の変更があるか(呼び出し側が判定) */
  dirty?: boolean;
  /** 再実行の導線がある画面で、パネル末尾に出す補足 */
  note?: string;
  /** 初期状態で開くか */
  defaultOpen?: boolean;
};

export function UmapParamsPanel({ params, onChange, defaults = UMAP_UI_DEFAULTS, dirty, note, defaultOpen }: Props) {
  const set = <K extends keyof UmapUiParams>(key: K, value: UmapUiParams[K]) => onChange({ ...params, [key]: value });
  const atDefault = isUmapDefault(params, defaults);

  return (
    <details className="card" style={{ marginTop: 0 }} open={defaultOpen}>
      <summary style={{ cursor: "pointer" }}>
        UMAP 詳細パラメータ{dirty ? "(変更あり — 再実行で反映)" : atDefault ? "(既定値)" : "(変更あり)"}
      </summary>
      <p className="note" style={{ marginTop: 8 }}>
        通常は変更不要です。同じ設定・同じデータなら UMAP は完全に決定論的で、何度実行しても同一の座標になります。
        別のレイアウトを見たい場合はシードを変えてください。
      </p>
      <div className="row" style={{ marginTop: 8 }}>
        <label style={{ margin: 0, fontWeight: 400 }}>
          nNeighbors: {params.nNeighbors}
          <br />
          <input
            type="range"
            min={2}
            max={100}
            value={params.nNeighbors}
            onChange={(e) => set("nNeighbors", Number(e.target.value))}
            style={{ width: 160 }}
          />
          <span className="note"> 局所⇔大域</span>
        </label>
        <label style={{ margin: 0, fontWeight: 400 }}>
          minDist: {params.minDist.toFixed(2)}
          <br />
          <input
            type="range"
            min={0}
            max={0.99}
            step={0.01}
            value={params.minDist}
            onChange={(e) => set("minDist", Number(e.target.value))}
            style={{ width: 160 }}
          />
          <span className="note"> 密集⇔分散</span>
        </label>
        <label style={{ margin: 0, fontWeight: 400 }}>
          spread: {params.spread.toFixed(1)}
          <br />
          <input
            type="range"
            min={0.5}
            max={3}
            step={0.1}
            value={params.spread}
            onChange={(e) => set("spread", Number(e.target.value))}
            style={{ width: 160 }}
          />
          <span className="note"> 全体スケール</span>
        </label>
        <label style={{ margin: 0, fontWeight: 400 }}>
          epochs: {params.nEpochs === 0 ? "自動" : params.nEpochs}
          <br />
          <input
            type="range"
            min={0}
            max={1000}
            step={50}
            value={params.nEpochs}
            onChange={(e) => set("nEpochs", Number(e.target.value))}
            style={{ width: 160 }}
          />
          <span className="note"> 反復回数(0=自動)</span>
        </label>
        <label style={{ margin: 0, fontWeight: 400 }}>
          シード
          <br />
          <input value={params.seed} onChange={(e) => set("seed", e.target.value)} style={{ width: 140 }} />
        </label>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button
          type="button"
          onClick={() => set("seed", randomSeed())}
          title="シードだけをランダムに変え、同じ設定で別のレイアウトを得る"
        >
          別のレイアウトを試す(シード変更)
        </button>
        <button type="button" onClick={() => onChange({ ...defaults })} disabled={atDefault}>
          既定値に戻す
        </button>
      </div>
      {note && (
        <p className="note" style={{ marginBottom: 0 }}>
          {note}
        </p>
      )}
    </details>
  );
}
