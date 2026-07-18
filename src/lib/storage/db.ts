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

/**
 * レポートに紐づく生成画像(ポンチ絵)。
 *
 * reports 本体ではなく別テーブルに置く。一覧画面は db.reports.toArray() で全行を
 * 読むため、Blob を ReportRow に入れると一覧を開くたびに全画像を構造化複製で
 * 読み込むことになる。別テーブルなら一覧はこのテーブルに触れない。
 */
export type ReportImageRow = {
  reportId: string;
  blob: Blob;
  /** 生成に使ったプロンプト(再生成時の参考・デバッグ用) */
  prompt: string;
  /** 生成に使ったモデル(コスト把握用) */
  model: string;
  createdAt: number;
};

export const DB_NAME = "kouchou-ai-serverless";

export const db = new Dexie(DB_NAME) as Dexie & {
  projects: EntityTable<Project, "id">;
  stepResults: Table<StepResultRow, [string, string]>;
  extractionCache: Table<ExtractionCacheRow, [string, string]>;
  chunkCache: Table<ChunkCacheRow, [string, string, string]>;
  reports: EntityTable<ReportRow, "id">;
  reportImages: EntityTable<ReportImageRow, "reportId">;
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
    // 新しいキーで put し直して旧行を消す。
    //
    // 移行対象かどうかは projectId と step だけで決まり、どちらも主キーに含まれる。
    // そこで primaryKeys() でキーだけを走査して対象を確定し、値の読み込みは実際に
    // 移行する行に限る。Collection.filter() は値カーソルなので全行を構造化複製で
    // 読み出してしまい、しかも移行済みの行は同じストアに残るため、バッチのたびに
    // 先頭から読み直すことになる(埋め込みベクトルを含む数万行で二次的に効く)。
    //
    // 対象を先に一度だけ確定させるので、1行が二度変換されることもない。
    const BATCH = 200;
    // 各テーブルの主キー構成(db.version(1).stores と対応)。
    // projectId は常に先頭、step は stepResults / chunkCache の2番目。
    const tables: { name: string; stepIndex: number | null }[] = [
      { name: "stepResults", stepIndex: 1 },
      { name: "extractionCache", stepIndex: null },
      { name: "chunkCache", stepIndex: 1 },
    ];

    for (const { name, stepIndex } of tables) {
      const store = tx.table<MigratableRow>(name);
      const allKeys = (await store.toCollection().primaryKeys()) as string[][];
      const migrateKey = (key: string[]): string[] | null => {
        const nextNamespace = migrateNamespace(key[0]);
        const nextStep = stepIndex !== null ? migrateStep(key[stepIndex]) : null;
        if (nextNamespace === null && nextStep === null) return null;
        const next = [...key];
        if (nextNamespace !== null) next[0] = nextNamespace;
        if (nextStep !== null && stepIndex !== null) next[stepIndex] = nextStep;
        return next;
      };
      const targets = allKeys.filter((key) => migrateKey(key) !== null);

      // 移行先のキーが既存の行とぶつかっていないか確かめる。ぶつかったまま bulkPut
      // すると相手を黙って上書きしてしまい、取り返しがつかない。現行の ID 体系
      // (crypto.randomUUID は16進数のみ)では起こらないはずだが、失うものが
      // LLM 課金済みの中間データなので確認してから進む。
      // キー要素自体が区切り文字を含みうるので、曖昧さのない JSON 表現で突き合わせる
      const asText = (key: string[]) => JSON.stringify(key);
      const staying = new Set(allKeys.filter((key) => migrateKey(key) === null).map(asText));
      const seen = new Set<string>();
      for (const key of targets) {
        const next = asText(migrateKey(key) as string[]);
        if (staying.has(next) || seen.has(next)) {
          throw new Error(`マイグレーション先のキーが衝突しました (${name}): ${next}`);
        }
        seen.add(next);
      }

      for (let offset = 0; offset < targets.length; offset += BATCH) {
        const batch = targets.slice(offset, offset + BATCH);
        const rows = await store.bulkGet(batch);
        const migrated: MigratableRow[] = [];
        for (const row of rows) {
          // 直前に列挙したキーなので通常あり得ないが、取れなければ黙って捨てずに落とす
          if (!row) throw new Error("マイグレーション中にレコードを読み出せませんでした");
          migrated.push({
            ...row,
            projectId: migrateNamespace(row.projectId) ?? row.projectId,
            ...(typeof row.step === "string" ? { step: migrateStep(row.step) ?? row.step } : {}),
          });
        }

        await store.bulkDelete(batch);
        await store.bulkPut(migrated);
      }
    }
  });

