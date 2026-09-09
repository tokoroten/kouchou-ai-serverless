import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseCsvFile } from "../src/lib/csv";

// NodeのBlobを実際に読み、Papa ParseのFileReader経路を検証する。
beforeAll(() => {
  vi.stubGlobal(
    "FileReader",
    class {
      result = "";
      onload: ((event: { target: { result: string } }) => void) | null = null;
      readAsText(blob: Blob) {
        void blob.text().then((text) => {
          this.result = text;
          this.onload?.({ target: { result: text } });
        });
      }
    },
  );
});
afterAll(() => vi.unstubAllGlobals());
const parse = async (file: File) => (await parseCsvFile(file)).rows;

describe("CSVの読み込み", () => {
  it.each([
    ['comment-body,age\n"unclosed,20', "引用符"],
    ["comment-body,age\na,20,extra", "列が多"],
    ["comment-body,age\na", "列が少"],
    ["comment-body,comment-body\na,b", "同じ名前"],
    ["comment-body,\na,b", "名前のない列"],
    ["comment-body,age", "データがありません"],
  ])("壊れたCSVを理由付きで拒否: %s", async (csv, reason) => {
    await expect(parse(new File([csv], "test.csv", { type: "text/csv" }))).rejects.toThrow(reason);
  });

  it.each([
    "comment-body\nfirst opinion\nsecond opinion",
    '\ufeffcomment-body,age\n"comma, and ""quotes""",20',
    'comment-body,age\r\n"multiple\nlines",20\r\nnext,30',
  ])("正常な1列・BOM・引用符・改行を受け入れる: %s", async (csv) => {
    const rows = await parse(new File([csv], "test.csv", { type: "text/csv" }));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]["comment-body"]).toBeTruthy();
  });
});
