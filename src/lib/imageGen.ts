import type { Result } from "../types/result";
import type { EndpointConfig } from "../types/settings";

// ポンチ絵(概念図)の画像生成。
// 1. レポートの概要とクラスタラベルから画像生成プロンプトを構築する。
// 2. OpenAI images/generations エンドポイント経由で画像を生成する。
// 3. 生成した画像を OPFS(Origin Private File System)に保存/読み込みする。

// OPFS のディレクトリ名
const OPFS_DIR = "ponchie";

/** レポートの内容からポンチ絵用の画像生成プロンプトを構築する */
export function buildPonchiePrompt(result: Result): string {
  const maxLevel = Math.max(...result.clusters.map((c) => c.level).filter((l) => l > 0), 1);
  const topClusters = result.clusters.filter((c) => c.level === maxLevel);
  const topicLabels = topClusters.map((c) => c.label).join("、");
  const title = result.config?.name ?? "広聴AIレポート";
  const overview = result.overview ? result.overview.slice(0, 300) : "";

  return [
    `以下のパブリックコンサルテーションレポートの内容を視覚的にわかりやすく表現した、`,
    `シンプルで明快なポンチ絵(概念図/インフォグラフィック)を日本語テキスト付きで生成してください。`,
    ``,
    `タイトル: ${title}`,
    overview ? `概要: ${overview}` : "",
    `主なテーマ: ${topicLabels}`,
    ``,
    `スタイル: 日本の官公庁・企業向けプレゼンテーション資料風。`,
    `フラットデザイン、アイコンとテキストラベルを組み合わせた整理された図解。`,
    `背景は白または薄いグレー。明確な矢印や区切り線でテーマ間の関係を示す。`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** OpenAI images/generations エンドポイントで画像を生成し、PNG の Blob を返す */
export async function generateImage(endpoint: EndpointConfig, prompt: string, signal?: AbortSignal): Promise<Blob> {
  const url = `${endpoint.baseUrl.replace(/\/$/, "")}/images/generations`;
  const body = {
    model: endpoint.model || "dall-e-3",
    prompt,
    n: 1,
    size: "1024x1024",
    response_format: "b64_json",
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (endpoint.apiKey) {
    if (endpoint.authHeader === "api-key") {
      headers["api-key"] = endpoint.apiKey;
    } else {
      headers.Authorization = `Bearer ${endpoint.apiKey}`;
    }
  }
  if (endpoint.extraHeaders) Object.assign(headers, endpoint.extraHeaders);

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`画像生成に失敗しました: HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("画像生成の応答に b64_json がありません");

  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: "image/png" });
}

/** OPFS にポンチ絵画像を保存する */
export async function savePonchieToOpfs(reportId: string, imageBlob: Blob): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
  const fileName = `${reportId}.png`;
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(imageBlob);
  } finally {
    await writable.close();
  }
}

/** OPFS からポンチ絵画像を読み込む。存在しなければ null を返す */
export async function loadPonchieFromOpfs(reportId: string): Promise<Blob | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: false });
    const fileHandle = await dir.getFileHandle(`${reportId}.png`, { create: false });
    return await fileHandle.getFile();
  } catch {
    // ファイルが存在しない場合など
    return null;
  }
}

/** OPFS のポンチ絵画像を削除する */
export async function deletePonchieFromOpfs(reportId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: false });
    await dir.removeEntry(`${reportId}.png`);
  } catch {
    // 存在しない場合は無視
  }
}
