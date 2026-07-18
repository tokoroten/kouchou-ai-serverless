// 賛否スペクトラム分析が永続化に使うキー(IndexedDB / エクスポートファイル)。
//
// 2026-07-18 のリネーム前は、これらの値はすべて "phase2" を含んでいた。
// 新規に書き込む値は下記の新名称に統一し、既存データは db.ts の
// version(2) マイグレーションで一括変換する。
// LEGACY_* は「マイグレーション対象を見つけるため」と
// 「ユーザの手元にダウンロード済みのファイルを読み込むため」にのみ使う。

/** Project.kind の値。通常版と一覧を分けるための区分 */
export const PROJECT_KIND = "stance-spectrum";
export const LEGACY_PROJECT_KIND = "phase2";

/**
 * チェックポイントの namespace。通常版(projectId 直下)と衝突しないよう隔離する。
 * 実プロジェクトは接尾辞、同梱サンプルは接頭辞という非対称な形だが、
 * 既存データとの対応を保つためリネーム後も形は変えていない。
 */
export const projectNamespace = (projectId: string) => `${projectId}-stance-spectrum`;
export const sampleNamespace = (sampleId: string) => `stance-spectrum-${sampleId}`;
export const legacyProjectNamespace = (projectId: string) => `${projectId}-phase2`;
export const legacySampleNamespace = (sampleId: string) => `phase2-${sampleId}`;

/** chunkCache の step キー(embedding / codebook / umap は通常版と共通なので対象外) */
export const CHUNK_STEP = {
  extract: "stance-spectrum-extract",
  edges: "stance-spectrum-edges",
  explain: "stance-spectrum-explain",
  label: "stance-spectrum-label",
  views: "stance-spectrum-views",
} as const;

/** 旧 step キー → 新 step キー。マイグレーションで参照する */
export const LEGACY_CHUNK_STEP: Record<string, string> = {
  "phase2-extract": CHUNK_STEP.extract,
  "phase2-edges": CHUNK_STEP.edges,
  "phase2-explain": CHUNK_STEP.explain,
  "phase2-label": CHUNK_STEP.label,
  "phase2-views": CHUNK_STEP.views,
};

/**
 * エクスポート/サンプル JSON の識別子。
 * 書き出しは新名称だが、読み込みは旧名称も受理する
 * (ユーザが既にダウンロード済みのファイルは移行できないため)。
 */
export const SAMPLE_FILE_TYPE = "kouchou-ai-stance-spectrum-sample";
export const LEGACY_SAMPLE_FILE_TYPE = "kouchou-ai-phase2-sample";

/** ビューのダウンロードファイル名の拡張子部分 */
export const EXPORT_FILE_SUFFIX = ".stance-spectrum.json";

/**
 * 旧 namespace なら新 namespace を返す。対象外(通常版のデータ等)なら null。
 * db.ts の version(2) マイグレーションが使う。
 */
export function migrateNamespace(projectId: string): string | null {
  const suffix = "-phase2";
  const prefix = "phase2-";
  if (projectId.endsWith(suffix)) return projectNamespace(projectId.slice(0, -suffix.length));
  if (projectId.startsWith(prefix)) return sampleNamespace(projectId.slice(prefix.length));
  return null;
}

/** 旧 step キーなら新 step キーを返す。対象外(embedding / codebook / umap 等)なら null */
export function migrateStep(step: string): string | null {
  return LEGACY_CHUNK_STEP[step] ?? null;
}
