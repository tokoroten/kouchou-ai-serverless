import { rename } from "node:fs/promises";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// 単一HTMLレポートのテンプレートをビルドする設定。
// viewer.html(ビューア単体エントリ)を JS/CSS 込みの1ファイルに固めて
// public/report-template.html として出力し、本体ビルド時に静的アセットとして同梱する。
// エクスポート時にこのテンプレートへ Result JSON を差し込む(src/lib/export.ts)。
export default defineConfig({
  plugins: [
    react(),
    viteSingleFile(),
    {
      name: "rename-to-report-template",
      closeBundle: async () => {
        await rename("public/viewer.html", "public/report-template.html");
      },
    },
  ],
  build: {
    outDir: "public",
    emptyOutDir: false,
    rollupOptions: {
      input: "viewer.html",
    },
    chunkSizeWarningLimit: 10000,
  },
});
