import { useMemo, useState } from "react";
import { type CsvPreview, normalizeComments, parseCsvFile } from "../lib/csv";
import { estimateCost, estimateUsd } from "../lib/estimate";
import { calculateRecommendedClusterNums } from "../lib/pipeline/clusterNums";
import { navigate } from "../lib/router";
import { db, requestPersistentStorage } from "../lib/storage/db";
import { extractionPrompt, initialLabellingPrompt, mergeLabellingPrompt, overviewPrompt } from "../prompts";
import { useSettings } from "../store/settings";
import type { Project } from "../types/project";
import { resolveEndpoint } from "../types/settings";

// 新規作成ウィザード(DESIGN §7-3)。
// Step1: CSV → Step2: タイトル → Step3: 詳細設定 → Step4: コスト見積り → 実行

export function WizardPage() {
  const { settings } = useSettings();
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);

  // Step1
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [encoding, setEncoding] = useState<"UTF-8" | "Shift_JIS">("UTF-8");
  const [fileName, setFileName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [bodyColumn, setBodyColumn] = useState("");
  const [idColumn, setIdColumn] = useState<string>("");
  const [attributeColumns, setAttributeColumns] = useState<string[]>([]);

  // Step2
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [intro, setIntro] = useState("");

  // Step3
  const [clusterNumsText, setClusterNumsText] = useState("");
  const [samplingNum, setSamplingNum] = useState(30);
  const [showPrompts, setShowPrompts] = useState(false);
  const [prompts, setPrompts] = useState({
    extraction: extractionPrompt,
    initialLabelling: initialLabellingPrompt,
    mergeLabelling: mergeLabellingPrompt,
    overview: overviewPrompt,
  });

  const comments = useMemo(() => {
    if (!preview || !bodyColumn) return [];
    return normalizeComments(preview.rows, bodyColumn, idColumn || null, attributeColumns);
  }, [preview, bodyColumn, idColumn, attributeColumns]);

  const clusterNums = useMemo(() => {
    const parsed = clusterNumsText
      .split(/[,、\s]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n >= 2);
    return parsed.sort((a, b) => a - b);
  }, [clusterNumsText]);

  const recommendedNums = useMemo(() => {
    const estimatedArgs = Math.max(2, Math.round(comments.length * 1.3));
    try {
      return calculateRecommendedClusterNums(estimatedArgs);
    } catch {
      return [2];
    }
  }, [comments.length]);

  const estimate = useMemo(
    () =>
      estimateCost(
        comments,
        {
          extraction: prompts.extraction.length,
          initialLabelling: prompts.initialLabelling.length,
          mergeLabelling: prompts.mergeLabelling.length,
          overview: prompts.overview.length,
        },
        clusterNums,
        samplingNum,
      ),
    [comments, prompts, clusterNums, samplingNum],
  );

  const loadFile = async (f: File, enc: "UTF-8" | "Shift_JIS") => {
    setError(null);
    try {
      const p = await parseCsvFile(f, enc);
      setPreview(p);
      setFile(f);
      setFileName(f.name);
      // comment-body / comment-id 列を自動検出
      if (p.columns.includes("comment-body")) setBodyColumn("comment-body");
      else setBodyColumn(p.columns[0] ?? "");
      setIdColumn(p.columns.includes("comment-id") ? "comment-id" : "");
      setAttributeColumns([]);
      if (!title) setTitle(f.name.replace(/\.csv$/i, ""));
    } catch (e) {
      setError(`CSV の読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const create = async () => {
    setError(null);
    if (comments.length < 2) {
      setError("有効なコメントが2件未満です。comment-body 列の指定を確認してください。");
      return;
    }
    const chatEndpoint = resolveEndpoint(settings, "chat");
    const embeddingEndpoint = resolveEndpoint(settings, "embedding");
    if (!chatEndpoint.baseUrl || !embeddingEndpoint.baseUrl) {
      setError("先に「設定」でチャットと埋め込みのプロバイダを設定してください。");
      return;
    }
    await requestPersistentStorage();
    const project: Project = {
      id: crypto.randomUUID(),
      title: title || "無題のレポート",
      question,
      intro,
      createdAt: Date.now(),
      comments,
      attributeColumns,
      settingsSnapshot: {
        chat: chatEndpoint,
        embedding: embeddingEndpoint,
        concurrency: settings.concurrency,
      },
      clusterNums,
      prompts,
      samplingNum,
      status: "created",
      currentStep: null,
      tokenUsage: { input: 0, output: 0, total: 0 },
    };
    await db.projects.put(project);
    navigate(`/run/${project.id}`);
  };

  return (
    <div>
      <h1>新規レポート作成 — Step {step}/4</h1>
      {error && <div className="error-box">{error}</div>}

      {step === 1 && (
        <div className="card">
          <h2>Step 1: CSV を選択</h2>
          <p className="note">
            ヘッダ付き CSV。意見本文の列(推奨: comment-body)が必要です。空のコメントは自動で除外されます。
          </p>
          <div className="row">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) loadFile(f, encoding);
              }}
            />
            <select
              value={encoding}
              onChange={(e) => {
                const enc = e.target.value as "UTF-8" | "Shift_JIS";
                setEncoding(enc);
                if (file) loadFile(file, enc);
              }}
            >
              <option value="UTF-8">UTF-8</option>
              <option value="Shift_JIS">Shift_JIS</option>
            </select>
          </div>
          {preview && (
            <>
              <p>
                {fileName}: 全 {preview.totalRows.toLocaleString()} 行 / 有効コメント {comments.length.toLocaleString()}{" "}
                件
              </p>
              <label>意見本文の列</label>
              <select value={bodyColumn} onChange={(e) => setBodyColumn(e.target.value)}>
                {preview.columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <label>ID 列(任意)</label>
              <select value={idColumn} onChange={(e) => setIdColumn(e.target.value)}>
                <option value="">(自動採番)</option>
                {preview.columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <label>属性として使う列(複数可)</label>
              <div className="row">
                {preview.columns
                  .filter((c) => c !== bodyColumn && c !== idColumn)
                  .map((c) => (
                    <label key={c} style={{ fontWeight: 400, margin: 0 }}>
                      <input
                        type="checkbox"
                        style={{ width: "auto", marginRight: 4 }}
                        checked={attributeColumns.includes(c)}
                        onChange={(e) =>
                          setAttributeColumns((prev) => (e.target.checked ? [...prev, c] : prev.filter((x) => x !== c)))
                        }
                      />
                      {c}
                    </label>
                  ))}
              </div>
              <div style={{ overflowX: "auto", marginTop: 12 }}>
                <table className="preview-table">
                  <thead>
                    <tr>
                      {preview.columns.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 5).map((row, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: プレビュー行は固定
                      <tr key={i}>
                        {preview.columns.map((c) => (
                          <td key={c}>{row[c]}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h2>Step 2: レポート情報</h2>
          <label>タイトル</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例: 生成AIに関する意見募集" />
          <label>調査の問い(question)</label>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="例: 生成AIについてどう思いますか?"
          />
          <label>調査概要(intro)</label>
          <textarea
            value={intro}
            onChange={(e) => setIntro(e.target.value)}
            placeholder="レポートの冒頭に表示される説明文"
          />
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <h2>Step 3: 分析設定</h2>
          <p className="note">
            使用モデル: チャット = {resolveEndpoint(settings, "chat").model || "未設定"} / 埋め込み ={" "}
            {resolveEndpoint(settings, "embedding").model || "未設定"}(変更は「設定」から)
          </p>
          <label>クラスタ数(カンマ区切り。空欄なら自動: 推奨 {recommendedNums.join(", ")})</label>
          <input
            value={clusterNumsText}
            onChange={(e) => setClusterNumsText(e.target.value)}
            placeholder={recommendedNums.join(", ")}
          />
          <label>ラベリング時のサンプリング数</label>
          <input
            type="number"
            min={5}
            max={100}
            value={samplingNum}
            onChange={(e) => setSamplingNum(Math.max(5, Number(e.target.value) || 30))}
          />
          <div style={{ marginTop: 12 }}>
            <button type="button" onClick={() => setShowPrompts(!showPrompts)}>
              {showPrompts ? "プロンプトを隠す" : "詳細設定: プロンプトを編集"}
            </button>
          </div>
          {showPrompts &&
            (
              [
                ["extraction", "抽出プロンプト"],
                ["initialLabelling", "初期ラベリングプロンプト"],
                ["mergeLabelling", "統合ラベリングプロンプト"],
                ["overview", "概要プロンプト"],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <label>{label}</label>
                <textarea
                  style={{ minHeight: 140, fontFamily: "monospace", fontSize: "0.8rem" }}
                  value={prompts[key]}
                  onChange={(e) => setPrompts((prev) => ({ ...prev, [key]: e.target.value }))}
                />
              </div>
            ))}
        </div>
      )}

      {step === 4 && (
        <div className="card">
          <h2>Step 4: コスト見積り</h2>
          <p>
            有効コメント {comments.length.toLocaleString()} 件 / chat 呼び出し 約 {estimate.chatCalls.toLocaleString()}{" "}
            回
          </p>
          <ul>
            <li>チャット入力: 約 {estimate.chatInputTokens.toLocaleString()} トークン</li>
            <li>チャット出力: 約 {estimate.chatOutputTokens.toLocaleString()} トークン</li>
            <li>埋め込み: 約 {estimate.embeddingTokens.toLocaleString()} トークン</li>
          </ul>
          {resolveEndpoint(settings, "chat").baseUrl.startsWith("local:") ||
          resolveEndpoint(settings, "embedding").baseUrl.startsWith("local:") ? (
            <p>
              ローカル実行(Gemini Nano / ブラウザ内埋め込み)が選択されているため、その分の API 費用は <b>0円</b> です。
            </p>
          ) : (
            <p>
              参考費用(gpt-4o-mini + text-embedding-3-small 価格): <b>約 ${estimateUsd(estimate).toFixed(3)}</b>
            </p>
          )}
          <p className="note">
            ※ あくまで概算です。処理はいつでも中断でき、途中経過はブラウザに保存されるため再開できます。
          </p>
        </div>
      )}

      <div className="row">
        {step > 1 && (
          <button type="button" onClick={() => setStep(step - 1)}>
            戻る
          </button>
        )}
        {step < 4 && (
          <button
            type="button"
            className="primary"
            disabled={step === 1 && comments.length < 2}
            onClick={() => setStep(step + 1)}
          >
            次へ
          </button>
        )}
        {step === 4 && (
          <button type="button" className="primary" onClick={create}>
            プロジェクトを作成して実行画面へ
          </button>
        )}
      </div>
    </div>
  );
}
