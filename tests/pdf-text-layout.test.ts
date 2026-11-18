import { describe, expect, it } from "vitest";
import {
  bodyFontSize,
  buildDocument,
  buildLines,
  dropTableOfContents,
  ensureAbstractHeading,
  headingLevel,
  isBoilerplate,
  mergeParagraphs,
  pickAuthors,
  type PdfPageText,
  type PdfTextItem,
  type TextLine,
} from "@/lib/pdfTextLayout";

function item(
  str: string,
  x: number,
  y: number,
  width = str.length * 5,
  height = 10,
  rotated = false,
): PdfTextItem {
  return { str, x, y, width, height, rotated };
}

function page(pageIdx: number, items: PdfTextItem[], width = 600, height = 800): PdfPageText {
  return { pageIdx, width, height, items };
}

function line(text: string, x0: number, y: number, x1 = x0 + text.length * 5, size = 10, pageIdx = 0): TextLine {
  return { text, x0, x1, textWidth: x1 - x0, y, size, pageIdx };
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

/**
 * 双栏页面，栏间距只有 14pt——这是 CVPR/ICLR 模板的真实间距，
 * 也是「按间隙拆行」最容易把左右栏串成一行的情形。
 */
function twoColumnPage(): PdfPageText {
  const items: PdfTextItem[] = [item("Deep Residual Learning for Image Recognition", 40, 740, 520, 18)];
  for (let index = 0; index < 10; index++) {
    items.push(item(`Left column line ${index} keeps going`, 40, 700 - index * 12, 240, 10));
    items.push(item(`Right column line ${index} keeps going`, 294, 700 - index * 12, 240, 10));
  }
  return page(0, items);
}

describe("buildLines", () => {
  it("同一基线上的文本项合成一行，并按位置补空格", () => {
    const lines = buildLines(page(0, [item("Hello", 50, 700, 25), item("world", 80, 700, 25), item("next", 50, 680, 20)]));
    expect(lines.map((l) => l.text)).toEqual(["Hello world", "next"]);
  });

  it("中文逐字排版不插空格", () => {
    const lines = buildLines(page(0, [item("论文", 50, 700, 20), item("阅读", 72, 700, 20)]));
    expect(lines[0].text).toBe("论文阅读");
  });

  it("height 被放大时相邻两行不会被并成一行", () => {
    // 真实 PDF 里 pdf.js 报告的 height 常是字号的两倍，拿它的一半当行容差会吃掉行距，
    // 于是相邻两行并成一行、双栏正文交错拼在一起。这里用 height=20 / 行距 10 复现。
    const lines = buildLines(
      page(0, [
        item("First line of a paragraph", 50, 700, 200, 20),
        item("Second line of the same paragraph", 50, 690, 200, 20),
      ]),
    );
    expect(lines.map((line) => line.text)).toEqual([
      "First line of a paragraph",
      "Second line of the same paragraph",
    ]);
  });

  it("旋转文本（页边 arXiv 印章）不进入正文", () => {
    const lines = buildLines(
      page(0, [
        item("arXiv:1706.03762v7 [cs.CL] 2 Aug 2023", 20, 700, 200, 8, true),
        item("The dominant sequence transduction models are complex.", 50, 700, 380, 10),
      ]),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].text.startsWith("The dominant")).toBe(true);
  });

  it("页码、页眉、DOI 行被丢弃", () => {
    const lines = buildLines(
      page(0, [
        item("3", 300, 40, 6, 9),
        item("Page 3 of 12", 260, 30, 70, 9),
        item("arXiv:2106.09685v2 [cs.LG] 1 Jan 2021", 50, 780, 240, 9),
        item("Real body text that should survive the filter.", 50, 600, 380, 10),
      ]),
    );
    expect(lines.map((l) => l.text)).toEqual(["Real body text that should survive the filter."]);
  });
});

