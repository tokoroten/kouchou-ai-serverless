/** APIキー不要。pnpm build と pnpm dev --port 5174 の後に node scripts/viewer-states-e2e.ts */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const browser = await chromium.launch();
const dir = await mkdtemp(join(tmpdir(), "viewer-e2e-"));
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${process.env.VIEWER_TEST_URL ?? "http://localhost:5174"}/#/dev/viewer-states`);
  await page.getByRole("button", { name: "階層リスト", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "階層リスト", exact: true }).getAttribute("class"), "active");
  for (const state of ["属性なし", "空の意見", "通常"]) {
    await page.getByRole("combobox", { name: "状態" }).selectOption(state);
    await page.getByRole("button", { name: "階層リスト", exact: true }).waitFor();
  }
  await page.getByRole("button", { name: "散布図", exact: true }).click();
  await page.locator(".js-plotly-plot").waitFor();
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await page.getByRole("button", { name: "散布図", exact: true }).getAttribute("class"), "active");
  await page.reload();
  await page.locator(".js-plotly-plot").waitFor();
  const template = await readFile("public/report-template.html", "utf8");
  const data = await readFile("src/components/dev/viewer-fixture.json", "utf8");
  const html = template.replace(
    /(<script[^>]*id="report-data"[^>]*>)[\s\S]*?(<\/script>)/,
    (_all, start, end) => start + data.replaceAll("<", "\\u003c") + end,
  );
  assert.notEqual(html, template);
  const file = join(dir, "report.html");
  await writeFile(file, html);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(pathToFileURL(file).href);
  await page.getByRole("button", { name: "階層リスト", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "階層リスト", exact: true }).getAttribute("class"), "active");
  await page.getByRole("button", { name: "散布図", exact: true }).click();
  await page.locator(".js-plotly-plot").waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS: 状態切替、スマホ初期表示、リサイズ、単一HTML file://表示（API通信なし）");
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}
