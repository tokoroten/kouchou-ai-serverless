import type { Result } from "../types/result";

// PowerPoint エクスポート(pptxgenjs 使用)。
// レポートの主要情報(タイトル、概要、クラスタ一覧)をスライドにまとめ、
// オプションでポンチ絵画像を先頭スライドに挿入する。

/** Blob を base64 データ URL へ変換する */
async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
    reader.readAsDataURL(blob);
  });
}

/** PowerPoint ファイルをダウンロードする */
export async function exportPptx(result: Result, ponchieBlob?: Blob | null): Promise<void> {
  // 動的インポート(バンドルサイズ削減のため必要時にのみ読み込む)
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();

  // プレゼンテーション全体の設定
  pptx.layout = "LAYOUT_WIDE"; // 16:9

  const title = result.config?.name ?? "広聴AIレポート";
  const question = result.config?.question ?? "";
  const overview = result.overview ?? "";
  const commentNum = result.comment_num ?? 0;
  const argNum = result.arguments?.length ?? 0;

  // 色定数
  const COLOR_BG = "FFFFFF";
  const COLOR_TITLE = "1E3A5F";
  const COLOR_ACCENT = "2563EB";
  const COLOR_BODY = "374151";
  const COLOR_LIGHT = "F3F4F6";
  const COLOR_BORDER = "E5E7EB";

  // ─── スライド 1: タイトル(ポンチ絵付き) ───────────────────────────────
  {
    const slide = pptx.addSlide();
    slide.background = { color: COLOR_BG };

    // ポンチ絵がある場合は右半分に配置
    const hasImage = !!ponchieBlob;
    const textWidth = hasImage ? 5.5 : 10;

    // タイトルテキストエリア
    slide.addText(title, {
      x: 0.3,
      y: 1.8,
      w: textWidth,
      h: 1.4,
      fontSize: 32,
      bold: true,
      color: COLOR_TITLE,
      wrap: true,
    });

    if (question) {
      slide.addText(question, {
        x: 0.3,
        y: 3.4,
        w: textWidth,
        h: 0.9,
        fontSize: 16,
        color: COLOR_BODY,
        wrap: true,
      });
    }

    // 統計情報
    slide.addText(`コメント数: ${commentNum.toLocaleString()} 件 / 意見数: ${argNum.toLocaleString()} 件`, {
      x: 0.3,
      y: 4.5,
      w: textWidth,
      h: 0.4,
      fontSize: 12,
      color: "6B7280",
    });

    // 広聴AI ロゴ的なバッジ
    slide.addShape("rect" as Parameters<typeof slide.addShape>[0], {
      x: 0.3,
      y: 5.2,
      w: 2.0,
      h: 0.4,
      fill: { color: COLOR_ACCENT },
      line: { color: COLOR_ACCENT },
    });
    slide.addText("広聴AI Serverless", {
      x: 0.3,
      y: 5.2,
      w: 2.0,
      h: 0.4,
      fontSize: 10,
      color: "FFFFFF",
      align: "center",
      valign: "middle",
    });

    // ポンチ絵画像
    if (hasImage && ponchieBlob) {
      const dataUrl = await blobToDataUrl(ponchieBlob);
      slide.addImage({
        data: dataUrl,
        x: 6.2,
        y: 0.6,
        w: 3.5,
        h: 3.5,
      });
    }
  }

  // ─── スライド 2: 概要 ─────────────────────────────────────────────────
  if (overview || question) {
    const slide = pptx.addSlide();
    slide.background = { color: COLOR_BG };

    slide.addText("概要", {
      x: 0.3,
      y: 0.3,
      w: 9.4,
      h: 0.7,
      fontSize: 24,
      bold: true,
      color: COLOR_TITLE,
    });
    // タイトル下の区切り線
    slide.addShape("line" as Parameters<typeof slide.addShape>[0], {
      x: 0.3,
      y: 1.1,
      w: 9.4,
      h: 0,
      line: { color: COLOR_ACCENT, width: 2 },
    });

    if (question) {
      slide.addText("設問", {
        x: 0.3,
        y: 1.3,
        w: 9.4,
        h: 0.35,
        fontSize: 13,
        bold: true,
        color: COLOR_ACCENT,
      });
      slide.addText(question, {
        x: 0.3,
        y: 1.65,
        w: 9.4,
        h: 0.7,
        fontSize: 12,
        color: COLOR_BODY,
        wrap: true,
      });
    }

    if (overview) {
      const overviewY = question ? 2.55 : 1.3;
      slide.addText("主要な知見", {
        x: 0.3,
        y: overviewY,
        w: 9.4,
        h: 0.35,
        fontSize: 13,
        bold: true,
        color: COLOR_ACCENT,
      });
      slide.addText(overview, {
        x: 0.3,
        y: overviewY + 0.4,
        w: 9.4,
        h: 3.0,
        fontSize: 12,
        color: COLOR_BODY,
        wrap: true,
      });
    }
  }

  // ─── スライド 3〜N: クラスタ一覧(レベルごとに1スライド) ──────────────
  const levels = [...new Set(result.clusters.filter((c) => c.level > 0).map((c) => c.level))].sort((a, b) => a - b);

  for (const level of levels) {
    const clustersAtLevel = result.clusters.filter((c) => c.level === level);

    // クラスタ数が多い場合は複数スライドに分割(1スライドあたり最大6クラスタ)
    const CLUSTERS_PER_SLIDE = 6;
    const pages = Math.ceil(clustersAtLevel.length / CLUSTERS_PER_SLIDE);

    for (let page = 0; page < pages; page++) {
      const slide = pptx.addSlide();
      slide.background = { color: COLOR_BG };

      const pageLabel = pages > 1 ? ` (${page + 1}/${pages})` : "";
      slide.addText(`意見グループ — 第${level}階層${pageLabel}`, {
        x: 0.3,
        y: 0.3,
        w: 9.4,
        h: 0.7,
        fontSize: 22,
        bold: true,
        color: COLOR_TITLE,
      });
      slide.addShape("line" as Parameters<typeof slide.addShape>[0], {
        x: 0.3,
        y: 1.1,
        w: 9.4,
        h: 0,
        line: { color: COLOR_ACCENT, width: 2 },
      });

      const pageClusters = clustersAtLevel.slice(page * CLUSTERS_PER_SLIDE, (page + 1) * CLUSTERS_PER_SLIDE);
      const cols = pageClusters.length <= 3 ? 1 : 2;
      const cardW = cols === 1 ? 9.0 : 4.3;
      const cardH = 1.3;
      const startX = 0.3;
      const startY = 1.3;
      const gapX = 0.4;
      const gapY = 0.25;

      for (let i = 0; i < pageClusters.length; i++) {
        const cluster = pageClusters[i];
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = startX + col * (cardW + gapX);
        const y = startY + row * (cardH + gapY);

        // カード背景
        slide.addShape("roundRect" as Parameters<typeof slide.addShape>[0], {
          x,
          y,
          w: cardW,
          h: cardH,
          fill: { color: COLOR_LIGHT },
          line: { color: COLOR_BORDER, width: 0.5 },
          rectRadius: 0.1,
        });

        // クラスタラベル
        slide.addText(cluster.label, {
          x: x + 0.15,
          y: y + 0.1,
          w: cardW - 0.5,
          h: 0.45,
          fontSize: 12,
          bold: true,
          color: COLOR_TITLE,
          wrap: true,
        });

        // 件数バッジ
        slide.addText(`${cluster.value.toLocaleString()} 件`, {
          x: x + cardW - 0.9,
          y: y + 0.1,
          w: 0.8,
          h: 0.35,
          fontSize: 10,
          color: "FFFFFF",
          align: "center",
          fill: { color: COLOR_ACCENT },
        });

        // テイクアウェイ
        if (cluster.takeaway) {
          slide.addText(cluster.takeaway, {
            x: x + 0.15,
            y: y + 0.58,
            w: cardW - 0.3,
            h: 0.65,
            fontSize: 10,
            color: COLOR_BODY,
            wrap: true,
          });
        }
      }
    }
  }

  // ダウンロード
  const fileName = `${title}.pptx`;
  await pptx.writeFile({ fileName });
}
