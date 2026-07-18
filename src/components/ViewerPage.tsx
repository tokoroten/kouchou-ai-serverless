import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState } from "react";
import {
  blobToDataUrl,
  exportArgumentsCsv,
  exportClustersCsv,
  exportResultJson,
  exportSingleHtml,
} from "../lib/export";
import { generateAndSavePonchie } from "../lib/imageGen";
import { navigate } from "../lib/router";
import { db, deleteReportImage, getReportImage, type ReportImageRow } from "../lib/storage/db";
import { useSettings } from "../store/settings";
import { estimateActualCostUsd, isProviderConfigured, PRESETS, resolveEndpoint } from "../types/settings";
import { ReportViewer } from "./viewer/ReportViewer";

// レポート表示ページ。ビューア + エクスポート(JSON / 単一HTML / CSV / PowerPoint)
// + ポンチ絵生成(images/generations 互換 API → IndexedDB 保存)。

export function ViewerPage({ reportId }: { reportId: string }) {
  const report = useLiveQuery(() => db.reports.get(reportId), [reportId]);
  const project = useLiveQuery(() => db.projects.filter((p) => p.reportId === reportId).first(), [reportId]);
  const { settings } = useSettings();
  const [exporting, setExporting] = useState(false);
  const [exportingPptx, setExportingPptx] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // ポンチ絵。blob と生成メタデータ(モデル・日時・プロンプト)を行ごと保持する
  const [imageRow, setImageRow] = useState<ReportImageRow | null>(null);
  const [ponchieUrl, setPonchieUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [ponchieError, setPonchieError] = useState<string | null>(null);
  // クリックで最大化表示(ライトボックス)。Escape でも閉じる
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!lightboxOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightboxOpen]);

  // 保存済みポンチ絵の復元。cancelled ガードで、読み込み完了前に reportId が
  // 変わった/アンマウントされた場合の setState(別レポートの画像混入)を防ぐ。
  useEffect(() => {
    let cancelled = false;
    setImageRow(null);
    setPonchieError(null);
    getReportImage(reportId).then((row) => {
      if (!cancelled) setImageRow(row ?? null);
    });
    return () => {
      cancelled = true;
      // レポートを離れたら進行中の生成も中断する(結果の混入防止 + 無駄な課金の抑制)
      abortRef.current?.abort();
    };
  }, [reportId]);

  // オブジェクト URL は blob からこの effect で一元管理する。cleanup で必ず revoke
  // されるため、手動管理で起きるリーク(revoke 漏れ)が構造的に起きない。
  const ponchieBlob = imageRow?.blob ?? null;
  useEffect(() => {
    if (!ponchieBlob) {
      setPonchieUrl(null);
      return;
    }
    const url = URL.createObjectURL(ponchieBlob);
    setPonchieUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [ponchieBlob]);

  // 画像スロットの解決はフックの後・早期 return の前に置く(フック順維持のため)
  const imageEndpoint = resolveEndpoint(settings, "image");
  // resolveEndpoint はプリセットの baseUrl で埋めるため、プロバイダのキーを
  // 削除した後でも baseUrl は残る。設定済みかどうかも見ないと、キー無しで
  // 送信して 401 になるボタンを有効のまま出してしまう。
  const imageProviderConfigured =
    settings.imageSlot.provider !== null && isProviderConfigured(settings.imageSlot.provider, settings);
  const imageConfigured = imageProviderConfigured && !!imageEndpoint.baseUrl && !!imageEndpoint.model;
  const imagePreset = PRESETS.find((p) => p.id === settings.imageSlot.provider);
  const imagePrice = imagePreset?.knownImageModels?.find((m) => m.id === imageEndpoint.model)?.price;

  if (report === undefined) return <p>読み込み中...</p>;
  if (report === null || !report) return <p>レポートが見つかりません。</p>;

  const exportHtml = async () => {
    setExporting(true);
    try {
      // 生成済みポンチ絵があれば data URL にして同梱する(PowerPoint と同じ扱い)
      const ponchie = imageRow
        ? {
            dataUrl: await blobToDataUrl(imageRow.blob),
            model: imageRow.model,
            createdAt: imageRow.createdAt,
          }
        : null;
      await exportSingleHtml(report.result, ponchie);
    } catch (e) {
      alert(`エクスポートに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  };

  const exportPowerPoint = async () => {
    setExportingPptx(true);
    setExportError(null);
    try {
      // 表示中の散布図(Plotly)を 4:3 でキャプチャして散布図スライドに入れる。
      // 階層リストタブなどでグラフが無いときは null になり、スライドはスキップされる
      const { captureChartPng } = await import("../lib/chartImage");
      const chart = await captureChartPng(document.querySelector(".viewer-chart")).catch(() => null);
      // pptxgenjs は重いので必要時にのみ読み込む
      const { exportPptx } = await import("../lib/pptx");
      await exportPptx(report.result, { ponchie: ponchieBlob, chart });
    } catch (e) {
      setExportError(`PowerPoint エクスポートに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExportingPptx(false);
    }
  };

  const generatePonchie = async () => {
    if (!imageConfigured) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setPonchieError(null);
    try {
      await generateAndSavePonchie(reportId, report.result, imageEndpoint, { signal: controller.signal });
      // メタデータ(prompt / model / createdAt)ごと表示したいので保存済み行を読み直す
      const row = await getReportImage(reportId);
      setImageRow(row ?? null);
    } catch (e) {
      // 中断(AbortError)はユーザ操作なのでエラー表示しない
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setPonchieError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  };

  const deletePonchie = async () => {
    // 課金して生成した画像がワンクリックで消えるのを防ぐ
    if (!confirm("生成済みのポンチ絵を削除しますか?(再生成には API 費用がかかります)")) return;
    await deleteReportImage(reportId);
    setImageRow(null);
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
      {exportError && <div className="error-box">{exportError}</div>}

      <ReportViewer result={report.result} />

      {/* ポンチ絵セクション: レポートの争点を一枚絵にする。PowerPoint の先頭スライドにも入る。
          チャートと解説を先に見せたいので、ビューア(散布図)の下に置く */}
      <section className="card" style={{ marginTop: 12 }}>
        <div className="row" style={{ alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>ポンチ絵</h2>
          {generating ? (
            <button type="button" onClick={() => abortRef.current?.abort()}>
              生成を中断
            </button>
          ) : (
            <button type="button" onClick={generatePonchie} disabled={!imageConfigured}>
              {imageRow ? "ポンチ絵を再生成" : "ポンチ絵を生成"}
            </button>
          )}
          {imageRow && (
            <button type="button" onClick={deletePonchie} disabled={generating}>
              削除
            </button>
          )}
          <span className="note">
            {imageConfigured
              ? `費用の目安: ${imagePrice ?? "モデルの料金表を確認してください"}`
              : "レポートの争点をひと目で掴める概念図を画像生成 API で作ります"}
          </span>
        </div>
        {!imageConfigured && (
          <p className="note">
            画像生成プロバイダが未設定のため生成できません。<a href="#/settings">設定画面</a>{" "}
            で画像スロットのプロバイダとモデルを選択してください。
          </p>
        )}
        {generating && <p className="note">画像を生成しています(数十秒かかることがあります)...</p>}
        {ponchieError && <div className="error-box">ポンチ絵の生成に失敗しました: {ponchieError}</div>}
        {imageRow && ponchieUrl && (
          <div style={{ marginTop: "0.75rem" }}>
            <button
              type="button"
              onClick={() => setLightboxOpen(true)}
              title="クリックで拡大表示"
              style={{ border: "none", padding: 0, background: "none", cursor: "zoom-in", display: "block" }}
            >
              <img src={ponchieUrl} alt="レポートの争点を表すポンチ絵" style={{ maxWidth: "100%", maxHeight: 480 }} />
            </button>
            <p className="note">
              モデル: {imageRow.model} / 生成日時: {new Date(imageRow.createdAt).toLocaleString()}
            </p>
            <details>
              <summary className="note">生成プロンプトを表示</summary>
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{imageRow.prompt}</pre>
            </details>
          </div>
        )}
      </section>

      {/* ライトボックス: クリックで最大化。背景クリックか Escape で閉じる */}
      {lightboxOpen && ponchieUrl && (
        <button
          type="button"
          aria-label="拡大表示を閉じる"
          onClick={() => setLightboxOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0, 0, 0, 0.8)",
            border: "none",
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "zoom-out",
          }}
        >
          <img
            src={ponchieUrl}
            alt="レポートの争点を表すポンチ絵(拡大表示)"
            style={{ maxWidth: "95vw", maxHeight: "95vh", objectFit: "contain" }}
          />
        </button>
      )}
    </div>
  );
}
