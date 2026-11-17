/**
 * 本机 PDF 文本提取的排版逻辑：把 pdf.js 的文本项还原成行、段落和章节。
 *
 * 这里只做纯计算，不碰 DOM、不碰 pdf.js、不碰 Tauri，方便单元测试。
 * 产出的 `content_list.json` 与 MinerU 的结构一致（`type/text/text_level/page_idx`），
 * 因此分块、检索、章节树、测验选题都能直接复用。
 *
 * 质量目标（真实论文评测见 `tools/eval-local-extraction.mjs`）：
 * 1. 双栏不能串行：按文本项中心做两栏聚类，先定位中缝，再逐栏成行。
 * 2. 页眉页脚、arXiv 印章、页码、旋转水印不进正文。
 * 3. 标题只认「字号明显更大」或「编号 + 实词」，避免把公式编号、独行数字当章节。
 * 4. 跨页续写与行末连字符要接回去，否则 AI 读到的句子是断的。
 * 5. 作者行从标题下方取，供论文库与 AI 上下文使用。
 */

/** pdf.js `getTextContent()` 中的一个文本项，坐标已按 PDF 左下原点归一。 */
export interface PdfTextItem {
  str: string;
  /** 基线起点的 x（pt） */
  x: number;
  /** 基线起点的 y（pt，页面底部为 0） */
  y: number;
  width: number;
  height: number;
  /** 真实字号（来自变换矩阵）；缺失时退回 height。 */
  size?: number;
  /** 旋转文本（页边印章、竖排表头）；不参与正文排序。 */
  rotated?: boolean;
}

export interface PdfPageText {
  /** 0 起页序，与 MinerU 的 `page_idx` 一致。 */
  pageIdx: number;
  width: number;
  height: number;
  items: PdfTextItem[];
}

/** 一行文字（同一基线上的文本项合并而成）。 */
export interface TextLine {
  text: string;
  y: number;
  x0: number;
  x1: number;
  /** 估算的真实文字宽度：PDF 里文本项的 width 常带上行尾空白，不能直接当作文字宽度。 */
  textWidth: number;
  /** 行高，用于判断标题字号。 */
  size: number;
  pageIdx: number;
}

/** 结构化正文块，直接对应 content_list.json 的元素。 */
export interface TextBlock {
  text: string;
  /** 0 = 正文；1 = 章节标题。 */
  level: number;
  pageIdx: number;
}

export interface LocalParseResult {
  markdown: string;
  contentList: string;
  blocks: TextBlock[];
  authors: string;
  chars: number;
}

export interface BuildOptions {
  /** PDF 里拿不到标题时的兜底（通常是去掉 .pdf 的文件名）。 */
  fallbackTitle?: string;
}

/** 少于该字符数视为没有文本层，通常是扫描件。 */
export const MIN_EXTRACTED_CHARS = 200;

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const TERMINAL = /[.。!！?？:：;；]$/;
/** 文本项的字号：优先用变换矩阵的水平缩放，height 可能是被放大的整体高度。 */
const itemSize = (item: PdfTextItem) => (item.size && item.size > 0 ? item.size : item.height || 10);
/** 真实文字宽度估算：PDF 文本项的 width 常包含行尾空白，直接用它会把栏缝吃掉。 */
const charWidth = (item: PdfTextItem) => (CJK.test(item.str) ? 0.95 : 0.5) * itemSize(item);
const estimatedWidth = (item: PdfTextItem) => item.str.trimEnd().length * charWidth(item);
const estimatedEnd = (item: PdfTextItem) => item.x + Math.min(item.width, estimatedWidth(item) + 1);
/** 至少 2 个中文字或 3 个拉丁字母才算「有实词」。 */
function hasWord(text: string): boolean {
  const letters = text.match(/[A-Za-z\u00c0-\u024f\u3400-\u9fff]/g) ?? [];
  if (!letters.length) return false;
  return CJK.test(text) ? letters.length >= 2 : letters.length >= 3;
}
/** 纯编号行：`4`、`(2)`、`1 (2)`、`3.1` —— 公式号或行号，不是章节。 */
const EQUATION_NUMBER = /^[\d\s().\[\]-]+$/;
const NUMBERED_SECTION = /^\d+(\.\d+)*\.?\s+[A-Z\u00c0-\u024f\u3400-\u9fff]/;
const ROMAN_SECTION = /^[IVX]{1,5}\.\s+[A-Z\u00c0-\u024f]/;
const SECTION_HINT =
  /^(abstract|摘要|introduction|引言|related work|related works|background|method|methods|methodology|approach|experiment|experiments|experimental setup|evaluation|results?|discussion|conclusion|conclusions|references?|bibliography|acknowledg|appendix|supplementary|第[一二三四五六七八九十]+[章节]|参考文献|致谢)/i;
