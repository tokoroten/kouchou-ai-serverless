import type { CommentRow, EmbeddingResult, ExtractionResult } from "../types/project";
import type { Result } from "../types/result";

// レポートのエクスポート(DESIGN §7.1)。
// 1. Result JSON(本家互換) 2. 単一HTMLレポート 3. CSV
// + 前処理済み中間データ(意見分解+ベクトル化)のエクスポート/インポート

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportResultJson(result: Result): void {
  const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
  downloadBlob(blob, "hierarchical_result.json");
}

/** Result JSON のインポート(本家産含む)。最低限のスキーマ検証を行う。 */
export function parseResultJson(text: string): Result {
  const obj = JSON.parse(text);
  if (!obj || typeof obj !== "object") throw new Error("JSON がオブジェクトではありません");
  if (!Array.isArray(obj.arguments) || !Array.isArray(obj.clusters)) {
    throw new Error("Result JSON ではありません(arguments / clusters がない)");
  }
  if (typeof obj.overview !== "string") obj.overview = "";
  if (!obj.comments || typeof obj.comments !== "object") obj.comments = {};
  if (!obj.propertyMap) obj.propertyMap = {};
  if (!obj.translations) obj.translations = {};
  if (typeof obj.comment_num !== "number") obj.comment_num = Object.keys(obj.comments).length;
  return obj as Result;
}

function csvEscape(value: string | number): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows: (string | number)[][]): string {
  // Excel での文字化け防止に BOM を付ける
  return `﻿${rows.map((row) => row.map(csvEscape).join(",")).join("\r\n")}`;
}

/** 意見一覧 CSV(DESIGN §7.1-3) */
export function exportArgumentsCsv(result: Result): void {
  const levels = [...new Set(result.clusters.filter((c) => c.level > 0).map((c) => c.level))].sort((a, b) => a - b);
  const labelById = new Map(result.clusters.map((c) => [c.id, c.label]));
  const header = [
    "arg-id",
    "argument",
    "comment-id",
    "x",
    "y",
    ...levels.flatMap((level) => [`cluster-level-${level}-id`, `cluster-level-${level}-label`]),
  ];
  const rows: (string | number)[][] = [header];
  for (const arg of result.arguments) {
    const byLevel = new Map<number, string>();
    for (const clusterId of arg.cluster_ids) {
      const cluster = result.clusters.find((c) => c.id === clusterId);
      if (cluster && cluster.level > 0) byLevel.set(cluster.level, clusterId);
    }
    rows.push([
      arg.arg_id,
      arg.argument,
      arg.comment_id,
      arg.x,
      arg.y,
      ...levels.flatMap((level) => {
        const id = byLevel.get(level) ?? "";
        return [id, id ? (labelById.get(id) ?? "") : ""];
      }),
    ]);
  }
  downloadBlob(new Blob([toCsv(rows)], { type: "text/csv" }), "arguments.csv");
}

/** クラスタ一覧 CSV */
export function exportClustersCsv(result: Result): void {
  const rows: (string | number)[][] = [["level", "id", "label", "takeaway", "value", "parent"]];
  for (const cluster of result.clusters) {
    rows.push([cluster.level, cluster.id, cluster.label, cluster.takeaway, cluster.value, cluster.parent]);
  }
  downloadBlob(new Blob([toCsv(rows)], { type: "text/csv" }), "clusters.csv");
}

/** 単一 HTML に同梱するポンチ絵(画像は data URL 化して埋め込む) */
export type PonchieExport = { dataUrl: string; model: string; createdAt: number; prompt?: string };

/**
 * テンプレートの <script type="application/json" id="..."> タグへ JSON を差し込む。
 * required=false のタグは、古いテンプレートに存在しなくてもエクスポートを止めない。
 */
