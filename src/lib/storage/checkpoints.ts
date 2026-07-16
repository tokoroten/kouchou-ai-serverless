import type { PipelineStepName } from "../../types/project";
import type { Checkpoints } from "../pipeline/context";
import type { StepStore } from "../pipeline/orchestrator";
import { db } from "./db";

// Dexie(IndexedDB)を使ったチェックポイント/ステップ結果ストアの実装。

export function dexieCheckpoints(projectId: string): Checkpoints {
  return {
    async getExtraction(commentId) {
      const row = await db.extractionCache.get([projectId, commentId]);
      return row?.args;
    },
    async putExtraction(commentId, args) {
      await db.extractionCache.put({ projectId, commentId, args });
    },
    async getChunk(step, key) {
      const row = await db.chunkCache.get([projectId, step, key]);
      return row?.data;
    },
    async putChunk(step, key, data) {
      await db.chunkCache.put({ projectId, step, key, data });
    },
  };
}

export function dexieStepStore(projectId: string): StepStore {
  return {
    async get(step: PipelineStepName) {
      const row = await db.stepResults.get([projectId, step]);
      return row?.data;
    },
    async put(step: PipelineStepName, data) {
      await db.stepResults.put({ projectId, step, data, completedAt: Date.now() });
    },
  };
}
