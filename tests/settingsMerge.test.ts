import { describe, expect, it } from "vitest";
import { fillMissingSettings } from "../src/store/settings";
import { DEFAULT_SETTINGS, resolveEndpoint, type Settings } from "../src/types/settings";

// zustand の既定 merge は最上位の浅いマージなので、保存済みの settings が丸ごと
// 復元される。Settings にフィールドを足したときに既存ユーザの設定が壊れないことを
// 保証するのがこの関数の役目。

describe("fillMissingSettings", () => {
  it("保存が無ければ既定値を返す", () => {
    expect(fillMissingSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(fillMissingSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it("ユーザが入力した API キーとモデル選択を保持する", () => {
    const saved = {
      settings: {
        providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" } },
        chatSlot: { provider: "openai", model: "gpt-5-mini" },
        concurrency: 4,
      },
    };
    const filled = fillMissingSettings(saved);
    expect(filled.providers.openai?.apiKey).toBe("sk-test");
    expect(filled.chatSlot).toEqual({ provider: "openai", model: "gpt-5-mini" });
    expect(filled.concurrency).toBe(4);
  });

  it("後から追加されたフィールド(imageSlot)を既定値で補う", () => {
    // imageSlot がまだ無かった頃の保存データ
    const saved = {
      settings: {
        providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" } },
        chatSlot: { provider: "openai", model: "gpt-5-mini" },
        embeddingSlot: { provider: "openai", model: "text-embedding-3-small" },
        concurrency: 8,
      },
    };
    const filled = fillMissingSettings(saved);
    expect(filled.imageSlot).toEqual(DEFAULT_SETTINGS.imageSlot);
    // 既存の値は失われていない
    expect(filled.providers.openai?.apiKey).toBe("sk-test");
    expect(filled.chatSlot.model).toBe("gpt-5-mini");
  });

  it("スロットの一部だけ保存されていても既定値で埋まる", () => {
    const filled = fillMissingSettings({ settings: { chatSlot: { provider: "openai" } } });
    expect(filled.chatSlot.provider).toBe("openai");
    expect(filled.chatSlot.model).toBe("");
    expect(filled.embeddingSlot).toEqual(DEFAULT_SETTINGS.embeddingSlot);
  });
});

describe("resolveEndpoint: image スロット", () => {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" } },
    imageSlot: { provider: "openai", model: "" },
  };

  it("未選択なら空のエンドポイントを返す", () => {
    expect(resolveEndpoint(DEFAULT_SETTINGS, "image")).toEqual({ baseUrl: "", apiKey: "", model: "" });
  });

  it("モデル未指定ならプリセットの既定画像モデルを使う", () => {
    const endpoint = resolveEndpoint(settings, "image");
    expect(endpoint.baseUrl).toBe("https://api.openai.com/v1");
    expect(endpoint.apiKey).toBe("sk-test");
    // gpt-image-1 は 2026-10 廃止予定のため、既定は現行フラッグシップの 1.5
    expect(endpoint.model).toBe("gpt-image-1.5");
  });

  it("明示したモデルが優先される", () => {
    const endpoint = resolveEndpoint({ ...settings, imageSlot: { provider: "openai", model: "dall-e-3" } }, "image");
    expect(endpoint.model).toBe("dall-e-3");
  });

  it("chat 専用の設定(reasoningEffort/serviceTier)は image では空になる", () => {
    const endpoint = resolveEndpoint(
      { ...settings, imageSlot: { provider: "openai", model: "", reasoningEffort: "high", serviceTier: "flex" } },
      "image",
    );
    expect(endpoint.reasoningEffort).toBe("");
    expect(endpoint.serviceTier).toBe("");
  });
});
