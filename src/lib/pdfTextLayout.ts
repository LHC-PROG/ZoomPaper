/**
 * 本机 PDF 文本提取的排版逻辑：把 pdf.js 的文本项还原成行、段落和章节。
 *
 * 这里只做纯计算，不碰 DOM、不碰 pdf.js、不碰 Tauri，方便单元测试。
 * 产出的 `content_list.json` 与 MinerU 的结构一致（`type/text/text_level/page_idx`），
 * 因此分块、检索、章节树、测验选题都能直接复用。
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
const SECTION_HINT =
  /^(abstract|摘要|introduction|引言|related work|background|method|methods|approach|experiment|experiments|evaluation|result|results|discussion|conclusion|conclusions|references|acknowledg|appendix|第[一二三四五六七八九十]+[章节])/i;

/** 逐页把文本项聚成行：同一基线上按 x 排序，间距足够大才补空格。
 *  同一基线上横向间隔过大（双栏的两个栏）要拆成两行，否则左右栏会串在一起。 */
export function buildLines(page: PdfPageText): TextLine[] {
  const items = page.items.filter((item) => item.str.trim().length > 0);
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
    const tolerance = Math.max(1.5, Math.min(anchor.height || 10, item.height || 10) * 0.5);
    const last = current[current.length - 1];
    const gap = item.x - (last.x + last.width);
    const split = Math.abs(item.y - anchor.y) > tolerance || gap > Math.max(8, (item.height || 10) * 1.5);
    if (split) {
      groups.push(current);
      current = [item];
    } else current.push(item);
  }
  if (current.length) groups.push(current);

  return groups.map((group) => {
    const ordered = [...group].sort((a, b) => a.x - b.x);
    let text = "";
    let previousEnd = 0;
    for (const item of ordered) {
      if (text) {
        const gap = item.x - previousEnd;
        // 拉丁文词间通常只有很小的间隙；CJK 逐字排版时间隙更小，不能因此拆词。
        const threshold = Math.max(1, (item.height || 10) * 0.22);
        if (gap > threshold && !CJK.test(text.slice(-1)) && !CJK.test(item.str.slice(0, 1))) text += " ";
      }
      text += item.str;
      previousEnd = item.x + item.width;
    }
    const sizes = ordered.map((item) => item.height).sort((a, b) => a - b);
    return {
      text: text.replace(/\s+/g, " ").trim(),
      y: ordered[0].y,
      x0: Math.min(...ordered.map((item) => item.x)),
      x1: Math.max(...ordered.map((item) => item.x + item.width)),
      size: sizes[Math.floor(sizes.length / 2)] || 10,
      pageIdx: page.pageIdx,
    };
  }).filter((line) => line.text.length > 0);
}

/**
 * 找双栏排版的中缝：选一条竖线，尽量多的行不跨过它，且两侧都有足够行。
 * 单栏论文找不到这样的位置，返回 null。
 */
export function detectGutter(lines: TextLine[], width: number): number | null {
  if (lines.length < 8) return null;
  const step = Math.max(2, Math.round(width * 0.01));
  let best = { position: 0, count: 0 };
  for (let position = Math.round(width * 0.3); position <= Math.round(width * 0.7); position += step) {
    let crossing = 0;
    let left = 0;
    let right = 0;
    for (const line of lines) {
      if (line.x1 <= position) left++;
      else if (line.x0 >= position) right++;
      else crossing++;
    }
    if (left < 3 || right < 3) continue;
    const clear = lines.length - crossing;
    if (clear > best.count) best = { position, count: clear };
  }
  return best.count >= Math.ceil(lines.length * 0.75) ? best.position : null;
}

/**
 * 按阅读顺序排列一页：双栏时先通栏内容（标题/摘要），再左栏，再右栏；
 * 单栏时就是自上而下。
 */
export function orderLines(lines: TextLine[], gutter: number | null): TextLine[] {
  const byPosition = (a: TextLine, b: TextLine) => b.y - a.y || a.x0 - b.x0;
  if (gutter == null) return [...lines].sort(byPosition);
  const left = lines.filter((line) => line.x1 <= gutter);
  const right = lines.filter((line) => line.x0 >= gutter);
  const spanning = lines.filter((line) => line.x1 > gutter && line.x0 < gutter);
  if (left.length < 3 || right.length < 3) return [...lines].sort(byPosition);
  return [...spanning.sort(byPosition), ...left.sort(byPosition), ...right.sort(byPosition)];
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

/** 按字号与编号约定判断标题层级；0 表示正文。 */
export function headingLevel(line: TextLine, bodySize: number): 0 | 1 | 2 {
  const text = line.text.trim();
  if (!text || text.length > 120) return 0;
  const relative = bodySize > 0 ? line.size / bodySize : 1;
  const numbered = /^\d+(\.\d+)*\.?\s+\S/.test(text) || SECTION_HINT.test(text);
  if (relative >= 1.3) return 1;
  if (relative >= 1.1 && text.length <= 90) return numbered ? 2 : 0;
  if (numbered && text.length <= 60 && !TERMINAL.test(text)) return 2;
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

/** 行合并成段落：上一行没有句末标点，说明这一行只是换行。 */
export function mergeParagraphs(lines: TextLine[], bodySize: number, repeated: Set<string> = new Set()): TextBlock[] {
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
    const continues = buffer.pageIdx === line.pageIdx && !TERMINAL.test(buffer.text);
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
    .filter((line) => !/^arxiv:|^https?:|^\d+$|^doi:/i.test(line.text))
    .filter((line) => bodySize > 0 && line.size >= bodySize * 1.15);
  const largest = Math.max(0, ...candidates.map((line) => line.size));
  const title = candidates.find((line) => line.size >= largest * 0.95)?.text;
  return (title ?? fallbackTitle ?? "").trim();
}

/**
 * 把逐页文本拼成 Markdown 与 content_list。
 *
 * Markdown 采用 `# 标题` / `## 章节` 两级：`extract_metadata` 依赖第一个 `# ` 取标题，
 * 关键词搜索依赖空行分段，分块器依赖 `text_level` 断章。
 */
export function buildDocument(pages: PdfPageText[], options: BuildOptions = {}): LocalParseResult {
  const pageLines = pages.map((page) => {
    const lines = buildLines(page);
    return orderLines(lines, detectGutter(lines, page.width));
  });
  const repeated = repeatedLines(pageLines, pages.length);
  const allLines = pageLines.flat();
  const bodySize = bodyFontSize(allLines);
  const blocks = pageLines.flatMap((lines) => mergeParagraphs(lines, bodySize, repeated));

  const chars = blocks.reduce((sum, block) => sum + block.text.length, 0);
  if (chars < MIN_EXTRACTED_CHARS) {
    throw new Error(
      "这份 PDF 几乎没有可提取的文字层（可能是扫描件）。请在设置中改用 MinerU 云端解析，或先做 OCR。",
    );
  }

  const title = pickTitle(pageLines[0] ?? [], bodySize, options.fallbackTitle) || "未命名论文";
  const markdown: string = [
    `# ${title}`,
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

  return { markdown, contentList, blocks, chars };
}
