/**
 * フェーズ2エンジンの実データ E2E(Node)。
 *   npx vite-node scripts/phase2-e2e.ts
 * testdata の実データ(既定150件)で 抽出→埋め込み→構造化→コードブック→候補グラフ→
 * Louvain→focus+context の stance 分裂 まで、UI を除く全経路を検証する。
 * PHASE2_N=300 PHASE2_MODEL=gpt-5-mini で調整可。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Papa from "papaparse";
import { normalizeComments } from "../src/lib/csv";
import type { Checkpoints, PipelineContext } from "../src/lib/pipeline/context";
import { embedding } from "../src/lib/pipeline/steps/embedding";
import { trackClusters } from "../src/phase2/clusterTracker";
import { assignTagVector, buildCodebook } from "../src/phase2/codebook";
import { extractAndEnrich } from "../src/phase2/extractEnrich";
import { buildCandidateEdges, clusterByLouvain, computeEdgeWeights } from "../src/phase2/graph";
import { STANCE_LABEL_JA, summarizeCluster } from "../src/phase2/labelTemplate";
import type { OpinionRecord } from "../src/phase2/types";
import { DEFAULT_VIEW, dominantStance } from "../src/phase2/types";
import { extractionPrompt } from "../src/prompts";

const N = Number(process.env.PHASE2_N ?? 150);
const MODEL = process.env.PHASE2_MODEL ?? "gpt-5-mini";
const STATE_DIR = "testdata/phase2-state";

function env(name: string): string {
  return (
    readFileSync(".env", "utf-8")
      .match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]
      ?.trim() ?? ""
  );
}

function fileCheckpoints(dir: string): Checkpoints {
  mkdirSync(dir, { recursive: true });
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
      if (data instanceof Float32Array) {
        writeFileSync(path, JSON.stringify({ __f32: Array.from(data) }));
      } else {
        writeFileSync(path, JSON.stringify(data));
      }
    },
  };
}

async function main() {
  const key = env("OPENAI_API_KEY");
  const ctx: PipelineContext = {
    chat: { baseUrl: "https://api.openai.com/v1", apiKey: key, model: MODEL },
    embedding: { baseUrl: "https://api.openai.com/v1", apiKey: key, model: "text-embedding-3-small" },
    concurrency: 8,
    checkpoints: fileCheckpoints(STATE_DIR),
    onProgress: () => {},
  };

  const csv = readFileSync("testdata/virtual_survey_responses.csv", "utf-8");
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  const comments = normalizeComments(parsed.data, "reasoning", null, []).slice(0, N);

  console.log(`[1/5] 意見抽出 + 構造化属性付与 (${comments.length} コメント, ${MODEL})...`);
  let last = 0;
  const { args, enrichments } = await extractAndEnrich(comments, extractionPrompt, ctx, (done, total) => {
    if (done - last >= 25 || done === total) {
      console.log(`  ${done}/${total} コメント`);
      last = done;
    }
  });
  console.log(`  → ${args.length} 意見`);
  const stanceCounts = new Map<string, number>();
  for (const e of enrichments) {
    const s = dominantStance(e.stance);
    stanceCounts.set(s, (stanceCounts.get(s) ?? 0) + 1);
  }
  console.log(`  stance 内訳: ${[...stanceCounts.entries()].map(([k, v]) => `${k}:${v}`).join(", ")}`);

  console.log("[2/5] 埋め込み...");
  const emb = await embedding(args, ctx);
  console.log(`  → ${emb.dim} 次元`);

  console.log("[3/5] コードブック統合(2パス)...");
  const codebook = await buildCodebook(enrichments, ctx);
  console.log(`  topics: ${codebook.topics.slice(0, 10).join(", ")}${codebook.topics.length > 10 ? "..." : ""}`);
  console.log(`  reasons: ${codebook.reasons.slice(0, 10).join(", ")}${codebook.reasons.length > 10 ? "..." : ""}`);

  const records: OpinionRecord[] = args.map((arg, i) => ({
    id: arg.argId,
    originalCommentId: "",
    claimText: arg.argument,
    enrichment: enrichments[i],
    topicVector: assignTagVector(enrichments[i].topics, codebook.topicIndex),
    reasonVector: assignTagVector(enrichments[i].reasons, codebook.reasonIndex),
  }));
  const assigned = records.filter((r) => r.topicVector.size > 0).length;
  console.log(`  タグ割当率: topics ${((assigned / records.length) * 100).toFixed(0)}%`);

  console.log("[4/5] 候補グラフ構築...");
  const t0 = Date.now();
  const edges = buildCandidateEdges(records, emb.vectors, emb.dim, {
    onProgress: (done, total, phase) => {
      if (done === total) console.log(`  ${phase} 完了`);
    },
  });
  console.log(`  → ${edges.count.toLocaleString()} 辺 (${Math.round((Date.now() - t0) / 1000)}s)`);

  console.log("[5/5] クラスタリング検証...");
  // トピックビュー
  const baseView = { ...DEFAULT_VIEW };
  const baseWeights = computeEdgeWeights(edges, baseView, null);
  const baseCommunities = clusterByLouvain(records.length, edges, baseWeights, baseView, null);
  const tracked = trackClusters(baseCommunities, null);
  const byLabel = new Map<string, number[]>();
  tracked.labels.forEach((label, i) => {
    if (!label) return;
    const list = byLabel.get(label) ?? [];
    list.push(i);
    byLabel.set(label, list);
  });
  const sorted = [...byLabel.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log(`  トピックビュー: ${sorted.length} クラスタ`);
  for (const [label, members] of sorted.slice(0, 6)) {
    const summary = summarizeCluster(members, records, codebook);
    console.log(`   - [${label}] ${summary.label} (${members.length}件)`);
  }

  // focus+context: stance が最も混在しているクラスタ(エントロピー最大)で stance を上げる
  const entropyOf = (members: number[]) => {
    const mix = new Map<string, number>();
    for (const i of members) {
      const s = dominantStance(records[i].enrichment.stance);
      mix.set(s, (mix.get(s) ?? 0) + 1);
    }
    let h = 0;
    for (const count of mix.values()) {
      const p = count / members.length;
      h -= p * Math.log2(p);
    }
    return h;
  };
  const purityOf = (members: number[]) => {
    const mix = new Map<string, number>();
    for (const i of members) {
      const s = dominantStance(records[i].enrichment.stance);
      mix.set(s, (mix.get(s) ?? 0) + 1);
    }
    return Math.max(...mix.values()) / members.length;
  };
  const [focusLabel, focusMembers] = [...sorted]
    .filter(([, m]) => m.length >= 30)
    .sort((a, b) => entropyOf(b[1]) - entropyOf(a[1]))[0];
  console.log(
    `\n  分裂対象: stance 混在度最大のクラスタ (${focusMembers.length}件, 純度 ${(purityOf(focusMembers) * 100).toFixed(0)}%)`,
  );
  const focusView = { ...baseView, stanceWeight: 3, selectedClusterId: focusLabel, edgeThreshold: 0.3 };
  const focusWeights = computeEdgeWeights(edges, focusView, tracked.labels);
  const focusCommunities = clusterByLouvain(records.length, edges, focusWeights, focusView, tracked.labels);
  const frozen = tracked.labels.map((l) => l !== focusLabel);
  const focusTracked = trackClusters(focusCommunities, tracked, frozen);
  const subLabels = new Map<string, number[]>();
  for (const i of focusMembers) {
    const label = focusTracked.labels[i];
    if (!label) continue;
    const list = subLabels.get(label) ?? [];
    list.push(i);
    subLabels.set(label, list);
  }
  console.log(
    `\n  focus+context: 最大クラスタ(${focusMembers.length}件)に stance 重み3 → ${subLabels.size} サブクラスタ`,
  );
  const stanceMixOf = (members: number[]) => {
    const mix = new Map<string, number>();
    for (const i of members) {
      const s = STANCE_LABEL_JA[dominantStance(records[i].enrichment.stance)];
      mix.set(s, (mix.get(s) ?? 0) + 1);
    }
    return [...mix.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(", ");
  };
  for (const [label, members] of [...subLabels.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
    if (members.length < 3) continue;
    const summary = summarizeCluster(members, records, codebook);
    console.log(`   - [${label}] ${summary.label} (${members.length}件) — ${stanceMixOf(members)}`);
  }

  // 検証1: サブクラスタ間で支配 stance が分化しているか
  const bigSubs = [...subLabels.values()].filter((m) => m.length >= 5);
  const dominantSet = new Set(
    bigSubs.map((m) => {
      const mix = new Map<string, number>();
      for (const i of m) {
        const s = dominantStance(records[i].enrichment.stance);
        mix.set(s, (mix.get(s) ?? 0) + 1);
      }
      return [...mix.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }),
  );
  // 検証2: 分裂後の加重平均純度が親クラスタより上がっているか
  const parentPurity = purityOf(focusMembers);
  const childPurity =
    bigSubs.reduce((sum, m) => sum + purityOf(m) * m.length, 0) /
    Math.max(
      1,
      bigSubs.reduce((s, m) => s + m.length, 0),
    );
  console.log(`\n  サブクラスタの支配 stance 種類: ${dominantSet.size} (${[...dominantSet].join(", ")})`);
  console.log(
    `  stance 純度: 親 ${(parentPurity * 100).toFixed(0)}% → 子(加重平均) ${(childPurity * 100).toFixed(0)}%`,
  );
  const pass = dominantSet.size >= 2 || childPurity - parentPurity >= 0.15;
  console.log(pass ? "\n✅ stance による分裂を確認" : "\n⚠️ stance 分裂が不十分(データ/重みの調整余地あり)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
