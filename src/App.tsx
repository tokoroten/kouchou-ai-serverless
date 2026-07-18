import { useEffect } from "react";
import { HomePage } from "./components/HomePage";
import { InteractivePage } from "./components/InteractivePage";
import { RunPage } from "./components/RunPage";
import { SettingsPage } from "./components/SettingsPage";
import { StanceSpectrumAboutPage } from "./components/StanceSpectrumAboutPage";
import { StanceSpectrumNewPage } from "./components/StanceSpectrumNewPage";
import { StanceSpectrumHome, StanceSpectrumPage } from "./components/StanceSpectrumPage";
import { ViewerPage } from "./components/ViewerPage";
import { WizardPage } from "./components/WizardPage";
import { navigate, useHashRoute } from "./lib/router";

// 旧ルート #/phase2... は 2026-07-18 のリネームで #/stance-spectrum... になった。
// 既存のブックマークや共有リンクを壊さないよう、同じパス構造のまま読み替える。
const LEGACY_ROUTE_PREFIX = "/phase2";

export function App() {
  const route = useHashRoute();
  const isLegacyRoute = route === LEGACY_ROUTE_PREFIX || route.startsWith(`${LEGACY_ROUTE_PREFIX}/`);

  useEffect(() => {
    if (!isLegacyRoute) return;
    navigate(`/stance-spectrum${route.slice(LEGACY_ROUTE_PREFIX.length)}`, { replace: true });
  }, [isLegacyRoute, route]);

  if (isLegacyRoute) return null;

  let page: React.ReactNode;
  if (route === "/" || route === "") {
    page = <HomePage />;
  } else if (route === "/settings") {
    page = <SettingsPage />;
  } else if (route === "/new") {
    page = <WizardPage />;
  } else if (route.startsWith("/run/")) {
    page = <RunPage projectId={route.slice("/run/".length)} />;
  } else if (route.startsWith("/report/")) {
    page = <ViewerPage reportId={route.slice("/report/".length)} />;
  } else if (route.startsWith("/interactive/")) {
    page = <InteractivePage projectId={route.slice("/interactive/".length)} />;
  } else if (route === "/stance-spectrum") {
    page = <StanceSpectrumHome />;
  } else if (route === "/stance-spectrum/new") {
    page = <StanceSpectrumNewPage />;
  } else if (route === "/stance-spectrum/about") {
    page = <StanceSpectrumAboutPage />;
  } else if (route.startsWith("/stance-spectrum/")) {
    page = <StanceSpectrumPage projectId={route.slice("/stance-spectrum/".length)} />;
  } else {
    page = <p>ページが見つかりません。</p>;
  }

  return (
    <div className="container">
      <nav className="app-nav">
        <a className="brand" href="#/">
          広聴AI サーバレス版
        </a>
        <a href="#/">レポート一覧</a>
        <a href="#/new">新規作成</a>
        <a href="#/settings">設定</a>
        <a
          href="https://github.com/tokoroten/kouchou-ai-serverless"
          target="_blank"
          rel="noreferrer"
          style={{ marginLeft: "auto" }}
        >
          GitHub
        </a>
      </nav>
      {page}
      <footer className="app-footer">
        広聴AI サーバレス版 —{" "}
        <a href="https://github.com/digitaldemocracy2030/kouchou-ai" target="_blank" rel="noreferrer">
          kouchou-ai(広聴AI)
        </a>
        の分析パイプラインをブラウザ内で再実装したものです。データはブラウザと選択した LLM API 以外へ送信されません。
        {" · "}
        <a href="#/stance-spectrum" className="footer-stance-spectrum">
          賛否スペクトラム分析
        </a>
      </footer>
    </div>
  );
}
