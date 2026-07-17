import { useLiveQuery } from "dexie-react-hooks";
import { useRef } from "react";
import { exportResultJson, parsePreprocessed, parseResultJson } from "../lib/export";
import { navigate } from "../lib/router";
import { dexieStepStore } from "../lib/storage/checkpoints";
import { db, deleteProjectData, requestPersistentStorage } from "../lib/storage/db";
import { useSettings } from "../store/settings";
import type { Project } from "../types/project";
import { estimateActualCostUsd, resolveEndpoint } from "../types/settings";

// ホーム / レポート一覧(DESIGN §7-1)。

const STATUS_LABEL: Record<Project["status"], string> = {
  created: "未実行",
  running: "実行中",
  paused: "一時停止",
  error: "エラー",
  done: "完了",
};

export function HomePage() {
  const reports = useLiveQuery(() => db.reports.orderBy("createdAt").reverse().toArray(), []);
  const projects = useLiveQuery(() => db.projects.orderBy("createdAt").reverse().toArray(), []);
  const importRef = useRef<HTMLInputElement>(null);
  const { settings } = useSettings();

  // Result JSON と前処理データ(.preprocessed.json)の両方を受け付ける
  const importJson = async (file: File) => {
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("JSON として読み込めませんでした");
      }
      if ((parsed as { type?: string })?.type === "kouchou-ai-preprocessed") {
        // 前処理済みプロジェクトのインポート: 抽出+埋め込み結果を復元し、後処理から再開できる
        const { project: meta, extraction, embedding } = parsePreprocessed(text);
        await requestPersistentStorage();
        const project: Project = {
          id: crypto.randomUUID(),
          title: meta.title,
          question: meta.question,
          intro: meta.intro,
          createdAt: Date.now(),
          comments: meta.comments,
          attributeColumns: meta.attributeColumns,
          settingsSnapshot: {
            chat: resolveEndpoint(settings, "chat"),
            embedding: resolveEndpoint(settings, "embedding"),
            concurrency: settings.concurrency,
          },
          clusterNums: meta.clusterNums,
          prompts: meta.prompts,
          samplingNum: meta.samplingNum,
          status: "paused",
          currentStep: "clustering",
          tokenUsage: { input: 0, output: 0, total: 0 },
        };
        await db.projects.put(project);
        const store = dexieStepStore(project.id);
        await store.put("extraction", extraction);
        await store.put("embedding", embedding);
        navigate(`/run/${project.id}`);
        return;
      }
      const result = parseResultJson(text);
      const id = crypto.randomUUID();
      await db.reports.put({
        id,
        title: result.config?.name || file.name.replace(/\.json$/, ""),
        createdAt: Date.now(),
        result,
      });
      navigate(`/report/${id}`);
    } catch (e) {
      alert(`インポートに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // 同梱サンプルレポート(実データで生成した本家互換 JSON)を開く
  const openSample = async () => {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}sample-report.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = parseResultJson(await response.text());
      await db.reports.put({
        id: "sample",
        title: result.config?.name || "サンプルレポート",
        createdAt: Date.now(),
        result,
      });
      navigate("/report/sample");
    } catch (e) {
      alert(`サンプルの読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>レポート一覧</h1>
        <div className="row">
          <button type="button" className="primary" onClick={() => navigate("/new")}>
            + 新規レポート作成
          </button>
          <button type="button" onClick={() => importRef.current?.click()}>
            JSON インポート
          </button>
          <button type="button" onClick={openSample} title="同梱のサンプルレポート(2,000件の仮想アンケート)を開く">
            サンプルを見る
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importJson(file);
              e.target.value = "";
            }}
          />
        </div>
      </div>
      <p className="note">
        すべての処理はブラウザ内で完結します。データは LLM プロバイダ以外へ送信されません。 レポートはこのブラウザの
        IndexedDB に保存されます — 大事なレポートは必ず JSON エクスポートで手元に保存してください。
      </p>

      {projects && projects.filter((p) => p.status !== "done").length > 0 && (
        <>
          <h2>処理中のプロジェクト</h2>
          <div className="report-grid">
            {projects
              .filter((p) => p.status !== "done")
              .map((project) => (
                <div key={project.id} className="card">
                  <h3>{project.title}</h3>
                  <p className="note">
                    {STATUS_LABEL[project.status]}
                    {project.currentStep ? ` (${project.currentStep})` : ""} / {project.comments.length} コメント
                  </p>
                  {project.errorMessage && <div className="error-box">{project.errorMessage}</div>}
                  <div className="row">
                    <button type="button" className="primary" onClick={() => navigate(`/run/${project.id}`)}>
                      {project.status === "created" ? "実行" : "再開 / 詳細"}
                    </button>
                    <button type="button" onClick={() => navigate(`/interactive/${project.id}`)}>
                      リアルタイム
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={async () => {
                        if (confirm(`「${project.title}」を削除しますか?(中間データも消えます)`)) {
                          await deleteProjectData(project.id);
                        }
                      }}
                    >
                      削除
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </>
      )}

      <h2>完成したレポート</h2>
      {(!reports || reports.length === 0) && <p className="note">まだレポートがありません。</p>}
      <div className="report-grid">
        {reports?.map((report) => (
          <div key={report.id} className="card">
            <h3>{report.title}</h3>
            <p className="note">
              {new Date(report.createdAt).toLocaleString("ja-JP")} / 意見 {report.result.arguments.length} 件
              {report.tokenUsage &&
                report.chatModel &&
                (() => {
                  const cost = estimateActualCostUsd(report.tokenUsage, report.chatModel, report.serviceTier);
                  return cost !== null ? ` / コスト ≈ $${cost.toFixed(3)}` : "";
                })()}
            </p>
            <div className="row">
              <button type="button" className="primary" onClick={() => navigate(`/report/${report.id}`)}>
                開く
              </button>
              <button type="button" onClick={() => exportResultJson(report.result)}>
                JSON
              </button>
              <button
                type="button"
                className="danger"
                onClick={async () => {
                  if (confirm(`レポート「${report.title}」を削除しますか?`)) {
                    await db.reports.delete(report.id);
                  }
                }}
              >
                削除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
