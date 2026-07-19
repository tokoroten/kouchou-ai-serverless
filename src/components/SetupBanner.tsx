import { navigate } from "../lib/router";
import { useSettings } from "../store/settings";
import { pipelineReadiness } from "../types/settings";

// 環境構築(LLM プロバイダ設定 + 疎通確認)が済んでいないことを知らせるバナー。
// トップ / 新規作成ウィザード / 賛否スペクトラム新規作成で共用する。
//
// 表現の方針: サンプル閲覧と既存レポートの表示は設定ゼロでも動くため、
// 「アプリが壊れている」ように見せない。足りないものを具体的に挙げ、
// 「新規作成には設定が必要」という限定した言い方にする。

export function SetupBanner({ context = "home" }: { context?: "home" | "create" }) {
  const { settings } = useSettings();
  const { ready, blocked, slots } = pipelineReadiness(settings);
  if (ready) return null;

  const missing = slots.filter((s) => s.readiness.state !== "ok");

  return (
    <div className="warn-box">
      <b>{blocked ? "環境構築がまだ終わっていません" : "疎通確認がまだです"}</b>
      <ul style={{ margin: "6px 0", paddingLeft: "1.2em" }}>
        {missing.map((s) => (
          <li key={s.slot}>{s.readiness.reason}</li>
        ))}
      </ul>
      <div className="row" style={{ alignItems: "center" }}>
        <button type="button" className="primary" onClick={() => navigate("/settings")}>
          設定画面へ
        </button>
        <span className="note" style={{ margin: 0 }}>
          {blocked
            ? context === "create"
              ? "この状態では実行できません。設定画面で API キーとモデルを設定してください。"
              : "新規レポート作成には LLM の設定が必要です。サンプル閲覧と既存レポートの表示は設定なしで使えます。"
            : "設定は揃っています。設定画面の「一括疎通確認を実行」で、キーとモデルが実際に動くか確かめられます。"}
        </span>
      </div>
    </div>
  );
}
