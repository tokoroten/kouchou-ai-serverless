import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { requestChat, Semaphore } from "../lib/llm/client";
import { parseLabelResponse } from "../lib/llm/jsonParse";
import { fnv1a } from "../lib/pipeline/clusterTable";
import { CacheMissError, type PipelineContext } from "../lib/pipeline/context";
import { navigate } from "../lib/router";
import { dexieCheckpoints } from "../lib/storage/checkpoints";
import { db, deleteStanceSpectrumProjectData } from "../lib/storage/db";
import { analyzeAttributes, computeAttributeSimilarities, encodeAttribute } from "../stance-spectrum/attributes";
import { type TrackedAssignment, trackClusters } from "../stance-spectrum/clusterTracker";
import { computeEdgeWeights, cutWardToK, type EdgeSet, subsetEdges } from "../stance-spectrum/graph";
import { STANCE_LABEL_JA, summarizeCluster } from "../stance-spectrum/labelTemplate";
import { buildEdgesWithWorker, prepareStanceSpectrumRecords } from "../stance-spectrum/prepare";
import { deserializeSample, serializeSample } from "../stance-spectrum/sample";
import {
  CHUNK_STEP,
  EXPORT_FILE_SUFFIX,
  PROJECT_KIND,
  projectNamespace,
  sampleNamespace,
} from "../stance-spectrum/storageKeys";
import type { ClusterView, Codebook, OpinionRecord } from "../stance-spectrum/types";
import { DEFAULT_VIEW, dominantStance, stanceScore } from "../stance-spectrum/types";
import { useSettings } from "../store/settings";
import type { EmbeddingResult } from "../types/project";
import { estimateActualCostUsd, resolveEndpoint } from "../types/settings";
import { SOFT_COLORS, wrapLabelText } from "./viewer/colors";
import { Plot } from "./viewer/Plot";
import { convexHull } from "./viewer/ScatterChart";

// 賛否スペクトラム分析(旧称: インタラクティブ再クラスタリング / 次世代版)。
// - クラスタは固定分類ではなく、重み付けから都度生成される「ビュー」
// - スライダー操作では候補辺の再重み付けのみ(LLM は呼ばない)
// - stance/reason は全体ビューでも使える(トピック類似度でゲート)。選択/絞り込み中はゲートを外す
// - 属性軸: 数値属性は範囲正規化距離で分離強度を調整、カテゴリカルは色分け+δ一致
// - projectId === "sample" のときは事前分析済みサンプルを読み込む(LLM 不要)

type Coords = { x: Float32Array; y: Float32Array };

// 同梱の事前分析済みサンプル(public/ の JSON)。projectId がこの id のときサンプルモードになる。
export const STANCE_SPECTRUM_SAMPLES = [
  {
    id: "sample",
    file: "sample-stance-spectrum.json",
    title: "AI人権法案への意見(150コメント・543意見)",
    note: "スライダー操作・クラスタ分裂は API キーなしで体験できます(LLM ラベル生成のみ設定が必要)。",
  },
  {
    id: "sample-survey",
    file: "sample-stance-spectrum-survey.json",
    title: "仮想アンケート 2,000件(3,098意見)",
    note: "大きめの実データ。Ward クラスタリングや属性軸を試せます(約8MB・初回読み込みは少し時間がかかります)。",
  },
] as const;

