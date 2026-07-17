import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { requestChat } from "../lib/llm/client";
import { fnv1a } from "../lib/pipeline/clusterTable";
import type { PipelineContext } from "../lib/pipeline/context";
import { navigate } from "../lib/router";
import { dexieCheckpoints } from "../lib/storage/checkpoints";
import { db } from "../lib/storage/db";
import { analyzeAttributes, computeAttributeSimilarities, encodeAttribute } from "../phase2/attributes";
import { type TrackedAssignment, trackClusters } from "../phase2/clusterTracker";
import { type EdgeSet, clusterByLayout, clusterByLouvain, computeEdgeWeights, subsetEdges } from "../phase2/graph";
import { STANCE_LABEL_JA, summarizeCluster } from "../phase2/labelTemplate";
import { buildEdgesWithWorker, preparePhase2Records } from "../phase2/prepare";
import { deserializeSample } from "../phase2/sample";
import type { ClusterView, Codebook, OpinionRecord } from "../phase2/types";
import { DEFAULT_VIEW, dominantStance, stanceScore } from "../phase2/types";
import { useSettings } from "../store/settings";
import type { EmbeddingResult, ExtractionResult } from "../types/project";
import { resolveEndpoint } from "../types/settings";
import { Plot } from "./viewer/Plot";
import { convexHull } from "./viewer/ScatterChart";
import { SOFT_COLORS, wrapLabelText } from "./viewer/colors";

// フェーズ2: インタラクティブ再クラスタリング(次世代版)。
// - クラスタは固定分類ではなく、重み付けから都度生成される「ビュー」
// - スライダー操作では候補辺の再重み付けのみ(LLM は呼ばない)
// - stance/reason はレビュー必須修正どおり focus+context(選択クラスタ内)でのみ有効
// - 属性軸: 数値属性は範囲正規化距離で分離強度を調整、カテゴリカルは色分け+δ一致
// - projectId === "sample" のときは事前分析済みサンプルを読み込む(LLM 不要)

type Coords = { x: Float32Array; y: Float32Array };

