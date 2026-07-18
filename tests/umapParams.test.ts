import { describe, expect, it } from "vitest";
import {
  isUmapDefault,
  randomSeed,
  toUmapInput,
  UMAP_UI_DEFAULTS,
  type UmapUiParams,
} from "../src/components/UmapParamsPanel";
import { runClusteringCore } from "../src/lib/pipeline/clusteringCore";
import { umapCheckpointKey } from "../src/lib/pipeline/steps/clustering";
import { LAYOUT_UMAP_DEFAULTS } from "../src/stance-spectrum/layoutParams";

// UMAP 詳細パラメータ(拡張設定)の変換規約とチェックポイントキーへの反映。
// 肝は「既定値のままなら入力に何も現れない」= 既存キャッシュを壊さないこと。

describe("toUmapInput", () => {
  it("既定値のままなら umap は空、seed は既定値", () => {
    const input = toUmapInput(UMAP_UI_DEFAULTS);
    expect(input.umap).toEqual({});
    expect(input.seed).toBe("kouchou-ai");
    expect(isUmapDefault(UMAP_UI_DEFAULTS)).toBe(true);
  });

  it("変更したキーだけが入力に現れる", () => {
    const params: UmapUiParams = { ...UMAP_UI_DEFAULTS, minDist: 0.5 };
    expect(toUmapInput(params).umap).toEqual({ minDist: 0.5 });
    expect(isUmapDefault(params)).toBe(false);
  });

  it("nEpochs は 0(自動)なら出力せず、正の値なら出力する", () => {
    expect(toUmapInput({ ...UMAP_UI_DEFAULTS, nEpochs: 0 }).umap).toEqual({});
    expect(toUmapInput({ ...UMAP_UI_DEFAULTS, nEpochs: 300 }).umap).toEqual({ nEpochs: 300 });
  });

  it("空のシードは既定値に落ちる", () => {
    expect(toUmapInput({ ...UMAP_UI_DEFAULTS, seed: "" }).seed).toBe("kouchou-ai");
  });

  it("賛否スペクトラムの既定値を渡すと、その既定との差分だけが出る", () => {
    // minDist 0.15 / spread 1.5 はこの画面では「既定」なので出力されない
    const input = toUmapInput(LAYOUT_UMAP_DEFAULTS, LAYOUT_UMAP_DEFAULTS);
    expect(input.umap).toEqual({});
    expect(input.seed).toBe("phase2-layout");
    // 通常版の既定と比べれば差分として現れる
    expect(toUmapInput(LAYOUT_UMAP_DEFAULTS).umap).toEqual({ minDist: 0.15, spread: 1.5 });
  });

  it("randomSeed は既定シードと衝突しない", () => {
    expect(randomSeed()).not.toBe(UMAP_UI_DEFAULTS.seed);
  });
});

describe("umapCheckpointKey", () => {
  const base = { count: 100, dim: 8, seed: "kouchou-ai" };

  it("既定パラメータなら従来どおりのキー(既存キャッシュ互換)", () => {
    expect(umapCheckpointKey({ ...base, umap: {} })).toBe("100/8/kouchou-ai");
    expect(umapCheckpointKey(base)).toBe("100/8/kouchou-ai");
  });

  it("パラメータやシードを変えるとキーが分かれる", () => {
    const a = umapCheckpointKey(base);
    const b = umapCheckpointKey({ ...base, umap: { minDist: 0.5 } });
    const c = umapCheckpointKey({ ...base, seed: "other" });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("runClusteringCore のパラメータ反映", () => {
  // 3つの塊。次元は小さくてよい(UMAP のパラメータが座標に効くことだけ見る)
  const dim = 4;
  const count = 60;
  const vectors = new Float32Array(count * dim);
  for (let i = 0; i < count; i++) {
    const group = i % 3;
    for (let d = 0; d < dim; d++) {
      // 決定的な微小ノイズ + グループごとのオフセット
      vectors[i * dim + d] = group * 5 + ((i * 37 + d * 11) % 13) / 100;
    }
  }
  const input = { vectors, dim, count, clusterNums: [3] };

  it("同じシード・同じパラメータなら完全に同一の座標になる", () => {
    const a = runClusteringCore({ ...input, seed: "s" });
    const b = runClusteringCore({ ...input, seed: "s" });
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(Array.from(a.y)).toEqual(Array.from(b.y));
  });

  it("シードを変えると座標が変わる(別レイアウトが得られる)", () => {
    const a = runClusteringCore({ ...input, seed: "s" });
    const b = runClusteringCore({ ...input, seed: "other-seed" });
    expect(Array.from(a.x)).not.toEqual(Array.from(b.x));
  });

  it("UMAP パラメータを変えると座標が変わる", () => {
    const a = runClusteringCore({ ...input, seed: "s" });
    const b = runClusteringCore({ ...input, seed: "s", umap: { minDist: 0.9, spread: 2.5 } });
    expect(Array.from(a.x)).not.toEqual(Array.from(b.x));
  });

  it("nEpochs の指定が実際の反復回数として使われる", () => {
    let observed = 0;
    runClusteringCore(
      { ...input, seed: "s", umap: { nEpochs: 42 } },
      {
        onUmapProgress: (_epoch, total) => {
          observed = total;
        },
      },
    );
    expect(observed).toBe(42);
  });
});
