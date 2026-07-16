import { useState } from "react";
import { listModels, listModelsDetailed, probeChat, requestEmbeddings } from "../lib/llm/client";
import { useSettings } from "../store/settings";
import { PRESETS, type PresetId, isProviderConfigured, resolveEndpoint } from "../types/settings";

// 設定画面(DESIGN §4)。
// 1. プロバイダごとに API キー等を登録
// 2. chat / embedding スロットは「設定済みプロバイダ」からのみ選択可能
// 3. 疎通確認: モデル一覧取得 / 埋め込み1件 / チャット応答テスト(タイムアウト検知)

const KEY_REQUIRED: PresetId[] = ["openai", "openrouter", "azure", "bedrock"];
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
              const preset = PRESETS.find((p) => p.id === id);
              setSlot({
                provider: id,
                model: preset ? (slot === "chat" ? preset.chatModel : preset.embeddingModel) : "",
              });
              setModels([]);
              setTestResult(preset?.corsNote ?? null);
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
              <label>モデル</label>
              {models.length > 0 ? (
                <select value={selection.model} onChange={(e) => setSlot({ model: e.target.value })}>
                  {!models.includes(selection.model) && <option value={selection.model}>{selection.model}</option>}
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={selection.model}
                  onChange={(e) => setSlot({ model: e.target.value })}
                  placeholder="モデル名(接続テストで一覧を取得できます)"
                />
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

export function SettingsPage() {
  const { settings, setConcurrency, clearAll } = useSettings();
  return (
    <div>
      <h1>設定</h1>
      <ProviderKeysCard />
      <SlotCard slot="chat" />
      <SlotCard slot="embedding" />
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
