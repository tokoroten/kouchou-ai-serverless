/**
 * 実 API を使ったパイプラインの E2E デバッグスクリプト(Node / vite-node)。
 *   pnpm debug:pipeline
 * 環境変数(.env): OPENAI_API_KEY / LM_STUDIO_AUTH_KEY / OPENROUTER_API_KEY
 *   DEBUG_N: 使用するコメント数(既定 30)
 *   DEBUG_PROVIDER: openai | lmstudio | openrouter(chat のみ切替。embedding は常に OpenAI)
 * 本番コードと同じエンジン(src/lib/pipeline)をそのまま実行する。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Papa from "papaparse";
import { normalizeComments } from "../src/lib/csv";
import { probeChat } from "../src/lib/llm/client";
import type { Checkpoints } from "../src/lib/pipeline/context";
import { memoryCheckpoints, type PipelineContext } from "../src/lib/pipeline/context";
import { runPipeline } from "../src/lib/pipeline/orchestrator";
import { extractionPrompt, initialLabellingPrompt, mergeLabellingPrompt, overviewPrompt } from "../src/prompts";
import type { PipelineStepName, Project } from "../src/types/project";
import type { EndpointConfig } from "../src/types/settings";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(".env", "utf-8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match) env[match[1]] = match[2].trim();
    }
  } catch {
    // no .env
  }
  return env;
}

const env = loadEnv();
const N = Number(process.env.DEBUG_N ?? 30);
const provider = process.env.DEBUG_PROVIDER ?? "openai";

const endpoints: Record<string, EndpointConfig> = {
  openai: { baseUrl: "https://api.openai.com/v1", apiKey: env.OPENAI_API_KEY ?? "", model: "gpt-4o-mini" },
  lmstudio: { baseUrl: "http://localhost:1234/v1", apiKey: env.LM_STUDIO_AUTH_KEY ?? "", model: "google/gemma-4-e4b" },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: env.OPENROUTER_API_KEY ?? "",
    model: process.env.DEBUG_OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
  },
};

const chat = endpoints[provider];
if (!chat?.apiKey && provider !== "lmstudio") {
  console.error(`API キーがありません: ${provider}`);
  process.exit(1);
}
const embedding: EndpointConfig = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: env.OPENAI_API_KEY ?? "",
  model: "text-embedding-3-small",
};

// DEBUG_STATE=dir を指定するとファイルベースのチェックポイントで中断・再開できる
function fileCheckpoints(dir: string): Checkpoints {
  mkdirSync(dir, { recursive: true });
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
  return {
    async getExtraction(commentId) {
      const path = `${dir}/ext_${safe(commentId)}.json`;
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : undefined;
    },
    async putExtraction(commentId, args) {
      writeFileSync(`${dir}/ext_${safe(commentId)}.json`, JSON.stringify(args));
    },
    async getChunk(step, key) {
      const path = `${dir}/${safe(step)}_${safe(key)}.json`;
      if (!existsSync(path)) return undefined;
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      // Float32Array / Int32Array は type タグ付きで復元
      if (raw?.__f32) return Float32Array.from(raw.__f32);
      if (raw?.__clustering) {
        return {
          ...raw.__clustering,
          x: Float32Array.from(raw.__clustering.x),
          y: Float32Array.from(raw.__clustering.y),
          assignments: raw.__clustering.assignments.map((a: number[]) => Int32Array.from(a)),
        };
      }
      if (raw?.__coords) {
        return { x: Float32Array.from(raw.__coords.x), y: Float32Array.from(raw.__coords.y) };
      }
      return raw;
    },
    async putChunk(step, key, data) {
      const path = `${dir}/${safe(step)}_${safe(key)}.json`;
      let serializable = data;
      if (data instanceof Float32Array) {
        serializable = { __f32: Array.from(data) };
      } else if (data && typeof data === "object" && data.assignments) {
        serializable = {
          __clustering: {
            ...data,
            x: Array.from(data.x),
            y: Array.from(data.y),
            assignments: data.assignments.map((a: Int32Array) => Array.from(a)),
          },
        };
      } else if (data && typeof data === "object" && data.x instanceof Float32Array) {
        serializable = { __coords: { x: Array.from(data.x), y: Array.from(data.y) } };
      }
      writeFileSync(path, JSON.stringify(serializable));
    },
  };
}

async function main() {
  console.log(`=== chat 応答テスト (${provider}: ${chat.model}) ===`);
  const probe = await probeChat(chat, 30_000);
  console.log(probe.ok ? `OK ${probe.latencyMs}ms: ${probe.message}` : `NG: ${probe.message}`);
  if (!probe.ok) process.exit(1);

  const csv = readFileSync("testdata/virtual_survey_responses.csv", "utf-8");
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  const comments = normalizeComments(parsed.data, "reasoning", null, ["age", "gender", "prefecture"]).slice(0, N);
  console.log(`=== パイプライン実行: ${comments.length} コメント ===`);

  const usage = { input: 0, output: 0, total: 0 };
  let lastLog = "";
  const ctx: PipelineContext = {
    chat,
    embedding,
    concurrency: 8,
    checkpoints: process.env.DEBUG_STATE ? fileCheckpoints(process.env.DEBUG_STATE) : memoryCheckpoints(),
    onProgress: (e) => {
      const line = `${e.step}: ${e.done}/${e.total}${e.message ? ` (${e.message})` : ""}`;
      if (line !== lastLog && (e.done === e.total || e.done % 10 === 0 || e.total < 20)) {
        console.log(line);
        lastLog = line;
      }
    },
    onUsage: (u) => {
      usage.input += u.input;
      usage.output += u.output;
      usage.total += u.total;
    },
  };

  const project: Project = {
    id: "debug",
    title: "AI人権法案に関する意見調査(デバッグ)",
    question: "AIに人権を認める法案についてどう思いますか?",
    intro: "デバッグ実行です。",
    createdAt: Date.now(),
    comments,
    attributeColumns: ["age", "gender", "prefecture"],
    settingsSnapshot: { chat, embedding, concurrency: 8 },
    clusterNums: [],
    prompts: {
      extraction: extractionPrompt,
      initialLabelling: initialLabellingPrompt,
      mergeLabelling: mergeLabellingPrompt,
      overview: overviewPrompt,
    },
    samplingNum: 30,
    status: "created",
    currentStep: null,
    tokenUsage: { input: 0, output: 0, total: 0 },
  };

  const stepData = new Map<string, unknown>();
  const start = Date.now();
  const result = await runPipeline(project, {
    ctx,
    store: {
      async get(step: PipelineStepName) {
        return stepData.get(step);
      },
      async put(step: PipelineStepName, data: unknown) {
        stepData.set(step, data);
      },
    },
    onStepChange: (step) => console.log(`--- step: ${step} ---`),
  });
  const elapsed = Math.round((Date.now() - start) / 1000);

  // ---- 検証 ----
  const errors: string[] = [];
  if (result.arguments.length < 2) errors.push("arguments が少なすぎる");
  const clusterIds = new Set(result.clusters.map((c) => c.id));
  for (const arg of result.arguments) {
    if (!/^A.+_\d+$/.test(arg.arg_id)) errors.push(`arg_id 形式不正: ${arg.arg_id}`);
    if (arg.cluster_ids[0] !== "0") errors.push(`cluster_ids[0] != "0": ${arg.arg_id}`);
    for (const id of arg.cluster_ids) {
      if (!clusterIds.has(id)) errors.push(`存在しないクラスタ参照: ${id}`);
    }
  }
  for (const cluster of result.clusters) {
    if (cluster.level > 0 && !clusterIds.has(cluster.parent))
      errors.push(`親クラスタ不在: ${cluster.id} -> ${cluster.parent}`);
    if (cluster.level > 0 && !cluster.label) errors.push(`ラベル空: ${cluster.id}`);
  }
  if (!result.overview) errors.push("overview が空");
  if (result.comment_num !== comments.length) errors.push("comment_num 不一致");
  const attrCount = result.arguments.filter((a) => a.attributes).length;

  mkdirSync("testdata", { recursive: true });
  writeFileSync("testdata/debug-result.json", JSON.stringify(result, null, 2));
  console.log("\n=== 結果 ===");
  console.log(`所要: ${elapsed}s / args: ${result.arguments.length} / clusters: ${result.clusters.length}`);
  console.log(`クラスタ数構成: ${JSON.stringify(result.config.hierarchical_clustering.cluster_nums)}`);
  console.log(`属性付き args: ${attrCount}/${result.arguments.length}`);
  console.log(`トークン: in=${usage.input} out=${usage.output}`);
  console.log(`overview: ${result.overview.slice(0, 120)}...`);
  console.log("level1 ラベル:");
  for (const c of result.clusters.filter((c) => c.level === 1)) {
    console.log(`  - ${c.label} (${c.value}件, density_pct=${c.density_rank_percentile.toFixed(2)})`);
  }
  if (errors.length > 0) {
    console.error(`\n検証エラー ${errors.length} 件:`);
    for (const e of errors.slice(0, 10)) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("\n検証 OK ✅ (testdata/debug-result.json に保存)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
