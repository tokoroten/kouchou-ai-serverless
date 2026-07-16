import { create } from "zustand";
import type { ProgressEvent } from "../lib/pipeline/context";
import { runPipeline } from "../lib/pipeline/orchestrator";
import { dexieCheckpoints, dexieStepStore } from "../lib/storage/checkpoints";
import { db } from "../lib/storage/db";
import type { PipelineStepName, Project, TokenUsage } from "../types/project";
import type { Result } from "../types/result";

// パイプライン実行の管理(モジュールシングルトン + zustand)。
// 画面遷移しても実行は継続し、進捗はストア経由で購読する。

export type RunnerState = {
  runningProjectId: string | null;
  currentStep: PipelineStepName | null;
  progress: Record<string, ProgressEvent>;
  usage: TokenUsage;
  startedAt: number | null;
  error: string | null;
  intermediateCoords: { x: Float32Array; y: Float32Array } | null;
};

type RunnerStore = RunnerState & {
  start: (project: Project) => Promise<void>;
  abort: () => void;
};

let abortController: AbortController | null = null;

export const useRunner = create<RunnerStore>((set, get) => ({
  runningProjectId: null,
  currentStep: null,
  progress: {},
  usage: { input: 0, output: 0, total: 0 },
  startedAt: null,
  error: null,
  intermediateCoords: null,

  abort: () => {
    abortController?.abort();
  },

  start: async (project: Project) => {
    if (get().runningProjectId) return; // 二重実行防止
    abortController = new AbortController();
    set({
      runningProjectId: project.id,
      currentStep: null,
      progress: {},
      usage: { input: 0, output: 0, total: 0 },
      startedAt: Date.now(),
      error: null,
      intermediateCoords: null,
    });
    await db.projects.update(project.id, { status: "running", errorMessage: undefined });

    try {
      const result: Result = await runPipeline(project, {
        ctx: {
          chat: project.settingsSnapshot.chat,
          embedding: project.settingsSnapshot.embedding,
          concurrency: project.settingsSnapshot.concurrency,
          signal: abortController.signal,
          checkpoints: dexieCheckpoints(project.id),
          onProgress: (event) => {
            set((state) => ({ progress: { ...state.progress, [event.step]: event } }));
          },
          onUsage: (u) => {
            set((state) => ({
              usage: {
                input: state.usage.input + u.input,
                output: state.usage.output + u.output,
                total: state.usage.total + u.total,
              },
            }));
            const usage = get().usage;
            void db.projects.update(project.id, { tokenUsage: usage });
          },
        },
        store: dexieStepStore(project.id),
        onStepChange: (step) => {
          set({ currentStep: step });
          void db.projects.update(project.id, { currentStep: step });
        },
        clusteringExtra: {
          onCoords: (x, y) => set({ intermediateCoords: { x, y } }),
        },
      });

      // レポート保存
      const reportId = project.reportId ?? crypto.randomUUID();
      await db.reports.put({ id: reportId, title: project.title, createdAt: Date.now(), result });
      await db.projects.update(project.id, { status: "done", reportId, currentStep: null });
      set({ runningProjectId: null, currentStep: null });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        await db.projects.update(project.id, { status: "paused" });
        set({ runningProjectId: null, error: null });
      } else {
        const message = e instanceof Error ? e.message : String(e);
        await db.projects.update(project.id, { status: "error", errorMessage: message });
        set({ runningProjectId: null, error: message });
      }
    } finally {
      abortController = null;
    }
  },
}));