export function StanceSpectrumPage({ projectId }: { projectId: string }) {
  const sampleDef = STANCE_SPECTRUM_SAMPLES.find((s) => s.id === projectId);
  const isSample = !!sampleDef;
  const project = useLiveQuery(() => (isSample ? undefined : db.projects.get(projectId)), [projectId, isSample]);
  const { settings } = useSettings();

  const [title, setTitle] = useState<string>("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  // 保存済みチェックポイントからの自動復元中(API は呼ばない)
  const [restoring, setRestoring] = useState(false);
  // 復元だけでは足りず、API を使う準備が必要だと分かった
  const [needsApiPreparation, setNeedsApiPreparation] = useState(false);
  // データ準備で消費した累計トークン(意見抽出+enrich+コードブック+埋め込み)
  const [usage, setUsage] = useState({ input: 0, output: 0, total: 0 });
  const [records, setRecords] = useState<OpinionRecord[] | null>(null);
  const [codebook, setCodebook] = useState<Codebook | null>(null);
  const [edges, setEdges] = useState<EdgeSet | null>(null);
  const [coords, setCoords] = useState<Coords | null>(null);
  const [view, setView] = useState<ClusterView>(DEFAULT_VIEW);
  const [assignment, setAssignment] = useState<TrackedAssignment | null>(null);
  const [colorMode, setColorMode] = useState<"cluster" | "attribute">("cluster");
  // 凸包(クラスタのなわばり)は既定オン。グラフクラスタは全体ビューでは空間的に
  // 重なりやすく、なわばりを見せた方がクラスタの範囲を掴みやすい
  const [showHull, setShowHull] = useState(true);
  // トピック絞り込み(ドリルダウン)。indices はグローバルインデックス。
  // 混在したままの全体 UMAP ではなく、トピックを選んでから全キャンバスで軸分離する
  const [scope, setScope] = useState<{ indices: number[]; label: string } | null>(null);
  const [explanation, setExplanation] = useState<{ clusterId: string; text: string } | null>(null);
  const [explaining, setExplaining] = useState(false);
  // LLM 生成のラベル/説明(clusterId → {label, description})。ボタンで生成、構成ハッシュでキャッシュ。
  const [llmLabels, setLlmLabels] = useState<Map<string, { label: string; description: string }>>(new Map());
  const [labeling, setLabeling] = useState(false);
  const [savedViews, setSavedViews] = useState<ClusterView[]>([]);

  // 自動復元は1プロジェクトにつき1回だけ試す(失敗後にループしないため)
  const restoreAttemptedRef = useRef(false);
  const layoutWorkerRef = useRef<Worker | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const assignmentRef = useRef<TrackedAssignment | null>(null);
  assignmentRef.current = assignment;
  const attrSimCacheRef = useRef<Map<string, Float32Array>>(new Map());
  // 全体ビューの座標スナップショット(ドリルダウンから戻るときの復元用)
  const globalCoordsRef = useRef<Coords | null>(null);
  // 初期 UMAP 座標の原本(スライダー操作で変化しない)。レイアウトのやり直しに使う。
  // ウォームスタートは現在座標から局所最適化を再開するため経路依存になり、重みを
  // 元に戻しても元のレイアウトには戻らない。ここから焼き直せば、重みに対して
  // 決定的な(乱数シードは固定)レイアウトが得られる。
  const initialCoordsRef = useRef<Coords | null>(null);
  // レイアウト収束時に Worker が計算した Ward 併合列。K スライダーはこれを切り直すだけ。
  const linkageRef = useRef<{ a: Int32Array; b: Int32Array; n: number } | null>(null);
  const clusterKRef = useRef(DEFAULT_VIEW.clusterK);
  clusterKRef.current = view.clusterK ?? DEFAULT_VIEW.clusterK;
  const activeLenRef = useRef(0);

  // スコープ適用後のレコードと辺(ドリルダウン中は部分集合)
  const activeRecords = useMemo(
    () => (records && scope ? scope.indices.map((i) => records[i]) : records),
    [records, scope],
  );
  const activeEdges = useMemo(() => (edges && scope ? subsetEdges(edges, scope.indices) : edges), [edges, scope]);
  activeLenRef.current = activeRecords?.length ?? 0;

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

  // 賛否スペクトラム分析は通常版とは独立した投入口(抽出/埋め込みを張り直す)ため、
  // チェックポイントも通常版(projectId)と衝突しない専用 namespace に隔離する。
  const checkpointsId = isSample ? sampleNamespace(projectId) : projectNamespace(projectId);

  const buildCtx = useCallback((): PipelineContext | null => {
    if (!isSample && !project) return null;
    abortRef.current = new AbortController();
    return {
      chat: chatEndpoint,
      embedding: isSample || !project ? resolveEndpoint(settings, "embedding") : project.settingsSnapshot.embedding,
      concurrency: project?.settingsSnapshot.concurrency ?? 8,
      signal: abortRef.current.signal,
      checkpoints: dexieCheckpoints(checkpointsId),
      onUsage: (u) =>
        setUsage((prev) => ({
          input: prev.input + u.input,
          output: prev.output + u.output,
          total: prev.total + u.total,
        })),
    };
  }, [isSample, project, chatEndpoint, settings, checkpointsId]);

  // ---- サンプルモード: 事前分析済みデータを読み込むだけで動く ----
  // biome-ignore lint/correctness/useExhaustiveDependencies: records ガードで初回のみ実行。startLayout 等を足すと再ロードを招くため意図的に除外
  useEffect(() => {
    if (!isSample || !sampleDef || records) return;
    (async () => {
      try {
        setStatus("サンプルデータ読み込み中...");
        const response = await fetch(`${import.meta.env.BASE_URL}${sampleDef.file}`);
        if (!response.ok) throw new Error(`サンプルの取得に失敗 (HTTP ${response.status})`);
        const sample = deserializeSample(await response.json());
        setTitle(sample.title);
        setRecords(sample.records);
        setCodebook(sample.codebook);
        setEdges(sample.edges);
        setCoords({ x: sample.coords.x.slice(), y: sample.coords.y.slice() });
        initialCoordsRef.current = { x: sample.coords.x.slice(), y: sample.coords.y.slice() };
        startLayout(sample.coords, sample.records, sample.edges);
        setStatus("サンプル準備完了 — スライダーで再クラスタリングできます");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [isSample, sampleDef, records]);

  // ---- データ準備(結合抽出 → 埋め込み → codebook → 候補辺 → 初期座標) ----
  // 各ステップはチェックポイントで短絡するので、すべて保存済みなら API を一切呼ばずに復元できる。
  // cacheOnly=true はその「復元だけ」を保証するモード(足りなければ CacheMissError で中断)。
  const prepare = async ({ cacheOnly = false } = {}) => {
    const base = buildCtx();
    if (!base || !project) return;
    const ctx: PipelineContext = { ...base, cacheOnly };
    if (cacheOnly) setRestoring(true);
    else setPreparing(true);
    setError(null);
    setUsage({ input: 0, output: 0, total: 0 });
    try {
      const attributesByComment = new Map(project.comments.map((c) => [c.commentId, c.attributes]));
      // 生コメントから賛否スペクトラム分析専用の投入口で「意見抽出 + 構造化属性 + 埋め込み」をまとめて実行
      const {
        records: recs,
        codebook: cb,
        embedding: emb,
      } = await prepareStanceSpectrumRecords(
        project.comments,
        project.prompts.extraction,
        ctx,
        (message, done, total) => setStatus(total ? `${message} ${done}/${total}` : message),
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

      // 初期座標: 賛否スペクトラム分析の隔離チェックポイントにキャッシュ(再実行時はスキップ)
      const { umapCheckpointKey } = await import("../lib/pipeline/steps/clustering");
      const key = umapCheckpointKey({ count: emb.argIds.length, dim: emb.dim, seed: "kouchou-ai" });
      const saved: Coords | undefined = await dexieCheckpoints(checkpointsId).getChunk("umap", key);
      let initial: Coords;
      if (saved) {
        initial = saved;
      } else {
        setStatus("初期レイアウト計算(UMAP)...");
        initial = await runUmapOnce(emb, (done, total) => setStatus(`初期レイアウト計算(UMAP)${done}/${total}`));
        await dexieCheckpoints(checkpointsId).putChunk("umap", key, initial);
      }
      setCoords({ x: initial.x.slice(), y: initial.y.slice() });
      initialCoordsRef.current = { x: initial.x.slice(), y: initial.y.slice() };
      startLayout(initial, recs, edgeSet);
      setStatus(cacheOnly ? "保存済みデータから復元しました" : "準備完了 — スライダーで再クラスタリングできます");
    } catch (e) {
      // 自動復元が理由を問わず失敗したら、必ず準備ボタンを出せる状態にして戻る。
      // ここで CacheMissError だけを扱うと、Worker のエラーや壊れたキャッシュで
      // 失敗したときに復元中の表示も準備ボタンも出ない行き止まりになる
      // (リロードしても同じ所で失敗するため、操作する手段が無くなる)。
      if (cacheOnly) setNeedsApiPreparation(true);
      if (e instanceof CacheMissError) {
        // 想定内: 保存済みデータだけでは足りなかった。エラー表示はしない
        setStatus("");
        return;
      }
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setPreparing(false);
      setRestoring(false);
    }
  };

  // 保存済みチェックポイントがあれば、ボタンを押させずに自動で復元してレイアウトまで進める。
  // records/edges/coords は React state にしか無いため、リロードのたびにここを通る。
  // 抽出・埋め込み・コードブックがすべてキャッシュ済みなら API 呼び出しはゼロで、
  // 足りなければ CacheMissError で中断して準備ボタンに切り替わる(黙って課金しない)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: prepare は毎レンダ再生成されるため依存に入れない。復元は条件が揃った初回のみ
  useEffect(() => {
    if (isSample || !project || records || restoring || preparing || restoreAttemptedRef.current) return;
    if (project.comments.length === 0) return;
    restoreAttemptedRef.current = true;
    prepare({ cacheOnly: true });
  }, [isSample, project, records, restoring, preparing]);

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

  // 保存済み Ward 併合列を目標クラスタ数 K で切り直し、色/ラベルの安定追跡をして反映する。
  // 併合列は不変なので K 変更は再計算不要で即時。UMAP は動かさない。K は点数で clamp。
  const applyWardCut = useCallback((k?: number) => {
    const lk = linkageRef.current;
    if (!lk || lk.n !== activeLenRef.current) return;
    const kk = Math.max(2, Math.min(k ?? clusterKRef.current, lk.n));
    const communities = cutWardToK(lk.a, lk.b, lk.n, kk);
    setAssignment(trackClusters(communities, assignmentRef.current));
  }, []);

  // ---- レイアウト Worker ----
  const startLayout = (
    initial: Coords,
    recs: OpinionRecord[],
    edgeSet: EdgeSet,
    viewForRecluster: ClusterView = DEFAULT_VIEW,
    topicConditioned = false,
  ) => {
    layoutWorkerRef.current?.terminate();
    linkageRef.current = null; // レイアウトを作り直すので古い併合列は破棄
    const worker = new Worker(new URL("../stance-spectrum/workers/layout.worker.ts", import.meta.url), {
      type: "module",
    });
    layoutWorkerRef.current = worker;
    let pending: Coords | null = null;
    let rafScheduled = false;
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "coords") {
        pending = { x: msg.x, y: msg.y };
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(() => {
            rafScheduled = false;
            if (pending) setCoords(pending);
          });
        }
      } else if (msg.type === "linkage") {
        // 収束時: Ward 併合列を受け取り、現在の K で切ってクラスタを更新する
        linkageRef.current = { a: msg.a, b: msg.b, n: msg.n };
        applyWardCut();
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

  // ---- レイアウト再加熱(スライダー操作時。LLM は呼ばない) ----
  // クラスタリングはレイアウト収束時に Ward 併合列を K 本カットして行うため、ここでは重みを
  // 更新して UMAP を組み直すだけ(収束すると Worker が併合列を返し、applyWardCut が走る)。
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

      // 再加熱するので古い併合列を無効化(収束前に K を動かしても古い配置で切らない)
      linkageRef.current = null;
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

  // 今すぐ現在の配置から切り直す: Worker に Ward 併合列の再計算を要求する
  // (通常はレイアウト収束時に自動で走る。手動で今の見た目に合わせたいとき用)。
  const requestReclusterNow = () => {
    layoutWorkerRef.current?.postMessage({ type: "computeLinkage" });
  };

  // クラスタ数 K の変更: 保存済み Ward 併合列を切り直すだけ(UMAP 再実行なし・即時)。
  const setClusterK = (k: number) => {
    setView((v) => ({ ...v, clusterK: k }));
    applyWardCut(k);
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

  /**
   * レイアウトのやり直し。初期 UMAP 座標に戻し、現在の重みで焼き直す。
   *
   * スライダーはウォームスタート(現在座標から局所最適化を再開)で連続的に動くため、
   * 到達したレイアウトは重みだけでなく操作履歴にも依存する。スタンスを上げて分離させて
   * から下げても元に戻らないのはこのため。ここから焼き直すと履歴が切れ、同じ重みなら
   * 同じレイアウトになる(乱数シードは固定なので決定的)。保存したビューを忠実に
   * 再現したいときにも使う。
   *
   * 埋め込みも UMAP 本体も再計算しないので LLM コストはゼロ、待ち時間も焼きなましだけ。
   */
  const resetLayout = () => {
    if (!records || !edges) return;
    const pristine = initialCoordsRef.current;
    if (!pristine) return;
    setAssignment(null);
    setExplanation(null);
    attrSimCacheRef.current = new Map();
    const nextView = { ...view, selectedClusterId: null };
    setView(nextView);

    if (scope) {
      // 絞り込み中は、初期座標の同じ部分集合から焼き直す(スコープは維持)
      const subX = new Float32Array(scope.indices.length);
      const subY = new Float32Array(scope.indices.length);
      scope.indices.forEach((globalIndex, k) => {
        subX[k] = pristine.x[globalIndex];
        subY[k] = pristine.y[globalIndex];
      });
      const subRecords = scope.indices.map((i) => records[i]);
      setCoords({ x: subX.slice(), y: subY.slice() });
      startLayout({ x: subX, y: subY }, subRecords, subsetEdges(edges, scope.indices), nextView, true);
    } else {
      globalCoordsRef.current = { x: pristine.x.slice(), y: pristine.y.slice() };
      setCoords({ x: pristine.x.slice(), y: pristine.y.slice() });
      startLayout({ x: pristine.x.slice(), y: pristine.y.slice() }, records, edges, nextView, false);
    }
    setStatus("初期座標からレイアウトを作り直しました");
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
    // 上位N件の制限は設けず、3件以上の全クラスタを対象にする(色付けと hull/ラベルを一致させる)。
    // summarizeCluster の総コストは全点の走査 O(N) 相当なのでクラスタ数が増えても重くならない。
    return [...byLabel.entries()]
      .filter(([, members]) => members.length >= 3)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([clusterId, members]) => ({
        clusterId,
        members,
        // 構成ハッシュ(所属意見id集合)。LLM ラベルはこれで引くので、再クラスタで中身が
        // 変わったクラスタは(clusterId を引き継いでも)古いラベルを表示しない。
        hash: fnv1a([...members.map((i) => activeRecords[i].id)].sort().join(" ")),
        ...summarizeCluster(members, activeRecords, codebook),
      }));
  }, [activeRecords, codebook, assignment]);

  // ---- 散布図 ----
  // 色付けは全クラスタ対象(サイズ降順にパレットを循環)。表示ラベル/一覧は上位に絞るが、
  // 色は全点に配ることで「上位30から漏れた点がグレーになる」問題を防ぐ。
  // サマリ計算(summarizeCluster)は重いので、色付けはラベル集計だけの軽量パスにする。
  const colorByCluster = useMemo(() => {
    const map = new Map<string, string>();
    if (!assignment) return map;
    const counts = new Map<string, number>();
    for (const label of assignment.labels) {
      if (label === null) continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([clusterId], index) => {
        map.set(clusterId, SOFT_COLORS[index % SOFT_COLORS.length]);
      });
    return map;
  }, [assignment]);

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
          text: llmLabels.get(summary.hash)?.label ?? summary.label,
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
    llmLabels,
  ]);

  const annotations = useMemo(() => {
    if (!coords) return [];
    // 全クラスタ(3件以上)にラベルを出す。密集部は重なるが、上限で隠すより網羅性を優先。
    return clusterSummaries.map((summary) => {
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
        text: wrapLabelText(llmLabels.get(summary.hash)?.label ?? summary.label, 12, 180),
        showarrow: false,
        font: { color: "white", size: 12 },
        bgcolor: `${color}cc`,
        borderpad: 6,
        align: "left" as const,
      };
    });
  }, [clusterSummaries, coords, colorByCluster, llmLabels]);

  // ---- クラスタ選択(focus+context) ----
  const selectCluster = (clusterId: string | null) => {
    setExplanation(null);
    // クリックは選択ハイライトのみ(UMAP は動かさない)。stance/理由を選択クラスタ内に
    // 適用して分裂させるのは、明示ボタン「選択クラスタを分裂」で行う。
    setView((v) => ({ ...v, selectedClusterId: clusterId }));
  };

  // focus+context の明示適用: 現在の view(選択クラスタ + stance/理由の重み)でレイアウトを
  // 組み直し、選択クラスタ内を分裂させる。スライダー操作と違い、クリックでは起きない。
  const applyFocusSplit = () => {
    if (!activeRecords || !activeEdges) return;
    recluster(activeRecords, activeEdges, view, assignmentRef.current, null, scope !== null);
  };

  // ---- LLM 解説(オンデマンド・構成ハッシュでキャッシュ) ----
  const explainCluster = async (clusterId: string) => {
    const summary = clusterSummaries.find((s) => s.clusterId === clusterId);
    if (!summary || !activeRecords || !chatEndpoint.baseUrl) return;
    setExplaining(true);
    try {
      const checkpoints = dexieCheckpoints(checkpointsId);
      const compositionKey = summary.hash;
      const cached = await checkpoints.getChunk(CHUNK_STEP.explain, compositionKey);
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
      await checkpoints.putChunk(CHUNK_STEP.explain, compositionKey, text);
      setExplanation({ clusterId, text });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExplaining(false);
    }
  };

  // ---- LLM ラベル生成(ボタンで現在ビューの全クラスタを命名。クラスタごとに1コール) ----
  // 構成ハッシュ(所属id集合)でキャッシュするので、同じ切り方に戻れば無料で再利用。
  const generateLlmLabels = async () => {
    if (!activeRecords || !chatEndpoint.baseUrl || clusterSummaries.length === 0) return;
    setLabeling(true);
    setError(null);
    const checkpoints = dexieCheckpoints(checkpointsId);
    const concurrency = isSample || !project ? 8 : project.settingsSnapshot.concurrency;
    const semaphore = new Semaphore(concurrency);
    const total = clusterSummaries.length;
    let done = 0;
    setStatus(`LLM ラベル生成 0/${total}`);
    try {
      await Promise.all(
        clusterSummaries.map((summary) =>
          semaphore.run(async () => {
            const key = summary.hash;
            let result = (await checkpoints.getChunk(CHUNK_STEP.label, key)) as
              | { label: string; description: string }
              | undefined;
            if (!result || typeof result.label !== "string") {
              const stanceText = Object.entries(summary.stanceMix)
                .map(([k, count]) => `${STANCE_LABEL_JA[k as keyof typeof STANCE_LABEL_JA]}: ${count}件`)
                .join(", ");
              const input = [
                `クラスタ件数: ${summary.size}`,
                `上位トピック: ${summary.topTopics.map((t) => t.label).join(", ")}`,
                `stance 分布: ${stanceText}`,
                `上位論点: ${summary.topReasons.map((r) => r.label).join(", ")}`,
                "代表的な意見:",
                ...summary.representatives.map((i) => `- ${activeRecords[i].claimText}`),
              ].join("\n");
              const response = await requestChat(chatEndpoint, {
                messages: [
                  {
                    role: "system",
                    content:
                      'あなたは意見分析の専門家です。以下の意見クラスタに、内容を的確に表す短いラベル(label, 15字程度)と、特徴を2〜3文でまとめた説明(description)を付けてください。ラベルは具体的にし、「多様な意見」のような抽象的・汎用的な名称は避け、他のクラスタと区別できる名称にしてください。立場の内訳(賛成/条件付き/非反対など)の違いにも注意してください。出力は {"label": "...", "description": "..."} の JSON のみ。',
                  },
                  { role: "user", content: input },
                ],
              });
              const parsed = parseLabelResponse(response);
              result = parsed
                ? { label: parsed.label, description: parsed.description }
                : { label: summary.label, description: "" };
              await checkpoints.putChunk(CHUNK_STEP.label, key, result);
            }
            const value = result;
            setLlmLabels((m) => new Map(m).set(key, value));
            done++;
            setStatus(`LLM ラベル生成 ${done}/${total}`);
          }),
        ),
      );
      setStatus("LLM ラベル生成 完了");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLabeling(false);
    }
  };

  // ---- ビュー定義の保存/復元 ----
  useEffect(() => {
    dexieCheckpoints(checkpointsId)
      .getChunk(CHUNK_STEP.views, "list")
      .then((saved) => {
        if (Array.isArray(saved)) setSavedViews(saved);
      });
  }, [checkpointsId]);

  // 現在の分析データ(意見・タグ・コードブック・候補グラフ・全体座標)を JSON で保存する。
  // 形式は事前分析済みサンプル(public/sample-stance-spectrum.json)と同一。
  const downloadJson = () => {
    if (!records || !codebook || !edges) return;
    const coordsForExport = scope ? globalCoordsRef.current : coords;
    if (!coordsForExport || coordsForExport.x.length !== records.length) {
      setError("JSON 保存には全体ビューの座標が必要です。ドリルダウンを解除してから実行してください。");
      return;
    }
    const name = (isSample ? title : project?.title) || "stance-spectrum";
    const sample = serializeSample(name, records, codebook, edges, coordsForExport);
    const blob = new Blob([JSON.stringify(sample)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}${EXPORT_FILE_SUFFIX}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const saveCurrentView = async () => {
    const name = prompt("ビュー名を入力してください", view.name);
    if (!name) return;
    const next = [...savedViews.filter((v) => v.name !== name), { ...view, name }];
    setSavedViews(next);
    await dexieCheckpoints(checkpointsId).putChunk(CHUNK_STEP.views, "list", next);
  };

  if (!isSample && !project) return <p>読み込み中...</p>;
  const commentCount = project?.comments.length ?? 0;
  const ready = !!(records && edges && coords);

  // ラベル生成が押せない理由。サンプルは設定ゲートを通らずに入れるため、
  // 未設定のまま «無言でグレーアウト» になりやすい。理由を必ず言葉で出す。
  const labelDisabledReason = !chatEndpoint.baseUrl
    ? "設定画面でチャットプロバイダを設定すると使えます。"
    : clusterSummaries.length === 0
      ? "レイアウトが収束してクラスタが確定すると使えます。"
      : "";
  const selectedAttrInfo = attributeInfos.find((a) => a.key === view.attributeKey);

  // 累計トークン → コスト概算(チャットモデル単価ベース。ローカル実行や単価不明は費用非表示)
  const usageCost = (() => {
    if (usage.total === 0) return null;
    if (chatEndpoint.baseUrl.startsWith("local:")) return "ローカル実行のため費用は 0";
    const cost = estimateActualCostUsd(usage, chatEndpoint.model, chatEndpoint.serviceTier);
    return cost !== null ? `コスト ≈ $${cost.toFixed(3)}` : "単価不明のモデル(トークン数のみ表示)";
  })();

  return (
    <div>
      <h1>{isSample ? title || "サンプル" : project?.title} — 賛否スペクトラム分析</h1>
      <p className="note">
        クラスタは固定分類ではなく、重み付けから都度生成される「ビュー」です。スライダー操作は LLM
        を呼ばず、候補グラフの再重み付けだけで点群が連続的に再編されます。スタンス/理由は全体ビューでも
        使えます(トピック類似度でゲートし、無関係な話題を賛否で混ぜません)。クラスタを選択・トピックで
        絞ると、その範囲にそのまま効きます。 詳しい仕組みは <a href="#/stance-spectrum/about">アルゴリズム解説</a> へ。
      </p>
      {error && <div className="error-box">{error}</div>}

      {usage.total > 0 && (
        <p className="note">
          累計トークン: 入力 {usage.input.toLocaleString()} / 出力 {usage.output.toLocaleString()} / 合計{" "}
          {usage.total.toLocaleString()}
          {usageCost ? ` — ${usageCost}` : ""}
          {preparing ? "(処理中...)" : ""}
        </p>
      )}

      {!ready && !isSample && commentCount === 0 && (
        <div className="card">
          <p>コメントデータがありません。先にプロジェクトを作成してデータを取り込んでください。</p>
          <button type="button" className="primary" onClick={() => navigate("/")}>
            ホームへ
          </button>
        </div>
      )}

      {/* 保存済みデータからの自動復元中。API は呼ばないのでボタンは出さない */}
      {!ready && !isSample && commentCount > 0 && restoring && (
        <div className="card">
          <p>
            保存済みデータから復元しています...
            <br />
            <span className="note">{status || "チェックポイントを読み込み中(API 呼び出しはありません)"}</span>
          </p>
        </div>
      )}

      {/* 復元では足りず、API を使う処理が必要なときだけ準備ボタンを出す */}
      {!ready && !isSample && commentCount > 0 && !restoring && needsApiPreparation && (
        <div className="card">
          <p>
            この分析にはまだ実行していない処理があるため、LLM API を使うデータ準備が必要です(通常版とは独立した
            専用の投入口)。{commentCount.toLocaleString()} 件のコメントごとにチャット1回で「意見抽出 +
            構造化属性(stance/topics/reasons)」を まとめて取得 → 意見をベクトル化 → タグ統合 →
            候補グラフ構築、の順で処理します。
            <br />
            <span className="note">
              使用モデル: {chatEndpoint.model}(推奨: gpt-5-mini — Phase 0 検証で stance 分類 19/19 全問正解)。
              コメント単位で保存されるため、すでに終わっている分は課金されません。
            </span>
          </p>
          <button type="button" className="primary" onClick={() => prepare()} disabled={preparing}>
            {preparing ? "準備中..." : "データ準備を実行(LLM API を使用)"}
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
                hint="7段階の賛否分布の近さ。上げると賛成派と反対派が分かれます。全体ビューではトピック類似度でゲートされ(無関係トピックを賛否で混ぜない)、クラスタ選択・トピック絞り込み中はそのまま全辺に効きます"
                onChange={(v) => updateView({ stanceWeight: v })}
              />
              <Slider
                label="理由"
                value={view.reasonWeight}
                max={3}
                hint="賛否の根拠として挙げている理由タグ(「安全性への懸念」「コスト」等)の一致度。スタンスとは独立で、賛成派と反対派が同じ理由を挙げているケースも束ねられます。全体ビューではトピック類似度でゲートされます"
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
              <label
                style={{ fontWeight: 400, margin: 0 }}
                title="クラスタ数。レイアウト収束時に作った連結制約付き Ward の樹形図を、ちょうどこの数のクラスタで切ります。UMAP は再実行せず即座に切り直します"
              >
                クラスタ数: {view.clusterK ?? DEFAULT_VIEW.clusterK}
                <br />
                <input
                  type="range"
                  min={2}
                  max={Math.min(40, Math.max(2, activeRecords?.length ?? 40))}
                  step={1}
                  value={view.clusterK ?? DEFAULT_VIEW.clusterK}
                  onChange={(e) => setClusterK(Number(e.target.value))}
                  style={{ width: 130 }}
                />
              </label>
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
                onClick={requestReclusterNow}
                title="現在の配置から今すぐクラスタを切り直します(Ward 併合列を再構築)。通常はレイアウトが収束したときに自動で切り直されるので、手動での実行は任意です"
              >
                今すぐ切り直す
              </button>
              <button
                type="button"
                onClick={resetLayout}
                title="初期座標に戻して、現在の重みでレイアウトを作り直します。スライダーは現在の配置から連続的に動くため結果が操作履歴に依存します(重みを戻しても元の配置には戻りません)。ここから焼き直すと履歴が切れ、同じ重みなら必ず同じレイアウトになります。LLM は呼びません"
              >
                レイアウトを作り直す
              </button>
              <button
                type="button"
                onClick={generateLlmLabels}
                disabled={labeling || !!labelDisabledReason}
                title={
                  labelDisabledReason ||
                  "現在のクラスタごとに LLM でラベルと説明文を生成します(クラスタ毎に1コール・構成ハッシュでキャッシュ)。押すたびに現在の切り方に対して生成/再利用します"
                }
              >
                {labeling ? "ラベル生成中..." : "LLMでラベル生成"}
              </button>
              {/* 押せない理由は tooltip だけだと気づかれないので、その場に文言として出す */}
              {labelDisabledReason && (
                <span className="note">
                  {labelDisabledReason}
                  {!chatEndpoint.baseUrl && (
                    <>
                      {" "}
                      <a href="#/settings">設定を開く</a>
                    </>
                  )}
                </span>
              )}
              <button
                type="button"
                onClick={saveCurrentView}
                title="現在の重み設定に名前を付けて保存し、ワンクリックで再現できるようにします"
              >
                ビューを保存
              </button>
              <button
                type="button"
                onClick={downloadJson}
                title="現在の分析データ(意見・タグ・候補グラフ・全体座標)を JSON で保存します(サンプルと同じ形式)"
              >
                JSON をダウンロード
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
                選択中:{" "}
                <b>
                  {(() => {
                    const s = clusterSummaries.find((c) => c.clusterId === view.selectedClusterId);
                    return (s && llmLabels.get(s.hash)?.label) ?? s?.label;
                  })()}
                </b>{" "}
                — スタンス/理由を上げて「分裂」を押すと、このクラスタ内が賛否・理由で分かれます。{" "}
                <button
                  type="button"
                  className="primary"
                  onClick={applyFocusSplit}
                  disabled={view.stanceWeight === 0 && view.reasonWeight === 0}
                  title={
                    view.stanceWeight === 0 && view.reasonWeight === 0
                      ? "先にスタンスか理由の重みを上げてください"
                      : "現在のスタンス/理由の重みを選択クラスタ内に適用してレイアウトを組み直します"
                  }
                >
                  選択クラスタを分裂
                </button>{" "}
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
            {/* 選択クラスタの LLM 説明(あれば全文表示) */}
            {view.selectedClusterId !== null &&
              (() => {
                const s = clusterSummaries.find((c) => c.clusterId === view.selectedClusterId);
                const desc = s && llmLabels.get(s.hash)?.description;
                return desc ? (
                  <p style={{ whiteSpace: "pre-wrap", background: "#f8fafc", padding: 8, borderRadius: 8 }}>{desc}</p>
                ) : null;
              })()}
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
                    <span style={{ color: colorByCluster.get(summary.clusterId) }}>●</span>{" "}
                    {llmLabels.get(summary.hash)?.label ?? summary.label}
                  </h3>
                  <p className="cluster-value">{summary.size} 件</p>
                  {llmLabels.get(summary.hash)?.description ? (
                    // LLM 説明があるときは全文表示し、代表意見(重複気味)は省く
                    <p className="cluster-desc">{llmLabels.get(summary.hash)?.description}</p>
                  ) : (
                    <p className="cluster-takeaway">
                      {activeRecords &&
                        summary.representatives
                          .slice(0, 2)
                          .map((i) => activeRecords[i].claimText)
                          .join(" / ")}
                    </p>
                  )}
                </button>
              ))}
            </div>
          </section>
        </>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" onClick={() => navigate("/stance-spectrum")}>
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

/** 賛否スペクトラム分析のプロジェクト選択(トップレベルの「賛否スペクトラム分析」から入る) */
export function StanceSpectrumHome() {
  // 賛否スペクトラム分析に所属するプロジェクトのみ(通常版とは領域を分ける)
  const projects = useLiveQuery(
    () =>
      db.projects
        .orderBy("createdAt")
        .reverse()
        .filter((p) => p.kind === PROJECT_KIND)
        .toArray(),
    [],
  );
  return (
    <div>
      <h1>賛否スペクトラム分析</h1>
      <p className="note">
        通常版とは別の分析モードです(クラスタリング方式が異なるため、結果は通常版のレポートとは混ざりません)。 CSV
        を取り込めば通常版を経由せずそのまま分析でき、事前分析済みサンプルでもすぐ試せます。 仕組みは{" "}
        <a href="#/stance-spectrum/about">アルゴリズム解説</a> を参照。
      </p>
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <div className="card" style={{ flex: 1, minWidth: 260 }}>
          <h3>CSV を取り込んで始める</h3>
          <p className="note">
            意見の CSV を取り込むと、意見抽出・stance/topics/reasons
            付与・ベクトル化まで賛否スペクトラム分析側で一括実行します (通常版の実行は不要)。
          </p>
          <button type="button" className="primary" onClick={() => navigate("/stance-spectrum/new")}>
            データを取り込む
          </button>
        </div>
        {STANCE_SPECTRUM_SAMPLES.map((s) => (
          <div key={s.id} className="card" style={{ flex: 1, minWidth: 260 }}>
            <h3>サンプル: {s.title}</h3>
            <p className="note">事前分析済み(分析の実行不要)。{s.note}</p>
            <button type="button" onClick={() => navigate(`/stance-spectrum/${s.id}`)}>
              サンプルを開く
            </button>
          </div>
        ))}
      </div>
      {(!projects || projects.length === 0) && (
        <p className="note" style={{ marginTop: 12 }}>
          賛否スペクトラム分析のプロジェクトはまだありません。上の「データを取り込む」から CSV
          を読み込むと、ここに並びます(通常版のプロジェクト/レポートとは領域が分かれています)。
        </p>
      )}
      {projects && projects.length > 0 && <h2>取り込み済みのデータ</h2>}
      <div className="report-grid">
        {projects?.map((project) => (
          <div key={project.id} className="card">
            <h3>{project.title}</h3>
            <p className="note">
              {project.comments.length.toLocaleString()} コメント / {project.status}
            </p>
            <div className="row">
              <button type="button" className="primary" onClick={() => navigate(`/stance-spectrum/${project.id}`)}>
                開く
              </button>
              <button
                type="button"
                className="danger"
                onClick={async () => {
                  if (confirm(`「${project.title}」を削除しますか?(賛否スペクトラム分析の中間データも消えます)`)) {
                    await deleteStanceSpectrumProjectData(project.id);
                  }
                }}
              >
                削除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
