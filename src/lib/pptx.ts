import type { Cluster, Result } from "../types/result";

// PowerPoint エクスポート(pptxgenjs 使用)。
// レポートの主要情報(タイトル、概要、クラスタ一覧)をスライドにまとめ、
// ポンチ絵がある場合は先頭スライドに挿入する。
// pptxgenjs 本体は重いので exportPptx 内で動的 import し、バンドルを分離する。
//
// レイアウトは LAYOUT_16x9(10 × 5.625 インチ)。座標定数はすべてこの前提。

// ---- レイアウト定数 ----------------------------------------------------

/** スライド幅(インチ、16:9) */
const PAGE_W = 10;
/** スライド高さ(インチ、16:9) */
const PAGE_H = 5.625;
/** 左右マージン */
const MARGIN_X = 0.3;
/** コンテンツ幅 */
const CONTENT_W = PAGE_W - MARGIN_X * 2;
/** クラスタカードの高さ */
const CARD_H = 1.25;
/** カード間の縦ギャップ */
const GAP_Y = 0.15;
/** カード間の横ギャップ(2列時) */
const GAP_X = 0.4;
/** カード領域の開始 Y(見出し+区切り線の下) */
const CARDS_START_Y = 1.3;
/** 1階層あたりのカードページ上限。数百クラスタで数十枚生成されるのを防ぐ */
export const MAX_PAGES_PER_LEVEL = 8;

// ---- 純関数(テスト対象) ----------------------------------------------

/** 文字数上限で切り詰め、超過分は末尾を「…」にする(サロゲートは考慮しない単純カウント) */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * ファイル名に使えない文字(Windows 予約文字・制御文字)を除去する。
 * 除去後に空になった場合は "report" を返す。
 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の除去が目的
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    // 末尾のドットは Windows で不可視になるため落とす
    .replace(/\.+$/, "");
  return cleaned || "report";
}

/** クラスタ一覧から表示対象の階層番号(level > 0)を昇順で返す */
export function clusterLevels(clusters: readonly Cluster[] | null | undefined): number[] {
  if (!clusters) return [];
  return [...new Set(clusters.filter((c) => c.level > 0).map((c) => c.level))].sort((a, b) => a - b);
}

export type ClusterPagePlan = {
  /** カードの列数。階層内のクラスタ総数で決める(続きページでも変わらない) */
  cols: number;
  /** 1ページあたりのカード数 */
  perPage: number;
  /** 実際に生成するページ数(上限 MAX_PAGES_PER_LEVEL) */
  pageCount: number;
  /** スライドに載せるカード数 */
  shownCount: number;
  /** 上限超過で載せられないカード数 */
  omittedCount: number;
};

/**
 * ある階層のクラスタ総数からページ割りを決める。
 * 列数はページ単位ではなく階層のクラスタ総数で固定する
 * (同じ階層の続きページでレイアウトが変わらないように)。
 */
export function planClusterPages(totalCount: number, maxPages: number = MAX_PAGES_PER_LEVEL): ClusterPagePlan {
  if (totalCount <= 0) return { cols: 1, perPage: 3, pageCount: 0, shownCount: 0, omittedCount: 0 };
  const cols = totalCount <= 3 ? 1 : 2;
  const rowsPerPage = 3; // CARD_H/GAP_Y/CARDS_START_Y から 16:9 に収まる行数
  const perPage = cols * rowsPerPage;
  const pageCount = Math.min(Math.ceil(totalCount / perPage), maxPages);
  const shownCount = Math.min(totalCount, pageCount * perPage);
  return { cols, perPage, pageCount, shownCount, omittedCount: totalCount - shownCount };
}

/** 配列を perPage 件ずつのページに分割する */
export function paginate<T>(items: readonly T[], perPage: number): T[][] {
  if (perPage <= 0) return [];
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += perPage) {
    pages.push(items.slice(i, i + perPage));
  }
  return pages;
}

// ---- スライド生成 ------------------------------------------------------

/** Blob を base64 データ URL へ変換する */
async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
    reader.readAsDataURL(blob);
  });
}

// 色定数
const COLOR_BG = "FFFFFF";
const COLOR_TITLE = "1E3A5F";
const COLOR_ACCENT = "2563EB";
const COLOR_BODY = "374151";
const COLOR_MUTED = "6B7280";
const COLOR_LIGHT = "F3F4F6";
const COLOR_BORDER = "E5E7EB";

// 切り詰め上限(fit: "shrink" の保険も併用する)
const MAX_LABEL_CHARS = 60;
const MAX_TAKEAWAY_CHARS = 100;
const MAX_QUESTION_CHARS = 200;
const MAX_OVERVIEW_CHARS = 600;

