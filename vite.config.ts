import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// GitHub Pages (project pages) では base をリポジトリ名にする必要がある
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/kouchou-ai-serverless/" : "/",
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
