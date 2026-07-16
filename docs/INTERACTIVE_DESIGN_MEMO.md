# 意見クラスタリング可視化システム 実装メモ(次世代版・一次資料)

> **出自**: 2026-07-17、プロジェクトオーナーが OpenAI(ChatGPT)と次世代版について
> 議論した際の設計資料。原文をそのまま収蔵している(改変しない)。
> 本リポジトリでの採否・修正方針は [INTERACTIVE_DESIGN_REVIEW.md](INTERACTIVE_DESIGN_REVIEW.md) を参照。
> **位置づけ**: MVP(DESIGN.md の M0〜M8)完了後のフェーズ2(第2分析モード)の構想。

---

## 目的

複数の意見文を、トピック・スタンス・理由などの観点からインタラクティブに再クラスタリングし、ブラウザ上で点群が連続的に変形する可視化を作る。

想定する代表的な操作は以下。

* 最初は「原発」「再生可能エネルギー」「電気料金」などのトピック別に表示する
* ユーザーが「原発」クラスタを選択する
* 「スタンスを重視」のスライダーを動かす
* 原発クラスタが、賛成・条件付き賛成・非反対・保留・反対などに分裂する
* 「理由を重視」にすると、安全性・安定供給・廃棄物・コストなどの論点別に再編される
* クラスタの境界、名称、点の所属が連続的に変化して見える

LLMは前処理と必要時のクラスタ解説に使い、スライダー操作のたびには呼ばない。

---

## 基本思想

意見に唯一の固定クラスタを付与するのではなく、各意見に再利用可能な意味属性を付ける。

クラスタは、意味属性の重み付けからその都度生成される「ビュー」とする。

各意見には以下を持たせる。

* 元の意見文
* 意見・主張単位のテキスト
* semantic embedding
* 複数のtopicタグと関連度
* stanceの確率分布
* reasonタグと関連度
* 条件
* 否定表現
* コミットメントの強さ
* 意見主体
* LLM解析のconfidence

---

## 特に重要な言語処理

### センチメントではなくstanceを扱う

「ポジティブ・ネガティブ」ではなく、対象に対する立場を扱う。

最低限、以下を区別する。

* 明示的賛成
* 条件付き賛成
* 非反対
* 中立・態度保留
* 非賛成
* 条件付き反対
* 明示的反対
* 判定不能
* 他者意見の引用

### 二重否定

以下を同一視しない。

* 「原発に賛成だ」
* 「原発に反対ではない」
* 「原発反対とは言えない」

「反対ではない」は、通常は明示的賛成ではない。

例:

```json
{
  "target": "原発再稼働",
  "stance": {
    "explicit_support": 0.05,
    "conditional_support": 0.18,
    "non_opposition": 0.56,
    "neutral_or_defer": 0.18,
    "conditional_opposition": 0.02,
    "explicit_opposition": 0.01
  },
  "negated_position": "反対",
  "explicit_support": false,
  "commitment": 0.35,
  "confidence": 0.79
}
```

単純な否定反転はしない。

### 文脈と意見主体

次の文は筆者の賛成意見ではない。

> 「原発反対とは言えない」と政府は説明した。

以下を抽出する。

* holder: 意見主体
* quoted_speech: 引用か
* target: 何に対する立場か
* condition: 条件
* reason: 理由
* commitment: 断定の強さ

---

## データ構造案

```ts
type StanceDistribution = {
  explicitSupport: number;
  conditionalSupport: number;
  nonOpposition: number;
  neutralOrDefer: number;
  nonSupport: number;
  conditionalOpposition: number;
  explicitOpposition: number;
  unknown: number;
};

type WeightedTag = {
  label: string;
  weight: number;
};

type OpinionRecord = {
  id: string;
  sourceDocumentId?: string;
  originalText: string;
  claimText: string;

  holder: string | null;
  target: string | null;

  topics: WeightedTag[];
  reasons: WeightedTag[];
  conditions: string[];

  stance: StanceDistribution;

  negatedPosition?: string | null;
  quotedSpeech: boolean;
  commitment: number;
  confidence: number;

  semanticEmbedding: number[];

  // 任意。必要なら別embeddingを持つ
  topicEmbedding?: number[];
  reasonEmbedding?: number[];

  initialClusterId?: string | null;
};
```

---

## バックエンド処理

### 1. 文書を主張単位に分割

長文を文書単位で1ベクトルにしない。

1文書に複数論点・複数立場が含まれる可能性があるため、意見・主張単位に分割する。

例:

```text
原発には事故リスクがある。
しかし再エネだけでは安定供給が難しい。
安全性が確認された原発の再稼働には反対とは言えない。
```

主張レコードとしては、少なくとも以下を抽出する。

