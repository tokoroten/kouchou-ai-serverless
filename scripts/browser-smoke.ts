/**
 * Playwright によるブラウザ実機スモークテスト(開発検証用。CI では実行しない)。
 *   npx vite-node scripts/browser-smoke.ts
 * 前提: pnpm dev が起動していること(PORT 環境変数、既定 5174)、.env に OPENAI_API_KEY。
 * 検証項目:
 *  1. ホーム表示
 *  2. 本家 example-hierarchical-polis JSON のインポート表示(M7 受け入れ基準)
 *  3. 設定画面でプロバイダ登録 → スロット選択 → 疎通確認
 *  4. ウィザードで CSV 取込 → 実行 → レポート表示(実 API・30件)
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = `http://localhost:${process.env.PORT ?? 5174}`;
const EXAMPLE_JSON =
  "e:/GitHub/kouchou-ai/apps/api/broadlistening/pipeline/outputs/example-hierarchical-polis/hierarchical_result.json";

function env(name: string): string {
  const match = readFileSync(".env", "utf-8").match(new RegExp(`^${name}=(.*)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });

  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) errors.push(name);
  };

  // 1. ホーム
  await page.goto(`${BASE}/#/`);
  await page.waitForLoadState("networkidle");
  check(
    "ホーム表示",
    await page
      .locator("h1")
      .first()
      .textContent()
      .then((t) => t?.includes("レポート一覧") ?? false),
  );

  // 2. 本家 JSON インポート(M7 受け入れ基準)
  await page.locator('input[type="file"][accept="application/json"]').setInputFiles(EXAMPLE_JSON);
  await page.waitForURL(/#\/report\//, { timeout: 30000 });
  await page.waitForSelector(".viewer-chart", { timeout: 30000 });
  // Plotly の WebGL 散布図が描画されるまで待つ
  await page.waitForSelector(".viewer-chart canvas, .viewer-chart .plotly", { timeout: 60000 });
  const clusterCards = await page.locator(".cluster-card").count();
  check("本家JSONインポート表示", clusterCards > 0, `クラスタカード ${clusterCards} 件`);
  const overviewText = await page.locator(".viewer-overview").textContent();
  check("本家JSON overview 表示", (overviewText?.length ?? 0) > 50);
  // ツリーマップ切替
  await page.getByRole("button", { name: "ツリーマップ" }).click();
  await page.waitForTimeout(3000);
  check("ツリーマップ描画", (await page.locator(".viewer-chart .treemap, .viewer-chart svg").count()) > 0);
  // 階層リスト切替
  await page.getByRole("button", { name: "階層リスト" }).click();
  await page.waitForTimeout(500);
  check("階層リスト描画", (await page.locator(".hierarchy-list details").count()) > 0);

  // 3. 設定画面
  await page.goto(`${BASE}/#/settings`);
  const openaiKey = env("OPENAI_API_KEY");
  const keyInputs = page.locator('input[type="password"]');
  await keyInputs.first().fill(openaiKey); // 先頭は OpenAI
  // chat スロット
  const chatSelect = page.locator(".card").filter({ hasText: "チャット(" }).locator("select").first();
  await chatSelect.selectOption("openai");
  const embSelect = page.locator(".card").filter({ hasText: "埋め込み(" }).locator("select").first();
  await embSelect.selectOption("openai");
  // 疎通確認
  await page
    .locator(".card")
    .filter({ hasText: "チャット(" })
    .getByRole("button", { name: /接続テスト/ })
    .click();
  await page.waitForFunction(
    () => document.body.textContent?.includes("接続成功") || document.body.textContent?.includes("接続失敗"),
    undefined,
    { timeout: 30000 },
  );
  check("OpenAI 疎通確認", (await page.textContent("body"))?.includes("接続成功") ?? false);

  // 4. ウィザード → 実行 → レポート
  await page.goto(`${BASE}/#/new`);
  await page.locator('input[type="file"]').setInputFiles("testdata/small30.csv");
  await page.waitForSelector("text=有効コメント");
  // 意見本文の列 = reasoning
  await page.locator("select").nth(1).selectOption("reasoning"); // [0]=エンコーディング, [1]=本文列
  // 属性: gender
  await page
    .getByLabel("gender", { exact: true })
    .check()
    .catch(() => {});
  await page.getByRole("button", { name: "次へ" }).click();
  await page.locator('input[placeholder*="生成AI"]').first();
  await page.getByRole("button", { name: "次へ" }).click(); // Step2 → 3
  await page.getByRole("button", { name: "次へ" }).click(); // Step3 → 4
  await page.waitForSelector("text=コスト見積り");
  await page.getByRole("button", { name: /プロジェクトを作成/ }).click();
  await page.waitForURL(/#\/run\//, { timeout: 15000 });
  await page.getByRole("button", { name: "実行開始" }).click();
  console.log("パイプライン実行中(実API、~2分)...");
  await page.getByRole("button", { name: "レポートを開く" }).waitFor({ timeout: 300000 });
  check("ブラウザ内パイプライン完走", true);
  await page.getByRole("button", { name: "レポートを開く" }).click();
  await page.waitForSelector(".viewer-chart", { timeout: 30000 });
  const cards2 = await page.locator(".cluster-card").count();
  check("生成レポート表示", cards2 > 0, `クラスタカード ${cards2} 件`);

  // 属性フィルタ(gender 属性を付けたので出るはず)
  const filterSelects = await page.locator(".viewer .row select").count();
  check("属性フィルタ表示", filterSelects > 0, `フィルタ ${filterSelects} 個`);

  // 単一 HTML エクスポート → ダウンロードした自己完結ファイルを file:// で開いて検証
  const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
  await page.getByRole("button", { name: /単一 HTML/ }).click();
  const download = await downloadPromise;
  const htmlPath = `${process.env.TEMP ?? "."}/kouchou-smoke-report.html`;
  await download.saveAs(htmlPath);
  const standalone = await browser.newPage();
  await standalone.goto(`file:///${htmlPath.replace(/\\/g, "/")}`);
  await standalone.waitForSelector(".viewer-chart canvas, .viewer-chart .plotly", { timeout: 60000 });
  check("単一HTMLレポートがオフラインで開ける", (await standalone.locator(".cluster-card").count()) > 0);
  await standalone.close();

  // リロードして IndexedDB 永続性確認(M2 受け入れ基準)
  await page.reload();
  await page.waitForSelector(".viewer-chart", { timeout: 30000 });
  check("リロード後もレポート表示(IndexedDB)", (await page.locator(".cluster-card").count()) > 0);

  // 前処理データのエクスポート → インポート → 後処理のみ再実行(LLM抽出・埋め込みはスキップ)
  await page.getByRole("button", { name: /リアルタイムモードで再クラスタリング/ }).click();
  await page.getByRole("button", { name: "前処理データをエクスポート" }).waitFor({ timeout: 15000 });
  const preDownloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await page.getByRole("button", { name: "前処理データをエクスポート" }).click();
  const preDownload = await preDownloadPromise;
  const prePath = `${process.env.TEMP ?? "."}/kouchou-smoke.preprocessed.json`;
  await preDownload.saveAs(prePath);
  check("前処理データエクスポート", true);
  await page.goto(`${BASE}/#/`);
  await page.locator('input[type="file"][accept="application/json"]').setInputFiles(prePath);
  await page.waitForURL(/#\/run\//, { timeout: 15000 });
  await page.getByRole("button", { name: "再開" }).click();
  console.log("後処理のみ再実行中(抽出・埋め込みはスキップされるはず)...");
  const resumeStart = Date.now();
  await page.getByRole("button", { name: "レポートを開く" }).waitFor({ timeout: 300000 });
  check("前処理インポート→後処理のみ完走", true, `${Math.round((Date.now() - resumeStart) / 1000)}秒`);

  const relevantPageErrors = pageErrors.filter(
    (e) => !e.includes("favicon") && !e.includes("WebGL") && !e.includes("gpu"),
  );
  if (relevantPageErrors.length > 0) {
    console.log(`\n⚠️ ページエラー ${relevantPageErrors.length} 件:`);
    for (const e of relevantPageErrors.slice(0, 10)) console.log(`  ${e.slice(0, 200)}`);
  }

  await browser.close();
  if (errors.length > 0) {
    console.error(`\n失敗: ${errors.join(", ")}`);
    process.exit(1);
  }
  console.log("\nブラウザスモークテスト 全項目 OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
