// 表示用の力学レイアウト Worker(一次資料「UMAPと表示」+ レビュー置換表)。
// - 初期座標(通常版の UMAP)からのウォームスタート。毎回ランダム初期化しない
// - 辺の重み変更時は現在座標から数 step ずつ再最適化し、座標をストリーミングする
// - stance 軸: 各 step 後に x += λ(stanceScore·scale − x) とナッジして方向を安定させる
//   (umap-js は損失をカスタムできないための置換。レビュー置換表のとおり)

export type LayoutWorkerRequest =
  | { type: "init"; x: Float32Array; y: Float32Array }
  | {
      type: "edges";
      source: Int32Array;
      target: Int32Array;
      weights: Float32Array;
      threshold: number;
    }
  | { type: "stanceAxis"; enabled: boolean; scores: Float32Array | null; lambda: number }
  | { type: "stop" };

export type LayoutWorkerResponse = { type: "coords"; x: Float32Array; y: Float32Array; alpha: number };

let x: Float32Array = new Float32Array(0);
let y: Float32Array = new Float32Array(0);
let vx: Float32Array = new Float32Array(0);
let vy: Float32Array = new Float32Array(0);
let edgeSource: Int32Array = new Int32Array(0);
let edgeTarget: Int32Array = new Int32Array(0);
let edgeWeights: Float32Array = new Float32Array(0);
let edgeThreshold = 0;
let stanceEnabled = false;
let stanceScores: Float32Array | null = null;
let stanceLambda = 0.1;
let alpha = 0; // 冷却係数。辺の更新でリセット
let timer: ReturnType<typeof setInterval> | null = null;

const TICK_MS = 33; // ~30fps
const ALPHA_DECAY = 0.985;
const ALPHA_MIN = 0.003;
const REPULSION = 0.55;
const ATTRACTION = 0.06;
const DAMPING = 0.6;
const CELL = 1.2; // 反発計算のグリッドセルサイズ(座標スケール依存)

function tick(): void {
  const n = x.length;
  if (n === 0 || alpha < ALPHA_MIN) return;

  // 反発: グリッド分割して近傍セルのみ計算(O(n·近傍))
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = `${Math.floor(x[i] / CELL)}:${Math.floor(y[i] / CELL)}`;
    const cell = grid.get(key);
    if (cell) cell.push(i);
    else grid.set(key, [i]);
  }
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(x[i] / CELL);
    const cy = Math.floor(y[i] / CELL);
    let fx = 0;
    let fy = 0;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const cell = grid.get(`${gx}:${gy}`);
        if (!cell) continue;
        for (const j of cell) {
          if (j === i) continue;
          const dx = x[i] - x[j];
          const dy = y[i] - y[j];
          const d2 = dx * dx + dy * dy + 0.01;
          if (d2 > CELL * CELL * 4) continue;
          const f = REPULSION / d2;
          fx += dx * f;
          fy += dy * f;
        }
      }
    }
    vx[i] += fx * alpha;
    vy[i] += fy * alpha;
  }

  // 引力: 重みの高い辺は近く、低い辺は遠くへ(バネ)
  for (let e = 0; e < edgeSource.length; e++) {
    const w = edgeWeights[e];
    if (w <= edgeThreshold) continue;
    const i = edgeSource[e];
    const j = edgeTarget[e];
    const dx = x[j] - x[i];
    const dy = y[j] - y[i];
    const dist = Math.sqrt(dx * dx + dy * dy) + 1e-6;
    const rest = 0.3 + (1 - w) * 2.5; // 重みが高いほど近づく
    const f = (ATTRACTION * (dist - rest) * w) / dist;
    vx[i] += dx * f * alpha;
    vy[i] += dy * f * alpha;
    vx[j] -= dx * f * alpha;
    vy[j] -= dy * f * alpha;
  }

  // 速度適用 + 減衰 + stance 軸ナッジ
  for (let i = 0; i < n; i++) {
    x[i] += Math.max(-0.5, Math.min(0.5, vx[i]));
    y[i] += Math.max(-0.5, Math.min(0.5, vy[i]));
    vx[i] *= DAMPING;
    vy[i] *= DAMPING;
    if (stanceEnabled && stanceScores) {
      // x 方向を stance スコアに弱くアンカーする(スケールは座標系に合わせて8)
      x[i] += stanceLambda * alpha * (stanceScores[i] * 8 - x[i]);
    }
  }
  alpha *= ALPHA_DECAY;

  self.postMessage(
    { type: "coords", x: x.slice(), y: y.slice(), alpha } satisfies LayoutWorkerResponse,
    // slice したバッファを transfer
    { transfer: [] },
  );
}

self.onmessage = (event: MessageEvent<LayoutWorkerRequest>) => {
  const message = event.data;
  switch (message.type) {
    case "init":
      x = message.x.slice();
      y = message.y.slice();
      vx = new Float32Array(x.length);
      vy = new Float32Array(y.length);
      alpha = 0.3;
      if (!timer) timer = setInterval(tick, TICK_MS);
      break;
    case "edges":
      edgeSource = message.source;
      edgeTarget = message.target;
      edgeWeights = message.weights;
      edgeThreshold = message.threshold;
      alpha = 1.0; // 再加熱して現在座標から再最適化
      if (!timer) timer = setInterval(tick, TICK_MS);
      break;
    case "stanceAxis":
      stanceEnabled = message.enabled;
      stanceScores = message.scores;
      stanceLambda = message.lambda;
      alpha = Math.max(alpha, 0.5);
      break;
    case "stop":
      if (timer) clearInterval(timer);
      timer = null;
      break;
  }
};
