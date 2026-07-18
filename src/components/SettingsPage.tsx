import { useEffect, useRef, useState } from "react";
import { listModels, listModelsDetailed, probeChat, requestEmbeddings } from "../lib/llm/client";
import { prepareAndTestGeminiNano } from "../lib/llm/geminiNano";
import { getStorageStatus, requestPersistentStorage, type StorageStatus } from "../lib/storage/db";
import { useSettings } from "../store/settings";
import { isProviderConfigured, PRESETS, type PresetId, resolveEndpoint } from "../types/settings";

// 設定画面(DESIGN §4)。
// 1. プロバイダごとに API キー等を登録
// 2. chat / embedding スロットは「設定済みプロバイダ」からのみ選択可能
// 3. 疎通確認: モデル一覧取得 / 埋め込み1件 / チャット応答テスト(タイムアウト検知)

/**
 * /models の結果をスロットに合うものだけに絞る。
 * embedding スロット: 埋め込みモデルらしい ID のみ(embed / bge / e5 / minilm / gte)
 * chat スロット: 音声・画像・埋め込み等の明らかにチャットでないモデルを除外
 */
export function filterModelsForSlot(ids: string[], slot: "chat" | "embedding"): string[] {
  if (slot === "embedding") {
    return ids.filter((id) => /embed|bge|(^|[/-])e5-|minilm|gte-/i.test(id));
  }
  return ids.filter(
    (id) => !/embed|whisper|tts|audio|realtime|dall-e|image|moderation|transcribe|similarity|rerank|clip/i.test(id),
  );
}

const KEY_REQUIRED: PresetId[] = ["openai", "anthropic", "grok", "openrouter", "azure", "bedrock"];
const URL_EDITABLE: PresetId[] = ["azure", "bedrock", "lmstudio", "ollama", "custom"];
const LOCAL_PROVIDERS: PresetId[] = ["gemini-nano", "local-embedding"];

// OpenAI 互換・セルフホスト系はひとつのグループにまとめる
const COMPAT_GROUP: PresetId[] = ["azure", "bedrock", "lmstudio", "ollama", "custom"];

function ProviderRow({ presetId }: { presetId: PresetId }) {
  const { settings, setProvider, removeProvider } = useSettings();
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) return null;
  const config = settings.providers[preset.id];
  const configured = isProviderConfigured(preset.id, settings);
  return (
    <details className="provider-row">
      <summary>
        <span>
          {configured ? "✅" : "○"} <b>{preset.label}</b>
        </span>
        <span className="note">
          {configured
            ? config?.apiKey
              ? `キー設定済み (…${config.apiKey.slice(-4)})`
              : "URL 設定済み"
            : KEY_REQUIRED.includes(preset.id)
              ? "API キーが必要"
              : "URL 指定で利用可"}
        </span>
      </summary>
      <div className="provider-body">
        <div className="row">
          {URL_EDITABLE.includes(preset.id) && (
            <input
              style={{ flex: 2, minWidth: 220 }}
              placeholder={preset.baseUrl || "ベース URL (例: http://localhost:1234/v1)"}
              value={config?.baseUrl ?? ""}
              onChange={(e) => setProvider(preset.id, { baseUrl: e.target.value })}
            />
          )}
          <input
            style={{ flex: 3, minWidth: 220 }}
            type="password"
            autoComplete="off"
            name={`api-key-${preset.id}`}
            placeholder={
              KEY_REQUIRED.includes(preset.id) ? "API キー (必須)" : "API キー (認証を有効にしている場合のみ)"
            }
            value={config?.apiKey ?? ""}
            onChange={(e) =>
              setProvider(preset.id, {
                apiKey: e.target.value,
                baseUrl: config?.baseUrl || preset.baseUrl,
              })
            }
          />
          {config && (
            <button type="button" className="danger" onClick={() => removeProvider(preset.id)}>
              削除
            </button>
          )}
        </div>
        <p className="note" style={{ margin: "4px 0 0" }}>
          {preset.corsNote}
        </p>
      </div>
    </details>
  );
}

