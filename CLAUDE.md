# CLAUDE.md

このリポジトリは **kouchou-ai-serverless** — ブラウザだけで完結するブロードリスニングツール。
サーバなし、静的 HTML のみで、LLM 呼び出し・埋め込み・UMAP・クラスタリング・可視化のすべてを
ブラウザ内で実行する。

## 最初に読むもの

1. `docs/DESIGN.md` — 設計書。アーキテクチャ、パイプライン仕様、マイルストーン、受け入れ基準の
   すべてがここにある。**実装はこの設計書のマイルストーン順(M0→M8)に進めること。**
2. 参照実装(本家 広聴AI)は隣のディレクトリ `../kouchou-ai` にある。
   移植元ファイルのパスは設計書 §6 の対応表を参照。**本家リポジトリは読み取り専用 — 変更しない。**
3. `docs/INTERACTIVE_DESIGN_REVIEW.md` — フェーズ2(次世代版: インタラクティブ
   再クラスタリング)の実装方針。フェーズ2は M0〜M8 完了後に着手するが、
   「通常版との合流点」の節には**通常版側で先に仕込む項目**(extraction の
   出力スキーマ拡張性、clustering worker のプロトコル等)があるため、
   M3/M5 の実装前に一読すること。一次資料は `docs/INTERACTIVE_DESIGN_MEMO.md`(改変禁止)。

## 重要な原則

- **本家互換**: 出力レポートは本家の `hierarchical_result.json`(型は
  `../kouchou-ai/apps/public-viewer/type.ts` の `Result`)とスキーマ互換を維持する。
- **プロンプトは本家から逐語移植**(`../kouchou-ai/apps/admin/app/create/*Prompt.ts`)。
  勝手に改変しない。
- **パイプラインエンジンは React 非依存**の純 TS モジュールにし、Vitest でテストする。
- クラスタリング(umap-js + KMeans + ward)は Web Worker 内で実行する。
- すべての LLM 呼び出しに AbortSignal・リトライ(指数バックオフ)・トークン集計を配線する。
- チェックポイント(IndexedDB/Dexie)により、タブを閉じても処理を再開できること。

## 技術スタック

Vite + React + TypeScript (strict) / Zustand / Papa Parse / umap-js / ml-kmeans / ml-hclust /
Plotly.js / Dexie / Biome / Vitest。パッケージマネージャは pnpm。

## 開発コマンド(確定)

```bash
pnpm install
pnpm dev              # 開発サーバ
pnpm build            # 本番ビルド (テンプレート → 本体の2段。base=/kouchou-ai-serverless/)
pnpm test             # Vitest (エンジン単体テスト)
pnpm lint             # Biome
pnpm debug:pipeline   # 実 API での E2E (要 .env、DEBUG_PROVIDER=openai|lmstudio|openrouter)
npx vite-node scripts/browser-smoke.ts  # Playwright ブラウザスモーク (要 pnpm dev + .env)
```

実装済み。設計との乖離は docs/DESIGN.md §11.5 に記録している。

## 進め方

- 各マイルストーンの完了時に、設計書 §8 の受け入れ基準を実際に動かして確認してから次へ進む。
- 設計書と実装が乖離する判断をした場合は、`docs/DESIGN.md` を更新して理由を残す。
- コミットは Conventional Commits(feat/fix/docs/chore/test)。