/** 只有这些词可以作为「不带编号也认」的顶层章节标题。 */
const PLAIN_HEADING =
  /^(abstract|摘要|introduction|related works?|background|references?|bibliography|conclusions?|discussion|acknowledg(e)?ments?|appendix|致谢|参考文献)$/i;
const BOILERPLATE: RegExp[] = [
  /^arxiv:\s*\d{4}\.\d{4,5}/i,
  /^\d{1,4}$/,
  /^[ivx]{1,5}$/i,
  /^page\s+\d+(\s*(of|\/)\s*\d+)?$/i,
  /^\d+\s*\/\s*\d+$/,
  /^(preprint|under review|published as a conference paper|proceedings of|workshop on)\b/i,
  /^(downloaded from|licensed under|cc by|creative commons)\b/i,
  /^[©(c)]\s*\d{4}/i,
  /\s*doi:\s*10\.\S+$/i,
  /^https?:\/\/\S+$/i,
  // arXiv 版常见：标题上方的授权声明（Attention 等论文）
  /^(provided proper attribution|reproduce the tables and figures|hereby grants permission)/i,
  /\b(solely for use in journalistic or scholarly works|permission to reproduce the tables and figures)\b/i,
  // 目录条目：`2.1 Model and Architectures . . . . . . 3`
  /(\s\.){3,}\s*\d*\s*$/,
];

/** 页码、页眉页脚、arXiv 印章等样板行。 */
export function isBoilerplate(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  return BOILERPLATE.some((pattern) => pattern.test(value));
}

interface ColumnLayout {
  /** 中缝位置（pt）；null 表示单栏。 */
  gutter: number | null;
}

/**
 * 用文本项中心做两栏聚类：真实双栏论文的正文中心会聚成两簇，
 * 单栏论文（含居中标题与两端对齐正文）分不出明显间隔，直接判为单栏。
 */
export function detectColumnLayout(items: PdfTextItem[], pageWidth: number): ColumnLayout {
  const usable = items.filter((item) => item.str.trim().length > 0 && !item.rotated);
  if (usable.length < 12 || pageWidth <= 0) return { gutter: null };
  const centers = usable.map((item) => item.x + item.width / 2);
  const min = Math.min(...centers);
  const max = Math.max(...centers);
  if (max - min < pageWidth * 0.2) return { gutter: null };
  let left = min + (max - min) * 0.35;
  let right = min + (max - min) * 0.65;
  let leftCount = 0;
  let rightCount = 0;
  for (let iteration = 0; iteration < 10; iteration++) {
    let leftSum = 0;
    let rightSum = 0;
    leftCount = 0;
    rightCount = 0;
    for (const center of centers) {
      if (Math.abs(center - left) <= Math.abs(center - right)) {
        leftSum += center;
        leftCount++;
      } else {
        rightSum += center;
        rightCount++;
      }
    }
    if (!leftCount || !rightCount) return { gutter: null };
    left = leftSum / leftCount;
    right = rightSum / rightCount;
  }
  const smaller = Math.min(leftCount, rightCount);
  if (Math.abs(right - left) < pageWidth * 0.12) return { gutter: null };
  // 两栏都应有实质内容，否则可能只是页边注释。
  if (smaller < centers.length * 0.2) return { gutter: null };
  return { gutter: (left + right) / 2 };
}

/**
 * 把文本项聚成行：同一基线合并，按 x 排序后按间距补空格。
 *
 * 这里不做「跨栏拆行」——列归属由调用方按文本项起点决定，宽度估算不可靠
 * （PDF 里文本项的 width 常带行尾空白，字宽也不等宽）。
 */
