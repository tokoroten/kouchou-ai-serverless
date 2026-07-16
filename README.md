# 広聴AI サーバレス版 (kouchou-ai-serverless)

**ブラウザだけで完結するブロードリスニングツール。**

[広聴AI (kouchou-ai)](https://github.com/digitaldemocracy2030/kouchou-ai) の分析パイプライン
(意見抽出 → 埋め込み → UMAP → 階層クラスタリング → LLM ラベリング → レポート生成)を
TypeScript で再実装し、静的サイトとして配布しています。サーバ・Python・Docker は不要です。

**▶ 使ってみる: https://tokoroten.github.io/kouchou-ai-serverless/**

## 使い方(3ステップ)

1. **設定** — プロバイダ(OpenAI など)の API キーを貼り、チャット/埋め込みのモデルを選ぶ。
   「接続テスト」「応答テスト」で疎通確認ができます。
2. **新規作成** — 意見データの CSV をドロップし、本文列と属性列を選ぶ。
   コスト見積りを確認して実行。
3. **待つ** — 進捗はステップごとに表示。タブを閉じても途中から再開できます。
   完成したレポートは散布図 / 濃い意見グループ / ツリーマップ / 階層リストで閲覧できます。

### 特徴

- **完全ブラウザ内実行** — データは選択した LLM API 以外のどこにも送信されません。
  UMAP・KMeans・ward 法クラスタリングは Web Worker でブラウザ内実行。
- **本家互換** — 出力は本家 kouchou-ai の `hierarchical_result.json` とスキーマ互換。
  本家が生成した JSON の読み込み・表示も可能。
- **多様な LLM プロバイダ** — OpenAI / OpenRouter(無償モデル検索付き) / Azure OpenAI /
  AWS Bedrock / LM Studio / Ollama / 任意の OpenAI 互換 API。
  さらに **Chrome 内蔵 Gemini Nano**(チャット)と **transformers.js + WebGPU**(埋め込み)により
  完全ローカル・無料での分析にも対応。
- **チェックポイントと再開** — 抽出はコメント単位、埋め込みはバッチ単位、ラベリングはクラスタ単位で
  IndexedDB に逐次保存。タブを閉じても API コストを失わずに再開できます。
- **前処理と後処理の分離** — 高コストな前処理(意見抽出+埋め込み)の結果を使い回して、
  クラスタ数などを変えた再クラスタリングをほぼ無料で何度でも実行できます。
  同一構成のクラスタのラベルはキャッシュから再利用されます。
- **リアルタイムモード** — UMAP の収束過程をライブ表示しながら、スライダーで
  クラスタ数を対話的に調整。構成が決まったらオンデマンドでラベリング。
- **エクスポート** — 本家互換 Result JSON / **単一 HTML レポート**(オフラインで開ける自己完結ファイル)/
  CSV(意見一覧・クラスタ一覧)。

### 入力 CSV

ヘッダ付き CSV。意見本文の列(本家準拠は `comment-body`)は必須で、任意の列を属性
(年代・性別など)として取り込み、レポート上でフィルタできます。列名は取込時に自由に選べます。

## 開発

```bash
pnpm install
pnpm dev        # 開発サーバ
pnpm build      # 本番ビルド(単一HTMLテンプレート → 本体の順にビルド)
pnpm test       # Vitest(エンジン単体テスト)
pnpm lint       # Biome
pnpm debug:pipeline  # 実 API でのパイプライン E2E(要 .env)
```

設計書は [docs/DESIGN.md](docs/DESIGN.md)。フェーズ2(インタラクティブ再クラスタリング)の
設計は [docs/INTERACTIVE_DESIGN_REVIEW.md](docs/INTERACTIVE_DESIGN_REVIEW.md)。

アーキテクチャ概要:

- `src/lib/pipeline/` — React 非依存の分析エンジン(本家 analysis-core の移植)
- `src/lib/llm/` — OpenAI 互換クライアント(構造化出力の三段フォールバック・指数バックオフ・
  タイムアウト・セマフォ並列制御)、Gemini Nano、transformers.js ローカル埋め込み
- `src/lib/workers/clustering.worker.ts` — UMAP+KMeans+ward(中間座標をストリーミング)
- `src/lib/storage/` — Dexie (IndexedDB) チェックポイント
- `src/components/` — UI(設定 / ウィザード / 進捗 / ビューア / リアルタイムモード)
- `src/prompts/` — 本家プロンプトの逐語移植

## ライセンス

[AGPL-3.0](LICENSE)(本家 kouchou-ai に準拠)。
プロンプト・アルゴリズムは [digitaldemocracy2030/kouchou-ai](https://github.com/digitaldemocracy2030/kouchou-ai) からの移植です。
