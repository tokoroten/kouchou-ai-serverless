import { requestChat } from "../lib/llm/client";
import { parseJsonObjectLoose } from "../lib/llm/jsonParse";
import type { PipelineContext } from "../lib/pipeline/context";
import { CODEBOOK_SCHEMA, codebookPrompt } from "./prompts";
import type { Codebook, OpinionEnrichment, WeightedTag } from "./types";

// topic/reason タグの2パス方式(レビュー「topic/reason タグは2パス方式を仕様とする」)。
// 1パス目: enrich で自由生成 → ここで統合してコードブック確定 → 2パス目: コードブックに対して割当。
// 野放しだと語彙が発散しタグベクトルが比較不能になるため。

const MAX_TOPICS = 40;
const MAX_REASONS = 30;
const MAX_INPUT_TAGS = 150;

export function normalizeTag(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[。、.,]/g, "");
}

/** 出現頻度付きの自由生成タグ一覧を作る */
function collectTags(
  enrichments: OpinionEnrichment[],
  kind: "topics" | "reasons",
): Map<string, { display: string; count: number }> {
  const counts = new Map<string, { display: string; count: number }>();
  for (const enrichment of enrichments) {
    for (const tag of enrichment[kind]) {
      const key = normalizeTag(tag.label);
      if (!key) continue;
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { display: tag.label.trim(), count: 1 });
    }
  }
  return counts;
}

async function consolidate(
  tags: Map<string, { display: string; count: number }>,
  maxTags: number,
  ctx: PipelineContext,
): Promise<{ canonical: string[]; mapping: Record<string, string> }> {
  const sorted = [...tags.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, MAX_INPUT_TAGS);
  if (sorted.length === 0) return { canonical: [], mapping: {} };
  const input = sorted.map(([, v]) => `${v.display} (${v.count})`).join("\n");
  try {
    const response = await requestChat(ctx.chat, {
      messages: [
        { role: "system", content: codebookPrompt.replace("{maxTags}", String(maxTags)) },
        { role: "user", content: input },
      ],
      jsonSchema: CODEBOOK_SCHEMA,
      signal: ctx.signal,
      onUsage: ctx.onUsage,
    });
    const obj = parseJsonObjectLoose(response);
    const canonical = (Array.isArray(obj?.canonical) ? obj.canonical : [])
      .filter((c): c is string => typeof c === "string" && c.trim() !== "")
      .slice(0, maxTags);
    const mapping: Record<string, string> = {};
    if (Array.isArray(obj?.mapping)) {
      for (const m of obj.mapping) {
        if (m && typeof m.from === "string" && typeof m.to === "string") {
          mapping[normalizeTag(m.from)] = m.to;
        }
      }
    }
    return { canonical, mapping };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    // フォールバック: 頻度上位をそのまま正規タグにする
    const canonical = sorted.slice(0, maxTags).map(([, v]) => v.display);
    const mapping: Record<string, string> = {};
    for (const [key, v] of sorted) mapping[key] = v.display;
    return { canonical, mapping };
  }
}

export async function buildCodebook(enrichments: OpinionEnrichment[], ctx: PipelineContext): Promise<Codebook> {
  const cached = await ctx.checkpoints.getChunk("codebook", "v1");
  if (cached) return deserializeCodebook(cached);

  const topicTags = collectTags(enrichments, "topics");
  const reasonTags = collectTags(enrichments, "reasons");
  const [topicResult, reasonResult] = await Promise.all([
    consolidate(topicTags, MAX_TOPICS, ctx),
    consolidate(reasonTags, MAX_REASONS, ctx),
  ]);

  const codebook: Codebook = {
    topics: topicResult.canonical,
    reasons: reasonResult.canonical,
    topicIndex: buildIndex(topicResult, topicTags),
    reasonIndex: buildIndex(reasonResult, reasonTags),
  };
  await ctx.checkpoints.putChunk("codebook", "v1", codebook);
  return codebook;
}

function buildIndex(
  result: { canonical: string[]; mapping: Record<string, string> },
  allTags: Map<string, { display: string; count: number }>,
): Record<string, number> {
  const canonicalIndex = new Map(result.canonical.map((c, i) => [normalizeTag(c), i]));
  const index: Record<string, number> = {};
  // 正規タグ自身
  for (const [key, i] of canonicalIndex) index[key] = i;
  // LLM のマッピング
  for (const [from, to] of Object.entries(result.mapping)) {
    const i = canonicalIndex.get(normalizeTag(to));
    if (i !== undefined) index[from] = i;
  }
  // 未マップのタグは部分一致で救済
  for (const key of allTags.keys()) {
    if (index[key] !== undefined) continue;
    for (const [canonKey, i] of canonicalIndex) {
      if (key.includes(canonKey) || canonKey.includes(key)) {
        index[key] = i;
        break;
      }
    }
  }
  return index;
}

/** 2パス目: 自由生成タグをコードブックに対する疎ベクトルへ変換する */
export function assignTagVector(tags: WeightedTag[], index: Record<string, number>): Map<number, number> {
  const vector = new Map<number, number>();
  for (const tag of tags) {
    const i = index[normalizeTag(tag.label)];
    if (i === undefined) continue;
    vector.set(i, Math.max(vector.get(i) ?? 0, tag.weight));
  }
  return vector;
}

// IndexedDB には Map が保存できないため素の形で持つ
function deserializeCodebook(raw: unknown): Codebook {
  const obj = raw as Codebook;
  return {
    topics: obj.topics ?? [],
    reasons: obj.reasons ?? [],
    topicIndex: obj.topicIndex ?? {},
    reasonIndex: obj.reasonIndex ?? {},
  };
}
