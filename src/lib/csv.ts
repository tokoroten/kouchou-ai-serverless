import Papa from "papaparse";
import type { CommentRow } from "../types/project";

export type CsvPreview = {
  columns: string[];
  rows: Record<string, string>[]; // 全行(文字列化済み)
  totalRows: number;
};

/**
 * CSV ファイルをパースする。ヘッダ付き前提。
 * エンコーディングは UTF-8 を既定とし、Shift_JIS 指定にも対応する。
 */
export function parseCsvFile(file: File, encoding: "UTF-8" | "Shift_JIS" = "UTF-8"): Promise<CsvPreview> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      encoding: encoding === "Shift_JIS" ? "Shift_JIS" : "UTF-8",
      complete: (results) => {
        const columns = results.meta.fields ?? [];
        resolve({
          columns,
          rows: results.data,
          totalRows: results.data.length,
        });
      },
      error: (error) => reject(error),
    });
  });
}

/**
 * パース済み CSV 行を CommentRow に正規化する。
 * - comment-body が空・空白のみの行は除外する(本家 #583 と同じ)
 * - comment-id 列がなければ行番号を振る
 */
export function normalizeComments(
  rows: Record<string, string>[],
  bodyColumn: string,
  idColumn: string | null,
  attributeColumns: string[],
): CommentRow[] {
  const result: CommentRow[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const body = (row[bodyColumn] ?? "").trim();
    if (body === "") continue;
    let commentId = idColumn ? String(row[idColumn] ?? "").trim() : String(i);
    if (commentId === "" || seenIds.has(commentId)) commentId = `${commentId || "row"}_${i}`;
    seenIds.add(commentId);
    const attributes: Record<string, string> = {};
    for (const col of attributeColumns) {
      attributes[col] = row[col] ?? "";
    }
    result.push({ commentId, body, attributes });
  }
  return result;
}
