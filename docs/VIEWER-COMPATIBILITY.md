# 本体との表示・抽出診断の互換性

600px以下では初期表示を階層リストにする。散布図にも切り替えられ、ウィンドウのリサイズで選択を上書きしない。アプリ内・単一HTMLは同じReportViewerを使う。本体側は明示的なvisualizationConfigを優先するが、serverlessは現時点でその設定による初期タブ指定に対応していない。

Plotlyの日本語折り返しは、結合文字を分けず、開き括弧の行末・閉じ括弧や句読点の行頭を避ける。同じ補助関数・テストケースを本体にも追加した。

開発サーバーの `#/dev/viewer-states` は、本体の状態カタログと同じ公開サンプル由来の12意見で通常・属性なし・空の意見を確認できる。APIやIndexedDBを操作しない。本番ビルドにはカタログを含めない。390pxと1280pxで比較する。

抽出の失敗と正常0件は区別する。失敗時には不完全な結果を返さず、その入力の成功キャッシュも書かない。原文・回答ID・区分・エラー型をブラウザ内のプロジェクト別診断に残し、実行画面で確認できる。正常0件は再実行時にも診断を表示する。診断の原文はレポートJSON・単一HTMLに追加しない。実LLMでの動作は未検証（モック試験のみ）。

抽出プロンプトの比較手順は本体の `docs/development/extraction-prompts.md`、JSONの任意の参照整合性検査は `analysis_core.validate_output` を参照する。単一HTMLはfile://で開けるが、本体の静的出力一式はHTTP配信が必要であり、配布形式を混同しない。

回帰確認: `pnpm exec playwright install chromium`、`pnpm build`、`pnpm dev --port 5174` の後、別端末で `node scripts/viewer-states-e2e.ts` を実行する（Node 24）。APIキーは不要で、状態切替・スマホ・リサイズ・ビルド済み単一HTMLのfile://表示を確認する。
