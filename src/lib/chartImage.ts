import Plotly from "plotly.js-dist-min";

// 表示中の Plotly 図版を PNG Blob にする(PowerPoint への埋め込み用)。
//
// Plotly のグラフ要素はコンテナ内に .js-plotly-plot として作られる(react/newPlot が
// 付与する)ため、Plot コンポーネントに ref を通す改造をせずコンテナから引ける。
// 散布図は scattergl(WebGL)だが、toImage は WebGL トレースも取り込める
// (サンプル 7,641 点で点・凸包・ラベルが出ることを実測済み)。

export type CaptureOptions = {
  /** 出力画像の幅(px)。既定 1600 */
  width?: number;
  /** 出力画像の高さ(px)。既定 1200(4:3。スライドに合わせる) */
  height?: number;
  /** 解像度倍率。既定 2(高 DPI) */
  scale?: number;
};

const DEFAULTS = { width: 1600, height: 1200, scale: 2 } as const;

/** コンテナ内の Plotly グラフ要素を取り出す。無ければ null */
export function findPlotlyGraph(container: Element | Document | null): HTMLElement | null {
  if (!container) return null;
  if (container instanceof HTMLElement && container.classList.contains("js-plotly-plot")) return container;
  return container.querySelector<HTMLElement>(".js-plotly-plot");
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, body] = dataUrl.split(",");
  const mime = /:(.*?);/.exec(header)?.[1] ?? "image/png";
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * 表示中の図版を PNG にする。画面の見た目(ズーム・表示中のトレース・フィルタ)が
 * そのまま反映される。グラフが見つからなければ null(呼び出し側でスキップできるように)。
 */
export async function captureChartPng(
  container: Element | Document | null,
  options: CaptureOptions = {},
): Promise<Blob | null> {
  const graph = findPlotlyGraph(container);
  if (!graph) return null;
  const { width, height, scale } = { ...DEFAULTS, ...options };
  const dataUrl = await Plotly.toImage(graph, { format: "png", width, height, scale });
  return dataUrlToBlob(dataUrl);
}
