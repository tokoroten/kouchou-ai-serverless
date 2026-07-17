import { useState } from "react";
import { listModels, listModelsDetailed, probeChat, requestEmbeddings } from "../lib/llm/client";
import { useSettings } from "../store/settings";
import { PRESETS, type PresetId, isProviderConfigured, resolveEndpoint } from "../types/settings";

// 設定画面(DESIGN §4)。
// 1. プロバイダごとに API キー等を登録
// 2. chat / embedding スロットは「設定済みプロバイダ」からのみ選択可能
// 3. 疎通確認: モデル一覧取得 / 埋め込み1件 / チャット応答テスト(タイムアウト検知)

const KEY_REQUIRED: PresetId[] = ["openai", "anthropic", "grok", "openrouter", "azure", "bedrock"];
const URL_EDITABLE: PresetId[] = ["azure", "bedrock", "lmstudio", "ollama", "custom"];
const LOCAL_PROVIDERS: PresetId[] = ["gemini-nano", "local-embedding"];

function ProviderKeysCard() {
  const { settings, setProvider, removeProvider } = useSettings();
  return (
    <div className="card">
      <h2>プロバイダの API キー</h2>
      <p className="note">
        キーを入力したプロバイダだけが下のスロットで選択可能になります。キーはこのブラウザ(localStorage)にのみ保存され、
        該当プロバイダの API 以外には送信されません。
      </p>
      {PRESETS.filter((p) => !LOCAL_PROVIDERS.includes(p.id)).map((preset) => {
        const config = settings.providers[preset.id];
        const configured = isProviderConfigured(preset.id, settings);
        return (
          <div key={preset.id} style={{ borderTop: "1px solid var(--border)", padding: "10px 0" }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <b>
                {configured ? "✅" : "○"} {preset.label}
              </b>
              {config && (
                <button type="button" className="danger" onClick={() => removeProvider(preset.id)}>
                  削除
                </button>
              )}
            </div>
            <div className="row">
              {URL_EDITABLE.includes(preset.id) && (
                <input
                  style={{ flex: 2, minWidth: 240 }}
                  placeholder={preset.baseUrl || "ベース URL (例: http://localhost:1234/v1)"}
                  value={config?.baseUrl ?? ""}
                  onChange={(e) => setProvider(preset.id, { baseUrl: e.target.value })}
                />
              )}
              <input
                style={{ flex: 3, minWidth: 240 }}
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
            </div>
            <p className="note" style={{ margin: "4px 0 0" }}>
              {preset.corsNote}
            </p>
          </div>
        );
      })}
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
  // 標準モデルリスト + 接続テスト/自動取得したモデルリストをマージ
  const knownModels = (slot === "chat" ? preset?.knownChatModels : preset?.knownEmbeddingModels) ?? [];
  const modelChoices = [...new Set([...knownModels, ...models])];

  // プロバイダ選択時にモデル一覧を自動取得(失敗しても標準リストで選べるので無視)
  const autoFetchModels = async (id: PresetId | null) => {
    if (!id || id === "gemini-nano" || id === "local-embedding") return;
    try {
      const selected = PRESETS.find((p) => p.id === id);
      const provider = settings.providers[id];
      const list = await listModels({
        baseUrl: provider?.baseUrl || selected?.baseUrl || "",
        apiKey: provider?.apiKey ?? "",
        model: "",
        authHeader: selected?.authHeader ?? "bearer",
        extraHeaders: selected?.extraHeaders,
      });
      setModels(list);
    } catch {
      // 標準リストのみ
    }
  };

  // チャット応答テスト: 小リクエストを投げてレイテンシ計測(30秒でタイムアウト検知)
  const probeResponse = async () => {
    setTesting(true);
    setTestResult("応答テスト中(最大30秒)...");
    try {
      const result = await probeChat(endpoint, 30_000);
      setTestResult(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`);
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
      const free = all.filter((m) => m.isFree).map((m) => m.id);
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
      setModels(list);
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
          <label>プロバイダ</label>
          <select
            value={selection.provider ?? ""}
            onChange={(e) => {
              const id = (e.target.value || null) as PresetId | null;
              const selected = PRESETS.find((p) => p.id === id);
              setSlot({
                provider: id,
                model: selected ? (slot === "chat" ? selected.chatModel : selected.embeddingModel) : "",
              });
              setModels([]);
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
                  (候補から選択 or 直接入力。取得済み {models.length} 件 + 標準 {knownModels.length} 件)
                </span>
              </label>
              {modelChoices.length > 0 && (
                <div className="row" style={{ marginBottom: 4 }}>
                  {modelChoices.slice(0, 8).map((m) => (
                    <button
                      type="button"
                      key={m}
                      className={selection.model === m ? "primary" : ""}
                      style={{ padding: "4px 10px", fontSize: "0.85rem" }}
                      onClick={() => setSlot({ model: m })}
                    >
                      {m}
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
                  <option key={m} value={m} />
                ))}
              </datalist>
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
                {slot === "chat" && (
                  <button type="button" onClick={probeResponse} disabled={testing || !selection.model}>
                    応答テスト(タイムアウト確認)
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
      update(probe.ok ? "ok" : "ng", probe.message);
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
      <button type="button" className="danger" onClick={clearAll}>
        設定をすべて削除(API キーを消去)
      </button>
    </div>
  );
}
