import type {
  ClusteringResult,
  EmbeddingResult,
  ExtractionResult,
  LabellingResult,
  PipelineStepName,
  Project,
} from "../../types/project";
import type { Result } from "../../types/result";
import { buildClusterTable } from "./clusterTable";
import type { PipelineContext } from "./context";
import { aggregation } from "./steps/aggregation";
import { type ClusteringProgressExtra, clustering } from "./steps/clustering";
import { embedding } from "./steps/embedding";
import { extraction } from "./steps/extraction";
import { initialLabelling, mergeLabelling } from "./steps/labelling";
import { overview } from "./steps/overview";

// パイプラインの逐次実行(DESIGN §6)。
// 各ステップの完了済み出力は store に確定保存し、再実行時はそこから再開する。
// ステップ内部の細かい再開(コメント単位・バッチ単位・クラスタ単位)は ctx.checkpoints が担う。

export type StepStore = {
  // biome-ignore lint/suspicious/noExplicitAny: ステップごとに型が異なる
  get(step: PipelineStepName): Promise<any | undefined>;
  // biome-ignore lint/suspicious/noExplicitAny: ステップごとに型が異なる
  put(step: PipelineStepName, data: any): Promise<void>;
};

export type OrchestratorDeps = {
  ctx: PipelineContext;
  store: StepStore;
  onStepChange?: (step: PipelineStepName) => void;
  clusteringExtra?: ClusteringProgressExtra;
};

export async function runPipeline(project: Project, deps: OrchestratorDeps): Promise<Result> {
  const { ctx, store, onStepChange } = deps;

  onStepChange?.("extraction");
  let extractionResult: ExtractionResult | undefined = await store.get("extraction");
  if (!extractionResult) {
    extractionResult = await extraction(project.comments, project.prompts.extraction, ctx);
    await store.put("extraction", extractionResult);
  }

  onStepChange?.("embedding");
  let embeddingResult: EmbeddingResult | undefined = await store.get("embedding");
  if (!embeddingResult) {
    embeddingResult = await embedding(extractionResult.args, ctx);
    await store.put("embedding", embeddingResult);
  }

  onStepChange?.("clustering");
  let clusteringResult: ClusteringResult | undefined = await store.get("clustering");
  if (!clusteringResult) {
    clusteringResult = await clustering(embeddingResult, project.clusterNums, ctx, deps.clusteringExtra);
    await store.put("clustering", clusteringResult);
  }

  const table = buildClusterTable(extractionResult.args, clusteringResult);

  onStepChange?.("initial_labelling");
  let deepestLabels = await store.get("initial_labelling");
  if (!deepestLabels) {
    deepestLabels = await initialLabelling(table, project.prompts.initialLabelling, project.samplingNum, ctx);
    await store.put("initial_labelling", deepestLabels);
  }

  onStepChange?.("merge_labelling");
  let labels: LabellingResult | undefined = await store.get("merge_labelling");
  if (!labels) {
    labels = await mergeLabelling(table, deepestLabels, project.prompts.mergeLabelling, project.samplingNum, ctx);
    await store.put("merge_labelling", labels);
  }

  onStepChange?.("overview");
  let overviewText: string | undefined = await store.get("overview");
  if (overviewText === undefined) {
    overviewText = await overview(labels, project.prompts.overview, ctx);
    await store.put("overview", overviewText);
  }

  onStepChange?.("aggregation");
  const result = aggregation({
    project,
    comments: project.comments,
    extractionResult,
    table,
    labels,
    overviewText,
    chatModel: ctx.chat.model,
    embeddingModel: ctx.embedding.model,
    workers: ctx.concurrency,
  });
  await store.put("aggregation", result);
  return result;
}
