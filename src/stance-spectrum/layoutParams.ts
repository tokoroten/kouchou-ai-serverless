// 表示用レイアウト UMAP の調整パラメータ。
// Worker(layout.worker.ts)と UI(StanceSpectrumPage)の双方から参照するため、
// Worker 本体とは別モジュールに置く(Worker を直接 import すると
// メインスレッドで self.onmessage が登録されてしまうため)。
//
// 形は components/UmapParamsPanel.tsx の UmapUiParams と構造的に同一で、
// そのまま同じパネルコンポーネントに渡せる。既定値だけが通常版と異なる。

export type LayoutUmapParams = {
  nNeighbors: number;
  minDist: number;
  spread: number;
  /** 0 = 自動(COLD/WARM の焼きなましスケジュールに従う) */
  nEpochs: number;
  seed: string;
};

export const LAYOUT_UMAP_DEFAULTS: LayoutUmapParams = {
  nNeighbors: 15,
  minDist: 0.15,
  spread: 1.5,
  nEpochs: 0,
  seed: "phase2-layout",
};
