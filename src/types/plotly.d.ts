declare module "plotly.js-dist-min" {
  // 最小限の型シム。トレース構造はビューア側でオブジェクトリテラルとして構築する。
  // biome-ignore lint/suspicious/noExplicitAny: 外部ライブラリの型シム
  const Plotly: any;
  export default Plotly;
}