export function injectJsonTag(template: string, id: string, value: unknown, { required = true } = {}): string {
  // </script> でタグが閉じないようエスケープして埋め込む
  const json = JSON.stringify(value).replace(/</g, "\\u003c");
  const marker = `<script type="application/json" id="${id}">`;
  const start = template.indexOf(marker);
  if (start === -1) {
    if (required) throw new Error(`テンプレートに ${id} タグがありません`);
    return template;
  }
  const end = template.indexOf("</script>", start);
  if (end === -1) throw new Error(`テンプレートの ${id} タグが閉じていません`);
  return template.slice(0, start + marker.length) + json + template.slice(end);
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("画像の読み込みに失敗しました"));
    reader.readAsDataURL(blob);
  });
}

/**
 * 単一 HTML レポート(DESIGN §7.1-2)。
 * ビルド時に生成したビューア単体テンプレート(report-template.html)を取得し、
 * report-data スクリプトタグへ Result JSON を差し込む。ポンチ絵があれば
 * ponchie-data タグへ data URL 込みで同梱する(タグの無い古いテンプレートでは黙って省く)。
 */
export async function exportSingleHtml(result: Result, ponchie: PonchieExport | null = null): Promise<void> {
  const response = await fetch(`${import.meta.env.BASE_URL}report-template.html`);
  if (!response.ok) throw new Error("レポートテンプレートの取得に失敗しました");
  const template = await response.text();
  let html = injectJsonTag(template, "report-data", result);
  if (ponchie) html = injectJsonTag(html, "ponchie-data", ponchie, { required: false });
  const title = result.config?.name ?? "report";
  downloadBlob(new Blob([html], { type: "text/html" }), `${title}.html`);
}

// ---- 前処理済みプロジェクトデータ(意見分解+ベクトル化)の入出力 ----
// 一番コストがかかる前処理の結果を元データごと持ち出し、別ブラウザ/セッションで
// ポストプロセス(クラスタリング以降)だけをやり直せるようにする。

export type ProjectMeta = {
  title: string;
  question: string;
  intro: string;
  comments: CommentRow[];
  attributeColumns: string[];
  clusterNums: number[];
  samplingNum: number;
  prompts: { extraction: string; initialLabelling: string; mergeLabelling: string; overview: string };
};

export type PreprocessedData = {
  formatVersion: 2;
  type: "kouchou-ai-preprocessed";
  project: ProjectMeta;
  extraction: ExtractionResult;
  embedding: {
    argIds: string[];
    dim: number;
    vectorsBase64: string;
  };
};

export function serializePreprocessed(
  project: ProjectMeta,
  extraction: ExtractionResult,
  embedding: EmbeddingResult,
): string {
  const bytes = new Uint8Array(embedding.vectors.buffer, embedding.vectors.byteOffset, embedding.vectors.byteLength);
  const data: PreprocessedData = {
    formatVersion: 2,
    type: "kouchou-ai-preprocessed",
    project,
    extraction,
    embedding: {
      argIds: embedding.argIds,
      dim: embedding.dim,
      vectorsBase64: bytesToBase64(bytes),
    },
  };
  return JSON.stringify(data);
}

export function exportPreprocessed(
  project: ProjectMeta,
  extraction: ExtractionResult,
  embedding: EmbeddingResult,
): void {
  const blob = new Blob([serializePreprocessed(project, extraction, embedding)], { type: "application/json" });
  downloadBlob(blob, `${project.title}.preprocessed.json`);
}

export function parsePreprocessed(text: string): {
  project: ProjectMeta;
  extraction: ExtractionResult;
  embedding: EmbeddingResult;
} {
  const data = JSON.parse(text) as PreprocessedData;
  if (data.type !== "kouchou-ai-preprocessed") throw new Error("前処理データのファイルではありません");
  if (!data.project || !data.extraction || !data.embedding) throw new Error("前処理データが不完全です");
  const bytes = base64ToBytes(data.embedding.vectorsBase64);
  const vectors = new Float32Array(bytes.buffer, 0, bytes.byteLength / 4);
  return {
    project: data.project,
    extraction: data.extraction,
    embedding: { argIds: data.embedding.argIds, dim: data.embedding.dim, vectors },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
