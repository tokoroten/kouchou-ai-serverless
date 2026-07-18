import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { exportPreprocessed } from "../lib/export";
import { clusterXY } from "../lib/pipeline/clusteringCore";
import { buildClusterTable } from "../lib/pipeline/clusterTable";
import { memoryCheckpoints, type PipelineContext } from "../lib/pipeline/context";
import { aggregation } from "../lib/pipeline/steps/aggregation";
import { umapCheckpointKey } from "../lib/pipeline/steps/clustering";
import { embedding as embeddingStep } from "../lib/pipeline/steps/embedding";
import { extraction as extractionStep } from "../lib/pipeline/steps/extraction";
import { initialLabelling, mergeLabelling } from "../lib/pipeline/steps/labelling";
import { overview as overviewStep } from "../lib/pipeline/steps/overview";
import { navigate } from "../lib/router";
import { dexieCheckpoints, dexieStepStore } from "../lib/storage/checkpoints";
import { db } from "../lib/storage/db";
import type { EmbeddingResult, ExtractionResult } from "../types/project";
import { SOFT_COLORS } from "./viewer/colors";
import { Plot } from "./viewer/Plot";

// リアルタイムモード(DESIGN §7.2 の前倒し・軽量版)。
// - UMAP の収束過程を散布図上でライブ表示(Worker から中間座標を受信)
// - クラスタ数スライダーで KMeans + ward を即時再計算(2D なので数十ms)
// - ラベリングはオンデマンド実行。クラスタ構成ハッシュでキャッシュされるため
//   同一構成の再ラベリングは無料

type Coords = { x: Float32Array; y: Float32Array };

