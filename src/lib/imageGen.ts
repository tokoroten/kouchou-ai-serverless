import type { Result } from "../types/result";
import type { EndpointConfig } from "../types/settings";
import { getReportImage, putReportImage } from "./storage/db";

// ポンチ絵(概念図)の生成。
// レポートの争点をひと目で掴める挿絵を、images/generations 互換 API で作る。
//
// 保存先は IndexedDB(reportImages テーブル)。レポート本体と同じ DB に置くことで、
// レポート削除と同一トランザクションで消せる(deleteReportWithImage)。

/**
 * DALL·E 3 のプロンプト上限は 4000 文字。上限を超えると 400 が返るだけで
 * 何が悪いのか分からないため、こちら側で必ず収める。
 * gpt-image-1 の上限はより長いが、短い方に合わせておけば両対応になる。
 */
const MAX_PROMPT_CHARS = 3800;
/** 主題として並べるクラスタラベルの上限。多すぎると絵が散漫になる */
const MAX_TOPIC_LABELS = 12;
const MAX_OVERVIEW_CHARS = 300;

/** レポートの内容からポンチ絵用の画像生成プロンプトを構築する */
export function buildPonchiePrompt(result: Result): string {
  const clusters = result.clusters ?? [];
  const levels = clusters.map((c) => c.level).filter((l) => l > 0);
  // 争点は粒度の粗い第1階層の方が掴みやすい。最深だと細かすぎて絵にならない。
  const targetLevel = levels.length > 0 ? Math.min(...levels) : 1;
  const topClusters = clusters
    .filter((c) => c.level === targetLevel)
    // 件数の多い(=主要な)グループを優先する
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, MAX_TOPIC_LABELS);
  const topicLabels = topClusters
    .map((c) => c.label)
    .filter(Boolean)
    .join("、");

  const title = result.config?.name || "広聴AIレポート";
  const overview = result.overview ? result.overview.slice(0, MAX_OVERVIEW_CHARS) : "";

  const lines = [
    "以下のパブリックコメント分析レポートの「何が争点か」が一目で伝わる、",
    "シンプルで明快なポンチ絵(概念図)を日本語のテキストラベル付きで描いてください。",
    "",
    `タイトル: ${title}`,
    overview ? `概要: ${overview}` : "",
    topicLabels ? `主な論点: ${topicLabels}` : "",
    "",
    "スタイル: 日本の官公庁・企業のプレゼン資料風のフラットデザイン。",
    "アイコンと短いラベルを組み合わせた整理された図解。背景は白または薄いグレー。",
    "対立する立場は左右に配置し、矢印や区切り線で関係を示す。写真的表現は使わない。",
  ].filter(Boolean);

  const prompt = lines.join("\n");
  return prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS - 1)}…` : prompt;
}

export type GenerateImageOptions = {
  /** 生成サイズ。既定 1024x1024 */
  size?: string;
  signal?: AbortSignal;
};

/** images/generations で画像を生成し、PNG の Blob を返す */
export async function generateImage(
  endpoint: EndpointConfig,
  prompt: string,
  options: GenerateImageOptions = {},
): Promise<Blob> {
  if (!endpoint.baseUrl) throw new Error("画像生成プロバイダが設定されていません。設定画面で選択してください。");
  const url = `${endpoint.baseUrl.replace(/\/$/, "")}/images/generations`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (endpoint.apiKey) {
    if (endpoint.authHeader === "api-key") headers["api-key"] = endpoint.apiKey;
    else headers.Authorization = `Bearer ${endpoint.apiKey}`;
  }
  if (endpoint.extraHeaders) Object.assign(headers, endpoint.extraHeaders);

  // response_format の要否はモデルと API の世代で異なる:
  // gpt-image 系は常に base64 を返しパラメータ自体を拒否、旧 dall-e-3 は既定が
  // URL なので b64_json の明示が必要だった。現行 API では dall-e-3 でも拒否される
  // ことを実環境で確認済み。モデル名で出し分けるのは API が変わるたびに壊れる
  // ため、まず送ってみて「response_format が原因の 400」なら外して1回だけ
  // 再試行する(自己修復)。応答が URL 形式でも取得できるようにしてある。
  let includeResponseFormat = !endpoint.model.startsWith("gpt-image");

  for (let attempt = 0; ; attempt++) {
    const body: Record<string, unknown> = {
      model: endpoint.model,
      prompt,
      n: 1,
      size: options.size ?? "1024x1024",
      ...(includeResponseFormat ? { response_format: "b64_json" } : {}),
    };

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: options.signal });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (includeResponseFormat && res.status === 400 && text.includes("response_format") && attempt === 0) {
        includeResponseFormat = false;
        continue;
      }
      // API が返すエラー本文は原因が具体的に書かれていることが多いので、そのまま見せる
      throw new Error(`画像生成に失敗しました (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
    const item = data.data?.[0];

    if (item?.b64_json) {
      const binary = atob(item.b64_json);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: "image/png" });
    }

    // b64 を要求できなかった(または無視された)場合、URL で返るモデルがある
    if (item?.url) {
      const imageRes = await fetch(item.url, { signal: options.signal });
      if (!imageRes.ok) {
        throw new Error(`生成された画像のダウンロードに失敗しました (HTTP ${imageRes.status})`);
      }
      return await imageRes.blob();
    }

    throw new Error("画像生成の応答に画像データ (b64_json / url) が含まれていません。");
  }
}

/** 生成して保存するところまで一括で行う */
export async function generateAndSavePonchie(
  reportId: string,
  result: Result,
  endpoint: EndpointConfig,
  options: GenerateImageOptions = {},
): Promise<Blob> {
  const prompt = buildPonchiePrompt(result);
  const blob = await generateImage(endpoint, prompt, options);
  await putReportImage({ reportId, blob, prompt, model: endpoint.model, createdAt: Date.now() });
  return blob;
}

/** 保存済みのポンチ絵を取り出す。無ければ null */
export async function loadPonchie(reportId: string): Promise<Blob | null> {
  const row = await getReportImage(reportId);
  return row?.blob ?? null;
}