function linesFromItems(items: PdfTextItem[], pageIdx: number): TextLine[] {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: PdfTextItem[][] = [];
  let current: PdfTextItem[] = [];
  for (const item of sorted) {
    const anchor = current[0];
    if (!anchor) {
      current = [item];
      continue;
    }
    // 基线容差必须很小：pdf.js 的 height 常常是字体的整体缩放（可达字号的两倍），
    // 用它的一半做容差会把相邻的两行并成一行，双栏正文就会被交错拼在一起。
    const tolerance = Math.max(1, Math.min(2.5, itemSize(anchor) * 0.12));
    if (Math.abs(item.y - anchor.y) > tolerance) {
      groups.push(current);
      current = [item];
    } else current.push(item);
  }
  if (current.length) groups.push(current);

  return groups
    .map((group) => {
      const ordered = [...group].sort((a, b) => a.x - b.x);
      let text = "";
      let previousEnd = 0;
      for (const item of ordered) {
        if (text) {
          const gap = item.x - previousEnd;
          // 拉丁文词间通常只有很小的间隙；CJK 逐字排版时间隙更小，不能因此拆词。
          const threshold = Math.max(1, itemSize(item) * 0.22);
          if (gap > threshold && !CJK.test(text.slice(-1)) && !CJK.test(item.str.slice(0, 1))) text += " ";
        }
        text += item.str;
        previousEnd = item.x + item.width;
      }
      const sizes = ordered.map((item) => itemSize(item)).sort((a, b) => a - b);
      const x0 = Math.min(...ordered.map((item) => item.x));
      const textEnd = Math.max(...ordered.map(estimatedEnd));
      return {
        text: text.replace(/\s+/g, " ").trim(),
        y: ordered[0].y,
        x0,
        x1: Math.max(...ordered.map((item) => item.x + item.width)),
        textWidth: Math.max(0, textEnd - x0),
        size: sizes[Math.floor(sizes.length / 2)] || 10,
        pageIdx,
      };
    })
    .filter((line) => line.text.length > 0 && !isBoilerplate(line.text));
}

/** 一页的正文基准字号：按字符数加权取众数，用来区分标题与正文行。 */
function pageBodySize(items: PdfTextItem[]): number {
  const weight = new Map<number, number>();
  for (const item of items) {
    const key = Math.round(itemSize(item) * 2) / 2;
    weight.set(key, (weight.get(key) ?? 0) + item.str.length);
  }
  let best = 10;
  let bestWeight = -1;
  for (const [size, count] of weight) {
    if (count > bestWeight) {
      best = size;
      bestWeight = count;
    }
  }
  return best;
}

/**
 * 逐页把文本项排成行，并给出阅读顺序。
 *
 * 列归属只看文本项起点（在栏缝左侧即左栏），宽度只用来合并同一行内的文字——
 * 这样 PDF 里带行尾空白的 width 不会把左右栏粘在一起。
 * 通栏大标题会被拆成左右两段，这里再按「同一基线 + 同一字号 + 明显大于正文」合并回去。
 */