```json
{
  "target": "原発再稼働",
  "stance": "非反対",
  "condition": "安全性が確認されること",
  "reason": "電力の安定供給"
}
```

### 2. LLMで構造化

LLMには、意見群を直接最終クラスタリングさせるだけでなく、各意見を構造化させる。

LLMが抽出する項目:

* claim
* target
* topics
* stance distribution
* reasons
* conditions
* holder
* negation
* commitment
* quoted speech
* confidence

出力はJSON Schemaで固定する。

### 3. Embedding生成

`claimText`を中心にsemantic embeddingを生成する。

必要に応じて、以下も別に生成する。

* topic用の正規化テキスト
* reason用の正規化テキスト
* 構造化された意見表現

例:

```text
対象: 原発再稼働
立場: 非反対
条件: 安全性確認
理由: 電力安定供給
```

ただし、semantic embeddingとstanceは別特徴として保持する。

### 4. 初期トピック生成

初期トピック生成には、BERTopic型の構成を使える。

```text
semantic embedding
→ UMAP 10〜30次元
→ HDBSCAN
→ c-TF-IDF
→ 初期topic名・代表文書
```

BERTopicは最終的な固定分類器ではなく、初期トピック構造を作る部品として扱う。

重要:

* クラスタリング用UMAPと表示用2次元UMAPは分ける
* c-TF-IDFはクラスタ説明用
* c-TF-IDFはスタンスを理解しない
* 原発賛成と原発反対は同じトピックに入る可能性がある
* スタンス分離は別処理で行う

---

## フロントエンドの基本モデル

フロントではLLMを呼ばず、保存済み特徴から近傍グラフと2次元配置を再構成する。

### 特徴ブロック

各意見には以下の特徴がある。

```text
semantic vector
topic vector / topic tag vector
stance probability vector
reason vector / reason tag vector
```

各ブロックは個別に正規化する。

単純に768次元embeddingと7次元stanceを連結すると、次元数の差でsemantic側が支配しやすい。

ブロック単位で重みを適用する。

概念的には以下。

```text
combinedVector =
[
  sqrt(wSemantic) × normalize(semanticVector),
  sqrt(wTopic) × normalize(topicVector),
  sqrt(wStance) × normalize(stanceVector),
  sqrt(wReason) × normalize(reasonVector)
]
```

ただし、リアルタイム用途では毎回ベクトルを作り直して完全kNN検索するより、候補近傍グラフを事前に持つ。

---

## 類似度と距離

候補辺ごとに複合類似度を計算する。

```text
similarity(i, j)
=
wSemantic × semanticSimilarity(i, j)
+ wTopic × topicSimilarity(i, j)
+ wStance × stanceSimilarity(i, j)
+ wReason × reasonSimilarity(i, j)
```

必要に応じて以下も加える。

```text
+ wCommitment × commitmentSimilarity(i, j)
+ wCondition × conditionSimilarity(i, j)
```

### stance similarity

stanceは単一の賛否スカラーだけでなく、確率分布全体を使う。

候補:

* cosine similarity
* Jensen–Shannon similarity
* Wasserstein distance
* 順序付きラベル向け独自距離

UI補助用にはstance scoreを別に計算してよい。

例:

```text
explicitOpposition   = -1.0
conditionalOpposition = -0.6
nonSupport           = -0.2
neutralOrDefer       = 0.0
nonOpposition        = +0.2
conditionalSupport   = +0.6
explicitSupport      = +1.0
```

ただしクラスタリングには確率分布全体を使う。

---

## 候補kNNグラフ

初期計算時に、各点について複数の観点を含めた広めの候補近傍を保存する。

候補数の初期値:

```text
50〜100近傍
```

候補辺には以下を保存する。

```ts
type CandidateEdge = {
  source: string;
  target: string;

  semanticSimilarity: number;
  topicSimilarity: number;
  stanceSimilarity: number;
  reasonSimilarity: number;
  commitmentSimilarity?: number;
};
```

スライダー操作時には、候補辺の最終重みだけを再計算する。

全点間距離の再計算は避ける。

---

## UMAPと表示

### 重要

クラスタ判定は、表示後の2次元座標だけで行わない。

2次元UMAPは情報を失っており、近く描画されたから意味的に近いとは限らない。

役割を分ける。

```text
クラスタ判定:
高次元特徴または再重み付け済みkNNグラフ

表示:
2次元UMAPまたはUMAP風の力学レイアウト
```

### 初期処理

```text
embedding / candidate graph
→ 初期UMAP座標
→ 初期クラスタ
```

### インタラクション時

```text
1. ユーザーが重みを変更
2. 候補辺の重みを再計算
3. kNNグラフを更新
4. 現在の2D座標を初期値として再最適化
5. 数stepずつ座標更新
6. requestAnimationFrameで描画
```

