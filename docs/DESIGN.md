# kouchou-ai-serverless 設計書

ブラウザだけで完結するブロードリスニングツール。
[kouchou-ai](https://github.com/digitaldemocracy2030/kouchou-ai)(広聴AI)の分析パイプラインを
TypeScript で再実装し、**静的 HTML として配布**する。サーバ・Python・Node ランタイム・Docker を
一切要求しない。

- 参照実装(本家)はこのリポジトリの隣 `../kouchou-ai` にある前提で書く。
- 本書は「新しい Claude セッションがこれだけ読めば実装に着手できる」ことを目的とする。

---

## 1. 背景と目的

本家 kouchou-ai は FastAPI(Python)+ Next.js(Node)+ Docker という構成で、
一般ユーザが手元で動かすのは著しく難しい。しかしパイプラインの実体は
「OpenAI 互換 API の呼び出し + 行列計算 + JSON 生成」であり、**サーバが本質的に必要な処理は存在しない**。

そこで全処理をブラウザ内で実行する版を作る:

- 配布 = GitHub Pages に置いた静的サイトの URL を開くだけ。
- ユーザがやることは「プロバイダを選ぶ → API キーを貼る → CSV を投げ込む」のみ。
- データは LLM プロバイダ以外のどこにも送信されない(プライバシー面で本家より説明しやすい)。

### ゴール

1. CSV(意見データ)から本家互換の階層クラスタリングレポートをブラウザ内で生成できる。
2. 生成したレポートを本家の `hierarchical_result.json` と**スキーマ互換**の JSON として保存・読込できる。
3. OpenAI / OpenRouter / LM Studio / Ollama など OpenAI 互換エンドポイントを設定 UI から切替できる。
4. 処理の途中経過が IndexedDB に保存され、タブを閉じても**再開できる**。
5. GitHub Pages に自動デプロイされる。

### 非ゴール(スコープ外)

- マルチユーザ・認証・レポートのサーバ保存(共有はファイルベースで行う)。
- 本家の admin 相当の運用機能(公開設定、Azure 連携、静的サイトビルダー)。
- 本家 Python パイプラインとのビット単位の一致(クラスタ構造として同等であればよい)。
- モバイル最適化(デスクトップブラウザ前提。壊れない程度でよい)。

---

## 2. 全体アーキテクチャ

```
┌────────────────────────── ブラウザ (静的SPA) ──────────────────────────┐
│                                                                        │
│  UI (React)                                                            │
│   ├─ 設定画面: プロバイダ2スロット (chat / embedding) → localStorage   │
│   ├─ レポート作成ウィザード: CSV投入 → 設定 → 実行                      │
│   ├─ 進捗画面: ステップ/件数/トークン使用量/中断・再開                  │
│   └─ ビューア: 散布図 / ツリーマップ (Plotly.js)                        │
│                                                                        │
│  パイプラインエンジン (TypeScript, UIとは独立したモジュール)             │
│   extraction → embedding → clustering → initial_labelling              │
│   → merge_labelling → overview → aggregation                           │
│        │              │                                                │
│        │              └─ Web Worker: umap-js + KMeans + ward           │
│        └─ fetch: OpenAI互換 chat/embeddings (並列・リトライ・中断可)     │
│                                                                        │
│  永続化 (IndexedDB via Dexie)                                          │
│   projects / stepResults / extractionCache / reports                   │
└────────────────────────────────────────────────────────────────────────┘
         │ fetch (CORS)
         ▼
  OpenAI / OpenRouter / LM Studio / Ollama / 任意のOpenAI互換API
```

原則: **パイプラインエンジンは React に依存しない純粋な TS モジュール**とし、
進捗はコールバック/イベントで UI に通知する。テストは Vitest でエンジン単体を回す。

---

## 3. 技術スタック

| 用途 | 採用 | 備考 |
|---|---|---|
| ビルド/開発 | Vite + React + TypeScript (strict) | Next.js は使わない(SSR不要、Pages 配布が目的) |
| UI | Chakra UI v3 もしくは軽量CSS | 本家 admin/viewer が Chakra。こだわらない |
| 状態管理 | Zustand | 小規模で十分 |
| CSVパース | Papa Parse | ヘッダ付きCSV、Shift_JIS も encoding 指定で対応 |
| 次元削減 | umap-js (@umap-js/umap-js または umap-js) | `nComponents:2, nNeighbors:15`。step() で進捗を出せる |
| KMeans | ml-kmeans | 最深レベルのクラスタ数で1回だけ実行 |
| 階層クラスタ | ml-hclust (AGNES, ward) | KMeans重心に対して ward。`group(n)` でレベル別カット |
| 可視化 | Plotly.js (react-plotly.js) | 本家 viewer と同系 |
| 永続化 | Dexie (IndexedDB) | チェックポイント/レポート保存 |
| ローカル埋め込み(任意) | @huggingface/transformers (transformers.js) | multilingual-e5-small 等。M8 のオプション |
| Lint/Format | Biome | 本家と同じ |
| テスト | Vitest | エンジン部を中心に |
| デプロイ | GitHub Actions → GitHub Pages | `vite build` の `base` 設定に注意 |

乱数: UMAP / KMeans / サンプリングは `seedrandom` 等で**シード可能**にしておく
(テスト再現性のため。UIからは非公開でよい)。

---

## 4. LLM プロバイダ抽象

### 4.1 設定は2スロット

OpenRouter には embeddings エンドポイントが**ない**ため、設定は必ず2スロットに分ける:

```ts
type EndpointConfig = {
  baseUrl: string;        // 例: https://api.openai.com/v1
  apiKey: string;         // LM Studio / Ollama では空でよい
  model: string;          // 例: gpt-4o-mini / text-embedding-3-small
};
type Settings = {
  chat: EndpointConfig;       // 抽出・ラベリング・概要
  embedding: EndpointConfig;  // 埋め込み(chatと同一プロバイダなら使い回すUIにする)
  concurrency: number;        // 既定 8
};
```

- localStorage に保存。「このブラウザに保存されます」の注意書きと削除ボタンを必ず付ける。
- プリセット(選択でbaseUrl等を自動入力): OpenAI / OpenRouter / LM Studio (`http://localhost:1234/v1`) /
  Ollama (`http://localhost:11434/v1`) / カスタム。
- 接続テストボタン: `GET {baseUrl}/models` でモデル一覧を取得しドロップダウンに反映。
  embeddings スロットは実際に 1 件埋め込みを投げて次元数を表示する。

### 4.2 CORS の実情(プリセット選択時に案内文を出す)

| プロバイダ | ブラウザ直叩き | 備考 |
|---|---|---|
| OpenAI | ○ | そのまま動く |
| OpenRouter | ○ | chat のみ。embeddings は無い |
| LM Studio | 要設定 | サーバ設定で CORS を有効化 |
| Ollama | 要設定 | `OLLAMA_ORIGINS` 環境変数の設定が必要 |
| Azure OpenAI | 要注意 | 認証ヘッダ(`api-key`)とパスが異なる。プリセットで差分吸収(優先度低) |

### 4.3 チャット呼び出しと構造化出力

本家は `request_to_chat_ai(messages, model, json_schema=PydanticModel)` で
Structured Outputs を使う(`../kouchou-ai/packages/analysis-core/src/analysis_core/services/llm.py` 参照)。
本プロジェクトでは:

1. まず `response_format: { type: "json_schema", json_schema: {...} }` で投げる。
2. プロバイダが非対応(400等)なら `response_format: { type: "json_object" }` にフォールバック、
   さらにダメならプロンプト末尾に「JSONのみで応答せよ」を足して素で投げる。
3. 応答パースは寛容に: ```json フェンス除去、`<think>...</think>` 除去、
   末尾カンマ除去、失敗時は該当件のみ空扱い(本家 extraction と同じ思想)。
   本家の `services/parse_json_list.py` を移植する。

リトライ: 429/5xx は指数バックオフ(初期1s、最大60s、最大5回)。`Retry-After` を尊重。
全呼び出しで usage(入出力トークン)を集計し UI に表示する。

---

## 5. データモデル

### 5.1 入力 CSV

本家と同じ列構成(`../kouchou-ai/packages/analysis-core/src/analysis_core/steps/extraction.py` 参照):

- 必須: `comment-id`, `comment-body`
- 任意: 属性列(自由)。UI で「属性として使う列」を選択させる。
- 空・空白のみの `comment-body` は除外(本家 #583 と同じ)。

### 5.2 出力: 本家互換 Result JSON

**最重要の互換性要件。** 本家 viewer の型定義
`../kouchou-ai/apps/public-viewer/type.ts` の `Result` / `Argument` / `Cluster` に一致させる。
実例: `../kouchou-ai/apps/api/broadlistening/pipeline/outputs/example-hierarchical-polis/hierarchical_result.json`

要点:

- `arguments[]`: `arg_id`(形式 `A{comment_id}_{j}`), `argument`, `comment_id`, `x`, `y`, `p`,
  `cluster_ids`(ルート `"0"` を含む全レベルのID、例 `["0","1_5","2_9"]`), `attributes?`
- `clusters[]`: `level`(ルート=0), `id`, `label`, `takeaway`, `value`(所属件数),
  `parent`(ルートは空文字), `density_rank_percentile`
- `comments`: `{ [comment_id]: { comment } }`
- `overview`: 全体要約文字列
- `config`: 使用モデル・プロンプト等(本家の `Config` 型に概ね準拠。埋められない項目は空文字でよい)
- `comment_num`, `propertyMap`(属性列があれば), `translations`(`{}` でよい)

クラスタ ID の命名は本家に合わせる: レベル L のクラスタは `"{L}_{index}"`、ルートは `"0"`。

### 5.3 IndexedDB スキーマ (Dexie)

```ts
// db.ts
projects:        "id, createdAt"        // { id, title, question, intro, csv(生データ), settingsSnapshot, status, currentStep }
stepResults:     "[projectId+step]"     // 各ステップの完了済み出力 (args, embeddings, clusters, labels, overview)
extractionCache: "[projectId+commentId]"// コメント単位の抽出結果(再開の粒度)
reports:         "id, createdAt"        // 完成した Result JSON
```

- **再開の粒度**: extraction はコメント単位、embedding はバッチ(100件)単位、
  labelling はクラスタ単位でキャッシュする。ステップ完了時に `stepResults` へ確定保存。
- embeddings は `Float32Array` のまま保存(JSON化しない)。IndexedDB は TypedArray を直接格納できる。
- **`navigator.storage.persist()` を初回プロジェクト作成時に必ず要求する。**
  既定(best-effort)では容量逼迫時にブラウザが IndexedDB を消去し得るため、
  チェックポイントと作成済みレポートを守るのに必須。拒否された場合は
  「レポートは必ずエクスポートして保存してください」と UI で案内する。

### 5.4 OPFS(メモ: 将来の逃げ道)

OPFS(Origin Private File System)は全モダンブラウザで使えるオリジン隔離のファイルシステムで、
Worker 内なら同期アクセス(`createSyncAccessHandle`)ができ、大きなバイナリの読み書きは
IndexedDB より速い。**現想定規模(埋め込み ~60MB)では IndexedDB で足りるため採用しない**が、
埋め込みデータが数百 MB 級になった場合は embeddings の格納先を OPFS に移す。
その差し替えが局所で済むよう、ストレージ層(`lib/storage/`)は
「embeddings の読み書き」をインターフェースとして分離しておくこと。
なお OPFS はユーザーからファイルとして見えない(エクスプローラに現れない)ため、
ユーザーに渡すファイルの置き場としては使わない — それは §7.1 のエクスポートの仕事。

---

## 6. パイプライン仕様(本家との対応)

ステップ構成は本家のデフォルトワークフロー
`../kouchou-ai/packages/analysis-core/src/analysis_core/workflows/hierarchical_default.py` に従う。
visualization ステップ(HTML生成)は不要 — 本アプリのビューアがその代替。

| # | ステップ | 移植元 (../kouchou-ai/packages/analysis-core/src/analysis_core/steps/) |
|---|---|---|
| 1 | extraction | extraction.py |
| 2 | embedding | embedding.py |
| 3 | clustering | hierarchical_clustering.py |
| 4 | initial_labelling | hierarchical_initial_labelling.py |
| 5 | merge_labelling | hierarchical_merge_labelling.py |
| 6 | overview | hierarchical_overview.py |
| 7 | aggregation | hierarchical_aggregation.py |

### 6.1 extraction(意見抽出)

- コメント1件につき chat 呼び出し1回。system=抽出プロンプト、user=コメント本文。
- 期待レスポンス: `{ "extractedOpinionList": string[] }`(本家 `ExtractionResponse`)。
- 並列数は `settings.concurrency`(既定8)。セマフォで制御。
- **重複排除**: 同一の意見文字列は最初の `arg_id` に集約(本家 `argument_map` と同じ)。
- `arg_id = "A{comment-id}_{j}"`(j はそのコメント内の連番)。
- comment-id ↔ arg-id の関係(relations)も保持(aggregation で使う)。
- 失敗したコメントは空リスト扱いで続行。全件失敗ならエラー。
- チェックポイント: 1件完了ごとに `extractionCache` へ書き込み。再開時は未処理分のみ実行。

### 6.2 embedding(埋め込み)

- `args` を最大100件ずつ `POST {baseUrl}/embeddings` に投げる(本家はバッチ1000だがブラウザでは
  ペイロードとタイムアウトを考慮して小さく)。
- 既定モデル: OpenAI なら `text-embedding-3-small`(UIで変更可)。
- 結果は `Float32Array[]`、arg-id と対応付けて保存。

### 6.3 clustering(UMAP → KMeans → ward)

本家 `hierarchical_clustering.py` を忠実に移植する。**Web Worker 内で実行**(メインスレッドを塞がない)。

1. **クラスタ数の既定値**(cube-root ルール、`calculate_recommended_cluster_nums`):
   `lv1 = clamp(round(N^(1/3)), 2, 10)`、`lv2 = clamp(lv1^2, 2, min(1000, N))`、
   `cluster_nums = sorted(unique([lv1, lv2]))`。UI で上書き可。
2. **UMAP**: umap-js、`nComponents: 2`、`nNeighbors: min(15, N-1)`(最低2)。
   `step()` API で反復ごとに進めることができる。Worker からは進捗%だけでなく
   **数反復ごとに中間座標(Float32Array, transferable)を postMessage できるプロトコル**に
   しておく — 進捗表示にも §7.2 のインタラクティブモードにもそのまま使える。
3. **KMeans**: 最大クラスタ数(`cluster_nums` の最後)で1回実行(ml-kmeans)。
4. **上位レベル**: KMeans の**重心**に ward 法(ml-hclust AGNES, method:"ward")を適用し、
   各 `n(cluster_nums の残り)` で `group(n)` カット → 各点はその重心のマージ先ラベルを継承
   (本家 `merge_clusters_with_hierarchy` と同じ)。
5. 出力: 各 arg に `x, y` と各レベルの `cluster-level-{L}-id`(値は `"{L}_{label}"`)。

注意: umap-js は Python 版 UMAP と厳密一致しない(spectral init や最適化の差)。
**クラスタ構造として妥当か**を §9 の方法で検証する。

### 6.4 initial_labelling(最深レベルのラベル付け)

- 最深レベルの各クラスタについて: 所属 args から `sampling_num`(既定30程度、本家設定に合わせる)件を
  ランダムサンプリング → 改行結合して user メッセージに → chat 呼び出し。
- 期待レスポンス: `{ "label": string, "description": string }`。
- 失敗時はプレースホルダ文字列(本家と同じ「エラーでラベル名が取得できませんでした」)。
- クラスタ単位で並列・チェックポイント。

### 6.5 merge_labelling(上位レベルのラベル付け)

`hierarchical_merge_labelling.py` を移植。深いレベルから順に、子クラスタの label/description の
リスト(`- {label}: {description}` 形式)+ サンプル意見を入力として親クラスタの
label/description を生成する。あわせて:

- 親子関係表の構築(`_build_parent_child_mapping`): level1 の親は `"0"`。
- `density_rank_percentile` の計算(`calculate_cluster_density` を移植)。

### 6.6 overview(全体概要)

level 1 の全クラスタの label/description を
`# Cluster i/n: {label}\n\n{description}` 形式で連結して1回の chat 呼び出し。
期待レスポンス `{ "summary": string }`。パース失敗時は `<think>` タグを除去した生テキストを採用。

### 6.7 aggregation(Result JSON 組み立て)

`hierarchical_aggregation.py` を参照して §5.2 の Result JSON を組み立てる。
ルートクラスタ `"0"`(level 0, parent="", value=全件数)を追加し、各 argument の
`cluster_ids` に `"0"` と各レベル ID を入れる。属性列があれば `attributes` と `propertyMap` に反映。
完成物を `reports` ストアに保存。

### 6.8 プロンプト

本家のデフォルトプロンプトを**そのまま**移植する(勝手に書き換えない):

- 抽出: `../kouchou-ai/apps/admin/app/create/extractionPrompt.ts`
- 初期ラベリング: `../kouchou-ai/apps/admin/app/create/initialLabellingPrompt.ts`
- マージラベリング: `../kouchou-ai/apps/admin/app/create/mergeLabellingPrompt.ts`
- 概要: `../kouchou-ai/apps/admin/app/create/overviewPrompt.ts`

`src/prompts/` に置き、UI の「詳細設定」で編集可能にする(本家 admin と同じ体験)。

---

## 7. UI 画面構成

SPA 内ルーティング(react-router または手書きで十分):

1. **ホーム / レポート一覧**: IndexedDB 内のレポートをカード表示。新規作成・JSONインポート・
   JSONエクスポート・削除。
2. **設定**: §4 の2スロット設定。接続テスト。
3. **新規作成ウィザード**:
   - Step1: CSV ドロップ → プレビュー(件数、列)→ `comment-body` 列と属性列の指定
   - Step2: タイトル・調査概要(question / intro)
   - Step3: モデル・クラスタ数・プロンプト(既定値でそのまま進める)
   - Step4: **コスト見積り**(件数 × プロンプト長からトークン概算)→ 実行
4. **実行進捗**: ステップごとのプログレスバー、処理件数、累計トークン、経過時間。
   一時停止 / 再開 / 中止。エラー時は内容表示 + 続行可否。
   `beforeunload` で「処理中です」警告(ただし閉じても再開できる)。
5. **ビューア**: 本家 public-viewer 相当の表示。
   - 全体散布図(クラスタ色分け + ラベル表示)/ 濃度(密度)表示 / ツリーマップ
   - クラスタクリックで意見リスト、overview 表示
   - 参考実装: `../kouchou-ai/apps/public-viewer/components/charts/`(Plotly の trace 構成を流用)
   - `hierarchical_result.json`(本家産)を読み込んでも表示できること = 互換性の証明

### 7.1 レポートのエクスポート

「レポートがブラウザの中に閉じ込められる」状態を作らないための機能。形式は3つ:

1. **Result JSON**(本家互換)
   - エクスポート: `hierarchical_result.json` としてダウンロード。
   - インポート: 同スキーマの JSON(本家産含む)を読み込んでビューアで表示・一覧に登録。
2. **単一 HTML レポート**
   - ビューアのバンドル(JS/CSS)と Result JSON を 1 つの HTML に埋め込んだ自己完結ファイル。
   - ダブルクリックで開ける・メール添付やファイル共有でそのまま配れる・オフラインで動く。
   - 実装: ビルド時にビューア単体のテンプレート HTML を生成しておき、エクスポート時に
     `<script type="application/json" id="report-data">` へデータを差し込む。
3. **CSV**(表計算ソフトでの二次分析用)
   - 意見一覧: `arg-id, argument, comment-id, x, y, 各レベルのクラスタID/ラベル`
   - クラスタ一覧: `level, id, label, takeaway, value, parent`

保存先の扱い:

- 既定は通常のダウンロード(全ブラウザ)。
- Chromium 系では File System Access API(`showDirectoryPicker`)で「レポートフォルダ」を
  一度選んでもらい、以後の完成レポートを実ファイルとして自動保存するオプションを提供する
  (ディレクトリハンドルは IndexedDB に永続化して再利用)。非対応ブラウザでは
  このオプションを出さずダウンロードにフォールバック。

### 7.2 インタラクティブモード(フェーズ2・確定ロードマップ)

**決定(2026-07-17): 通常版(M0〜M8)完成後、これを拡張して次世代版
「インタラクティブ再クラスタリング分析」をフェーズ2として作る。**
詳細設計の一次資料とレビュー(採否判断・実装差分)は以下:

- [INTERACTIVE_DESIGN_MEMO.md](INTERACTIVE_DESIGN_MEMO.md) — 一次資料(逐語収蔵、改変禁止)
- [INTERACTIVE_DESIGN_REVIEW.md](INTERACTIVE_DESIGN_REVIEW.md) — レビューと実装方針。
  **通常版の実装中も「通常版との合流点」の節は読むこと**
  (extraction の出力スキーマ拡張性など、通常版側で先に仕込む項目がある)。

以下は初期の構想メモ(参考。フェーズ2の正式仕様は上記2文書が優先):

umap-js は `step()` で 1 反復ずつ進められるため、**UMAP の収束過程を散布図上で
リアルタイムに動かして見せる**ことが可能(Worker から数反復ごとに座標を postMessage して
Plotly/canvas を更新)。2次元座標上の KMeans + ward は数千点なら数十 ms で終わるので、
**再クラスタリングもリアルタイムに追従できる**(反復ごと、またはスライダーで
クラスタ数変更時に即時再計算)。一方 **LLM ラベリングだけは実時間にならない**
(API コストとレイテンシがあるため)。設計上は:

- ラベリングは「レイアウトが確定したら実行」のオンデマンド操作にする。
- クラスタ構成(所属 arg-id 集合のハッシュ)をキーにラベルをキャッシュし、
  同一構成の再ラベリングを無料にする。
- このモードを後付けできるよう、clustering worker のメッセージは
  「進捗%」ではなく**中間座標そのもの**を流せるプロトコルにしておく(§6.3)。

初期リリースには含めないが、デモ映えと「パラメータをいじって理解する」教育的価値が
大きいため、M8 以降の拡張候補として残す。

---

## 8. マイルストーンと受け入れ基準

各マイルストーンは独立に動作確認できる単位。**順番に実装する。**

| M | 内容 | 受け入れ基準 |
|---|---|---|
| M0 | scaffold: Vite+React+TS+Biome+Vitest、GitHub Actions で Pages デプロイ | CI green、Pages に Hello 表示 |
| M1 | 設定画面 + プロバイダ接続テスト | OpenAI と LM Studio でモデル一覧取得・埋め込み1件成功 |
| M2 | CSV 取込 + プロジェクト作成 + IndexedDB 基盤 | 1万行CSVを取り込みリロード後も残る |
| M3 | extraction(並列・リトライ・チェックポイント・再開) | 実行途中でリロード→未処理分だけ再開される |
| M4 | embedding | args 全件の埋め込みが保存される |
| M5 | clustering(Worker) | 5,000件で UI が固まらず進捗表示、x/y と全レベルIDが出る |
| M6 | labelling ×2 + overview | 全クラスタに label/takeaway、overview 文字列が出る |
| M7 | aggregation + ビューア + JSON入出力(§7.1-1) | **本家の example-hierarchical-polis の JSON を読み込んで表示できる**。自前生成 JSON も同一ビューアで表示できる |
| M8 | エクスポート仕上げ(§7.1): 単一HTMLレポート、CSV、File System Access API による自動保存。コスト見積り、エラーUX、README、(任意) transformers.js ローカル埋め込み | 初見ユーザがREADMEなしで1本レポートを作れる。単一HTMLをオフラインで開いて閲覧できる |

M7 の「本家JSONが読める」を先に作ると、ビューアの開発がパイプライン完成を待たずに進む。
**ビューア(M7の表示部)は M3〜M6 と並行して着手してよい。**

---

## 9. 検証計画

1. **互換性**: 本家サンプル(`example-hierarchical-polis/hierarchical_result.json`)を
   インポートして散布図・ツリーマップ・意見リストが本家 viewer と同等に見えること。
2. **パイプライン妥当性**: 同一CSV・同一モデルで本家 Python パイプラインと本実装を実行し、
   - 抽出件数がほぼ一致(LLM の揺らぎの範囲)
   - クラスタ構造の類似(最深レベルのラベル割当について Adjusted Rand Index を計算、
     UMAP実装差があるため厳密一致は求めない。目視でクラスタの意味的まとまりを確認)
3. **性能**: 10,000 args で UMAP+KMeans+ward が Worker 内で完走すること(数分は許容)。
   進捗が止まって見えないこと。
4. **再開**: extraction 途中でタブを閉じ、開き直して完走できること。
5. **エンジン単体テスト**: cube-root ルール、ward カットの継承ロジック、JSONパーサの
   フォールバック、`cluster_ids` 組み立てを Vitest で固定シードで検証。

---

## 10. リスクと対策

| リスク | 対策 |
|---|---|
| umap-js の品質・速度が Python 版に劣る | n_neighbors 等は本家準拠。1万件超は時間がかかる旨をUI表示。Worker化で体感を守る。将来 WASM 実装への差し替え余地をモジュール境界で確保 |
| プロバイダの Structured Outputs 非対応 | §4.3 の三段フォールバック + 寛容パーサ |
| レート制限(429) | 指数バックオフ + 並列数設定 + Retry-After 尊重 |
| APIキーの扱いへの不安 | 「キーはこのブラウザにのみ保存され、選択したAPI以外に送信されない」を設定画面に明記。削除ボタン |
| IndexedDB 容量(埋め込みが大きい) | Float32Array 格納。10,000件 × 1536次元 ≒ 61MB で許容範囲。レポート完成後に中間データ削除オプション |
| 本家スキーマの将来変更 | Result JSON に `schemaVersion` は足さない(互換維持が目的)。本家 type.ts への追従は都度対応 |
| 長時間タブのスリープ(モバイル/省電力) | チェックポイントがあるので再開可能。「PCをスリープさせないでください」の案内で十分 |

---

## 11. リポジトリ構成(目標)

```
kouchou-ai-serverless/
├─ CLAUDE.md                 # 実装セッション向けガイド
├─ README.md
├─ docs/DESIGN.md            # 本書
├─ index.html
├─ vite.config.ts            # base: プロジェクトPages なら "/kouchou-ai-serverless/"
├─ biome.json
├─ src/
│  ├─ main.tsx / App.tsx / routes/
│  ├─ components/            # 設定・ウィザード・進捗・ビューア
│  ├─ lib/
│  │  ├─ llm/                # client.ts(chat/embeddings), presets.ts, jsonParse.ts
│  │  ├─ pipeline/           # steps/*.ts, orchestrator.ts(逐次実行+チェックポイント)
│  │  ├─ storage/            # db.ts (Dexie), checkpoints.ts
│  │  └─ workers/            # clustering.worker.ts
│  ├─ prompts/               # 本家から移植した既定プロンプト
│  └─ types/                 # result.ts(本家 type.ts 由来), project.ts, settings.ts
├─ tests/                    # Vitest
└─ .github/workflows/deploy.yml
```

## 11.5 実装時の決定事項(2026-07-17、初期実装)

実装が本書と乖離した点・前倒しした点の記録:

1. **設定モデル(§4.1 の拡張)**: 「2スロットに直接 baseUrl/key を入力」ではなく、
   **プロバイダ単位で API キーを登録し、設定済みプロバイダのみをスロットで選択**する方式にした
   (ユーザ要望)。解決済みの `EndpointConfig` をプロジェクト作成時にスナップショットする。
2. **プロバイダ追加**: Azure OpenAI(`api-key` ヘッダ、`/openai/v1` 互換パス)、
   AWS Bedrock(OpenAI 互換エンドポイント、CORS 注意書き付き)、
   **Anthropic**(公式 OpenAI 互換レイヤ + `anthropic-dangerous-direct-browser-access` ヘッダ)、
   **Grok (xAI)**(OpenAI 互換)、
   **Chrome 内蔵 Gemini Nano**(Prompt API、チャット)、
   **transformers.js + WebGPU ローカル埋め込み**(M8 の任意項目を前倒し)。
   OpenRouter には無償モデル検索と応答テスト(タイムアウト検知)を追加。
   抽象化方針: プロバイダ専用クライアントは作らず、全プロバイダを OpenAI 互換として扱い、
   差分は `EndpointConfig` のメタデータ(`authHeader` / `extraHeaders` / 既知モデルリスト)で吸収する。
   **reasoning effort** はチャットスロットの設定で指定可能(OpenAI/xAI は `reasoning_effort`、
   OpenRouter は `reasoning: {effort}`、非対応プロバイダで 400 の場合は外して自動再試行)。
   設定画面には標準モデルリスト + `/models` 自動取得によるモデル候補選択(datalist)と、
   キー・チャット・埋め込みを一括確認する**ヘルスチェック**がある。
3. **リアルタイムモード(§7.2 の軽量版)を初期リリースに含めた**:
   UMAP 収束のライブ表示 + クラスタ数スライダーによる KMeans+ward の即時再計算 +
   オンデマンドラベリング。フェーズ2の完全版(stance 抽出・グラフクラスタリング)とは別物。
4. **前処理/後処理の分離**: 高コストな前処理(抽出+埋め込み)の結果を再利用して
   後処理のみ再実行できる。ラベルキャッシュのキーは**クラスタ構成(argId 集合)のハッシュ**
   (§7.2 のキャッシュ方針を前倒し)。UMAP 座標も独立チェックポイントし、
   クラスタ数変更時は UMAP を再計算しない。前処理データのファイルエクスポート形式
   (`.preprocessed.json`、embeddings は base64)を追加。
5. **未実装(M8 の一部)**: File System Access API による自動保存。
6. **ライセンス**: AGPL-3.0(本家準拠)。
7. **フェーズ2(次世代版)実装(2026-07-17)**: INTERACTIVE_DESIGN_REVIEW の実装順序に従い着手。
   - **Phase 0(stance 抽出品質検証)実施済み**: 代表9文+追加10文の評価セット
     (`scripts/phase0-stance-eval.ts`)で gpt-5-mini が 19/19 全問正解、
     gpt-5.4-nano 89% / gpt-5.4-mini 95%(隣接許容)。引用検出は全モデル 100%。
     合格ライン(85%/90%)クリアのため7分類のまま進行。**推奨モデル: gpt-5-mini**
     (nano は引用文の stance を筆者に帰属させる弱点)。
   - 実装: `src/stance-spectrum/`(types / enrich / codebook 2パス / similarity 累積L1 /
     graph ブロック別kNN和集合 + Louvain(graphology) / clusterTracker Jaccard ID追跡 /
     labelTemplate / workers: graph.worker + layout.worker)。
   - レビュー必須修正を反映: 候補kNN = semantic∪topic∪stance∪reason の和集合、
     stance/reason 重みは focus+context(選択クラスタ内)+トピック条件付きのみ。
   - **レイアウトは本物の UMAP のウォームスタート**: 結合特徴
     (√weight スケールのブロック結合 = 一次資料の combinedVector。
     d² = Σwᵦ·dᵦ² は加重平均類似度の単調変換)の距離を候補辺上で計算し、
     公開 API `setPrecomputedKNN` で UMAP に渡して正規の fuzzy simplicial set から実行。
     ウォームスタートは umap-js の内部構造(initializeOptimization が embedding を
     参照保持する)を利用し、initializeFit 後に embedding を現在座標へ書き換えて実現
     (Python 版の init=array 相当)。表示は重心+RMS 正規化で漂流を抑制、
     stance 軸は step 後のナッジ。当初の自作力学シミュレーションは
     反発力の近傍探索バグで格子状に結晶化したため廃止した。
   - UI はトップレベルナビ「次世代版」(`#/stance-spectrum`)から。通常版と結果は混ぜない。
   - **実データ検証(150コメント・543意見・実API)**: stance 混在クラスタ(純度27%)が
     focus+context の stance 重み付けで「中立・保留 / 条件付き反対 / 明確な反対」の
     3群に分裂し純度55%へ(`scripts/stance-spectrum-e2e.ts`)。重み付けの注意: クラスタを明示選択した
     場合はトピックゲートを外す(選択自体がトピック条件。ゲートを残すと分裂力が不足する)。
   - **事前分析済みサンプル**(`public/sample-stance-spectrum.json`, 1.1MB)を同梱し、
     API キーなしで次世代版を体験可能(`#/stance-spectrum/sample`)。
   - **属性軸**: 数値属性(年齢等)は範囲正規化距離の「分離強度」スライダー、
     カテゴリカル属性(職業等)は色分けを既定とし、上位8カテゴリ+δ一致の分離も選択可
     (0/1距離は断片化しやすいため色分け推奨の注記付き)。順序のある属性(学歴等)は
     数値化して扱うのが望ましい。
   - **トピック絞り込み(ドリルダウン)**: トピックが混在したままの全体 UMAP では
     軸分離の結果が読みにくい(ユーザ指摘)ため、コードブックのトピックまたは
     選択クラスタで表示範囲を絞り、部分集合だけを全キャンバスで再レイアウトできる。
     実装は候補辺の部分集合化(`subsetEdges`、インデックスをローカルへ再割当)+
     現在座標からの UMAP ウォームスタート。絞り込み中はスコープ自体がトピック条件を
     満たすため、クラスタ未選択でも stance/reason/属性スライダーが直接有効になる
     (`computeEdgeWeights` の `topicConditioned` でゲートを外す)。
     「全体に戻る」で絞り込み前の座標スナップショットへ復元する。
8. **UMAP 詳細パラメータの露出(2026-07-18)**: UMAP は seedrandom を注入した
   完全な決定論であり、パラメータを変えずに再実行しても同じ座標になる(ユーザ指摘)。
   これは意図した挙動だが、「再実行」ボタンだけがあって調整手段が見えないと
   壊れているように見えるため、3画面すべてに折り畳みの詳細パネル
   (`src/components/UmapParamsPanel.tsx`)を共有配置した:
   新規作成ウィザード Step3 / クラスタリング再実行 / 賛否スペクトラム分析。
   調整項目は nNeighbors・minDist・spread・nEpochs(0=自動)・シードで、
   「別のレイアウトを試す(シード変更)」「既定値に戻す」を併設する。
   - **既定値と同じキーは入力に含めない**という規約を全画面で守る
     (`toUmapInput`)。これによりチェックポイントキー(`umapCheckpointKey`、
     および今回追加した clustering ステップ側のキー)が既定実行時と一致し、
     パラメータを触らないユーザは既存キャッシュをそのまま再利用できる。
   - 通常パイプライン側は `Project.umap` / `Project.umapSeed`(いずれも省略可、
     既存データ互換)に保存し、`clustering()` の第5引数 `ClusteringOptions` で渡す。
     併せて clustering ステップのキャッシュキーがクラスタ数のみだった取りこぼしを
     修正した(パラメータを変えても古い結果が返る不具合)。
   - 賛否スペクトラム側は既定値が異なる(minDist 0.15 / spread 1.5 /
     seed "phase2-layout")ため、`src/stance-spectrum/layoutParams.ts` に既定値を置き、
     パネルの `defaults` プロパティで差し替える。Worker へは `umapParams` メッセージで
     反映し、`recold: true` で現在座標から強めに焼き直す(ウォームスタートのままだと
     minDist/spread の変更が見た目にほとんど出ないため)。nEpochs の明示指定は
     COLD のみ上書きし、WARM(スライダー操作時)は短いままにして連続性を保つ。
     既定値を Worker 本体ではなく別モジュールに置いたのは、Worker を
     メインスレッドから import すると `self.onmessage` が登録されてしまうため。
9. **クラスタリング再実行画面の階層表示(2026-07-18)**: 第1階層を凸包(なわばり)、
   第2階層を点の色で表し、1枚の散布図で両方の粒度を読めるようにした。
   描画方式は賛否スペクトラム側と同じ(SVG scatter + `fill: "toself"`。
   SVG は scattergl の前面に来るため塗りは薄くする)。クラスタ数スライダーは
   従来どおり UMAP を再実行せず KMeans+ward のみを即時再計算する。
10. **コスト見積りを選択中モデルの単価で計算する(2026-07-18)**: Step4 の費用表示に
    2つの誤りがあった。(a) ローカル実行の判定が chat/embedding の OR だったため、
    チャットだけ Gemini Nano で埋め込みは API という構成で「全額 0 円」と表示していた。
    (b) 単価が `gpt-5.4-nano + text-embedding-3-small` 固定で、どのモデルを選んでも
    同じ金額が出ていた。`estimateSlotCosts`(`src/lib/estimate.ts`)でスロットごとに
    `lookupModelPrice` を引き、local(0 円) / usd(実単価・Flex は 50%) /
    unknown(単価不明) の3状態を返すようにした。unknown で既定価格を当てると
    別モデルの値段を表示することになるため、金額を出さず合計からも除外し注記する。
11. **レポートからのクラスタリング再実行(2026-07-19)**: 「クラスタリングを再実行」は
    生成元プロジェクトが IndexedDB に残っているレポートでしか押せず、同梱サンプルや
    インポートした Result JSON では導線が出なかった。Result には意見・元コメント・
    散布図座標・階層割当がすべて入っているため、`src/lib/reportProject.ts` で
    Result からプロジェクト(+ extraction / clustering ステップ結果)を復元し、
    どのレポートからでも対話画面に入れるようにした。
    復元したプロジェクトには**埋め込みベクトルが無い**(サンプルは 7,491 意見 ×
    1,536 次元 ≈ 46MB で同梱できない)ため、対話画面は保存済み座標を初期レイアウトに
    使い、クラスタ数の切り直しと再ラベリングだけを許す。UMAP のやり直しには
    ベクトルが要るので UMAP ボタンとパラメータパネルは隠し、「ベクトル化を実行」
    (意見抽出はスキップし埋め込みのみ)を導線として出す。
    ベクトル化の実行先は対話画面で選べる。**既定はブラウザ内(transformers.js)**で、
    API キーが無くても無料・データ送信なしでベクトルを作れるため、同梱サンプルから
    UMAP のやり直しまで到達できる(埋め込み API が設定済みならそちらを既定にする)。
    埋め込みチェックポイントのキーはモデル名と local フラグを含むので、実行先を
    切り替えても古いベクトルは再利用されない。
12. **ローカル埋め込みの WebGPU 判定を実アダプタで行う(2026-07-19)**: バックエンド選択が
    `"gpu" in navigator` だけだったため、API はあるがアダプタを取れない環境
    (ヘッドレス Chrome、GPU がブロックリスト等)で `device: "webgpu"` を選び、
    「no available backend found」で埋め込みが失敗していた。`navigator.gpu.requestAdapter()`
    まで確認し、取得できない場合と初期化に失敗した場合の両方で WASM にフォールバックする。
    ベンチマークのバックエンド判定も、WASM のメッセージ(「WASM: WebGPU 非対応環境」)が
    両方の語を含むため WASM を先に判定するよう直した。

## 12. 実装上の注意

- パイプラインの各ステップは `(input, config, ctx) => output` の純関数に近い形にし、
  `ctx` に { llmClient, progress通知, abortSignal, checkpoint読み書き } を渡す。
- 中止は `AbortController` を全 fetch に配線する。
- 文言はまず日本語のみでよい(本家の主対象が日本語)。i18n 基盤は入れない。
- 本家リポジトリ(`../kouchou-ai`)は**読み取り専用の参照**。変更しない。
- コミットは Conventional Commits(feat/fix/docs...)。
