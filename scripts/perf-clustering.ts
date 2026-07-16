/**
 * クラスタリング性能検証(検証計画 §9-3)。
 *   npx vite-node scripts/perf-clustering.ts
 * 10,000 args × 1536 次元で UMAP + KMeans + ward が完走することを確認する。
 */
import { runClusteringCore } from "../src/lib/pipeline/clusteringCore";

const COUNT = Number(process.env.PERF_N ?? 10000);
const DIM = 1536;

console.log(`${COUNT} 点 × ${DIM} 次元を生成中...`);
const vectors = new Float32Array(COUNT * DIM);
// 10個の疑似クラスタ中心 + ノイズ(決定的)
let state = 123456789;
const rand = () => {
  state = (state * 1103515245 + 12345) % 2147483648;
  return state / 2147483648 - 0.5;
};
const centers: number[][] = Array.from({ length: 10 }, () => Array.from({ length: DIM }, () => rand() * 4));
for (let i = 0; i < COUNT; i++) {
  const c = centers[i % 10];
  for (let d = 0; d < DIM; d++) vectors[i * DIM + d] = c[d] + rand() * 0.5;
}

const start = Date.now();
let lastReport = 0;
const result = runClusteringCore(
  { vectors, dim: DIM, count: COUNT, clusterNums: [10, 100], seed: "perf" },
  {
    onPhase: (phase) => console.log(`[${Math.round((Date.now() - start) / 1000)}s] phase: ${phase}`),
    onUmapProgress: (epoch, total) => {
      if (Date.now() - lastReport > 15000) {
        console.log(`[${Math.round((Date.now() - start) / 1000)}s] UMAP ${epoch}/${total}`);
        lastReport = Date.now();
      }
    },
  },
);
const elapsed = Math.round((Date.now() - start) / 1000);
console.log(`完了: ${elapsed}s`);
console.log(`レベル1 クラスタ数: ${new Set(result.assignments[0]).size}`);
console.log(`レベル2 クラスタ数: ${new Set(result.assignments[1]).size}`);
if (elapsed > 600) {
  console.error("10分を超過 — 性能要件未達");
  process.exit(1);
}
