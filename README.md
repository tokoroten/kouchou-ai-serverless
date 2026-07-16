# kouchou-ai-serverless

ブラウザだけで完結するブロードリスニングツール(設計フェーズ)。

[広聴AI (kouchou-ai)](https://github.com/digitaldemocracy2030/kouchou-ai) の分析パイプライン
(意見抽出 → 埋め込み → UMAP → 階層クラスタリング → LLM ラベリング → レポート生成)を
TypeScript で再実装し、**静的サイトとして配布**する。

- インストール不要 — URL を開き、API キーを貼り、CSV を投げ込むだけ
- OpenAI / OpenRouter / LM Studio / Ollama など OpenAI 互換 API に対応
- データは選択した LLM プロバイダ以外に送信されない
- 処理は IndexedDB にチェックポイントされ、タブを閉じても再開可能
- 出力レポートは本家 kouchou-ai の `hierarchical_result.json` とスキーマ互換

## ステータス

設計完了・実装前。設計書: [docs/DESIGN.md](docs/DESIGN.md)

ロードマップ:

1. **フェーズ1(通常版)**: 本家互換の静的レポート生成(M0〜M8)
2. **フェーズ2(次世代版)**: 意見の構造化属性(stance/topic/reason)に基づく
   インタラクティブ再クラスタリング — スライダー操作で点群が連続変形する分析UI。
   設計: [docs/INTERACTIVE_DESIGN_MEMO.md](docs/INTERACTIVE_DESIGN_MEMO.md)(一次資料)+
   [docs/INTERACTIVE_DESIGN_REVIEW.md](docs/INTERACTIVE_DESIGN_REVIEW.md)(実装方針)

## ライセンス

本家 kouchou-ai に準拠(実装開始時に確定)。
