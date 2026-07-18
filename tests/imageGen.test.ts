import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPonchiePrompt, generateImage, pickFallbackSize } from "../src/lib/imageGen";
import type { Cluster, Result } from "../src/types/result";
import type { EndpointConfig } from "../src/types/settings";

function cluster(level: number, id: string, label: string, value = 10): Cluster {
  return { level, id, label, takeaway: `${label}の要点`, value, parent: level > 1 ? "1_1" : "0" } as Cluster;
}

function makeResult(overrides: Partial<Result> = {}): Result {
  return {
    arguments: [],
    clusters: [cluster(1, "1_1", "賛成の立場", 100), cluster(1, "1_2", "反対の立場", 80)],
    comment_num: 10,
    overview: "賛否が拮抗している。",
    config: { name: "テストレポート", question: "どう思いますか", intro: "" },
    ...overrides,
  } as Result;
}

const endpoint: EndpointConfig = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
  model: "gpt-image-1",
};

const PNG_B64 = "iVBORw0KGgo=";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildPonchiePrompt", () => {
  it("タイトル・概要・論点を含む", () => {
    const prompt = buildPonchiePrompt(makeResult());
    expect(prompt).toContain("テストレポート");
    expect(prompt).toContain("賛否が拮抗している。");
    expect(prompt).toContain("賛成の立場");
    expect(prompt).toContain("反対の立場");
  });

  it("最深ではなく第1階層を論点に使う(細かすぎると絵にならない)", () => {
    const result = makeResult({
      clusters: [cluster(1, "1_1", "粗い論点"), cluster(2, "2_1", "細かい論点")],
    });
    const prompt = buildPonchiePrompt(result);
    expect(prompt).toContain("粗い論点");
    expect(prompt).not.toContain("細かい論点");
  });

  it("件数の多いクラスタを優先し、12件までに絞る", () => {
    const clusters = Array.from({ length: 30 }, (_, i) => cluster(1, `1_${i}`, `論点${i}`, i));
    const prompt = buildPonchiePrompt(makeResult({ clusters }));
    // 最大件数の論点29が入り、最小の論点0は落ちる
    expect(prompt).toContain("論点29");
    expect(prompt).not.toContain("論点0、");
    const topicLine = prompt.split("\n").find((l) => l.startsWith("主な論点:")) ?? "";
    expect(topicLine.split("、")).toHaveLength(12);
  });

  it("クラスタが大量でもプロンプト上限(3800字)を超えない", () => {
    const longLabel = "あ".repeat(500);
    const clusters = Array.from({ length: 50 }, (_, i) => cluster(1, `1_${i}`, `${longLabel}${i}`, i));
    const prompt = buildPonchiePrompt(makeResult({ clusters }));
    expect(prompt.length).toBeLessThanOrEqual(3800);
  });

  it("クラスタが無くても論点行を出さずに成立する", () => {
    const prompt = buildPonchiePrompt(makeResult({ clusters: [] }));
    expect(prompt).not.toContain("主な論点:");
    expect(prompt).toContain("テストレポート");
  });

  it("タイトルが空文字でも既定名になる", () => {
    const result = makeResult({ config: { name: "", question: "", intro: "" } } as Partial<Result>);
    expect(buildPonchiePrompt(result)).toContain("広聴AIレポート");
  });
});