function ProviderKeysCard() {
  const { settings } = useSettings();
  const main = PRESETS.filter((p) => !LOCAL_PROVIDERS.includes(p.id) && !COMPAT_GROUP.includes(p.id));
  const compat = PRESETS.filter((p) => COMPAT_GROUP.includes(p.id));
  const sortConfigured = (list: typeof PRESETS) => [
    ...list.filter((p) => isProviderConfigured(p.id, settings)),
    ...list.filter((p) => !isProviderConfigured(p.id, settings)),
  ];
  const configuredCount = [...main, ...compat].filter((p) => isProviderConfigured(p.id, settings)).length;
  const compatConfigured = compat.filter((p) => isProviderConfigured(p.id, settings)).length;

  return (
    <div className="card">
      <h2>プロバイダの API キー</h2>
      <p className="note">
        使うプロバイダを開いてキーを入力してください({configuredCount} 件設定済み)。キーはこのブラウザ(localStorage)
        にのみ保存され、該当プロバイダの API 以外には送信されません。Gemini Nano・ローカル埋め込みはキー不要です。
      </p>
      {sortConfigured(main).map((preset) => (
        <ProviderRow key={preset.id} presetId={preset.id} />
      ))}
      <details className="provider-row provider-group" open={compatConfigured > 0}>
        <summary>
          <span>
            {compatConfigured > 0 ? "✅" : "○"} <b>OpenAI 互換・セルフホスト</b>
            <span className="note"> (Azure / Bedrock / LM Studio / Ollama / カスタム)</span>
          </span>
          <span className="note">
            {compatConfigured > 0 ? `${compatConfigured} 件設定済み` : "URL や独自キーで利用"}
          </span>
        </summary>
        <div className="provider-body">
          {sortConfigured(compat).map((preset) => (
            <ProviderRow key={preset.id} presetId={preset.id} />
          ))}
        </div>
      </details>
    </div>
  );
}