// v3: レポートのポンチ絵を置く reportImages を追加する。
// 既存データの変換は不要なので upgrade は無い(純粋な store 追加)。
db.version(3).stores({ reportImages: "reportId" });

type MigratableRow = { projectId: string; step?: unknown; commentId?: unknown; key?: unknown };

// 別タブが古いバージョンで DB を開いていると versionchange を取れず、Dexie は
// 無言で待ち続ける(画面が「読み込み中...」のまま理由も出ない)。理由を伝える。
db.on("blocked", () => {
  console.warn("他のタブがこのアプリを開いているため、データベースの更新を待っています。");
  alert("データの更新のため、このアプリを開いている他のタブを閉じてから再読み込みしてください。");
});

/**
 * 永続ストレージを要求する(DESIGN §5.3)。
 *
 * persist() はオリジン単位で、IndexedDB / OPFS / Cache Storage / localStorage を
 * まとめて eviction の対象外にする(API ごとの指定はできない)。本アプリが保存する
 * のは LLM 課金で得た中間データで、消えると実費が再発生するうえ、サーバを持たない
 * ためブラウザが唯一の保管場所になる。
 *
 * ただし Chrome はプロンプトを出さず、サイトのエンゲージメントやブックマークの
 * 有無などから黙って許可/拒否を返す。したがって初回作成時の1回で通るとは限らず、
 * 拒否されても分からない。設定画面から明示的に再要求できるようにしてある。
 */
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

export type StorageStatus = {
  /** 永続化 API に対応しているか */
  supported: boolean;
  /** eviction の対象外になっているか */
  persisted: boolean;
  /** 使用量(バイト)。取得できなければ null */
  usage: number | null;
  /** 割り当て上限(バイト)。取得できなければ null */
  quota: number | null;
};

/** 設定画面に出すストレージの状態 */
export async function getStorageStatus(): Promise<StorageStatus> {
  const status: StorageStatus = { supported: false, persisted: false, usage: null, quota: null };
  if (typeof navigator === "undefined" || !navigator.storage) return status;
  status.supported = typeof navigator.storage.persist === "function";
  try {
    if (typeof navigator.storage.persisted === "function") {
      status.persisted = await navigator.storage.persisted();
    }
  } catch {
    // 取得できなければ既定値のまま
  }
  try {
    if (typeof navigator.storage.estimate === "function") {
      const estimate = await navigator.storage.estimate();
      status.usage = estimate.usage ?? null;
      status.quota = estimate.quota ?? null;
    }
  } catch {
    // 同上
  }
  return status;
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

/**
 * レポートと、それに紐づく生成画像をまとめて削除する。
 *
 * 画像を別ストア(OPFS 等)に置くとこの不変条件をコード規律で守り続けることに
 * なり、消し忘れた画像が孤児として残る。同じ DB のトランザクションに載せることで
 * 「レポートを消せば画像も消える」を構造的に保証する。
 */
export async function deleteReportWithImage(reportId: string): Promise<void> {
  await db.transaction("rw", db.reports, db.reportImages, async () => {
    await db.reports.delete(reportId);
    await db.reportImages.delete(reportId);
  });
}

/** レポートのポンチ絵を保存する(1レポート1枚。再生成時は置き換え) */
export async function putReportImage(row: ReportImageRow): Promise<void> {
  await db.reportImages.put(row);
}

/** レポートのポンチ絵を取得する。無ければ undefined */
export async function getReportImage(reportId: string): Promise<ReportImageRow | undefined> {
  return db.reportImages.get(reportId);
}

/** レポートのポンチ絵を削除する */
export async function deleteReportImage(reportId: string): Promise<void> {
  await db.reportImages.delete(reportId);
}

/** レポート完成後に中間データのみ削除する(容量対策) */
export async function clearIntermediateData(projectId: string): Promise<void> {
  await db.transaction("rw", db.stepResults, db.extractionCache, db.chunkCache, async () => {
    await db.stepResults.where("[projectId+step]").between([projectId, ""], [projectId, "￿"]).delete();
    await db.extractionCache.where("projectId").equals(projectId).delete();
    await db.chunkCache.where("[projectId+step]").between([projectId, ""], [projectId, "￿"]).delete();
  });
}
