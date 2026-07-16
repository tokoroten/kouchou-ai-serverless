// 本家 services/parse_json_list.py の移植 + 寛容な JSON パース(DESIGN §4.3)。

const COMMA_BEFORE_BRACKET = /,\s*([\]}])/g;

/** ```json フェンス・<think>...</think> を除去する */
export function stripNoise(text: string): string {
  let t = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/g, "");
  t = t.replace(/```json/g, "").replace(/```/g, "");
  return t.trim();
}

/** 寛容な JSON オブジェクトパース。失敗時は null を返す。 */
export function parseJsonObjectLoose(text: string): Record<string, unknown> | null {
  const cleaned = stripNoise(text);
  const candidates = [cleaned];
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) candidates.push(match[0]);
  for (const candidate of candidates) {
    for (const source of [candidate, candidate.replace(COMMA_BEFORE_BRACKET, "$1")]) {
      try {
        const obj = JSON.parse(source);
        if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
          return obj as Record<string, unknown>;
        }
      } catch {
        // 次の候補へ
      }
    }
  }
  return null;
}

/**
 * extraction レスポンスのパース(本家 parse_extraction_response 相当)。
 * {"extractedOpinionList": [...]} 形式を期待し、失敗時は空リスト。
 */
export function parseExtractionResponse(response: string | Record<string, unknown>): string[] {
  try {
    const obj = typeof response === "string" ? parseJsonObjectLoose(response) : response;
    if (!obj) return parseListFallback(typeof response === "string" ? response : "");
    const list = obj.extractedOpinionList;
    if (!Array.isArray(list)) return [];
    return list.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((s) => s.trim());
  } catch {
    return [];
  }
}

/**
 * 本家 parse_response 相当: テキストから JSON 配列を抽出する。
 * extractedOpinionList 形式でない素の配列応答へのフォールバック。
 */
export function parseListFallback(response: string): string[] {
  try {
    const obj = JSON.parse(response);
    if (typeof obj === "string") return [obj].filter((s) => s.trim());
    if (Array.isArray(obj))
      return obj
        .filter((a): a is string => typeof a === "string")
        .map((a) => a.trim())
        .filter(Boolean);
    return [];
  } catch {
    const cleaned = stripNoise(response);
    const match = cleaned.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const jsonStr = match[0].replace(COMMA_BEFORE_BRACKET, "$1");
    try {
      const obj = JSON.parse(jsonStr);
      if (typeof obj === "string") return [obj];
      if (Array.isArray(obj))
        return obj
          .filter((a): a is string => typeof a === "string")
          .map((a) => a.trim())
          .filter(Boolean);
      return [];
    } catch {
      return [];
    }
  }
}

/** label/description レスポンスのパース。失敗時は null。 */
export function parseLabelResponse(response: string): { label: string; description: string } | null {
  const obj = parseJsonObjectLoose(response);
  if (!obj) return null;
  const label = obj.label;
  const description = obj.description;
  if (typeof label !== "string") return null;
  return {
    label,
    description: typeof description === "string" ? description : "",
  };
}

/** overview レスポンスのパース。失敗時は <think> 除去済みの生テキスト(本家と同じ)。 */
export function parseOverviewResponse(response: string): string {
  const obj = parseJsonObjectLoose(response);
  if (obj && typeof obj.summary === "string") return obj.summary;
  return response.replace(/<think\b[^>]*>[\s\S]*?<\/think>/g, "").trim();
}
