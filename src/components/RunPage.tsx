import { useLiveQuery } from "dexie-react-hooks";
import { useMemo } from "react";
import { navigate } from "../lib/router";
import { db } from "../lib/storage/db";
import { useRunner } from "../store/runner";
import { PIPELINE_STEPS, type PipelineStepName } from "../types/project";
import { estimateActualCostUsd as actualCostUsd } from "../types/settings";
import { Plot } from "./viewer/Plot";

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
  // ベクトル化(embedding)が済んでいるかどうか。済んでいない間は
  // 「クラスタリングを再実行」の導線を出さない(embedding 以後を対話再実行する画面のため)
  const hasEmbedding = useLiveQuery(
    () => db.stepResults.where("[projectId+step]").equals([projectId, "embedding"]).count(),
    [projectId],
  );

  // クラスタリング中は UMAP の収束過程をライブ表示する
  const coords = isRunning ? runner.intermediateCoords : null;
  const livePlotData = useMemo(() => {
    if (!coords) return null;
    return [
      {
        x: Array.from(coords.x),
        y: Array.from(coords.y),
        mode: "markers",
        type: "scattergl",
        marker: { size: 4, color: "#3fa9f5", opacity: 0.7 },
        hoverinfo: "skip",
        showlegend: false,
      },
    ];
  }, [coords]);

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

      {livePlotData && runner.currentStep === "clustering" && (
        <div className="card">
          <h2>UMAP 収束過程(ライブ)</h2>
          <div style={{ height: 320 }}>
            <Plot
              data={livePlotData}
              layout={{
                margin: { l: 0, r: 0, b: 0, t: 0 },
                xaxis: { zeroline: false, showticklabels: false, showgrid: false },
                yaxis: { zeroline: false, showticklabels: false, showgrid: false },
                showlegend: false,
              }}
              config={{ displayModeBar: false }}
            />
          </div>
        </div>
      )}

      <div className="card">
        <div className="row">
          <span>
            累計トークン: 入力 {(isRunning ? runner.usage : project.tokenUsage).input.toLocaleString()} / 出力{" "}
            {(isRunning ? runner.usage : project.tokenUsage).output.toLocaleString()}
          </span>
          {(() => {
            const usage = isRunning ? runner.usage : project.tokenUsage;
            const cost = actualCostUsd(
              usage,
              project.settingsSnapshot.chat.model,
              project.settingsSnapshot.chat.serviceTier,
            );
            return cost !== null && usage.total > 0 ? (
              <span>
                概算費用: <b>${cost.toFixed(3)}</b>
                <span className="note">({project.settingsSnapshot.chat.model} 単価)</span>
              </span>
            ) : null;
          })()}
          {elapsed !== null && (
            <span>
              経過時間: {Math.floor(elapsed / 60)}分{elapsed % 60}秒
            </span>
          )}
        </div>
        {project.status === "done" && project.tokenUsage.total > 0 && (
          <p className="note" style={{ marginBottom: 0 }}>
            ✅ レポート作成完了 — 実績 入力 {project.tokenUsage.input.toLocaleString()} / 出力{" "}
            {project.tokenUsage.output.toLocaleString()} トークン
            {(() => {
              const cost = actualCostUsd(
                project.tokenUsage,
                project.settingsSnapshot.chat.model,
                project.settingsSnapshot.chat.serviceTier,
              );
              return cost !== null ? ` ≈ $${cost.toFixed(3)}` : "";
            })()}
          </p>
        )}
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
        {!isRunning && !!hasEmbedding && (
          <button
            type="button"
            onClick={() => navigate(`/interactive/${projectId}`)}
            title="ベクトル化済みデータで UMAP をライブ表示しながらクラスタ数を対話調整(クラスタリング以後を再実行)"
          >
            クラスタリングを再実行
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
