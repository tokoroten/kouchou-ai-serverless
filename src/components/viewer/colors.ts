// 本家 public-viewer ScatterChart.tsx の softColors を移植。
export const SOFT_COLORS = [
  "#7ac943",
  "#3fa9f5",
  "#ff7997",
  "#e0dd02",
  "#d6410f",
  "#b39647",
  "#7cccc3",
  "#a147e6",
  "#ff6b6b",
  "#4ecdc4",
  "#ffbe0b",
  "#fb5607",
  "#8338ec",
  "#3a86ff",
  "#ff006e",
  "#8ac926",
  "#1982c4",
  "#6a4c93",
  "#f72585",
  "#7209b7",
  "#00b4d8",
  "#e76f51",
  "#606c38",
  "#9d4edd",
  "#457b9d",
  "#bc6c25",
  "#2a9d8f",
  "#e07a5f",
  "#5e548e",
  "#81b29a",
  "#f4a261",
  "#9b5de5",
  "#f15bb5",
  "#00bbf9",
  "#98c1d9",
  "#84a59d",
  "#f28482",
  "#00afb9",
  "#cdb4db",
  "#fcbf49",
];

// 本家 TreemapChart.tsx の colorway を移植。
export const TREEMAP_COLORWAY = [
  "#b3daa1",
  "#f5c5d7",
  "#d5e5f0",
  "#fbecc0",
  "#80b8ca",
  "#dabeed",
  "#fad1af",
  "#fbb09d",
  "#a6e3ae",
  "#f1e4d6",
];

/** 本家と同じラベル折返し(英字0.6幅・全角1幅、最大228px/14px 想定) */
export function wrapLabelText(text: string, fontSize = 14, maxWidth = 228): string {
  const alphabetWidth = 0.6;
  let result = "";
  let currentLine = "";
  let currentLineLength = 0;
  for (const char of text) {
    const charWidth = /[!-~]/.test(char) ? alphabetWidth : 1;
    const charLength = charWidth * fontSize;
    currentLineLength += charLength;
    if (currentLineLength > maxWidth) {
      result += `${currentLine}<br>`;
      currentLine = char;
      currentLineLength = charLength;
    } else {
      currentLine += char;
    }
  }
  if (currentLine) result += currentLine;
  return result;
}

/** ホバーテキスト用: 30文字ごとに改行 */
export function wrapHoverText(text: string): string {
  return text.replace(/(.{30})/g, "$1<br />");
}
