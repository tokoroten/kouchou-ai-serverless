import { parseResultJson } from "./export";
import { db, putReportImage } from "./storage/db";

// 同梱サンプルレポート(実データで生成した本家互換 JSON)。
// ホームの「サンプルを見る」と、#/report/sample への直リンク(IndexedDB 未登録の
// ブラウザで開いた場合)の両方から呼ぶ。
export const SAMPLE_REPORT_ID = "sample";

export async function importSampleReport(): Promise<void> {
  const response = await fetch(`${import.meta.env.BASE_URL}sample-report.json`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = parseResultJson(await response.text());
  await db.reports.put({
    id: SAMPLE_REPORT_ID,
    title: result.config?.name || "サンプルレポート",
    createdAt: Date.now(),
    result,
  });
  // 同梱のポンチ絵(gpt-image-2 で事前生成)も取り込む。API キーなしで
  // ポンチ絵つきのレポートを体験できるようにするため。無ければ黙ってスキップ
  try {
    const imageResponse = await fetch(`${import.meta.env.BASE_URL}sample-ponchie.png`);
    if (imageResponse.ok) {
      const { buildPonchiePrompt } = await import("./imageGen");
      await putReportImage({
        reportId: SAMPLE_REPORT_ID,
        blob: await imageResponse.blob(),
        prompt: buildPonchiePrompt(result),
        model: "gpt-image-2",
        createdAt: Date.now(),
      });
    }
  } catch {
    // ポンチ絵はおまけなので、取得失敗でサンプル自体を止めない
  }
}
