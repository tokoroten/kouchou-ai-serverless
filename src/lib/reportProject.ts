import { extractionPrompt, initialLabellingPrompt, mergeLabellingPrompt, overviewPrompt } from "../prompts";
import type { ClusteringResult, CommentRow, ExtractionResult, Project, Relation } from "../types/project";
import type { Result } from "../types/result";
import { resolveEndpoint, type Settings } from "../types/settings";
import { dexieStepStore } from "./storage/checkpoints";
import { db, requestPersistentStorage } from "./storage/db";

// レポート(Result JSON)からクラスタリング再実行用のプロジェクトを復元する。
//
// サンプルレポートやインポートした Result JSON には、生成元プロジェクトが存在しない。
// しかし Result には意見(arguments)・元コメント・散布図座標がすべて入っているため、
// 埋め込みベクトルが無くても「保存済み座標の上でクラスタ数を切り直す → 再ラベリング」
// までは復元できる。UMAP のやり直しだけはベクトルが要るので、対話画面側で
// 「ベクトル化を実行」を促す(DESIGN §11.5)。

/** 再クラスタリングに必要な最低限のデータが Result に揃っているか */
export function canRecluster(result: Result): boolean {
  return result.arguments.length >= 2 && result.arguments.every((a) => Number.isFinite(a.x) && Number.isFinite(a.y));
}

/** 空文字のときは本家デフォルトのプロンプトへフォールバックする */
function promptOr(value: string | undefined, fallback: string): string {
  return value?.trim() ? value : fallback;
}

export function projectFromResult(
  result: Result,
  options: { id: string; reportId: string; title: string; settings: Settings },
): { project: Project; extraction: ExtractionResult; clustering: ClusteringResult } {
  const { id, reportId, title, settings } = options;
  const config = result.config;
  const attributeColumns = Object.keys(result.propertyMap ?? {});

  // コメントの属性は Result では意見側に載っているため、最初に見つかったものを採用する
  const attributesByComment = new Map<string, Record<string, string>>();
  for (const arg of result.arguments) {
    const key = String(arg.comment_id);
    if (attributesByComment.has(key) || !arg.attributes) continue;
    const attributes: Record<string, string> = {};
    for (const column of attributeColumns) {
      const value = arg.attributes[column];
      if (value !== undefined) attributes[column] = String(value);
    }
    attributesByComment.set(key, attributes);
  }
  const comments: CommentRow[] = Object.entries(result.comments ?? {}).map(([commentId, row]) => ({
    commentId,
    body: row.comment,
    attributes: attributesByComment.get(commentId) ?? {},
  }));

  const relations: Relation[] = result.arguments.map((a) => ({
    argId: a.arg_id,
    commentId: String(a.comment_id),
  }));
  const extraction: ExtractionResult = {
    args: result.arguments.map((a) => ({ argId: a.arg_id, argument: a.argument })),
    relations,
  };

  // 散布図座標と、cluster_ids("{level}_{label}")から階層ごとの割当を復元する
  const count = result.arguments.length;
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const labelsByLevel = new Map<number, Int32Array>();
  for (let i = 0; i < count; i++) {
    const arg = result.arguments[i];
    x[i] = arg.x;
    y[i] = arg.y;
    for (const clusterId of arg.cluster_ids) {
      const [levelPart, labelPart] = clusterId.split("_");
      const level = Number(levelPart);
      const label = Number(labelPart);
      if (!Number.isInteger(level) || level < 1 || !Number.isInteger(label)) continue;
      let labels = labelsByLevel.get(level);
      if (!labels) {
        labels = new Int32Array(count).fill(-1);
        labelsByLevel.set(level, labels);
      }
      labels[i] = label;
    }
  }
  const levels = [...labelsByLevel.keys()].sort((a, b) => a - b);
  const assignments = levels.map((level) => labelsByLevel.get(level) as Int32Array);
  const clusterNums =
    assignments.length > 0
      ? assignments.map((labels) => new Set(Array.from(labels).filter((l) => l >= 0)).size)
      : (config?.hierarchical_clustering?.cluster_nums ?? []);
  const clustering: ClusteringResult = {
    argIds: result.arguments.map((a) => a.arg_id),
    x,
    y,
    clusterNums,
    assignments,
  };

  const project: Project = {
    id,
    kind: "normal",
    title,
    question: config?.question ?? "",
    intro: config?.intro ?? "",
    createdAt: Date.now(),
    comments,
    attributeColumns,
    settingsSnapshot: {
      chat: resolveEndpoint(settings, "chat"),
      embedding: resolveEndpoint(settings, "embedding"),
      concurrency: settings.concurrency,
    },
    clusterNums,
    prompts: {
      extraction: promptOr(config?.extraction?.prompt, extractionPrompt),
      initialLabelling: promptOr(config?.hierarchical_initial_labelling?.prompt, initialLabellingPrompt),
      mergeLabelling: promptOr(config?.hierarchical_merge_labelling?.prompt, mergeLabellingPrompt),
      overview: promptOr(config?.hierarchical_overview?.prompt, overviewPrompt),
    },
    samplingNum: 30,
    status: "done",
    currentStep: "aggregation",
    reportId,
    tokenUsage: { input: 0, output: 0, total: 0 },
  };

  return { project, extraction, clustering };
}

/**
 * レポートに対応する再クラスタリング用プロジェクトを用意し、その id を返す。
 * すでに生成元/復元済みプロジェクトがあればそれを再利用する(毎回作り直さない)。
 */
export async function ensureInteractiveProject(
  reportId: string,
  title: string,
  result: Result,
  settings: Settings,
): Promise<string> {
  const existing = await db.projects.filter((p) => p.reportId === reportId).first();
  if (existing) return existing.id;
  if (!canRecluster(result)) {
    throw new Error("このレポートには散布図座標が無いため、クラスタリングを再実行できません");
  }
  await requestPersistentStorage();
  const id = crypto.randomUUID();
  const { project, extraction, clustering } = projectFromResult(result, { id, reportId, title, settings });
  await db.projects.put(project);
  const store = dexieStepStore(id);
  await store.put("extraction", extraction);
  await store.put("clustering", clustering);
  return id;
}
