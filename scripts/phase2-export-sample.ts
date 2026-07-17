/**
 * フェーズ2の事前分析済みサンプルを public/sample-phase2.json に出力する。
 *   npx vite-node scripts/phase2-export-sample.ts
 * scripts/phase2-e2e.ts が作った testdata/phase2-state のキャッシュを再利用する
 * (LLM 呼び出しは全てキャッシュ済みのため API コストなし)。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import Papa from "papaparse";
import { normalizeComments } from "../src/lib/csv";
import { runClusteringCore } from "../src/lib/pipeline/clusteringCore";
import type { Checkpoints, PipelineContext } from "../src/lib/pipeline/context";
import { embedding } from "../src/lib/pipeline/steps/embedding";
import { assignTagVector, buildCodebook } from "../src/phase2/codebook";
import { extractAndEnrich } from "../src/phase2/extractEnrich";
import { buildCandidateEdges } from "../src/phase2/graph";
import { serializeSample } from "../src/phase2/sample";
import type { OpinionRecord } from "../src/phase2/types";
import { extractionPrompt } from "../src/prompts";

const N = Number(process.env.PHASE2_N ?? 150);
const STATE_DIR = "testdata/phase2-state";

function env(name: string): string {
  return (
    readFileSync(".env", "utf-8")
      .match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]
      ?.trim() ?? ""
  );
}

function fileCheckpoints(dir: string): Checkpoints {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
  const read = (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : undefined);
  return {
    async getExtraction(commentId) {
      return read(`${dir}/ext_${safe(commentId)}.json`);
    },
    async putExtraction(commentId, args) {
      writeFileSync(`${dir}/ext_${safe(commentId)}.json`, JSON.stringify(args));
    },
    async getChunk(step, key) {
      const raw = read(`${dir}/${safe(step)}_${safe(key)}.json`);
      if (raw?.__f32) return Float32Array.from(raw.__f32);
      return raw;
    },
    async putChunk(step, key, data) {
      const path = `${dir}/${safe(step)}_${safe(key)}.json`;
      if (data instanceof Float32Array) writeFileSync(path, JSON.stringify({ __f32: Array.from(data) }));
      else writeFileSync(path, JSON.stringify(data));
    },
  };
}

async function main() {
  const key = env("OPENAI_API_KEY");
  const ctx: PipelineContext = {
    chat: { baseUrl: "https://api.openai.com/v1", apiKey: key, model: "gpt-5-mini" },
    embedding: { baseUrl: "https://api.openai.com/v1", apiKey: key, model: "text-embedding-3-small" },
    concurrency: 8,
    checkpoints: fileCheckpoints(STATE_DIR),
  };

  const csv = readFileSync("testdata/virtual_survey_responses.csv", "utf-8");
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  // 属性付きで取り込む(属性軸のプレビューに使う)
  const comments = normalizeComments(parsed.data, "reasoning", null, ["age", "gender", "job", "education"]).slice(0, N);
  const attributesByComment = new Map(comments.map((c) => [c.commentId, c.attributes]));

  console.log("意見抽出 + 構造化属性付与(キャッシュ)...");
  const { args, relations, enrichments } = await extractAndEnrich(comments, extractionPrompt, ctx);
  console.log("埋め込み(キャッシュ)...");
  const emb = await embedding(args, ctx);
  console.log("コードブック(キャッシュ)...");
  const codebook = await buildCodebook(enrichments, ctx);

  const argIdToCommentId = new Map(relations.map((r) => [r.argId, r.commentId]));
  const records: OpinionRecord[] = args.map((arg, i) => {
    const commentId = argIdToCommentId.get(arg.argId) ?? "";
    return {
      id: arg.argId,
      originalCommentId: commentId,
      claimText: arg.argument,
      enrichment: enrichments[i],
      topicVector: assignTagVector(enrichments[i].topics, codebook.topicIndex),
      reasonVector: assignTagVector(enrichments[i].reasons, codebook.reasonIndex),
      attributes: attributesByComment.get(commentId),
    };
  });

  console.log("候補グラフ構築...");
  const edges = buildCandidateEdges(records, emb.vectors, emb.dim, {});
  console.log(`  ${edges.count.toLocaleString()} 辺`);

  console.log("初期レイアウト(UMAP)...");
  const layout = runClusteringCore({
    vectors: emb.vectors,
    dim: emb.dim,
    count: emb.argIds.length,
    clusterNums: [2],
    seed: "kouchou-ai",
  });

  const sample = serializeSample("サンプル: AI人権法案への意見(150コメント・事前分析済み)", records, codebook, edges, {
    x: layout.x,
    y: layout.y,
  });
  const json = JSON.stringify(sample);
  writeFileSync("public/sample-phase2.json", json);
  console.log(`public/sample-phase2.json に出力 (${(json.length / 1e6).toFixed(1)} MB, ${records.length} 意見)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
