import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// GitHub Pages (project pages) では base をリポジトリ名にする必要がある。
// vite preview(command は "serve")もビルド成果物を配信するので同じ base にする。
export default defineConfig(({ command, isPreview }) => ({
  base: command === "build" || isPreview ? "/kouchou-ai-serverless/" : "/",
  plugins: [react()],
  worker: {
    format: "es" as const,
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 6000,
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
}));
