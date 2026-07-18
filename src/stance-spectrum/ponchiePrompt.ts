import { STANCE_LABEL_JA } from "./labelTemplate";
import type { StanceKey } from "./types";

// 賛否スペクトラム分析のポンチ絵プロンプト構築。
// 通常レポート版(lib/imageGen の buildPonchiePrompt)と違い、クラスタは固定分類では
// なく「現在のビュー」なので、いま画面に出ているクラスタ構成(ラベル・件数・賛否の
// 内訳)から組み立てる。賛否の対立構図を絵の主役にする。

/** プロンプト上限(DALL·E 系 4000 字)。こちら側で必ず収める */
const MAX_PROMPT_CHARS = 3800;
/** 並べるクラスタの上限。多すぎると絵が散漫になる */
const MAX_CLUSTERS = 10;
/** 賛否内訳として書く上位スタンス数 */
const MAX_STANCES_PER_CLUSTER = 3;

export type StancePonchieCluster = {
  /** テンプレートまたは LLM 生成のラベル */
  label: string;
  /** LLM 生成の説明(あれば優先的に文脈へ入れる) */
  description?: string;
  size: number;
  stanceMix: Partial<Record<StanceKey | "unknown", number>>;
};

/**
 * stanceMix を「明確な賛成 12 / 条件付き反対 8」のような日本語内訳にする。
 * 区切りはラベル自体に「・」を含むもの(中立・保留)があるため " / " を使う。
 */
export function formatStanceMix(mix: StancePonchieCluster["stanceMix"]): string {
  const entries = Object.entries(mix)
    .filter(([, count]) => (count ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, MAX_STANCES_PER_CLUSTER);
  return entries.map(([key, count]) => `${STANCE_LABEL_JA[key as StanceKey | "unknown"] ?? key} ${count}`).join(" / ");
}

export function buildStancePonchiePrompt(title: string, clusters: readonly StancePonchieCluster[]): string {
  const top = [...clusters].sort((a, b) => b.size - a.size).slice(0, MAX_CLUSTERS);

  const clusterLines = top.map((cluster) => {
    const mix = formatStanceMix(cluster.stanceMix);
    const desc = cluster.description ? ` — ${cluster.description}` : "";
    return `- ${cluster.label}(${cluster.size}件${mix ? ` / ${mix}` : ""})${desc}`;
  });

  const lines = [
    "以下の意見分析について、「どの論点で賛否がどう分かれているか」が一目で伝わる、",
    "シンプルで明快なポンチ絵(概念図)を日本語のテキストラベル付きで描いてください。",
    "",
    `タイトル: ${title || "賛否スペクトラム分析"}`,
    clusterLines.length > 0 ? "意見グループ(件数と賛否の内訳):" : "",
    ...clusterLines,
    "",
    "スタイル: 日本の官公庁・企業のプレゼン資料風のフラットデザイン。",
    "賛成側と反対側を左右に対置し、中立・条件付きの立場は中央に置く。",
    "アイコンと短いラベルを組み合わせた整理された図解。背景は白または薄いグレー。",
    "矢印や区切り線で立場の関係を示す。写真的表現は使わない。",
  ].filter(Boolean);

  const prompt = lines.join("\n");
  return prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS - 1)}…` : prompt;
}
