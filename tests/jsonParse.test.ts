import { describe, expect, it } from "vitest";
import {
  parseExtractionResponse,
  parseJsonObjectLoose,
  parseLabelResponse,
  parseListFallback,
  parseOverviewResponse,
} from "../src/lib/llm/jsonParse";

describe("parseExtractionResponse", () => {
  it("正常な JSON をパースする", () => {
    expect(parseExtractionResponse('{"extractedOpinionList": ["a", "b"]}')).toEqual(["a", "b"]);
  });

  it("json フェンス付きをパースする", () => {
    expect(parseExtractionResponse('```json\n{"extractedOpinionList": ["a"]}\n```')).toEqual(["a"]);
  });

  it("<think> タグを除去する", () => {
    expect(parseExtractionResponse('<think>考え中...</think>{"extractedOpinionList": ["a"]}')).toEqual(["a"]);
  });

  it("末尾カンマを許容する", () => {
    expect(parseExtractionResponse('{"extractedOpinionList": ["a", "b", ]}')).toEqual(["a", "b"]);
  });

  it("リストでない場合は空", () => {
    expect(parseExtractionResponse('{"extractedOpinionList": "a"}')).toEqual([]);
  });

  it("壊れた JSON は空", () => {
    expect(parseExtractionResponse("これはJSONではありません")).toEqual([]);
  });

  it("dict をそのまま受ける", () => {
    expect(parseExtractionResponse({ extractedOpinionList: ["x"] })).toEqual(["x"]);
  });

  it("空文字列の要素を除去する", () => {
    expect(parseExtractionResponse('{"extractedOpinionList": ["a", "", "  "]}')).toEqual(["a"]);
  });
});

describe("parseListFallback(本家 parse_response 相当)", () => {
  it("説明文に埋まった JSON 配列を抽出する", () => {
    expect(parseListFallback('Response was: なんか説明\n[ "x", "y" ] さらに何か')).toEqual(["x", "y"]);
  });

  it("末尾カンマの配列を許容する", () => {
    expect(parseListFallback('["a", "b" , ]')).toEqual(["a", "b"]);
  });

  it("単一文字列は1要素リスト", () => {
    expect(parseListFallback('"a"')).toEqual(["a"]);
  });
});

describe("parseLabelResponse", () => {
  it("label/description をパースする", () => {
    expect(parseLabelResponse('{"label": "L", "description": "D"}')).toEqual({ label: "L", description: "D" });
  });

  it("フェンス・前置きに寛容", () => {
    expect(parseLabelResponse('もちろんです!\n```json\n{"label": "L", "description": "D"}\n```')).toEqual({
      label: "L",
      description: "D",
    });
  });

  it("label がなければ null", () => {
    expect(parseLabelResponse('{"description": "D"}')).toBeNull();
  });
});

describe("parseOverviewResponse", () => {
  it("summary をパースする", () => {
    expect(parseOverviewResponse('{"summary": "全体の要約"}')).toBe("全体の要約");
  });

  it("失敗時は <think> を除去した生テキスト(本家と同じ)", () => {
    expect(parseOverviewResponse("<think>推論</think>要約テキスト")).toBe("要約テキスト");
  });
});

describe("parseJsonObjectLoose", () => {
  it("入れ子の JSON も抽出する", () => {
    expect(parseJsonObjectLoose('前置き {"a": {"b": 1}} 後書き')).toEqual({ a: { b: 1 } });
  });
});
