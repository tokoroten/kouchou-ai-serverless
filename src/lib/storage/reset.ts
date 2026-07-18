import { DB_NAME, db } from "./db";

// 保存データの消去。
//
// 想定する使いどころは「スキーマのマイグレーションに失敗して db.open() が毎回
// 失敗し、アプリが起動しなくなった」状態からの復旧なので、Dexie を経由せず
// 生の API だけで動くようにしてある(Dexie が開けない状況でも実行できる)。
//
// 【重要】IndexedDB も OPFS もオリジン単位で、パス単位ではない。
// 本番の配信元は https://tokoroten.github.io/kouchou-ai-serverless/ で、
// オリジン(https://tokoroten.github.io)は同じアカウントの他の GitHub Pages
// プロジェクトと共有される。したがって「オリジンの全データを消す」は
// 無関係なアプリのデータまで巻き込む。既定は本アプリの DB のみとし、
// オリジン全体の消去は呼び出し側が明示したときだけ行う。

export type WipeScope = "app" | "origin";

export type WipeReport = {
  /** 削除した IndexedDB のデータベース名 */
  deletedDatabases: string[];
  /** 削除した OPFS の直下エントリ名 */
  deletedOpfsEntries: string[];
  /** 個別に失敗したもの(処理は続行する) */
  errors: string[];
};

/** オリジンに存在する、本アプリ以外の保存データ(消す前に提示するため) */
export type ForeignData = {
  databases: string[];
  opfsEntries: string[];
};

/** 他タブが掴んでいると deleteDatabase は完了しないので、待ち続けずに理由を返す */
const BLOCKED_TIMEOUT_MS = 3000;

function deleteDatabase(name: string): Promise<"deleted" | "blocked"> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    let blocked = false;
    request.onsuccess = () => resolve("deleted");
    request.onerror = () => reject(request.error ?? new Error(`${name} の削除に失敗しました`));
    request.onblocked = () => {
      blocked = true;
    };
    // onblocked のあとに他タブが閉じれば onsuccess が来る。来なければ諦めて報告する
    setTimeout(() => {
      if (blocked) resolve("blocked");
    }, BLOCKED_TIMEOUT_MS);
  });
}

async function listOpfsEntries(): Promise<string[]> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return [];
  try {
    const root = await navigator.storage.getDirectory();
    // keys() の非同期イテレータは型定義に載っていない環境がある
    const iterable = root as unknown as { keys?: () => AsyncIterableIterator<string> };
    if (!iterable.keys) return [];
    const names: string[] = [];
    for await (const name of iterable.keys()) names.push(name);
    return names;
  } catch {
    return [];
  }
}

/**
 * 本アプリ以外の保存データを列挙する。
 * 同じオリジンに同居している他アプリのものなので、消す前にユーザへ見せる。
 */
export async function listForeignData(): Promise<ForeignData> {
  const databases: string[] = [];
  if (typeof indexedDB.databases === "function") {
    try {
      for (const info of await indexedDB.databases()) {
        if (info.name && info.name !== DB_NAME) databases.push(info.name);
      }
    } catch {
      // 列挙できない環境(Firefox 等)では空扱い
    }
  }
  // OPFS は本アプリが使っていないため、見つかるものはすべて他アプリのもの
  return { databases, opfsEntries: await listOpfsEntries() };
}

/**
 * 保存データを消す。
 * scope="app"    … 本アプリの IndexedDB のみ(既定・安全)
 * scope="origin" … 同じオリジンの全 IndexedDB と OPFS も消す(他アプリを巻き込む)
 *
 * 設定(localStorage の API キー等)とローカル埋め込みモデルの Cache Storage は
 * どちらの場合も対象外。
 */
export async function wipeStoredData(scope: WipeScope = "app"): Promise<WipeReport> {
  const report: WipeReport = { deletedDatabases: [], deletedOpfsEntries: [], errors: [] };

  // 自分が掴んだままだと deleteDatabase がブロックされる。開けていなくても close は安全
  try {
    db.close();
  } catch {
    // 開いていなければ何もしなくてよい
  }

  const targets = [DB_NAME];
  if (scope === "origin") {
    targets.push(...(await listForeignData()).databases);
  }

  for (const name of targets) {
    try {
      const result = await deleteDatabase(name);
      if (result === "deleted") {
        report.deletedDatabases.push(name);
      } else {
        report.errors.push(
          `"${name}" は他のタブが使用中のため削除できませんでした。全てのタブを閉じて再実行してください。`,
        );
      }
    } catch (e) {
      report.errors.push(`"${name}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (scope === "origin" && navigator.storage?.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      for (const name of await listOpfsEntries()) {
        try {
          await root.removeEntry(name, { recursive: true });
          report.deletedOpfsEntries.push(name);
        } catch (e) {
          report.errors.push(`OPFS "${name}": ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      report.errors.push(`OPFS: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return report;
}
