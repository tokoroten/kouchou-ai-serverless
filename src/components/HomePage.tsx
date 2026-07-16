import { useLiveQuery } from "dexie-react-hooks";
import { useRef } from "react";
import { exportResultJson, parseResultJson } from "../lib/export";
import { navigate } from "../lib/router";
import { db, deleteProjectData } from "../lib/storage/db";
import type { Project } from "../types/project";

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

  const importJson = async (file: File) => {
    try {
      const result = parseResultJson(await file.text());
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