export function buildLines(page: PdfPageText): TextLine[] {
  const items = page.items.filter((item) => item.str.trim().length > 0 && !item.rotated);
  if (!items.length) return [];
  const byPosition = (a: TextLine, b: TextLine) => b.y - a.y || a.x0 - b.x0;
  const { gutter } = detectColumnLayout(items, page.width);
  if (gutter == null) return linesFromItems(items, page.pageIdx).sort(byPosition);

  const bodySize = pageBodySize(items);
  const left = linesFromItems(items.filter((item) => item.x < gutter), page.pageIdx).sort(byPosition);
  const right = linesFromItems(items.filter((item) => item.x >= gutter), page.pageIdx).sort(byPosition);

  // 居中的短行（例如通栏摘要上方的 “ABSTRACT”）起点可能落在栏缝右侧，按栏目归属会被
  // 排到右栏去。只把「窄且居中」的行当作通栏，宽标题的左右两半仍走字号合并。
  const centered = (line: TextLine) =>
    Math.abs((line.x0 + line.x1) / 2 - page.width / 2) <= page.width * 0.08 &&
    line.textWidth < page.width * 0.45;
  const centeredLeft = left.filter(centered);
  const centeredRight = right.filter(centered);
  const leftColumn = left.filter((line) => !centered(line));
  const rightColumn = right.filter((line) => !centered(line));

  // 居中的通栏内容（大标题、居中排的 ABSTRACT）先输出；再合并被栏缝切开的大标题。
  const spanning: TextLine[] = [...centeredLeft, ...centeredRight].sort(byPosition);
  const usedRight = new Set<number>();
  const remainingLeft: TextLine[] = [];
  for (const leftLine of leftColumn) {
    const partnerIndex = rightColumn.findIndex(
      (rightLine, index) =>
        !usedRight.has(index) &&
        Math.abs(rightLine.y - leftLine.y) <= 1.5 &&
        // 字号容差要宽一些：ICLR 标题用小型大写字母，同一行里字号会混排（17.2 / 13.8）；
        // 但两侧都必须明显大于正文，否则会把「章节标题 + 右栏正文」误并成一行。
        Math.abs(rightLine.size - leftLine.size) <= Math.max(1, leftLine.size * 0.25) &&
        Math.min(leftLine.size, rightLine.size) >= bodySize * 1.15,
    );
    if (partnerIndex >= 0) {
      const partner = rightColumn[partnerIndex];
      usedRight.add(partnerIndex);
      spanning.push({
        ...leftLine,
        text: `${leftLine.text} ${partner.text}`.trim(),
        x1: partner.x1,
        textWidth: partner.x1 - leftLine.x0,
      });
    } else remainingLeft.push(leftLine);
  }
  const remainingRight = rightColumn.filter((_, index) => !usedRight.has(index));

  // 同一基线上被栏缝切开的多个通栏片段（标题、居中摘要行）合并回一行。
  const spanningMerged: TextLine[] = [];
  for (const line of spanning.sort(byPosition)) {
    const last = spanningMerged[spanningMerged.length - 1];
    if (last && Math.abs(last.y - line.y) <= 1.5 && Math.max(last.size, line.size) >= bodySize * 1.15) {
      const x0 = Math.min(last.x0, line.x0);
      const x1 = Math.max(last.x1, line.x1);
      spanningMerged[spanningMerged.length - 1] = {
        ...last,
        text: `${last.text} ${line.text}`.trim(),
        x0,
        x1,
        textWidth: x1 - x0,
      };
    } else spanningMerged.push(line);
  }

  // 首页顶部（第一个带编号章节之前）常见通栏摘要：左右两段其实属于同一行，
  // 判断依据是右段紧接左段文字结尾（栏内正文的两栏之间会空出一个栏缝）。
  let frontMatter: TextLine[] = [];
  if (page.pageIdx === 0) {
    const firstSection = [...remainingLeft, ...remainingRight]
      .filter((line) => /^(\d+\.?\s+[A-Z]|[IVX]+\.\s+[A-Z])/.test(line.text.trim()))
      .sort((a, b) => b.y - a.y)[0];
    const boundary = firstSection ? firstSection.y : Number.NEGATIVE_INFINITY;
    const maxGap = Math.max(6, page.width * 0.012);
    const usedFront = new Set<number>();
    const keptLeft: TextLine[] = [];
    for (const leftLine of remainingLeft) {
      if (leftLine.y <= boundary) {
        keptLeft.push(leftLine);
        continue;
      }
      const index = remainingRight.findIndex(
        (rightLine, position) =>
          !usedFront.has(position) &&
          !usedRight.has(position) &&
          Math.abs(rightLine.y - leftLine.y) <= 1.5 &&
          rightLine.x0 - (leftLine.x0 + leftLine.textWidth) <= maxGap,
      );
      if (index >= 0) {
        usedFront.add(index);
        frontMatter.push({
          ...leftLine,
          text: `${leftLine.text} ${remainingRight[index].text}`.trim(),
          x1: remainingRight[index].x1,
          textWidth: remainingRight[index].x1 - leftLine.x0,
        });
      } else keptLeft.push(leftLine);
    }
    return [
      ...spanningMerged,
      // 通栏摘要与未合并的首页行要一起按 y 排序，否则摘要的最后一行会跑到最前面。
      ...[...frontMatter, ...keptLeft].sort(byPosition),
      ...remainingRight.filter((_, position) => !usedFront.has(position)),
    ];
  }

  return [...spanningMerged, ...remainingLeft, ...remainingRight];
}

