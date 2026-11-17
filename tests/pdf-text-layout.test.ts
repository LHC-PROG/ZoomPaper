import { describe, expect, it } from "vitest";
import {
  bodyFontSize,
  buildDocument,
  buildLines,
  detectGutter,
  headingLevel,
  mergeParagraphs,
  orderLines,
  type PdfPageText,
  type PdfTextItem,
  type TextLine,
} from "@/lib/pdfTextLayout";

function item(str: string, x: number, y: number, width = str.length * 5, height = 10): PdfTextItem {
  return { str, x, y, width, height };
}

function page(pageIdx: number, items: PdfTextItem[], width = 600, height = 800): PdfPageText {
  return { pageIdx, width, height, items };
}

function line(text: string, x0: number, y: number, x1 = x0 + text.length * 5, size = 10): TextLine {
  return { text, x0, x1, y, size, pageIdx: 0 };
}

/** 单栏页面：标题 + 作者 + Abstract + 正文，字符数足够绕过“扫描件”判定。 */
function singleColumnPage(): PdfPageText {
  return page(0, [
    item("Attention Is All You Need", 50, 700, 260, 18),
    item("Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit", 50, 680, 330, 10),
    item("Abstract", 50, 640, 55, 13),
    item("The dominant sequence transduction models are based on complex", 50, 620, 370, 10),
    item("recurrent or convolutional neural networks that include an encoder", 50, 608, 390, 10),
    item("and a decoder. We propose the Transformer, based solely on attention.", 50, 596, 400, 10),
    item("1 Introduction", 50, 560, 90, 13),
    item("Recurrent neural networks have long been the state of the art in", 50, 540, 380, 10),
    item("sequence modeling tasks such as machine translation and parsing.", 50, 528, 380, 10),
  ]);
}

describe("buildLines", () => {
  it("同一基线上的文本项合成一行，并按位置补空格", () => {
    const lines = buildLines(
      page(0, [item("Hello", 50, 700, 25), item("world", 80, 700, 25), item("next", 50, 680, 20)]),
    );
    expect(lines.map((l) => l.text)).toEqual(["Hello world", "next"]);
  });

  it("中文逐字排版不插空格", () => {
    const lines = buildLines(page(0, [item("论文", 50, 700, 20), item("阅读", 72, 700, 20)]));
    expect(lines[0].text).toBe("论文阅读");
  });

  it("忽略纯空白文本项", () => {
    expect(buildLines(page(0, [item("   ", 50, 700, 10), item("", 60, 700, 10)]))).toEqual([]);
  });
});

describe("detectGutter / orderLines", () => {
  function twoColumnPage(): PdfPageText {
    const items: PdfTextItem[] = [item("A Two Column Paper Title", 50, 720, 250, 18)];
    for (let index = 0; index < 6; index++) {
      items.push(item(`Left column line ${index} with some words`, 50, 680 - index * 12, 230, 10));
      items.push(item(`Right column line ${index} with some words`, 310, 680 - index * 12, 230, 10));
    }
    return page(0, items);
  }

  it("双栏时先通栏标题，再左栏，再右栏", () => {
    const twoColumn = twoColumnPage();
    const lines = buildLines(twoColumn);
    const gutter = detectGutter(lines, twoColumn.width);
    expect(gutter).not.toBeNull();
    const ordered = orderLines(lines, gutter);
    const texts = ordered.map((l) => l.text);
    expect(texts[0]).toContain("Title");
    const firstLeft = texts.findIndex((text) => text.startsWith("Left column line 0"));
    const firstRight = texts.findIndex((text) => text.startsWith("Right column line 0"));
    expect(firstLeft).toBeGreaterThan(0);
    expect(firstRight).toBeGreaterThan(firstLeft + 4);
  });

  it("单栏不误判中缝", () => {
    const lines = buildLines(singleColumnPage());
    expect(detectGutter(lines, 600)).toBeNull();
    expect(orderLines(lines, null).map((l) => l.text)[0]).toBe("Attention Is All You Need");
  });
});

