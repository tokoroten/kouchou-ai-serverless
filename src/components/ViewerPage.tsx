import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { exportArgumentsCsv, exportClustersCsv, exportResultJson, exportSingleHtml } from "../lib/export";
import {
  buildPonchiePrompt,
  deletePonchieFromOpfs,
  generateImage,
  loadPonchieFromOpfs,
  savePonchieToOpfs,
} from "../lib/imageGen";
import { exportPptx } from "../lib/pptx";
import { navigate } from "../lib/router";
import { db } from "../lib/storage/db";
import { useSettings } from "../store/settings";
import { estimateActualCostUsd, resolveEndpoint } from "../types/settings";
import { ReportViewer } from "./viewer/ReportViewer";

// レポート表示ページ。ビューア + エクスポート(JSON / 単一HTML / CSV / PowerPoint)
// + ポンチ絵生成(OpenAI images API → OPFS 保存)。

export function ViewerPage({ reportId }: { reportId: string }) {
  const report = useLiveQuery(() => db.reports.get(reportId), [reportId]);
  const project = useLiveQuery(() => db.projects.filter((p) => p.reportId === reportId).first(), [reportId]);
  const { settings } = useSettings();
  const [exporting, setExporting] = useState(false);
  const [ponchieBlob, setPonchieBlob] = useState<Blob | null>(null);
  const [ponchieUrl, setPonchieUrl] = useState<string | null>(null);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [exportingPptx, setExportingPptx] = useState(false);

  // OPFS から既存のポンチ絵を読み込む
  useEffect(() => {
    let objectUrl: string | null = null;
    loadPonchieFromOpfs(reportId).then((blob) => {
      if (blob) {
        setPonchieBlob(blob);
        objectUrl = URL.createObjectURL(blob);
        setPonchieUrl(objectUrl);
      }
    });
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [reportId]);

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

  const generatePonchie = async () => {
    const endpoint = resolveEndpoint(settings, "chat");
    if (!endpoint.apiKey && endpoint.baseUrl.startsWith("https://api.openai.com")) {
      alert("OpenAI API キーが設定されていません。設定画面でキーを入力してください。");
      return;
    }
    // 画像生成用エンドポイント(画像生成は dall-e-3 固定)
    const imageEndpoint = { ...endpoint, model: "dall-e-3" };
    setGeneratingImage(true);
    try {
      const prompt = buildPonchiePrompt(report.result);
      const blob = await generateImage(imageEndpoint, prompt);
      await savePonchieToOpfs(reportId, blob);
      setPonchieBlob(blob);
      if (ponchieUrl) URL.revokeObjectURL(ponchieUrl);
      setPonchieUrl(URL.createObjectURL(blob));
    } catch (e) {
      alert(`ポンチ絵の生成に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setGeneratingImage(false);
    }
  };

  const deletePonchie = async () => {
    await deletePonchieFromOpfs(reportId);
    if (ponchieUrl) URL.revokeObjectURL(ponchieUrl);
    setPonchieBlob(null);
    setPonchieUrl(null);
  };

  const exportPowerPoint = async () => {
    setExportingPptx(true);
    try {
      await exportPptx(report.result, ponchieBlob);
    } catch (e) {
      alert(`PowerPoint エクスポートに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExportingPptx(false);
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
        <button type="button" onClick={exportPowerPoint} disabled={exportingPptx}>
          {exportingPptx ? "生成中..." : "PowerPoint"}
        </button>
        {project && (
          <button type="button" onClick={() => navigate(`/interactive/${project.id}`)}>
            クラスタリングを再実行
          </button>
        )}
      </div>

      {/* ポンチ絵セクション */}
      <section className="card" style={{ marginBottom: "1rem" }}>
        <div className="row" style={{ alignItems: "center", gap: "0.5rem" }}>
          <h2 style={{ margin: 0 }}>ポンチ絵</h2>
          <button type="button" onClick={generatePonchie} disabled={generatingImage}>
            {generatingImage ? "生成中..." : ponchieUrl ? "再生成" : "ポンチ絵を生成"}
          </button>
          {ponchieUrl && (
            <button type="button" onClick={deletePonchie} style={{ color: "var(--color-danger, #dc2626)" }}>
              削除
            </button>
          )}
          <span className="note">OpenAI DALL-E 3 で概念図を生成します(チャットスロットの API キーを使用)</span>
        </div>
        {ponchieUrl && (
          <div style={{ marginTop: "0.75rem", textAlign: "center" }}>
            <img
              src={ponchieUrl}
              alt="ポンチ絵"
              style={{
                maxWidth: "100%",
                maxHeight: "480px",
                borderRadius: "8px",
                border: "1px solid var(--color-border, #e5e7eb)",
              }}
            />
          </div>
        )}
      </section>

      <ReportViewer result={report.result} />
    </div>
  );
}
