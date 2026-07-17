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
let releaseLock: (() => void) | null = null;

// 実行中はどの画面にいてもタブ閉じ警告を出す(閉じてもチェックポイントから再開はできる)
const onBeforeUnload = (e: BeforeUnloadEvent) => {
  e.preventDefault();
};

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
    if (get().runningProjectId) return; // 同一タブ内の二重実行防止

    // タブ間の二重実行防止(Web Locks)。同じプロジェクトを別タブで同時に走らせると
    // IndexedDB のチェックポイントを競合更新するため、ロックが取れなければ実行しない。
    if (navigator.locks) {
      const granted = await new Promise<boolean>((resolve) => {
        let release: (() => void) | null = null;
        navigator.locks
          .request(`kouchou-run-${project.id}`, { ifAvailable: true }, async (lock) => {
            if (!lock) {
              resolve(false);
              return;
            }
            resolve(true);
            // 実行終了までロックを保持する
            await new Promise<void>((r) => {
              release = r;
            });
          })
          .catch(() => resolve(true)); // ロック API の失敗時は実行を優先
        releaseLock = () => release?.();
      });
      if (!granted) {
        set({ error: "このプロジェクトは別のタブで実行中です。そちらのタブを閉じるか完了を待ってください。" });
        return;
      }
    }

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
    window.addEventListener("beforeunload", onBeforeUnload);

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

      // レポート保存(累積トークン実績とモデルも記録し、一覧でコスト表示できるようにする)
      const reportId = project.reportId ?? crypto.randomUUID();
      const latestProject = await db.projects.get(project.id);
      await db.reports.put({
        id: reportId,
        title: project.title,
        createdAt: Date.now(),
        result,
        tokenUsage: latestProject?.tokenUsage ?? get().usage,
        chatModel: project.settingsSnapshot.chat.model,
      });
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
      window.removeEventListener("beforeunload", onBeforeUnload);
      releaseLock?.();
      releaseLock = null;
    }
  },
}));
