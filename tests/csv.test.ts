import { describe, expect, it } from "vitest";
import { normalizeComments } from "../src/lib/csv";

describe("normalizeComments", () => {
  it("空・空白のみの comment-body を除外する(本家 #583)", () => {
    const rows = [
      { "comment-id": "1", "comment-body": "意見" },
      { "comment-id": "2", "comment-body": "" },
      { "comment-id": "3", "comment-body": "   " },
      { "comment-id": "4", "comment-body": "別の意見" },
    ];
    const result = normalizeComments(rows, "comment-body", "comment-id", []);
    expect(result.map((c) => c.commentId)).toEqual(["1", "4"]);
  });

  it("ID 列がなければ行番号を振る", () => {
    const rows = [{ body: "a" }, { body: "b" }];
    const result = normalizeComments(rows, "body", null, []);
    expect(result.map((c) => c.commentId)).toEqual(["0", "1"]);
  });

  it("重複 ID には行番号サフィックスを付ける", () => {
    const rows = [
      { id: "x", body: "a" },
      { id: "x", body: "b" },
    ];
    const result = normalizeComments(rows, "body", "id", []);
    expect(result[0].commentId).toBe("x");
    expect(result[1].commentId).toBe("x_1");
  });

  it("属性列を取り込む", () => {
    const rows = [{ body: "a", age: "20代", region: "東京" }];
    const result = normalizeComments(rows, "body", null, ["age"]);
    expect(result[0].attributes).toEqual({ age: "20代" });
  });
});
