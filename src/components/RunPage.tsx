import { useLiveQuery } from "dexie-react-hooks";
import { useEffect } from "react";
import { navigate } from "../lib/router";
import { db } from "../lib/storage/db";
import { useRunner } from "../store/runner";
import { PIPELINE_STEPS, type PipelineStepName } from "../types/project";

// 実行進捗画面(DESIGN §7-4)。
// ステップごとのプログレスバー、処理件数、累計トークン、経過時間、中止/再開。

const STEP_LABELS: Record<PipelineStepName, string> = {
  extraction: "意見抽出 (extraction)",
  embedding: "ベクトル化 (embedding)",
  clustering: "クラスタリング",
  initial_labelling: "初期ラベリング",
  merge_labelling: "統合ラベリング",
  overview: "全体概要",
  aggregation: "レポート生成",
};

export function RunPage({ projectId }: { projectId: string }) {
  const project = useLiveQuery(() => db.projects.get(projectId), [projectId]);
  const runner = useRunner();
  const isRunning = runner.runningProjectId === projectId;

  // 処理中のタブ閉じ警告(閉じても再開はできる)
  useEffect(() => {
    if (!isRunning) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isRunning]);

  if (!project) return <p>読み込み中...</p>;

  const elapsed = isRunning && runner.startedAt ? Math.floor((Date.now() - runner.startedAt) / 1000) : null;

  return (
    <div>
      <h1>{project.title} — 実行</h1>
      <p className="note">
        コメント {project.comments.length.toLocaleString()} 件 / モデル: {project.settingsSnapshot.chat.model} +{" "}
        {project.settingsSnapshot.embedding.model}
      </p>

      {(runner.error || project.errorMessage) && !isRunning && (
        <div className="error-box">
          エラー: {runner.error ?? project.errorMessage}
          {"\n"}処理済みの部分はブラウザに保存されています。「再開」で未処理分のみ実行されます。
        </div>
      )}

      <div className="card">
        {PIPELINE_STEPS.map((step) => {
          const progress = isRunning ? runner.progress[step] : undefined;
          const isCurrent = isRunning && runner.currentStep === step;
          const stepIndex = PIPELINE_STEPS.indexOf(step);
          const currentIndex = runner.currentStep ? PIPELINE_STEPS.indexOf(runner.currentStep) : -1;
          const isDone =
            project.status === "done" ||
            (isRunning && currentIndex > stepIndex) ||
            (progress && progress.total > 0 && progress.done >= progress.total);
          const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
          return (
            <div className="step-row" key={step}>
              <span className="step-name">
                {isDone ? "✅" : isCurrent ? "⏳" : "・"} {STEP_LABELS[step]}
              </span>
              <div className="progress-bar">
                <div style={{ width: `${isDone ? 100 : percent}%` }} />
              </div>
              <span className="step-status">
                {progress && progress.total > 0
                  ? `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}${progress.message ? ` (${progress.message})` : ""}`
                  : isDone
                    ? "完了"
                    : ""}
              </span>
            </div>
          );
        })}
      </div>

      <div className="card">
        <div className="row">
          <span>
            累計トークン: 入力 {(isRunning ? runner.usage : project.tokenUsage).input.toLocaleString()} / 出力{" "}
            {(isRunning ? runner.usage : project.tokenUsage).output.toLocaleString()}
          </span>
          {elapsed !== null && (
            <span>
              経過時間: {Math.floor(elapsed / 60)}分{elapsed % 60}秒
            </span>
          )}
        </div>
      </div>

      <div className="row">
        {!isRunning && project.status !== "done" && (
          <button type="button" className="primary" onClick={() => runner.start(project)}>
            {project.status === "created" ? "実行開始" : "再開"}
          </button>
        )}
        {isRunning && (
          <button type="button" className="danger" onClick={() => runner.abort()}>
            中止(途中経過は保存されます)
          </button>
        )}
        {project.status === "done" && project.reportId && (
          <button type="button" className="primary" onClick={() => navigate(`/report/${project.reportId}`)}>
            レポートを開く
          </button>
        )}
        <button type="button" onClick={() => navigate("/")}>
          一覧へ戻る
        </button>
      </div>
      <p className="note">
        処理中にタブを閉じても、途中経過(コメント単位・バッチ単位)は IndexedDB
        に保存されているため、このページから再開できます。PC をスリープさせないでください。
      </p>
    </div>
  );
}
