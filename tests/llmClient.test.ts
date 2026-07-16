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
