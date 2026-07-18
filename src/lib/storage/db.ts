import Dexie, { type EntityTable, type Table } from "dexie";
import {
  LEGACY_PROJECT_KIND,
  migrateNamespace,
  migrateStep,
  PROJECT_KIND,
  projectNamespace,
} from "../../stance-spectrum/storageKeys";
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

// v2: 賛否スペクトラム分析の永続キーから "phase2" という開発順序由来の名前を除く。
// スキーマ(インデックス)は変わらず、レコード内の値だけを移す。
db.version(2)
  .stores({})
  .upgrade(async (tx) => {
    // 旧データの kind は現行の ProjectKind には無い値なので、型は緩めて扱う
    await tx
      .table<{ kind?: string }>("projects")
      .toCollection()
      .modify((project) => {
        if (project.kind === LEGACY_PROJECT_KIND) project.kind = PROJECT_KIND;
      });

    // namespace(projectId)と step は複合主キーの構成要素なので modify では変えられない。
    // 新しいキーで put し直して旧行を消す。全件を一度にメモリへ載せると埋め込みベクトルで
    // 数百 MB になりうるため、必ずバッチで回す。
    // upgrade 全体が単一の versionchange トランザクションなので、途中で失敗すれば
    // すべてロールバックされ、次回起動時に再試行される(中途半端な状態にはならない)。
    const BATCH = 200;
    // 各テーブルの主キー構成(db.version(1).stores と対応)
    const tables: { name: string; primaryKey: (row: MigratableRow) => IDBValidKey }[] = [
      { name: "stepResults", primaryKey: (row) => [row.projectId, row.step as string] },
      { name: "extractionCache", primaryKey: (row) => [row.projectId, row.commentId as string] },
      { name: "chunkCache", primaryKey: (row) => [row.projectId, row.step as string, row.key as string] },
    ];

    for (const { name, primaryKey } of tables) {
      const store = tx.table<MigratableRow>(name);
      for (;;) {
        const rows = await store.filter(needsMigration).limit(BATCH).toArray();
        if (rows.length === 0) break;

        const oldKeys = rows.map(primaryKey);
        const migrated = rows.map((row) => ({
          ...row,
          projectId: migrateNamespace(row.projectId) ?? row.projectId,
          ...(typeof row.step === "string" ? { step: migrateStep(row.step) ?? row.step } : {}),
        }));

        // 先に消してから入れる。namespace だけが変わる行では新旧キーが異なるため
        // 順序はどちらでもよいが、変換が恒等になった場合に自分自身を消さないようにする。
        await store.bulkDelete(oldKeys);
        await store.bulkPut(migrated);
      }
    }
  });

type MigratableRow = { projectId: string; step?: unknown; commentId?: unknown; key?: unknown };

function needsMigration(row: MigratableRow): boolean {
  if (migrateNamespace(row.projectId) !== null) return true;
  return typeof row.step === "string" && migrateStep(row.step) !== null;
}

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
 * "{projectId}-stance-spectrum" namespace の中間データ(抽出 / embedding /
 * codebook / 候補辺 / umap 等)もまとめて消す。
 */
export async function deleteStanceSpectrumProjectData(projectId: string): Promise<void> {
  await db.transaction("rw", db.projects, db.stepResults, db.extractionCache, db.chunkCache, async () => {
    await db.projects.delete(projectId);
    for (const ns of [projectId, projectNamespace(projectId)]) {
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