function SlotCard({ slot }: { slot: "chat" | "embedding" }) {
  const { settings, setChatSlot, setEmbeddingSlot } = useSettings();
  const selection = slot === "chat" ? settings.chatSlot : settings.embeddingSlot;
  const setSlot = slot === "chat" ? setChatSlot : setEmbeddingSlot;
  const [models, setModels] = useState<string[]>([]);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  // このスロットで選択可能なプロバイダ: slot 指定が合致し、かつ設定済みのもの
  const candidates = PRESETS.filter((p) => {
    if (p.slot && p.slot !== slot) return false;
    if (slot === "embedding" && p.id === "openrouter") return false; // embeddings なし
    if (slot === "chat" && p.id === "local-embedding") return false;
    return isProviderConfigured(p.id, settings);
  });

  const endpoint = resolveEndpoint(settings, slot);
  const preset = PRESETS.find((p) => p.id === selection.provider);
  // 標準モデルリスト(価格付き・安い順) + 自動取得したモデルリストをマージ
  const knownModels = (slot === "chat" ? preset?.knownChatModels : preset?.knownEmbeddingModels) ?? [];
  const [fetchedPrices, setFetchedPrices] = useState<Map<string, string>>(new Map());
  const priceOf = (id: string) => knownModels.find((m) => m.id === id)?.price ?? fetchedPrices.get(id);
  const modelChoices = [...new Set([...knownModels.map((m) => m.id), ...models])];

  // プロバイダ選択時にモデル一覧を自動取得(失敗しても標準リストで選べるので無視)。
  // pricing を返すプロバイダ(OpenRouter 等)は実勢価格も表示する。
  // 素早くプロバイダを切り替えた場合に古いレスポンスが混入しないよう、世代番号で無効化する。
  const fetchSeqRef = useRef(0);
  const autoFetchModels = async (id: PresetId | null) => {
    const seq = ++fetchSeqRef.current;
    if (!id || id === "gemini-nano" || id === "local-embedding") return;
    try {
      const selected = PRESETS.find((p) => p.id === id);
      const provider = settings.providers[id];
      const list = await listModelsDetailed({
        baseUrl: provider?.baseUrl || selected?.baseUrl || "",
        apiKey: provider?.apiKey ?? "",
        model: "",
        authHeader: selected?.authHeader ?? "bearer",
        extraHeaders: selected?.extraHeaders,
      });
      if (seq !== fetchSeqRef.current) return; // 別プロバイダに切り替え済み
      setModels(
        filterModelsForSlot(
          list.map((m) => m.id),
          slot,
        ),
      );
      setFetchedPrices(new Map(list.filter((m) => m.price).map((m) => [m.id, m.price as string])));
    } catch {
      // 標準リストのみ
    }
  };

  // チャット応答テスト: 小リクエストを投げてレイテンシ計測(30秒でタイムアウト検知)。
  // 実際に送った入力とモデルの出力をそのまま表示する。
  const [probeIo, setProbeIo] = useState<{ input: string; output: string; reasoning?: string } | null>(null);
  const probeResponse = async () => {
    setTesting(true);
    setProbeIo(null);
    setTestResult("応答テスト中(最大30秒)...");
    try {
      const result = await probeChat(endpoint, 30_000);
      setTestResult(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`);
      setProbeIo({ input: result.input, output: result.output || "(応答なし)", reasoning: result.reasoning });
    } finally {
      setTesting(false);
    }
  };

  // Gemini Nano: availability 確認 → 必要ならDL(進捗表示) → 小さな往復テスト。
  // ダウンロードは transient user activation を要するため、この click ハンドラ内で即実行する。
  const prepareNano = async () => {
    setTesting(true);
    setProbeIo(null);
    setTestResult("Gemini Nano を準備中...");
    try {
      const r = await prepareAndTestGeminiNano((m) => setTestResult(m));
      const s = r.structured;
      const structuredLabel = !s
        ? ""
        : s.supported
          ? s.valid
            ? " / structured output ✅(スキーマ準拠 JSON を確認)"
            : " / structured output ⚠️(responseConstraint は通るが JSON が不正)"
          : " / structured output ❌ 非対応(text のみ)";
      setTestResult(
        `✅ Gemini Nano 利用可能(availability=${r.availability}${r.latencyMs != null ? ` / 応答 ${r.latencyMs}ms` : ""})${structuredLabel}`,
      );
      const structuredLine = s?.supported
        ? `\n[structured] 出力: ${s.output ?? "(なし)"}${s.valid ? "" : " ← JSON 不正"}`
        : s
          ? `\n[structured] 非対応: ${s.error ?? ""}`
          : "";
      if (r.output) {
        setProbeIo({ input: "1 + 1 は? 数字のみで答えてください。", output: `${r.output}${structuredLine}` });
      }
    } catch (e) {
      setTestResult(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  // ローカル埋め込み: この端末での実効スループットを計測(WebGPU/WASM 判定込み)
  const runBenchmark = async () => {
    setTesting(true);
    setProbeIo(null);
    setTestResult("ベンチマーク準備中...");
    try {
      const { benchmarkLocalEmbedding } = await import("../lib/llm/localEmbedding");
      const r = await benchmarkLocalEmbedding(endpoint.model, (m) => setTestResult(m));
      const perSec = r.textsPerSec;
      const estMin = (n: number) => (perSec > 0 ? Math.max(0.1, n / perSec / 60).toFixed(1) : "∞");
      const backendLabel = r.backend === "webgpu" ? "WebGPU(GPU)" : r.backend === "wasm" ? "⚠️ WASM(CPU・低速)" : "不明";
      const wasmNote =
        r.backend === "wasm" ? "。WASM フォールバック中です。対応 GPU の Chrome だと大幅に速くなります。" : "";
      setTestResult(
        `バックエンド: ${backendLabel} / ${perSec.toFixed(1)} 意見/秒(${r.count}件を ${(r.totalMs / 1000).toFixed(1)}秒) / 次元 ${r.dim} — 目安: 2,000意見で約${estMin(2000)}分、7,500意見で約${estMin(7500)}分${wasmNote}`,
      );
    } catch (e) {
      setTestResult(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  // OpenRouter: pricing が 0 の無償モデルを列挙してドロップダウンに反映
  const findFreeModels = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const all = await listModelsDetailed(endpoint);
      const free = filterModelsForSlot(
        all.filter((m) => m.isFree).map((m) => m.id),
        slot,
      );
      if (free.length === 0) {
        setTestResult("無償モデルが見つかりませんでした。");
      } else {
        setModels(free);
        if (!free.includes(selection.model)) setSlot({ model: free[0] });
        setTestResult(
          `無償モデル ${free.length} 件をモデル一覧に反映しました。「応答テスト」でタイムアウトしないか確認してから使ってください。`,
        );
      }
    } catch (e) {
      setTestResult(`取得失敗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      if (endpoint.baseUrl === "local:transformers") {
        const { embedLocally } = await import("../lib/llm/localEmbedding");
        const vectors = await embedLocally(["接続テスト"], endpoint.model, (m) => setTestResult(m));
        setTestResult(`ローカル埋め込み成功 / 次元数: ${vectors[0]?.length}`);
        return;
      }
      const list = await listModels(endpoint);
      setModels(filterModelsForSlot(list, slot));
      let message = `接続成功: ${list.length} モデル`;
      if (slot === "embedding" && endpoint.model) {
        const vectors = await requestEmbeddings(endpoint, { texts: ["テスト"] });
        message += ` / 埋め込み次元数: ${vectors[0]?.length ?? "?"}`;
      }
      setTestResult(message);
    } catch (e) {
      setTestResult(`接続失敗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="card">
      <h2>{slot === "chat" ? "チャット(意見抽出・ラベリング・概要)" : "埋め込み(ベクトル化)"}</h2>
      {candidates.length === 0 ? (
        <p className="note">選択可能なプロバイダがありません。上で API キーを設定してください。</p>
      ) : (
        <>
          <label>
            プロバイダ
            {preset?.statusUrl && (
              <a
                href={preset.statusUrl}
                target="_blank"
                rel="noreferrer"
                style={{ fontWeight: 400, marginLeft: 8, fontSize: "0.85rem" }}
                title="プロバイダの稼働状況ページを開く"
              >
                稼働状況 ↗
              </a>
            )}
          </label>
          <select
            value={selection.provider ?? ""}
            onChange={(e) => {
              const id = (e.target.value || null) as PresetId | null;
              const selected = PRESETS.find((p) => p.id === id);
              setSlot({
                provider: id,
                model: selected ? (slot === "chat" ? selected.chatModel : selected.embeddingModel) : "",
                reasoningEffort: "", // 前プロバイダの設定を持ち越さない
                serviceTier: "",
              });
              setModels([]);
              setFetchedPrices(new Map());
              setTestResult(selected?.corsNote ?? null);
              void autoFetchModels(id);
            }}
          >
            <option value="">選択してください</option>
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {selection.provider && (
            <>
              <label>
                モデル{" "}
                <span className="note" style={{ fontWeight: 400 }}>
                  (候補から選択 or 直接入力。取得済み {models.length} 件 + 標準 {knownModels.length} 件。 価格は USD /
                  100万トークン、入力 / 出力の参考値)
                </span>
              </label>
              {modelChoices.length > 0 && (
                <div className="row" style={{ marginBottom: 4 }}>
                  {modelChoices.slice(0, 9).map((m) => (
                    <button
                      type="button"
                      key={m}
                      className={`model-chip ${selection.model === m ? "primary" : ""}`}
                      onClick={() => setSlot({ model: m })}
                    >
                      {m}
                      {priceOf(m) && <span className="model-price">{priceOf(m)}</span>}
                    </button>
                  ))}
                </div>
              )}
              <input
                list={`model-choices-${slot}`}
                value={selection.model}
                onChange={(e) => setSlot({ model: e.target.value })}
                placeholder="モデル名(入力すると候補が絞り込まれます)"
              />
              <datalist id={`model-choices-${slot}`}>
                {modelChoices.map((m) => (
                  <option key={m} value={m} label={priceOf(m)} />
                ))}
              </datalist>
              {selection.model && priceOf(selection.model) && (
                <p className="note" style={{ margin: "4px 0 0" }}>
                  選択中: {selection.model} — {priceOf(selection.model)} (USD/100万トークン)
                </p>
              )}
              {slot === "chat" && preset?.tierOptions && (
                <>
                  <label>処理ティア / ルーティング</label>
                  <select
                    value={selection.serviceTier ?? ""}
                    onChange={(e) => setSlot({ serviceTier: e.target.value })}
                  >
                    {preset.tierOptions.map((tier) => (
                      <option key={tier.value} value={tier.value}>
                        {tier.label}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {slot === "chat" && selection.provider !== "gemini-nano" && (
                <>
                  <label>reasoning effort(対応モデルのみ。非対応なら自動で外して再試行します)</label>
                  <select
                    value={selection.reasoningEffort ?? ""}
                    onChange={(e) =>
                      setSlot({ reasoningEffort: e.target.value as "" | "minimal" | "low" | "medium" | "high" })
                    }
                  >
                    <option value="">指定しない(既定)</option>
                    <option value="minimal">minimal</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </select>
                </>
              )}
              <div className="row" style={{ marginTop: 12 }}>
                <button type="button" onClick={testConnection} disabled={testing}>
                  {testing ? "テスト中..." : "接続テスト(疎通確認)"}
                </button>
                {slot === "chat" && selection.provider !== "gemini-nano" && (
                  <button type="button" onClick={probeResponse} disabled={testing || !selection.model}>
                    応答テスト(タイムアウト確認)
                  </button>
                )}
                {slot === "chat" && selection.provider === "gemini-nano" && (
                  <button type="button" className="primary" onClick={prepareNano} disabled={testing}>
                    {testing ? "準備中..." : "Gemini Nano を準備 + 動作確認"}
                  </button>
                )}
                {slot === "embedding" && endpoint.baseUrl === "local:transformers" && (
                  <button type="button" onClick={runBenchmark} disabled={testing}>
                    {testing ? "計測中..." : "ベンチマーク(速度計測)"}
                  </button>
                )}
                {slot === "chat" && selection.provider === "openrouter" && (
                  <button type="button" onClick={findFreeModels} disabled={testing}>
                    利用可能な無償モデルを探す
                  </button>
                )}
              </div>
            </>
          )}
          {testResult && <p className="note">{testResult}</p>}
          {probeIo && (
            <div className="probe-io">
              <div>
                <b>入力:</b> <span>{probeIo.input}</span>
              </div>
              {probeIo.reasoning && (
                <div>
                  <b>思考 (reasoning):</b>{" "}
                  <span style={{ whiteSpace: "pre-wrap", opacity: 0.75 }}>
                    {probeIo.reasoning.length > 600 ? `${probeIo.reasoning.slice(0, 600)}…` : probeIo.reasoning}
                  </span>
                </div>
              )}
              <div>
                <b>出力:</b> <span style={{ whiteSpace: "pre-wrap" }}>{probeIo.output}</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

type HealthItem = { label: string; status: "ok" | "ng" | "running"; detail: string };

function HealthCheckCard() {
  const { settings } = useSettings();
  const [items, setItems] = useState<HealthItem[] | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    const results: HealthItem[] = [];
    const push = (item: HealthItem) => {
      results.push(item);
      setItems([...results]);
    };
    const update = (status: HealthItem["status"], detail: string) => {
      results[results.length - 1] = { ...results[results.length - 1], status, detail };
      setItems([...results]);
    };

    const chat = resolveEndpoint(settings, "chat");
    const embedding = resolveEndpoint(settings, "embedding");

    // 1. スロット設定の有無
    push({
      label: "チャット設定",
      status: chat.baseUrl ? "ok" : "ng",
      detail: chat.baseUrl ? `${settings.chatSlot.provider} / ${chat.model}` : "プロバイダ未選択",
    });
    push({
      label: "埋め込み設定",
      status: embedding.baseUrl ? "ok" : "ng",
      detail: embedding.baseUrl ? `${settings.embeddingSlot.provider} / ${embedding.model}` : "プロバイダ未選択",
    });

    // 2. チャット疎通(モデル一覧 → 実応答)
    if (chat.baseUrl) {
      push({ label: "チャット API キー / モデル一覧", status: "running", detail: "確認中..." });
      try {
        const list = await listModels(chat);
        update("ok", `${list.length} モデル取得`);
      } catch (e) {
        update("ng", e instanceof Error ? e.message : String(e));
      }
      push({ label: "チャット応答(実リクエスト)", status: "running", detail: "最大30秒..." });
      const probe = await probeChat(chat, 30_000);
      update(
        probe.ok ? "ok" : "ng",
        probe.ok
          ? `${probe.message} / 入力:「${probe.input}」→ 出力:「${probe.output.slice(0, 80)}${probe.output.length > 80 ? "…" : ""}」`
          : probe.message,
      );
    }

    // 3. 埋め込み疎通(1件埋め込んで次元数を確認)
    if (embedding.baseUrl) {
      push({ label: "埋め込み(実リクエスト)", status: "running", detail: "確認中..." });
      try {
        if (embedding.baseUrl === "local:transformers") {
          const { embedLocallyViaWorker } = await import("../lib/llm/localEmbedding");
          const vectors = await embedLocallyViaWorker(["ヘルスチェック"], embedding.model, (m) => update("running", m));
          update("ok", `ローカル埋め込み成功 / 次元数 ${vectors[0]?.length}`);
        } else {
          const vectors = await requestEmbeddings(embedding, { texts: ["ヘルスチェック"], timeoutMs: 30_000 });
          update("ok", `次元数 ${vectors[0]?.length}`);
        }
      } catch (e) {
        update("ng", e instanceof Error ? e.message : String(e));
      }
    }
    setRunning(false);
  };

  const icon = (status: HealthItem["status"]) => (status === "ok" ? "✅" : status === "ng" ? "❌" : "⏳");

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>ヘルスチェック</h2>
        <button type="button" className="primary" onClick={run} disabled={running}>
          {running ? "チェック中..." : "一括疎通確認を実行"}
        </button>
      </div>
      <p className="note">API キー・チャット・埋め込みの疎通をまとめて確認します(小さな実リクエストが発生します)。</p>
      {items && (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {items.map((item) => (
            <li key={item.label} style={{ padding: "4px 0" }}>
              {icon(item.status)} <b>{item.label}</b> — <span className="note">{item.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {items && !running && (
        <p className="note">
          {items.every((i) => i.status === "ok")
            ? "✅ すべて正常です。レポート作成に進めます。"
            : "❌ 失敗した項目があります。キー・モデル名・CORS 設定を確認してください。"}
        </p>
      )}
    </div>
  );
}

/**
 * 保存データの全消去。
 *
 * 主な用途は、スキーマのマイグレーションに失敗して db.open() が毎回失敗し、
 * アプリが起動しなくなったときの復旧手段。そのため Dexie を通さず生の API で
 * 消す(この画面自体も IndexedDB を読まないので、DB が壊れていても開ける)。
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

/**
 * ストレージの状態表示と永続化の要求。
 *
 * Chrome は persist() でプロンプトを出さず、エンゲージメント等から黙って許否を
 * 返すため、プロジェクト作成時の自動要求だけでは通らないことが多い。ここから
 * 明示的に再要求できるようにし、拒否されている事実も見えるようにする。
 */
function StorageCard() {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    getStorageStatus().then(setStatus);
  }, []);

  const request = async () => {
    setRequesting(true);
    setMessage(null);
    const granted = await requestPersistentStorage();
    setStatus(await getStorageStatus());
    setMessage(
      granted
        ? "永続化されました。ブラウザの空き容量が逼迫しても、このサイトのデータは自動削除されません。"
        : "ブラウザに拒否されました。Chrome はサイトの利用実績から自動判定するため、このサイトをブックマークしたり何度か利用したあとに再試行すると通ることがあります。",
    );
    setRequesting(false);
  };

  return (
    <div className="card">
      <h2>ストレージ</h2>
      {status === null ? (
        <p className="note">確認中...</p>
      ) : (
        <>
          <p>
            永続化: <b>{!status.supported ? "非対応のブラウザ" : status.persisted ? "有効" : "無効"}</b>
            {status.usage !== null && (
              <span className="note">
                {" / "}使用量 {formatBytes(status.usage)}
                {status.quota !== null && ` (上限 ${formatBytes(status.quota)})`}
              </span>
            )}
          </p>
          <p className="note">
            このアプリのデータ(レポート・プロジェクト・LLM で生成した中間データ)は、
            サーバではなくブラウザにしか存在しません。永続化が<b>無効</b>だと、
            端末の空き容量が逼迫したときにブラウザの判断で<b>まとめて削除されることがあります</b>。 中間データは LLM
            課金で得たものなので、消えると再取得に実費がかかります。
          </p>
          <p className="note">
            永続化は<b>オリジン単位</b>で、IndexedDB・OPFS・Cache Storage
            (ローカル埋め込みモデル)をまとめて対象にします。API ごとの指定はできません。
          </p>
          {status.supported && !status.persisted && (
            <button type="button" onClick={request} disabled={requesting}>
              {requesting ? "要求中..." : "永続化を要求する"}
            </button>
          )}
          {message && (
            <p className="note" style={{ marginTop: 8 }}>
              {message}
            </p>
          )}
          <p className="note">
            永続化は保証ではありません(ブラウザのデータ消去操作では消えます)。 完成したレポートは JSON
            でエクスポートしておくのが確実です。
          </p>
        </>
      )}
    </div>
  );
}

function DangerZoneCard() {
  const [wiping, setWiping] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [wipeOrigin, setWipeOrigin] = useState(false);
  const [foreign, setForeign] = useState<{ databases: string[]; opfsEntries: string[] } | null>(null);

  // 同じオリジンに同居している他アプリのデータを、消す前に見せる
  const inspect = async () => {
    const { listForeignData } = await import("../lib/storage/reset");
    setForeign(await listForeignData());
  };

  const wipe = async () => {
    const extra = wipeOrigin
      ? `\n\n【注意】このオリジン(${window.location.origin})にある他のアプリのデータ` +
        "(IndexedDB / OPFS)も削除します。GitHub Pages では同じアカウントの他プロジェクトと共有されます。"
      : "";
    const ok = window.confirm(
      "このアプリの保存データを削除します。\n\n" +
        "・作成したレポートとプロジェクト\n" +
        "・意見抽出や埋め込みなど、LLM を使って生成した中間データ(再実行には再課金が必要です)" +
        extra +
        "\n\nこの操作は取り消せません。必要なレポートは先に JSON でエクスポートしてください。\n\n続行しますか?",
    );
    if (!ok) return;
    if (!window.confirm("本当に削除しますか? 削除後はページを再読み込みします。")) return;

    setWiping(true);
    setResult(null);
    try {
      const { wipeStoredData } = await import("../lib/storage/reset");
      const report = await wipeStoredData(wipeOrigin ? "origin" : "app");
      if (report.errors.length > 0) {
        setResult(
          `一部を削除できませんでした:\n${report.errors.join("\n")}\n\n` +
            `削除したデータベース: ${report.deletedDatabases.join(", ") || "なし"}`,
        );
        setWiping(false);
        return;
      }
      setResult("削除しました。再読み込みします...");
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      setResult(`削除に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      setWiping(false);
    }
  };

  return (
    <div className="card">
      <h2>保存データの削除</h2>
      <p className="note">
        このアプリがブラウザに保存したデータ(IndexedDB)を消します。 レポート・プロジェクト・LLM
        で生成した中間データが失われ、取り消せません。
        <br />
        <b>アップデート後にアプリが「読み込み中...」から進まない、または起動しない場合の復旧手段</b>
        としても使えます(データ形式の変換に失敗した状態をここから初期化できます)。 必要なレポートは先に JSON
        エクスポートしておいてください。
      </p>
      <p className="note">
        API キーなどの設定は消えません(下の「設定をすべて削除」で消せます)。
        ローカル埋め込みモデルのキャッシュも対象外です。
      </p>

      <label style={{ fontWeight: 400 }}>
        <input
          type="checkbox"
          style={{ width: "auto", marginRight: 6 }}
          checked={wipeOrigin}
          onChange={(e) => {
            setWipeOrigin(e.target.checked);
            if (e.target.checked && !foreign) inspect();
          }}
        />
        このオリジンの他のデータ(他アプリの IndexedDB / OPFS)も削除する
      </label>
      <p className="note" style={{ margin: "4px 0 8px" }}>
        IndexedDB と OPFS はパスではなく<b>オリジン単位</b>です。GitHub Pages
        で公開している場合、同じアカウントの他プロジェクトとオリジンを共有するため、
        <b>無関係なアプリのデータまで消えます</b>。本アプリは OPFS
        を使っていないので、復旧目的では通常このチェックは不要です。
      </p>
      {wipeOrigin && foreign && (
        <p className="note" style={{ whiteSpace: "pre-wrap", marginBottom: 8 }}>
          {foreign.databases.length === 0 && foreign.opfsEntries.length === 0
            ? "このオリジンに、他アプリのデータは見つかりませんでした。"
            : "一緒に削除されるもの:\n" +
              (foreign.databases.length ? `  IndexedDB: ${foreign.databases.join(", ")}\n` : "") +
              (foreign.opfsEntries.length ? `  OPFS: ${foreign.opfsEntries.join(", ")}` : "")}
        </p>
      )}

      <button type="button" className="danger" onClick={wipe} disabled={wiping}>
        {wiping ? "削除中..." : wipeOrigin ? "オリジンの保存データをすべて削除" : "このアプリの保存データを削除"}
      </button>
      {result && (
        <p className="note" style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>
          {result}
        </p>
      )}
    </div>
  );
}

export function SettingsPage() {
  const { settings, setConcurrency, clearAll } = useSettings();
  return (
    <div>
      <h1>設定</h1>
      <ProviderKeysCard />
      <SlotCard slot="chat" />
      <SlotCard slot="embedding" />
      <HealthCheckCard />
      <div className="card">
        <h2>実行設定</h2>
        <label>LLM リクエストの並列数(既定 8)</label>
        <input
          type="number"
          min={1}
          max={32}
          value={settings.concurrency}
          onChange={(e) => setConcurrency(Math.max(1, Number(e.target.value) || 8))}
        />
        <p className="note">レート制限(429)が頻発する場合は並列数を下げてください。セマフォで制御されます。</p>
      </div>
      <StorageCard />
      <DangerZoneCard />
      <button type="button" className="danger" onClick={clearAll}>
        設定をすべて削除(API キーを消去)
      </button>
    </div>
  );
}
