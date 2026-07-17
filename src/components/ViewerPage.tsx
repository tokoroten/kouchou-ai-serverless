import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { exportArgumentsCsv, exportClustersCsv, exportResultJson, exportSingleHtml } from "../lib/export";
import { navigate } from "../lib/router";
import { db } from "../lib/storage/db";
import { estimateActualCostUsd } from "../types/settings";
import { ReportViewer } from "./viewer/ReportViewer";

// レポート表示ページ。ビューア + エクスポート(JSON / 単一HTML / CSV)。

export function ViewerPage({ reportId }: { reportId: string }) {
  const report = useLiveQuery(() => db.reports.get(reportId), [reportId]);
  const project = useLiveQuery(() => db.projects.filter((p) => p.reportId === reportId).first(), [reportId]);
  const [exporting, setExporting] = useState(false);

  if (report === undefined) return <p>読み込み中...</p>;
  if (report === null || !report) return <p>レポートが見つかりません。</p>;

  const exportHtml = async () => {
    setExporting(true);
    try {
      await exportSingleHtml(report.result);
    } catch (e) {
      alert(`エクスポートに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  };

  const cost =
    report.tokenUsage && report.chatModel
      ? estimateActualCostUsd(report.tokenUsage, report.chatModel, report.serviceTier)
      : null;

  return (
    <div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        {report.tokenUsage && (
          <span className="note">
            生成コスト: 入力 {report.tokenUsage.input.toLocaleString()} / 出力{" "}
            {report.tokenUsage.output.toLocaleString()} トークン
            {cost !== null ? ` ≈ $${cost.toFixed(3)}` : ""}({report.chatModel})
          </span>
        )}
        <button type="button" onClick={() => exportResultJson(report.result)}>
          JSON エクスポート
        </button>
        <button type="button" onClick={exportHtml} disabled={exporting}>
          {exporting ? "生成中..." : "単一 HTML レポート"}
        </button>
        <button type="button" onClick={() => exportArgumentsCsv(report.result)}>
          意見 CSV
        </button>
        <button type="button" onClick={() => exportClustersCsv(report.result)}>
          クラスタ CSV
        </button>
        {project && (
          <button type="button" onClick={() => navigate(`/interactive/${project.id}`)}>
            クラスタリングを再実行
          </button>
        )}
      </div>
      <ReportViewer result={report.result} />
    </div>
  );
}