describe("双栏排版", () => {
  it("栏间距很小时也不会把左右栏串成一行", () => {
    const twoColumn = twoColumnPage();
    const lines = buildLines(twoColumn);
    expect(lines[0].text).toContain("Residual Learning");
    const texts = lines.map((l) => l.text);
    expect(texts.some((text) => text.includes("Left column line 0") && text.includes("Right column"))).toBe(false);
    const firstLeft = texts.findIndex((text) => text.startsWith("Left column line 0"));
    const firstRight = texts.findIndex((text) => text.startsWith("Right column line 0"));
    expect(firstLeft).toBeGreaterThan(0);
    expect(firstRight).toBeGreaterThan(firstLeft + 5);
  });

  it("单栏页面不会被误判成双栏", () => {
    const lines = buildLines(singleColumnPage());
    expect(lines.map((l) => l.text)[0]).toBe("Attention Is All You Need");
    // 单栏时正文顺序就是 y 序，不出现“先整个上半页、再整个下半页”的重排。
    const body = lines.filter((l) => l.text.startsWith("The dominant"));
    expect(body).toHaveLength(1);
  });

  it("跨栏的标题在正文之前", () => {
    const lines = buildLines(twoColumnPage());
    expect(lines[0].text).toContain("Deep Residual Learning");
  });

  it("被栏缝切开的通栏标题会合并回一行", () => {
    const items: PdfTextItem[] = [
      item("LORA: LOW-RANK ADAPTATION", 60, 760, 230, 20),
      item("OF LARGE LANGUAGE MODELS", 310, 760, 230, 20),
    ];
    for (let index = 0; index < 8; index++) {
      items.push(item(`Left column body line ${index} keeps going`, 60, 720 - index * 12, 230, 10));
      items.push(item(`Right column body line ${index} keeps going`, 310, 720 - index * 12, 230, 10));
    }
    const lines = buildLines(page(0, items));
    expect(lines[0].text).toBe("LORA: LOW-RANK ADAPTATION OF LARGE LANGUAGE MODELS");
  });
});

