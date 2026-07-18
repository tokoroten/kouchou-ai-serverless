import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReportViewer } from "./components/viewer/ReportViewer";
import type { PonchieExport } from "./lib/export";
import type { Result } from "./types/result";
import "./styles.css";

// 単一 HTML レポートのエントリポイント。
// <script type="application/json" id="report-data"> に埋め込まれた Result を表示する。
// ポンチ絵(id="ponchie-data"、data URL 込み)があればビューアの下に出す。

function readJsonTag<T>(id: string): T | null {
  const el = document.getElementById(id);
  try {
    return el ? (JSON.parse(el.textContent ?? "null") as T | null) : null;
  } catch {
    return null;
  }
}

/** アプリ内ビューアと同じ作法のポンチ絵表示(クリックで最大化、Escape で閉じる) */
function PonchieSection({ ponchie }: { ponchie: PonchieExport }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  useEffect(() => {
    if (!lightboxOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightboxOpen]);
  return (
    <>
      <section className="card" style={{ marginTop: 12 }}>
        <h2>ポンチ絵</h2>
        <button
          type="button"
          onClick={() => setLightboxOpen(true)}
          title="クリックで拡大表示"
          style={{ border: "none", padding: 0, background: "none", cursor: "zoom-in", display: "block" }}
        >
          <img src={ponchie.dataUrl} alt="レポートの争点を表すポンチ絵" style={{ maxWidth: "100%", maxHeight: 480 }} />
        </button>
        <p className="note">
          画像生成 AI({ponchie.model})による概念図 / 生成日時: {new Date(ponchie.createdAt).toLocaleString()}
        </p>
      </section>
      {lightboxOpen && (
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
            src={ponchie.dataUrl}
            alt="レポートの争点を表すポンチ絵(拡大表示)"
            style={{ maxWidth: "95vw", maxHeight: "95vh", objectFit: "contain" }}
          />
        </button>
      )}
    </>
  );
}

function StandaloneApp() {
  const result = readJsonTag<Result>("report-data");
  const ponchie = readJsonTag<PonchieExport>("ponchie-data");
  if (!result) {
    return (
      <div className="container">
        <h1>レポートデータがありません</h1>
        <p>このファイルは 広聴AI サーバレス版 のレポートテンプレートです。アプリからエクスポートしてください。</p>
      </div>
    );
  }
  return (
    <div className="container">
      <ReportViewer result={result} />
      {ponchie?.dataUrl && <PonchieSection ponchie={ponchie} />}
      <footer className="app-footer">
        <a href="https://github.com/tokoroten/kouchou-ai-serverless" target="_blank" rel="noreferrer">
          広聴AI サーバレス版で生成
        </a>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<StandaloneApp />);
