import Plotly from "plotly.js-dist-min";
import { useEffect, useRef } from "react";

// react-plotly.js を使わない薄いラッパ(plotly.js-dist-min 直使用)。

// biome-ignore lint/suspicious/noExplicitAny: Plotly のトレース/レイアウトは動的構造
type PlotlyData = any;

type Props = {
  data: PlotlyData[];
  layout: Record<string, unknown>;
  config?: Record<string, unknown>;
  style?: React.CSSProperties;
  onClick?: (event: PlotlyData) => void;
  onHover?: (event: PlotlyData) => void;
};

export function Plot({ data, layout, config, style, onClick, onHover }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const onClickRef = useRef(onClick);
  const onHoverRef = useRef(onHover);
  onClickRef.current = onClick;
  onHoverRef.current = onHover;
  // 進行中の Plotly.react()。アンマウント時はこれの完了を待ってから purge する。
  const pendingRef = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    pendingRef.current = Plotly.react(el, data, layout, { responsive: true, ...config }).then(() => {
      if (cancelled) return;
      // biome-ignore lint/suspicious/noExplicitAny: Plotly が拡張した HTMLElement
      const gd = el as any;
      gd.removeAllListeners?.("plotly_click");
      gd.removeAllListeners?.("plotly_hover");
      gd.on?.("plotly_click", (event: PlotlyData) => onClickRef.current?.(event));
      gd.on?.("plotly_hover", (event: PlotlyData) => onHoverRef.current?.(event));
    });
    return () => {
      cancelled = true;
    };
  }, [data, layout, config]);

  useEffect(() => {
    const el = ref.current;
    return () => {
      if (!el) return;
      // 描画の途中で purge すると、Plotly 内部に残った遅延タスクが破棄済みの
      // _fullLayout を参照して落ちる(_redrawFromAutoMarginCount の TypeError)。
      // レイアウト Worker が座標を流し続けている最中にページを離れると起きやすい。
      // 進行中の描画が終わってから片付ける。
      pendingRef.current.catch(() => {}).then(() => Plotly.purge(el));
    };
  }, []);

  return <div ref={ref} style={{ width: "100%", height: "100%", ...style }} />;
}