export function InteractivePage({ projectId }: { projectId: string }) {
  const project = useLiveQuery(() => db.projects.get(projectId), [projectId]);
  const preprocessed = useLiveQuery(async () => {
    const ext = (await db.stepResults.get([projectId, "extraction"]))?.data as ExtractionResult | undefined;
    const emb = (await db.stepResults.get([projectId, "embedding"]))?.data as EmbeddingResult | undefined;
    return { ext, emb };
  }, [projectId]);

  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [coords, setCoords] = useState<Coords | null>(null);
  const [umapRunning, setUmapRunning] = useState(false);
  const [umapDone, setUmapDone] = useState(false);
  const [lv1, setLv1] = useState(5);
  const [lv2, setLv2] = useState(25);
  const [assignments, setAssignments] = useState<Int32Array[] | null>(null);
  const [labelsPreview, setLabelsPreview] = useState<{ id: string; label: string; value: number }[] | null>(null);
  const [labelling, setLabelling] = useState(false);
  // UMAP 詳細パラメータ(変更後は「UMAP 再実行」で反映)
  const [umapParams, setUmapParams] = useState({
    nNeighbors: 15,
    minDist: 0.1,
    spread: 1.0,
    nEpochs: 0, // 0 = 自動
    seed: "kouchou-ai",
  });
  // 現在表示中の座標がどのパラメータで計算されたか(変更検知用)
  const [appliedParams, setAppliedParams] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // このページで消費したトークン(ラベリング・前処理)。レポート保存時に記録する
  const usageRef = useRef({ input: 0, output: 0, total: 0 });

  const toUmapInput = useCallback(
    () => ({
      seed: umapParams.seed || "kouchou-ai",
      umap: {
        ...(umapParams.nNeighbors !== 15 ? { nNeighbors: umapParams.nNeighbors } : {}),
        ...(umapParams.minDist !== 0.1 ? { minDist: umapParams.minDist } : {}),
        ...(umapParams.spread !== 1.0 ? { spread: umapParams.spread } : {}),
        ...(umapParams.nEpochs > 0 ? { nEpochs: umapParams.nEpochs } : {}),
      },
    }),
    [umapParams],
  );
  const paramsDirty = appliedParams !== null && appliedParams !== JSON.stringify(toUmapInput());
  // 表示中の座標を計算したときのシード(KMeans/ward の再計算にも同じ値を使う)
  const appliedSeed = (() => {
    if (appliedParams) {
      try {
        return (JSON.parse(appliedParams) as { seed?: string }).seed ?? "kouchou-ai";
      } catch {
        // fallthrough
      }
    }
    return umapParams.seed || "kouchou-ai";
  })();

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      abortRef.current?.abort();
    };
  }, []);

  // 保存済みの UMAP 座標があれば復元する(タブを閉じても UMAP を再計算しない)
  useEffect(() => {
    const emb = preprocessed?.emb;
    if (!emb || coords) return;
    const input = toUmapInput();
    const key = umapCheckpointKey({ count: emb.argIds.length, dim: emb.dim, ...input });
    dexieCheckpoints(projectId)
      .getChunk("umap", key)
      .then((saved: { x: Float32Array; y: Float32Array } | undefined) => {
        if (saved) {
          setCoords(saved);
          setUmapDone(true);
          setAppliedParams(JSON.stringify(input));
          setStatus("保存済みの UMAP 座標を復元しました");
        }
      });
  }, [preprocessed?.emb, coords, projectId, toUmapInput]);

  const buildCtx = useCallback(
    (persistent: boolean): PipelineContext | null => {
      if (!project) return null;
      abortRef.current = new AbortController();
      return {
        chat: project.settingsSnapshot.chat,
        embedding: project.settingsSnapshot.embedding,
        concurrency: project.settingsSnapshot.concurrency,
        signal: abortRef.current.signal,
        checkpoints: persistent ? dexieCheckpoints(projectId) : memoryCheckpoints(),
        onProgress: (event) => {
          if (event.total > 0) setStatus(`${event.step}: ${event.done}/${event.total}`);
        },
        onUsage: (u) => {
          usageRef.current = {
            input: usageRef.current.input + u.input,
            output: usageRef.current.output + u.output,
            total: usageRef.current.total + u.total,
          };
        },
      };
    },
    [project, projectId],
  );

  // 前処理(意見抽出+ベクトル化)を単独実行できるようにする
  const runPreprocess = async () => {
    const ctx = buildCtx(true);
    if (!project || !ctx) return;
    setError(null);
    try {
      setStatus("意見抽出中...");
      const ext = await extractionStep(project.comments, project.prompts.extraction, ctx);
      await dexieStepStore(projectId).put("extraction", ext);
      setStatus("ベクトル化中...");
      const emb = await embeddingStep(ext.args, ctx);
      await dexieStepStore(projectId).put("embedding", emb);
      setStatus("前処理完了");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runUmap = () => {
    const emb = preprocessed?.emb;
    if (!emb) return;
    const input = toUmapInput();
    setError(null);
    setUmapRunning(true);
    setUmapDone(false);
    setAssignments(null);
    setLabelsPreview(null);
    workerRef.current?.terminate();
    const worker = new Worker(new URL("../lib/workers/clustering.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === "coords") {
        setCoords({ x: message.x, y: message.y });
      } else if (message.type === "progress") {
        setStatus(`UMAP: ${message.epoch}/${message.totalEpochs}`);
      } else if (message.type === "done") {
        setCoords({ x: message.x, y: message.y });
        setUmapRunning(false);
        setUmapDone(true);
        setAppliedParams(JSON.stringify(input));
        setStatus("UMAP 完了 — スライダーでクラスタ数を調整できます");
        // UMAP 座標を逐次保存(タブが閉じられても失われない)。キーはパラメータ込み
        const key = umapCheckpointKey({ count: emb.argIds.length, dim: emb.dim, ...input });
        void dexieCheckpoints(projectId).putChunk("umap", key, { x: message.x, y: message.y });
        worker.terminate();
      } else if (message.type === "error") {
        setError(message.message);
        setUmapRunning(false);
        worker.terminate();
      }
    };
    const count = emb.argIds.length;
    const clamp = (n: number) => Math.max(2, Math.min(n, count));
    worker.postMessage({
      type: "run",
      input: {
        vectors: emb.vectors,
        dim: emb.dim,
        count,
        clusterNums: [...new Set([clamp(Math.min(lv1, lv2)), clamp(Math.max(lv1, lv2))])],
        ...input,
      },
    });
  };

  // スライダー変更時: 2D 座標上で KMeans + ward を即時再計算
  useEffect(() => {
    if (!umapDone || !coords || !preprocessed?.emb) return;
    const count = preprocessed.emb.argIds.length;
    const clamp = (n: number) => Math.max(2, Math.min(n, count));
    const nums = [...new Set([clamp(Math.min(lv1, lv2)), clamp(Math.max(lv1, lv2))])];
    const embedded: number[][] = new Array(count);
    for (let i = 0; i < count; i++) embedded[i] = [coords.x[i], coords.y[i]];
    const result = clusterXY(embedded, nums, appliedSeed);
    setAssignments(result.assignments);
    setLabelsPreview(null);
  }, [umapDone, coords, lv1, lv2, preprocessed?.emb, appliedSeed]);

  // ラベリング → レポート生成(オンデマンド)
  const runLabelling = async () => {
    const ctx = buildCtx(true);
    const ext = preprocessed?.ext;
    const emb = preprocessed?.emb;
    if (!project || !ctx || !ext || !emb || !coords || !assignments) return;
    setError(null);
    setLabelling(true);
    try {
      const clampN = (n: number) => Math.max(2, Math.min(n, emb.argIds.length));
      const nums = [...new Set([clampN(Math.min(lv1, lv2)), clampN(Math.max(lv1, lv2))])];
      const clusteringResult = {
        argIds: emb.argIds,
        x: coords.x,
        y: coords.y,
        clusterNums: nums,
        assignments,
      };
      const table = buildClusterTable(ext.args, clusteringResult);
      setStatus("ラベリング中...");
      const deepestLabels = await initialLabelling(table, project.prompts.initialLabelling, project.samplingNum, ctx);
      const labels = await mergeLabelling(
        table,
        deepestLabels,
        project.prompts.mergeLabelling,
        project.samplingNum,
        ctx,
      );
      setLabelsPreview(
        (labels.byLevel[1] ?? []).map((l) => ({
          id: l.clusterId,
          label: l.label,
          value: table.idsByLevel[0].filter((id) => id === l.clusterId).length,
        })),
      );
      setStatus("概要生成中...");
      const overviewText = await overviewStep(labels, project.prompts.overview, ctx);
      const result = aggregation({
        project,
        comments: project.comments,
        extractionResult: ext,
        table,
        labels,
        overviewText,
        chatModel: ctx.chat.model,
        embeddingModel: ctx.embedding.model,
        workers: ctx.concurrency,
      });
      const reportId = crypto.randomUUID();
      await db.reports.put({
        id: reportId,
        title: `${project.title} (${nums.join("-")})`,
        createdAt: Date.now(),
        result,
        tokenUsage: { ...usageRef.current },
        chatModel: ctx.chat.model,
      });
      const store = dexieStepStore(projectId);
      await store.put("clustering", clusteringResult);
      await store.put("aggregation", result);
      await db.projects.update(projectId, { status: "done", reportId });
      setStatus("レポート生成完了");
      navigate(`/report/${reportId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLabelling(false);
    }
  };

  const plotData = useMemo(() => {
    if (!coords) return [];
    const deepest = assignments ? assignments[assignments.length - 1] : null;
    const colors = deepest
      ? Array.from(
          deepest,
          (label) => SOFT_COLORS[((label % SOFT_COLORS.length) + SOFT_COLORS.length) % SOFT_COLORS.length],
        )
      : "#3fa9f5";
    return [
      {
        x: Array.from(coords.x),
        y: Array.from(coords.y),
        mode: "markers",
        type: "scattergl",
        marker: { size: 5, color: colors, opacity: 0.85 },
        hoverinfo: "skip",
        showlegend: false,
      },
    ];
  }, [coords, assignments]);

  const plotLayout = useMemo(
    () => ({
      margin: { l: 0, r: 0, b: 0, t: 0 },
      xaxis: { zeroline: false, showticklabels: false, showgrid: false },
      yaxis: { zeroline: false, showticklabels: false, showgrid: false },
      dragmode: "pan",
      showlegend: false,
    }),
    [],
  );

  if (!project) return <p>読み込み中...</p>;
  const hasPreprocess = !!(preprocessed?.ext && preprocessed?.emb);

  return (
    <div>
      <h1>{project.title} — クラスタリング再実行</h1>
      <p className="note">
        ベクトル化済みデータを使い、クラスタリング(UMAP + KMeans + ward)を再実行します。UMAP
        の収束をライブ表示しながらクラスタ数を対話的に調整でき、ラベリングは構成が決まってから実行します
        (同一構成のラベルはキャッシュされ無料)。
      </p>
      {error && <div className="error-box">{error}</div>}

      {!hasPreprocess && (
        <div className="card">
          <p>前処理済みデータがまだありません。ここで前処理だけを実行できます(LLM 呼び出しが発生します)。</p>
          <button type="button" className="primary" onClick={runPreprocess}>
            前処理を実行(意見抽出+ベクトル化)
          </button>
        </div>
      )}

      {hasPreprocess && (
        <>
          <div className="row card">
            <button
              type="button"
              className={paramsDirty ? "primary umap-dirty" : "primary"}
              onClick={runUmap}
              disabled={umapRunning}
            >
              {umapRunning
                ? "UMAP 実行中..."
                : paramsDirty
                  ? "UMAP 再実行(パラメータ変更あり)"
                  : coords
                    ? "UMAP 再実行"
                    : "UMAP 実行"}
            </button>
            <button
              type="button"
              title="意見抽出+ベクトル化の結果を元データごとファイルに保存(別ブラウザで後処理のみ再実行できます)"
              onClick={() => {
                if (preprocessed?.ext && preprocessed?.emb) {
                  exportPreprocessed(
                    {
                      title: project.title,
                      question: project.question,
                      intro: project.intro,
                      comments: project.comments,
                      attributeColumns: project.attributeColumns,
                      clusterNums: project.clusterNums,
                      samplingNum: project.samplingNum,
                      prompts: project.prompts,
                    },
                    preprocessed.ext,
                    preprocessed.emb,
                  );
                }
              }}
            >
              前処理データをエクスポート
            </button>
            <label style={{ margin: 0 }}>
              第1階層: {Math.min(lv1, lv2)}
              <input
                type="range"
                min={2}
                max={20}
                value={lv1}
                onChange={(e) => setLv1(Number(e.target.value))}
                style={{ width: 160 }}
              />
            </label>
            <label style={{ margin: 0 }}>
              第2階層: {Math.max(lv1, lv2)}
              <input
                type="range"
                min={4}
                max={Math.min(200, preprocessed.emb?.argIds.length ?? 200)}
                value={lv2}
                onChange={(e) => setLv2(Number(e.target.value))}
                style={{ width: 160 }}
              />
            </label>
            <button type="button" className="primary" onClick={runLabelling} disabled={!assignments || labelling}>
              {labelling ? "ラベリング中..." : "この構成でラベリング → レポート生成"}
            </button>
            <span className="note">{status}</span>
          </div>
          <details className="card" style={{ marginTop: 0 }}>
            <summary style={{ cursor: "pointer" }}>
              UMAP 詳細パラメータ{paramsDirty ? "(変更あり — 再実行で反映)" : ""}
            </summary>
            <div className="row" style={{ marginTop: 8 }}>
              <label style={{ margin: 0, fontWeight: 400 }}>
                nNeighbors: {umapParams.nNeighbors}
                <br />
                <input
                  type="range"
                  min={2}
                  max={100}
                  value={umapParams.nNeighbors}
                  onChange={(e) => setUmapParams((p) => ({ ...p, nNeighbors: Number(e.target.value) }))}
                  style={{ width: 160 }}
                />
                <span className="note"> 局所⇔大域</span>
              </label>
              <label style={{ margin: 0, fontWeight: 400 }}>
                minDist: {umapParams.minDist.toFixed(2)}
                <br />
                <input
                  type="range"
                  min={0}
                  max={0.99}
                  step={0.01}
                  value={umapParams.minDist}
                  onChange={(e) => setUmapParams((p) => ({ ...p, minDist: Number(e.target.value) }))}
                  style={{ width: 160 }}
                />
                <span className="note"> 密集⇔分散</span>
              </label>
              <label style={{ margin: 0, fontWeight: 400 }}>
                spread: {umapParams.spread.toFixed(1)}
                <br />
                <input
                  type="range"
                  min={0.5}
                  max={3}
                  step={0.1}
                  value={umapParams.spread}
                  onChange={(e) => setUmapParams((p) => ({ ...p, spread: Number(e.target.value) }))}
                  style={{ width: 160 }}
                />
                <span className="note"> 全体スケール</span>
              </label>
              <label style={{ margin: 0, fontWeight: 400 }}>
                epochs: {umapParams.nEpochs === 0 ? "自動" : umapParams.nEpochs}
                <br />
                <input
                  type="range"
                  min={0}
                  max={1000}
                  step={50}
                  value={umapParams.nEpochs}
                  onChange={(e) => setUmapParams((p) => ({ ...p, nEpochs: Number(e.target.value) }))}
                  style={{ width: 160 }}
                />
                <span className="note"> 反復回数(0=自動)</span>
              </label>
              <label style={{ margin: 0, fontWeight: 400 }}>
                シード
                <br />
                <input
                  value={umapParams.seed}
                  onChange={(e) => setUmapParams((p) => ({ ...p, seed: e.target.value }))}
                  style={{ width: 140 }}
                />
              </label>
            </div>
            <p className="note">
              パラメータ変更後は「UMAP 再実行」で反映されます(座標はパラメータごとにキャッシュされます)。
              クラスタ数のスライダーは再実行不要で即時反映です。
            </p>
          </details>
          <div className="viewer-chart" style={{ height: 520 }}>
            {coords ? (
              <Plot data={plotData} layout={plotLayout} config={{ scrollZoom: true }} />
            ) : (
              <p style={{ padding: 24 }} className="note">
                「UMAP 実行」を押すと、{preprocessed.emb?.argIds.length.toLocaleString()}{" "}
                件の意見の収束過程がここに表示されます。
              </p>
            )}
          </div>
          {labelsPreview && (
            <div className="card">
              <h2>第1階層ラベル</h2>
              <ul>
                {labelsPreview.map((l) => (
                  <li key={l.id}>
                    <b>{l.label}</b> ({l.value} 件)
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" onClick={() => navigate("/")}>
          一覧へ戻る
        </button>
      </div>
    </div>
  );
}