毎回UMAPをランダム初期化しない。

### 実装候補

小規模:

```text
umap-js
Web Worker
Canvas / WebGL
```

中規模以上:

```text
候補kNNはバックエンドで生成
フロントはWebGPUまたはWASM
描画はWebGL / WebGPU instancing
```

初期目標は数千〜1万点程度でよい。

---

## スタンスでクラスタを割る操作

代表的な操作フロー:

```text
1. 全体はトピック重視で表示
2. ユーザーが「原発」クラスタを選択
3. 「スタンスで見る」を有効化
4. 選択クラスタ内だけstance weightを上げる
5. 原発以外の点は弱く固定
6. 原発内の賛成・反対を結ぶ辺が弱くなる
7. 同じstance同士の辺が強くなる
8. 点群に隙間ができる
9. 賛成・保留・反対の集団に分裂する
```

全体空間を一斉にスタンス中心へ変えるより、選択クラスタだけを局所再配置する「フォーカス＋コンテキスト」方式を優先する。

---

## UMAPに弱い方向制約を加える案

純粋なUMAPでは、賛成と反対が左右ではなく上下に分かれたり、毎回反転する可能性がある。

UI上は、スタンス方向をある程度固定したほうが読みやすい。

例:

```text
x方向: stance score
y方向: UMAPによる理由・論点構造
```

損失の概念:

```text
layoutLoss
=
umapLoss
+ lambda × (x_i - stanceScore_i)^2
```

完全なUMAPではなく、UMAPの近傍保持にスタンス軸の弱いアンカーを加えた表示用レイアウトとして実装してよい。

---

## クラスタリング

クラスタは2次元座標ではなく、更新済みkNNグラフから決める。

候補:

* Leiden
* connected components with threshold
* label propagation
* HDBSCAN相当
* soft community detection

初期プロトタイプでは、以下のどちらかでよい。

### 案A: Leiden

更新済みグラフに対してコミュニティ検出。

利点:

* 非球形クラスタに強い
* kNNグラフと相性がよい
* 局所再構成しやすい

### 案B: ラベル伝播

各点の所属スコア:

```text
score(i, cluster)
=
sum over neighbors(
  edgeWeight(i, j) × membership(j, cluster)
)
+ selfAttributeScore(i, cluster)
```

soft membershipを保持する。

```ts
type ClusterMembership = Record<string, number>;
```

表示上は最大値のクラスタを使うが、境界点は複数クラスタへの所属確率を保持する。

---

## クラスタの安定化

スライダー操作中にクラスタIDやラベルが高速に変化しないようにする。

必須項目:

### ヒステリシス

```text
newScore > currentScore + threshold
```

の場合のみ所属変更。

### 時間的平滑化

```text
smoothedScore
=
0.8 × previousScore
+ 0.2 × currentScore
```

### 最小保持時間

クラスタ変更後、一定時間は所属を維持する。

目安:

```text
300〜1000ms
```

### クラスタID追跡

フレームごとに新しいクラスタ番号を振らない。

前回クラスタとのJaccard overlapや重心近傍から、クラスタIDを引き継ぐ。

---

## クラスタラベル

LLMなしでも、構造化属性から簡易ラベルを生成する。

クラスタ内で集計する。

* 上位topic
* 主なstance
* 上位reason
* 条件
* 代表文書

例:

```text
topic: 原発再稼働
stance: 非反対
reason: 安全性
```

テンプレート:

```text
安全性を条件とする原発再稼働の非反対意見
```

別例:

```text
電力安定供給を理由とする原発再稼働賛成意見
```

### ラベル変更の安定化

* 少しの変化では変更しない
* confidence thresholdを持つ
* 文字列をクロスフェードする
* 可能なら上位ラベルを維持し、下位説明だけ変更する

例:

```text
原発
→ 原発再稼働
→ 原発再稼働・賛成
```

---

## クラスタ境界の表示

点を囲む単純な凸包ではなく、密度ベースの境界を推奨。

候補:

* kernel density contour
* metaball
* alpha shape
* Gaussian density field

「ぐにゃぐにゃ分裂・結合する」表現にはmetaballまたは密度等高線が向いている。

点群が近づくと領域が接続し、離れると自然に分裂するようにする。

---

## LLMの利用箇所

### 初期処理

LLMを使う。

* 主張抽出
* topicタグ生成
* stance解析
* 二重否定解析
* condition抽出
* reason抽出
* holder検出
* confidence生成
* 初期コードブック生成

### フロント操作中

LLMを使わない。

* 重み変更
* グラフ再計算
* クラスタ再構成
* UMAP再配置
* ラベルの簡易生成
* 代表文書抽出

### ユーザー要求時のみ

ユーザーがクラスタをクリックして「解説」を要求した場合だけLLMを呼ぶ。