export function Phase2Page({ projectId }: { projectId: string }) {
  const isSample = projectId === "sample";
  const project = useLiveQuery(() => (isSample ? undefined : db.projects.get(projectId)), [projectId, isSample]);
  const preprocessed = useLiveQuery(
    async () => {
      if (isSample) return { ext: undefined, emb: undefined };
      const ext = (await db.stepResults.get([projectId, "extraction"]))?.data as ExtractionResult | undefined;
      const emb = (await db.stepResults.get([projectId, "embedding"]))?.data as EmbeddingResult | undefined;
      return { ext, emb };
    },
    [projectId, isSample],
    { ext: undefined, emb: undefined },
  );
  const { settings } = useSettings();

  const [title, setTitle] = useState<string>("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [records, setRecords] = useState<OpinionRecord[] | null>(null);
  const [codebook, setCodebook] = useState<Codebook | null>(null);
  const [edges, setEdges] = useState<EdgeSet | null>(null);
  const [coords, setCoords] = useState<Coords | null>(null);
  const [view, setView] = useState<ClusterView>(DEFAULT_VIEW);
  const [assignment, setAssignment] = useState<TrackedAssignment | null>(null);
  const [colorMode, setColorMode] = useState<"cluster" | "attribute">("cluster");
  // 凸包は既定オフ(通常版ビューアと同じ)。グラフクラスタは全体ビューでは空間的に
  // 重なりやすく、「見た目で切り直す」後やドリルダウン時に有用
  const [showHull, setShowHull] = useState(false);
  // トピック絞り込み(ドリルダウン)。indices はグローバルインデックス。
  // 混在したままの全体 UMAP ではなく、トピックを選んでから全キャンバスで軸分離する
  const [scope, setScope] = useState<{ indices: number[]; label: string } | null>(null);
  const [explanation, setExplanation] = useState<{ clusterId: string; text: string } | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [savedViews, setSavedViews] = useState<ClusterView[]>([]);

  const layoutWorkerRef = useRef<Worker | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const assignmentRef = useRef<TrackedAssignment | null>(null);
  assignmentRef.current = assignment;
  const attrSimCacheRef = useRef<Map<string, Float32Array>>(new Map());
  // 全体ビューの座標スナップショット(ドリルダウンから戻るときの復元用)
  const globalCoordsRef = useRef<Coords | null>(null);

  // スコープ適用後のレコードと辺(ドリルダウン中は部分集合)
  const activeRecords = useMemo(
    () => (records && scope ? scope.indices.map((i) => records[i]) : records),
    [records, scope],
  );
  const activeEdges = useMemo(() => (edges && scope ? subsetEdges(edges, scope.indices) : edges), [edges, scope]);

  useEffect(() => {
    return () => {
      layoutWorkerRef.current?.terminate();
      abortRef.current?.abort();
    };
  }, []);

  // 解説等の LLM 呼び出し先: プロジェクトのスナップショット、サンプルでは現在の設定
  const chatEndpoint = useMemo(
    () => (isSample || !project ? resolveEndpoint(settings, "chat") : project.settingsSnapshot.chat),
    [isSample, project, settings],
  );

  const checkpointsId = isSample ? "phase2-sample" : projectId;

  const buildCtx = useCallback((): PipelineContext | null => {
    if (!isSample && !project) return null;
    abortRef.current = new AbortController();
    return {
      chat: chatEndpoint,
      embedding: isSample || !project ? resolveEndpoint(settings, "embedding") : project.settingsSnapshot.embedding,
      concurrency: project?.settingsSnapshot.concurrency ?? 8,
      signal: abortRef.current.signal,
      checkpoints: dexieCheckpoints(checkpointsId),
    };
  }, [isSample, project, chatEndpoint, settings, checkpointsId]);

  // ---- サンプルモード: 事前分析済みデータを読み込むだけで動く ----
  useEffect(() => {
    if (!isSample || records) return;
    (async () => {
      try {
        setStatus("サンプルデータ読み込み中...");
        const response = await fetch(`${import.meta.env.BASE_URL}sample-phase2.json`);
        if (!response.ok) throw new Error(`サンプルの取得に失敗 (HTTP ${response.status})`);
        const sample = deserializeSample(await response.json());
        setTitle(sample.title);
        setRecords(sample.records);
        setCodebook(sample.codebook);
        setEdges(sample.edges);
        setCoords({ x: sample.coords.x.slice(), y: sample.coords.y.slice() });
        startLayout(sample.coords, sample.records, sample.edges);
        setStatus("サンプル準備完了 — スライダーで再クラスタリングできます");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [isSample, records]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- データ準備(enrich → codebook → 候補辺 → 初期座標) ----
  const prepare = async () => {
    const ctx = buildCtx();
    const ext = preprocessed?.ext;
    const emb = preprocessed?.emb;
    if (!ctx || !ext || !emb || !project) return;
    setPreparing(true);
    setError(null);
    try {
      const attributesByComment = new Map(project.comments.map((c) => [c.commentId, c.attributes]));
      const { records: recs, codebook: cb } = await preparePhase2Records(ext, ctx, (message, done, total) =>
        setStatus(total ? `${message} ${done}/${total}` : message),
      );
      for (const record of recs) {
        record.attributes = attributesByComment.get(record.originalCommentId);
      }
      setRecords(recs);
      setCodebook(cb);
      const edgeSet = await buildEdgesWithWorker(recs, emb, ctx, (message, done, total) =>
        setStatus(total ? `${message} ${done}/${total}` : message),
      );
      setEdges(edgeSet);

      // 初期座標: 通常版の UMAP チェックポイントを再利用。無ければ計算
      const { umapCheckpointKey } = await import("../lib/pipeline/steps/clustering");
      const key = umapCheckpointKey({ count: emb.argIds.length, dim: emb.dim, seed: "kouchou-ai" });
      const saved: Coords | undefined = await dexieCheckpoints(projectId).getChunk("umap", key);
      let initial: Coords;
      if (saved) {
        initial = saved;
      } else {
        setStatus("初期レイアウト計算(UMAP)...");
        initial = await runUmapOnce(emb, (done, total) => setStatus(`初期レイアウト計算(UMAP)${done}/${total}`));
        await dexieCheckpoints(projectId).putChunk("umap", key, initial);
      }
      setCoords({ x: initial.x.slice(), y: initial.y.slice() });
      startLayout(initial, recs, edgeSet);
      setStatus("準備完了 — スライダーで再クラスタリングできます");
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setPreparing(false);
    }
  };

  function runUmapOnce(emb: EmbeddingResult, onProgress: (done: number, total: number) => void): Promise<Coords> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("../lib/workers/clustering.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event) => {
        const message = event.data;
        if (message.type === "progress") onProgress(message.epoch, message.totalEpochs);
        else if (message.type === "done") {
          worker.terminate();
          resolve({ x: message.x, y: message.y });
        } else if (message.type === "error") {
          worker.terminate();
          reject(new Error(message.message));
        }
      };
      worker.postMessage({
        type: "run",
        input: { vectors: emb.vectors, dim: emb.dim, count: emb.argIds.length, clusterNums: [2], seed: "kouchou-ai" },
      });
    });
  }

  // ---- レイアウト Worker ----
  const startLayout = (
    initial: Coords,
    recs: OpinionRecord[],
    edgeSet: EdgeSet,
    viewForRecluster: ClusterView = DEFAULT_VIEW,
    topicConditioned = false,
  ) => {
    layoutWorkerRef.current?.terminate();
    const worker = new Worker(new URL("../phase2/workers/layout.worker.ts", import.meta.url), { type: "module" });
    layoutWorkerRef.current = worker;
    let pending: Coords | null = null;
    let rafScheduled = false;
    worker.onmessage = (event) => {
      if (event.data.type !== "coords") return;
      pending = { x: event.data.x, y: event.data.y };
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(() => {
          rafScheduled = false;
          if (pending) setCoords(pending);
        });
      }
    };
    worker.postMessage({ type: "init", x: initial.x, y: initial.y });
    recluster(recs, edgeSet, viewForRecluster, null, worker, topicConditioned);
  };

  // ---- 属性類似度(選択された属性の辺類似度をキャッシュ) ----
  const attributeInfos = useMemo(() => (activeRecords ? analyzeAttributes(activeRecords) : []), [activeRecords]);

  const attributeSimsFor = useCallback(
    (key: string | null, recs: OpinionRecord[], edgeSet: EdgeSet): Float32Array | null => {
      if (!key) return null;
      const cached = attrSimCacheRef.current.get(key);
      if (cached) return cached;
      const info = attributeInfos.find((a) => a.key === key);
      if (!info) return null;
      const encoded = encodeAttribute(recs, info);
      const sims = computeAttributeSimilarities(edgeSet, encoded, info.type);
      attrSimCacheRef.current.set(key, sims);
      return sims;
    },
    [attributeInfos],
  );

  // ---- 再クラスタリング(スライダー操作時。LLM は呼ばない) ----
  const recluster = useCallback(
    (
      recs: OpinionRecord[],
      edgeSet: EdgeSet,
      nextView: ClusterView,
      current: TrackedAssignment | null,
      worker?: Worker | null,
      topicConditioned = false,
    ) => {
      const membership = current?.labels ?? null;
      const attrSims = nextView.attributeWeight > 0 ? attributeSimsFor(nextView.attributeKey, recs, edgeSet) : null;
      const weights = computeEdgeWeights(edgeSet, nextView, membership, attrSims, topicConditioned);
      const communities = clusterByLouvain(recs.length, edgeSet, weights, nextView, membership);
      const frozen =
        nextView.selectedClusterId !== null && membership !== null
          ? membership.map((label) => label !== nextView.selectedClusterId)
          : undefined;
      const tracked = trackClusters(communities, current, frozen);
      setAssignment(tracked);

      const layoutWorker = worker ?? layoutWorkerRef.current;
      layoutWorker?.postMessage({
        type: "edges",
        source: edgeSet.source,
        target: edgeSet.target,
        weights,
        threshold: nextView.edgeThreshold,
      });
      if (nextView.stanceAxisEnabled) {
        const scores = new Float32Array(recs.map((r) => stanceScore(r.enrichment.stance)));
        layoutWorker?.postMessage({ type: "stanceAxis", enabled: true, scores, lambda: 0.15 });
      } else {
        layoutWorker?.postMessage({ type: "stanceAxis", enabled: false, scores: null, lambda: 0 });
      }
    },
    [attributeSimsFor],
  );

  // ビュー変更をデバウンスして再クラスタリング
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const updateView = (patch: Partial<ClusterView>) => {
    const next = { ...view, ...patch };
    setView(next);
    if (!activeRecords || !activeEdges) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(
      () => recluster(activeRecords, activeEdges, next, assignmentRef.current, null, scopeRef.current !== null),
      250,
    );
  };

  // 現在の 2D 配置からクラスタを切り直す(UMAP が視覚的に分離した塊とクラスタ色を一致させる)。
  // 通常の再クラスタリングは特徴グラフに対する Louvain なので、見た目の分離とはずれることがある
  const reclusterFromLayout = () => {
    const current = coordsRef.current;
    if (!activeRecords || !current || current.x.length !== activeRecords.length) return;
    const communities = clusterByLayout(current.x, current.y, view.resolution);
    setAssignment(trackClusters(communities, assignmentRef.current));
  };

  // ---- トピック絞り込み(ドリルダウン) ----
  const coordsRef = useRef<Coords | null>(null);
  coordsRef.current = coords;

  const enterScope = (indices: number[], label: string) => {
    if (!records || !edges || !coordsRef.current || indices.length < 5) return;
    // 全体ビューの座標を保存(戻るとき用。既にスコープ中なら保存済みのものを維持)
    if (!scope) globalCoordsRef.current = { x: coordsRef.current.x.slice(), y: coordsRef.current.y.slice() };
    // 現在の表示座標から部分集合を切り出してウォームスタート(連続的な遷移)
    const current = coordsRef.current;
    const globalIndices = scope ? indices.map((local) => scope.indices[local]) : indices;
    const subX = new Float32Array(globalIndices.length);
    const subY = new Float32Array(globalIndices.length);
    // スコープ中にさらに絞る場合、current はローカル座標なので indices(ローカル)で引く
    indices.forEach((idx, k) => {
      subX[k] = current.x[idx];
      subY[k] = current.y[idx];
    });
    attrSimCacheRef.current = new Map();
    setScope({ indices: globalIndices, label });
    setAssignment(null);
    setExplanation(null);
    const nextView = { ...view, selectedClusterId: null };
    setView(nextView);
    setCoords({ x: subX.slice(), y: subY.slice() });
    const subRecords = globalIndices.map((i) => records[i]);
    const subEdgeSet = subsetEdges(edges, globalIndices);
    startLayout({ x: subX, y: subY }, subRecords, subEdgeSet, nextView, true);
  };

  const exitScope = () => {
    if (!records || !edges) return;
    attrSimCacheRef.current = new Map();
    setScope(null);
    setAssignment(null);
    setExplanation(null);
    const nextView = { ...view, selectedClusterId: null, stanceWeight: 0, reasonWeight: 0 };
    setView(nextView);
    const initial = globalCoordsRef.current;
    if (initial) {
      setCoords({ x: initial.x.slice(), y: initial.y.slice() });
      startLayout(initial, records, edges, nextView, false);
    }
  };

  // コードブックのトピック別件数(ドリルダウンの選択肢)
  const topicCounts = useMemo(() => {
    if (!records || !codebook) return [];
    const counts = new Map<number, number>();
    for (const record of records) {
      let top = -1;
      let topWeight = 0;
      for (const [index, weight] of record.topicVector) {
        if (weight > topWeight) {
          top = index;
          topWeight = weight;
        }
      }
      if (top >= 0) counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([index, count]) => ({ index, label: codebook.topics[index] ?? "?", count }));
  }, [records, codebook]);

  const drillToTopic = (topicIndex: number) => {
    if (!records || !codebook) return;
    // スコープはグローバル基準で選ぶ(現在のスコープからではなく全体から)
    if (scope) exitScope();
    const indices: number[] = [];
    records.forEach((record, i) => {
      let top = -1;
      let topWeight = 0;
      for (const [index, weight] of record.topicVector) {
        if (weight > topWeight) {
          top = index;
          topWeight = weight;
        }
      }
      if (top === topicIndex || (record.topicVector.get(topicIndex) ?? 0) >= 0.5) indices.push(i);
    });
    // exitScope 直後は coords がグローバルに戻っているため、次のフレームで enter する
    setTimeout(() => enterScopeGlobal(indices, codebook.topics[topicIndex] ?? "トピック"), 50);
  };

  // グローバルインデックスで直接スコープに入る(drillToTopic 用)
  const enterScopeGlobal = (globalIndices: number[], label: string) => {
    if (!records || !edges || globalIndices.length < 5) return;
    const base = globalCoordsRef.current ?? coordsRef.current;
    if (!base) return;
    if (!scopeRef.current) globalCoordsRef.current = { x: base.x.slice(), y: base.y.slice() };
    const subX = new Float32Array(globalIndices.length);
    const subY = new Float32Array(globalIndices.length);
    globalIndices.forEach((idx, k) => {
      subX[k] = base.x[idx];
      subY[k] = base.y[idx];
    });
    attrSimCacheRef.current = new Map();
    setScope({ indices: globalIndices, label });
    setAssignment(null);
    setExplanation(null);
    const nextView = { ...view, selectedClusterId: null };
    setView(nextView);
    setCoords({ x: subX.slice(), y: subY.slice() });
    const subRecords = globalIndices.map((i) => records[i]);
    const subEdgeSet = subsetEdges(edges, globalIndices);
    startLayout({ x: subX, y: subY }, subRecords, subEdgeSet, nextView, true);
  };

  // ---- クラスタ要約(テンプレートラベル) ----
  const clusterSummaries = useMemo(() => {
    if (!activeRecords || !codebook || !assignment) return [];
    const byLabel = new Map<string, number[]>();
    assignment.labels.forEach((label, i) => {
      if (label === null) return;
      const list = byLabel.get(label) ?? [];
      list.push(i);
      byLabel.set(label, list);
    });
    return [...byLabel.entries()]
      .filter(([, members]) => members.length >= 3)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 30)
      .map(([clusterId, members]) => ({ clusterId, members, ...summarizeCluster(members, activeRecords, codebook) }));
  }, [activeRecords, codebook, assignment]);

  // ---- 散布図 ----
  const colorByCluster = useMemo(() => {
    const map = new Map<string, string>();
    clusterSummaries.forEach((summary, index) => {
      map.set(summary.clusterId, SOFT_COLORS[index % SOFT_COLORS.length]);
    });
    return map;
  }, [clusterSummaries]);

  // 属性色分け: 数値はグラデーション、カテゴリカルはパレット
  const attributeColors = useMemo(() => {
    if (colorMode !== "attribute" || !activeRecords || !view.attributeKey) return null;
    const info = attributeInfos.find((a) => a.key === view.attributeKey);
    if (!info) return null;
    const encoded = encodeAttribute(activeRecords, info);
    return activeRecords.map((_, i) => {
      const v = encoded[i];
      if (v < 0) return "#cccccc";
      if (info.type === "numeric") {
        // 青(低)→赤(高)
        const r = Math.round(60 + v * 180);
        const b = Math.round(240 - v * 180);
        return `rgb(${r},90,${b})`;
      }
      return SOFT_COLORS[Math.round(v) % SOFT_COLORS.length];
    });
  }, [colorMode, activeRecords, view.attributeKey, attributeInfos]);

  const plotData = useMemo(() => {
    if (!activeRecords || !coords) return [];
    const colors = activeRecords.map((_, i) => {
      const label = assignment?.labels[i];
      if (view.selectedClusterId && label !== view.selectedClusterId) return "#d8d8d8";
      if (attributeColors) return attributeColors[i];
      return (label && colorByCluster.get(label)) || "#bbbbbb";
    });
    // biome-ignore lint/suspicious/noExplicitAny: Plotly trace
    const traces: any[] = [];
    // 凸包(SVG scatter は WebGL の背面に描画される。通常版ビューアと同じ方式)
    if (showHull) {
      for (const summary of clusterSummaries) {
        if (view.selectedClusterId && summary.clusterId !== view.selectedClusterId) continue;
        const points = summary.members.map((i) => [coords.x[i], coords.y[i]] as [number, number]);
        const hull = convexHull(points);
        if (hull.length < 3) continue;
        const color = colorByCluster.get(summary.clusterId) ?? "#888";
        traces.push({
          x: [...hull.map((p) => p[0]), hull[0][0]],
          y: [...hull.map((p) => p[1]), hull[0][1]],
          mode: "lines",
          fill: "toself",
          fillcolor: `${color}22`,
          line: { color, width: 1.5 },
          type: "scatter",
          hoveron: "fills",
          hoverinfo: "text",
          text: summary.label,
          hoverlabel: { bgcolor: color, bordercolor: color, font: { color: "white", size: 13 } },
          showlegend: false,
        });
      }
    }
    return [
      ...traces,
      {
        x: Array.from(coords.x),
        y: Array.from(coords.y),
        mode: "markers",
        type: "scattergl",
        marker: { size: 5, color: colors, opacity: 0.85 },
        text: activeRecords.map((r) => {
          const stance = STANCE_LABEL_JA[dominantStance(r.enrichment.stance)];
          const attrs = r.attributes
            ? `<br>${Object.entries(r.attributes)
                .map(([k, v]) => `${k}: ${v}`)
                .join(" / ")}`
            : "";
          return `${r.claimText.replace(/(.{28})/g, "$1<br />")}<br><b>立場: ${stance}</b>${attrs}`;
        }),
        hoverinfo: "text",
        hoverlabel: { align: "left", bgcolor: "white", font: { size: 12, color: "#333" } },
        customdata: activeRecords.map((_, i) => i),
        showlegend: false,
      },
    ];
  }, [
    activeRecords,
    coords,
    assignment,
    colorByCluster,
    attributeColors,
    view.selectedClusterId,
    showHull,
    clusterSummaries,
  ]);

  const annotations = useMemo(() => {
    if (!coords) return [];
    return clusterSummaries.slice(0, 12).map((summary) => {
      let cx = 0;
      let cy = 0;
      for (const i of summary.members) {
        cx += coords.x[i];
        cy += coords.y[i];
      }
      cx /= summary.members.length;
      cy /= summary.members.length;
      const color = colorByCluster.get(summary.clusterId) ?? "#888";
      return {
        x: cx,
        y: cy,
        text: wrapLabelText(summary.label, 12, 180),
        showarrow: false,
        font: { color: "white", size: 12 },
        bgcolor: `${color}cc`,
        borderpad: 6,
        align: "left" as const,
      };
    });
  }, [clusterSummaries, coords, colorByCluster]);

  // ---- クラスタ選択(focus+context) ----
  const selectCluster = (clusterId: string | null) => {
    setExplanation(null);
    updateView({
      selectedClusterId: clusterId,
      ...(clusterId === null ? { stanceWeight: 0, reasonWeight: 0 } : {}),
    });
  };

  // ---- LLM 解説(オンデマンド・構成ハッシュでキャッシュ) ----
  const explainCluster = async (clusterId: string) => {
    const summary = clusterSummaries.find((s) => s.clusterId === clusterId);
    if (!summary || !activeRecords || !chatEndpoint.baseUrl) return;
    setExplaining(true);
    try {
      const checkpoints = dexieCheckpoints(checkpointsId);
      const compositionKey = fnv1a(summary.members.map((i) => activeRecords[i].id).join(" "));
      const cached = await checkpoints.getChunk("phase2-explain", compositionKey);
      if (typeof cached === "string") {
        setExplanation({ clusterId, text: cached });
        return;
      }
      const stanceText = Object.entries(summary.stanceMix)
        .map(([key, count]) => `${STANCE_LABEL_JA[key as keyof typeof STANCE_LABEL_JA]}: ${count}件`)
        .join(", ");
      const input = [
        `クラスタ件数: ${summary.size}`,
        `上位トピック: ${summary.topTopics.map((t) => t.label).join(", ")}`,
        `stance 分布: ${stanceText}`,
        `上位論点: ${summary.topReasons.map((r) => r.label).join(", ")}`,
        "代表的な意見:",
        ...summary.representatives.map((i) => `- ${activeRecords[i].claimText}`),
      ].join("\n");
      const text = await requestChat(chatEndpoint, {
        messages: [
          {
            role: "system",
            content:
              "あなたは意見分析の専門家です。以下の意見クラスタの特徴を、立場の内訳(賛成/条件付き/非反対など)の違いに注意しながら3〜4文で解説してください。",
          },
          { role: "user", content: input },
        ],
      });
      await checkpoints.putChunk("phase2-explain", compositionKey, text);
      setExplanation({ clusterId, text });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExplaining(false);
    }
  };

  // ---- ビュー定義の保存/復元 ----
  useEffect(() => {
    dexieCheckpoints(checkpointsId)
      .getChunk("phase2-views", "list")
      .then((saved) => {
        if (Array.isArray(saved)) setSavedViews(saved);
      });
  }, [checkpointsId]);

  const saveCurrentView = async () => {
    const name = prompt("ビュー名を入力してください", view.name);
    if (!name) return;
    const next = [...savedViews.filter((v) => v.name !== name), { ...view, name }];
    setSavedViews(next);
    await dexieCheckpoints(checkpointsId).putChunk("phase2-views", "list", next);
  };

  if (!isSample && !project) return <p>読み込み中...</p>;
  const hasPreprocess = isSample || !!(preprocessed?.ext && preprocessed?.emb);
  const ready = !!(records && edges && coords);
  const selectedAttrInfo = attributeInfos.find((a) => a.key === view.attributeKey);

  return (
    <div>
      <h1>{isSample ? title || "サンプル" : project?.title} — 次世代版</h1>
      <p className="note">
        クラスタは固定分類ではなく、重み付けから都度生成される「ビュー」です。スライダー操作は LLM
        を呼ばず、候補グラフの再重み付けだけで点群が連続的に再編されます。スタンス/理由の重みは、
        クラスタを選択したときにそのクラスタ内だけに適用されます(focus+context)。 詳しい仕組みは{" "}
        <a href="#/phase2/about">アルゴリズム解説</a> へ。
      </p>
      {error && <div className="error-box">{error}</div>}

      {!hasPreprocess && (
        <div className="card">
          <p>前処理(意見抽出+ベクトル化)がまだありません。先に通常版の実行画面で前処理を済ませてください。</p>
          <button type="button" className="primary" onClick={() => navigate(`/run/${projectId}`)}>
            実行画面へ
          </button>
        </div>
      )}

      {hasPreprocess && !ready && !isSample && (
        <div className="card">
          <p>
            フェーズ2のデータ準備を行います: 構造化抽出(意見 {preprocessed?.ext?.args.length.toLocaleString()} 件 ×
            チャット1回) → タグ統合 → 候補グラフ構築。
            <br />
            <span className="note">
              使用モデル: {chatEndpoint.model}(推奨: gpt-5-mini — Phase 0 検証で stance 分類 19/19 全問正解)。
              抽出結果は保存され、再実行時はスキップされます。
            </span>
          </p>
          <button type="button" className="primary" onClick={prepare} disabled={preparing}>
            {preparing ? "準備中..." : "フェーズ2データを準備"}
          </button>
          <span className="note" style={{ marginLeft: 12 }}>
            {status}
          </span>
        </div>
      )}
      {isSample && !ready && <p className="note">{error ?? status}</p>}

      {ready && (
        <>
          <div className="card">
            <div className="row" style={{ marginBottom: 8 }}>
              <b>表示範囲:</b>
              {scope === null ? (
                <>
                  <span>全体({activeRecords?.length.toLocaleString()} 意見)</span>
                  <select
                    style={{ width: "auto" }}
                    value=""
                    onChange={(e) => {
                      if (e.target.value !== "") drillToTopic(Number(e.target.value));
                    }}
                  >
                    <option value="">トピックで絞り込む...</option>
                    {topicCounts.map((topic) => (
                      <option key={topic.index} value={topic.index}>
                        {topic.label} ({topic.count})
                      </option>
                    ))}
                  </select>
                  <span className="note">
                    トピックを絞ってから軸分離すると、全キャンバスを使った明瞭な分離になります
                  </span>
                </>
              ) : (
                <>
                  <span>
                    <b>{scope.label}</b>({scope.indices.length.toLocaleString()} 意見)
                  </span>
                  <button type="button" onClick={exitScope}>
                    ← 全体に戻る
                  </button>
                  <span className="note">スタンス/理由/属性スライダーがこの範囲に直接使えます</span>
                </>
              )}
            </div>
            <div className="row">
              <b
                style={{ minWidth: 110 }}
                title="意見同士の「近さ」をどの軸で測るか。UMAP レイアウトとクラスタリングの両方に効きます"
              >
                分離の重み
              </b>
              <Slider
                label="意味"
                value={view.semanticWeight}
                max={2}
                hint="意見本文の文脈埋め込みベクトルのコサイン類似度。上げるほど「似た内容の文章」が寄ります"
                onChange={(v) => updateView({ semanticWeight: v })}
              />
              <Slider
                label="トピック"
                value={view.topicWeight}
                max={2}
                hint="LLM が各意見に付けたトピックタグ(何について話しているか)の一致度。埋め込みではなく、全意見から集めて正規化した統制語彙(コードブック)のタグベクトルです"
                onChange={(v) => updateView({ topicWeight: v })}
              />
              <Slider
                label="スタンス"
                value={view.stanceWeight}
                max={3}
                disabled={view.selectedClusterId === null && scope === null}
                hint="7段階の賛否分布の近さ。上げると賛成派と反対派が分かれます。トピックが混在すると壊れるため、クラスタ選択またはトピック絞り込み中のみ有効"
                onChange={(v) => updateView({ stanceWeight: v })}
              />
              <Slider
                label="理由"
                value={view.reasonWeight}
                max={3}
                disabled={view.selectedClusterId === null && scope === null}
                hint="賛否の根拠として挙げている理由タグ(「安全性への懸念」「コスト」等)の一致度。スタンスとは独立で、賛成派と反対派が同じ理由を挙げているケースも束ねられます。クラスタ選択またはトピック絞り込み中のみ有効"
                onChange={(v) => updateView({ reasonWeight: v })}
              />
              {attributeInfos.length > 0 && (
                <>
                  <label
                    style={{ margin: 0, fontWeight: 400 }}
                    title="回答者の属性(年齢・職業など)による分離。数値属性は範囲正規化した距離、カテゴリカル属性は一致/不一致で近さを測ります"
                  >
                    属性軸:{" "}
                    <select
                      style={{ width: "auto" }}
                      value={view.attributeKey ?? ""}
                      onChange={(e) => {
                        const key = e.target.value || null;
                        updateView({ attributeKey: key, ...(key === null ? { attributeWeight: 0 } : {}) });
                      }}
                    >
                      <option value="">(なし)</option>
                      {attributeInfos.map((info) => (
                        <option key={info.key} value={info.key}>
                          {info.key} ({info.type === "numeric" ? "数値" : "カテゴリ"})
                        </option>
                      ))}
                    </select>
                  </label>
                  <Slider
                    label="分離強度"
                    value={view.attributeWeight}
                    max={3}
                    disabled={view.attributeKey === null}
                    hint="選択した属性の重み。数値属性(年齢等)は値が近い人同士が寄り、カテゴリカル属性は同カテゴリ同士が寄ります(カテゴリカルは断片化しやすいので色分け推奨)"
                    onChange={(v) => updateView({ attributeWeight: v })}
                  />
                </>
              )}
            </div>

            <div className="row" style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
              <b style={{ minWidth: 110 }} title="近さ(重み)の定義は変えず、クラスタの切り方と見せ方だけを調整します">
                クラスタと表示
              </b>
              <Slider
                label="解像度"
                value={view.resolution}
                min={0.4}
                max={2.5}
                hint="Louvain クラスタリングの resolution パラメータ。配置には影響せず、クラスタの切り方だけが変わります(上げる=細かく多く、下げる=粗く少なく)"
                onChange={(v) => updateView({ resolution: v })}
              />
              <Slider
                label="辺しきい値"
                value={view.edgeThreshold}
                max={0.8}
                hint="この重み以下の辺(意見間のつながり)を無視します。上げるとノイズの辺が消えてクラスタが分かれやすくなり、上げすぎると孤立点が増えます"
                onChange={(v) => updateView({ edgeThreshold: v })}
              />
              <label
                style={{ fontWeight: 400, margin: 0 }}
                title="レイアウトの X 軸を賛否スコアに寄せます(左=反対、右=賛成)"
              >
                <input
                  type="checkbox"
                  style={{ width: "auto", marginRight: 4 }}
                  checked={view.stanceAxisEnabled}
                  onChange={(e) => updateView({ stanceAxisEnabled: e.target.checked })}
                />
                X軸=賛否
              </label>
              <label style={{ fontWeight: 400, margin: 0 }} title="クラスタごとの凸包(なわばり)を半透明で表示します">
                <input
                  type="checkbox"
                  style={{ width: "auto", marginRight: 4 }}
                  checked={showHull}
                  onChange={(e) => setShowHull(e.target.checked)}
                />
                凸包
              </label>
              {attributeInfos.length > 0 && (
                <label
                  style={{ margin: 0, fontWeight: 400 }}
                  title="点の色をクラスタ別にするか、選択中の属性値別にするか"
                >
                  色分け:{" "}
                  <select
                    style={{ width: "auto" }}
                    value={colorMode}
                    onChange={(e) => setColorMode(e.target.value as "cluster" | "attribute")}
                  >
                    <option value="cluster">クラスタ</option>
                    <option value="attribute" disabled={view.attributeKey === null}>
                      属性値
                    </option>
                  </select>
                </label>
              )}
              <button
                type="button"
                onClick={reclusterFromLayout}
                title="現在の配置(2D座標)の近さでクラスタを切り直します。通常のクラスタリングは特徴グラフに対して自動で走りますが、レイアウトが視覚的に分離した塊を1クラスタのまま残すことがあるため、見た目とクラスタ色・ラベルを一致させたいときに押してください。粒度は「解像度」に従います"
              >
                見た目で切り直す
              </button>
              <button
                type="button"
                onClick={saveCurrentView}
                title="現在の重み設定に名前を付けて保存し、ワンクリックで再現できるようにします"
              >
                ビューを保存
              </button>
              {savedViews.map((saved) => (
                <button key={saved.name} type="button" onClick={() => updateView(saved)}>
                  {saved.name}
                </button>
              ))}
              {selectedAttrInfo?.type === "categorical" && (
                <span className="note">
                  カテゴリカル属性は色分けでの俯瞰を推奨(分離強度は一致/不一致の2値で断片化しやすい)
                </span>
              )}
            </div>

            {view.selectedClusterId === null ? (
              <p className="note">
                点をクリックするとクラスタを選択できます。スタンス/理由スライダーは選択中のクラスタ内
                またはトピック絞り込み中でのみ有効です(無関係なトピック同士を賛否で混ぜないため)。
              </p>
            ) : (
              <p className="note">
                選択中: <b>{clusterSummaries.find((s) => s.clusterId === view.selectedClusterId)?.label}</b> —
                スタンス/理由スライダーでこのクラスタが分裂します。{" "}
                <button type="button" onClick={() => selectCluster(null)}>
                  選択解除
                </button>{" "}
                <button
                  type="button"
                  onClick={() => {
                    const summary = clusterSummaries.find((s) => s.clusterId === view.selectedClusterId);
                    if (summary) enterScope(summary.members, summary.label);
                  }}
                  title="このクラスタだけを全キャンバスに展開して軸分離する"
                >
                  このクラスタにズーム
                </button>{" "}
                <button
                  type="button"
                  onClick={() => explainCluster(view.selectedClusterId as string)}
                  disabled={explaining || !chatEndpoint.baseUrl}
                  title={chatEndpoint.baseUrl ? "" : "設定画面でチャットプロバイダを設定すると使えます"}
                >
                  {explaining ? "解説生成中..." : "このクラスタを解説 (LLM)"}
                </button>
              </p>
            )}
            {explanation && explanation.clusterId === view.selectedClusterId && (
              <p style={{ whiteSpace: "pre-wrap", background: "#f8fafc", padding: 8, borderRadius: 8 }}>
                {explanation.text}
              </p>
            )}
            <p className="note">{status}</p>
          </div>

          <div className="viewer-chart" style={{ height: 560 }}>
            <Plot
              data={plotData}
              layout={{
                margin: { l: 0, r: 0, b: 0, t: 0 },
                xaxis: { zeroline: false, showticklabels: false, showgrid: false },
                yaxis: { zeroline: false, showticklabels: false, showgrid: false },
                dragmode: "pan",
                hovermode: "closest",
                annotations,
                showlegend: false,
              }}
              config={{ scrollZoom: true, displayModeBar: "hover" }}
              // biome-ignore lint/suspicious/noExplicitAny: Plotly event
              onClick={(event: any) => {
                const index = event?.points?.[0]?.customdata;
                if (typeof index === "number" && assignment) {
                  selectCluster(assignment.labels[index]);
                }
              }}
            />
          </div>

          <section className="viewer-clusters">
            <h2>クラスタ一覧({clusterSummaries.length})</h2>
            <div className="cluster-grid">
              {clusterSummaries.map((summary) => (
                <button
                  type="button"
                  key={summary.clusterId}
                  className={`cluster-card ${view.selectedClusterId === summary.clusterId ? "selected" : ""}`}
                  onClick={() => selectCluster(view.selectedClusterId === summary.clusterId ? null : summary.clusterId)}
                >
                  <h3>
                    <span style={{ color: colorByCluster.get(summary.clusterId) }}>●</span> {summary.label}
                  </h3>
                  <p className="cluster-value">{summary.size} 件</p>
                  <p className="cluster-takeaway">
                    {activeRecords &&
                      summary.representatives
                        .slice(0, 2)
                        .map((i) => activeRecords[i].claimText)
                        .join(" / ")}
                  </p>
                </button>
              ))}
            </div>
          </section>
        </>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" onClick={() => navigate("/phase2")}>
          プロジェクト選択へ戻る
        </button>
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  disabled = false,
  hint,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label style={{ fontWeight: 400, margin: 0, opacity: disabled ? 0.4 : 1 }} title={hint}>
      {label}
      {hint && <span style={{ cursor: "help", opacity: 0.6 }}>ⓘ</span>}: {value.toFixed(2)}
      <br />
      <input
        type="range"
        min={min}
        max={max}
        step={0.05}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: 130 }}
      />
    </label>
  );
}

/** フェーズ2のプロジェクト選択(トップレベルの「次世代版」から入る) */
export function Phase2Home() {
  const projects = useLiveQuery(() => db.projects.orderBy("createdAt").reverse().toArray(), []);
  return (
    <div>
      <h1>次世代版 — インタラクティブ再クラスタリング</h1>
      <p className="note">
        通常版とは別の分析モードです(クラスタリング方式が異なるため、結果は通常版のレポートとは混ざりません)。
        前処理(意見抽出+ベクトル化)済みのプロジェクトを選ぶか、事前分析済みサンプルですぐに試せます。 仕組みは{" "}
        <a href="#/phase2/about">アルゴリズム解説</a> を参照。
      </p>
      <div className="card">
        <h3>サンプルで試す(分析の実行不要)</h3>
        <p className="note">
          AI人権法案への意見 150 コメント(543意見)を事前分析済み。API
          キーなしでスライダー操作・クラスタ分裂を体験できます。
        </p>
        <button type="button" className="primary" onClick={() => navigate("/phase2/sample")}>
          サンプルを開く
        </button>
      </div>
      {(!projects || projects.length === 0) && (
        <p>
          プロジェクトがありません。まず <a href="#/new">新規レポート作成</a> で CSV を取り込み、
          実行画面で前処理を済ませてください。
        </p>
      )}
      <div className="report-grid">
        {projects?.map((project) => (
          <div key={project.id} className="card">
            <h3>{project.title}</h3>
            <p className="note">
              {project.comments.length.toLocaleString()} コメント / {project.status}
            </p>
            <button type="button" className="primary" onClick={() => navigate(`/phase2/${project.id}`)}>
              開く
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