describe("headingLevel / bodyFontSize", () => {
  it("按字号与编号识别章节标题", () => {
    const body = bodyFontSize([
      line("正文正文正文正文正文正文正文正文正文正文", 50, 600, 400, 10),
      line("Attention Is All You Need", 50, 700, 260, 18),
    ]);
    expect(body).toBe(10);
    expect(headingLevel(line("Attention Is All You Need", 50, 700, 260, 18), body)).toBe(1);
    expect(headingLevel(line("1 Introduction", 50, 560, 90, 13), body)).toBe(1);
    expect(headingLevel(line("普通的正文句子，不是标题。", 50, 540, 300, 10), body)).toBe(0);
  });
});

describe("mergeParagraphs", () => {
  it("上一行没有句末标点就合并成一段，中文不插空格", () => {
    const blocks = mergeParagraphs(
      [line("这是第一行没有句号", 50, 600, 200), line("这是第二行", 50, 588, 100), line("结束。", 50, 576, 30)],
      10,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("这是第一行没有句号这是第二行结束。");
  });

  it("句末标点后断段，并修复被连字符拆开的单词", () => {
    const blocks = mergeParagraphs(
      [line("We use inter-", 50, 600, 100), line("national benchmarks.", 50, 588, 120), line("Next paragraph.", 50, 570, 80)],
      10,
    );
    expect(blocks.map((block) => block.text)).toEqual([
      "We use international benchmarks.",
      "Next paragraph.",
    ]);
  });

  it("标题单独成块，不并入正文", () => {
    const blocks = mergeParagraphs(
      [line("2 Method", 50, 600, 80, 13), line("We describe the encoder stack in detail", 50, 588, 300)],
      10,
    );
    expect(blocks[0]).toMatchObject({ text: "2 Method", level: 1 });
    expect(blocks[1]).toMatchObject({ level: 0 });
  });
});

describe("buildDocument", () => {
  it("产出可直接落盘的 Markdown 与 content_list", () => {
    const result = buildDocument([singleColumnPage()], { fallbackTitle: "fallback" });
    expect(result.markdown.startsWith("# Attention Is All You Need")).toBe(true);
    expect(result.markdown).toContain("## Abstract");
    expect(result.markdown).toContain("## 1 Introduction");
    expect(result.markdown).toContain("We propose the Transformer");

    const blocks = JSON.parse(result.contentList) as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({ type: "text", text: "Attention Is All You Need", text_level: 1, page_idx: 0 });
    expect(blocks.every((block) => block.type === "text")).toBe(true);
    expect(blocks.some((block) => block.text_level === undefined)).toBe(true);
  });

  it("跨页重复的页眉页脚被丢弃", () => {
    const pages = [0, 1, 2].map((pageIdx) =>
      page(pageIdx, [
        item("Journal of Reproducible Tests Vol. 1", 50, 780, 240, 9),
        item(`Body paragraph of page ${pageIdx} that keeps going for a while`, 50, 600, 380, 10),
        item(`and continues on this line so the text is long enough ${pageIdx}.`, 50, 588, 380, 10),
        item(String(pageIdx + 1), 300, 40, 6, 9),
      ]),
    );
    const result = buildDocument(pages);
    expect(result.markdown).not.toContain("Journal of Reproducible Tests");
  });

  it("没有文字层时提示扫描件，而不是写一份空正文", () => {
    expect(() => buildDocument([page(0, [item("1", 50, 700, 5)])])).toThrow(/扫描件/);
  });

  it("PDF 标题缺失时回退到文件名", () => {
    const pages = [
      page(0, [
        item("arXiv:2401.00001v1 [cs.CL] 1 Jan 2024", 50, 700, 260, 9),
        item("This paper studies an important problem in detail.", 50, 600, 380, 10),
        item("The results show a clear improvement over all baselines.", 50, 588, 380, 10),
        item("We conclude with a discussion of limitations and future work.", 50, 576, 380, 10),
      ]),
    ];
    const result = buildDocument(pages, { fallbackTitle: "my-paper" });
    expect(result.markdown.startsWith("# my-paper")).toBe(true);
  });
});