describe("headingLevel", () => {
  const body = bodyFontSize([
    line("正文正文正文正文正文正文正文正文正文正文", 50, 600, 400, 10),
    line("Attention Is All You Need", 50, 700, 260, 18),
  ]);

  it("字号明显更大的行是一级标题", () => {
    expect(body).toBe(10);
    expect(headingLevel(line("Attention Is All You Need", 50, 700, 260, 18), body)).toBe(1);
  });

  it("编号深度决定层级", () => {
    expect(headingLevel(line("1 Introduction", 50, 560, 90, 13), body)).toBe(1);
    expect(headingLevel(line("3.2 Attention", 50, 560, 90, 11), body)).toBe(2);
    expect(headingLevel(line("3.2.1 Scaled Dot-Product Attention", 50, 560, 200, 11), body)).toBe(2);
    expect(headingLevel(line("Abstract", 50, 640, 55, 13), body)).toBe(1);
  });

  it("公式编号、独行数字、正文句子都不算标题", () => {
    expect(headingLevel(line("4 1", 50, 500, 20, 11), body)).toBe(0);
    expect(headingLevel(line("1 (2)", 50, 500, 30, 11), body)).toBe(0);
    expect(headingLevel(line("(3)", 50, 500, 15, 11), body)).toBe(0);
    expect(headingLevel(line("Results show that deeper models are harder to train.", 50, 500, 380, 10), body)).toBe(0);
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

  it("句末标点后断段，并修复行末连字符", () => {
    const blocks = mergeParagraphs(
      [line("We use inter-", 50, 600, 100), line("national benchmarks.", 50, 588, 120), line("Next paragraph.", 50, 570, 80)],
      10,
    );
    expect(blocks.map((block) => block.text)).toEqual([
      "We use international benchmarks.",
      "Next paragraph.",
    ]);
  });

  it("跨页续写的句子接回一段，页码取自起始页", () => {
    const blocks = mergeParagraphs(
      [
        line("The encoder stacks six identical layers and each layer has", 50, 80, 380, 10, 2),
        line("two sub-layers that are connected by a residual connection.", 50, 760, 380, 10, 3),
      ],
      10,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].pageIdx).toBe(2);
    expect(blocks[0].text).toContain("residual connection.");
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

describe("pickAuthors", () => {
  const title = "Attention Is All You Need";
  const lines = [
    line(title, 50, 700, 260, 18),
    line("Ashish Vaswani∗ Noam Shazeer∗ Niki Parmar∗", 50, 680, 240, 10),
    line("Llion Jones∗ Aidan N. Gomez∗", 50, 668, 160, 10),
    line("Google Brain", 50, 640, 80, 10),
    line("Abstract", 50, 620, 55, 13),
  ];

  it("取标题下方的作者行，遇到机构行就停", () => {
    const authors = pickAuthors(lines, title, 10);
    expect(authors).toContain("Ashish Vaswani");
    expect(authors).toContain("Aidan N. Gomez");
    expect(authors).not.toContain("Google Brain");
    expect(authors).not.toContain("∗");
  });

  it("没有作者行时返回空字符串", () => {
    expect(pickAuthors([line(title, 50, 700, 260, 18), line("Abstract", 50, 660, 55, 13)], title, 10)).toBe("");
  });
});

describe("isBoilerplate", () => {
  it("识别页码、页眉、arXiv 印章与 DOI", () => {
    expect(isBoilerplate("12")).toBe(true);
    expect(isBoilerplate("Page 4 of 9")).toBe(true);
    expect(isBoilerplate("arXiv:1810.04805v2 [cs.CL] 24 May 2019")).toBe(true);
    expect(isBoilerplate("doi: 10.1109/CVPR.2016.90")).toBe(true);
    expect(isBoilerplate("We present a residual learning framework.")).toBe(false);
  });
});

describe("目录与摘要补齐", () => {
  it("目录页的连续标题会被丢弃", () => {
    const blocks = [
      { text: "Abstract", level: 1, pageIdx: 0 },
      { text: "A short abstract body for the contents page test.", level: 0, pageIdx: 0 },
      { text: "1 Introduction", level: 1, pageIdx: 1 },
      { text: "2 Approach", level: 1, pageIdx: 1 },
      { text: "3 Results", level: 1, pageIdx: 1 },
      { text: "4 Conclusion", level: 1, pageIdx: 1 },
      { text: "1 Introduction", level: 1, pageIdx: 2 },
      { text: "Real introduction body text after the contents page.", level: 0, pageIdx: 2 },
    ];
    const kept = dropTableOfContents(blocks);
    expect(kept.filter((block) => block.level > 0).map((block) => block.pageIdx)).toEqual([0, 2]);
  });

  it("没有 Abstract 小标题时补一个，摘要不再为空", () => {
    const blocks = [
      { text: "x".repeat(400), level: 0, pageIdx: 0 },
      { text: "1 Introduction", level: 1, pageIdx: 1 },
    ];
    ensureAbstractHeading(blocks);
    expect(blocks[0]).toMatchObject({ text: "Abstract", level: 1, pageIdx: 0 });
  });

  it("已有 Abstract 时不会重复插入", () => {
    const blocks = [
      { text: "Abstract", level: 1, pageIdx: 0 },
      { text: "x".repeat(400), level: 0, pageIdx: 0 },
    ];
    ensureAbstractHeading(blocks);
    expect(blocks.filter((block) => block.level > 0)).toHaveLength(1);
  });
});

describe("首页抬头与标题", () => {
  it("小型大写字母标题（同一行字号混排）不会被栏缝切成两段", () => {
    // ICLR 的标题把大写字母与小型大写字母混排：17.2 / 13.8 交替出现。
    const items: PdfTextItem[] = [
      item("A", 108, 698.4, 14, 17.2),
      item("N", 122, 698.4, 14, 13.8),
      item(" I", 137, 698.4, 14, 17.2),
      item("MAGE IS", 143, 698.4, 60, 13.8),
      item(" W", 209, 698.4, 16, 17.2),
      item("ORTH", 226, 698.4, 24, 13.8),
      item(" 16", 271, 698.4, 18, 17.2),
      item("X", 290, 698.4, 10, 13.8),
      item("16 W", 300, 698.4, 40, 17.2),
      item("ORDS:", 341, 698.4, 40, 13.8),
      item("1 INTRODUCTION", 108, 520, 90, 12),
      item("Body text of the introduction that is long enough to be prose.", 108, 500, 400, 10),
    ];
    for (let index = 0; index < 8; index++) {
      items.push(item(`Left column body line ${index} keeps going`, 108, 480 - index * 12, 200, 10));
      items.push(item(`Right column body line ${index} keeps going`, 330, 480 - index * 12, 200, 10));
    }
    const result = buildDocument([page(0, items, 612, 792)]);
    expect(result.markdown.split("\n")[0]).toBe("# AN IMAGE IS WORTH 16X16 WORDS:");
  });

  it("标题折行到连字符时把下一行接回标题", () => {
    const items: PdfTextItem[] = [
      item("LORA: LOW-RANK ADAPTATION OF LARGE LAN-", 60, 760, 480, 20),
      item("GUAGE MODELS", 200, 736, 160, 13),
      item("Edward Hu, Yelong Shen", 60, 700, 180, 11),
      item("ABSTRACT", 60, 670, 70, 12),
      item("We propose low-rank adaptation of large language models, which freezes", 60, 650, 420, 10),
      item("the pre-trained weights and injects trainable rank decomposition matrices.", 60, 638, 440, 10),
      item("1 INTRODUCTION", 60, 610, 90, 12),
      item("Fine-tuning large models is expensive because every weight is updated.", 60, 590, 420, 10),
    ];
    const result = buildDocument([page(0, items)]);
    expect(result.markdown.split("\n")[0]).toBe("# LORA: LOW-RANK ADAPTATION OF LARGE LANGUAGE MODELS");
  });

  it("首页脚注与标记行（∗ ∗、equal contribution、Version）不进入正文", () => {
    const items: PdfTextItem[] = [
      item("A Reasonable Paper Title", 60, 760, 300, 18),
      item("Alice Smith, Bob Jones", 60, 730, 200, 11),
      item("∗ ∗ (Version 2)", 60, 718, 100, 8),
      item("† equal technical contribution", 60, 706, 160, 8),
      item("Google Research {alice,bob}@google.com", 60, 694, 260, 10),
      item("Abstract", 60, 660, 55, 13),
      item("This paper studies a problem and reports results from several", 60, 640, 420, 10),
      item("experiments that were run on multiple datasets for comparison.", 60, 628, 420, 10),
      item("We also discuss the limitations of the approach and outline the", 60, 616, 420, 10),
      item("directions we consider most promising for future work on this topic.", 60, 604, 440, 10),
    ];
    const result = buildDocument([page(0, items)]);
    expect(result.markdown).not.toContain("Version 2");
    expect(result.markdown).not.toContain("equal technical contribution");
    expect(result.markdown).not.toContain("google.com");
    expect(result.markdown).toContain("## Abstract");
    expect(result.markdown).toContain("This paper studies a problem");
  });

  it("页内相邻两栏不会被当成同一行的两段", () => {
    // 两栏正文之间隔着栏缝：即使同一基线也不能拼成一段。
    const items: PdfTextItem[] = [item("Two Column Paper", 60, 760, 220, 18)];
    for (let index = 0; index < 10; index++) {
      items.push(item(`Left column sentence ${index} continues here`, 60, 700 - index * 12, 230, 10));
      items.push(item(`Right column sentence ${index} continues here`, 320, 700 - index * 12, 230, 10));
    }
    const lines = buildLines(page(0, items, 612, 792)).map((line) => line.text);
    expect(lines.some((text) => text.includes("Left column sentence 0 continues here Right column"))).toBe(false);
  });
});

describe("buildDocument", () => {
  it("产出可直接落盘的 Markdown 与 content_list", () => {
    const result = buildDocument([singleColumnPage()], { fallbackTitle: "fallback" });
    expect(result.markdown.startsWith("# Attention Is All You Need")).toBe(true);
    expect(result.markdown).toContain("Ashish Vaswani");
    expect(result.markdown).toContain("## Abstract");
    expect(result.markdown).toContain("## 1 Introduction");
    expect(result.markdown).toContain("We propose the Transformer");

    const blocks = JSON.parse(result.contentList) as Array<Record<string, unknown>>;
    // 标题只出现在 Markdown 的 `# ` 行里，不再作为正文块产生假章节。
    expect(blocks.some((block) => block.text === "Attention Is All You Need")).toBe(false);
    expect(blocks[0]).toMatchObject({ type: "text", text: "Abstract", text_level: 1, page_idx: 0 });
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

  it("标题上方的授权声明不会被当成标题", () => {
    const items: PdfTextItem[] = [
      item("Provided proper attribution is provided, Google hereby grants permission", 120, 710, 360, 12),
      item("to reproduce the tables and figures solely for scholarly works.", 124, 696, 360, 12),
      item("Attention Is All You Need", 210, 630, 190, 17),
      item("Ashish Vaswani, Noam Shazeer", 130, 549, 160, 10),
      item("Abstract", 50, 500, 55, 13),
      item("The dominant sequence transduction models are based on complex recurrent", 50, 480, 400, 10),
      item("neural networks that include an encoder and a decoder for translation.", 50, 468, 400, 10),
      item("1 Introduction", 50, 440, 90, 13),
      item("Recurrent neural networks have long been the state of the art in", 50, 420, 400, 10),
      item("sequence modeling tasks such as machine translation and parsing.", 50, 408, 400, 10),
    ];
    const result = buildDocument([page(0, items)], { fallbackTitle: "fallback" });
    expect(result.markdown.split("\n")[0]).toBe("# Attention Is All You Need");
  });

  it("没有文字层时提示扫描件，而不是写一份空正文", () => {
    expect(() => buildDocument([page(0, [item("1", 50, 700, 5)])])).toThrow(/扫描件/);
  });

  it("PDF 标题缺失时回退到文件名", () => {    const pages = [
      page(0, [
        item("arXiv:2401.00001v1 [cs.CL] 1 Jan 2024", 50, 700, 260, 9),
        item("This paper studies an important problem in detail and reports", 50, 600, 380, 10),
        item("the results of a long series of carefully controlled experiments.", 50, 588, 400, 10),
        item("The results show a clear improvement over all published baselines.", 50, 576, 380, 10),
        item("We conclude with a discussion of limitations and future work.", 50, 564, 380, 10),
      ]),
    ];
    const result = buildDocument(pages, { fallbackTitle: "my-paper" });
    expect(result.markdown.startsWith("# my-paper")).toBe(true);
  });

  it("章节数不会因为公式编号而膨胀", () => {
    const items: PdfTextItem[] = [item("A Study of Things", 50, 740, 200, 18), item("Abstract", 50, 700, 55, 13)];
    for (let index = 0; index < 8; index++) {
      items.push(item(`Body line ${index} with enough words to be real prose here.`, 50, 680 - index * 12, 380, 10));
      items.push(item(`${index} 1`, 500, 680 - index * 12, 18, 10));
    }
    const result = buildDocument([page(0, items)]);
    const headings = result.blocks.filter((block) => block.level > 0);
    // 标题进入 Markdown 抬头，公式编号（`0 1`、`1 1`…）不产生章节。
    expect(headings.map((block) => block.text)).toEqual(["Abstract"]);
  });

  it("中文短标题也能识别为章节", () => {
    const items: PdfTextItem[] = [
      item("不依赖云服务的中文论文正文提取", 60, 760, 320, 20),
      item("张三，李四，王五", 60, 730, 160, 11),
      item("摘要", 60, 690, 24, 13),
      item("本文研究如何从 PDF 中稳定提取论文正文，并保留章节结构。", 60, 670, 420, 10.5),
      item("我们先把每个文本项还原为行，再按字号与编号识别章节标题。", 60, 658, 420, 10.5),
      item("跨页的句子会被接回同一段，这一处理对问答上下文的完整性影响最大。", 60, 646, 440, 10.5),
      item("1 引言", 60, 630, 40, 13),
      item("阅读论文的第一步是找到正文，而扫描件与双栏排版常常让提取结果无法使用。", 60, 610, 460, 10.5),
      item("现有方案多依赖外部解析服务，上传全文既带来隐私顾虑，也让离线使用变得困难。", 60, 598, 460, 10.5),
      item("本文的方法完全在本机运行，不联网也不需要任何密钥，章节与关键词检索照常可用。", 60, 586, 460, 10.5),
      item("我们在若干真实论文上验证了排版还原、标题识别与跨页合并的稳定性。", 60, 574, 460, 10.5),
    ];
    const result = buildDocument([page(0, items)]);
    expect(result.authors).toContain("张三");
    expect(result.authors).toContain("李四");
    expect(result.markdown).toContain("## 摘要");
    expect(result.markdown).toContain("## 1 引言");
  });

  it("双栏页面的章节标题不会与右栏正文粘在一行", () => {
    const items: PdfTextItem[] = [];
    // 左栏标题的 width 被 PDF 撑到栏末（真实文件很常见）
    items.push(item("1. Introduction", 40, 700, 250, 13));
    items.push(item("unsurprising) and then degrades rapidly with depth.", 310, 700, 240, 10));
    for (let index = 0; index < 8; index++) {
      items.push(item(`Left column body line ${index} keeps going`, 40, 680 - index * 12, 240, 10));
      items.push(item(`Right column body line ${index} keeps going`, 310, 688 - index * 12, 240, 10));
    }
    const lines = buildLines(page(0, items)).map((l) => l.text);
    const heading = lines.find((text) => text.startsWith("1. Introduction"));
    expect(heading).toBe("1. Introduction");
    expect(lines.some((text) => text.startsWith("unsurprising) and then degrades"))).toBe(true);
  });

  it("换行标题拼回一个标题，不产生假章节", () => {
    const items: PdfTextItem[] = [
      item("LORA: LOW-RANK ADAPTATION OF LARGE LAN-", 60, 760, 480, 20),
      item("GUAGE MODELS", 200, 736, 160, 20),
      item("Edward Hu, Yelong Shen", 60, 700, 180, 11),
      item("ABSTRACT", 60, 670, 70, 12),
      item("We propose low-rank adaptation of large language models, which freezes", 60, 650, 420, 10),
      item("the pre-trained weights and injects trainable rank decomposition matrices.", 60, 638, 440, 10),
      item("1 INTRODUCTION", 60, 610, 90, 12),
      item("Fine-tuning large models is expensive because every weight is updated.", 60, 590, 420, 10),
      item("We show that the number of trainable parameters can drop by four orders.", 60, 578, 420, 10),
    ];
    const result = buildDocument([page(0, items)]);
    expect(result.markdown.split("\n")[0]).toBe("# LORA: LOW-RANK ADAPTATION OF LARGE LANGUAGE MODELS");
    expect(result.blocks.filter((block) => block.level > 0).map((block) => block.text)).toEqual([
      "ABSTRACT",
      "1 INTRODUCTION",
    ]);
  });

  it("参考文献条目与图例不算章节", () => {
    const items: PdfTextItem[] = [
      item("Deep Residual Learning for Image Recognition", 60, 770, 400, 18),
      item("3 Results", 60, 740, 80, 13),
      item("Body of results section with enough text to be prose and long enough", 60, 720, 420, 10),
      item("23. Data can be found at https://example.org/commitmentbank.", 60, 700, 400, 10),
      item("1633. He learned their language and culture through long field work", 60, 688, 420, 10),
      item("0.6 SGDNesterov+dropout", 300, 660, 120, 9),
      item("2 ResNet-56 ble 10 and 11 for better results.", 300, 648, 220, 10),
    ];
    const result = buildDocument([page(0, items)]);
    // 片段里没有「1 Introduction」，会按摘要规则补一个 Abstract 标题；这里只看其余章节。
    const headings = result.blocks
      .filter((block) => block.level > 0)
      .map((block) => block.text)
      .filter((text) => text !== "Abstract");
    expect(headings).toEqual(["3 Results"]);
  });
});
