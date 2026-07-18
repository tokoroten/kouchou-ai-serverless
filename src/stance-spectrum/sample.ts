import type { EdgeSet } from "./graph";
import { LEGACY_SAMPLE_FILE_TYPE, SAMPLE_FILE_TYPE } from "./storageKeys";
import type { Codebook, OpinionEnrichment, OpinionRecord } from "./types";

// 事前分析済みサンプル(賛否スペクトラム分析プレビュー)の直列化。
// LLM 前処理済みの records + codebook + 候補辺 + 初期座標を1ファイルに固め、
// 分析を実行しなくても賛否スペクトラム分析 UI を試せるようにする。

export type StanceSpectrumSample = {
  // 書き出しは常に SAMPLE_FILE_TYPE。読み込みは旧名称も受理する
  // (リネーム前にユーザがダウンロード済みのファイルは移行できないため)
  type: typeof SAMPLE_FILE_TYPE | typeof LEGACY_SAMPLE_FILE_TYPE;
  title: string;
  records: SerializedRecord[];
  codebook: Codebook;
  edges: {
    count: number;
    source: string;
    target: string;
    semantic: string;
    topic: string;
    stance: string;
    reason: string;
  };
  coords: { x: string; y: string };
};

type SerializedRecord = {
  id: string;
  commentId: string;
  claim: string;
  enrichment: OpinionEnrichment;
  topicVector: [number, number][];
  reasonVector: [number, number][];
  attributes?: Record<string, string>;
};

export function serializeSample(
  title: string,
  records: OpinionRecord[],
  codebook: Codebook,
  edges: EdgeSet,
  coords: { x: Float32Array; y: Float32Array },
): StanceSpectrumSample {
  return {
    type: SAMPLE_FILE_TYPE,
    title,
    records: records.map((r) => ({
      id: r.id,
      commentId: r.originalCommentId,
      claim: r.claimText,
      enrichment: r.enrichment,
      topicVector: [...r.topicVector.entries()],
      reasonVector: [...r.reasonVector.entries()],
      attributes: r.attributes,
    })),
    codebook,
    edges: {
      count: edges.count,
      source: b64FromBytes(new Uint8Array(edges.source.buffer, edges.source.byteOffset, edges.source.byteLength)),
      target: b64FromBytes(new Uint8Array(edges.target.buffer, edges.target.byteOffset, edges.target.byteLength)),
      semantic: b64FromBytes(
        new Uint8Array(edges.semantic.buffer, edges.semantic.byteOffset, edges.semantic.byteLength),
      ),
      topic: b64FromBytes(new Uint8Array(edges.topic.buffer, edges.topic.byteOffset, edges.topic.byteLength)),
      stance: b64FromBytes(new Uint8Array(edges.stance.buffer, edges.stance.byteOffset, edges.stance.byteLength)),
      reason: b64FromBytes(new Uint8Array(edges.reason.buffer, edges.reason.byteOffset, edges.reason.byteLength)),
    },
    coords: {
      x: b64FromBytes(new Uint8Array(coords.x.buffer, coords.x.byteOffset, coords.x.byteLength)),
      y: b64FromBytes(new Uint8Array(coords.y.buffer, coords.y.byteOffset, coords.y.byteLength)),
    },
  };
}

export function deserializeSample(sample: StanceSpectrumSample): {
  title: string;
  records: OpinionRecord[];
  codebook: Codebook;
  edges: EdgeSet;
  coords: { x: Float32Array; y: Float32Array };
} {
  if (sample.type !== SAMPLE_FILE_TYPE && sample.type !== LEGACY_SAMPLE_FILE_TYPE) {
    throw new Error("賛否スペクトラム分析サンプルのファイルではありません");
  }
  const records: OpinionRecord[] = sample.records.map((r) => ({
    id: r.id,
    originalCommentId: r.commentId,
    claimText: r.claim,
    enrichment: r.enrichment,
    topicVector: new Map(r.topicVector),
    reasonVector: new Map(r.reasonVector),
    attributes: r.attributes,
  }));
  const edges: EdgeSet = {
    count: sample.edges.count,
    source: new Int32Array(bytesFromB64(sample.edges.source).buffer),
    target: new Int32Array(bytesFromB64(sample.edges.target).buffer),
    semantic: new Float32Array(bytesFromB64(sample.edges.semantic).buffer),
    topic: new Float32Array(bytesFromB64(sample.edges.topic).buffer),
    stance: new Float32Array(bytesFromB64(sample.edges.stance).buffer),
    reason: new Float32Array(bytesFromB64(sample.edges.reason).buffer),
  };
  return {
    title: sample.title,
    records,
    codebook: sample.codebook,
    edges,
    coords: {
      x: new Float32Array(bytesFromB64(sample.coords.x).buffer),
      y: new Float32Array(bytesFromB64(sample.coords.y).buffer),
    },
  };
}

function b64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function bytesFromB64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