export type PptxImages = {
  /** ポンチ絵(タイトルスライドに配置) */
  ponchie?: Blob | null;
  /** 散布図のキャプチャ(専用スライドに配置) */
  chart?: Blob | null;
};

/** PowerPoint ファイルを生成してダウンロードする */
export async function exportPptx(result: Result, images: PptxImages = {}): Promise<void> {
  const ponchie = images.ponchie ?? null;
  const chart = images.chart ?? null;
  // 動的インポート(バンドルサイズ削減のため必要時にのみ読み込む)
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();

  // 座標定数(10 × 5.625)と一致させるため LAYOUT_16x9 を使う
  pptx.layout = "LAYOUT_16x9";

  // ?? では空文字を拾えないので || でフォールバックする
  const title = result.config?.name || "広聴AIレポート";
  const question = result.config?.question ?? "";
  const overview = result.overview ?? "";
  const commentNum = result.comment_num ?? 0;
  const argNum = result.arguments?.length ?? 0;
  const clusters = result.clusters ?? [];

  // ─── スライド 1: タイトル(ポンチ絵付き) ─────────────────────────────
  {
    const slide = pptx.addSlide();
    slide.background = { color: COLOR_BG };

    // ポンチ絵がある場合は右側に配置し、テキストは左半分に寄せる
    const hasImage = !!ponchie;
    const textWidth = hasImage ? 5.1 : CONTENT_W;

    slide.addText(title, {
      x: MARGIN_X,
      y: 1.4,
      w: textWidth,
      h: 1.3,
      fontSize: 30,
      bold: true,
      color: COLOR_TITLE,
      wrap: true,
      fit: "shrink",
    });

    if (question) {
      slide.addText(truncate(question, MAX_QUESTION_CHARS), {
        x: MARGIN_X,
        y: 2.9,
        w: textWidth,
        h: 0.9,
        fontSize: 14,
        color: COLOR_BODY,
        wrap: true,
        fit: "shrink",
      });
    }

    // 統計情報
    slide.addText(`コメント数: ${commentNum.toLocaleString()} 件 / 意見数: ${argNum.toLocaleString()} 件`, {
      x: MARGIN_X,
      y: 4.0,
      w: textWidth,
      h: 0.4,
      fontSize: 12,
      color: COLOR_MUTED,
    });

    // 生成元バッジ
    slide.addShape(pptx.ShapeType.rect, {
      x: MARGIN_X,
      y: 4.7,
      w: 2.0,
      h: 0.4,
      fill: { color: COLOR_ACCENT },
      line: { color: COLOR_ACCENT },
    });
    slide.addText("広聴AI Serverless", {
      x: MARGIN_X,
      y: 4.7,
      w: 2.0,
      h: 0.4,
      fontSize: 10,
      color: "FFFFFF",
      align: "center",
      valign: "middle",
    });

    if (hasImage && ponchie) {
      const dataUrl = await blobToDataUrl(ponchie);
      // contain でアスペクト比を保つ(正方形とは限らない)
      const imgW = 4.1;
      const imgH = 4.425;
      slide.addImage({
        data: dataUrl,
        x: PAGE_W - MARGIN_X - imgW,
        y: 0.6,
        w: imgW,
        h: imgH,
        sizing: { type: "contain", w: imgW, h: imgH },
      });
    }
  }

  // ─── スライド 2: 概要・設問 ───────────────────────────────────────────
  if (overview || question) {
    const slide = pptx.addSlide();
    slide.background = { color: COLOR_BG };
    addHeading(slide, "概要");

    if (question) {
      slide.addText("設問", {
        x: MARGIN_X,
        y: 1.3,
        w: CONTENT_W,
        h: 0.35,
        fontSize: 13,
        bold: true,
        color: COLOR_ACCENT,
      });
      slide.addText(truncate(question, MAX_QUESTION_CHARS), {
        x: MARGIN_X,
        y: 1.65,
        w: CONTENT_W,
        h: 0.7,
        fontSize: 12,
        color: COLOR_BODY,
        wrap: true,
        fit: "shrink",
      });
    }

    if (overview) {
      const overviewY = question ? 2.55 : 1.3;
      slide.addText("主要な知見", {
        x: MARGIN_X,
        y: overviewY,
        w: CONTENT_W,
        h: 0.35,
        fontSize: 13,
        bold: true,
        color: COLOR_ACCENT,
      });
      slide.addText(truncate(overview, MAX_OVERVIEW_CHARS), {
        x: MARGIN_X,
        y: overviewY + 0.4,
        w: CONTENT_W,
        h: PAGE_H - (overviewY + 0.4) - 0.25,
        fontSize: 12,
        color: COLOR_BODY,
        wrap: true,
        fit: "shrink",
        valign: "top",
      });
    }
  }

  // ─── スライド 3: 散布図 ──────────────────────────────────────────────
  if (chart) {
    const slide = pptx.addSlide();
    slide.background = { color: COLOR_BG };
    addHeading(slide, "意見の分布(散布図)");
    const dataUrl = await blobToDataUrl(chart);
    // 見出し(下端 1.1)の下いっぱいに contain で収める(キャプチャは 4:3)
    const imgY = 1.25;
    const imgH = PAGE_H - imgY - 0.2;
    slide.addImage({
      data: dataUrl,
      x: MARGIN_X,
      y: imgY,
      w: CONTENT_W,
      h: imgH,
      sizing: { type: "contain", w: CONTENT_W, h: imgH },
    });
  }

  // ─── スライド 4〜N: クラスタ一覧(階層ごと) ─────────────────────────
  for (const level of clusterLevels(clusters)) {
    const clustersAtLevel = clusters.filter((c) => c.level === level);
    const plan = planClusterPages(clustersAtLevel.length);
    const pages = paginate(clustersAtLevel.slice(0, plan.shownCount), plan.perPage);

    // 列数は plan.cols で階層内固定。カード幅もページによらず一定になる。
    const cardW = plan.cols === 1 ? CONTENT_W : (CONTENT_W - GAP_X) / 2;

    for (let page = 0; page < pages.length; page++) {
      const slide = pptx.addSlide();
      slide.background = { color: COLOR_BG };

      const pageLabel = plan.pageCount > 1 ? ` (${page + 1}/${plan.pageCount})` : "";
      addHeading(slide, `意見グループ — 第${level}階層${pageLabel}`);

      const pageClusters = pages[page];
      for (let i = 0; i < pageClusters.length; i++) {
        const cluster = pageClusters[i];
        const col = i % plan.cols;
        const row = Math.floor(i / plan.cols);
        const x = MARGIN_X + col * (cardW + GAP_X);
        const y = CARDS_START_Y + row * (CARD_H + GAP_Y);

        // カード背景
        slide.addShape(pptx.ShapeType.roundRect, {
          x,
          y,
          w: cardW,
          h: CARD_H,
          fill: { color: COLOR_LIGHT },
          line: { color: COLOR_BORDER, width: 0.5 },
          rectRadius: 0.05,
        });

        // クラスタラベル。件数バッジ(右端 0.9 幅)に食い込まないよう右側を空ける
        slide.addText(truncate(cluster.label ?? "", MAX_LABEL_CHARS), {
          x: x + 0.15,
          y: y + 0.08,
          w: cardW - 1.2,
          h: 0.42,
          fontSize: 12,
          bold: true,
          color: COLOR_TITLE,
          wrap: true,
          fit: "shrink",
          valign: "top",
        });

        // 件数バッジ
        slide.addText(`${(cluster.value ?? 0).toLocaleString()} 件`, {
          x: x + cardW - 0.95,
          y: y + 0.08,
          w: 0.85,
          h: 0.32,
          fontSize: 10,
          color: "FFFFFF",
          align: "center",
          valign: "middle",
          fill: { color: COLOR_ACCENT },
        });

        // テイクアウェイ
        if (cluster.takeaway) {
          slide.addText(truncate(cluster.takeaway, MAX_TAKEAWAY_CHARS), {
            x: x + 0.15,
            y: y + 0.52,
            w: cardW - 0.3,
            h: CARD_H - 0.58,
            fontSize: 9,
            color: COLOR_BODY,
            wrap: true,
            fit: "shrink",
            valign: "top",
          });
        }
      }

      // ページ上限超過の注記(最終ページの下部)
      if (page === pages.length - 1 && plan.omittedCount > 0) {
        slide.addText(
          `※ 以降 ${plan.omittedCount.toLocaleString()} 件の意見グループは CSV エクスポートを参照してください`,
          {
            x: MARGIN_X,
            y: PAGE_H - 0.28,
            w: CONTENT_W,
            h: 0.25,
            fontSize: 10,
            color: COLOR_MUTED,
          },
        );
      }
    }
  }

  // ダウンロード。タイトルからファイル名に使えない文字を除去する
  await pptx.writeFile({ fileName: `${sanitizeFileName(title)}.pptx` });

  /** 見出し+アクセント区切り線を追加する(各スライド共通) */
  function addHeading(slide: ReturnType<typeof pptx.addSlide>, text: string): void {
    slide.addText(text, {
      x: MARGIN_X,
      y: 0.25,
      w: CONTENT_W,
      h: 0.7,
      fontSize: 22,
      bold: true,
      color: COLOR_TITLE,
      fit: "shrink",
    });
    slide.addShape(pptx.ShapeType.line, {
      x: MARGIN_X,
      y: 1.1,
      w: CONTENT_W,
      h: 0,
      line: { color: COLOR_ACCENT, width: 2 },
    });
  }
}
