import { afterEach, describe, expect, it, vi } from "vitest";
import { Semaphore, requestChat } from "../src/lib/llm/client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const endpoint = { baseUrl: "https://mock/v1", apiKey: "k", model: "m" };
const schema = { name: "T", schema: { type: "object" } };

function okResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: {} }), { status: 200 });
}

describe("requestChat フォールバック", () => {
  it("json_schema 非対応(400)なら json_object にフォールバックする", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        calls.push(body.response_format?.type ?? "none");
        if (body.response_format?.type === "json_schema") {
          return new Response("unsupported", { status: 400 });
        }
        return okResponse('{"ok": true}');
      }),
    );
    const result = await requestChat(endpoint, {
      messages: [{ role: "user", content: "hi" }],
      jsonSchema: schema,
    });
    expect(result).toBe('{"ok": true}');
    expect(calls).toEqual(["json_schema", "json_object"]);
  });

  it("json_object も非対応なら素のプロンプトにフォールバックし、JSON指示を追記する", async () => {
    let lastUserContent = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.response_format) return new Response("unsupported", { status: 400 });
        lastUserContent = body.messages[body.messages.length - 1].content;
        return okResponse("{}");
      }),
    );
    await requestChat(endpoint, { messages: [{ role: "user", content: "hi" }], jsonSchema: schema });
    expect(lastUserContent).toContain("JSONのみで応答");
  });

  it("429 はリトライする", async () => {
    vi.useFakeTimers();
    let count = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        count++;
        if (count === 1) {
          return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
        }
        return okResponse("done");
      }),
    );
    const promise = requestChat(endpoint, { messages: [{ role: "user", content: "hi" }] });
    await vi.runAllTimersAsync();
    expect(await promise).toBe("done");
    expect(count).toBe(2);
  });

  it("401 はリトライせず即エラー", async () => {
    let count = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        count++;
        return new Response("unauthorized", { status: 401 });
      }),
    );
    await expect(requestChat(endpoint, { messages: [{ role: "user", content: "hi" }] })).rejects.toThrow("401");
    expect(count).toBe(1);
  });

  it("AbortSignal で中断できる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }),
    );
    const controller = new AbortController();
    const promise = requestChat(endpoint, { messages: [{ role: "user", content: "hi" }], signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow(/abort/i);
  });
});

describe("reasoning effort と追加ヘッダ", () => {
  it("reasoningEffort 指定時は reasoning_effort を送る", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: テスト用
    let sentBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body));
        return okResponse("ok");
      }),
    );
    await requestChat({ ...endpoint, reasoningEffort: "high" }, { messages: [{ role: "user", content: "hi" }] });
    expect(sentBody.reasoning_effort).toBe("high");
  });

  it("OpenRouter では reasoning: {effort} 形式で送る", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: テスト用
    let sentBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body));
        return okResponse("ok");
      }),
    );
    await requestChat(
      { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "m", reasoningEffort: "low" },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(sentBody.reasoning).toEqual({ effort: "low" });
  });

  it("reasoning 非対応(400)なら外して再試行する", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = String(init?.body);
        bodies.push(body);
        if (body.includes("reasoning_effort")) return new Response("unsupported parameter", { status: 400 });
        return okResponse("ok");
      }),
    );
    const result = await requestChat(
      { ...endpoint, reasoningEffort: "medium" },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(result).toBe("ok");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toContain("reasoning_effort");
  });

  it("extraHeaders が送信される(Anthropic ブラウザ直アクセス等)", async () => {
    let sentHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        sentHeaders = init?.headers as Record<string, string>;
        return okResponse("ok");
      }),
    );
    await requestChat(
      { ...endpoint, extraHeaders: { "anthropic-dangerous-direct-browser-access": "true" } },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(sentHeaders["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(sentHeaders.Authorization).toBe("Bearer k");
  });
});

describe("Semaphore", () => {
  it("並列数を制限する", async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let maxActive = 0;
    const tasks = Array.from({ length: 10 }, () =>
      semaphore.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      }),
    );
    await Promise.all(tasks);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
