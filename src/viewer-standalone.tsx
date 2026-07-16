import { createRoot } from "react-dom/client";
import { ReportViewer } from "./components/viewer/ReportViewer";
import type { Result } from "./types/result";
import "./styles.css";

// 単一 HTML レポートのエントリポイント。
// <script type="application/json" id="report-data"> に埋め込まれた Result を表示する。

function StandaloneApp() {
  const el = document.getElementById("report-data");
  let result: Result | null = null;
  try {
    result = el ? (JSON.parse(el.textContent ?? "null") as Result | null) : null;
  } catch {
    result = null;
  }
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
