/**
 * Phase 0: stance 構造化抽出の品質検証(INTERACTIVE_DESIGN_REVIEW §1)。
 *   npx vite-node scripts/phase0-stance-eval.ts
 * 一次資料の代表9文 + 追加ケースに正解ラベルを付け、モデル×プロンプトの一致率を測る。
 * 合格ライン: 隣接誤り込み一致 85% / 引用検出の再現率 90%。
 * PHASE0_MODELS=gpt-5.4-nano,gpt-5-mini のように環境変数でモデルを指定できる。
 */
import { readFileSync } from "node:fs";
import { requestChat } from "../src/lib/llm/client";
import { parseEnrichment } from "../src/phase2/enrich";
import { ENRICHMENT_SCHEMA, enrichmentPrompt } from "../src/phase2/prompts";
import { STANCE_KEYS, type StanceKey, dominantStance } from "../src/phase2/types";

type Expected = {
  text: string;
  /** 許容する主分類(いずれかに argmax が入れば正解)。隣接クラスは自動で許容 */
  accept: (StanceKey | "unknown")[];
  quoted?: boolean;
};

// 一次資料「テストしたい代表文」の9文(期待分類はメモの記載どおり)
const CANONICAL: Expected[] = [
  { text: "原発再稼働に賛成だ。", accept: ["explicitSupport"] },
  { text: "原発再稼働には条件付きで賛成だ。", accept: ["conditionalSupport"] },
  { text: "原発再稼働に反対ではない。", accept: ["nonOpposition"] },
  { text: "原発反対とは言えない。", accept: ["nonOpposition", "neutralOrDefer"] },
  { text: "原発再稼働には賛成できない。", accept: ["nonSupport"] },
  { text: "安全性が確認できない限り原発再稼働には反対だ。", accept: ["conditionalOpposition"] },
  { text: "原発再稼働には断固反対だ。", accept: ["explicitOpposition"] },
  { text: "専門家の判断を待ちたい。", accept: ["neutralOrDefer"] },
  { text: "「原発反対とは言えない」と政府は説明した。", accept: ["unknown", "neutralOrDefer"], quoted: true },
];

// 追加ケース(実データに近い文体・別ドメイン・引用の再現率測定用)
const EXTRA: Expected[] = [
  { text: "AIに人権を認める法案には全面的に賛成します。", accept: ["explicitSupport"] },
  { text: "悪用対策がしっかりするなら、AI人権法案に賛成してもいい。", accept: ["conditionalSupport"] },
  { text: "AIに権利を与えることに、必ずしも反対というわけではありません。", accept: ["nonOpposition"] },
  { text: "この法案に賛成する気にはなれない。", accept: ["nonSupport"] },
  { text: "雇用への影響が解決されない限り、この法案には反対です。", accept: ["conditionalOpposition"] },
  { text: "AI人権法案など言語道断、絶対に廃案にすべきだ。", accept: ["explicitOpposition"] },
  { text: "正直よく分からないので、どちらとも言えません。", accept: ["neutralOrDefer"] },
  { text: "推進派は「反対する理由がない」と主張している。", accept: ["unknown", "neutralOrDefer"], quoted: true },
  {
    text: "母は「AIに人権なんてとんでもない」とよく言っています。",
    accept: ["unknown", "neutralOrDefer"],
    quoted: true,
  },
  { text: "増税には反対しないが、使い道の透明化が先だと思う。", accept: ["nonOpposition", "conditionalSupport"] },
];

const ORDER: (StanceKey | "unknown")[] = [...STANCE_KEYS];

function isAdjacent(a: StanceKey | "unknown", b: StanceKey | "unknown"): boolean {
  if (a === "unknown" || b === "unknown") return a === b;
  return Math.abs(ORDER.indexOf(a) - ORDER.indexOf(b)) <= 1;
}

function env(name: string): string {
  return (
    readFileSync(".env", "utf-8")
      .match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]
      ?.trim() ?? ""
  );
}

async function evalModel(model: string): Promise<void> {
  const endpoint = { baseUrl: "https://api.openai.com/v1", apiKey: env("OPENAI_API_KEY"), model };
  const cases = [...CANONICAL, ...EXTRA];
  let exact = 0;
  let adjacent = 0;
  let quoteHit = 0;
  let quoteTotal = 0;
  const failures: string[] = [];

  await Promise.all(
    cases.map(async (c) => {
      const response = await requestChat(endpoint, {
        messages: [
          { role: "system", content: enrichmentPrompt },
          { role: "user", content: c.text },
        ],
        jsonSchema: ENRICHMENT_SCHEMA,
      });
      const enrichment = parseEnrichment(response);
      const got = dominantStance(enrichment.stance);
      const okExact = c.accept.includes(got);
      const okAdjacent = okExact || c.accept.some((a) => isAdjacent(a, got));
      if (okExact) exact++;
      if (okAdjacent) adjacent++;
      else failures.push(`  ✗ "${c.text}" → ${got} (期待: ${c.accept.join("/")})`);
      if (c.quoted) {
        quoteTotal++;
        if (enrichment.quotedSpeech) quoteHit++;
      }
    }),
  );

  const n = cases.length;
  console.log(`\n=== ${model} ===`);
  console.log(`厳密一致:       ${exact}/${n} (${((exact / n) * 100).toFixed(0)}%)`);
  console.log(`隣接許容一致:   ${adjacent}/${n} (${((adjacent / n) * 100).toFixed(0)}%)  [合格ライン 85%]`);
  console.log(
    `引用検出再現率: ${quoteHit}/${quoteTotal} (${((quoteHit / quoteTotal) * 100).toFixed(0)}%)  [合格ライン 90%]`,
  );
  if (failures.length > 0) console.log(failures.join("\n"));
  const pass = adjacent / n >= 0.85 && quoteHit / quoteTotal >= 0.9;
  console.log(pass ? "→ 合格 ✅" : "→ 不合格 ❌(5分類への縮退 or 上位モデルを検討)");
}

const models = (process.env.PHASE0_MODELS ?? "gpt-5.4-nano,gpt-5-mini,gpt-5.4-mini").split(",");
for (const model of models) {
  await evalModel(model.trim());
}
