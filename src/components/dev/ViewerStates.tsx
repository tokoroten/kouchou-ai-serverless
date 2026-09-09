import { useState } from "react";
import type { Result } from "../../types/result";
import { ReportViewer } from "../viewer/ReportViewer";
import fixture from "./viewer-fixture.json";

export function ViewerStates() {
  const [state, setState] = useState("通常");
  const result = structuredClone(fixture) as unknown as Result;
  if (state === "属性なし") for (const arg of result.arguments) arg.attributes = {};
  if (state === "空の意見") {
    result.arguments = [];
    for (const cluster of result.clusters) cluster.value = 0;
  }
  return (
    <main>
      <h1>Viewer状態カタログ（開発専用）</h1>
      <label>
        状態{" "}
        <select aria-label="状態" value={state} onChange={(e) => setState(e.target.value)}>
          {["通常", "属性なし", "空の意見"].map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <p>本体と共通の仮想アンケート12意見を使用。API通信・データベースの変更は行いません。</p>
      <ReportViewer key={state} result={result} />
    </main>
  );
}
