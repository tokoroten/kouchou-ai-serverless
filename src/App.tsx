import { HomePage } from "./components/HomePage";
import { InteractivePage } from "./components/InteractivePage";
import { Phase2AboutPage } from "./components/Phase2AboutPage";
import { Phase2NewPage } from "./components/Phase2NewPage";
import { Phase2Home, Phase2Page } from "./components/Phase2Page";
import { RunPage } from "./components/RunPage";
import { SettingsPage } from "./components/SettingsPage";
import { ViewerPage } from "./components/ViewerPage";
import { WizardPage } from "./components/WizardPage";
import { useHashRoute } from "./lib/router";

export function App() {
  const route = useHashRoute();

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
  } else if (route === "/phase2") {
    page = <Phase2Home />;
  } else if (route === "/phase2/new") {
    page = <Phase2NewPage />;
  } else if (route === "/phase2/about") {
    page = <Phase2AboutPage />;
  } else if (route.startsWith("/phase2/")) {
    page = <Phase2Page projectId={route.slice("/phase2/".length)} />;
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
        <a href="#/phase2" className="footer-phase2">
          賛否スペクトラム分析
        </a>
      </footer>
    </div>
  );
}
