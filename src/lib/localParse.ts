/**
 * 本机 PDF 正文提取：用包内已有的 pdf.js 读文字层，产出与 MinerU 同构的
 * `paper.md` 与 `content_list.json`。不联网、不需要任何 API Key。
 *
 * 与阅读器共用同一条字节读取路径（`convertFileSrc` + `fetch`），
 * 因此中文、空格、Windows 盘符路径都与阅读表现一致。
 */
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  buildDocument,
  type LocalParseResult,
  type PdfPageText,
  type PdfTextItem,
} from "./pdfTextLayout";

if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** 单次提取的页数上限：再长的 PDF 建议走云端解析，避免长时间占用界面。 */
export const MAX_LOCAL_PAGES = 400;

export interface ExtractOptions {
  fallbackTitle?: string;
  /** 每页回调一次；抛错即可中止提取（用于取消与进度上报）。 */
  onPage?: (done: number, total: number) => void | Promise<void>;
}

/** pdf.js 的文本项；不同版本字段略有差异，这里只取排版需要的部分。 */
function toTextItem(raw: unknown): PdfTextItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as { str?: unknown; transform?: unknown; width?: unknown; height?: unknown };
  if (typeof item.str !== "string" || !item.str) return null;
  const transform = item.transform;
  if (!Array.isArray(transform) || transform.length < 6) return null;
  const x = Number(transform[4]);
  const y = Number(transform[5]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const width = Number(item.width);
  const height = Number(item.height);
  return {
    str: item.str,
    x,
    y,
    width: Number.isFinite(width) && width > 0 ? width : item.str.length * 5,
    height: Number.isFinite(height) && height > 0 ? height : 10,
  };
}

/** 读取整篇 PDF 的文字层，返回可直接落盘的 Markdown 与 content_list。 */
export async function extractPdfText(
  pdfPath: string,
  options: ExtractOptions = {},
): Promise<LocalParseResult> {
  const response = await fetch(convertFileSrc(pdfPath));
  if (!response.ok) throw new Error(`读取 PDF 失败（${response.status}）`);
  const data = await response.arrayBuffer();
  const task = pdfjs.getDocument({ data });
  const document = await task.promise;
  try {
    const total = Math.min(document.numPages, MAX_LOCAL_PAGES);
    const pages: PdfPageText[] = [];
    for (let index = 1; index <= total; index++) {
      const page = await document.getPage(index);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push({
        pageIdx: index - 1,
        width: viewport.width,
        height: viewport.height,
        items: content.items.map(toTextItem).filter((item): item is PdfTextItem => item !== null),
      });
      page.cleanup();
      await options.onPage?.(index, total);
    }
    return buildDocument(pages, { fallbackTitle: options.fallbackTitle });
  } finally {
    await task.destroy().catch(() => {});
  }
}
