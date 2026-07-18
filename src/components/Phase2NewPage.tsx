import { useMemo, useState } from "react";
import { type CsvPreview, detectBodyColumn, normalizeComments, parseCsvFile } from "../lib/csv";
import { navigate } from "../lib/router";
import { db, requestPersistentStorage } from "../lib/storage/db";
import { extractionPrompt, initialLabellingPrompt, mergeLabellingPrompt, overviewPrompt } from "../prompts";
import { useSettings } from "../store/settings";
import type { Project } from "../types/project";
import { resolveEndpoint } from "../types/settings";

// 賛否スペクトラム分析の専用データ投入口。通常版パイプラインを経由せず、CSV から直接
// Project を作って #/phase2/{id} へ入る(結合抽出は phase2 側で走る)。
// 通常版ウィザードから、賛否スペクトラム分析に不要な設定(クラスタ数・ラベリング/概要プロンプト・
// サンプリング数)を削いだ軽量版。それらの Project フィールドは既定値で埋める。

export function Phase2NewPage() {
  const { settings } = useSettings();
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [encoding, setEncoding] = useState<"UTF-8" | "Shift_JIS">("UTF-8");
  const [fileName, setFileName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [bodyColumn, setBodyColumn] = useState("");
  const [idColumn, setIdColumn] = useState("");
  const [attributeColumns, setAttributeColumns] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [extraction, setExtraction] = useState(extractionPrompt);

  const comments = useMemo(() => {
    if (!preview || !bodyColumn) return [];
    return normalizeComments(preview.rows, bodyColumn, idColumn || null, attributeColumns);
  }, [preview, bodyColumn, idColumn, attributeColumns]);

  const chatNow = resolveEndpoint(settings, "chat");
  const embeddingNow = resolveEndpoint(settings, "embedding");
  const settingsMissing = !chatNow.baseUrl || !embeddingNow.baseUrl;

  const loadFile = async (f: File, enc: "UTF-8" | "Shift_JIS") => {
    setError(null);
    try {
      const p = await parseCsvFile(f, enc);
      setPreview(p);
      setFile(f);
      setFileName(f.name);
      setBodyColumn((prev) => (prev && p.columns.includes(prev) ? prev : detectBodyColumn(p.columns, p.rows)));
      setIdColumn((prev) =>
        prev && p.columns.includes(prev) ? prev : p.columns.includes("comment-id") ? "comment-id" : "",
      );
      setAttributeColumns((prev) => prev.filter((c) => p.columns.includes(c)));
      if (!title) setTitle(f.name.replace(/\.csv$/i, ""));
    } catch (e) {
      setError(`CSV の読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const create = async () => {
    setError(null);
    if (comments.length < 2) {
      setError("有効なコメントが2件未満です。意見本文の列の指定を確認してください。");
      return;
    }
    if (settingsMissing) {
      setError("先に「設定」でチャットと埋め込みのプロバイダを設定してください。");
      return;
    }
    setCreating(true);
    try {
      await requestPersistentStorage();
      const project: Project = {
        id: crypto.randomUUID(),
        kind: "phase2",
        title: title || "無題の賛否スペクトラム分析",
        question,
        intro: "",
        createdAt: Date.now(),
        comments,
        attributeColumns,
        settingsSnapshot: {
          chat: chatNow,
          embedding: embeddingNow,
          concurrency: settings.concurrency,
        },
        // 以下は通常版パイプライン用の設定。賛否スペクトラム分析では使わないので既定値。
        clusterNums: [],
        prompts: {
          extraction,
          initialLabelling: initialLabellingPrompt,
          mergeLabelling: mergeLabellingPrompt,
          overview: overviewPrompt,
        },
        samplingNum: 30,
        status: "created",
        currentStep: null,
        tokenUsage: { input: 0, output: 0, total: 0 },
      };
      await db.projects.put(project);
      navigate(`/phase2/${project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  };

  return (
    <div>
      <h1>賛否スペクトラム分析 — データを取り込む</h1>
      <p className="note">
        CSV を取り込んで、そのまま賛否スペクトラム分析に入ります。通常版の実行は不要です。意見抽出・
        stance/topics/reasons の付与・ベクトル化は「開く」の後、賛否スペクトラム分析の画面で一括実行されます。
      </p>
      {settingsMissing && (
        <div className="error-box">
          LLM プロバイダが未設定です(チャット{chatNow.baseUrl ? "設定済み" : "未設定"} / 埋め込み
          {embeddingNow.baseUrl ? "設定済み" : "未設定"})。先に <a href="#/settings">設定画面</a> で API
          キーとモデルを設定してください。
        </div>
      )}
      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <h2>CSV を選択</h2>
        <p className="note">
          ヘッダ付き CSV。意見本文の列(推奨: comment-body)が必要です。空のコメントは自動除外されます。
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
            <p className="note" style={{ marginTop: 8 }}>
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
            <label>属性として使う列(複数可 — 色分け・属性軸に使えます)</label>
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

      {preview && (
        <div className="card">
          <h2>基本情報</h2>
          <label>タイトル</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例: 生成AIに関する意見募集" />
          <label>調査の問い(任意)</label>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="例: 生成AIについてどう思いますか?"
          />
          <div style={{ marginTop: 12 }}>
            <button type="button" onClick={() => setShowPrompt(!showPrompt)}>
              {showPrompt ? "抽出プロンプトを隠す" : "詳細設定: 抽出プロンプトを編集"}
            </button>
          </div>
          {showPrompt && (
            <div>
              <label>
                抽出プロンプト(意見分割の指針。賛否スペクトラム分析はこれに構造化属性の指示を自動で足して1コールで実行)
              </label>
              <textarea
                style={{ minHeight: 160, fontFamily: "monospace", fontSize: "0.8rem" }}
                value={extraction}
                onChange={(e) => setExtraction(e.target.value)}
              />
            </div>
          )}
        </div>
      )}

      <div className="row">
        <button type="button" onClick={() => navigate("/phase2")}>
          戻る
        </button>
        <button
          type="button"
          className="primary"
          disabled={creating || comments.length < 2 || settingsMissing}
          onClick={create}
        >
          {creating ? "作成中..." : "取り込んで賛否スペクトラム分析を開く"}
        </button>
      </div>
    </div>
  );
}
