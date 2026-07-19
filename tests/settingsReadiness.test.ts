import { describe, expect, it } from "vitest";
import { fillMissingSettings } from "../src/store/settings";
import {
  DEFAULT_SETTINGS,
  endpointFingerprint,
  pipelineReadiness,
  resolveEndpoint,
  type Settings,
  slotReadiness,
} from "../src/types/settings";

// 環境構築の「済/未済」判定(トップの警告バナーの条件)。

function configured(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    providers: { openai: { baseUrl: "", apiKey: "sk-test-123" } },
    chatSlot: { provider: "openai", model: "gpt-5-nano" },
    embeddingSlot: { provider: "openai", model: "text-embedding-3-small" },
    verification: {},
  };
}

/** 現在の構成で疎通確認に成功した状態にする */
function verify(settings: Settings, slot: "chat" | "embedding"): Settings {
  return {
    ...settings,
    verification: {
      ...settings.verification,
      [slot]: { fingerprint: endpointFingerprint(resolveEndpoint(settings, slot)), at: 1 },
    },
  };
}

describe("slotReadiness", () => {
  it("初期状態は未設定", () => {
    const r = slotReadiness(DEFAULT_SETTINGS, "chat");
    expect(r.state).toBe("unset");
    expect(r.reason).toContain("未選択");
  });

  it("キーを消したら未設定に戻る(baseUrl だけ見る判定の穴)", () => {
    const settings = { ...configured(), providers: {} };
    // resolveEndpoint はプリセットの baseUrl で埋めるため、baseUrl 判定だけだと通ってしまう
    expect(resolveEndpoint(settings, "chat").baseUrl).toBeTruthy();
    expect(slotReadiness(settings, "chat").state).toBe("unset");
  });

  it("設定済みでも疎通確認前は unverified", () => {
    expect(slotReadiness(configured(), "chat").state).toBe("unverified");
  });

  it("疎通確認すると ok", () => {
    expect(slotReadiness(verify(configured(), "chat"), "chat").state).toBe("ok");
  });

  it("モデルを変えると未確認に戻る", () => {
    const settings = verify(configured(), "chat");
    const changed = { ...settings, chatSlot: { ...settings.chatSlot, model: "gpt-5-mini" } };
    const r = slotReadiness(changed, "chat");
    expect(r.state).toBe("unverified");
    expect(r.reason).toContain("変更");
  });

  it("API キーを差し替えると未確認に戻る", () => {
    const settings = verify(configured(), "chat");
    const changed = { ...settings, providers: { openai: { baseUrl: "", apiKey: "sk-other-999" } } };
    expect(slotReadiness(changed, "chat").state).toBe("unverified");
  });

  it("ブラウザ内実行のプロバイダもキー無しで設定済み扱いになる", () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      chatSlot: { provider: "gemini-nano", model: "gemini-nano" },
    };
    // キー不要だが、疎通確認は必要(実際に使えるとは限らないため)
    expect(slotReadiness(settings, "chat").state).toBe("unverified");
  });
});

describe("endpointFingerprint", () => {
  it("API キーそのものを含まない", () => {
    const fp = endpointFingerprint({ baseUrl: "https://x/v1", apiKey: "sk-super-secret", model: "m" });
    expect(fp).not.toContain("sk-super-secret");
    expect(fp).not.toContain("secret");
  });

  it("同じ構成なら同じ指紋", () => {
    const e = { baseUrl: "https://x/v1", apiKey: "k", model: "m" };
    expect(endpointFingerprint(e)).toBe(endpointFingerprint({ ...e }));
  });
});

describe("pipelineReadiness", () => {
  it("未設定は blocked(実行できない)", () => {
    const r = pipelineReadiness(DEFAULT_SETTINGS);
    expect(r.blocked).toBe(true);
    expect(r.ready).toBe(false);
    expect(r.slots.map((s) => s.slot)).toEqual(["chat", "embedding"]);
  });

  it("設定済み・疎通未確認は blocked ではない(警告のみ)", () => {
    const r = pipelineReadiness(configured());
    expect(r.blocked).toBe(false);
    expect(r.ready).toBe(false);
  });

  it("両方確認済みなら ready", () => {
    const r = pipelineReadiness(verify(verify(configured(), "chat"), "embedding"));
    expect(r.ready).toBe(true);
    expect(r.blocked).toBe(false);
  });
});

describe("fillMissingSettings", () => {
  it("verification を持たない旧設定を読んでも落ちない", () => {
    const old = { settings: { providers: {}, chatSlot: { provider: "openai", model: "m" }, concurrency: 8 } };
    const filled = fillMissingSettings(old);
    expect(filled.verification).toEqual({});
    expect(() => slotReadiness(filled, "chat")).not.toThrow();
    // ユーザが入力した値は保持される
    expect(filled.chatSlot.model).toBe("m");
  });
});