describe("generateImage", () => {
  it("b64_json を PNG Blob にする", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const blob = await generateImage(endpoint, "prompt");
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBeGreaterThan(0);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body).model).toBe("gpt-image-1");
  });

  it("gpt-image-1 には response_format を送らない(送るとエラーになる)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await generateImage(endpoint, "prompt");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("response_format");
  });

  it("dall-e-3 には初回 b64_json を明示する(旧 API の既定が URL のため)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await generateImage({ ...endpoint, model: "dall-e-3" }, "prompt");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).response_format).toBe("b64_json");
  });

  it("response_format が原因の 400 なら、外して1回だけ再試行する(現行 API はパラメータ自体を拒否)", async () => {
    const reject = new Response(
      JSON.stringify({ error: { message: "Unknown parameter: 'response_format'.", param: "response_format" } }),
      { status: 400 },
    );
    const ok = new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 });
    const fetchMock = vi.fn().mockResolvedValueOnce(reject).mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);

    const blob = await generateImage({ ...endpoint, model: "dall-e-3" }, "prompt");
    expect(blob.type).toBe("image/png");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toHaveProperty("response_format");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty("response_format");
  });

  it("再試行は1回まで(2回目も response_format 起因の 400 ならそのままエラー)", async () => {
    const reject = () =>
      new Response(JSON.stringify({ error: { message: "Unknown parameter: 'response_format'." } }), { status: 400 });
    const fetchMock = vi.fn().mockResolvedValueOnce(reject()).mockResolvedValueOnce(reject());
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateImage({ ...endpoint, model: "dall-e-3" }, "prompt")).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("response_format と無関係な 400 は再試行しない", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: { message: "billing_hard_limit" } }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateImage({ ...endpoint, model: "dall-e-3" }, "prompt")).rejects.toThrow(/billing/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("応答が URL 形式なら画像をダウンロードして Blob にする", async () => {
    const pngBytes = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ url: "https://images.example/generated.png" }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(pngBytes, { status: 200, headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);

    const blob = await generateImage(endpoint, "prompt");
    expect(blob.size).toBe(pngBytes.length);
    expect(fetchMock.mock.calls[1][0]).toBe("https://images.example/generated.png");
  });

  it("api-key 方式(Azure)のヘッダを使う", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await generateImage({ ...endpoint, authHeader: "api-key" }, "prompt");
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["api-key"]).toBe("sk-test");
    expect(headers.Authorization).toBeUndefined();
  });

  it("エラー応答の本文をメッセージに含める", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"error":{"message":"content_policy_violation"}}', { status: 400 })),
    );
    await expect(generateImage(endpoint, "prompt")).rejects.toThrow(/400.*content_policy_violation/s);
  });

  it("b64_json が無い応答はエラーにする", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{}] }), { status: 200 })));
    await expect(generateImage(endpoint, "prompt")).rejects.toThrow(/b64_json/);
  });

  it("プロバイダ未設定なら API を呼ばずに止める", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateImage({ ...endpoint, baseUrl: "" }, "prompt")).rejects.toThrow(/設定/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("既定サイズは 4:3(1280x960)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await generateImage(endpoint, "prompt");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).size).toBe("1280x960");
  });

  it("モデルが 4:3 非対応なら、エラー文面の対応一覧から横長を選んで再試行する", async () => {
    // gpt-image-1 系の実際のエラー文面
    const reject = new Response(
      JSON.stringify({
        error: { message: "Invalid size '1280x960'. Supported sizes are 1024x1024, 1024x1536, 1536x1024, and auto." },
      }),
      { status: 400 },
    );
    const ok = new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 });
    const fetchMock = vi.fn().mockResolvedValueOnce(reject).mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);

    await generateImage(endpoint, "prompt");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 横長(1536x1024)が選ばれる。縦長や正方形ではない
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).size).toBe("1536x1024");
  });

  it("サイズと無関係な 400 はサイズ再試行しない", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: { message: "rate limit" } }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateImage(endpoint, "prompt")).rejects.toThrow(/rate limit/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pickFallbackSize: 横長 > 正方形 の優先で選ぶ", () => {
    expect(pickFallbackSize("Supported sizes are 1024x1024, 1024x1536, 1536x1024, and auto.")).toBe("1536x1024");
    expect(pickFallbackSize("Supported sizes are 1024x1024 and auto.")).toBe("1024x1024");
    expect(pickFallbackSize("no sizes here")).toBeNull();
  });

  it("signal が fetch へ渡る(中断できる)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await generateImage(endpoint, "prompt", { signal: controller.signal });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });
});
