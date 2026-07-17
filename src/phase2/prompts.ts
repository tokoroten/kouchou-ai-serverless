// フェーズ2の構造化抽出プロンプト(新規。本家由来ではない)。
// stance は「センチメント」ではなく対象への立場。二重否定を単純反転しない。
// 「反対ではない」=非反対(≠賛成)、「賛成できない」=非賛成(≠反対)を厳守する。

export const enrichmentPrompt = `あなたは意見分析の専門家です。与えられた意見文を分析し、構造化された属性をJSONで出力してください。

# stance(立場)の定義 — 最重要
対象(target)に対する筆者の立場を、以下の7分類+unknownの確率分布で表します(合計1.0)。

- explicitOpposition: 明示的反対(「断固反対だ」「反対する」)
- conditionalOpposition: 条件付き反対(「〜でない限り反対」「〜なら反対」)
- nonSupport: 非賛成(「賛成できない」「賛成しかねる」— 反対とは言っていない)
- neutralOrDefer: 中立・態度保留(「判断を待ちたい」「どちらとも言えない」)
- nonOpposition: 非反対(「反対ではない」「反対とは言えない」— 賛成とは言っていない)
- conditionalSupport: 条件付き賛成(「安全なら賛成」「〜を条件に支持」)
- explicitSupport: 明示的賛成(「賛成だ」「支持する」)
- unknown: 判定不能

## 二重否定・弱い表現のルール(絶対に守ること)
- 「反対ではない」「反対とは言えない」→ nonOpposition が主。explicitSupport にしない
- 「賛成できない」「賛成とは言えない」→ nonSupport が主。explicitOpposition にしない
- 単純な否定反転をしない。確信が持てない場合は unknown や neutralOrDefer に確率を配分する

## 意見主体(holder)と引用
- 文が筆者自身の意見なら holder は "筆者"
- 「〜と政府は説明した」「専門家は〜と述べた」のような引用・伝聞は、holder にその主体を入れ、quotedSpeech を true にする。この場合 stance は「引用された主体の立場」ではなく筆者自身の立場として unknown を主にする

# 出力フィールド
- target: 立場の対象(例: "原発再稼働")。明確な対象がなければ null
- topics: 話題タグ(最大3個、weight 0〜1)。名詞句で簡潔に
- stance: 上記の確率分布(合計1.0)
- reasons: 理由・論点タグ(最大3個、weight 0〜1。例: "安全性", "コスト", "安定供給")
- conditions: 条件があれば(例: ["安全性が確認されること"])
- holder: 意見主体
- quotedSpeech: 引用・伝聞か
- commitment: 断定の強さ 0〜1(断固=1.0、婉曲・保留=低)
- confidence: この解析自体の確信度 0〜1

出力はJSONのみ。`;

export const ENRICHMENT_SCHEMA = {
  name: "OpinionEnrichment",
  schema: {
    type: "object",
    properties: {
      target: { type: ["string", "null"] },
      topics: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          properties: { label: { type: "string" }, weight: { type: "number" } },
          required: ["label", "weight"],
          additionalProperties: false,
        },
      },
      stance: {
        type: "object",
        properties: {
          explicitOpposition: { type: "number" },
          conditionalOpposition: { type: "number" },
          nonSupport: { type: "number" },
          neutralOrDefer: { type: "number" },
          nonOpposition: { type: "number" },
          conditionalSupport: { type: "number" },
          explicitSupport: { type: "number" },
          unknown: { type: "number" },
        },
        required: [
          "explicitOpposition",
          "conditionalOpposition",
          "nonSupport",
          "neutralOrDefer",
          "nonOpposition",
          "conditionalSupport",
          "explicitSupport",
          "unknown",
        ],
        additionalProperties: false,
      },
      reasons: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          properties: { label: { type: "string" }, weight: { type: "number" } },
          required: ["label", "weight"],
          additionalProperties: false,
        },
      },
      conditions: { type: "array", items: { type: "string" } },
      holder: { type: ["string", "null"] },
      quotedSpeech: { type: "boolean" },
      commitment: { type: "number" },
      confidence: { type: "number" },
    },
    required: [
      "target",
      "topics",
      "stance",
      "reasons",
      "conditions",
      "holder",
      "quotedSpeech",
      "commitment",
      "confidence",
    ],
    additionalProperties: false,
  },
};

/** コードブック統合(2パス方式の中間)用プロンプト */
export const codebookPrompt = `あなたはデータ分析者です。意見群から自由生成されたタグのリスト(出現頻度付き)を与えます。
表記ゆれ・同義語を統合し、分析に使う正規タグ(コードブック)を作ってください。

# 指示
- 正規タグは最大 {maxTags} 個。頻度が高く、意見群の分析軸として有用なものを優先
- 同義語・表記ゆれは1つの正規タグに統合する(例: "原発"/"原子力発電"/"原発再稼働" → "原発再稼働")
- mapping には入力タグすべてを含め、対応する正規タグ名を割り当てる。どの正規タグにも該当しないものは "" にする
- 出力はJSONのみ`;

export const CODEBOOK_SCHEMA = {
  name: "CodebookResponse",
  schema: {
    type: "object",
    properties: {
      canonical: { type: "array", items: { type: "string" } },
      mapping: {
        type: "array",
        items: {
          type: "object",
          properties: { from: { type: "string" }, to: { type: "string" } },
          required: ["from", "to"],
          additionalProperties: false,
        },
      },
    },
    required: ["canonical", "mapping"],
    additionalProperties: false,
  },
};