/** 正文基准字号：取出现行数最多的字号（同票取更小者）。
 *  按行数而不是字符数统计，长标题不会把基准字号带偏。 */
export function bodyFontSize(lines: TextLine[]): number {
  const weight = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.size * 2) / 2;
    weight.set(key, (weight.get(key) ?? 0) + 1);
  }
  let best = 10;
  let bestWeight = -1;
  for (const [size, count] of weight) {
    if (count > bestWeight || (count === bestWeight && size < best)) {
      best = size;
      bestWeight = count;
    }
  }
  return best;
}

/**
 * 判断标题层级；0 表示正文。
 *
 * 只接受三类：无编号但属于固定章节名（Abstract/References…）、字号明显大于正文、
 * 带编号且以实词开头。作者行、机构行（字号比正文大一点）因此不会被当成章节。
 */
export function headingLevel(line: TextLine, bodySize: number): 0 | 1 | 2 {
  const text = line.text.trim();
  // 中文标题常常只有两个字（摘要、引言、方法），不能按英文长度下限卡。
  if (text.length < 2 || text.length > 120) return 0;
  if (EQUATION_NUMBER.test(text)) return 0;
  if (!hasWord(text)) return 0;
  // 图例、表格串、带引号的图注和网址都不是章节。
  if (/[|\\“”"]/.test(text) || /\bhttps?:\/\//i.test(text)) return 0;
  const relative = bodySize > 0 ? line.size / bodySize : 1;
  const numbered = NUMBERED_SECTION.test(text);
  const roman = ROMAN_SECTION.test(text);
  const known = SECTION_HINT.test(text);
  // 编号深度决定层级：`2 Method` 是一级，`2.1 Encoder` 是二级。
  const depth = numbered ? (text.match(/^\d+(\.\d+)*/)?.[0].split(".").length ?? 1) : 1;
  if (PLAIN_HEADING.test(text) && relative >= 1.0) return 1;
  if (known && text.length <= 60 && relative >= 1.05) return relative >= 1.35 ? 1 : depth > 1 ? 2 : 1;
  if (relative >= 1.35) return 1;
  // 编号标题：短行直接认；长行必须靠字号证明自己不是参考文献条目。
  if ((numbered || roman) && relative >= 0.99 && !TERMINAL.test(text)) {
    if (text.length <= 60 || relative >= 1.05) return depth > 1 ? 2 : 1;
  }
  return 0;
}

/** 跨页重复出现的短行（页眉、页脚、栏目标题）应当丢弃。 */
function repeatedLines(pages: TextLine[][], pageCount: number): Set<string> {
  if (pageCount < 3) return new Set();
  const counts = new Map<string, number>();
  for (const lines of pages) {
    const seen = new Set<string>();
    for (const line of lines) {
      const key = line.text.trim();
      if (!key || key.length > 80 || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.ceil(pageCount * 0.6));
  const repeated = new Set<string>();
  for (const [text, count] of counts) if (count >= threshold) repeated.add(text);
  return repeated;
}

/**
 * 行合并成段落：上一行没有句末标点，说明这一行只是换行。
 * 允许跨页继续，否则跨页的句子会被切成两段，AI 读到的上下文就是断的。
 */
export function mergeParagraphs(
  lines: TextLine[],
  bodySize: number,
  repeated: Set<string> = new Set(),
): TextBlock[] {
  const blocks: TextBlock[] = [];
  let buffer: { text: string; level: number; pageIdx: number } | null = null;
  const flush = () => {
    if (buffer && buffer.text.trim()) blocks.push({ ...buffer, text: buffer.text.trim() });
    buffer = null;
  };
  for (const line of lines) {
    if (repeated.has(line.text.trim())) continue;
    const level = headingLevel(line, bodySize);
    if (level > 0) {
      flush();
      blocks.push({ text: line.text.trim(), level, pageIdx: line.pageIdx });
      continue;
    }
    if (!buffer) {
      buffer = { text: line.text, level: 0, pageIdx: line.pageIdx };
      continue;
    }
    const continues = !TERMINAL.test(buffer.text);
    if (!continues) {
      flush();
      buffer = { text: line.text, level: 0, pageIdx: line.pageIdx };
      continue;
    }
    // 断词连字符：`inter-` + `national` → `international`
    if (/[A-Za-z]-$/.test(buffer.text) && /^[a-z]/.test(line.text)) buffer.text = buffer.text.slice(0, -1) + line.text;
    else buffer.text += CJK.test(buffer.text.slice(-1)) || CJK.test(line.text.slice(0, 1)) ? line.text : ` ${line.text}`;
  }
  flush();
  return blocks;
}

/**
 * 取一个像标题的字符串：只认明显大于正文的字号，太短、太长、像 arXiv 页眉的都排除。
 * 找不到可靠标题就退回文件名——把正文首句当标题比没有标题更糟。
 */
function pickTitle(pageLines: TextLine[], bodySize: number, fallbackTitle?: string): string {
  const candidates = pageLines
    .slice(0, 6)
    .filter((line) => line.text.length >= 8 && line.text.length <= 200)
    .filter((line) => !isBoilerplate(line.text))
    .filter((line) => bodySize > 0 && line.size >= bodySize * 1.15);
  const largest = Math.max(0, ...candidates.map((line) => line.size));
  const title = candidates.find((line) => line.size >= largest * 0.95)?.text;
  return (title ?? fallbackTitle ?? "").trim();
}

/**
 * 首页字号最大的一串连续行。
 *
 * 大标题常常换行（BERT 就是两行），这些行如果留在正文流里会各自变成章节，
 * 于是目录里出现「Language Understanding」这种假章节，引用也会指向它。
 */
function pickTitleLines(pageLines: TextLine[], bodySize: number): TextLine[] {
  if (!pageLines.length) return [];
  const head = pageLines.slice(0, 6).filter((line) => !isBoilerplate(line.text));
  if (!head.length) return [];
  const largest = Math.max(...head.map((line) => line.size));
  if (bodySize > 0 && largest < bodySize * 1.15) return [];
  const picked: TextLine[] = [];
  for (const line of head) {
    // 字号不够的行直接跳过：arXiv 会把授权声明排在标题上方，它不是标题。
    if (line.size < largest * 0.95) {
      if (picked.length) break;
      continue;
    }
    if (picked.length) {
      const previous = picked[picked.length - 1];
      const lineGap = previous.y - line.y;
      if (lineGap <= 0 || lineGap > largest * 2.2) break;
    }
    if (line.text.length < 8) continue;
    picked.push(line);
    if (picked.length >= 3) break;
  }
  return picked;
}

const lineKey = (line: TextLine) => `${line.pageIdx}:${line.y}:${line.text}`;

/**
 * 首页抬头里的单位、邮箱、作者单位行：属于元数据，不该混进正文段落。
 * 只扫首页前 10 行，避免误伤正文里提到机构名的句子。
 */
function frontMatterKeys(pageLines: TextLine[], titleKeys: Set<string>, authors: string): Set<string> {
  const keys = new Set<string>();
  // 作者名单独拿出来：排版里的作者网格会把同一批名字重复一遍。
  const authorNames = authors
    .split(/[,，]\s*/)
    .map((name) => name.trim())
    .filter((name) => name.length >= 4);
  for (const line of pageLines.slice(0, 10)) {
    const key = lineKey(line);
    if (titleKeys.has(key)) continue;
    const text = line.text.trim();
    if (!text) continue;
    if (authors && authors.includes(text)) {
      keys.add(key);
      continue;
    }
    if (authorNames.length && authorNames.some((name) => text.includes(name))) {
      keys.add(key);
      continue;
    }
    if (/[@{}]/.test(text)) {
      keys.add(key);
      continue;
    }
    if (text.length <= 120 && (INSTITUTION_LATIN.test(text) || INSTITUTION_CJK.test(text))) keys.add(key);
  }
  return keys;
}

/**
 * 丢掉目录页：连续 4 个以上标题块、中间没有正文，只可能是目录。
 *
 * 目录被当成章节后，章节树会出现两份同名条目，而且摘要会被紧随其后的
 * 「1 Introduction」立刻截断（GPT-3 就是这种排版）。
 */
export function dropTableOfContents(blocks: TextBlock[]): TextBlock[] {
  const kept: TextBlock[] = [];
  let index = 0;
  while (index < blocks.length) {
    if (blocks[index].level === 0) {
      kept.push(blocks[index]);
      index++;
      continue;
    }
    let end = index;
    // 目录只会在同一页内连续出现；跨页的连续标题各自成段，不会被误删。
    while (end < blocks.length && blocks[end].level > 0 && blocks[end].pageIdx === blocks[index].pageIdx) end++;
    const run = blocks.slice(index, end);
    // 目录页的特征：同一页上连续多个标题、中间没有正文。
    const isContents = run.length >= 4 && run.every((block) => block.text.length <= 100);
    if (!isContents) kept.push(...run);
    index = end;
  }
  return kept;
}

/**
 * 有些模板不写「Abstract」小标题（GPT-3）：首页作者之后、第一个章节之前的
 * 那一段就是摘要。补一个标题，让摘要提取、目录和引用都按同一套规则工作。
 */
export function ensureAbstractHeading(blocks: TextBlock[]): TextBlock[] {
  // 只检查第一个带编号的一级章节之前：后面的 “ABSTRACT” 可能只是页眉。
  const introIndex = blocks.findIndex(
    (block) => block.level > 0 && /^\d+\.?\s+(introduction|引言)\b/i.test(block.text.trim()),
  );
  const prefix = introIndex >= 0 ? blocks.slice(0, introIndex) : blocks;
  if (prefix.some((block) => block.level > 0 && /^(abstract|摘要)/i.test(block.text.trim()))) return blocks;
  const firstBody = prefix.findIndex((block) => block.level === 0);
  if (firstBody < 0) return blocks;
  const candidate = blocks[firstBody];
  if (candidate.pageIdx !== 0) return blocks;
  // 摘要可能被拆成几段（一行一句），用前缀里正文的总长度判断更像摘要。
  const prefixBodyChars = prefix
    .filter((block) => block.level === 0)
    .reduce((sum, block) => sum + block.text.length, 0);
  if (prefixBodyChars < 200) return blocks;
  if (/\b(permission to reproduce|all rights reserved|copyright)\b/i.test(candidate.text)) return blocks;
  blocks.splice(firstBody, 0, { text: "Abstract", level: 1, pageIdx: 0 });
  return blocks;
}

const INSTITUTION_LATIN =
  /\b(university|universit[a-z]*|institute|laborator[a-z]*|department|college|school|research|inc\.?|corp\.?|labs?\.?|google|microsoft|meta|openai|deepmind|amazon|apple|nvidia|tencent|alibaba|baidu)\b/i;
const INSTITUTION_CJK = /(大学|学院|研究所|研究院|实验室|公司)/;

/** 作者行：首页前几行里人名占比最高、且不是标题/单位/邮箱的那些行。 */
export function pickAuthors(pageLines: TextLine[], title: string, bodySize: number): string {
  const picked: string[] = [];
  for (const line of pageLines.slice(0, 6)) {
    // 标题可能占多行，也可能被排在作者行下方：标题行跳过而不是中断扫描。
    if (title.includes(line.text.trim())) continue;
    // 上标符号（∗†‡）与作者编号数字不是名字的一部分。
    const text = line.text
      .replace(/[\u2217\u2020\u2021\u00a7\u00b6*†‡§¶]/g, " ")
      .replace(/(?<=\s)\d+(?=\s|$)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text.length > 240) continue;
    if (line.size > bodySize * 1.6) continue;
    if (isBoilerplate(text)) continue;
    if (PLAIN_HEADING.test(text)) continue;
    if (/[@{}]/.test(line.text)) continue;
    if (INSTITUTION_LATIN.test(text) || INSTITUTION_CJK.test(text)) continue;
    if (!/^[A-Z\u00c0-\u024f\u3400-\u9fff]/.test(text)) continue;
    if (TERMINAL.test(text)) continue;
    if (CJK.test(text)) {
      // 中文作者行很短，且每个名字不超过 6 个字；正文句子会被这条规则挡掉。
      const clauses = text.split(/[，,、;；]+/).map((clause) => clause.trim()).filter(Boolean);
      if (text.length > 80 || !clauses.length || clauses.some((clause) => clause.length > 6)) continue;
      picked.push(text);
      if (picked.length >= 3) break;
      continue;
    }
    const words = text.split(/\s+/).filter(Boolean);
    const nameLike = words.filter((word) =>
      /^[A-Z\u00c0-\u024f\u3400-\u9fff][\w\u00c0-\u024f\u3400-\u9fff.'’-]*$/.test(word),
    ).length;
    if (nameLike < words.length * 0.6) continue;
    picked.push(text);
    if (picked.length >= 3) break;
  }
  return picked
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*,\s*/g, ", ");
}

/**
 * 把逐页文本拼成 Markdown 与 content_list。
 *
 * Markdown 采用 `# 标题` / `## 章节` 两级：`extract_metadata` 依赖第一个 `# ` 取标题，
 * 关键词搜索依赖空行分段，分块器依赖 `text_level` 断章。
 */
export function buildDocument(pages: PdfPageText[], options: BuildOptions = {}): LocalParseResult {
  const pageLines = pages.map((page) => buildLines(page));
  const repeated = repeatedLines(pageLines, pages.length);
  const allLines = pageLines.flat();
  const bodySize = bodyFontSize(allLines);

  // 标题行从正文流里剔除，否则大标题的每一行都会变成章节。
  const titleLines = pickTitleLines(pageLines[0] ?? [], bodySize);
  const titleKeys = new Set(titleLines.map(lineKey));
  // 逐行拼接：上行以连字符结尾时直接接上，避免把 "LAN-" + "GUAGE" 拼成 "LAN- GUAGE"。
  const joinedTitle = titleLines.reduce((title, line) => {
    const text = line.text.trim();
    if (!title) return text;
    return /[A-Za-z]-$/.test(title) ? title.slice(0, -1) + text : `${title} ${text}`;
  }, "");
  const title = (joinedTitle.trim() || pickTitle(pageLines[0] ?? [], bodySize, options.fallbackTitle) || "未命名论文")
    .replace(/\s+/g, " ")
    .slice(0, 300);
  const authors = pickAuthors(pageLines[0] ?? [], title, bodySize);
  const frontMatter = frontMatterKeys(pageLines[0] ?? [], titleKeys, authors);
  // 标题、作者、单位都是元数据：写进 Markdown 抬头，但不参与分块检索。
  const contentLines = allLines.filter((line) => {
    if (titleKeys.has(lineKey(line))) return false;
    if (frontMatter.has(lineKey(line))) return false;
    if (authors && authors.includes(line.text.trim())) return false;
    return true;
  });
  const blocks = dropTableOfContents(mergeParagraphs(contentLines, bodySize, repeated));
  ensureAbstractHeading(blocks);
  // 重复出现的 “Abstract/摘要” 只是页眉，不应再开一节。
  let abstractSeen = false;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block.level > 0 && /^(abstract|摘要)$/i.test(block.text.trim())) {
      if (abstractSeen) blocks.splice(index, 1);
      abstractSeen = true;
    }
  }

  const chars = blocks.reduce((sum, block) => sum + block.text.length, 0);
  if (chars < MIN_EXTRACTED_CHARS) {
    throw new Error(
      "这份 PDF 几乎没有可提取的文字层（可能是扫描件）。请在设置中改用 MinerU 云端解析，或先做 OCR。",
    );
  }

  const markdown: string = [
    `# ${title}`,
    ...(authors ? ["", authors] : []),
    "",
    ...blocks.map((block) => (block.level > 0 ? `${"#".repeat(Math.min(3, block.level + 1))} ${block.text}\n` : `${block.text}\n`)),
  ].join("\n");

  const contentList = JSON.stringify(
    blocks.map((block) => ({
      type: "text",
      text: block.text,
      ...(block.level > 0 ? { text_level: block.level } : {}),
      page_idx: block.pageIdx,
    })),
  );

  return { markdown, contentList, blocks, authors, chars };
}
