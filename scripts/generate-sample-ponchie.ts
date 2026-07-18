import { readFileSync, writeFileSync } from "node:fs";
import { buildPonchiePrompt, generateImage } from "../src/lib/imageGen";
import type { Result } from "../src/types/result";

/**
 * 同梱サンプルレポートのポンチ絵を生成して public/sample-ponchie.png に出力する。
 * HomePage の「サンプルを見る」がこれを取り込み、API キーなしでポンチ絵つきの
 * レポートを体験できるようにする。
 *
 * 実行: npx vite-node scripts/generate-sample-ponchie.ts(要 .env の OPENAI_API_KEY)
 * モデルは gpt-image-2(16 の倍数の任意サイズに対応するため、真の 4:3 で生成できる)。
 */

const MODEL = process.env.PONCHIE_MODEL ?? "gpt-image-2";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const apiKey = /OPENAI_API_KEY\s*=\s*(\S+)/.exec(env)?.[1];
if (!apiKey) throw new Error(".env に OPENAI_API_KEY がありません");

const result = JSON.parse(readFileSync(new URL("../public/sample-report.json", import.meta.url), "utf8")) as Result;
const prompt = buildPonchiePrompt(result);
console.log(`モデル: ${MODEL} / プロンプト ${prompt.length} 文字`);
console.log("生成中(数十秒かかります)...");

const t0 = Date.now();
const blob = await generateImage({ baseUrl: "https://api.openai.com/v1", apiKey, model: MODEL }, prompt);
const bytes = Buffer.from(await blob.arrayBuffer());
writeFileSync(new URL("../public/sample-ponchie.png", import.meta.url), bytes);
console.log(
  `完了: ${Math.round((Date.now() - t0) / 1000)}秒 / ${Math.round(bytes.length / 1024)} KB → public/sample-ponchie.png`,
);
