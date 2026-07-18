import Dexie, { type EntityTable, type Table } from "dexie";
import type { Project } from "../../types/project";
import type { Result } from "../../types/result";

// IndexedDB スキーマ(DESIGN §5.3)。
// - 再開の粒度: extraction はコメント単位、embedding はバッチ単位、labelling はクラスタ単位
// - embeddings は Float32Array のまま保存する(IndexedDB は TypedArray を直接格納できる)

export type StepResultRow = {
  projectId: string;
  step: string;
  // ステップごとの確定出力(JSON 化可能な形 + TypedArray)
  // biome-ignore lint/suspicious/noExplicitAny: ステップごとに型が異なる
  data: any;
  completedAt: number;
};

export type ExtractionCacheRow = {
  projectId: string;
  commentId: string;
  args: string[]; // 抽出された意見(重複排除前の生テキスト)
};

export type ChunkCacheRow = {
  // embedding バッチ / labelling クラスタ単位の途中結果
  projectId: string;
  step: string;
  key: string; // バッチ番号 or クラスタID
  // biome-ignore lint/suspicious/noExplicitAny: ステップごとに型が異なる
  data: any;
};

export type ReportRow = {
  id: string;
  title: string;
  createdAt: number;
  result: Result;
  /** 生成に要したトークン実績(インポートしたレポートには無い) */
  tokenUsage?: { input: number; output: number; total: number };
  /** 生成に使ったチャットモデル(コスト概算用) */
  chatModel?: string;
  /** 生成時の処理ティア(flex は約50%割引でコスト概算に反映) */
  serviceTier?: string;
};

export const db = new Dexie("kouchou-ai-serverless") as Dexie & {
  projects: EntityTable<Project, "id">;
  stepResults: Table<StepResultRow, [string, string]>;
  extractionCache: Table<ExtractionCacheRow, [string, string]>;
  chunkCache: Table<ChunkCacheRow, [string, string, string]>;
  reports: EntityTable<ReportRow, "id">;
};

db.version(1).stores({
  projects: "id, createdAt",
  stepResults: "[projectId+step]",
  extractionCache: "[projectId+commentId], projectId",
  chunkCache: "[projectId+step+key], [projectId+step]",
  reports: "id, createdAt",
});

/** 初回プロジェクト作成時に永続ストレージを要求する(DESIGN §5.3) */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) {
      const persisted = await navigator.storage.persisted();
      if (persisted) return true;
      return await navigator.storage.persist();
    }
  } catch {
    // 非対応ブラウザ
  }
  return false;
}

/** プロジェクトと中間データを削除する */
export async function deleteProjectData(projectId: string): Promise<void> {
  await db.transaction("rw", db.projects, db.stepResults, db.extractionCache, db.chunkCache, async () => {
    await db.projects.delete(projectId);
    await db.stepResults.where("[projectId+step]").between([projectId, ""], [projectId, "￿"]).delete();
    await db.extractionCache.where("projectId").equals(projectId).delete();
    await db.chunkCache.where("[projectId+step]").between([projectId, ""], [projectId, "￿"]).delete();
  });
}

/**
 * 賛否スペクトラム分析プロジェクトの削除。プロジェクト本体に加え、隔離した
 * "{projectId}-phase2" namespace の中間データ(phase2-extract / embedding /
 * codebook / phase2-edges / umap 等)もまとめて消す。
 */
export async function deletePhase2ProjectData(projectId: string): Promise<void> {
  const phase2Id = `${projectId}-phase2`;
  await db.transaction("rw", db.projects, db.stepResults, db.extractionCache, db.chunkCache, async () => {
    await db.projects.delete(projectId);
    for (const ns of [projectId, phase2Id]) {
      await db.stepResults.where("[projectId+step]").between([ns, ""], [ns, "￿"]).delete();
      await db.extractionCache.where("projectId").equals(ns).delete();
      await db.chunkCache.where("[projectId+step]").between([ns, ""], [ns, "￿"]).delete();
    }
  });
}

/**
 * ポストプロセス(clustering 以降)の結果のみリセットする。
 * 高コストな前処理(extraction=意見分解, embedding=ベクトル化)は保持されるため、
 * クラスタ数などのパラメータを変えて LLM コストほぼゼロで再実行できる。
 * labelling のキャッシュはクラスタ構成ハッシュ付きキーのため消さない
 * (同一構成のクラスタはラベルを再利用できる)。
 */
export async function resetPostprocess(projectId: string): Promise<void> {
  await db.transaction("rw", db.stepResults, db.chunkCache, async () => {
    for (const step of ["clustering", "initial_labelling", "merge_labelling", "overview", "aggregation"]) {
      await db.stepResults.delete([projectId, step]);
    }
    // clustering の chunk はパラメータ違いの結果が混ざるため消す(labelling/overview は構成ハッシュ付きなので残す)
    // UMAP 座標(step="umap")はデータ本体が変わらない限り有効なため残す
    await db.chunkCache.where("[projectId+step]").equals([projectId, "clustering"]).delete();
  });
}

/** レポート完成後に中間データのみ削除する(容量対策) */
export async function clearIntermediateData(projectId: string): Promise<void> {
  await db.transaction("rw", db.stepResults, db.extractionCache, db.chunkCache, async () => {
    await db.stepResults.where("[projectId+step]").between([projectId, ""], [projectId, "￿"]).delete();
    await db.extractionCache.where("projectId").equals(projectId).delete();
    await db.chunkCache.where("[projectId+step]").between([projectId, ""], [projectId, "￿"]).delete();
  });
}