LLMに渡すもの:

* クラスタの代表文書
* 上位topicタグ
* stance分布
* reason分布
* 条件
* 反例または境界的意見
* クラスタ件数

全意見を毎回渡さない。

---

## MVP

まずは以下に限定する。

### データ件数

```text
500〜5000意見
```

### 特徴

* semantic embedding
* topicタグ
* stance distribution
* reasonタグ

### UI

* 2D散布図
* topic / stance / reason重みスライダー
* クラスタ選択
* 選択クラスタの局所再配置
* 点のホバー表示
* クラスタラベル表示
* 密度境界表示

### クラスタリング

* 候補kNNグラフ
* 重み再計算
* Leidenまたは簡易label propagation

### レイアウト

* 初期UMAP
* 現在座標から数stepずつ再最適化
* Web Workerで計算
* CanvasまたはWebGLで描画

---

## 推奨ファイル構成

```text
src/
  domain/
    opinion.ts
    stance.ts
    cluster.ts

  analysis/
    similarity.ts
    stance-distance.ts
    graph-builder.ts
    cluster-tracker.ts
    label-generator.ts

  layout/
    umap-worker.ts
    layout-controller.ts
    interpolation.ts
    anchors.ts

  visualization/
    ScatterPlot.tsx
    ClusterContours.tsx
    ClusterLabels.tsx
    Controls.tsx
    OpinionTooltip.tsx

  workers/
    graph.worker.ts
    layout.worker.ts

  fixtures/
    opinions.sample.json

  tests/
    stance-distance.test.ts
    similarity.test.ts
    cluster-tracker.test.ts
    label-generator.test.ts
```

---

## 最初に実装してほしい順序

1. `OpinionRecord`型を定義する
2. サンプル意見データを30〜100件作る
3. stance distanceと複合similarityを実装する
4. 候補kNNグラフを作る
5. topic / stance / reasonの重みを変更できるようにする
6. グラフから簡易クラスタを作る
7. 初期2D座標を表示する
8. 重み変更時に座標を補間して動かす
9. クラスタIDを安定追跡する
10. クラスタラベルをテンプレート生成する
11. 密度境界を表示する
12. UMAPの反復更新をWeb Workerへ移す

---

## テストしたい代表文

以下が意図通り別のstanceとして扱われること。

```text
原発再稼働に賛成だ。
原発再稼働には条件付きで賛成だ。
原発再稼働に反対ではない。
原発反対とは言えない。
原発再稼働には賛成できない。
安全性が確認できない限り原発再稼働には反対だ。
原発再稼働には断固反対だ。
専門家の判断を待ちたい。
「原発反対とは言えない」と政府は説明した。
```

期待する大まかな分類:

```text
明示的賛成
条件付き賛成
非反対
非反対または態度保留
非賛成
条件付き反対
明示的反対
態度保留
他者意見・筆者stance不明
```

---

## 注意事項

* 2次元UMAP上の距離だけでクラスタを決めない
* 「非反対」を「賛成」に正規化しない
* 「非賛成」を「反対」に正規化しない
* 長文は主張単位に分割する
* クラスタIDはビュー変更ごとに変動し得る
* 永続化するのは固定クラスタではなく、意見属性とビュー定義
* クラスタ名とクラスタ品質を混同しない
* LLMが良い名称を付けても、クラスタ自体が妥当とは限らない
* LLM出力はconfidence付きで保持する
* 低confidence意見を無理に賛否クラスタへ押し込まない

---

## ビュー定義の保存

ユーザーが作った見方を再現できるよう、クラスタIDではなく重みと条件を保存する。

```ts
type ClusterView = {
  selectedClusterId?: string;
  selectedTopics?: string[];

  semanticWeight: number;
  topicWeight: number;
  stanceWeight: number;
  reasonWeight: number;

  minimumTopicWeight: number;
  edgeThreshold: number;
  resolution: number;

  stanceAxisEnabled: boolean;
  localReclusterOnly: boolean;
};
```

このビュー定義を保存すれば、同じ意見データから別の分析画面を何度でも再現できる。

---

## 最終的なユーザー体験

ユーザーには、次のように見えることを目指す。

1. 最初は意見が話題ごとの島として見える
2. 原発の島をクリックする
3. スタンススライダーを上げる
4. 原発の島が賛成・反対・保留へゆっくり分裂する
5. 中間には条件付き賛成や非反対が残る
6. クラスタ境界が分裂する
7. ラベルが「原発」から「原発・賛成」「原発・反対」へ変わる
8. 理由スライダーを上げると、安全性・安定供給・廃棄物などへさらに分かれる
9. 個別点をクリックすると、元意見と構造化属性が確認できる
10. 必要なときだけ「このクラスタを解説」でLLM要約を生成する
